import { NextResponse } from 'next/server';
import { insertOrUpdateLead, getAllLeads, LeadRecord } from '@/lib/db';

export async function POST(req: Request) {
    try {
        const body = await req.json();

        const rawLeads = Array.isArray(body) ? body : [body];
        
        const results = [];
        for (const lead of rawLeads) {
            const mappedLead: Partial<LeadRecord> = {
                linkedin_url: lead.linkedin_url || lead.url || '',
                first_name: lead.first_name || lead.firstName || '',
                last_name: lead.last_name || lead.lastName || '',
                company: lead.company || lead.company_name || '',
                website: lead.website || '',
                website_source: lead.website_source || '',
                email: lead.email || '',
                all_emails: lead.all_emails || '',
                hook: lead.hook || '',
                location: lead.location || '',
                contacted: lead.contacted || false,
            };
            
            const inserted = await insertOrUpdateLead(mappedLead);
            results.push(inserted);
        }

        return NextResponse.json({ success: true, count: results.length, inserted: results });
    } catch (error: any) {
        console.error('API /api/crm/leads error:', error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}

export async function GET() {
    try {
        const leads = await getAllLeads();
        return NextResponse.json({ success: true, count: leads.length, data: leads });
    } catch (error: any) {
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}
