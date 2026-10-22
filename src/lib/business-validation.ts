import { ESSENTIAL_MAX_LENGTH, ONBOARDING_ESSENTIAL_FIELDS } from './offer-essentials';
import { validateJourney } from './onboarding-journey';
import { importResultSchema } from './copy-studio/shared/contracts';
import { validateDeliveryData } from './project-workspace';
import {
    AGREEMENT_STATUSES,
    FUNNEL_TYPES,
    PAYMENT_STATUSES,
    SALES_STAGES,
    missingOnboardingFormFields,
    type OfferProfile,
    type OpportunityData,
    type ProjectData,
} from './business';

function text(value: unknown, label: string, max = 20000): asserts value is string {
    if (typeof value !== 'string' || value.length > max)
        throw new Error(`${label} must be text of at most ${max} characters.`);
}
function required(value: unknown, label: string) {
    text(value, label);
    if (!value.trim()) throw new Error(`${label} is required.`);
}
function choice(value: unknown, values: readonly string[], label: string) {
    if (!values.includes(String(value))) throw new Error(`Choose a valid ${label}.`);
}
function number(value: unknown, label: string, nullable = false, integer = false) {
    if (value === null && nullable) return;
    if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value < 0 ||
        (integer && !Number.isInteger(value))
    )
        throw new Error(`${label} must be a non-negative ${integer ? 'whole number' : 'number'}.`);
}
function url(value: unknown, label: string) {
    text(value, label, 2000);
    if (!value) return;
    try {
        if (!['http:', 'https:'].includes(new URL(value).protocol)) throw new Error();
    } catch {
        throw new Error(`${label} must start with https:// or http://.`);
    }
}
function date(value: unknown, label: string) {
    text(value, label, 50);
    if (value && !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be a valid date.`);
}
export function validateOffer(p: OfferProfile) {
    for (const k of [
        'name',
        'promise',
        'primaryAudience',
        'secondaryAudience',
        'markets',
        'exclusions',
        'signals',
        'paymentTrigger',
        'measurementPolicy',
        'caseStudyTerms',
        'brand',
        'outreach',
        'personalBrand',
        'status',
    ] as const)
        text(p[k], k);
    required(p.name, 'Business name');
    required(p.promise, 'Offer promise');
    url(p.website, 'Business website');
    number(p.priceMin, 'Minimum price');
    number(p.priceMax, 'Maximum price');
    if (p.priceMax < p.priceMin) throw new Error('Maximum price must be at least the minimum price.');
    for (const funnel of FUNNEL_TYPES) {
        required(p.funnels?.[funnel]?.description, 'Funnel description');
        required(p.funnels[funnel].deliverables, 'Funnel deliverables');
    }
    if (p.onboardingTemplates)
        for (const [key, value] of Object.entries(p.onboardingTemplates)) text(value, `Onboarding template ${key}`, 50000);
}
export function validateOpportunity(d: OpportunityData) {
    required(d.name, 'Name');
    choice(d.stage, SALES_STAGES, 'sales stage');
    choice(d.funnel, ['', ...FUNNEL_TYPES], 'funnel');
    choice(d.mode, ['PERFORMANCE', 'CASE_STUDY'], 'engagement type');
    for (const k of [
        'email',
        'niche',
        'audience',
        'currentOffer',
        'bookingPath',
        'evidence',
        'opportunity',
        'unknowns',
        'recommendationReason',
        'terms',
        'nextAction',
        'lostReason',
        'notes',
    ] as const)
        text(d[k], k);
    if (d.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email))
        throw new Error('Enter a valid email address.');
    for (const k of ['website', 'loomUrl', 'bookingUrl', 'proposalUrl'] as const) url(d[k], k);
    for (const k of ['dueAt', 'callAt', 'repliedAt', 'loomSentAt'] as const) date(d[k], k);
    number(d.fee, 'Agreed fee', true);
    choice(d.audienceStage ?? 'UNKNOWN', ['UNKNOWN', 'COLD', 'WARM'], 'audience stage');
    choice(d.videoReadiness ?? 'UNKNOWN', ['UNKNOWN', 'READY', 'NOT_READY'], 'video readiness');
    choice(d.offerTier ?? 'UNKNOWN', ['UNKNOWN', 'HIGH_TICKET', 'STANDARD'], 'offer tier');
    choice(d.primaryCta ?? 'UNKNOWN', ['UNKNOWN', 'CALL', 'OPT_IN'], 'primary CTA');
    if (['LOOM_SENT', 'FOLLOW_UP', 'BREAKUP'].includes(d.stage) && (!d.repliedAt || !d.loomUrl))
        throw new Error('Record the initial reply and add a Loom link first.');
    if (d.stage === 'BOOKED' && !d.callAt) throw new Error('Add the discovery call date.');
    if (d.stage === 'LOST' && !d.lostReason.trim()) throw new Error('Add a lost reason.');
}
export function validateProject(d: ProjectData) {
    validateDeliveryData(d);
    required(d.name, 'Client name');
    choice(d.funnel, FUNNEL_TYPES, 'funnel');
    choice(d.mode, ['PERFORMANCE', 'CASE_STUDY'], 'engagement type');
    choice(d.status, ['ONBOARDING', 'BUILDING', 'APPROVAL', 'LIVE', 'COMPLETE'], 'project status');
    choice(d.invoiceStatus, ['NOT_INVOICED', 'DRAFT', 'SENT', 'PAID'], 'invoice status');
    number(d.fee, 'Agreed fee', true);
    for (const k of ['terms', 'brief', 'assets'] as const) text(d[k], k);
    date(d.launchAt, 'Launch date');
    url(d.invoiceUrl, 'Invoice URL');
    if (!Array.isArray(d.deliverables) || d.deliverables.length > 100)
        throw new Error('Use up to 100 deliverables.');
    const ids = new Set<string>();
    for (const item of d.deliverables) {
        required(item.id, 'Deliverable id');
        if (ids.has(item.id)) throw new Error('Deliverable IDs must be unique.');
        ids.add(item.id);
        required(item.title, 'Deliverable title');
        text(item.content, 'Deliverable content', 100000);
        url(item.url, 'Deliverable URL');
        date(item.dueAt, 'Deliverable deadline');
        choice(item.status, ['TODO', 'DOING', 'BLOCKED', 'REVIEW', 'DONE'], 'deliverable status');
    }
    const m = d.measurement;
    if (!m) throw new Error('Measurement is required.');
    for (const k of ['baselineStart', 'baselineEnd', 'currentStart', 'currentEnd'] as const) {
        date(m[k], k);
        if (m[k] && !/^\d{4}-\d{2}-\d{2}$/.test(m[k]))
            throw new Error('Measurement periods use calendar dates.');
    }
    for (const k of [
        'baselineBookings',
        'currentBookings',
        'baselineVisitors',
        'currentVisitors',
        'minimumIncrease',
    ] as const)
        number(m[k], k, true, true);
    text(m.countingRules, 'Counting rules');
    text(m.attribution, 'Attribution');
    url(m.evidenceUrl, 'Evidence URL');
    if (typeof m.agreed !== 'boolean' || typeof m.reviewed !== 'boolean')
        throw new Error('Confirm the measurement terms and review explicitly.');
    if (m.minimumIncrease === 0) throw new Error('The target must be an increase of at least one booking.');
    if (d.onboarding) {
        const o = d.onboarding;
        if (o.journey) {
            validateJourney(o.journey);
            if (o.journey.reference) importResultSchema.parse(o.journey.reference);
        }
        text(o.form.coachBio ?? '', 'Coach background', 20000);
        text(o.form.proof ?? '', 'Client proof', 480000);
        text(o.form.preferences ?? '', 'Client preferences', 20000);
        required(o.clientName, 'Onboarding client name');
        required(o.projectName, 'Onboarding project name');
        choice(o.projectType, ['PAID', 'CASE_STUDY'], 'project type');
        choice(o.agreement?.status, AGREEMENT_STATUSES, 'agreement status');
        choice(o.payment?.status, PAYMENT_STATUSES, 'payment status');
        choice(o.payment?.structure, ['FULL', 'DEPOSIT', 'CUSTOM'], 'payment structure');
        choice(o.form?.status, ['NOT_SENT', 'SENT', 'IN_PROGRESS', 'COMPLETE'], 'onboarding form status');
        text(o.form.differentiation ?? '', 'Approach differentiation', 20_000);
        text(o.form.unsuitableClients ?? '', 'Unsuitable clients', 20_000);
        if (o.form.caseStudyConsent !== undefined && typeof o.form.caseStudyConsent !== 'boolean')
            throw new Error('Case-study permission must be accepted or declined.');
        for (const key of ['testimonialCommitment', 'deploymentAccessConsent'] as const)
            if (o.form[key] !== undefined && typeof o.form[key] !== 'boolean')
                throw new Error('Onboarding commitments must be accepted or declined.');
        if (o.form.status === 'COMPLETE') {
            const missing = missingOnboardingFormFields(o);
            if (missing.length) throw new Error(`Complete the required onboarding fields: ${missing.join(', ')}.`);
        }
        number(o.payment?.price, 'Project price', true);
        number(o.payment?.deposit, 'Deposit amount', true);
        number(o.payment?.balance, 'Remaining balance', true);
        date(o.payment?.dueDate, 'Payment due date');
        url(o.payment?.link, 'Payment link');
        date(o.targetStartDate, 'Target start date');
        date(o.baseline?.capturedAt, 'Baseline capture date');
        date(o.scope?.targetLaunchDate, 'Target launch date');
        date(o.scope?.confirmedAt, 'Scope confirmation date');
        if (!Array.isArray(o.access) || o.access.length > 100) throw new Error('Use up to 100 access items.');
        for (const [key] of ONBOARDING_ESSENTIAL_FIELDS) text(o.form[key] ?? '', key, ESSENTIAL_MAX_LENGTH);
        if (!Array.isArray(o.documents) || o.documents.length > 100)
            throw new Error('Use up to 100 onboarding documents.');
        if (!Array.isArray(o.overrides)) throw new Error('Onboarding overrides must be a list.');
        for (const item of o.access) {
            required(item.id, 'Access item id');
            required(item.platform, 'Access platform');
            choice(item.status, ['NOT_REQUESTED', 'REQUESTED', 'RECEIVED', 'VERIFIED', 'NOT_NEEDED'], 'access status');
        }
        if (o.agreement.signedPdfData && o.agreement.signedPdfData.length > 8_000_000)
            throw new Error('The signed agreement is too large. Upload a PDF smaller than 5 MB.');
        if (o.agreement.clientSignature) {
            required(o.agreement.clientSignature.name, 'Signer name');
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(o.agreement.clientSignature.email))
                throw new Error('Signer email is invalid.');
            date(o.agreement.clientSignature.signedAt, 'Signature date');
            if (!/^[0-9a-f]{64}$/.test(o.agreement.clientSignature.documentSha256))
                throw new Error('Agreement fingerprint is invalid.');
        }
    }
}
