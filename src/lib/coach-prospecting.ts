export type CoachEvidence = { source: string; url: string; quote: string };
export type CoachContact = {
  accountId: string;
  connection: "CONNECTED" | "NOT_CONNECTED" | "PENDING" | "UNKNOWN";
  openProfile: "YES" | "NO" | "UNKNOWN";
  checkedAt: string;
  source: "WORKER" | "MANUAL";
  note: string;
};
export type CoachAssessment = {
  policy: string;
  status: "MATCH" | "POTENTIAL" | "OUTSIDE";
  score: number;
  reason: string;
  evidence: CoachEvidence[];
  gaps: string[];
  assessedAt: string;
};
export type CoachProspecting = {
  followers?:import('./prospect-qualification.cjs').AudienceEvidence|null;connections?:import('./prospect-qualification.cjs').AudienceEvidence|null;
  assessment: CoachAssessment;
  automatedAssessment?: CoachAssessment;
  contact: CoachContact | null;
  about: string;
  runId?: string;
  lastJobId?: string;
  accountId: string;
  discoverySource?: string;
  researchStatus: string;
  websiteSources?: { url: string; title?: string }[];
  suppressed?: boolean;
  draft?: string;
  invitationDraft?: string;
};
export type CoachRun = {
  id: string;
  account_id: string;
  source: string;
  status: string;
  data: {
    limit: number;
    queued: number;
    skipped: number;
    pages: number;
    message: string;
    criteria: { exclude: string[] };
  };
  created_at: string;
  updated_at: string;
  done: number;
  failed: number;
  pending: number;
};
export const COACH_LISTS = {
  ALL: "All prospects",
  READY: "Ready to message",
  CONNECT: "Connection requests",
  VERIFY: "Verify messaging",
  REVIEW: "Needs fit review",
  PENDING: "Invitation pending",
  CONTACTED: "Already contacted",
  OUTSIDE: "Outside criteria",
  SUPPRESSED: "Do not contact",
};
export const COACH_SOURCES = {
  ALL: "All sources",
  CONNECTION: "My connections",
  FOLLOWER: "My followers",
  PROFILE_VIEWER: "Profile viewers",
  SEARCH: "LinkedIn People Search",
  URLS: "Pasted profiles",
  MANUAL: "Other / manually added",
};
