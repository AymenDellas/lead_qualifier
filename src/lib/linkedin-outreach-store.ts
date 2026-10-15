import type { PoolClient } from 'pg';
import { pool } from './pg_setup';
import type { LeadRecord } from './db';
import type { CaseStudyProspectData } from './case-study';

let dmColumnReady: Promise<void> | undefined;
export function ensureDmColumn() {
    if (!dmColumnReady) {
        dmColumnReady = pool.query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS linkedin_dm_at TIMESTAMPTZ')
            .then(() => undefined)
            .catch((error) => { dmColumnReady = undefined; throw error; });
    }
    return dmColumnReady;
}

export async function stampLinkedinDmForLead(client: PoolClient, leadId: string, sentAt?: string) {
    const current = await client.query('SELECT do_not_contact FROM leads WHERE id=$1 FOR UPDATE', [leadId]);
    if (!current.rows[0]) throw new Error('Linked CRM lead no longer exists.');
    if (current.rows[0].do_not_contact) throw new Error('This lead is marked Don’t contact. Remove that status before recording outreach.');
    const updated = await client.query(
        `UPDATE leads SET
            linkedin_dm_at=COALESCE(linkedin_dm_at,$2::timestamptz,NOW()),
            contacted=TRUE,
            contacted_at=COALESCE(contacted_at,$2::timestamptz,NOW()),
            contacted_source=CASE WHEN contacted_source IS NULL OR contacted_source='HUNTER' THEN 'LINKEDIN' ELSE contacted_source END
         WHERE id=$1 RETURNING *`,
        [leadId, sentAt || null],
    );
    if (!updated.rows[0]) throw new Error('Linked CRM lead no longer exists.');
    return updated.rows[0] as LeadRecord;
}

/** Keep a Hunter "Don't contact" stage aligned with the linked Lead CRM suppression. */
export async function syncCrmOutreachSuppression(
    client: PoolClient,
    previous: CaseStudyProspectData,
    next: CaseStudyProspectData,
): Promise<CaseStudyProspectData> {
    if (!previous.crmLeadId || previous.stage === next.stage) return next;
    if (next.stage === 'DO_NOT_CONTACT') {
        const found = await client.query('SELECT do_not_contact FROM leads WHERE id=$1 FOR UPDATE', [previous.crmLeadId]);
        if (!found.rows[0]) throw new Error('Linked CRM lead no longer exists.');
        await client.query('UPDATE leads SET do_not_contact=TRUE WHERE id=$1', [previous.crmLeadId]);
        return { ...next, outreachSuppressedLead: !found.rows[0].do_not_contact };
    }
    if (previous.stage === 'DO_NOT_CONTACT') {
        const found = await client.query('SELECT do_not_contact,outcome FROM leads WHERE id=$1 FOR UPDATE', [previous.crmLeadId]);
        if (!found.rows[0]) throw new Error('Linked CRM lead no longer exists.');
        if ((!previous.outreachSuppressedLead && found.rows[0].do_not_contact) ||
            ['NOT_INTERESTED', 'BOUNCED'].includes(found.rows[0].outcome))
            throw new Error('This lead remains suppressed in the Lead CRM. Resolve that suppression before changing its outreach status.');
        if (previous.outreachSuppressedLead)
            await client.query('UPDATE leads SET do_not_contact=FALSE WHERE id=$1', [previous.crmLeadId]);
        return { ...next, outreachSuppressedLead: false, doNotContactPreviousStage: undefined };
    }
    return next;
}
