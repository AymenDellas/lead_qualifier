import type { OnboardingData } from './business';
import type { ImportResult } from './copy-studio/shared/contracts';

export type AccessNeed = 'domain' | 'website' | 'booking' | 'email' | 'tracking';
export type OnboardingJourney = {
    version: 1;
    flowVersion?: 2 | 3;
    reviewSummaries?: Partial<Record<'differentiation' | 'unsuitableClients' | 'trafficSources' | 'coachBio' | 'proof', string>>;
    briefPrepared: boolean;
    preparedAt: string;
    reference: ImportResult | null;
    sourceLabel: string;
    offerConfirmed: boolean;
    offerConfirmedAt: string;
    requestedChanges: string;
    step: number;
    websiteManager: '' | 'SELF' | 'OTHER' | 'UNSURE';
    publisher: '' | 'COMPEL' | 'DEVELOPER';
    contactName: string;
    contactEmail: string;
    introductionMessage: string;
    introductionSent: boolean;
    responsibilityConfirmed: boolean;
    verifiedAt: string;
    accessNeeds: AccessNeed[];
};
export const ACCESS_NEEDS: Record<AccessNeed, string> = {
    domain: 'Connect the web address', website: 'Publish in the existing website platform',
    booking: 'Update booking questions or reminders', email: 'Set up email follow-up', tracking: 'Set up tracking',
};
export function newOnboardingJourney(): OnboardingJourney {
    return { version: 1, flowVersion: 3, reviewSummaries: {}, briefPrepared: false, preparedAt: '', reference: null, sourceLabel: '', offerConfirmed: false,
        offerConfirmedAt: '', requestedChanges: '', step: 0, websiteManager: '', publisher: '', contactName: '',
        contactEmail: '', introductionMessage: '', introductionSent: false, responsibilityConfirmed: false,
        verifiedAt: '', accessNeeds: ['domain'] };
}
export function journeyFor(data: Pick<OnboardingData, 'journey'>): OnboardingJourney {
    return { ...newOnboardingJourney(), ...data.journey, flowVersion: data.journey ? data.journey.flowVersion : 3 };
}
// Welcome is 0, followed by four focused screens. Version two's removed review
// and agreement screens both resume at the agreement without losing any answers.
export function clientJourneyStep(saved: number, flowVersion?: 2 | 3): number {
    return flowVersion ? Math.max(-1, Math.min(3, saved - 1)) : saved >= 4 ? 3 : saved >= 3 ? 2 : saved > 0 ? 0 : -1;
}
export function storedJourneyStep(visible: number): number { return Math.max(0, Math.min(4, visible + 1)); }
export function needsWebsiteIntroduction(j: Pick<OnboardingJourney, 'websiteManager' | 'publisher'>): boolean {
    return j.websiteManager === 'OTHER' || j.publisher === 'DEVELOPER';
}
export function essentialsPresent(data: Pick<OnboardingData, 'form'>): boolean {
    return ['offerName', 'offer', 'audience', 'customerProblem', 'desiredOutcome'].every(key =>
        String(data.form[key as keyof OnboardingData['form']] || '').trim().length >= 3);
}
export function clientBriefReady(data: Pick<OnboardingData, 'form' | 'journey'>): boolean {
    return data.journey ? data.journey.briefPrepared || (Boolean(data.journey.sourceLabel || data.journey.reference) && essentialsPresent(data)) : essentialsPresent(data);
}
export function publishingReady(data: Pick<OnboardingData, 'journey'>): boolean {
    const j = journeyFor(data);
    return Boolean(j.publisher && j.responsibilityConfirmed && j.verifiedAt &&
        (j.publisher !== 'DEVELOPER' || (j.contactName.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(j.contactEmail))));
}
export function introductionDraft(data: Pick<OnboardingData, 'journey' | 'projectName' | 'clientName'>): string {
    const j = journeyFor(data);
    return `Hi ${j.contactName || '[Name]'},\n\nI’m working with Aymen from Compel on ${data.projectName}. I authorize him to coordinate the agreed website changes with you. Please reply to both of us so we can confirm who will publish the page and arrange the access needed.\n\nThe page will be published after I approve it. Aymen will provide the specific technical instructions.\n\nThank you,\n${data.clientName}`;
}
export function introductionMailto(data: Pick<OnboardingData, 'journey' | 'projectName' | 'clientName'>): string {
    const j = journeyFor(data);
    const query = new URLSearchParams({ cc: 'aymen@getcompel.co', subject: `Website introduction · ${data.clientName}`, body: j.introductionMessage || introductionDraft(data) });
    return `mailto:${encodeURIComponent(j.contactEmail)}?${query.toString().replace(/\+/g, '%20')}`;
}

/** Guided saves patch only named answers; omitted legacy/hidden fields survive. */
export const CLIENT_JOURNEY_FIELDS = ['websiteManager', 'publisher', 'contactName', 'contactEmail', 'introductionMessage', 'introductionSent', 'requestedChanges', 'step', 'flowVersion', 'reviewSummaries'] as const;
export function validateJourney(j: OnboardingJourney) {
    if (j.version !== 1 || !Array.isArray(j.accessNeeds) || j.accessNeeds.some(key => !Object.hasOwn(ACCESS_NEEDS, key))) throw new Error('Choose the access needed for this project.');
    if (!['', 'SELF', 'OTHER', 'UNSURE'].includes(j.websiteManager) || !['', 'COMPEL', 'DEVELOPER'].includes(j.publisher)) throw new Error('Choose who manages and publishes the website.');
    if (j.flowVersion !== undefined && j.flowVersion !== 2 && j.flowVersion !== 3) throw new Error('This onboarding flow is invalid.');
    if (!Number.isInteger(j.step) || j.step < 0 || j.step > (j.flowVersion === 2 ? 5 : 4)) throw new Error('This onboarding step is invalid.');
    if (j.reviewSummaries !== undefined) {
        if (!j.reviewSummaries || typeof j.reviewSummaries !== 'object' || Array.isArray(j.reviewSummaries)) throw new Error('The brief summaries are invalid.');
        for (const [key, value] of Object.entries(j.reviewSummaries)) {
            if (!['differentiation', 'unsuitableClients', 'trafficSources', 'coachBio', 'proof'].includes(key) || typeof value !== 'string' || value.length > 2000)
                throw new Error('Keep each brief summary under 2,000 characters.');
        }
    }
    for (const key of ['briefPrepared', 'offerConfirmed', 'introductionSent', 'responsibilityConfirmed'] as const)
        if (typeof j[key] !== 'boolean') throw new Error('The onboarding confirmation is invalid.');
    for (const key of ['contactName', 'contactEmail', 'sourceLabel', 'preparedAt', 'offerConfirmedAt', 'verifiedAt', 'requestedChanges', 'introductionMessage'] as const)
        if (typeof j[key] !== 'string' || j[key].length > 20000) throw new Error('Keep each onboarding answer under 20,000 characters.');
    if ((j.responsibilityConfirmed || j.verifiedAt) && j.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(j.contactEmail)) throw new Error('Enter a valid email for the person who manages your website.');
}
