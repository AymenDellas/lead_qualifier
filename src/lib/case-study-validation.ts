import {
    CASE_STUDY_STAGES,
    HUNTER_MODES,
    WARMTH_SOURCES,
    type CaseStudyProspectData,
} from './case-study';

function text(value: unknown, label: string, max = 50000): asserts value is string {
    if (typeof value !== 'string' || value.length > max)
        throw new Error(`${label} must be text of at most ${max.toLocaleString()} characters.`);
}

function url(value: unknown, label: string) {
    text(value, label, 2000);
    if (!value) return;
    try {
        if (!['http:', 'https:'].includes(new URL(value).protocol)) throw new Error();
    } catch {
        throw new Error(`${label} must start with https:// or http://.`);
    }
}

function date(value: unknown, label: string) {
    text(value, label, 50);
    if (value && !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be a valid date.`);
}

export function validateCaseStudyProspect(data: CaseStudyProspectData) {
    url(data.linkedinUrl, 'LinkedIn URL');
    if (!data.linkedinUrl.includes('linkedin.com/in/')) throw new Error('Use a LinkedIn profile URL.');
    url(data.website, 'Website');
    if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email))
        throw new Error('Enter a valid email address.');
    if (!WARMTH_SOURCES.includes(data.source)) throw new Error('Choose a valid warmth source.');
    if (!HUNTER_MODES.includes(data.mode)) throw new Error('Choose a valid hunter mode.');
    if (!CASE_STUDY_STAGES.includes(data.stage)) throw new Error('Choose a valid CRM stage.');
    if (data.doNotContactPreviousStage !== undefined && !CASE_STUDY_STAGES.includes(data.doNotContactPreviousStage))
        throw new Error('Previous CRM stage is invalid.');
    if (data.outreachSuppressedLead !== undefined && typeof data.outreachSuppressedLead !== 'boolean')
        throw new Error('CRM suppression flag is invalid.');
    if (!['NOT_RUN', 'QUEUED', 'ANALYZING', 'COMPLETE', 'ERROR'].includes(data.scanStatus))
        throw new Error('Choose a valid scan status.');
    if (data.crmLeadId !== undefined) text(data.crmLeadId, 'CRM lead ID', 255);
    if (data.crmHook !== undefined) text(data.crmHook, 'CRM hook', 10000);
    if (!['YES', 'MAYBE', 'NO'].includes(data.coachFit)) throw new Error('Choose a valid coach-fit verdict.');
    if (!data.headlineQualification || typeof data.headlineQualification.qualified !== 'boolean')
        throw new Error('Headline qualification is missing.');
    if (!Array.isArray(data.headlineQualification.matches) || data.headlineQualification.matches.length > 30)
        throw new Error('Use up to 30 headline matches.');
    data.headlineQualification.matches.forEach((match) => text(match, 'Headline match', 100));
    text(data.headlineQualification.reason, 'Headline qualification reason', 5000);
    if (data.headlineQualification.targetTitles !== undefined) {
        if (!Array.isArray(data.headlineQualification.targetTitles) || !data.headlineQualification.targetTitles.length || data.headlineQualification.targetTitles.length > 30)
            throw new Error('Use from 1 to 30 target job titles.');
        data.headlineQualification.targetTitles.forEach(title => text(title, 'Target job title', 100));
    }
    const scanMethods = ['', 'NOT_RUN', 'FOUND', 'NOT_FOUND', 'RENDERED_BROWSER', 'HTTP_FALLBACK', 'BLOCKED', 'FAILED', 'ERROR'];
    if (!data.websiteScan || !scanMethods.includes(data.websiteScan.method))
        throw new Error('Website scan method is invalid.');
    if (!Array.isArray(data.websiteScan.pages) || data.websiteScan.pages.length > 20)
        throw new Error('Use up to 20 website scan pages.');
    data.websiteScan.pages.forEach((page) => url(page, 'Scanned page URL'));
    text(data.websiteScan.challenge, 'Website challenge', 1000);
    date(data.websiteScan.completedAt, 'Website scan completion date');
    for (const key of [
        'name',
        'headline',
        'location',
        'warmthEvidence',
        'whyContact',
        'mainWeakness',
        'outreachAngle',
        'suggestedDm',
        'recommendedNextAction',
        'nextAction',
        'notes',
    ] as const)
        text(data[key], key);
    date(data.nextActionDueAt, 'Next action due date');
    date(data.lastContactedAt, 'Last contacted date');
    for (const [key, value] of Object.entries(data.scores)) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100)
            throw new Error(`${key} must be a score from 0 to 100.`);
    }
    if (!Array.isArray(data.observations) || data.observations.length > 25)
        throw new Error('Use up to 25 funnel observations.');
    for (const observation of data.observations) {
        text(observation.id, 'Observation id', 100);
        text(observation.label, 'Observation label', 500);
        text(observation.evidence, 'Observation evidence', 5000);
        url(observation.url, 'Observation URL');
        if (!Number.isFinite(observation.severity) || observation.severity < 0 || observation.severity > 25)
            throw new Error('Observation severity must be from 0 to 25.');
    }
    const delivery = data.delivery;
    if (!delivery || !Array.isArray(delivery.strongestLeaks) || delivery.strongestLeaks.length !== 3)
        throw new Error('Record exactly three strongest funnel leaks.');
    delivery.strongestLeaks.forEach((item, index) => text(item, `Leak ${index + 1}`, 10000));
    url(delivery.auditUrl, 'Audit URL');
    date(delivery.discoveryCallAt, 'Discovery call date');
    url(delivery.caseStudyUrl, 'Case study URL');
    for (const [label, values] of [
        ['Before screenshot', delivery.beforeScreenshots],
        ['After screenshot', delivery.afterScreenshots],
    ] as const) {
        if (!Array.isArray(values) || values.length > 100) throw new Error(`Use up to 100 ${label.toLowerCase()} URLs.`);
        values.forEach((value) => url(value, label));
    }
    for (const key of ['oldCopy', 'newCopy', 'rationale', 'metrics', 'testimonial'] as const)
        text(delivery[key], key, 200000);
    if (data.stage === 'AUDIT_SENT' && !delivery.auditUrl)
        throw new Error('Add the Loom or audit URL before marking the audit sent.');
    if (data.stage === 'CALL_BOOKED' && !delivery.discoveryCallAt)
        throw new Error('Add the discovery call date before marking the call booked.');
}
