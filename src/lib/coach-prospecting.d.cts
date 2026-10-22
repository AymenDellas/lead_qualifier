import type { CoachAssessment, CoachContact } from "./coach-prospecting";
export function assessCoach(
  input?: any,
  research?: any,
  criteria?: any,
): CoachAssessment;
export function profileContactEvidence(
  profile?: any,
  accountId?: string,
  now?: string,
): CoachContact;
export function contactRoute(
  data?: any,
  accountId?: string,
  now?: number,
): { key: string; label: string; reason: string };
export function shortlist(
  data: any,
  accountId: string,
  now?: number,
): {
  list: string;
  route: { key: string; label: string; reason: string };
  score: number;
};
export function csvCell(value: unknown): string;
