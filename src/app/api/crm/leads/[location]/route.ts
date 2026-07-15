import { NextResponse } from 'next/server';
import { getAllLeads, insertOrUpdateLead, LeadRecord } from '@/lib/db';

export async function GET(
    request: Request,
    { params }: { params: Promise<{ location: string }> }
) {
    try {
        const resolvedParams = await params;
        const locationParam = resolvedParams.location.toLowerCase();
        const leads = await getAllLeads();
        
        // Filter leads by INBOX and by the exact location string requested
        const filteredLeads = leads.filter(l => 
            l.pipeline_status === 'INBOX' && 
            l.location && 
            l.location.toLowerCase() === locationParam
        );

        return NextResponse.json({ 
            success: true, 
            location: locationParam,
            count: filteredLeads.length, 
            data: filteredLeads 
        });
    } catch (error: any) {
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}

export async function POST(
    req: Request,
    { params }: { params: Promise<{ location: string }> }
) {
    try {
        const resolvedParams = await params;
        const type = resolvedParams.location.toLowerCase();
        let location = '';
        let pipeline_status = 'OUTREACH';
        let email_status = 'VALID';

        if (type === 'uk_qualified') {
            location = 'UK';
        } else if (type === 'usa_qualified') {
            location = 'USA';
        } else if (type === 'canada_qualified') {
            location = 'CANADA';
        } else {
            return NextResponse.json({ success: false, error: 'Invalid endpoint type' }, { status: 400 });
        }

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
            
            // Hardcode the necessary ones
            mappedLead.email_status = email_status;
            mappedLead.location = location;
            mappedLead.pipeline_status = pipeline_status;
            
            if (lead.hook) mappedLead.hook = lead.hook;
            if (lead.contacted !== undefined) mappedLead.contacted = lead.contacted;
            
            const inserted = await insertOrUpdateLead(mappedLead);
            results.push(inserted);
        }

        return NextResponse.json({ success: true, count: results.length, inserted: results });
    } catch (error: any) {
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}
