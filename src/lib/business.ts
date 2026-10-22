import { ESSENTIAL_MIN_LENGTH, OFFER_ESSENTIAL_LABELS, ONBOARDING_ESSENTIAL_FIELDS, legacyOfferName } from './offer-essentials';
import { clientBriefReady, journeyFor, publishingReady, type OnboardingJourney } from './onboarding-journey';

/** Shared, serializable business records. Kept independent of the lead send gate. */
export type BusinessView = 'today' | 'onboarding' | 'projects';
export const FUNNEL_TYPES = ['DIRECT_TO_CALL', 'VSL', 'LEAD_MAGNET'] as const;
export type FunnelType = (typeof FUNNEL_TYPES)[number];
export const FUNNEL_LABELS: Record<FunnelType, string> = {
    DIRECT_TO_CALL: 'Direct-to-Call',
    VSL: 'VSL',
    LEAD_MAGNET: 'Lead Magnet',
};
export type OfferProfile = {
    name: string;
    website: string;
    promise: string;
    primaryAudience: string;
    secondaryAudience: string;
    markets: string;
    exclusions: string;
    signals: string;
    priceMin: number;
    priceMax: number;
    paymentTrigger: string;
    measurementPolicy: string;
    caseStudyTerms: string;
    brand: string;
    outreach: string;
    personalBrand: string;
    status: string;
    funnels: Record<FunnelType, { description: string; deliverables: string }>;
    onboardingTemplates?: OnboardingTemplates;
};

export type OnboardingTemplates = {
    freeAgreement: string;
    paidAgreement: string;
    welcome: string;
    paymentRequest: string;
    accessRequest: string;
    reminder: string;
    scopeConfirmation: string;
    projectReady: string;
};

export const DEFAULT_ONBOARDING_TEMPLATES: OnboardingTemplates = {
    freeAgreement:
        'This project is provided at no charge in exchange for the case-study permission described below. The client owns the final approved funnel assets. Compel retains its reusable systems, templates, frameworks, tools, and processes.',
    paidAgreement:
        'Work begins after the agreement is signed and the agreed initial payment is received. Once agreed payment is complete, the client owns the final approved deliverables created specifically for them. Compel retains its reusable systems, templates, frameworks, tools, and processes.',
    welcome:
        'Welcome, {{client_name}}. This page keeps every item needed to start {{project_name}} in one place. Please complete the outstanding items below and contact us if anything is unclear.',
    paymentRequest:
        'Your agreement is complete. Please use the secure payment link below to complete the agreed payment for {{project_name}}.',
    accessRequest:
        'To prepare {{project_name}}, please grant the access listed below using collaborator or team access. Please do not send passwords.',
    reminder:
        'A quick reminder: we still need {{outstanding_items}} before {{project_name}} can start. If you are blocked on anything, reply and we will help.',
    scopeConfirmation:
        'Please review the included and excluded work below. Confirming this scope gives both sides one clear plan for delivery.',
    projectReady:
        '{{project_name}} is fully onboarded and ready to build. The agreement, information, access, baseline, and scope are now organized in the project record.',
};
export const currentFreeAgreementIntro = (value: string) =>
    value.replace('case-study permissions selected below', 'case-study permission described below');
export const DEFAULT_OFFER: OfferProfile = {
    name: 'Compel',
    website: 'https://getcompel.co',
    promise:
        'Complete conversion funnels for coaches. $0 upfront; payment only when discovery call bookings increase.',
    primaryAudience: 'Executive, business, and leadership coaches',
    secondaryAudience: 'Life and career coaches with strong qualifying signals',
    markets: 'United States, United Kingdom, Canada — English-speaking markets',
    exclusions: 'Founder, CEO, or consultant unless explicitly paired with Coach',
    signals:
        'Active on LinkedIn within 30 days; has a website; shows signs of running or trying to run an inbound funnel.',
    priceMin: 1500,
    priceMax: 4000,
    paymentTrigger: 'Discovery call bookings increase.',
    measurementPolicy: '',
    caseStudyTerms: '',
    brand: 'Near-black, warm off-white, electric lime. Weight Pull wordmark. Previously Revlane.',
    outreach:
        'Initial email → reply → same-day Loom with calendar link and specific available slots → follow up after 48 hours if unbooked → breakup follow-up. No qualifying-question step.',
    personalBrand:
        'Phase 1: Algerian Instagram account in Darija, documenting the Compel build, marketing education, and mindset. Phase 2: English account tied to Compel after traction and results.',
    status: 'Pre-revenue at the time of the supplied knowledge base; first-client case-study outreach underway.',
    funnels: {
        DIRECT_TO_CALL: {
            description: 'For coaches whose primary call to action is a discovery call.',
            deliverables:
                'Booking-focused landing page copy and design\nNurture email sequence\nIntegrated booking flow',
        },
        VSL: {
            description: 'For higher-ticket offers and coaches with a strong on-camera presence.',
            deliverables:
                'Video-led landing page copy and design\nVSL outline and supporting copy\nNurture email sequence\nIntegrated booking flow',
        },
        LEAD_MAGNET: {
            description: 'For cold or awareness-stage audiences: freebie → nurture → booking.',
            deliverables:
                'Opt-in page copy and design\nLead magnet delivery flow\nNurture email sequence\nIntegrated booking flow',
        },
    },
    onboardingTemplates: DEFAULT_ONBOARDING_TEMPLATES,
};
export type OfferVersion = { version: number; profile: OfferProfile; createdAt: string };

export const SALES_STAGES = [
    'NEW',
    'EMAILED',
    'REPLIED',
    'LOOM_SENT',
    'FOLLOW_UP',
    'BREAKUP',
    'BOOKED',
    'PROPOSAL',
    'WON',
    'LOST',
] as const;
export type SalesStage = (typeof SALES_STAGES)[number];
export type OpportunityData = {
    name: string;
    email: string;
    website: string;
    stage: SalesStage;
    niche: string;
    audience: string;
    currentOffer: string;
    bookingPath: string;
    evidence: string;
    opportunity: string;
    unknowns: string;
    funnel: FunnelType | '';
    recommendationReason: string;
    mode: 'PERFORMANCE' | 'CASE_STUDY';
    fee: number | null;
    terms: string;
    loomUrl: string;
    bookingUrl: string;
    proposalUrl: string;
    nextAction: string;
    dueAt: string;
    callAt: string;
    lostReason: string;
    notes: string;
    repliedAt: string;
    loomSentAt: string;
    audienceStage?: 'UNKNOWN' | 'COLD' | 'WARM';
    videoReadiness?: 'UNKNOWN' | 'READY' | 'NOT_READY';
    offerTier?: 'UNKNOWN' | 'HIGH_TICKET' | 'STANDARD';
    primaryCta?: 'UNKNOWN' | 'CALL' | 'OPT_IN';
};
export type Opportunity = {
    id: string;
    leadId: string | null;
    offerVersion: number;
    revision: number;
    data: OpportunityData;
    updatedAt: string;
};
export type Deliverable = {
    id: string;
    title: string;
    status: 'TODO' | 'DOING' | 'BLOCKED' | 'REVIEW' | 'DONE';
    dueAt: string;
    content: string;
    url: string;
    visibleToClient?: boolean;
    version?: number;
    reviews?: import('./project-workspace').DeliverableReview[];
};
export type Measurement = {
    baselineStart: string;
    baselineEnd: string;
    baselineBookings: number | null;
    baselineVisitors: number | null;
    currentStart: string;
    currentEnd: string;
    currentBookings: number | null;
    currentVisitors: number | null;
    minimumIncrease: number | null;
    countingRules: string;
    attribution: string;
    evidenceUrl: string;
    agreed: boolean;
    reviewed: boolean;
};

export const AGREEMENT_STATUSES = [
    'DRAFT',
    'SENT',
    'VIEWED',
    'SIGNED_CLIENT',
    'FULLY_SIGNED',
] as const;
export type AgreementStatus = (typeof AGREEMENT_STATUSES)[number];
export const PAYMENT_STATUSES = [
    'NOT_SENT',
    'LINK_SENT',
    'DEPOSIT_PAID',
    'FULLY_PAID',
    'OVERDUE',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export const CLIENT_AGREEMENT_LABELS: Record<AgreementStatus, string> = {
    DRAFT: 'Ready to review', SENT: 'Please review and sign', VIEWED: 'Please sign the agreement',
    SIGNED_CLIENT: 'Waiting for Compel to sign', FULLY_SIGNED: 'Signed by both parties',
};
export const CLIENT_PAYMENT_LABELS: Record<PaymentStatus, string> = {
    NOT_SENT: 'Payment link to follow', LINK_SENT: 'Please complete your payment',
    DEPOSIT_PAID: 'Deposit received', FULLY_PAID: 'Payment received', OVERDUE: 'Payment overdue',
};
export type AccessStatus = 'NOT_REQUESTED' | 'REQUESTED' | 'RECEIVED' | 'VERIFIED' | 'NOT_NEEDED';
export type OnboardingDocument = {
    id: string;
    name: string;
    kind: 'AGREEMENT' | 'PAYMENT' | 'FORM' | 'SCOPE' | 'ASSET' | 'ACCESS' | 'BASELINE' | 'PERMISSION';
    url: string;
    fileName: string;
    dataUrl?: string;
    createdAt: string;
};
export type AccessItem = {
    generated?: boolean;
    id: string;
    platform: string;
    reason: string;
    permission: string;
    instructions: string;
    status: AccessStatus;
    required: boolean;
    nonBlocking: boolean;
};
export type OnboardingData = {
    journey?: OnboardingJourney;
    clientName: string;
    businessName: string;
    email: string;
    website: string;
    projectName: string;
    projectType: 'PAID' | 'CASE_STUDY';
    targetStartDate: string;
    portalToken: string;
    agreement: {
        status: AgreementStatus;
        intro: string;
        scope: string;
        deliverables: string;
        timeline: string;
        clientResponsibilities: string;
        compelResponsibilities: string;
        ownership: string;
        caseStudyRights: string;
        confidentiality: string;
        termination: string;
        revisions: string;
        sentAt: string;
        signedPdfName: string;
        signedPdfData?: string;
        clientSignature?: {
            name: string;
            email: string;
            signedAt: string;
            documentSha256: string;
        };
    };
    payment: {
        structure: 'FULL' | 'DEPOSIT' | 'CUSTOM';
        status: PaymentStatus;
        price: number | null;
        currency: string;
        deposit: number | null;
        balance: number | null;
        dueDate: string;
        link: string;
        notes: string;
    };
    form: {
        status: 'NOT_SENT' | 'SENT' | 'IN_PROGRESS' | 'COMPLETE';
        offerName: string;
        offer: string;
        audience: string;
        customerProblem: string;
        desiredOutcome: string;
        differentiation: string;
        unsuitableClients: string;
        trafficSources: string;
        landingPageUrl: string;
        bookingUrl: string;
        qualification: string;
        nurture: string;
        traffic: string;
        bookings: string;
        showRate: string;
        closeRate: string;
        bookingPlatform: string;
        crm: string;
        emailPlatform: string;
        analyticsPlatform: string;
        hostingPlatform: string;
        domainProvider: string;
        websitePlatform: string;
        repositoryProvider: string;
        assets: string;
        mustStay: string;
        avoid: string;
        importantContext: string;
        coachBio?: string;
        proof?: string;
        preferences?: string;
        caseStudyConsent: boolean;
        testimonialCommitment: boolean;
        deploymentAccessConsent: boolean;
    };
    access: AccessItem[];
    baseline: {
        captured: boolean;
        capturedAt: string;
        landingPage: string;
        hero: string;
        bookingFlow: string;
        currentCopy: string;
        cta: string;
        nurtureEmails: string;
        analyticsEvidence: string;
        traffic: string;
        bookings: string;
        showRate: string;
        closeRate: string;
        notes: string;
    };
    scope: {
        included: string;
        excluded: string;
        targetLaunchDate: string;
        approvalOwner: string;
        revisionProcess: string;
        dependencies: string;
        confirmed: boolean;
        confirmedAt: string;
    };
    overrides: string[];
    documents: OnboardingDocument[];
};

export const CASE_STUDY_CONSENT_VERSION = 'case-study-testimonial-v1';
export const CASE_STUDY_CONSENT_TEXT =
    'I agree to provide a short, honest testimonial after delivery and let Compel share this project and verified results as a case study, with my approval before publication.';

export const TESTIMONIAL_COMMITMENT_TEXT =
    'In exchange for this free case-study project, I will provide one short, honest written or video testimonial about my experience with Compel after the agreed work is delivered. A positive review is not required, and Compel will show me the testimonial for approval before publishing it.';
export const DEPLOYMENT_ACCESS_CONSENT_TEXT =
    'I will provide Compel with the collaborator or delegated access needed to build, publish, connect, and test my funnel in the tools I list, including my website builder, hosting, domain/DNS, and repository where used. Work requiring that access cannot start until Compel verifies it. I will use invitations to aymen@getcompel.co rather than share passwords.';
export const DEPLOYMENT_TOOL_FIELDS = [
    ['websitePlatform', 'Website / funnel builder'],
    ['hostingPlatform', 'Hosting / publishing platform'],
    ['domainProvider', 'Domain / DNS provider'],
    ['repositoryProvider', 'Code repository provider'],
] as const;
export const DEPLOYMENT_TOOL_HINT =
    'Fill this in only if you manage these tools. Otherwise, skip this section and we’ll coordinate deployment with the person responsible.';

const UNUSED_TOOL = /^(none|n\/?a|no|not used|not applicable|not needed|no custom domain|no repository|no code repository|no website|no hosting)$/i;
const UNKNOWN_TOOL = /^(unknown|unsure|not sure|don['’]?t know|i don['’]?t know|idk|tbd|to be decided|pending|\?+)$/i;
const namedTool = (value: string) => Boolean(value?.trim() && !UNUSED_TOOL.test(value.trim()) && !UNKNOWN_TOOL.test(value.trim()));

export const FUNNEL_OFFER_QUESTION = 'Which single offer should this funnel promote?';
export const FUNNEL_OFFER_HINT =
    'One offer keeps the message focused and gives visitors a clear next step, reducing distractions and helping the page convert.';
export const DIFFERENTIATION_QUESTION = 'What makes your approach different from other coaches?';
export const UNSUITABLE_CLIENTS_QUESTION = 'Who would you consider an unsuitable client?';
export const DEFAULT_SCOPE_EXCLUSIONS =
    'Unless agreed separately in writing, this project does not include:\nLead generation\nAdvertising, campaign management or ad spend\nThird-party subscriptions and platform costs\nOngoing optimization outside the agreed project scope';
const LEGACY_SCOPE_DEPENDENCIES = 'Signed agreement, required payment, completed form, verified access, and baseline capture.';
export const scopeDependencies = (projectType: OnboardingData['projectType']) =>
    `Signed agreement, completed onboarding form, any required access verified, and starting funnel information recorded.${projectType === 'CASE_STUDY' ? ' No project payment is required.' : ' The agreed initial payment must also be received.'}`;

export const REQUIRED_ONBOARDING_FORM_FIELDS = ONBOARDING_ESSENTIAL_FIELDS.map(
    ([key, briefKey]) => [key, OFFER_ESSENTIAL_LABELS[briefKey]] as const,
);

export function missingOnboardingFormFields(data: OnboardingData): string[] {
    const missing: string[] = REQUIRED_ONBOARDING_FORM_FIELDS
        .filter(([key]) => String(data.form[key] || '').trim().length < ESSENTIAL_MIN_LENGTH)
        .map(([, label]) => label);
    if (data.projectType === 'CASE_STUDY' && (!data.form.caseStudyConsent || !data.form.testimonialCommitment))
        missing.push('Case-study permission and testimonial commitment');
    if (data.journey && !data.journey.offerConfirmed) missing.push('Client offer review');
    return missing;
}

export function onboardingFormComplete(data: OnboardingData): boolean {
    return data.form.status === 'COMPLETE' && missingOnboardingFormFields(data).length === 0;
}
export function clientFormStatus(data: OnboardingData): string {
    if (onboardingFormComplete(data)) return 'Answers submitted';
    if (data.form.status === 'COMPLETE') return 'Please add the missing answers';
    if (data.form.status === 'IN_PROGRESS') return 'Continue your saved answers';
    return 'Please share your business details';
}

export type ProjectData = {
    name: string;
    funnel: FunnelType;
    mode: 'PERFORMANCE' | 'CASE_STUDY';
    fee: number | null;
    terms: string;
    status: 'ONBOARDING' | 'BUILDING' | 'APPROVAL' | 'LIVE' | 'COMPLETE';
    brief: string;
    assets: string;
    launchAt: string;
    deliverables: Deliverable[];
    measurement: Measurement;
    invoiceStatus: 'NOT_INVOICED' | 'DRAFT' | 'SENT' | 'PAID';
    invoiceUrl: string;
    onboarding?: OnboardingData;
    delivery?: import('./project-workspace').DeliveryWorkspace;
};
export type ClientProject = {
    id: string;
    opportunityId: string;
    offerVersion: number;
    revision: number;
    data: ProjectData;
    updatedAt: string;
};
export type BusinessSnapshot = {
    offer: OfferVersion;
    opportunities: Opportunity[];
    projects: ClientProject[];
};

export function blankOpportunity(): OpportunityData {
    return {
        name: '',
        email: '',
        website: '',
        stage: 'NEW',
        niche: '',
        audience: '',
        currentOffer: '',
        bookingPath: '',
        evidence: '',
        opportunity: '',
        unknowns: '',
        funnel: '',
        recommendationReason: '',
        mode: 'PERFORMANCE',
        fee: null,
        terms: '',
        loomUrl: '',
        bookingUrl: '',
        proposalUrl: '',
        nextAction: 'Send initial email',
        dueAt: '',
        callAt: '',
        lostReason: '',
        notes: '',
        repliedAt: '',
        loomSentAt: '',
        audienceStage: 'UNKNOWN',
        videoReadiness: 'UNKNOWN',
        offerTier: 'UNKNOWN',
        primaryCta: 'UNKNOWN',
    };
}

export function buildProject(data: OpportunityData, profile: OfferProfile): ProjectData {
    if (!data.funnel) throw new Error('Choose a funnel before creating the client project.');
    const titles = [
        'Onboarding brief and access',
        ...profile.funnels[data.funnel].deliverables.split('\n').filter(Boolean),
        'Client approval',
        'Launch and booking test',
    ];
    const project: ProjectData = {
        name: data.name,
        funnel: data.funnel,
        mode: data.mode,
        fee: data.fee,
        terms: data.terms,
        status: 'ONBOARDING',
        brief: [data.audience, data.currentOffer, data.opportunity].filter(Boolean).join('\n\n'),
        assets: '',
        launchAt: '',
        deliverables: titles.map((title, i) => ({
            id: `deliverable-${i}`,
            title,
            status: 'TODO',
            dueAt: '',
            content: '',
            url: '',
        })),
        measurement: {
            baselineStart: '',
            baselineEnd: '',
            baselineBookings: null,
            baselineVisitors: null,
            currentStart: '',
            currentEnd: '',
            currentBookings: null,
            currentVisitors: null,
            minimumIncrease: null,
            countingRules: '',
            attribution: '',
            evidenceUrl: '',
            agreed: false,
            reviewed: false,
        },
        invoiceStatus: 'NOT_INVOICED',
        invoiceUrl: '',
    };
    project.onboarding = createOnboardingData(project, data, profile);
    return project;
}

export function createOnboardingData(
    project: ProjectData,
    opportunity?: Partial<OpportunityData>,
    profile: OfferProfile = DEFAULT_OFFER,
): OnboardingData {
    const isCaseStudy = project.mode === 'CASE_STUDY';
    const deliverables = project.deliverables
        .map((item) => item.title)
        .filter((title) => !/onboarding|approval|launch/i.test(title))
        .join('\n');
    const templates = profile.onboardingTemplates || DEFAULT_ONBOARDING_TEMPLATES;
    return {
        clientName: opportunity?.name || project.name,
        businessName: opportunity?.name || project.name,
        email: opportunity?.email || '',
        website: opportunity?.website || '',
        projectName: `${project.name} funnel`,
        projectType: isCaseStudy ? 'CASE_STUDY' : 'PAID',
        targetStartDate: '',
        portalToken: '',
        agreement: {
            status: 'DRAFT',
            intro: isCaseStudy ? currentFreeAgreementIntro(templates.freeAgreement) : templates.paidAgreement,
            scope: project.brief || `${FUNNEL_LABELS[project.funnel]} funnel for ${project.name}.`,
            deliverables,
            timeline: project.launchAt
                ? `Target launch: ${project.launchAt}`
                : 'Timeline begins when all onboarding blockers are cleared.',
            clientResponsibilities:
                ['Provide accurate business information, requested assets and necessary access; give feedback and approvals in a reasonable timeframe; ensure supplied claims, testimonials and data are accurate.', DEPLOYMENT_ACCESS_CONSENT_TEXT, ...(isCaseStudy ? [TESTIMONIAL_COMMITMENT_TEXT] : [])].join('\n\n'),
            compelResponsibilities:
                'Diagnose the current funnel, create the approved deliverables, communicate progress, implement the agreed work, protect client information, and meet timelines when dependencies are available.',
            ownership: isCaseStudy
                ? 'The client owns the final approved funnel assets delivered to them. Compel retains its internal tools, frameworks and reusable systems. Public use follows the case-study permission below.'
                : 'Once agreed payment is complete, the client owns the final approved deliverables created specifically for them. Compel retains its internal systems, templates, reusable frameworks, tools and processes.',
            caseStudyRights: isCaseStudy
                ? 'Compel may document and publish project work only as described in the case-study permission below.'
                : 'Portfolio and case-study use requires separate written permission from the client.',
            confidentiality:
                'Both parties will keep non-public business, customer and access information confidential where reasonably required.',
            termination: isCaseStudy
                ? 'Either party may end the project with written notice. Completed work and return or removal of access will be handled promptly. No project fee is due for this free engagement.'
                : 'Either party may end the project with written notice. Completed work, outstanding payments and return or removal of access will be handled promptly.',
            revisions: isCaseStudy
                ? 'Reasonable revisions are limited to the confirmed scope.'
                : 'Revision rounds follow the confirmed project scope. Work outside that scope requires separate approval.',
            sentAt: '',
            signedPdfName: '',
        },
        payment: {
            structure: 'FULL',
            status: isCaseStudy ? 'FULLY_PAID' : 'NOT_SENT',
            price: project.fee,
            currency: 'USD',
            deposit: null,
            balance: project.fee,
            dueDate: '',
            link: project.invoiceUrl,
            notes: '',
        },
        form: {
            status: 'NOT_SENT',
            offerName: '',
            offer: '',
            audience: opportunity?.audience || '',
            customerProblem: '',
            desiredOutcome: '',
            differentiation: '',
            unsuitableClients: '',
            trafficSources: '',
            landingPageUrl: opportunity?.website || '',
            bookingUrl: opportunity?.bookingUrl || '',
            qualification: '',
            nurture: '',
            traffic: '',
            bookings: '',
            showRate: '',
            closeRate: '',
            bookingPlatform: '',
            crm: '',
            emailPlatform: '',
            analyticsPlatform: '',
            hostingPlatform: '',
            domainProvider: '',
            websitePlatform: '',
            repositoryProvider: '',
            assets: '',
            mustStay: '',
            avoid: '',
            importantContext: opportunity?.unknowns || '',
            caseStudyConsent: false,
            testimonialCommitment: false,
            deploymentAccessConsent: false,
        },
        access: [],
        baseline: {
            captured: false,
            capturedAt: '',
            landingPage: '',
            hero: '',
            bookingFlow: '',
            currentCopy: '',
            cta: '',
            nurtureEmails: '',
            analyticsEvidence: '',
            traffic: '',
            bookings: '',
            showRate: '',
            closeRate: '',
            notes: '',
        },
        scope: {
            included: deliverables,
            excluded: DEFAULT_SCOPE_EXCLUSIONS,
            targetLaunchDate: project.launchAt,
            approvalOwner: opportunity?.name || project.name,
            revisionProcess: 'One consolidated feedback round per milestone unless otherwise agreed.',
            dependencies: scopeDependencies(isCaseStudy ? 'CASE_STUDY' : 'PAID'),
            confirmed: false,
            confirmedAt: '',
        },
        overrides: [],
        documents: [],
    };
}

export function normalizeOnboarding(
    project: ProjectData,
    opportunity?: Partial<OpportunityData>,
    profile: OfferProfile = DEFAULT_OFFER,
): OnboardingData {
    const fallback = createOnboardingData(project, opportunity, profile);
    const saved = project.onboarding;
    if (!saved) return fallback;
    const { permissions: _legacyPermissions, ...current } = saved as OnboardingData & { permissions?: unknown };
    const { currentPrice: _legacyPrice, ...savedForm } = saved.form as OnboardingData['form'] & { currentPrice?: string };
    const form = { ...fallback.form, ...savedForm };
    // Remove the old prospect prefill only before the client has saved any answers.
    if ((form.status === 'NOT_SENT' || form.status === 'SENT') && form.offer === opportunity?.currentOffer) {
        form.offer = '';
    }
    if (savedForm.offerName === undefined) form.offerName = legacyOfferName(form.offer);
    const agreement = { ...fallback.agreement, ...saved.agreement };
    const scope = { ...fallback.scope, ...saved.scope };
    const signed = ['SIGNED_CLIENT', 'FULLY_SIGNED'].includes(agreement.status) || Boolean(agreement.clientSignature || agreement.signedPdfData || agreement.signedPdfName);
    if (!signed && current.projectType === 'CASE_STUDY' && agreement.termination === 'Either party may end the project with written notice. Completed work, outstanding payments and return or removal of access will be handled promptly.')
        agreement.termination = fallback.agreement.termination;
    // Upgrade untouched defaults, never custom exclusions or an already confirmed/signed scope.
    if (!signed && !scope.confirmed && !scope.excluded.trim()) scope.excluded = DEFAULT_SCOPE_EXCLUSIONS;
    if ([LEGACY_SCOPE_DEPENDENCIES, scopeDependencies('PAID'), scopeDependencies('CASE_STUDY')].includes(scope.dependencies))
        scope.dependencies = scopeDependencies(current.projectType || fallback.projectType);
    // Upgrade unsigned terms; signatures and stored signed PDFs retain their original wording.
    if (['DRAFT', 'SENT', 'VIEWED'].includes(agreement.status) && !agreement.clientSignature && !agreement.signedPdfData) {
        const commitments = [DEPLOYMENT_ACCESS_CONSENT_TEXT, ...(current.projectType === 'CASE_STUDY' ? [TESTIMONIAL_COMMITMENT_TEXT] : [])];
        for (const commitment of commitments)
            if (!agreement.clientResponsibilities.includes(commitment)) agreement.clientResponsibilities += `\n\n${commitment}`;
    }
    if (agreement.status === 'DRAFT' && current.projectType === 'CASE_STUDY') {
        agreement.intro = currentFreeAgreementIntro(agreement.intro);
        agreement.caseStudyRights = agreement.caseStudyRights.replace('permissions selected below', 'permission described below');
    }
    return {
        ...fallback,
        ...current,
        agreement,
        payment: { ...fallback.payment, ...saved.payment },
        form,
        baseline: { ...fallback.baseline, ...saved.baseline },
        scope,
        access: form.status === 'COMPLETE' || current.journey
            ? reconcileOnboardingAccess({ ...fallback, ...current, form, access: Array.isArray(saved.access) ? saved.access : [] })
            : Array.isArray(saved.access) ? saved.access : [],
        overrides: Array.isArray(saved.overrides) ? saved.overrides : [],
        documents: Array.isArray(saved.documents) ? saved.documents : [],
    };
}

const accessKey = (platform: string) =>
    `access-${platform.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}`;

export function generateAccessChecklist(form: OnboardingData['form']): AccessItem[] {
    const items: AccessItem[] = [];
    const add = (role: string, platform: string, reason: string, permission: string, instructions: string) => {
        if (!namedTool(platform)) return;
        items.push({
            generated: true,
            id: `${accessKey(platform)}-${role}`,
            platform: platform.trim(),
            reason,
            permission,
            instructions,
            status: 'NOT_REQUESTED',
            required: true,
            nonBlocking: false,
        });
    };
    add(
        'website',
        form.websitePlatform,
        'Needed to build, publish, and test the agreed funnel in your website or funnel builder.',
        'Website editor / publisher',
        `Invite aymen@getcompel.co as a collaborator who can edit and publish the relevant site or funnel in ${form.websitePlatform}. Keep the account in your business name; do not share a password.`,
    );
    add(
        'repository',
        form.repositoryProvider,
        'Needed to work with and deploy the funnel code.',
        'Repository collaborator',
        `Invite aymen@getcompel.co as a repository collaborator in ${form.repositoryProvider}. Do not share a password.`,
    );
    add(
        'hosting',
        form.hostingPlatform,
        'Needed to deploy and verify the finished funnel.',
        'Project collaborator',
        `Invite aymen@getcompel.co to the relevant project or team in ${form.hostingPlatform} with permission to deploy and manage the project. Keep the account in your business name.`,
    );
    add(
        'domain',
        form.domainProvider,
        'Needed only for final domain and DNS connection.',
        'DNS manager or delegated access',
        `Grant aymen@getcompel.co delegated domain/DNS access in ${form.domainProvider} where available so Compel can connect the funnel domain. Do not send login credentials.`,
    );
    add(
        'booking',
        form.bookingPlatform,
        'Needed to update the booking flow and qualification questions.',
        'Editor or admin for the relevant event',
        `Invite Compel through ${form.bookingPlatform}'s team or collaborator settings.`,
    );
    add(
        'email',
        form.emailPlatform,
        'Needed to build or update the agreed nurture sequence.',
        'Campaign editor',
        `Grant the minimum collaborator role that can edit automations in ${form.emailPlatform}.`,
    );
    add(
        'crm',
        form.crm,
        'Needed to connect lead capture and handoff.',
        'Workflow editor',
        `Invite Compel with access limited to the relevant pipeline or workflow in ${form.crm}.`,
    );
    add(
        'analytics',
        form.analyticsPlatform,
        'Needed to capture the baseline and verify tracking.',
        'Viewer or analyst',
        `Grant viewer or analyst access to the relevant property in ${form.analyticsPlatform}.`,
    );
    return items;
}

export function onboardingAccessChecklist(data: OnboardingData): AccessItem[] {
    const generated = generateAccessChecklist(data.form);
    if (!data.journey) return generated;
    const journey = journeyFor(data);
    if (journey.publisher === 'DEVELOPER') return [];
    const roles: Record<string, string> = { domain: 'domain', website: 'website', booking: 'booking', email: 'email', tracking: 'analytics' };
    return generated.filter(item => journey.accessNeeds.some(need => item.id.endsWith(`-${roles[need]}`)));
}

export function reconcileOnboardingAccess(data: OnboardingData): AccessItem[] {
    const generated = onboardingAccessChecklist(data);
    const existing = data.access.map(item => data.journey && item.generated
        ? { ...item, required: generated.some(next => next.id === item.id), nonBlocking: !generated.some(next => next.id === item.id) }
        : item);
    return mergeAccessChecklist(existing, generated);
}

export function mergeAccessChecklist(existing: AccessItem[], generated: AccessItem[]): AccessItem[] {
    const merged = existing.map((item) => ({ ...item }));
    for (const item of generated) {
        const index = merged.findIndex((saved) => saved.id === item.id ||
            (saved.id === accessKey(item.platform) && saved.permission === item.permission && saved.reason === item.reason));
        if (index < 0) merged.push(item);
        else merged[index] = { ...item, ...merged[index], id: item.id };
    }
    return merged;
}

export function onboardingAccessComplete(data: OnboardingData): boolean {
    const required = reconcileOnboardingAccess(data).filter(
        (item) => item.required && !item.nonBlocking,
    );
    if (data.journey && !publishingReady(data)) return false;
    return required.length
        ? required.every((item) => ['VERIFIED', 'NOT_NEEDED'].includes(item.status))
        : onboardingFormComplete(data);
}

export type OnboardingBlocker = { key: string; label: string; detail: string };
export function onboardingBlockers(data: OnboardingData, audience: 'internal' | 'client' = 'internal'): OnboardingBlocker[] {
    const blockers: OnboardingBlocker[] = [];
    const add = (key: string, label: string, detail: string) => {
        if (!data.overrides.includes(key)) blockers.push({ key, label, detail });
    };
    if (data.agreement.status !== 'FULLY_SIGNED')
        add('agreement', 'Agreement not fully signed', 'Complete both required signatures or add a manual override.');
    if (data.projectType === 'PAID') {
        const paid =
            data.payment.status === 'FULLY_PAID' ||
            (data.payment.structure !== 'FULL' && data.payment.status === 'DEPOSIT_PAID');
        if (!paid)
            add(
                'payment',
                data.payment.status === 'OVERDUE' ? 'Payment is overdue' : 'Initial payment not complete',
                'Record the full payment or agreed deposit before work starts.',
            );
    }
    if (!onboardingFormComplete(data))
        add('form', 'Onboarding form incomplete',
            data.form.status === 'COMPLETE'
                ? `Missing: ${missingOnboardingFormFields(data).join(', ')}.`
                : 'Collect the structured business, funnel, tool, and asset details.');
    if (data.journey && !publishingReady(data))
        add('publishing', 'Publishing handoff needs confirmation', 'Confirm who will publish the page and verify the access or developer arrangement. A contact or introduction alone is not confirmation.');
    const missingAccess = reconcileOnboardingAccess(data).filter(
        (item) => item.required && !item.nonBlocking && !['VERIFIED', 'NOT_NEEDED'].includes(item.status),
    );
    if (missingAccess.length)
        blockers.push({
            key: 'access',
            label: `${missingAccess.length} required access ${missingAccess.length === 1 ? 'item is' : 'items are'} missing`,
            detail: missingAccess.map((item) => item.platform).join(', '),
        });
    if (!data.baseline.captured)
        add('baseline', 'Baseline not captured', 'Preserve the current funnel and mark unavailable metrics as unknown.');
    if (!data.scope.confirmed)
        add('scope', 'Scope not confirmed', 'The client needs to approve the included work, exclusions, and dependencies.');
    if (audience === 'internal') return blockers;
    const clientDetails: Record<string, { label: string; detail: string }> = {
        agreement: data.agreement.status === 'SIGNED_CLIENT'
            ? { label: 'Waiting for Compel to sign', detail: 'You have signed. Compel will complete the agreement and share the signed copy with you.' }
            : { label: 'Review and sign your agreement', detail: 'Read the included work and exclusions, then review your agreement PDF and arrange your signature with Compel.' },
        payment: { label: data.payment.status === 'OVERDUE' ? 'Complete your overdue payment' : 'Complete the agreed initial payment', detail: data.payment.link ? 'Use the secure payment link in the Payment section.' : 'Compel will share your payment link. Contact Aymen if you need help.' },
        form: !clientBriefReady(data) ? { label: 'Compel is preparing your offer summary', detail: 'We will prepare a prefilled summary for you to review. No need to start from a blank form.' } : { label: 'Review your offer and business details', detail: data.form.status === 'COMPLETE' ? `Please add the missing answers: ${missingOnboardingFormFields(data).join(', ')}.` : 'Review the prefilled facts, add anything missing, and save your answers as you go.' },
        access: { label: 'Share the requested tool access', detail: 'Follow the access instructions below and let us know when you have sent the invitations. Never send passwords.' },
        publishing: { label: 'Arrange how your page will go live', detail: 'Tell us who manages your website. Compel will confirm the publishing responsibility and the access needed with you or your website contact.' },
        baseline: { label: 'Compel is preparing your starting-point record', detail: 'We will record your current funnel and available booking figures. We will contact you if we need anything else.' },
        scope: { label: 'Confirm the work we will deliver', detail: 'Review what is included, what is excluded and what we need before starting, then select Confirm this scope.' },
    };
    return blockers.map(item => ({ ...item, ...clientDetails[item.key] }));
}

export function onboardingProgress(data: OnboardingData) {
    const stages = [
        data.agreement.status === 'FULLY_SIGNED' || data.overrides.includes('agreement'),
        ...(data.projectType === 'PAID' ? [data.payment.status === 'FULLY_PAID' ||
            (data.payment.structure !== 'FULL' && data.payment.status === 'DEPOSIT_PAID') ||
            data.overrides.includes('payment')] : []),
        onboardingFormComplete(data) || data.overrides.includes('form'),
        onboardingAccessComplete(data),
        data.baseline.captured || data.overrides.includes('baseline'),
        data.scope.confirmed || data.overrides.includes('scope'),
    ];
    return Math.round((stages.filter(Boolean).length / stages.length) * 100);
}

