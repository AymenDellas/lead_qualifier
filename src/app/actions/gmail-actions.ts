"use server";

import { getAllLeads, bulkMarkContactedWithDates, updateLead, isQualifiedStage } from "@/lib/db";
import { getGmailAccounts, describeGmailAccountsProblem, scanSentMail } from "@/lib/gmail-sent";
import { FREE_PROVIDERS } from "@/lib/email-constants";

export type GmailSyncReport = {
    ok: boolean;
    accounts: { email: string; messagesScanned: number; recipients: number; provider?: string; error?: string }[];
    /** Breakdown of the qualified tabs: who has actually been emailed and who hasn't. */
    qualified: { total: number; confirmedContacted: number; notContacted: number };
    /** Every lead with an address, matched or not — the honest denominator. */
    coverage: { leadsWithEmail: number; outboundRecipients: number; exactMatches: number };
    /**
     * Leads where a *different* person at the same company was emailed. Free
     * providers are excluded — sharing gmail.com with someone means nothing.
     * Reported only; these are not marked contacted.
     */
    sameCompany: { count: number; examples: { lead: string; emailedInstead: string }[] };
    /**
     * Sent mail grouped by subject. This is what separates real outreach from
     * warm-up traffic, and shows how much of each campaign went to people who
     * are actually in this CRM.
     */
    campaigns: {
        subject: string;
        messages: number;
        recipients: number;
        leadsMatched: number;
        firstSent: string;
        lastSent: string;
    }[];
    /** Leads found in sent mail that weren't already flagged contacted. */
    newlyMarked: number;
    /** Leads found in sent mail that were already flagged. */
    alreadyMarked: number;
    /** Rows whose contacted_at was written or pulled earlier by a real send date. */
    datesRecorded: number;
    /**
     * Flagged contacted in the CRM but absent from every scanned mailbox. Reported
     * only — clearing them is a separate, explicit action, because a lead may well
     * have been contacted on LinkedIn or from an account that wasn't scanned.
     *
     * Split by how much evidence there is, because "no exact match" is not one
     * thing. `nearMiss` leads show a weaker sign of having been reached — a
     * colleague at the same company was emailed, or an address bearing this
     * person's name was. Those must never be cleared in bulk; `safeIds` can be.
     */
    unconfirmed: {
        total: number;
        inQualifiedStage: number;
        ids: string[];
        safeIds: string[];
        nearMiss: { count: number; ids: string[]; examples: { lead: string; emailedInstead: string; reason: string }[] };
    };
    /**
     * False when any mailbox failed to scan. A partial scan sees fewer sent
     * messages, so it confirms fewer leads and reports *more* as unconfirmed —
     * the failure makes the destructive action look more attractive, not less.
     * `safeIds` is emptied whenever this is false.
     */
    scanComplete: boolean;
    error?: string;
};

/** Strips punctuation and case so "Jane.Doe" and "janedoe" compare equal. */
function normaliseLocalPart(value: string): string {
    return value.toLowerCase().replace(/[^a-z]/g, "");
}

/**
 * Address shapes a person's name could plausibly have been emailed under. Both
 * parts must be reasonably long — two-letter names collide with everything, and
 * a false "already contacted" costs a real lead.
 */
function nameVariants(firstName: string, lastName: string): string[] {
    const first = normaliseLocalPart(firstName || "");
    const last = normaliseLocalPart(lastName || "");
    if (first.length < 3 || last.length < 3) return [];
    return [first + last, last + first, first[0] + last, first + last[0]];
}

function splitAllEmails(raw: string | null | undefined): string[] {
    if (!raw) return [];
    // all_emails has been written both as a JSON array and as a joined string
    // over the life of the table, so accept either.
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.map(e => String(e).toLowerCase().trim());
    } catch { /* not JSON — fall through */ }
    return raw.split(/[,;\s]+/).map(e => e.toLowerCase().trim()).filter(e => e.includes("@"));
}

/**
 * Merges each account's subject-grouped campaigns and works out how much of each
 * one went to people who are actually in this CRM. A campaign with a high message
 * count but near-zero lead matches was sent to a list built somewhere else.
 */
function buildCampaignReport(
    scans: Awaited<ReturnType<typeof scanSentMail>>[],
    leadAddresses: Set<string>,
): GmailSyncReport["campaigns"] {
    const merged = new Map<string, { sample: string; messages: number; recipients: Set<string>; firstSent: string; lastSent: string }>();

    for (const scan of scans) {
        for (const [key, campaign] of scan.campaigns) {
            const existing = merged.get(key);
            if (!existing) {
                merged.set(key, {
                    sample: campaign.sample,
                    messages: campaign.messages,
                    recipients: new Set(campaign.recipients),
                    firstSent: campaign.firstSent,
                    lastSent: campaign.lastSent,
                });
                continue;
            }
            existing.messages += campaign.messages;
            for (const r of campaign.recipients) existing.recipients.add(r);
            if (campaign.firstSent < existing.firstSent) existing.firstSent = campaign.firstSent;
            if (campaign.lastSent > existing.lastSent) existing.lastSent = campaign.lastSent;
        }
    }

    return [...merged.values()]
        .map(c => ({
            subject: c.sample,
            messages: c.messages,
            recipients: c.recipients.size,
            leadsMatched: [...c.recipients].filter(r => leadAddresses.has(r)).length,
            firstSent: c.firstSent,
            lastSent: c.lastSent,
        }))
        .sort((a, b) => b.messages - a.messages)
        .slice(0, 40);
}

/**
 * Reconciles the CRM's `contacted` flag against what was actually sent from your
 * Gmail accounts. Read-only against Gmail; the only writes are to your own leads.
 */
export async function syncContactedFromGmailAction(): Promise<GmailSyncReport> {
    const accounts = getGmailAccounts();
    const empty: GmailSyncReport = {
        ok: false, accounts: [], qualified: { total: 0, confirmedContacted: 0, notContacted: 0 },
        coverage: { leadsWithEmail: 0, outboundRecipients: 0, exactMatches: 0 },
        sameCompany: { count: 0, examples: [] },
        campaigns: [],
        newlyMarked: 0, alreadyMarked: 0, datesRecorded: 0,
        unconfirmed: { total: 0, inQualifiedStage: 0, ids: [], safeIds: [], nearMiss: { count: 0, ids: [], examples: [] } },
        scanComplete: false,
    };

    if (accounts.length === 0) {
        return { ...empty, error: describeGmailAccountsProblem() ?? "No Gmail accounts configured." };
    }

    // Load leads before touching the mailboxes. Scanning is the slow part (minutes
    // on a large account), and a database hiccup afterwards would throw all of that
    // work away — so fail fast on the cheap call first.
    let leads;
    try {
        leads = await getAllLeads();
    } catch (e: any) {
        return { ...empty, error: `Couldn't read leads from the database: ${e?.message || e}. Nothing was scanned.` };
    }

    // Scanned one at a time, not in parallel. Gmail throttles repeated full-mailbox
    // reads, and a throttled account comes back as a connection error — which would
    // quietly shrink the confirmed set and inflate the unconfirmed one. One retry
    // after a pause clears the transient case; the slower run is worth it, since a
    // half-scanned mailbox is worse than a slow one.
    const scans: Awaited<ReturnType<typeof scanSentMail>>[] = [];
    for (const account of accounts) {
        let scan = await scanSentMail(account);
        if (scan.error) {
            await new Promise(resolve => setTimeout(resolve, 5000));
            const retry = await scanSentMail(account);
            if (!retry.error) scan = retry;
        }
        scans.push(scan);
    }

    // Earliest send date per address, merged across every mailbox.
    const sentTo = new Map<string, string>();
    for (const scan of scans) {
        for (const [address, sentAt] of scan.recipients) {
            const existing = sentTo.get(address);
            if (!existing || sentAt < existing) sentTo.set(address, sentAt);
        }
    }

    const scanComplete = scans.every(s => !s.error);
    const accountReports = scans.map(s => ({
        email: s.account,
        messagesScanned: s.messagesScanned,
        recipients: s.recipients.size,
        provider: s.provider,
        error: s.error,
    }));

    if (sentTo.size === 0) {
        const allFailed = scans.every(s => s.error);
        return {
            ...empty,
            accounts: accountReports,
            error: allFailed ? "Could not read any mailbox — see the per-account errors." : "No sent mail found.",
        };
    }

    // Which company domains were emailed, and at what address. Free providers are
    // excluded outright: two leads sharing gmail.com are not the same company, and
    // warm-up services fill a mailbox with free-provider addresses.
    const emailedByDomain = new Map<string, string>();
    // Every local part that was emailed anywhere, so a lead can be matched by name
    // even when the CRM holds a different address for them (info@ instead of their
    // own, a personal address, a since-changed mailbox).
    const emailedLocalParts = new Map<string, string>();
    for (const address of sentTo.keys()) {
        const [local, domain] = address.split("@");
        if (!domain) continue;
        const normalisedLocal = normaliseLocalPart(local);
        if (normalisedLocal && !emailedLocalParts.has(normalisedLocal)) emailedLocalParts.set(normalisedLocal, address);
        if (FREE_PROVIDERS.has(domain)) continue;
        if (!emailedByDomain.has(domain)) emailedByDomain.set(domain, address);
    }

    // Every address the CRM knows for any lead — primary and secondary — so a
    // campaign's lead-match rate is measured against the whole database, not
    // just one tab.
    const leadAddresses = new Set<string>();
    for (const lead of leads) {
        if (lead.email?.includes("@")) leadAddresses.add(lead.email.toLowerCase().trim());
        for (const extra of splitAllEmails(lead.all_emails)) leadAddresses.add(extra);
    }

    const matches: { id: string; sentAt: string }[] = [];
    const matchedIds = new Set<string>();
    const sameCompanyExamples: { lead: string; emailedInstead: string }[] = [];
    let sameCompanyCount = 0;
    let alreadyMarked = 0;

    for (const lead of leads) {
        // Check the primary address first, then any secondary ones the scraper found.
        const candidates = [lead.email, ...splitAllEmails(lead.all_emails)]
            .filter(Boolean)
            .map(e => String(e).toLowerCase().trim());

        let earliest: string | undefined;
        for (const candidate of candidates) {
            const sentAt = sentTo.get(candidate);
            if (sentAt && (!earliest || sentAt < earliest)) earliest = sentAt;
        }
        if (!earliest) {
            // No exact hit. Did we email someone else at this company? Worth knowing —
            // it's a duplicate-outreach risk — but never grounds to mark contacted.
            const domain = candidates[0]?.split("@")[1];
            const emailedInstead = domain ? emailedByDomain.get(domain) : undefined;
            if (emailedInstead) {
                sameCompanyCount++;
                if (sameCompanyExamples.length < 20) {
                    sameCompanyExamples.push({ lead: String(lead.email), emailedInstead });
                }
            }
            continue;
        }

        matchedIds.add(lead.id);
        if (lead.contacted) alreadyMarked++;
        matches.push({ id: lead.id, sentAt: earliest });
    }

    const datesRecorded = await bulkMarkContactedWithDates(matches);

    // A lead the sending platform has already vouched for is confirmed, full stop.
    // Gmail can only see mail relayed through the connected mailboxes, so its
    // silence says nothing about a send the platform made elsewhere.
    const unconfirmedLeads = leads.filter(l =>
        l.contacted && !l.in_hunter && !matchedIds.has(l.id) && !l.linkedin_dm_at && !["PLATFORM", "LINKEDIN", "HUNTER"].includes(l.contacted_source || ""));

    // Sort the unconfirmed by how much evidence there is against them. A lead with
    // no trace of any kind is safe to clear and re-approach; one where a colleague
    // or a name-alike address was emailed is not, and clearing it in bulk would
    // send a second cold email to someone who already got one.
    const safeIds: string[] = [];
    const nearMissIds: string[] = [];
    const nearMissExamples: { lead: string; emailedInstead: string; reason: string }[] = [];

    for (const lead of unconfirmedLeads) {
        const candidates = [lead.email, ...splitAllEmails(lead.all_emails)]
            .filter(Boolean)
            .map(e => String(e).toLowerCase().trim());

        // Someone else at the same company. Free providers are already excluded from
        // emailedByDomain, so this only fires on real company domains.
        const domains = new Set(candidates.map(c => c.split("@")[1]).filter(Boolean) as string[]);
        let hit: { address: string; reason: string } | undefined;
        for (const domain of domains) {
            const emailedInstead = emailedByDomain.get(domain);
            if (emailedInstead && !candidates.includes(emailedInstead)) {
                hit = { address: emailedInstead, reason: "a colleague at the same company was emailed" };
                break;
            }
        }

        // An address built from this person's name was emailed, at any domain.
        if (!hit) {
            for (const variant of nameVariants(lead.first_name, lead.last_name)) {
                const emailedInstead = emailedLocalParts.get(variant);
                if (emailedInstead && !candidates.includes(emailedInstead)) {
                    hit = { address: emailedInstead, reason: "an address matching their name was emailed" };
                    break;
                }
            }
        }

        if (!hit) {
            safeIds.push(lead.id);
            continue;
        }
        nearMissIds.push(lead.id);
        if (nearMissExamples.length < 25) {
            nearMissExamples.push({ lead: String(lead.email || `${lead.first_name} ${lead.last_name}`), emailedInstead: hit.address, reason: hit.reason });
        }
    }

    // The question this whole sync exists to answer: of the leads that cleared
    // qualification, which have actually been emailed and which are still owed one.
    const qualifiedLeads = leads.filter(l => isQualifiedStage(l.pipeline_status));
    // Confirmed by either source — found in Sent Mail, or vouched for by the
    // sending platform's own campaign report.
    const qualifiedConfirmed = qualifiedLeads.filter(
        l => matchedIds.has(l.id) || l.contacted_source === "PLATFORM").length;

    return {
        ok: true,
        accounts: accountReports,
        qualified: {
            total: qualifiedLeads.length,
            confirmedContacted: qualifiedConfirmed,
            notContacted: qualifiedLeads.length - qualifiedConfirmed,
        },
        coverage: {
            leadsWithEmail: leads.filter(l => l.email?.includes("@")).length,
            outboundRecipients: sentTo.size,
            exactMatches: matches.length,
        },
        sameCompany: { count: sameCompanyCount, examples: sameCompanyExamples },
        campaigns: buildCampaignReport(scans, leadAddresses),
        newlyMarked: matches.length - alreadyMarked,
        alreadyMarked,
        datesRecorded,
        unconfirmed: {
            total: unconfirmedLeads.length,
            inQualifiedStage: unconfirmedLeads.filter(l => isQualifiedStage(l.pipeline_status)).length,
            ids: unconfirmedLeads.map(l => l.id),
            // Withheld entirely on a partial scan — see `scanComplete`.
            safeIds: scanComplete ? safeIds : [],
            nearMiss: { count: nearMissIds.length, ids: nearMissIds, examples: nearMissExamples },
        },
        scanComplete,
    };
}

/**
 * Clears the contacted flag on leads the Gmail sync couldn't confirm. Separate and
 * explicit: absence from a mailbox is not proof a lead was never contacted, so this
 * is never done automatically as part of a sync.
 */
export async function clearUnconfirmedContactedAction(ids: string[]): Promise<number> {
    let cleared = 0;
    for (const id of ids) {
        try {
            await updateLead(id, { contacted: false });
            cleared++;
        } catch (e) {
            console.error("Failed to clear contacted flag", id, e);
        }
    }
    return cleared;
}
