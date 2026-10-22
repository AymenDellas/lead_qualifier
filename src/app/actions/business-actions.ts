'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import {
    CASE_STUDY_CONSENT_VERSION,
    blankOpportunity,
    buildProject,
    generateAccessChecklist,
    onboardingAccessChecklist,
    reconcileOnboardingAccess,
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
import { CLIENT_JOURNEY_FIELDS, clientBriefReady, essentialsPresent, journeyFor, needsWebsiteIntroduction, newOnboardingJourney } from '@/lib/onboarding-journey';

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
            journey: newOnboardingJourney(),
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
    'offerName', 'offer', 'audience', 'customerProblem', 'desiredOutcome', 'differentiation', 'unsuitableClients', 'trafficSources',
    'landingPageUrl', 'bookingUrl', 'qualification', 'nurture', 'traffic', 'bookings', 'showRate',
    'closeRate', 'bookingPlatform', 'crm', 'emailPlatform', 'analyticsPlatform', 'hostingPlatform',
    'domainProvider', 'websitePlatform', 'repositoryProvider', 'assets', 'mustStay', 'avoid',
    'importantContext', 'coachBio', 'proof', 'preferences',
] as const;

function portalValue(formData: FormData, key: string) {
    const value = formData.get(key);
    return typeof value === 'string' ? value.trim().slice(0, 20_000) : '';
}

/** Client-portal writes are deliberately limited to the client's own onboarding fields. */
export async function saveClientPortalFormAction(formData: FormData) {
    const token = portalValue(formData, 'token');
    if (!/^[0-9a-f-]{36}$/i.test(token)) throw new Error('This portal link is invalid.');
    const guided = formData.get('guidedVersion') === '1';
    const savedRevision = await businessTransaction(async (client) => {
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
        if (onboarding.journey && !guided) throw new Error('This onboarding now uses the guided brief. Reload this page before saving.');
        if (guided && Number(formData.get('revision')) !== Number(result.rows[0].revision))
            throw new Error('This onboarding changed in another window. Reload to see the latest answers before saving.');
        if (guided && !clientBriefReady(onboarding))
            throw new Error('Compel is still preparing your offer summary. Please return when your brief is ready.');
        const nextForm = { ...onboarding.form };
        for (const key of PORTAL_FORM_FIELDS) {
            if (!formData.has(key)) continue;
            const raw = formData.get(key);
            nextForm[key] = typeof raw === 'string' ? raw.trim().slice(0, key === 'proof' ? 480000 : 20000) : '';
        }
        let journey = onboarding.journey;
        const complete = portalValue(formData, 'intent') === 'complete';
        if (guided) {
            journey = { ...journeyFor(onboarding), briefPrepared: clientBriefReady(onboarding) };
            const patch = JSON.parse(String(formData.get('journeyPatch') || '{}'));
            for (const key of CLIENT_JOURNEY_FIELDS) if (Object.hasOwn(patch, key)) Object.assign(journey, { [key]: patch[key] });
            const essentialChanged = ['offerName', 'offer', 'audience', 'customerProblem', 'desiredOutcome'].some(key => nextForm[key as keyof typeof nextForm] !== onboarding.form[key as keyof typeof nextForm]);
            if (essentialChanged) { journey.offerConfirmed = false; journey.offerConfirmedAt = ''; }
            if (formData.get('confirmOffer') === 'yes') {
                if (!essentialsPresent({ ...onboarding, form: nextForm })) throw new Error('Please complete the five offer facts before confirming this summary.');
                journey.offerConfirmed = true; journey.offerConfirmedAt = new Date().toISOString();
            }
            const old = journeyFor(onboarding);
            if (['websiteManager', 'publisher', 'contactName', 'contactEmail'].some(key => journey![key as keyof typeof journey] !== old[key as keyof typeof old]) ||
                ['domainProvider', 'websitePlatform', 'bookingPlatform', 'emailPlatform', 'analyticsPlatform'].some(key => nextForm[key as keyof typeof nextForm] !== onboarding.form[key as keyof typeof nextForm])) {
                journey.responsibilityConfirmed = false; journey.verifiedAt = '';
            }
            if (complete && (!journey.offerConfirmed || !journey.websiteManager || !journey.publisher)) throw new Error('Confirm your offer and choose how your page will be published before finishing.');
            if (complete && (journey.websiteManager === 'OTHER' || journey.publisher === 'DEVELOPER') && (!journey.contactName.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(journey.contactEmail))) throw new Error('Add a valid name and email for the person who helps with your website.');
            if ((complete || (journey.flowVersion && journey.step >= 4)) && needsWebsiteIntroduction(journey) && !journey.introductionSent)
                throw new Error('Send the introduction email and confirm “I’ve sent the introduction” before continuing.');
            if (complete && journey.flowVersion && !onboarding.scope.confirmed && !onboarding.overrides.includes('scope') && formData.get('confirmScope') !== 'yes')
                throw new Error('Review and confirm the project scope before submitting.');
        }
        if (!guided || formData.has('caseStudyConsentPresent')) {
            nextForm.caseStudyConsent = onboarding.projectType === 'CASE_STUDY' && formData.get('caseStudyConsent') === 'accepted';
            nextForm.testimonialCommitment = nextForm.caseStudyConsent && (formData.get('caseStudyConsentVersion') === CASE_STUDY_CONSENT_VERSION || formData.get('testimonialCommitment') === 'accepted');
        }
        if (!guided || formData.has('deploymentAccessConsent')) nextForm.deploymentAccessConsent = formData.get('deploymentAccessConsent') === 'accepted';
        nextForm.status = complete ? 'COMPLETE' : guided && onboarding.form.status === 'COMPLETE' && journey?.offerConfirmed ? 'COMPLETE' : 'IN_PROGRESS';
        const withForm = { ...onboarding, form: nextForm, ...(journey ? { journey } : {}) };
        const generated = guided || nextForm.status === 'COMPLETE' ? onboardingAccessChecklist(withForm) : [];
        let access = guided ? reconcileOnboardingAccess(withForm) : mergeAccessChecklist(onboarding.access, generated);
        if (guided && formData.has('receivedAccessIds')) {
            const received: unknown = JSON.parse(String(formData.get('receivedAccessIds')));
            if (!Array.isArray(received) || received.some(id => typeof id !== 'string' || !access.some(item => item.id === id))) throw new Error('This access request is no longer available. Reload before trying again.');
            access = access.map(item => received.includes(item.id) && !['VERIFIED', 'NOT_NEEDED'].includes(item.status) ? { ...item, status: 'RECEIVED' as const } : item);
        }
        const scope = guided && complete && formData.get('confirmScope') === 'yes'
            ? { ...onboarding.scope, confirmed: true, confirmedAt: onboarding.scope.confirmedAt || new Date().toISOString() }
            : onboarding.scope;
        const next = { ...project, onboarding: { ...withForm, scope, access } };
        validateProject(next);
        await client.query(
            'UPDATE business_projects SET data=$2,revision=revision+1,updated_at=NOW() WHERE id=$1',
            [result.rows[0].id, JSON.stringify(next)],
        );
        if (!guided || complete) await recordActivity(client, result.rows[0].opportunity_id, 'ONBOARDING', complete ? 'Client completed the onboarding form' : 'Client saved onboarding form progress');
        return Number(result.rows[0].revision || 0) + 1;
    });
    if (!guided || formData.get('intent') === 'complete') revalidatePath(`/portal/${token}`);
    return { revision: savedRevision };
}

export async function saveGuidedOnboardingAction(formData: FormData) {
    try { return { ok: true as const, ...await saveClientPortalFormAction(formData) }; }
    catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : 'Your answers could not be saved. Please retry.' }; }
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

