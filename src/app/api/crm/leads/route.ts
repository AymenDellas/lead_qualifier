import { NextResponse } from 'next/server';
import { insertOrUpdateLead, getAllLeads, LeadRecord } from '@/lib/db';

export async function POST(req: Request) {
    try {
        const body = await req.json();

        const rawLeads = Array.isArray(body) ? body : [body];
        
        const results = [];
        for (const lead of rawLeads) {
            const mappedLead: Partial<LeadRecord> = {};
            if (lead.linkedin_url || lead.url) mappedLead.linkedin_url = lead.linkedin_url || lead.url;
            if (lead.first_name || lead.firstName) mappedLead.first_name = lead.first_name || lead.firstName;
            if (lead.last_name || lead.lastName) mappedLead.last_name = lead.last_name || lead.lastName;
            if (lead.company || lead.company_name) mappedLead.company = lead.company || lead.company_name;
            if (lead.website) mappedLead.website = lead.website;
            if (lead.website_source) mappedLead.website_source = lead.website_source;
            if (lead.email) mappedLead.email = lead.email;
            if (lead.all_emails) mappedLead.all_emails = lead.all_emails;
            if (lead.email_status) mappedLead.email_status = lead.email_status;
            if (lead.hook) mappedLead.hook = lead.hook;
            if (lead.location) mappedLead.location = lead.location;
            if (lead.contacted !== undefined) mappedLead.contacted = lead.contacted;
            if (lead.pipeline_status) mappedLead.pipeline_status = lead.pipeline_status;
            
            const inserted = await insertOrUpdateLead(mappedLead);
            results.push(inserted);
        }

        return NextResponse.json({ success: true, count: results.length, inserted: results });
    } catch (error: any) {
        console.error('API /api/crm/leads error:', error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}

export async function GET(req: Request) {
    try {
        const { searchParams } = new URL(req.url);
        const location = searchParams.get('location');
        const status = searchParams.get('status');

        let leads = await getAllLeads();

        if (location) {
            leads = leads.filter(l => l.location?.toUpperCase() === location.toUpperCase());
        }
        if (status) {
            leads = leads.filter(l => l.pipeline_status === status);
        }

        return NextResponse.json({ success: true, count: leads.length, data: leads });
    } catch (error: any) {
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}
