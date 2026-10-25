import { pool } from './pg_setup';
import type { LeadRecord } from './db';
import { hunterProfileKeySql } from './hunter-contact-sync';
import { assessProspect, type ProspectContactAssessment } from './prospect-qualification.cjs';
import { hasFreshSmtpProof } from './email-verification-proof';

export type CrmLead = Omit<LeadRecord, 'prospect_assessment'> & { prospect_assessment?: ProspectContactAssessment | null };
export type ContactPatch = Pick<LeadRecord, 'id' | 'contacted' | 'contacted_source' | 'contacted_at' | 'in_hunter' | 'linkedin_dm_at'>;

// Research pages, post bodies and crawl queues are for the research screen. The
// list needs identity/activity, contact ownership and facts for its existing gates
// and priority score. Project before transferring JSON from Postgres.
const columns = `l.id,l.linkedin_url,l.first_name,l.last_name,l.company,l.website,l.website_source,
    l.email,l.all_emails,l.email_status,l.email_verification_method,l.email_verification_reason,
    l.email_verification_score,l.email_verified_at,l.email_verification_expires_at,
    l.hook,l.hook_source,l.pipeline_status,l.location,l.contacted,l.contacted_source,l.contacted_at,
    l.linkedin_dm_at,l.outcome,l.do_not_contact,l.created_at,l.prospect_review,
    CASE WHEN l.prospect_assessment->'research' IS NOT NULL THEN jsonb_build_object('version',l.prospect_assessment->'version','research',
        r.value - ARRAY['about','latestPostText','activityEvidence','description','pages','crawl','limitations','facts','contacts']
        || jsonb_build_object('facts', CASE WHEN jsonb_typeof(r.value->'facts')='object' THEN COALESCE((SELECT jsonb_object_agg(f.key,jsonb_build_object('state',f.value->'state',
            'evidence',(SELECT jsonb_agg(jsonb_build_object('url',e.value->'url','source',e.value->'source',
                'excerpt',CASE WHEN jsonb_typeof(e.value->'excerpt')='string' THEN left(e.value->>'excerpt',8) ELSE NULL END))
                FROM jsonb_array_elements(CASE WHEN jsonb_typeof(f.value->'evidence')='array' THEN f.value->'evidence' ELSE '[]'::jsonb END)
                    WITH ORDINALITY e(value,ordinal) WHERE e.ordinal<=4)))
            FROM jsonb_each(r.value->'facts') f),'{}'::jsonb) ELSE r.value->'facts' END,
        'contacts',(SELECT jsonb_agg(jsonb_build_object('address',c.value->'address','url',c.value->'url','ownership',c.value->'ownership'))
            FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.value->'contacts')='array' THEN r.value->'contacts' ELSE '[]'::jsonb END)
                WITH ORDINALITY c(value,ordinal) WHERE c.ordinal<=15)))
    ELSE NULL END AS prospect_assessment`;
const researchJoin = `CROSS JOIN LATERAL (SELECT COALESCE(NULLIF(l.prospect_assessment->'baseResearch','null'::jsonb),
    l.prospect_assessment->'research') AS value) r`;

// The same normalized membership rule as syncHunterContacted, without rewriting
// leads on each read. UNION deduplicates shared profiles before joining the grid.
function membersSql(selected = false, hunter = true, page = false) {
    if (!hunter) return 'WITH members AS (SELECT id FROM leads WHERE FALSE)';
    return `WITH lead_keys AS MATERIALIZED (
        SELECT l.id, ${hunterProfileKeySql('l.linkedin_url')} AS profile_key FROM leads l ${page ? 'WHERE l.id IN (SELECT id FROM page)' : selected ? 'WHERE l.id=ANY($1::text[])' : ''}
    ), hunter_keys AS MATERIALIZED (
        SELECT p.data->>'crmLeadId' AS lead_id, ${hunterProfileKeySql('p.linkedin_url')} AS profile_key FROM case_study_prospects p
    ), members AS (
        SELECT l.id FROM lead_keys l JOIN hunter_keys p ON p.lead_id=l.id
        UNION SELECT l.id FROM lead_keys l JOIN hunter_keys p ON p.profile_key=l.profile_key WHERE l.profile_key IS NOT NULL
    )`;
}

export function crmLead(lead: LeadRecord): CrmLead {
    // Apply the legacy label safety rule in memory. Loading a grid must not run
    // full-table maintenance UPDATEs or wait for their locks.
    const legacyNegative = ['INVALID','RISKY'].includes(lead.email_status) && !lead.email_verification_method
        && !lead.email_verification_reason?.trim() && lead.outcome !== 'BOUNCED' && !lead.do_not_contact;
    const legacyValid = lead.email_status === 'VALID' && (!['SMTP_DIRECT','QUICKEMAILVERIFICATION'].includes(lead.email_verification_method || '')
        || !lead.email_verified_at || !lead.email_verification_expires_at);
    if (legacyNegative || legacyValid) lead = { ...lead, email_status: 'UNVERIFIED', email_verification_score: null,
        email_verification_expires_at: null, email_verification_reason: legacyNegative ? 'Label reset: legacy verdict had no verification evidence'
            : [lead.email_verification_reason, 'Label reset: no stored verification proof'].filter(Boolean).join(' · ') };
    let assessment: ProspectContactAssessment | null = null;
    if (lead.prospect_assessment?.research) {
        try {
            const value = assessProspect(lead.prospect_assessment.baseResearch || lead.prospect_assessment.research,
                { review: lead.prospect_review, email: lead.email, emailProven: hasFreshSmtpProof(lead),legacyFollowersUnchecked:(lead.prospect_assessment.version||1)<2&&!lead.prospect_assessment.research.followers });
            assessment = { version: value.version, score: value.score, contact: value.contact,
                research: { profileIdentityConfirmed: value.research.profileIdentityConfirmed, lastActivityAt: value.research.lastActivityAt,followers:value.research.followers,connections:value.research.connections } };
        } catch { /* Match the existing assessmentForLead fallback for invalid research. */ }
    }
    const { prospect_review: _review, ...record } = lead;
    return { ...record, contacted: lead.in_hunter || lead.contacted,
        contacted_source: lead.in_hunter ? lead.contacted_source || 'HUNTER' : lead.contacted_source,
        prospect_assessment: assessment };
}

export async function getCrmLeads(): Promise<CrmLead[]> {
    let rows: LeadRecord[];
    try {
        rows = (await pool.query(`${membersSql()} SELECT ${columns},m.id IS NOT NULL AS in_hunter
            FROM leads l ${researchJoin} LEFT JOIN members m ON m.id=l.id ORDER BY l.created_at DESC,l.id`)).rows;
    } catch (error) {
        if ((error as {code?: string}).code !== '42P01') throw error;
        // Older installations may not have the optional Hunter table yet.
        rows = (await pool.query(`SELECT ${columns},FALSE AS in_hunter FROM leads l ${researchJoin} ORDER BY l.created_at DESC,l.id`)).rows;
    }
    return rows.map(crmLead);
}

/** Show the first screen promptly; hydrate the local tab/search index in bounded pages. */
export async function getCrmPage(limit: number, offset: number) {
    const query = (hunter: boolean) => `WITH page AS MATERIALIZED (
        SELECT id,COUNT(*) OVER()::int AS total_count FROM leads ORDER BY created_at DESC,id LIMIT $1 OFFSET $2
    ), ${membersSql(false, hunter, true).slice(5)}
        SELECT ${columns},m.id IS NOT NULL AS in_hunter,page.total_count
        FROM page JOIN leads l ON l.id=page.id ${researchJoin} LEFT JOIN members m ON m.id=l.id
        ORDER BY l.created_at DESC,l.id`;
    let rows;
    try { rows = (await pool.query(query(true), [limit,offset])).rows; }
    catch (error) {
        if ((error as {code?:string}).code !== '42P01') throw error;
        rows = (await pool.query(query(false), [limit,offset])).rows;
    }
    return { data: rows.map(({total_count: _total, ...row}) => crmLead(row as LeadRecord)), total: Number(rows[0]?.total_count || 0) };
}

/** One atomic statement for an explicit manual contact claim, regardless of size. */
export async function setCrmContacted(ids: string[], contacted: boolean): Promise<ContactPatch[]> {
    if (!ids.length) return [];
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id) || typeof contacted !== 'boolean') throw new Error('Invalid contact update.');
    const unique = [...new Set(ids)];
    // Unchecking protected contact evidence must fail the whole operation. Keeping
    // the guard in the UPDATE avoids read/modify/write races and unrelated fields.
    const query = (hunter: boolean) => `${membersSql(true, hunter)}, target AS MATERIALIZED (
        SELECT l.id,l.contacted_source,l.linkedin_dm_at FROM leads l WHERE l.id=ANY($1::text[]) FOR UPDATE
    ), blocked AS (
        SELECT t.id FROM target t
        WHERE NOT $2::boolean AND (t.contacted_source IN ('LINKEDIN','HUNTER') OR t.linkedin_dm_at IS NOT NULL
            OR EXISTS(SELECT 1 FROM members m WHERE m.id=t.id))
    ), changed AS (
        UPDATE leads l SET contacted=$2::boolean,
            contacted_at=CASE WHEN $2::boolean THEN COALESCE(l.contacted_at,CURRENT_TIMESTAMP) ELSE l.contacted_at END,
            contacted_source=CASE WHEN $2::boolean THEN COALESCE(NULLIF(l.contacted_source,''),
                CASE WHEN EXISTS(SELECT 1 FROM members m WHERE m.id=l.id) THEN 'HUNTER'
                    WHEN l.linkedin_dm_at IS NOT NULL THEN 'LINKEDIN' ELSE 'MANUAL' END) ELSE NULL END
        FROM target t WHERE l.id=t.id AND NOT EXISTS(SELECT 1 FROM blocked)
            AND (SELECT COUNT(*) FROM target)=cardinality($1::text[])
        RETURNING l.id,l.contacted,l.contacted_source,l.contacted_at,l.linkedin_dm_at
    ) SELECT c.*,EXISTS(SELECT 1 FROM members m WHERE m.id=c.id) AS in_hunter FROM changed c`;
    let result;
    try { result = await pool.query(query(true), [unique, contacted]); }
    catch (error) {
        if ((error as {code?: string}).code !== '42P01') throw error;
        result = await pool.query(query(false), [unique, contacted]);
    }
    if (result.rows.length !== unique.length) throw new Error('Could not update every lead. Hunter reservations and tracked DMs must be updated in Hunter.');
    return result.rows;
}
