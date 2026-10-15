export type Certainty = "Observed" | "Inferred" | "Unknown";
export type Priority = "high" | "medium" | "low";
export type FunnelSection = "Landing Page" | "Booking Flow" | "Nurture";

export type Evidence = {
  url: string;
  page: string;
  element: string;
  excerpt: string;
};

export type Finding = {
  id: string;
  section: FunnelSection;
  title: string;
  observation: string;
  whyItMatters: string;
  evidence: Evidence;
  certainty: Certainty;
  priority: Priority;
  rebuildAction: string;
};

export type EvidenceNote = {
  title: string;
  observation: string;
  evidence: Evidence;
  certainty: Certainty;
};

export type JourneyStep = {
  order: number;
  label: string;
  url: string | null;
  status: "observed" | "blocked" | "missing" | "unknown";
  note: string;
};

export type SectionAssessment = {
  label: "Strong" | "Mixed" | "Weak" | "Limited evidence";
  summary: string;
};

export type SectionDiagnosis = {
  working: EvidenceNote[];
  findings: Finding[];
  rebuildActions: string[];
  assessment: SectionAssessment;
};

export type LandingDimensionDiagnosis = {
  assessment: SectionAssessment;
  diagnosis: string;
  evidence: EvidenceNote[];
  rebuildActions: string[];
};

export type LandingPageAnalysis = {
  heroAndAboveFold: LandingDimensionDiagnosis;
  copyAndMessaging: LandingDimensionDiagnosis;
  offerAndMechanism: LandingDimensionDiagnosis;
  visualHierarchy: LandingDimensionDiagnosis;
  ctaAndConversionPath: LandingDimensionDiagnosis;
  trustAndProof: LandingDimensionDiagnosis;
  objectionsAndRisk: LandingDimensionDiagnosis;
  usabilityAndDistractions: LandingDimensionDiagnosis;
};

export type DeliverableRecommendation = {
  deliverable: "Landing-page rebuild" | "Booking-flow rebuild" | "Nurture rebuild";
  decision: "Recommended" | "Pending sequence review" | "Further information required" | "Not recommended";
  reason: string;
};

export type ScanResult = {
  scanId: string;
  scannedAt: string;
  startingUrl: string;
  analysisMode: "LLM";
  model: string;
  requestedModel: string;
  fallbackUsed: boolean;
  usage: {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
  } | null;
  funnelType: "Direct-to-call" | "Lead magnet" | "Hybrid" | "Other or unclear";
  audience: string;
  offer: string;
  conversionGoal: string;
  journeySummary: string;
  strongestDiagnosis: string;
  limitations: string[];
  primaryJourney: JourneyStep[];
  alternateJourney: JourneyStep[];
  primaryProblems: Finding[];
  landingPage: SectionDiagnosis;
  landingPageAnalysis: LandingPageAnalysis;
  bookingFlow: SectionDiagnosis;
  nurture: SectionDiagnosis & {
    publicFindings: EvidenceNote[];
    unknowns: string[];
    conditionalRecommendations: string[];
    informationRequired: string[];
  };
  deliverables: DeliverableRecommendation[];
  validationQuestions: string[];
  pagesInspected: Array<{
    url: string;
    label: string;
    status: "inspected" | "blocked";
    note: string;
  }>;
};
