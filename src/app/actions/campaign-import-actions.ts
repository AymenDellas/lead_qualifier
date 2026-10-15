"use server";

import { getAllLeads, updateLead, setLeadOutcome, bulkMarkContactedWithDates, setContactedSource } from "@/lib/db";
import { parseCampaignReport, mergeCampaignReports, type ParsedCampaignReport } from "@/lib/campaign-report";

export type CampaignImportReport = {
    ok: boolean;
    files: { source: string; rows: number; sent: number; skipped: number; error?: string }[];
    platform: { uploaded: number; sent: number; replied: number; bounced: number };
    /** How much of the platform's record corresponds to a lead in this CRM. */
    matched: { sent: number; uploadedNotSent: number; replied: number; bounced: number };
    /** Writes actually made. */
    applied: {
        markedContacted: number;
        /** Already flagged, and now backed by the platform's own record. */
        sendsConfirmed: number;
        clearedContacted: number;
        repliesRecorded: number;
        bouncesSuppressed: number;
    };
    /** Leads the platform proves were never sent to, so the flag was wrong. */
    correctedExamples: string[];
    /** Repliers and bounces, so they can be eyeballed. */
    replierExamples: { email: string; name: string }[];
    bounceExamples: string[];
    error?: string;
};

/** Every address the CRM holds for a lead — the scraper often finds more than one. */
function leadAddresses(lead: { email?: string; all_emails?: string }): string[] {
    const out: string[] = [];
    if (lead.email?.includes("@")) out.push(lead.email.toLowerCase().trim());
    if (lead.all_emails) {
        try {
            const parsed = JSON.parse(lead.all_emails);
            if (Array.isArray(parsed)) for (const e of parsed) out.push(String(e).toLowerCase().trim());
        } catch {
            for (const e of lead.all_emails.split(/[,;\s]+/)) {
                const trimmed = e.toLowerCase().trim();
                if (trimmed.includes("@")) out.push(trimmed);
            }
        }
    }
    return [...new Set(out)];
}

/**
 * Reconciles the CRM against campaign reports exported from the sending platform.
 *
 * Unlike the Gmail sync, this source is authoritative in both directions: the
 * platform knows both who it sent to *and* who it merely held. So this is the
 * only place allowed to clear a `contacted` flag automatically — and it does so
 * only for a lead the platform explicitly lists as never sent. A lead absent from
 * every report is left exactly as it is; absence still proves nothing.
 */
export async function importCampaignReportsAction(
    files: { name: string; content: string }[],
): Promise<CampaignImportReport> {
    const empty: CampaignImportReport = {
        ok: false, files: [],
        platform: { uploaded: 0, sent: 0, replied: 0, bounced: 0 },
        matched: { sent: 0, uploadedNotSent: 0, replied: 0, bounced: 0 },
        applied: { markedContacted: 0, sendsConfirmed: 0, clearedContacted: 0, repliesRecorded: 0, bouncesSuppressed: 0 },
        correctedExamples: [], replierExamples: [], bounceExamples: [],
    };

    if (!files?.length) return { ...empty, error: "No files supplied." };

    const parsed: ParsedCampaignReport[] = files.map(f => parseCampaignReport(f.content, f.name));
    const platform = mergeCampaignReports(parsed);

    if (platform.uploaded.size === 0) {
        return {
            ...empty,
            files: platform.files,
            error: "No usable rows. These need to be campaign reports with an Email column — not lead exports.",
        };
    }

    let leads;
    try {
        leads = await getAllLeads();
    } catch (e: any) {
        return { ...empty, files: platform.files, error: `Couldn't read leads: ${e?.message || e}` };
    }

    const toMarkContacted: { id: string; sentAt: string }[] = [];
    const toStampSource: string[] = [];
    const toClear: string[] = [];
    const toRecordReply: string[] = [];
    const toSuppress: string[] = [];
    const correctedExamples: string[] = [];
    const replierExamples: { email: string; name: string }[] = [];
    const bounceExamples: string[] = [];
    const matched = { sent: 0, uploadedNotSent: 0, replied: 0, bounced: 0 };

    for (const lead of leads) {
        const addresses = leadAddresses(lead);
        if (addresses.length === 0) continue;

        const wasSent = addresses.some(a => platform.sent.has(a));
        const wasUploaded = addresses.some(a => platform.uploaded.has(a));
        const didBounce = addresses.some(a => platform.bounced.has(a));
        const didReply = addresses.some(a => platform.replied.has(a));

        if (wasSent) {
            matched.sent++;
            // The report has no per-send timestamp, so a reply date is the only real
            // date available; otherwise fall back to now. `bulkMarkContactedWithDates`
            // keeps whichever date is earliest, so this never overwrites a Gmail date.
            if (!lead.contacted) {
                const replyDate = addresses.map(a => platform.replied.get(a)).find(Boolean);
                toMarkContacted.push({ id: lead.id, sentAt: replyDate || new Date().toISOString() });
            } else if (lead.contacted_source !== "PLATFORM") {
                // Already flagged, and now we know the flag was right. Recording that
                // is what stops a later Gmail sync from listing it as unconfirmed and
                // offering it up to be cleared.
                toStampSource.push(lead.id);
            }
        } else if (wasUploaded) {
            matched.uploadedNotSent++;
            // The platform holds this lead and states it never sent it. That's the one
            // provable correction available — but only against a flag with no positive
            // evidence behind it. "Not sent" is scoped to the campaigns in these
            // reports; a lead skipped by one campaign may well have been emailed by
            // another, and a Gmail match is direct proof that it was.
            if (lead.contacted && !lead.contacted_source) {
                toClear.push(lead.id);
                if (correctedExamples.length < 20) correctedExamples.push(String(lead.email));
            }
        }

        if (didBounce) {
            matched.bounced++;
            if (!lead.do_not_contact || lead.outcome !== "BOUNCED") {
                toSuppress.push(lead.id);
                if (bounceExamples.length < 30) bounceExamples.push(String(lead.email));
            }
        } else if (didReply) {
            matched.replied++;
            if (lead.outcome !== "REPLIED" && lead.outcome !== "BOOKED") {
                toRecordReply.push(lead.id);
                if (replierExamples.length < 20) {
                    replierExamples.push({ email: String(lead.email), name: `${lead.first_name} ${lead.last_name}`.trim() });
                }
            }
        }
    }

    // --- writes ---------------------------------------------------------------
    let markedContacted = 0;
    if (toMarkContacted.length) markedContacted = await bulkMarkContactedWithDates(toMarkContacted, "PLATFORM");
    const sourceStamped = await setContactedSource(toStampSource, "PLATFORM");

    let clearedContacted = 0;
    for (const id of toClear) {
        try { await updateLead(id, { contacted: false }); clearedContacted++; }
        catch (e) { console.error("[CampaignImport] clear failed", id, e); }
    }

    // A bounce is set before a reply so that a bounced-then-replied oddity ends up
    // suppressed rather than queued for another send.
    let bouncesSuppressed = 0;
    for (const id of toSuppress) {
        try { await setLeadOutcome(id, "BOUNCED"); bouncesSuppressed++; }
        catch (e) { console.error("[CampaignImport] bounce failed", id, e); }
    }

    let repliesRecorded = 0;
    for (const id of toRecordReply) {
        try { await setLeadOutcome(id, "REPLIED"); repliesRecorded++; }
        catch (e) { console.error("[CampaignImport] reply failed", id, e); }
    }

    return {
        ok: true,
        files: platform.files,
        platform: {
            uploaded: platform.uploaded.size,
            sent: platform.sent.size,
            replied: platform.replied.size,
            bounced: platform.bounced.size,
        },
        matched,
        applied: { markedContacted, sendsConfirmed: sourceStamped, clearedContacted, repliesRecorded, bouncesSuppressed },
        correctedExamples,
        replierExamples,
        bounceExamples,
    };
}
