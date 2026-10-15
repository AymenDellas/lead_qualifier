'use server';

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { businessTransaction, mapProject, recordActivity } from '@/lib/business-store';
import { blankOpportunity, buildProject } from '@/lib/business';
import { validateProject } from '@/lib/business-validation';
import { recordCaseStudyActivity } from '@/lib/case-study-store';
import { ensureDiscoverySchema, mapDiscoveryCall, readDiscoverySnapshot } from '@/lib/discovery-call-store';
import {
    applyDiscoveryToProject, callFromSource, discoveryRecap, questionAnswer,
    discoveryCallSchema, callTemplateSchema, type DiscoveryCallData, type CallTemplateData, type DiscoveryActionResult,
} from '@/lib/discovery-calls';

const uuid = z.string().uuid();
const revision = z.number().int().positive();
class CallInputError extends Error {}
// Expected input/conflict errors must survive Next's production error redaction.
async function actionResult<T>(work: () => Promise<T>): Promise<DiscoveryActionResult<T>> {
    try { return { ok: true, value: await work() }; }
    catch (error) {
        if (error instanceof CallInputError) return { ok: false, error: error.message };
        if (error instanceof z.ZodError) return { ok: false, error: error.issues.map(issue => issue.message).join(' ') };
        return { ok: false, error: 'Could not save this change. Your call draft is kept on this device. Please try again.' };
    }
}
function parseInput<T>(schema: z.ZodType<T>, data: unknown): T {
    const result = schema.safeParse(data);
    if (!result.success) throw new CallInputError(result.error.issues.map(issue => issue.message).join(' '));
    return result.data;
}
export async function loadDiscoveryCallsAction() { return readDiscoverySnapshot(); }

export async function createDiscoveryCallAction(data: DiscoveryCallData, sourceProspectId?: string) {
    return actionResult(async () => {
    const snapshot = await readDiscoverySnapshot();
    if (sourceProspectId) {
        uuid.parse(sourceProspectId);
        const source = snapshot.sources.find(item => item.id === sourceProspectId);
        if (!source) throw new CallInputError('This prospect is no longer available. Reload the prospect list.');
        data = callFromSource(source, snapshot.template.data);
    }
    const parsed = parseInput(discoveryCallSchema, data);
    return businessTransaction(async client => {
        const result = await client.query(`INSERT INTO discovery_calls(id,source_prospect_id,data) VALUES($1,$2,$3)
            ON CONFLICT(source_prospect_id) WHERE source_prospect_id IS NOT NULL
            DO UPDATE SET source_prospect_id=EXCLUDED.source_prospect_id RETURNING *`,
            [randomUUID(), sourceProspectId || null, JSON.stringify(parsed)]);
        return mapDiscoveryCall(result.rows[0]);
    });
    });
}
export async function saveDiscoveryCallAction(id: string, data: DiscoveryCallData, expectedRevision: number) {
    return actionResult(async () => {
    uuid.parse(id); revision.parse(expectedRevision);
    const parsed = parseInput(discoveryCallSchema, data);
    await ensureDiscoverySchema();
    return businessTransaction(async client => {
        const result = await client.query(`UPDATE discovery_calls SET data=$2, revision=revision+1, updated_at=NOW()
            WHERE id=$1 AND revision=$3 RETURNING *`, [id, JSON.stringify(parsed), expectedRevision]);
        if (!result.rows[0]) throw new CallInputError('This call changed in another window. Reload it before saving; your draft is kept on this device.');
        return mapDiscoveryCall(result.rows[0]);
    });
    });
}
export async function saveDiscoveryTemplateAction(data: CallTemplateData, expectedRevision: number) {
    return actionResult(async () => {
    revision.parse(expectedRevision);
    const parsed = parseInput(callTemplateSchema, data);
    await ensureDiscoverySchema();
    return businessTransaction(async client => {
        const result = await client.query('UPDATE discovery_call_templates SET data=$1,revision=revision+1 WHERE id=TRUE AND revision=$2 RETURNING data,revision', [JSON.stringify(parsed), expectedRevision]);
        if (!result.rows[0]) throw new CallInputError('The templates changed in another window. Reload before saving.');
        return result.rows[0] as { data: CallTemplateData; revision: number };
    });
    });
}
export async function startDiscoveryOnboardingAction(id: string, expectedRevision: number) {
    return actionResult(async () => {
    uuid.parse(id); revision.parse(expectedRevision);
    await ensureDiscoverySchema();
    return businessTransaction(async client => {
        const record = await client.query('SELECT * FROM discovery_calls WHERE id=$1 FOR UPDATE', [id]);
        if (!record.rows[0]) throw new CallInputError('The call could not be found.');
        const call = mapDiscoveryCall(record.rows[0]);
        if (call.projectId) {
            const existing = await client.query('SELECT * FROM business_projects WHERE id=$1', [call.projectId]);
            return mapProject(existing.rows[0]);
        }
        if (call.revision !== expectedRevision) throw new CallInputError('This call changed. Reload and review the latest recap before starting onboarding.');
        const data = parseInput(discoveryCallSchema, call.data);
        if (data.outcome !== 'AGREED') throw new CallInputError('Record that the prospect agreed to proceed first.');
        const offer = await client.query('SELECT * FROM business_offer_versions ORDER BY version DESC LIMIT 1');
        const opportunity = {
            ...blankOpportunity(), name: data.name, email: data.email, website: data.website,
            stage: 'WON' as const, funnel: data.funnel, mode: data.projectType === 'CASE_STUDY' ? 'CASE_STUDY' as const : 'PERFORMANCE' as const,
            currentOffer: questionAnswer(data, 'offer') || data.currentOffer, audience: questionAnswer(data, 'buyer'),
            notes: discoveryRecap(data), nextAction: 'Complete client onboarding', callAt: data.scheduledAt,
        };
        const opportunityId = randomUUID();
        await client.query('INSERT INTO business_opportunities(id,lead_id,offer_version,data) VALUES($1,NULL,$2,$3)', [opportunityId, offer.rows[0].version, JSON.stringify(opportunity)]);
        const project = applyDiscoveryToProject(buildProject(opportunity, offer.rows[0].profile), data);
        project.onboarding!.portalToken = randomUUID();
        try { validateProject(project); }
        catch (error) { throw new CallInputError(error instanceof Error ? error.message : 'Review the project brief before continuing.'); }
        const projectId = randomUUID();
        const inserted = await client.query('INSERT INTO business_projects(id,opportunity_id,offer_version,data) VALUES($1,$2,$3,$4) RETURNING *', [projectId, opportunityId, offer.rows[0].version, JSON.stringify(project)]);
        await client.query('UPDATE discovery_calls SET project_id=$2,revision=revision+1,updated_at=NOW() WHERE id=$1', [id, projectId]);
        await recordActivity(client, opportunityId, 'DISCOVERY', 'Onboarding created from the reviewed discovery call brief');
        if (call.sourceProspectId) await recordCaseStudyActivity(client, call.sourceProspectId, 'DISCOVERY', 'Discovery call handed off to onboarding');
        return mapProject(inserted.rows[0]);
    });
    });
}
