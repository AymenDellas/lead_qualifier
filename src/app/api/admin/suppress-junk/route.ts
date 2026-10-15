import { NextResponse } from 'next/server';
import { suppressJunkAddressesAction } from '@/app/actions/crm-actions';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Suppresses addresses that can't be a lead's own mailbox — placeholders, vendor
 * and registrar contacts, mangled crawler output.
 *
 *   curl -X POST http://localhost:3000/api/admin/suppress-junk
 *
 * Nothing is deleted; the rows keep their LinkedIn URL and stay re-scrapeable.
 */
export async function POST() {
    try {
        const report = await suppressJunkAddressesAction();
        return NextResponse.json({ success: true, ...report });
    } catch (error: any) {
        console.error('Junk suppression failed:', error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}
