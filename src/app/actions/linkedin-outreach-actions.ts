'use server';

import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
    blankCaseStudyProspect,
    canonicalLinkedinUrl,
    CASE_STUDY_STAGES,
    CRM_OUTREACH_STATUSES,
    crmOutreachStatus,
    transitionCaseStudyProspect,
    type CaseStudyProspectData,
    type CrmOutreachStatus,
} from '@/lib/case-study';
import { caseStudyTransaction, mapCaseStudyProspect, recordCaseStudyActivity } from '@/lib/case-study-store';
import type { LeadRecord } from '@/lib/db';
import { ensureDmColumn, stampLinkedinDmForLead, syncCrmOutreachSuppression } from '@/lib/linkedin-outreach-store';
import { syncHunterContacted } from '@/lib/hunter-contact-sync';
import { isQualifiedRecord } from '@/lib/prospect-qualification.cjs';
import { assessmentForLead } from '@/lib/prospect-store';

function validWebsite(value: string | null | undefined) {
    try {
        const url = new URL(String(value || ''));
        const host = url.hostname.toLowerCase();
        return ['http:', 'https:'].includes(url.protocol) && host.includes('.') &&
            !host.includes('_') && !/(^|\.)(linkedin\.com|lnkd\.in)$/.test(host)
            ? url.href : '';
    } catch { return ''; }
}

async function linkedProspect(client: PoolClient, lead: LeadRecord) {
    const linkedinUrl = canonicalLinkedinUrl(lead.linkedin_url);
    // The CRM and Hunter use different row IDs; lock by the shared person key.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [linkedinUrl.toLowerCase()]);
    const found = await client.query(
        `SELECT * FROM case_study_prospects
         WHERE LOWER(REGEXP_REPLACE(linkedin_url, '/+$', '')) = $1
         LIMIT 1 FOR UPDATE`,
        [linkedinUrl.toLowerCase().replace(/\/+$/, '')],
    );
    const row = found.rows[0];
    if (row && row.data?.crmLeadId && row.data.crmLeadId !== lead.id) {
        throw new Error('A different CRM row is already linked to this LinkedIn profile.');
    }
    const name = [lead.first_name, lead.last_name].filter(Boolean).join(' ').trim();
    const website = validWebsite(lead.website);
    const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email || '') ? lead.email : '';
    if (row) {
        const previous = row.data as CaseStudyProspectData;
        let existingDmAt = '';
        if (previous.stage !== 'DO_NOT_CONTACT' && CASE_STUDY_STAGES.indexOf(previous.stage) >= CASE_STUDY_STAGES.indexOf('MESSAGED')) {
            const dmActivity = await client.query(
                `SELECT kind,created_at FROM case_study_activities
                 WHERE prospect_id=$1 AND kind IN ('LINKEDIN_DM_SENT','LINKEDIN_DM_UNDONE')
                 ORDER BY created_at DESC LIMIT 1`,
                [row.id],
            );
            if (dmActivity.rows[0]?.kind === 'LINKEDIN_DM_SENT') {
                const stamped = await stampLinkedinDmForLead(client, lead.id, new Date(dmActivity.rows[0].created_at).toISOString());
                existingDmAt = stamped.linkedin_dm_at ? new Date(stamped.linkedin_dm_at).toISOString() : '';
            } else {
                // Older Hunter stages did not record a channel. Prevent repeat
                // outreach without inventing a LinkedIn DM that may not have occurred.
                await client.query(
                    `UPDATE leads SET contacted=TRUE,
                        contacted_at=COALESCE(contacted_at,$2::timestamptz),
                        contacted_source=COALESCE(contacted_source,'MANUAL')
                     WHERE id=$1`,
                    [lead.id, previous.lastContactedAt || new Date(row.updated_at).toISOString()],
                );
            }
        }
        const data: CaseStudyProspectData = {
            ...previous,
            crmLeadId: lead.id,
            crmHook: String(lead.hook || '').slice(0, 10000),
            name: previous.name || name,
            location: previous.location || lead.location || '',
            website: previous.website || website,
            email: previous.email || email,
        };
        if (previous.stage === 'DO_NOT_CONTACT' && !lead.do_not_contact) {
            await client.query('UPDATE leads SET do_not_contact=TRUE WHERE id=$1', [lead.id]);
            data.outreachSuppressedLead = true;
        }
        if (JSON.stringify(data) !== JSON.stringify(previous)) {
            const updated = await client.query(
                'UPDATE case_study_prospects SET data=$2,revision=revision+1,updated_at=NOW() WHERE id=$1 RETURNING *',
                [row.id, JSON.stringify(data)],
            );
            if (!previous.crmLeadId) await recordCaseStudyActivity(client, row.id, 'CRM_LINK', 'Linked to the qualified Lead CRM row');
            return { prospect: mapCaseStudyProspect(updated.rows[0]), existing: true, existingDmAt };
        }
        return { prospect: mapCaseStudyProspect(row), existing: true, existingDmAt };
    }

    const data = blankCaseStudyProspect(linkedinUrl, 'MANUAL', 'CLIENT');
    data.crmLeadId = lead.id;
    data.crmHook = String(lead.hook || '').slice(0, 10000);
    data.name = name;
    data.location = lead.location || '';
    data.website = website;
    data.email = email;
    data.stage = 'QUALIFIED';
    data.scanStatus = 'NOT_RUN';
    data.coachFit = 'YES';
    data.headlineQualification = {
        qualified: true,
        matches: [],
        reason: 'Qualified in Lead CRM. The Hunter has not scanned this profile or website.',
    };
    data.websiteScan.method = 'NOT_RUN';
    data.whyContact = 'Qualified in Lead CRM. Review the existing hook against the live website before sending a DM.';
    data.nextAction = 'Review the CRM hook, then send a LinkedIn DM';
    data.recommendedNextAction = data.nextAction;
    const inserted = await client.query(
        'INSERT INTO case_study_prospects(id,linkedin_url,data) VALUES($1,$2,$3) RETURNING *',
        [randomUUID(), linkedinUrl, JSON.stringify(data)],
    );
    await recordCaseStudyActivity(client, inserted.rows[0].id, 'CRM_IMPORT', 'Imported from qualified Lead CRM for manual LinkedIn outreach');
    return { prospect: mapCaseStudyProspect(inserted.rows[0]), existing: false, existingDmAt: '' };
}

export async function importCrmLeadsToHunterAction(ids: string[]) {
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 25 || new Set(ids).size !== ids.length)
        throw new Error('Select 1 to 25 distinct CRM leads.');
    await ensureDmColumn();
    return caseStudyTransaction(async (client) => {
        const result = await client.query('SELECT * FROM leads WHERE id = ANY($1::text[])', [ids]);
        const byId = new Map<string, LeadRecord>(result.rows.map((row: LeadRecord) => [row.id, row]));
        const added: { leadId: string; prospectId: string; existing: boolean; alreadyMessaged: boolean; sentAt: string }[] = [];
        const skipped: { leadId: string; reason: string }[] = [];
        for (const id of ids) {
            const lead = byId.get(id);
            if (!lead) { skipped.push({ leadId: id, reason: 'Lead no longer exists' }); continue; }
            if (!isQualifiedRecord({ ...lead, prospect_assessment: assessmentForLead(lead) })) {
                skipped.push({ leadId: id, reason: 'This lead is not qualified' }); continue;
            }
            if (lead.do_not_contact) { skipped.push({ leadId: id, reason: 'Do not contact' }); continue; }
            if (lead.contacted && lead.contacted_source && lead.contacted_source !== 'HUNTER') {
                skipped.push({ leadId: id, reason: 'Already contacted' }); continue;
            }
            try {
                const { prospect, existing, existingDmAt } = await linkedProspect(client, lead);
                const alreadyMessaged = prospect.data.stage !== 'DO_NOT_CONTACT' && CASE_STUDY_STAGES.indexOf(prospect.data.stage) >= CASE_STUDY_STAGES.indexOf('MESSAGED');
                added.push({
                    leadId: id,
                    prospectId: prospect.id,
                    existing,
                    alreadyMessaged,
                    sentAt: existingDmAt,
                });
            } catch (error) {
                // A bad URL or a duplicate CRM row should not discard valid selections.
                skipped.push({ leadId: id, reason: error instanceof Error ? error.message : 'Could not link lead' });
            }
        }
        await syncHunterContacted(client, added.map((row) => row.leadId));
        return { added, skipped };
    });
}

/** Suppress or resume a CRM outreach lead without recording or sending a DM. */
export async function setCrmOutreachDoNotContactAction(prospectId: string, excluded: boolean) {
    if (typeof prospectId !== 'string' || !prospectId.trim()) throw new Error('Choose a CRM outreach lead.');
    if (typeof excluded !== 'boolean') throw new Error('Choose a valid contact status.');
    return caseStudyTransaction(async (client) => {
        const result = await client.query('SELECT * FROM case_study_prospects WHERE id=$1 FOR UPDATE', [prospectId]);
        const row = result.rows[0];
        if (!row) throw new Error('CRM outreach lead no longer exists.');
        const previous = row.data as CaseStudyProspectData;
        if (!previous.crmLeadId) throw new Error('This prospect is not linked to the Lead CRM.');
        if (excluded === (previous.stage === 'DO_NOT_CONTACT')) return { stage: previous.stage };
        const restoreStage = previous.doNotContactPreviousStage && previous.doNotContactPreviousStage !== 'DO_NOT_CONTACT'
            ? previous.doNotContactPreviousStage : 'QUALIFIED';
        const target = excluded ? 'DO_NOT_CONTACT' : (
            previous.lastContactedAt && CASE_STUDY_STAGES.indexOf(restoreStage) < CASE_STUDY_STAGES.indexOf('MESSAGED')
                ? 'MESSAGED' : restoreStage
        );
        let next = transitionCaseStudyProspect(previous, target);
        if (!excluded) next = { ...next, lastContactedAt: previous.lastContactedAt };
        next = await syncCrmOutreachSuppression(client, previous, next);
        await client.query('UPDATE case_study_prospects SET data=$2,revision=revision+1,updated_at=NOW() WHERE id=$1',
            [prospectId, JSON.stringify(next)]);
        await recordCaseStudyActivity(client, prospectId, excluded ? 'DO_NOT_CONTACT' : 'RESUMED',
            excluded ? 'Marked Don’t contact; Lead CRM suppressed' : `Don’t contact removed; restored ${target.toLowerCase().replaceAll('_', ' ')}`);
        return { stage: next.stage };
    });
}

/** Applies one status to selected CRM outreach rows and returns only the changed records. */
export async function setCrmOutreachStatusesAction(ids: string[], status: CrmOutreachStatus) {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 150 ||
        new Set(ids).size !== ids.length || ids.some((id) => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)))
        throw new Error('Select 1 to 150 distinct CRM outreach leads.');
    if (!CRM_OUTREACH_STATUSES.includes(status)) throw new Error('Choose a valid contact status.');
    if (status !== 'DO_NOT_CONTACT') await ensureDmColumn();
    return caseStudyTransaction(async (client) => {
        const found = await client.query(
            'SELECT * FROM case_study_prospects WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
            [ids],
        );
        const byId = new Map(found.rows.map((row) => [row.id as string, row]));
        const updated = [];
        const activities = [];
        const unchangedIds: string[] = [];
        const skipped: { id: string; reason: string }[] = [];
        for (const id of ids) {
            const row = byId.get(id);
            if (!row) { skipped.push({ id, reason: 'Lead no longer exists' }); continue; }
            const previous = row.data as CaseStudyProspectData;
            if (!previous.crmLeadId) { skipped.push({ id, reason: 'Not a CRM outreach lead' }); continue; }
            const currentStatus = crmOutreachStatus(previous);
            if (currentStatus === status) { unchangedIds.push(id); continue; }
            let next: CaseStudyProspectData;
            let activityKind = 'STATUS';
            let activityNote = '';
            if (status === 'DO_NOT_CONTACT') {
                next = await syncCrmOutreachSuppression(client, previous,
                    transitionCaseStudyProspect(previous, 'DO_NOT_CONTACT'));
                activityKind = 'DO_NOT_CONTACT';
                activityNote = 'Marked Don’t contact; Lead CRM suppressed';
            } else if (currentStatus === 'DO_NOT_CONTACT') {
                const priorContacted = Boolean(previous.lastContactedAt) || Boolean(previous.doNotContactPreviousStage &&
                    CASE_STUDY_STAGES.indexOf(previous.doNotContactPreviousStage) >= CASE_STUDY_STAGES.indexOf('MESSAGED'));
                if (status !== (priorContacted ? 'MESSAGED' : 'NOT_CONTACTED')) {
                    skipped.push({ id, reason: 'Restore the prior contact status first' }); continue;
                }
                const lead = await client.query('SELECT do_not_contact,outcome FROM leads WHERE id=$1 FOR UPDATE', [previous.crmLeadId]);
                if (!lead.rows[0] || (!previous.outreachSuppressedLead && lead.rows[0].do_not_contact) ||
                    ['NOT_INTERESTED', 'BOUNCED'].includes(lead.rows[0].outcome)) {
                    skipped.push({ id, reason: 'Lead CRM suppression must be resolved first' }); continue;
                }
                const restoreStage = previous.doNotContactPreviousStage && previous.doNotContactPreviousStage !== 'DO_NOT_CONTACT'
                    ? previous.doNotContactPreviousStage : 'QUALIFIED';
                const target = priorContacted && CASE_STUDY_STAGES.indexOf(restoreStage) < CASE_STUDY_STAGES.indexOf('MESSAGED')
                    ? 'MESSAGED' : restoreStage;
                next = await syncCrmOutreachSuppression(client, previous, {
                    ...transitionCaseStudyProspect(previous, target),
                    lastContactedAt: previous.lastContactedAt,
                });
                activityKind = 'RESUMED';
                activityNote = `Don’t contact removed; restored ${target.toLowerCase().replaceAll('_', ' ')}`;
            } else if (status === 'MESSAGED') {
                const lead = await client.query('SELECT do_not_contact FROM leads WHERE id=$1 FOR UPDATE', [previous.crmLeadId]);
                if (!lead.rows[0] || lead.rows[0].do_not_contact) {
                    skipped.push({ id, reason: 'Lead CRM is suppressed' }); continue;
                }
                next = transitionCaseStudyProspect(previous, 'MESSAGED');
                activityKind = 'LINKEDIN_DM_SENT';
                activityNote = 'LinkedIn DM sent manually; follow-up due in 48 hours';
            } else {
                if (previous.stage !== 'MESSAGED') {
                    skipped.push({ id, reason: 'A progressed conversation cannot be reset to Not contacted' }); continue;
                }
                next = { ...transitionCaseStudyProspect(previous, 'QUALIFIED'), lastContactedAt: '', nextActionDueAt: '' };
                activityKind = 'LINKEDIN_DM_UNDONE';
                activityNote = 'Accidental LinkedIn DM mark removed';
            }
            const saved = await client.query(
                'UPDATE case_study_prospects SET data=$2,revision=revision+1,updated_at=NOW() WHERE id=$1 RETURNING *',
                [id, JSON.stringify(next)],
            );
            if (status === 'MESSAGED' && currentStatus === 'NOT_CONTACTED')
                await stampLinkedinDmForLead(client, previous.crmLeadId);
            if (status === 'NOT_CONTACTED' && currentStatus === 'MESSAGED')
                await client.query(
                    `UPDATE leads SET linkedin_dm_at=NULL,
                        contacted=TRUE,
                        contacted_at=CASE WHEN contacted_source='LINKEDIN' THEN NULL ELSE contacted_at END,
                        contacted_source=CASE WHEN contacted_source='LINKEDIN' THEN 'HUNTER' ELSE contacted_source END
                     WHERE id=$1`,
                    [previous.crmLeadId],
                );
            updated.push(mapCaseStudyProspect(saved.rows[0]));
            activities.push(await recordCaseStudyActivity(client, id, activityKind, activityNote));
        }
        return { updated, activities, unchangedIds, skipped };
    });
}

/** Records a DM after the operator has sent it; this action never sends a message. */
export async function markCrmLeadLinkedinDmSentAction(leadId: string) {
    if (typeof leadId !== 'string' || !leadId.trim()) throw new Error('Choose a CRM lead.');
    await ensureDmColumn();
    return caseStudyTransaction(async (client) => {
        const result = await client.query('SELECT * FROM leads WHERE id=$1', [leadId]);
        const lead = result.rows[0] as LeadRecord | undefined;
        if (!lead) throw new Error('Lead no longer exists.');
        if (lead.do_not_contact) throw new Error('This lead is marked Don’t contact. Remove that status before recording outreach.');
        const { prospect } = await linkedProspect(client, lead);
        if (prospect.data.stage === 'DO_NOT_CONTACT') throw new Error('This lead is marked Don’t contact. Remove that status before recording outreach.');
        const lockedLead = await client.query('SELECT linkedin_dm_at FROM leads WHERE id=$1 FOR UPDATE', [leadId]);
        if (!lockedLead.rows[0]) throw new Error('Lead no longer exists.');
        const firstDm = !lockedLead.rows[0].linkedin_dm_at;
        let next = CASE_STUDY_STAGES.indexOf(prospect.data.stage) < CASE_STUDY_STAGES.indexOf('MESSAGED')
            ? transitionCaseStudyProspect(prospect.data, 'MESSAGED')
            : prospect.data;
        if (firstDm && next === prospect.data && prospect.data.stage === 'MESSAGED') {
            const now = new Date();
            next = {
                ...prospect.data,
                lastContactedAt: now.toISOString(),
                nextAction: 'Follow up if they do not reply',
                nextActionDueAt: new Date(now.getTime() + 48 * 3600000).toISOString(),
            };
        }
        if (next !== prospect.data) {
            await client.query(
                'UPDATE case_study_prospects SET data=$2,revision=revision+1,updated_at=NOW() WHERE id=$1',
                [prospect.id, JSON.stringify(next)],
            );
        }
        const updatedLead = await stampLinkedinDmForLead(client, leadId);
        if (firstDm) await recordCaseStudyActivity(client, prospect.id, 'LINKEDIN_DM_SENT', 'LinkedIn DM sent manually; follow-up due in 48 hours');
        return {
            prospectId: prospect.id,
            alreadyRecorded: !firstDm,
            sentAt: updatedLead.linkedin_dm_at ? new Date(updatedLead.linkedin_dm_at).toISOString() : '',
            stage: next.stage,
        };
    });
}

export async function markHunterProspectLinkedinDmSentAction(prospectId: string) {
    if (typeof prospectId !== 'string' || !prospectId.trim()) throw new Error('Choose a Hunter prospect.');
    await ensureDmColumn();
    return caseStudyTransaction(async (client) => {
        const result = await client.query('SELECT * FROM case_study_prospects WHERE id=$1 FOR UPDATE', [prospectId]);
        const row = result.rows[0];
        if (!row) throw new Error('Hunter prospect no longer exists.');
        const data = row.data as CaseStudyProspectData;
        if (data.stage === 'DO_NOT_CONTACT') throw new Error('This lead is marked Don’t contact. Remove that status before recording outreach.');
        const firstDm = !data.lastContactedAt;
        const next = CASE_STUDY_STAGES.indexOf(data.stage) < CASE_STUDY_STAGES.indexOf('MESSAGED')
            ? transitionCaseStudyProspect(data, 'MESSAGED')
            : data;
        if (next !== data) {
            await client.query('UPDATE case_study_prospects SET data=$2,revision=revision+1,updated_at=NOW() WHERE id=$1',
                [prospectId, JSON.stringify(next)]);
        }
        if (data.crmLeadId) await stampLinkedinDmForLead(client, data.crmLeadId);
        if (firstDm) await recordCaseStudyActivity(client, prospectId, 'LINKEDIN_DM_SENT', 'LinkedIn DM sent manually; follow-up due in 48 hours');
        return { alreadyRecorded: !firstDm };
    });
}

/** Corrects an accidental DM mark while the prospect is still at Messaged. */
export async function undoHunterProspectLinkedinDmAction(prospectId: string) {
    if (typeof prospectId !== 'string' || !prospectId.trim()) throw new Error('Choose a Hunter prospect.');
    await ensureDmColumn();
    return caseStudyTransaction(async (client) => {
        const result = await client.query('SELECT * FROM case_study_prospects WHERE id=$1 FOR UPDATE', [prospectId]);
        const row = result.rows[0];
        if (!row) throw new Error('Hunter prospect no longer exists.');
        const data = row.data as CaseStudyProspectData;
        if (data.stage !== 'MESSAGED') throw new Error('A DM mark can only be undone while the prospect is at Messaged.');
        const next = { ...transitionCaseStudyProspect(data, 'QUALIFIED'), lastContactedAt: '', nextActionDueAt: '' };
        await client.query('UPDATE case_study_prospects SET data=$2,revision=revision+1,updated_at=NOW() WHERE id=$1',
            [prospectId, JSON.stringify(next)]);
        if (data.crmLeadId) {
            await client.query(
                `UPDATE leads SET
                    linkedin_dm_at=NULL,
                    contacted=TRUE,
                    contacted_at=CASE WHEN contacted_source='LINKEDIN' THEN NULL ELSE contacted_at END,
                    contacted_source=CASE WHEN contacted_source='LINKEDIN' THEN 'HUNTER' ELSE contacted_source END
                 WHERE id=$1`,
                [data.crmLeadId],
            );
        }
        await recordCaseStudyActivity(client, prospectId, 'LINKEDIN_DM_UNDONE', 'Accidental LinkedIn DM mark removed');
        return { restoredStage: 'QUALIFIED' };
    });
}
