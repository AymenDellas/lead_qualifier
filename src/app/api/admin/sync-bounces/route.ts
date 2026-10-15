import { NextResponse } from 'next/server';
import { syncBouncesAction } from '@/app/actions/bounce-actions';

export const dynamic = 'force-dynamic';
export const maxDuration = 800;

/**
 * Reads delivery-failure reports from the connected inboxes and suppresses the
 * leads they name. Safe to run after every send.
 *
 *   curl -X POST http://localhost:3000/api/admin/sync-bounces
 */
export async function POST() {
    try {
        const report = await syncBouncesAction();
        return NextResponse.json(report, { status: report.ok ? 200 : 500 });
    } catch (error: any) {
        console.error('Bounce sync failed:', error);
        return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
}
