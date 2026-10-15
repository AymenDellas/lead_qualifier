import { NextResponse } from 'next/server';
import { getAllLeads, isQualifiedStage } from '@/lib/db';
import { verifyLeadEmailsAction } from '@/app/actions/crm-actions';
import { hasFreshSmtpProof } from '@/lib/email-verification-proof';

export const dynamic = 'force-dynamic';
export const maxDuration = 800;

/**
 * Re-checks leads whose email label is not backed by evidence.
 *
 *   curl -X POST .../api/admin/reverify -d '{"limit":200}'                      # stale VALID
 *   curl -X POST .../api/admin/reverify -d '{"target":"unknown","limit":100}'   # never got an answer
 *
 * Two targets, because they fail for opposite reasons:
 *
 * `unproven-valid` (default) — the label claims proof that isn't there: no
 * direct-SMTP result was recorded, or it has expired. These are excluded from
 * every send list until re-checked, so this is what turns them back into
 * usable leads.
 *
 * `unknown` — the probe never got a verdict at all. Worth retrying because the
 * common causes are temporary: a greylister that has since cleared, a server
 * that was slow, a rate limit that has reset. It is *not* worth retrying in a
 * tight loop, because the other common cause is the recipient server refusing
 * this machine's IP outright, and that answer will not change today. The
 * verifier caches a host-level refusal for 30 minutes and skips the rest of that
 * provider's addresses, so a run over a mostly-blocked backlog now finishes in
 * seconds instead of timing out address by address for hours.
 *
 * Batched at 100 because that's the per-call cap in `verifyLeadEmailsAction`;
 * SMTP pacing is handled inside the verifier and must not be worked around here.
 */
export async function POST(request: Request) {
    try {
        const body = await request.json().catch(() => ({}));
        const limit = Math.max(1, Math.min(Number(body.limit) || 200, 1000));
        const target: string = String(body.target || 'unproven-valid').toLowerCase();

        if (!['unproven-valid', 'unknown'].includes(target)) {
            return NextResponse.json(
                { success: false, error: `Unknown target "${target}". Use "unproven-valid" or "unknown".` },
                { status: 400 });
        }

        const leads = await getAllLeads();
        const stale = leads.filter(lead => {
            if (!isQualifiedStage(lead.pipeline_status)) return false;
            if (lead.do_not_contact || !lead.email) return false;

            if (target === 'unknown') return lead.email_status === 'UNKNOWN';

            if (lead.email_status === 'UNVERIFIED' && lead.email_verification_reason?.includes('Label reset: no stored direct SMTP proof')) return true;
            return lead.email_status === 'VALID' && !hasFreshSmtpProof(lead);
        }).slice(0, limit);

        if (stale.length === 0) {
            return NextResponse.json({ success: true, checked: 0, message: 'Nothing to re-verify.' });
        }

        // Statuses before the run, so the response reports what actually *moved*
        // rather than a distribution that looks the same either way. A re-verify
        // that changes nothing and a re-verify that rescued 40 leads produce
        // identical `outcomes` blocks otherwise — which is exactly how "I re-ran
        // it and they stay unknown" went unexplained.
        const before = new Map(stale.map(l => [l.id, l.email_status || 'UNKNOWN']));

        const outcomes: Record<string, number> = {};
        const transitions: Record<string, number> = {};
        const startedAt = Date.now();
        let checked = 0;
        let skipped = 0;
        let failed = 0;
        for (let i = 0; i < stale.length; i += 100) {
            const batch = stale.slice(i, i + 100);
            const report = await verifyLeadEmailsAction(batch.map(l => l.id));
            skipped += report.skipped.length;
            failed += report.failed.length;
            for (const lead of report.updated) {
                checked++;
                const status = lead.email_status || 'UNKNOWN';
                outcomes[status] = (outcomes[status] || 0) + 1;
                const was = before.get(lead.id) || 'UNKNOWN';
                if (was !== status) {
                    const key = `${was} -> ${status}`;
                    transitions[key] = (transitions[key] || 0) + 1;
                }
            }
        }

        const changed = Object.values(transitions).reduce((a, b) => a + b, 0);

        return NextResponse.json({
            success: true,
            target,
            candidates: stale.length,
            checked,
            skipped,
            failed,
            changed,
            unchanged: checked - changed,
            elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
            outcomes,
            transitions,
        });
    } catch (error: any) {
        console.error('Re-verification failed:', error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}
