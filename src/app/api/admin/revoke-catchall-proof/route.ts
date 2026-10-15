import { NextResponse } from 'next/server';
import { pool } from '@/lib/pg_setup';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Demotes addresses that were marked VALID on a catch-all domain.
 *
 * Companion to `revoke-unearned-proof`, for the other way a row reached the send
 * list without proof. That one catches rows where no verification ran at all
 * (SMTP_DIRECT with a null score — the signature of a backfill). This one catches
 * rows where verification *did* run, recorded a real score, and still concluded
 * VALID on evidence that cannot support it.
 *
 * The cause: `buildFinalResult` carried an exemption promoting catch-all domains
 * to VALID whenever the MX was Google, on the reasoning that a catch-all "accepts
 * email without bouncing". Accepting at RCPT is not a promise to deliver — Google
 * evaluates routing rules, aliases, and suspended or over-quota mailboxes after
 * the transaction closes and returns an async NDR later, none of which a probe can
 * see. It also promoted addresses at domains like bit.ly, which sit on Google's MX
 * and accept every recipient. 106 rows were affected; 104 were on the live send
 * list. The exemption is gone, and `toPersistedVerification` now enforces the
 * invariant on both write paths, so this only repairs rows written before that.
 *
 * Demotion, not deletion: RISKY keeps the lead in the CRM and still exportable via
 * `?include=risky`, and the address is untouched, so a later verification run can
 * promote it properly if the domain turns out not to be catch-all. The expiry is
 * cleared so the row cannot satisfy the send gate even if its status is changed by
 * something else.
 *
 *   curl -X POST http://localhost:3000/api/admin/revoke-catchall-proof
 *
 * Idempotent: re-running finds nothing once the rows have been demoted.
 */
export async function POST() {
    const client = await pool.connect();
    try {
        // Catch-all acceptance is only recorded in the reason text — there is no
        // stored `catchAll` column — so the reason is the audit trail. Both the
        // provider-specific phrasing and the generic one are matched; a VALID row
        // carrying either was promoted on evidence that does not prove a mailbox.
        const PREDICATE = `
            email_status = 'VALID'
            AND (
                email_verification_reason ILIKE '%Google Workspace catch-all%'
             OR email_verification_reason ILIKE '%Accepted by catch-all server%'
            )
        `;

        const { rows: before } = await client.query(`
            SELECT COUNT(*) AS unproven,
                   COUNT(*) FILTER (
                       WHERE email_verification_expires_at > NOW()
                         AND COALESCE(do_not_contact, false) = false
                         AND pipeline_status IN ('QUALIFIED', 'OUTREACH')
                   ) AS on_send_list
            FROM leads WHERE ${PREDICATE}
        `);

        const result = await client.query(`
            UPDATE leads
            SET email_status = 'RISKY',
                email_verification_score = LEAST(COALESCE(email_verification_score, 70), 70),
                email_verification_expires_at = NULL,
                email_verification_reason =
                    'Catch-all domain — a random recipient was also accepted, so this mailbox is unproven'
                    || ' · demoted: the catch-all exemption that promoted it was incorrect'
            WHERE ${PREDICATE}
            RETURNING id
        `);

        const { rows: after } = await client.query(`
            SELECT COUNT(*) AS sendable
            FROM leads
            WHERE email_status = 'VALID'
              AND email_verification_method = 'SMTP_DIRECT'
              AND email_verification_score IS NOT NULL
              AND email_verification_expires_at > NOW()
              AND COALESCE(do_not_contact, false) = false
              AND pipeline_status IN ('QUALIFIED', 'OUTREACH')
              AND NOT (contacted AND contacted_source IS NOT NULL)
        `);

        return NextResponse.json({
            success: true,
            found: Number(before[0]?.unproven || 0),
            wasOnSendList: Number(before[0]?.on_send_list || 0),
            demoted: result.rowCount || 0,
            sendListNow: Number(after[0]?.sendable || 0),
            message:
                'Demoted to RISKY, not removed. These addresses accepted mail but could not be shown to belong to a real mailbox; '
                + 're-verify them to promote any whose domain turns out not to be catch-all.',
        });
    } catch (error: any) {
        console.error('Revoking catch-all verification proof failed:', error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    } finally {
        client.release();
    }
}
