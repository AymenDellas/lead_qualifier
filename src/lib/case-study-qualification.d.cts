export type Qualification = {
    qualified: boolean;
    matches: string[];
    reason: string;
    targetTitles: string[];
};
export const DEFAULT_TARGET_TITLES: readonly string[];
export function normalizeTitles(values?: unknown): string[];
export function qualifyHeadline(headline: unknown, configuredTitles?: unknown): Qualification;
export function isMissedCoachCandidate(data: unknown, targetTitles?: unknown): boolean;
