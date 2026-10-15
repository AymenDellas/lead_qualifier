import { NextResponse } from 'next/server';
import { insertOrUpdateLead, updateLeadEmailVerification, LeadRecord } from '@/lib/db';
import { verifyEmail } from '@/app/actions/email-verifier-actions';
import { toPersistedVerification } from '@/lib/verification-persist';
import { isUnsafeContact } from '@/lib/prospect-qualification.cjs';
import { queueCandidates } from '@/lib/linkedin-workers.cjs';
import { pool } from '@/lib/pg_setup';

export async function GET(
    request: Request,
    { params }: { params: Promise<{ location: string }> }
) {
    try {
        const resolvedParams = await params;
        const locationParam = resolvedParams.location.toLowerCase();
        const leads = await queueCandidates(pool);
        
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
            resolveCountry(l.location).toLowerCase() === locationParam
        );

        // ── Queue ordering: best-first ──
        //
        // This is where "fewer, much better" is actually applied. The worker gets
        // ~400 profiles a day against a five-figure inbox, so the order this returns
        // decides what the next month of LinkedIn budget is spent on — every run
        // previously took the region's leads in whatever order the table produced.
        //
        // Ranking rather than filtering is deliberate: nothing is discarded, the
        // threshold stays re-tunable, and it applies retroactively to every row that
        // has a score. Unscored legacy rows sort last (an unknown score is not a good
        // score) but stay reachable by raising the limit.
        //
        // The limit is applied *after* the region filter. Applying it in SQL would
        // starve every region but whichever happens to score highest overall.
        // `LeadRecord.created_at` is typed as a string, but node-postgres hydrates
        // TIMESTAMP columns into real Date objects — so any string method on it
        // throws at runtime while typechecking cleanly. Compare as epoch millis,
        // which is correct for a Date, an ISO string, or null.
        const ts = (v: unknown): number => {
            if (!v) return 0;
            const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
            return Number.isFinite(t) ? t : 0;
        };

        const ranked = filteredLeads.sort((a, b) => {
            const av = a.fit_score ?? -1;
            const bv = b.fit_score ?? -1;
            if (av !== bv) return bv - av;
            // Oldest first among equals, so the backlog drains rather than starves.
            return ts(a.created_at) - ts(b.created_at);
        });

        const limitParam = Number(new URL(request.url).searchParams.get('limit'));
        const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : ranked.length;
        const page = ranked.slice(0, limit);

        return NextResponse.json({
            leads: page,
            total: ranked.length,
            returned: page.length,
            scored: ranked.filter(l => l.fit_score != null).length,
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
        let pipeline_status = 'QUALIFIED';

        if (type === 'uk_qualified') {
            location = 'UK';
        } else if (type === 'na_qualified') {
            // North America (US + Canada) — keep the lead's original location
            pipeline_status = 'QUALIFIED';
        } else if (type === 'usa_qualified') {
            location = 'USA';
        } else if (type === 'canada_qualified') {
            location = 'CANADA';
        } else if (type === 'other_qualified') {
            // Everything outside NA/UK. Like na_qualified, it keeps the lead's own
            // location rather than stamping one — there is no single country to write.
            //
            // This branch has to exist before the UI can offer an "Other" queue: the
            // worker builds its push endpoint as `{targetRegion}_qualified`, so
            // without it every lead scraped from that queue would qualify and then be
            // rejected here with a 400, losing the result of the scrape.
            pipeline_status = 'QUALIFIED';
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

            if (location) {
                mappedLead.location = location;
            } else if (lead.location) {
                mappedLead.location = lead.location;
            }

            // The scraper decides the stage. A lead that cleared its bar lands in
            // QUALIFIED and stays there — verification below only annotates the
            // email, it never moves or removes the lead. The strict send gate is
            // applied later, at /api/crm/leads/qualified.
            mappedLead.pipeline_status = pipeline_status === 'QUALIFIED' && isUnsafeContact(String(lead.email || '')) ? 'NOT_QUALIFIED' : pipeline_status;

            if (lead.hook) mappedLead.hook = lead.hook;
            if (lead.hook_source) mappedLead.hook_source = lead.hook_source;
            if (lead.contacted !== undefined) mappedLead.contacted = lead.contacted;

            let inserted = await insertOrUpdateLead(mappedLead);

            // Verify on arrival so the lead reaches the tab already labelled, rather
            // than sitting there as UNVERIFIED until someone remembers to check it.
            // A failure here costs a label, never the lead.
            if (mappedLead.pipeline_status === 'QUALIFIED' && inserted.email) {
                try {
                    const verification = await verifyEmail(inserted.email, 'automation');
                    // Same gate as the CRM's own verify path. This used to inline the
                    // field mapping and enforce nothing, so a VALID verdict reached the
                    // send list here without a second opinion — and this is the
                    // high-volume path, since every qualified lead the worker pushes
                    // comes through it.
                    inserted = await updateLeadEmailVerification(
                        inserted.id,
                        toPersistedVerification(verification),
                    );
                } catch (verifyError: any) {
                    console.error(`Verification failed for ${inserted.email}:`, verifyError?.message);
                }
            }

            results.push(inserted);
        }

        return NextResponse.json({ success: true, count: results.length, inserted: results });
    } catch (error: any) {
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}
