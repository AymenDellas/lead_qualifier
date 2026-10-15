import { pool } from './pg_setup';
import { getLead, insertOrUpdateLead, type LeadRecord } from './db';
import { hasFreshSmtpProof } from './email-verification-proof';
import { normaliseLinkedinUrl } from './utils';
import { hunterProfileKeySql } from './hunter-contact-sync';
import {
    assessProspect, validateResearch, validateReview, pipelineForAssessment, isUnsafeContact,
    type ProspectResearch, type ProspectReview, type ProspectAssessment,
} from './prospect-qualification.cjs';

export const PROSPECT_SCHEMA_SQL = `
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS prospect_assessment JSONB;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS prospect_review JSONB;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS prospect_researched_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS idx_leads_prospect_priority
        ON leads ((prospect_assessment->>'tier'), (prospect_assessment->>'segment'), prospect_researched_at DESC);
`;
let schemaReady: Promise<void> | undefined;
export async function ensureProspectSchema() {
    if (!schemaReady) schemaReady = pool.query(PROSPECT_SCHEMA_SQL).then(() => undefined).catch(error => { schemaReady = undefined; throw error; });
    return schemaReady;
}

export function assessmentForLead(lead: LeadRecord): ProspectAssessment | null {
    if (!lead.prospect_assessment?.research) return null;
    try {
        return assessProspect(lead.prospect_assessment.baseResearch || lead.prospect_assessment.research, {
            review: lead.prospect_review, email: lead.email, emailProven: hasFreshSmtpProof(lead),
        });
    } catch { return null; }
}

export async function saveProspectResearch(input: {
    linkedinUrl: string; research: ProspectResearch; firstName?: string; lastName?: string;
    email?: string; emails?: string[]; emailSource?: string; websiteSource?: string;
}) {
    await ensureProspectSchema();
    if (!/^https:\/\/(?:[a-z]{2,3}\.)?(?:www\.)?linkedin\.com\/in\/[^/?#]+\/?(?:\?.*)?$/.test(input.linkedinUrl)) throw new Error('Research must belong to a LinkedIn person profile.');
    const canonicalUrl = normaliseLinkedinUrl(input.linkedinUrl)!;
    const research = validateResearch(input.research);
    if (normaliseLinkedinUrl(research.linkedinUrl)?.toLowerCase() !== canonicalUrl.toLowerCase()) throw new Error('Research profile does not match the CRM profile.');
    const profileKey = new URL(canonicalUrl).pathname.split('/in/')[1].toLowerCase();
    const found = await pool.query(`SELECT l.id FROM leads l WHERE ${hunterProfileKeySql('l.linkedin_url')}=$1
        ORDER BY l.do_not_contact DESC NULLS LAST, (l.contacted IS TRUE AND l.contacted_source IS NOT NULL) DESC,
        l.created_at ASC, l.id ASC LIMIT 1`, [profileKey]);
    let id = found.rows[0]?.id as string | undefined;
    if (!id) {
        const inserted = await insertOrUpdateLead({ linkedin_url: canonicalUrl, first_name: input.firstName || '', last_name: input.lastName || '', pipeline_status: 'INBOX' });
        id = inserted.id;
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const locked = await client.query('SELECT * FROM leads WHERE id=$1 FOR UPDATE', [id]);
        const lead: LeadRecord = locked.rows[0];
        if (!lead) throw new Error('Lead no longer exists.');
        const safeEmails = [...new Set((input.emails || research.contacts.map(c => c.address)).filter(address => !isUnsafeContact(address)).map(address => address.trim().toLowerCase()))];
        const requested = (input.email || '').trim().toLowerCase();
        const existing = (lead.email || '').trim().toLowerCase();
        // Re-research cannot reuse a vendor address or silently promote an unconfirmed address.
        const attributableEmails = research.contacts.filter(c => ['PUBLISHED', 'DOMAIN_MATCH'].includes(c.ownership)).map(c => c.address);
        const candidate = attributableEmails.includes(requested) ? requested : attributableEmails[0]
            || (safeEmails.includes(requested) ? requested : safeEmails[0]) || (!isUnsafeContact(existing) ? existing : '');
        const changedEmail = candidate !== existing;
        const assessment = assessProspect(research, { review: lead.prospect_review, email: candidate, emailProven: !changedEmail && hasFreshSmtpProof(lead) });
        const stage = pipelineForAssessment(assessment);
        const result = await client.query(`UPDATE leads SET
            prospect_assessment=$2::jsonb, prospect_researched_at=$3::timestamptz, pipeline_status=$4,
            first_name=CASE WHEN $5<>'' THEN $5 ELSE first_name END,
            last_name=CASE WHEN $6<>'' THEN $6 ELSE last_name END,
            website=CASE WHEN $7<>'' THEN $7 ELSE website END,
            website_source=CASE WHEN $8<>'' THEN $8 ELSE website_source END,
            location=CASE WHEN $13<>'' THEN $13 ELSE location END,
            email=$9, all_emails=$10,
            email_status=CASE WHEN $11::boolean THEN $12 ELSE email_status END,
            email_verification_method=CASE WHEN $11::boolean THEN NULL ELSE email_verification_method END,
            email_verification_reason=CASE WHEN $11::boolean THEN NULL ELSE email_verification_reason END,
            email_verification_score=CASE WHEN $11::boolean THEN NULL ELSE email_verification_score END,
            email_verified_at=CASE WHEN $11::boolean THEN NULL ELSE email_verified_at END,
            email_verification_expires_at=CASE WHEN $11::boolean THEN NULL ELSE email_verification_expires_at END
            WHERE id=$1 RETURNING *`, [id, JSON.stringify(assessment), research.researchedAt, stage,
            input.firstName || '', input.lastName || '', research.website, input.websiteSource || '', candidate,
            JSON.stringify(safeEmails.length ? safeEmails : candidate ? [candidate] : []), changedEmail,
            input.emailSource === 'pattern_guess' ? 'GUESSED' : 'UNVERIFIED', research.profileIdentityConfirmed ? research.profileLocation : '']);
        await client.query('COMMIT');
        return result.rows[0] as LeadRecord;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
}

export async function saveProspectReview(id: string, value: unknown, expectedResearchedAt: string, expectedReviewedAt: string | null = null) {
    await ensureProspectSchema();
    const review = validateReview(value);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const locked = await client.query('SELECT * FROM leads WHERE id=$1 FOR UPDATE', [id]);
        const lead: LeadRecord = locked.rows[0];
        if (!lead?.prospect_assessment?.research) throw new Error('Research the prospect before reviewing their evidence.');
        if (lead.prospect_assessment.researchedAt !== expectedResearchedAt) throw new Error('This prospect was researched again. Refresh before saving your review.');
        if ((lead.prospect_review?.reviewedAt || null) !== expectedReviewedAt) throw new Error('This review changed in another window. Refresh before saving.');
        review.contactEmail = review.contactOwnership ? (lead.email || '').trim().toLowerCase() : '';
        if (review.contactOwnership === 'CONFIRMED' && isUnsafeContact(review.contactEmail)) throw new Error('Add a safe contact address before confirming its ownership.');
        // This is an intentional full review replacement: removing a finding restores automated evidence.
        const assessment = assessProspect(lead.prospect_assessment.baseResearch || lead.prospect_assessment.research, { review, email: lead.email, emailProven: hasFreshSmtpProof(lead) });
        await client.query(`UPDATE leads SET prospect_review=$2::jsonb, prospect_assessment=$3::jsonb,
            pipeline_status=$4 WHERE id=$1`, [id, JSON.stringify(review), JSON.stringify(assessment), pipelineForAssessment(assessment)]);
        await client.query('COMMIT');
        return { ...lead, prospect_review: review, prospect_assessment: assessment, pipeline_status: pipelineForAssessment(assessment) };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
}

export async function getProspectForResearch(id: string) {
    await ensureProspectSchema();
    const lead = await getLead(id);
    if (!lead) throw new Error('Lead no longer exists.');
    return lead;
}

export type { ProspectResearch, ProspectReview, ProspectAssessment };
