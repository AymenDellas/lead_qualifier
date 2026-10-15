import { NextResponse } from 'next/server';
import { getAllLeads, isQualifiedStage, isProvenContacted, type LeadRecord } from '@/lib/db';
import { isExportableUnverifiable, type SendTier } from '@/lib/send-tiers';
import { hasFreshEmailVerification } from '@/lib/email-verification-proof';
import { hasQualifiedEmail } from '@/lib/prospect-qualification.cjs';
import { assessmentForLead, ensureProspectSchema } from '@/lib/prospect-store';

export const dynamic = 'force-dynamic';

/**
 * The send list. This is the one place where the strict gate is applied, and it
 * stays strict on purpose: an address only qualifies if direct SMTP proved the
 * mailbox exists and that proof has not expired. Everything upstream is allowed
 * to be permissive — leads keep their place in the CRM regardless of email
 * status — because nothing upstream actually sends mail.
 *
 * `?include=risky` widens it to addresses that accepted mail but couldn't be
 * proven unique (catch-all domains, free providers). Those are deliverable but
 * unconfirmed, so they are opt-in rather than default.
 *
 * `?include=unverifiable` widens it further, to addresses about which the probe
 * learned *nothing* — overwhelmingly because the recipient server refused this
 * sending host rather than judging the mailbox. See `isExportableUnverifiable`
 * in `lib/send-tiers.ts` for why that is a host problem and not a lead problem.
 * Tiers compose: `?include=risky,unverifiable`.
 *
 * Every returned row carries `send_tier`, so the level of proof survives into
 * whatever the export is handed to. Nothing here promotes a lead between tiers.
 */
/**
 * Prefer stronger business evidence and fresher verification for shared addresses.
 */
function rankForDedupe(lead: LeadRecord): number {
    let rank = (lead.prospect_assessment?.score || 0) / 100;
    if (lead.email_verification_expires_at) rank += 1;
    return rank;
}

export async function GET(req: Request) {
    try {
        const { searchParams } = new URL(req.url);
        // Comma-separated so tiers compose (`?include=risky,unverifiable`), while
        // the long-standing `?include=risky` keeps working unchanged.
        const include = new Set(
            (searchParams.get('include') ?? '')
                .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
        );
        const includeRisky = include.has('risky');
        const includeUnverifiable = include.has('unverifiable');

        await ensureProspectSchema();
        const leads = (await getAllLeads()).map(l => ({ ...l, prospect_assessment: assessmentForLead(l) }));
        const qualifiedLeads = leads.filter(l => {
            if (!isQualifiedStage(l.pipeline_status)) return false;
            if (!hasQualifiedEmail(l)) return false;
            if (l.do_not_contact) return false;
            // Excluded for having actually been reached — not merely for having been
            // queued once. A bare `contacted` flag with no evidence behind it is a
            // record of a push, and blocking on it buried hundreds of leads that no
            // message was ever sent to. See ContactedSource in db.ts.
            if (isProvenContacted(l)) return false;
            if (!l.email) return false;

            if (l.email_status === 'VALID') {
                // The score is part of the proof. A data-recovery backfill once wrote
                // VALID + SMTP_DIRECT + a year-long expiry on 935 rows without ever
                // running a check, forging every other field this gate reads; only a
                // real verification run produces a score.
                return hasFreshEmailVerification(l);
            }
            // RISKY means the recipient server accepted mail but the address could
            // not be shown to be unique — it will deliver, it may not be a person.
            if (l.email_status === 'RISKY') return includeRisky;

            // UNVERIFIABLE means we got no verdict at all, usually because the
            // server refused this host. Opt-in, and labelled on every row.
            return includeUnverifiable && isExportableUnverifiable(l);
        });

        // One address, one send. Franchise networks and shared company inboxes put
        // the same address on many leads (one address here sits on seven), and a
        // send list that repeats it mails the same person seven times — which reads
        // as spam to them and to their provider. Keep the best-evidenced row.
        const tierOf = (l: LeadRecord): SendTier =>
            l.email_status === 'VALID' ? 'PROVEN'
                : l.email_status === 'RISKY' ? 'RISKY'
                    : 'UNVERIFIABLE';

        // Proof beats everything when the same address arrives from two tiers —
        // otherwise an unproven duplicate could displace the row that
        // was actually verified.
        const tierWeight: Record<SendTier, number> = { PROVEN: 100, RISKY: 50, UNVERIFIABLE: 0 };
        const rank = (l: LeadRecord) => tierWeight[tierOf(l)] + rankForDedupe(l);

        const byAddress = new Map<string, LeadRecord>();
        for (const lead of qualifiedLeads) {
            const key = lead.email.toLowerCase().trim();
            const existing = byAddress.get(key);
            if (!existing || rank(lead) > rank(existing)) byAddress.set(key, lead);
        }

        // The tier travels with the row. An export that mixes proven and unproven
        // addresses without saying which is which is how "verified" stopped
        // meaning anything the first time.
        const deduped = [...byAddress.values()].map(l => ({ ...l, send_tier: tierOf(l) }))
            .sort((a, b) => (b.prospect_assessment?.score || 0) - (a.prospect_assessment?.score || 0));

        const counts = deduped.reduce<Record<string, number>>((acc, l) => {
            acc[l.send_tier] = (acc[l.send_tier] ?? 0) + 1;
            return acc;
        }, {});

        return NextResponse.json({
            success: true,
            count: deduped.length,
            duplicatesCollapsed: qualifiedLeads.length - deduped.length,
            tiers: {
                proven: counts.PROVEN ?? 0,
                risky: counts.RISKY ?? 0,
                unverifiable: counts.UNVERIFIABLE ?? 0,
            },
            data: deduped,
        });
    } catch (error: any) {
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}
