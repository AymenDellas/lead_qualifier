'use server';

import { pool } from '@/lib/pg_setup';
import { getLeadsByIds } from '@/lib/db';
import { ensureProspectSchema, saveProspectReview } from '@/lib/prospect-store';
import { normaliseLinkedinUrl } from '@/lib/utils';
import { hunterProfileKeySql } from '@/lib/hunter-contact-sync';
import { DEFAULT_PROSPECT_BATCH_SIZE, MAX_PROSPECT_BATCH_SIZE, validateProspectBatchSize } from '@/lib/prospect-batches';
import { enqueue, ensure } from '@/lib/linkedin-workers.cjs';

export async function reviewProspectAction(id: string, review: unknown, expectedResearchedAt: string, expectedReviewedAt: string | null = null) {
    return saveProspectReview(id, review, expectedResearchedAt, expectedReviewedAt);
}

export async function queueProspectResearchAction(ids: string[]) {
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_PROSPECT_BATCH_SIZE || ids.some(id => typeof id !== 'string')) throw new Error(`Select between 1 and ${MAX_PROSPECT_BATCH_SIZE.toLocaleString()} prospects to research.`);
    await ensureProspectSchema();
    const leads = await getLeadsByIds([...new Set(ids)]);
    return queueLeads(leads, await readQueuedUrls());
}

async function readQueuedUrls() {
    await ensure(pool);
    const result = await pool.query("SELECT profile_key FROM compel_worker_jobs WHERE status IN ('pending','processing')");
    return new Set<string>(result.rows.map(row => normaliseLinkedinUrl(row.profile_key)!.toLowerCase()));
}

async function queueLeads(leads: Awaited<ReturnType<typeof getLeadsByIds>>, queuedUrls: Set<string>) {
    const jobs: { id: string; leadId: string }[] = [];
    const skipped: { id: string; reason: string }[] = [];
    const eligible: {url:string;leadId:string}[] = [];
    for (const lead of leads) {
        const url = normaliseLinkedinUrl(lead.linkedin_url || '') || '';
        if (lead.do_not_contact) { skipped.push({ id: lead.id, reason: 'Suppressed' }); continue; }
        if (!/^https:\/\/(?:www\.)?linkedin\.com\/in\/[^/?#]+\/?$/.test(url)) { skipped.push({ id: lead.id, reason: 'No valid LinkedIn person profile' }); continue; }
        if (queuedUrls.has(url.toLowerCase())) { skipped.push({ id: lead.id, reason: 'Already queued' }); continue; }
        eligible.push({url,leadId:lead.id}); queuedUrls.add(url.toLowerCase());
    }
    const queued=await enqueue(pool,eligible.map(lead=>lead.url),{nativePostProcess:true});
    for(const lead of eligible){
        const job=queued.queued.find(job=>normaliseLinkedinUrl(job.url)!.toLowerCase()===lead.url.toLowerCase());
        if(job)jobs.push({id:job.id,leadId:lead.leadId});else skipped.push({id:lead.leadId,reason:'Already queued'});
    }
    return { jobs, skipped };
}

export async function queueNextProspectsAction(segment: string, limit = DEFAULT_PROSPECT_BATCH_SIZE) {
    if (!['ALL', 'EXECUTIVE', 'CAREER', 'BUSINESS'].includes(segment)) throw new Error('Invalid coaching segment.');
    validateProspectBatchSize(limit);
    await ensureProspectSchema();
    const queuedUrls = await readQueuedUrls();
    const keys = [...queuedUrls].map(url => url.split('/in/')[1]);
    const pattern = segment === 'ALL' ? '' : segment === 'EXECUTIVE' ? 'executive|leadership' : segment === 'CAREER' ? 'career' : 'business|entrepreneur';
    const profileKey = hunterProfileKeySql('l.linkedin_url');
    const result = await pool.query(`SELECT id FROM (
        SELECT DISTINCT ON (${profileKey}) l.id, l.fit_score, l.created_at
        FROM leads l WHERE l.prospect_assessment IS NULL
        AND l.do_not_contact IS NOT TRUE AND NOT (l.contacted IS TRUE AND l.contacted_source IS NOT NULL)
        AND l.linkedin_url ~ '^https://(www[.])?linkedin[.]com/in/'
        AND ($1 = '' OR l.discovery_niche ~* $1) AND NOT (${profileKey} = ANY($2::text[]))
        ORDER BY ${profileKey}, l.fit_score DESC NULLS LAST, l.created_at ASC, l.id ASC
        ) candidates ORDER BY fit_score DESC NULLS LAST, created_at ASC, id ASC LIMIT $3`, [pattern, keys, limit]);
    if (!result.rows.length) return { jobs: [], skipped: [] };
    const leads = await getLeadsByIds(result.rows.map(row => row.id));
    return queueLeads(leads.filter(lead => !(lead.contacted && lead.contacted_source)), queuedUrls);
}
