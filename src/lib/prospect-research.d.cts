import type { ProspectResearch } from './prospect-qualification.cjs';
export function researchProspect(input: {
    firstName?: string; lastName?: string; headline?: string; about?: string; profileLocation?: string;
    profileIdentityConfirmed?: boolean; linkedinUrl?: string; url?: string; website?: string; websites?: string[];
    email?: string; emails?: string[]; emailSource?: string; latestPostText?: string; lastActivityAt?: string | null;
}, options?: { ai?: boolean; now?: string }): Promise<ProspectResearch>;
