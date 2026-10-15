import { z } from 'zod';
import { FUNNEL_TYPES, type FunnelType, type ProjectData } from './business';

export const CALL_OUTCOMES = ['PENDING', 'AGREED', 'FOLLOW_UP', 'NOT_A_FIT', 'NO_SHOW'] as const;
export const CALL_OUTCOME_LABELS: Record<(typeof CALL_OUTCOMES)[number], string> = {
    PENDING: 'Upcoming / undecided', AGREED: 'Agreed to proceed', FOLLOW_UP: 'Follow-up needed',
    NOT_A_FIT: 'Not a fit', NO_SHOW: 'Did not attend',
};
export type CallQuestion = { id: string; title: string; prompt: string; answer: string };
export type CallTemplateData = { questions: Omit<CallQuestion, 'answer'>[]; offerScript: string };
export const DEFAULT_CALL_TEMPLATE: CallTemplateData = {
    questions: [
        { id: 'success', title: 'What are we really trying to improve?', prompt: 'What would make this project genuinely successful for you?' },
        { id: 'offer', title: 'Which offer matters most right now?', prompt: 'If we focus this funnel on one offer, which one should it be, and why?' },
        { id: 'buyer', title: 'Who is the buyer you actually want more of?', prompt: 'Who tends to be the best fit for your work? Who would you rather not attract?' },
        { id: 'context', title: 'What is happening that the website doesn’t show?', prompt: 'Where do leads really come from? What do prospects usually say, and what makes them hesitate?' },
        { id: 'belief', title: 'What do prospects need to believe before they book?', prompt: 'What do people need to understand or feel confident about before they decide to speak with you? Why do they choose you?' },
        { id: 'preserve', title: 'What should stay, and what can I challenge?', prompt: 'Are there messages, offers, pages, brand elements, or processes you want preserved? Where do I have freedom to rethink things?' },
        { id: 'sales', title: 'What happens after the booking?', prompt: 'Walk me through what happens from booking the call to becoming a client.' },
        { id: 'priority', title: 'What are we optimizing for first?', prompt: 'Which matters most right now: qualified bookings, show rate, lead quality, clearer positioning, or something else?' },
        { id: 'relationship', title: 'Confirm the working relationship', prompt: 'Are you comfortable with the agreed rebuild scope and receiving formal onboarding afterward? For a case study, discuss documenting the work and results.' },
    ],
    offerScript: 'So basically, we’re gonna be building three pillars.\n\nFirst, a high-converting landing page, using proven copy templates and formulas, strong messaging, and a clear visual hierarchy. Everything from the headline to where we put the buttons is designed to help turn more visitors into bookings.\n\nThen, a frictionless booking flow. That’s basically the process someone goes through once they decide they want to speak with you—from clicking the button to choosing a time and confirming their call. We’ll make that simple and clear, so they can book without getting confused or dropping off halfway through.\n\nAnd then we have the nurture system, where we send follow-ups leading up to the call to build trust, help them understand what to expect, and increase the chances they actually show up. We can also follow up with people who showed interest but haven’t booked yet.',
};
export type DiscoveryCallData = {
    name: string; businessName: string; email: string; website: string; linkedinUrl: string;
    scheduledAt: string; projectType: 'PAID' | 'CASE_STUDY'; currentOffer: string;
    context: string; funnelNotes: string; questions: CallQuestion[]; offerScript: string;
    notes: string; objections: string; agreedScope: string; excludedScope: string;
    outcome: (typeof CALL_OUTCOMES)[number]; nextAction: string; followUpAt: string; funnel: FunnelType;
};
export type DiscoveryCall = {
    id: string; sourceProspectId: string | null; projectId: string | null;
    revision: number; data: DiscoveryCallData; createdAt: string; updatedAt: string;
};
export type CallSource = {
    id: string; name: string; email: string; website: string; linkedinUrl: string;
    headline: string; mode: 'CASE_STUDY' | 'CLIENT'; scheduledAt: string; notes: string;
    warmthEvidence: string; mainWeakness: string; stage: string;
};
export type DiscoverySnapshot = {
    calls: DiscoveryCall[]; sources: CallSource[]; template: { revision: number; data: CallTemplateData };
};
export type DiscoveryActionResult<T> = { ok: true; value: T } | { ok: false; error: string };
export function unwrapDiscoveryResult<T>(result: DiscoveryActionResult<T>): T {
    if (!result.ok) throw new Error(result.error);
    return result.value;
}
export function blankDiscoveryCall(template: CallTemplateData = DEFAULT_CALL_TEMPLATE): DiscoveryCallData {
    return {
        name: '', businessName: '', email: '', website: '', linkedinUrl: '', scheduledAt: '',
        projectType: 'CASE_STUDY', currentOffer: '', context: '', funnelNotes: '',
        questions: template.questions.map(question => ({ ...question, answer: '' })),
        offerScript: template.offerScript, notes: '', objections: '', agreedScope: '', excludedScope: '',
        outcome: 'PENDING', nextAction: '', followUpAt: '', funnel: 'DIRECT_TO_CALL',
    };
}
export function callFromSource(source: CallSource, template: CallTemplateData): DiscoveryCallData {
    return {
        ...blankDiscoveryCall(template), name: source.name || source.headline || 'New prospect',
        businessName: source.name, email: source.email, website: source.website, linkedinUrl: source.linkedinUrl,
        scheduledAt: source.scheduledAt, projectType: source.mode === 'CASE_STUDY' ? 'CASE_STUDY' : 'PAID',
        context: [source.headline, source.warmthEvidence, source.notes].filter(Boolean).join('\n\n'),
        funnelNotes: source.mainWeakness,
    };
}

const text = z.string().max(20000);
const url = z.string().max(2000).refine(value => !value || /^https?:\/\//i.test(value) && URL.canParse(value), 'Use a full http:// or https:// URL.');
const date = z.string().max(50).refine(value => !value || Number.isFinite(Date.parse(value)), 'Choose a valid date.');
const questionSchema = z.object({ id: z.string().min(1).max(100), title: z.string().trim().min(1).max(500), prompt: text });
function uniqueQuestions(questions: { id: string }[]) { return new Set(questions.map(q => q.id)).size === questions.length; }
export const callTemplateSchema = z.object({
    questions: z.array(questionSchema).max(30).refine(uniqueQuestions, 'Question IDs must be unique.'),
    offerScript: text,
});
export const discoveryCallSchema = z.object({
    name: z.string().trim().min(1, 'Add the prospect’s name.').max(500), businessName: text,
    email: z.string().max(500).refine(value => !value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), 'Enter a valid email.'),
    website: url, linkedinUrl: url, scheduledAt: date, projectType: z.enum(['PAID', 'CASE_STUDY']),
    currentOffer: text, context: text, funnelNotes: text,
    questions: z.array(questionSchema.extend({ answer: text })).max(30).refine(uniqueQuestions, 'Question IDs must be unique.'),
    offerScript: text, notes: text, objections: text, agreedScope: text, excludedScope: text,
    outcome: z.enum(CALL_OUTCOMES), nextAction: text, followUpAt: date, funnel: z.enum(FUNNEL_TYPES),
});
export function questionAnswer(data: DiscoveryCallData, id: string) {
    return data.questions.find(q => q.id === id)?.answer.trim() || '';
}
export function discoveryRecap(data: DiscoveryCallData): string {
    const parts = [
        `Discovery call · ${data.name}`, `Outcome: ${CALL_OUTCOME_LABELS[data.outcome]}`,
        data.currentOffer && `Current offer: ${data.currentOffer}`,
        data.context && `Prospect context\n${data.context}`,
        data.funnelNotes && `Funnel observations\n${data.funnelNotes}`,
        ...data.questions.filter(q => q.answer.trim()).map(q => `${q.title}\n${q.answer.trim()}`),
        data.notes && `Call notes\n${data.notes}`, data.objections && `Objections / open questions\n${data.objections}`,
        data.agreedScope && `Agreed scope\n${data.agreedScope}`, data.excludedScope && `Outside scope\n${data.excludedScope}`,
        data.nextAction && `Next step\n${data.nextAction}`,
        data.followUpAt && `Follow-up: ${data.followUpAt}`,
    ];
    return parts.filter(Boolean).join('\n\n');
}
/** Populate the draft brief without claiming formal approval or completed onboarding. */
export function applyDiscoveryToProject(project: ProjectData, data: DiscoveryCallData): ProjectData {
    if (!project.onboarding) throw new Error('Create onboarding before applying the call brief.');
    const onboarding = project.onboarding;
    const recap = discoveryRecap(data);
    return {
        ...project, brief: recap,
        onboarding: {
            ...onboarding, clientName: data.name, businessName: data.businessName || data.name,
            email: data.email, website: data.website, projectName: `${data.name} funnel`,
            form: {
                ...onboarding.form, offer: questionAnswer(data, 'offer') || data.currentOffer,
                audience: questionAnswer(data, 'buyer'), desiredOutcome: [questionAnswer(data, 'success'), questionAnswer(data, 'priority')].filter(Boolean).join('\n\n'),
                mustStay: questionAnswer(data, 'preserve'), importantContext: recap,
            },
            agreement: { ...onboarding.agreement, scope: data.agreedScope || onboarding.agreement.scope },
            scope: { ...onboarding.scope, included: data.agreedScope || onboarding.scope.included, excluded: data.excludedScope },
        },
    };
}
