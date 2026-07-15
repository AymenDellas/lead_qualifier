import { NextResponse } from 'next/server';
import { getAllLeads } from '@/lib/db';

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const locationFilter = searchParams.get('location')?.toLowerCase();

        const leads = await getAllLeads();
        let inboxLeads = leads.filter(l => l.pipeline_status === 'INBOX');

        if (locationFilter) {
            inboxLeads = inboxLeads.filter(l => 
                l.location && l.location.toLowerCase().includes(locationFilter)
            );
        }

        return NextResponse.json({ success: true, count: inboxLeads.length, data: inboxLeads });
    } catch (error: any) {
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}
