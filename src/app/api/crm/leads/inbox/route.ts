import { NextResponse } from 'next/server';
import { getAllLeads } from '@/lib/db';

export async function GET() {
    try {
        const leads = await getAllLeads();
        const inboxLeads = leads.filter(l => l.pipeline_status === 'INBOX');
        return NextResponse.json({ success: true, count: inboxLeads.length, data: inboxLeads });
    } catch (error: any) {
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}
