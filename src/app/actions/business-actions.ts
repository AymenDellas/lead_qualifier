'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import {
    CASE_STUDY_CONSENT_VERSION,
    blankOpportunity,
    buildProject,
    generateAccessChecklist,
    mergeAccessChecklist,
    normalizeOnboarding,
    type OfferProfile,
    type OpportunityData,
    type ProjectData,
} from '@/lib/business';
import {
    businessTransaction,
    readBusinessSnapshot,
    mapOffer,
    mapProject,
    recordActivity,
} from '@/lib/business-store';
import { validateOffer, validateOpportunity, validateProject } from '@/lib/business-validation';

export async function loadBusinessAction() {
    return readBusinessSnapshot();
}

export async function saveOfferAction(profile: OfferProfile, expectedVersion: number) {
    validateOffer(profile);
    return businessTransaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(83472102)');
        const latest = await client.query(
            'SELECT version FROM business_offer_versions ORDER BY version DESC LIMIT 1',
        );
        if (latest.rows[0].version !== expectedVersion)
            throw new Error('The offer changed in another window. Reload before saving.');
        const result = await client.query(
            'INSERT INTO business_offer_versions(profile) VALUES ($1) RETURNING *',
            [JSON.stringify(profile)],
        );
        return mapOffer(result.rows[0]);
    });
}

export type CreateOnboardingInput = {
    clientName: string;
    businessName: string;
    email: string;
    website: string;
    projectName: string;
    funnel: ProjectData['funnel'];
    projectType: 'PAID' | 'CASE_STUDY';
};

/** Start a client workflow even when the accepted deal was not previously tracked in Sales. */
export async function createOnboardingAction(input: CreateOnboardingInput) {
    const opportunity: OpportunityData = {
        ...blankOpportunity(),
        name: input.clientName.trim(),
        email: input.email.trim(),
        website: input.website.trim(),
        stage: 'WON',
        funnel: input.funnel,
        mode: input.projectType === 'CASE_STUDY' ? 'CASE_STUDY' : 'PERFORMANCE',
        currentOffer: input.projectName.trim(),
        nextAction: 'Complete client onboarding',
    };
    validateOpportunity(opportunity);
    return businessTransaction(async (client) => {
        const offer = await client.query(
            'SELECT * FROM business_offer_versions ORDER BY version DESC LIMIT 1',
        );
        const opportunityId = randomUUID();
        await client.query(
            'INSERT INTO business_opportunities(id,lead_id,offer_version,data) VALUES ($1,NULL,$2,$3)',
            [opportunityId, offer.rows[0].version, JSON.stringify(opportunity)],
        );
        const project = buildProject(opportunity, offer.rows[0].profile);
        project.name = input.projectName.trim();
        project.onboarding = {
            ...project.onboarding!,
            clientName: input.clientName.trim(),
            businessName: input.businessName.trim(),
            email: input.email.trim(),
            website: input.website.trim(),
            projectName: input.projectName.trim(),
            projectType: input.projectType,
            portalToken: randomUUID(),
        };
        const result = await client.query(
            'INSERT INTO business_projects(id,opportunity_id,offer_version,data) VALUES ($1,$2,$3,$4) RETURNING *',
            [randomUUID(), opportunityId, offer.rows[0].version, JSON.stringify(project)],
        );
        await recordActivity(client, opportunityId, 'PROJECT', 'Client onboarding started');
        return mapProject(result.rows[0]);
    });
}

export async function saveClientProjectAction(id: string, data: ProjectData, expectedRevision: number) {
    validateProject(data);
    return businessTransaction(async (client) => {
        const result = await client.query(
            'UPDATE business_projects SET data=$2,revision=revision+1,updated_at=NOW() WHERE id=$1 AND revision=$3 RETURNING *',
            [id, JSON.stringify(data), expectedRevision],
        );
        if (!result.rows[0]) throw new Error('This project changed in another window. Reload before saving.');
        await recordActivity(
            client,
            result.rows[0].opportunity_id,
            'PROJECT',
            `Client project updated · ${data.status.toLowerCase()}`,
        );
        return mapProject(result.rows[0]);
    });
}

const PORTAL_FORM_FIELDS = [
    'offer', 'audience', 'customerProblem', 'desiredOutcome', 'differentiation', 'unsuitableClients', 'trafficSources',
    'landingPageUrl', 'bookingUrl', 'qualification', 'nurture', 'traffic', 'bookings', 'showRate',
    'closeRate', 'bookingPlatform', 'crm', 'emailPlatform', 'analyticsPlatform', 'hostingPlatform',
    'domainProvider', 'websitePlatform', 'repositoryProvider', 'assets', 'mustStay', 'avoid',
    'importantContext',
] as const;

function portalValue(formData: FormData, key: string) {
    const value = formData.get(key);
    return typeof value === 'string' ? value.trim().slice(0, 20_000) : '';
}

/** Client-portal writes are deliberately limited to the client's own onboarding fields. */
export async function saveClientPortalFormAction(formData: FormData) {
    const token = portalValue(formData, 'token');
    if (!/^[0-9a-f-]{36}$/i.test(token)) throw new Error('This portal link is invalid.');
    await businessTransaction(async (client) => {
        const result = await client.query(
            `SELECT p.*,o.data AS opportunity,v.profile
             FROM business_projects p
             JOIN business_opportunities o ON o.id=p.opportunity_id
             JOIN business_offer_versions v ON v.version=p.offer_version
             WHERE p.data->'onboarding'->>'portalToken'=$1 FOR UPDATE OF p`,
            [token],
        );
        if (!result.rows[0]) throw new Error('This portal link is no longer available.');
        const project = result.rows[0].data as ProjectData;
        const onboarding = normalizeOnboarding(project, result.rows[0].opportunity, result.rows[0].profile);
        const nextForm = { ...onboarding.form };
        for (const key of PORTAL_FORM_FIELDS) {
            // A form opened before these optional questions were added must not erase newer answers.
            if ((key === 'differentiation' || key === 'unsuitableClients') && !formData.has(key)) continue;
            nextForm[key] = portalValue(formData, key);
        }
        nextForm.caseStudyConsent = onboarding.projectType === 'CASE_STUDY' && formData.get('caseStudyConsent') === 'accepted';
        nextForm.testimonialCommitment = nextForm.caseStudyConsent && (
            formData.get('caseStudyConsentVersion') === CASE_STUDY_CONSENT_VERSION ||
            formData.get('testimonialCommitment') === 'accepted'
        );
        nextForm.deploymentAccessConsent = formData.get('deploymentAccessConsent') === 'accepted';
        nextForm.status = portalValue(formData, 'intent') === 'complete' ? 'COMPLETE' : 'IN_PROGRESS';
        const generated = nextForm.status === 'COMPLETE' ? generateAccessChecklist(nextForm) : [];
        const access = mergeAccessChecklist(onboarding.access, generated);
        const next = { ...project, onboarding: { ...onboarding, form: nextForm, access } };
        validateProject(next);
        await client.query(
            'UPDATE business_projects SET data=$2,revision=revision+1,updated_at=NOW() WHERE id=$1',
            [result.rows[0].id, JSON.stringify(next)],
        );
        await recordActivity(client, result.rows[0].opportunity_id, 'ONBOARDING', nextForm.status === 'COMPLETE' ? 'Client completed the onboarding form' : 'Client saved onboarding form progress');
    });
    revalidatePath(`/portal/${token}`);
}

export async function confirmClientScopeAction(formData: FormData) {
    const token = portalValue(formData, 'token');
    if (!/^[0-9a-f-]{36}$/i.test(token)) throw new Error('This portal link is invalid.');
    await businessTransaction(async (client) => {
        const result = await client.query(
            `SELECT p.*,o.data AS opportunity,v.profile FROM business_projects p
             JOIN business_opportunities o ON o.id=p.opportunity_id
             JOIN business_offer_versions v ON v.version=p.offer_version
             WHERE p.data->'onboarding'->>'portalToken'=$1 FOR UPDATE OF p`,
            [token],
        );
        if (!result.rows[0]) throw new Error('This portal link is no longer available.');
        const project = result.rows[0].data as ProjectData;
        if (!project.onboarding) throw new Error('Onboarding has not been prepared.');
        const onboarding = normalizeOnboarding(project, result.rows[0].opportunity, result.rows[0].profile);
        const next = {
            ...project,
            onboarding: {
                ...onboarding,
                scope: { ...onboarding.scope, confirmed: true, confirmedAt: new Date().toISOString() },
            },
        };
        validateProject(next);
        await client.query('UPDATE business_projects SET data=$2,revision=revision+1,updated_at=NOW() WHERE id=$1', [result.rows[0].id, JSON.stringify(next)]);
        await recordActivity(client, result.rows[0].opportunity_id, 'ONBOARDING', 'Client confirmed the project scope');
    });
    revalidatePath(`/portal/${token}`);
}

export async function markPortalAccessReceivedAction(formData: FormData) {
    const token = portalValue(formData, 'token');
    const itemId = portalValue(formData, 'itemId');
    if (!/^[0-9a-f-]{36}$/i.test(token) || !itemId) throw new Error('This access request is invalid.');
    await businessTransaction(async (client) => {
        const result = await client.query(
            `SELECT * FROM business_projects WHERE data->'onboarding'->>'portalToken'=$1 FOR UPDATE`,
            [token],
        );
        if (!result.rows[0]) throw new Error('This portal link is no longer available.');
        const project = result.rows[0].data as ProjectData;
        if (!project.onboarding) throw new Error('Onboarding has not been prepared.');
        const access = project.onboarding.access.map((item) => item.id === itemId ? { ...item, status: 'RECEIVED' as const } : item);
        if (!access.some((item) => item.id === itemId)) throw new Error('Access request not found.');
        const next = { ...project, onboarding: { ...project.onboarding, access } };
        validateProject(next);
        await client.query('UPDATE business_projects SET data=$2,revision=revision+1,updated_at=NOW() WHERE id=$1', [result.rows[0].id, JSON.stringify(next)]);
        await recordActivity(client, result.rows[0].opportunity_id, 'ONBOARDING', 'Client marked an access request received');
    });
    revalidatePath(`/portal/${token}`);
}

