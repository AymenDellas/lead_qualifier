import { NextResponse } from 'next/server';
import { getAllLeads } from '@/lib/db';

export async function GET() {
    try {
        const leads = await getAllLeads();
        const qualifiedLeads = leads.filter(l => 
            l.pipeline_status === 'OUTREACH' && 
            (l.email_status === 'VALID' || l.email_status === 'RISKY') &&
            l.hook !== ''
        );
        return NextResponse.json({ success: true, count: qualifiedLeads.length, data: qualifiedLeads });
    } catch (error: any) {
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}
