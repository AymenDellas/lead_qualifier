import { NextResponse } from 'next/server';
import { syncContactedFromGmailAction } from '@/app/actions/gmail-actions';

export const dynamic = 'force-dynamic';
// An all-time scan of a large mailbox takes minutes, not seconds.
export const maxDuration = 800;

/**
 * Same reconcile as the CRM's "Sync Gmail" button, exposed as an endpoint so it
 * can be scripted or scheduled instead of clicked.
 *
 *   curl -X POST http://localhost:3000/api/admin/gmail-sync
 *
 * Read-only against the mailboxes; the only writes are to your own leads, and it
 * never un-marks a lead as contacted.
 */
export async function POST() {
    try {
        const report = await syncContactedFromGmailAction();
        return NextResponse.json(report, { status: report.ok ? 200 : 500 });
    } catch (error: any) {
        console.error('Gmail sync failed:', error);
        return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
}
