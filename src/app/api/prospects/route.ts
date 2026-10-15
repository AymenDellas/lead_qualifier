import { NextResponse } from 'next/server';
import { pool } from '@/lib/pg_setup';
import { assessmentForLead, ensureProspectSchema } from '@/lib/prospect-store';
import type { LeadRecord } from '@/lib/db';
import { RESEARCH_MAX_AGE_DAYS } from '@/lib/prospect-qualification.cjs';

export const dynamic = 'force-dynamic';
const effectiveTier = `CASE WHEN prospect_assessment->>'tier'='A' AND
    (prospect_researched_at IS NULL OR prospect_researched_at < NOW() - INTERVAL '${RESEARCH_MAX_AGE_DAYS} days'
        OR prospect_researched_at > NOW() + INTERVAL '1 day') THEN 'B'
    ELSE COALESCE(prospect_assessment->>'tier','UNREVIEWED') END`;

export async function GET(request: Request) {
    try {
        await ensureProspectSchema();
        const params = new URL(request.url).searchParams;
        const tier = params.get('tier') || 'A';
        const segment = params.get('segment') || 'ALL';
        const search = (params.get('search') || '').trim().slice(0, 150);
        const limit = Math.max(1, Math.min(100, Number(params.get('limit')) || 50));
        const offset = Math.max(0, Math.min(100000, Number(params.get('offset')) || 0));
        if (!['A', 'B', 'C', 'OUTSIDE_ICP', 'UNREVIEWED', 'ALL'].includes(tier)
            || !['EXECUTIVE', 'CAREER', 'BUSINESS', 'ALL'].includes(segment)) return NextResponse.json({ error: 'Invalid prospect filter.' }, { status: 400 });
        const values: unknown[] = [];
        const where = ['do_not_contact IS NOT TRUE'];
        if (params.get('includeManaged') !== 'true') where.push("NOT (contacted IS TRUE AND contacted_source IS NOT NULL)");
        if (segment !== 'ALL') {
            values.push(segment);
            const family = segment === 'EXECUTIVE' ? 'executive|leadership' : segment === 'CAREER' ? 'career' : 'business';
            values.push(family);
            where.push(`((prospect_assessment->'segments') ? $${values.length - 1} OR (prospect_assessment IS NULL AND discovery_niche ~* $${values.length}))`);
        }
        if (search) { values.push(`%${search}%`); where.push(`concat_ws(' ',first_name,last_name,company,website,linkedin_url,prospect_assessment->'research'->>'headline') ILIKE $${values.length}`); }
        const baseWhere = where.join(' AND ');
        const counts = await pool.query(`SELECT ${effectiveTier} AS tier, COUNT(*)::int AS total FROM leads WHERE ${baseWhere} GROUP BY 1`, values);
        if (tier !== 'ALL') { values.push(tier); where.push(`(${effectiveTier})=$${values.length}`); }
        const filteredWhere = where.join(' AND ');
        const total = await pool.query(`SELECT COUNT(*)::int AS total FROM leads WHERE ${filteredWhere}`, values);
        const query = await pool.query(`SELECT * FROM leads WHERE ${filteredWhere}
            ORDER BY CASE (${effectiveTier}) WHEN 'A' THEN 0 WHEN 'B' THEN 1 WHEN 'UNREVIEWED' THEN 2 WHEN 'C' THEN 3 ELSE 4 END,
            COALESCE((prospect_assessment->>'score')::int,fit_score,-1) DESC,
            prospect_researched_at DESC NULLS LAST, created_at ASC, id ASC
            LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, limit, offset]);
        const rows = query.rows.map((lead: LeadRecord) => ({ ...lead, prospect_assessment: assessmentForLead(lead) }));
        return NextResponse.json({ leads: rows, counts: Object.fromEntries(counts.rows.map(row => [row.tier, row.total])), total: total.rows[0].total, offset, limit });
    } catch (error) {
        console.error('[prospects] List failed:', error instanceof Error ? error.message : 'Unknown failure');
        return NextResponse.json({ error: 'Could not load the prospect shortlist. Retry in a moment.' }, { status: 500 });
    }
}
