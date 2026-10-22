/** The client onboarding and Copy Studio ask for the same five offer facts. */
export const OFFER_ESSENTIAL_LABELS = {
    offerName: 'Offer name',
    description: 'What are you offering?',
    audience: 'Who is it for?',
    problem: 'What problem are they facing?',
    outcome: 'What outcome do they want?',
} as const;
export const OFFER_ESSENTIAL_KEYS = Object.keys(OFFER_ESSENTIAL_LABELS) as Array<keyof typeof OFFER_ESSENTIAL_LABELS>;
export const ONBOARDING_ESSENTIAL_FIELDS = [
    ['offerName', 'offerName'],
    ['offer', 'description'],
    ['audience', 'audience'],
    ['customerProblem', 'problem'],
    ['desiredOutcome', 'outcome'],
] as const;
export const ESSENTIAL_MIN_LENGTH = 3;
export const ESSENTIAL_MAX_LENGTH = 6000;

/** Older forms had one combined offer answer. Preserve its short first line as the editable name. */
export function legacyOfferName(offer?: string): string {
    const line = (offer || '').trim().split('\n')[0];
    return line.length <= 200 ? line : '';
}
