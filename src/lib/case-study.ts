/** Serializable records for the Case Study Hunter and its delivery archive. */
export const MAX_SOURCE_SCAN_PROFILES = 150;

export const HUNTER_MODES = ['CASE_STUDY', 'CLIENT'] as const;
export type HunterMode = (typeof HUNTER_MODES)[number];

export const WARMTH_SOURCES = [
    'REPLIED',
    'PROFILE_VIEWER',
    'ENGAGER',
    'FOLLOWER',
    'CONNECTION',
    'MANUAL',
] as const;
export type WarmthSource = (typeof WARMTH_SOURCES)[number];
export const WARMTH_LABELS: Record<WarmthSource, string> = {
    REPLIED: 'Replied before',
    PROFILE_VIEWER: 'Viewed your profile',
    ENGAGER: 'Engaged with your content',
    FOLLOWER: 'Follows you',
    CONNECTION: 'LinkedIn connection',
    MANUAL: 'Manually found',
};

export const CASE_STUDY_STAGES = [
    'FOUND',
    'QUALIFIED',
    'MESSAGED',
    'REPLIED',
    'INTERESTED',
    'AUDIT_SENT',
    'CALL_BOOKED',
    'CASE_STUDY_AGREED',
    'REBUILD',
    'COMPLETED',
    'TESTIMONIAL_RESULTS',
    'DO_NOT_CONTACT',
] as const;
export type CaseStudyStage = (typeof CASE_STUDY_STAGES)[number];
export const CRM_OUTREACH_STATUSES = ['NOT_CONTACTED', 'MESSAGED', 'DO_NOT_CONTACT'] as const;
export type CrmOutreachStatus = (typeof CRM_OUTREACH_STATUSES)[number];
export const CASE_STUDY_STAGE_LABELS: Record<CaseStudyStage, string> = {
    FOUND: 'Found',
    QUALIFIED: 'Qualified',
    MESSAGED: 'Messaged',
    REPLIED: 'Replied',
    INTERESTED: 'Interested',
    AUDIT_SENT: 'Audit sent',
    CALL_BOOKED: 'Call booked',
    CASE_STUDY_AGREED: 'Case study agreed',
    REBUILD: 'Rebuild',
    COMPLETED: 'Completed',
    TESTIMONIAL_RESULTS: 'Testimonial / results',
    DO_NOT_CONTACT: "Don't contact",
};

export type FunnelObservation = {
    id: string;
    label: string;
    evidence: string;
    url: string;
    severity: number;
};

export type CaseStudyScores = {
    icpFit: number;
    warmth: number;
    funnelWeakness: number;
    commercialPotential: number;
    total: number;
};

export type DeliveryArchive = {
    strongestLeaks: string[];
    auditUrl: string;
    discoveryCallAt: string;
    beforeScreenshots: string[];
    afterScreenshots: string[];
    oldCopy: string;
    newCopy: string;
    rationale: string;
    metrics: string;
    testimonial: string;
    caseStudyUrl: string;
};

export type HeadlineQualification = {
    qualified: boolean;
    matches: string[];
    reason: string;
    /** Preserve the operator's title selection for later retries. */
    targetTitles?: string[];
};

export type WebsiteScan = {
    method: '' | 'NOT_RUN' | 'FOUND' | 'NOT_FOUND' | 'RENDERED_BROWSER' | 'HTTP_FALLBACK' | 'BLOCKED' | 'FAILED' | 'ERROR';
    pages: string[];
    challenge: string;
    completedAt: string;
};

export type CaseStudyProspectData = {
    name: string;
    linkedinUrl: string;
    headline: string;
    location: string;
    website: string;
    email: string;
    source: WarmthSource;
    warmthEvidence: string;
    mode: HunterMode;
    stage: CaseStudyStage;
    /** Funnel stage to restore if an outreach exclusion is lifted. */
    doNotContactPreviousStage?: CaseStudyStage;
    /** True only when this outreach record set the linked CRM suppression flag. */
    outreachSuppressedLead?: boolean;
    scanStatus: 'NOT_RUN' | 'QUEUED' | 'ANALYZING' | 'COMPLETE' | 'ERROR';
    /** Link to the original qualified lead without copying its outreach state. */
    crmLeadId?: string;
    /** Existing lead-qualifier hook; review it before using it as a DM. */
    crmHook?: string;
    coachFit: 'YES' | 'MAYBE' | 'NO';
    headlineQualification: HeadlineQualification;
    websiteScan: WebsiteScan;
    scores: CaseStudyScores;
    whyContact: string;
    mainWeakness: string;
    outreachAngle: string;
    suggestedDm: string;
    recommendedNextAction: string;
    observations: FunnelObservation[];
    nextAction: string;
    nextActionDueAt: string;
    lastContactedAt: string;
    notes: string;
    delivery: DeliveryArchive;
};

export type CaseStudyProspect = {
    id: string;
    revision: number;
    data: CaseStudyProspectData;
    createdAt: string;
    updatedAt: string;
};

export type CaseStudyActivity = {
    id: string;
    prospectId: string;
    kind: string;
    note: string;
    createdAt: string;
};

export type CaseStudySnapshot = {
    prospects: CaseStudyProspect[];
    activities: CaseStudyActivity[];
};

export function crmOutreachStatus(data: CaseStudyProspectData): CrmOutreachStatus {
    if (data.stage === 'DO_NOT_CONTACT') return 'DO_NOT_CONTACT';
    return data.lastContactedAt || CASE_STUDY_STAGES.indexOf(data.stage) >= CASE_STUDY_STAGES.indexOf('MESSAGED')
        ? 'MESSAGED' : 'NOT_CONTACTED';
}

export function blankDelivery(): DeliveryArchive {
    return {
        strongestLeaks: ['', '', ''],
        auditUrl: '',
        discoveryCallAt: '',
        beforeScreenshots: [],
        afterScreenshots: [],
        oldCopy: '',
        newCopy: '',
        rationale: '',
        metrics: '',
        testimonial: '',
        caseStudyUrl: '',
    };
}

export function blankCaseStudyProspect(
    linkedinUrl = '',
    source: WarmthSource = 'CONNECTION',
    mode: HunterMode = 'CASE_STUDY',
): CaseStudyProspectData {
    return {
        name: '',
        linkedinUrl,
        headline: '',
        location: '',
        website: '',
        email: '',
        source,
        warmthEvidence: '',
        mode,
        stage: 'FOUND',
        scanStatus: 'QUEUED',
        coachFit: 'MAYBE',
        headlineQualification: { qualified: false, matches: [], reason: '' },
        websiteScan: { method: '', pages: [], challenge: '', completedAt: '' },
        scores: { icpFit: 0, warmth: 0, funnelWeakness: 0, commercialPotential: 0, total: 0 },
        whyContact: '',
        mainWeakness: '',
        outreachAngle: '',
        suggestedDm: '',
        recommendedNextAction: 'Run the LinkedIn and funnel scan',
        observations: [],
        nextAction: 'Run the LinkedIn and funnel scan',
        nextActionDueAt: '',
        lastContactedAt: '',
        notes: '',
        delivery: blankDelivery(),
    };
}

export function canonicalLinkedinUrl(value: string): string {
    const raw = value.trim();
    if (!raw) throw new Error('LinkedIn URL is required.');
    let parsed: URL;
    try {
        parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {
        throw new Error(`Invalid LinkedIn URL: ${raw}`);
    }
    if (!/(^|\.)linkedin\.com$/i.test(parsed.hostname) || !/^\/in\/[^/]+/i.test(parsed.pathname))
        throw new Error(`Use a LinkedIn profile URL containing /in/: ${raw}`);
    const slug = parsed.pathname.match(/^\/in\/([^/?#]+)/i)?.[1];
    return `https://www.linkedin.com/in/${slug}/`;
}

/** Stage changes record work and due dates; they never send a message. */
export function transitionCaseStudyProspect(
    current: CaseStudyProspectData,
    stage: CaseStudyStage,
    now = new Date(),
): CaseStudyProspectData {
    if (stage === current.stage) return { ...current };
    const next = { ...current, stage, nextActionDueAt: '' };
    const immediately = now.toISOString();
    const in48Hours = new Date(now.getTime() + 48 * 3600000).toISOString();
    const actions: Record<CaseStudyStage, string> = {
        FOUND: 'Finish the scan and decide whether they fit',
        QUALIFIED: 'Review the profile and website, then write your LinkedIn DM',
        MESSAGED: 'Follow up if they do not reply',
        REPLIED: 'Send the specific Loom / audit now',
        INTERESTED: 'Send the specific Loom / audit now',
        AUDIT_SENT: 'Follow up on the audit and book the call',
        CALL_BOOKED: 'Prepare the three strongest funnel leaks',
        CASE_STUDY_AGREED: 'Capture the before state before rebuilding',
        REBUILD: 'Complete the funnel rebuild and archive every decision',
        COMPLETED: 'Record results and request the testimonial',
        TESTIMONIAL_RESULTS: 'Publish the case study and use it in client outreach',
        DO_NOT_CONTACT: 'Do not contact this prospect',
    };
    next.nextAction = actions[stage];
    next.recommendedNextAction = actions[stage];
    if (stage === 'MESSAGED') {
        next.lastContactedAt = immediately;
        next.nextActionDueAt = in48Hours;
    } else if (stage === 'REPLIED' || stage === 'INTERESTED') {
        next.nextActionDueAt = immediately;
    } else if (stage === 'AUDIT_SENT') {
        next.lastContactedAt = immediately;
        next.nextActionDueAt = in48Hours;
    } else if (stage === 'CASE_STUDY_AGREED') {
        next.mode = 'CASE_STUDY';
        next.nextActionDueAt = immediately;
    } else if (stage === 'DO_NOT_CONTACT') {
        next.doNotContactPreviousStage = current.stage;
    }
    return next;
}

export function isDeliveryStage(stage: CaseStudyStage): boolean {
    return ['CASE_STUDY_AGREED', 'REBUILD', 'COMPLETED', 'TESTIMONIAL_RESULTS'].includes(stage);
}

export function buildHunterDailyPlan(prospects: CaseStudyProspect[], now = new Date()) {
    const open = prospects.filter((p) => !['TESTIMONIAL_RESULTS', 'DO_NOT_CONTACT'].includes(p.data.stage));
    const byWarmth = (a: CaseStudyProspect, b: CaseStudyProspect) =>
        WARMTH_SOURCES.indexOf(a.data.source) - WARMTH_SOURCES.indexOf(b.data.source) || Date.parse(a.createdAt) - Date.parse(b.createdAt);
    const message = open
        .filter((p) => p.data.stage === 'QUALIFIED' && (
            (p.data.scanStatus === 'COMPLETE' && p.data.coachFit === 'YES') ||
            (p.data.scanStatus === 'NOT_RUN' && Boolean(p.data.crmLeadId) && Boolean(p.data.crmHook))
        ))
        .sort(byWarmth)
        .slice(0, 5);
    const followUp = open
        .filter(
            (p) =>
                ['MESSAGED', 'REPLIED', 'INTERESTED', 'AUDIT_SENT'].includes(p.data.stage) &&
                !!p.data.nextActionDueAt &&
                Date.parse(p.data.nextActionDueAt) <= now.getTime(),
        )
        .sort((a, b) => Date.parse(a.data.nextActionDueAt) - Date.parse(b.data.nextActionDueAt))
        .slice(0, 3);
    const excluded = new Set([...message, ...followUp].map((p) => p.id));
    const engage = open
        .filter(
            (p) =>
                !excluded.has(p.id) &&
                ['FOUND', 'QUALIFIED'].includes(p.data.stage) &&
                p.data.coachFit === 'YES' &&
                p.data.source !== 'MANUAL',
        )
        .sort(byWarmth)
        .slice(0, 5);
    return { message, followUp, engage };
}
