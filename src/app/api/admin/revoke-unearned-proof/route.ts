import { NextResponse } from 'next/server';
import { pool } from '@/lib/pg_setup';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Strips verification evidence that no verification run produced.
 *
 * A past data-recovery script promoted rows by writing `email_status='VALID'`,
 * `email_verification_method='SMTP_DIRECT'` and a year-long expiry directly —
 * every field the send gate reads — without ever opening an SMTP socket. Those
 * rows then looked identical to genuinely checked ones and went out on a campaign.
 *
 * A real run always records a score, so a null score alongside SMTP_DIRECT is the
 * signature of a backfill. This clears the *method*, *expiry* and *score* on those
 * rows so they fall back into "VALID label, no proof" — already surfaced in the CRM
 * and already excluded from every export — and leaves the address itself untouched
 * so it can simply be re-verified.
 *
 *   curl -X POST http://localhost:3000/api/admin/revoke-unearned-proof
 *
 * Idempotent: re-running finds nothing once the rows have been cleaned.
 */
export async function POST() {
    const client = await pool.connect();
    try {
        const { rows: before } = await client.query(`
            SELECT COUNT(*) AS forged
            FROM leads
            WHERE email_verification_method = 'SMTP_DIRECT'
              AND email_verification_score IS NULL
        `);

        const result = await client.query(`
            UPDATE leads
            SET email_verification_method = NULL,
                email_verification_expires_at = NULL,
                email_verification_reason = CASE
                    WHEN email_verification_reason IS NULL OR email_verification_reason = ''
                        THEN 'Unverified — earlier proof was backfilled, not measured'
                    ELSE email_verification_reason || ' · proof revoked: never SMTP-checked'
                END
            WHERE email_verification_method = 'SMTP_DIRECT'
              AND email_verification_score IS NULL
            RETURNING id
        `);

        return NextResponse.json({
            success: true,
            found: Number(before[0]?.forged || 0),
            revoked: result.rowCount || 0,
            message: 'These addresses are unchanged and still in the CRM — they just need a real verification run before they can be exported.',
        });
    } catch (error: any) {
        console.error('Revoking unearned verification proof failed:', error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    } finally {
        client.release();
    }
}
