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
        
        const resolveCountry = (loc: string | undefined): string => {
            if (!loc) return 'OTHER';
            const upperLoc = loc.toUpperCase();
            if (upperLoc.includes('LONDON, ON') || upperLoc.includes('LONDON, ONTARIO')) return 'NA';
            if (upperLoc.includes('VANCOUVER, WA') || upperLoc.includes('VANCOUVER, WASHINGTON')) return 'NA';
            const ukKeywords = ['UK', 'UNITED KINGDOM', 'ENGLAND', 'SCOTLAND', 'WALES', 'NORTHERN IRELAND', 'LONDON', 'BIRMINGHAM', 'MANCHESTER', 'GLASGOW', 'NEWCASTLE', 'SHEFFIELD', 'LEEDS', 'LIVERPOOL', 'BRISTOL', 'EDINBURGH', 'CARDIFF', 'BELFAST', 'NOTTINGHAM', 'LEICESTER', 'COVENTRY', 'BRADFORD'];
            if (ukKeywords.some(kw => upperLoc.includes(kw) || upperLoc === kw)) return 'UK';
            const canadaKeywords = ['CANADA', 'TORONTO', 'MONTREAL', 'VANCOUVER', 'CALGARY', 'EDMONTON', 'OTTAWA', 'WINNIPEG', 'QUEBEC', 'HAMILTON', 'KITCHENER', 'VICTORIA', 'HALIFAX', 'OSHAWA', 'WINDSOR', 'SASKATOON', 'REGINA', 'KELOWNA', 'ON', 'BC', 'QC', 'AB', 'MB', 'SK', 'NS', 'NB', 'NL', 'PE', 'ONTARIO', 'BRITISH COLUMBIA', 'ALBERTA', 'NOVA SCOTIA', 'MANITOBA', 'SASKATCHEWAN'];
            if (canadaKeywords.some(kw => upperLoc.includes(kw) || upperLoc === kw)) return 'NA';
            const usKeywords = ['US', 'USA', 'AMERICA', 'UNITED STATES', 'NEW YORK', 'LOS ANGELES', 'CHICAGO', 'HOUSTON', 'PHOENIX', 'PHILADELPHIA', 'SAN ANTONIO', 'SAN DIEGO', 'DALLAS', 'SAN JOSE', 'AUSTIN', 'JACKSONVILLE', 'FORT WORTH', 'COLUMBUS', 'CHARLOTTE', 'SAN FRANCISCO', 'INDIANAPOLIS', 'SEATTLE', 'DENVER', 'WASHINGTON', 'BOSTON', 'EL PASO', 'NASHVILLE', 'DETROIT', 'OKLAHOMA CITY', 'PORTLAND', 'LAS VEGAS', 'MEMPHIS', 'LOUISVILLE', 'BALTIMORE', 'MILWAUKEE', 'ALBUQUERQUE', 'TUCSON', 'FRESNO', 'SACRAMENTO', 'ATLANTA', 'KANSAS CITY', 'MIAMI', 'RALEIGH', 'OMAHA', 'OAKLAND', 'MINNEAPOLIS', 'TULSA', 'TAMPA', 'NEW ORLEANS', 'WICHITA', 'CLEVELAND', 'HONOLULU', 'COLORADO', 'FLORIDA', 'TEXAS', 'CALIFORNIA', 'GREATER', 'AREA', 'CA', 'NY', 'TX', 'FL', 'IL', 'PA', 'OH', 'GA', 'NC', 'MI', 'WA', 'AZ', 'MA', 'TN', 'IN', 'MO', 'MD', 'WI', 'CO', 'MN', 'SC', 'AL', 'LA', 'KY', 'OR', 'OK', 'CT', 'IA', 'MS', 'AR', 'KS', 'UT', 'NV', 'NM', 'WV', 'NE', 'ID', 'HI', 'ME', 'NH', 'RI', 'MT', 'DE', 'SD', 'ND', 'AK', 'VT', 'WY'];
            const usRegex = new RegExp(`\\b(${usKeywords.join('|')})\\b`);
            if (usRegex.test(upperLoc)) return 'NA';
            return 'OTHER';
        };

        // Filter leads by INBOX and by the resolved country
        const filteredLeads = leads.filter(l => 
            l.pipeline_status === 'INBOX' && 
            resolveCountry(l.location).toLowerCase() === locationParam
        );

        return NextResponse.json(filteredLeads);
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

        if (type === 'uk_qualified') {
            location = 'UK';
        } else if (type === 'na_qualified') {
            // North America (US + Canada) — keep the lead's original location
            pipeline_status = 'OUTREACH';
        } else if (type === 'not_qualified') {
            pipeline_status = 'NOT_QUALIFIED';
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
            
            // Email status from incoming lead, or unverified
            mappedLead.email_status = lead.email_status || 'UNVERIFIED';
            
            if (location) {
                mappedLead.location = location;
            } else if (lead.location) {
                mappedLead.location = lead.location;
            }

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
