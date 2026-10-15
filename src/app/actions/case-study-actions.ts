'use server';

import fs from 'node:fs';
import path from 'node:path';
import {
    canonicalLinkedinUrl,
    CASE_STUDY_STAGES,
    CASE_STUDY_STAGE_LABELS,
    MAX_SOURCE_SCAN_PROFILES,
    transitionCaseStudyProspect,
    WARMTH_SOURCES,
    HUNTER_MODES,
    type CaseStudyProspectData,
    type HunterMode,
    type WarmthSource,
} from '@/lib/case-study';
import {
    caseStudyTransaction,
    findExistingCaseStudyLinkedinUrls,
    mapCaseStudyProspect,
    readCaseStudySnapshot,
    recordCaseStudyActivity,
    upsertQueuedCaseStudyProspect,
} from '@/lib/case-study-store';
import { validateCaseStudyProspect } from '@/lib/case-study-validation';
import { resolveCaseStudyPostUrl } from '@/lib/case-study-post-url';
import { DEFAULT_TARGET_TITLES, isMissedCoachCandidate } from '@/lib/case-study-qualification.cjs';
import { ensureDmColumn, stampLinkedinDmForLead, syncCrmOutreachSuppression } from '@/lib/linkedin-outreach-store';

const QUEUE_DIR = path.join(process.cwd(), 'case-study-queue');
const DATA_DIR = path.join(process.cwd(), 'data');
const RESULTS_DIR = path.join(process.cwd(), 'case-study-results');
const SOURCE_SCAN_LOCK = path.join(QUEUE_DIR, '.source-scan.lock');
const WORKER_CONTROL_FILE = path.join(DATA_DIR, 'case-study-worker-control.json');
function validateTargetTitles(values: string[] | undefined) {
    const titles = (Array.isArray(values) ? values : DEFAULT_TARGET_TITLES)
        .map((value) => String(value || '').trim())
        .filter(Boolean);
    if (!titles.length || titles.length > 30) throw new Error('Add from 1 to 30 target job titles.');
    if (titles.some((title) => title.length > 100)) throw new Error('Each target job title must be at most 100 characters.');
    return [...new Set(titles)];
}

function hasSourceScanJob() {
    if (!fs.existsSync(QUEUE_DIR)) return false;
    return fs.readdirSync(QUEUE_DIR).some((name) => {
        if (!name.endsWith('.json') && !name.endsWith('.processing')) return false;
        try {
            return JSON.parse(fs.readFileSync(path.join(QUEUE_DIR, name), 'utf8')).type === 'SOURCE_SCAN';
        } catch {
            return false;
        }
    });
}

function hasFreshActiveSourceScan() {
    const statusPath = path.join(RESULTS_DIR, 'worker-status.json');
    try {
        const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
        const updatedAt = Date.parse(String(status.updatedAt || ''));
        return status.activeJobType === 'SOURCE_SCAN' &&
            status.status === 'WORKING' &&
            Number.isFinite(updatedAt) &&
            Date.now() - updatedAt < 45_000;
    } catch {
        return false;
    }
}

function acquireSourceScanLock() {
    fs.mkdirSync(QUEUE_DIR, { recursive: true });
    if (hasSourceScanJob() || hasFreshActiveSourceScan()) {
        throw new Error('A LinkedIn source scan is already queued or running.');
    }
    if (fs.existsSync(SOURCE_SCAN_LOCK)) {
        const age = Date.now() - fs.statSync(SOURCE_SCAN_LOCK).mtimeMs;
        if (age < 15 * 60_000) throw new Error('A LinkedIn source scan is already being submitted.');
        fs.unlinkSync(SOURCE_SCAN_LOCK);
    }
    try {
        const descriptor = fs.openSync(SOURCE_SCAN_LOCK, 'wx');
        fs.writeFileSync(descriptor, JSON.stringify({ createdAt: new Date().toISOString() }));
        fs.closeSync(descriptor);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new Error('A LinkedIn source scan is already being submitted.');
        }
        throw error;
    }
}

function releaseSourceScanLock() {
    try { fs.unlinkSync(SOURCE_SCAN_LOCK); } catch { /* already released */ }
}

export async function loadCaseStudyAction() {
    return readCaseStudySnapshot();
}

export async function queueCaseStudyProspectsAction(input: {
    urls: string[];
    source: WarmthSource;
    mode: HunterMode;
    warmthEvidence: string;
    targetTitles?: string[];
}) {
    if (!WARMTH_SOURCES.includes(input.source)) throw new Error('Choose a valid warmth source.');
    if (!HUNTER_MODES.includes(input.mode)) throw new Error('Choose a valid hunter mode.');
    if (typeof input.warmthEvidence !== 'string' || input.warmthEvidence.length > 5000)
        throw new Error('Warmth evidence must be at most 5,000 characters.');
    const urls = [...new Set(input.urls.map(canonicalLinkedinUrl))];
    const targetTitles = validateTargetTitles(input.targetTitles);
    if (!urls.length) throw new Error('Add at least one LinkedIn profile URL.');
    if (urls.length > 100) throw new Error('Queue up to 100 profiles at a time.');
    fs.mkdirSync(QUEUE_DIR, { recursive: true });

    const existingUrls = await findExistingCaseStudyLinkedinUrls(urls);
    const existingKeys = new Set(existingUrls.map((value) => value.toLowerCase().replace(/\/+$/, '')));
    const newUrls = urls.filter((value) => !existingKeys.has(value.toLowerCase().replace(/\/+$/, '')));

    const queued = await caseStudyTransaction(async (client) => {
        const queued: { jobId: string; prospectId: string; linkedinUrl: string }[] = [];
        for (const linkedinUrl of newUrls) {
            const prospect = await upsertQueuedCaseStudyProspect(
                client,
                linkedinUrl,
                input.source,
                input.mode,
                input.warmthEvidence.trim(),
            );
            const jobId = `case_study_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
            const jobPath = path.join(QUEUE_DIR, `${jobId}.json`);
            const tempPath = `${jobPath}.tmp`;
            fs.writeFileSync(
                tempPath,
                JSON.stringify({
                    jobId,
                    type: 'PROFILE',
                    prospectId: prospect.id,
                    linkedinUrl,
                    source: input.source,
                    mode: input.mode,
                    warmthEvidence: input.warmthEvidence.trim(),
                    targetTitles,
                    createdAt: new Date().toISOString(),
                }),
            );
            fs.renameSync(tempPath, jobPath);
            queued.push({ jobId, prospectId: prospect.id, linkedinUrl });
        }
        return queued;
    });
    return { queued, skipped: urls.filter((value) => existingKeys.has(value.toLowerCase().replace(/\/+$/, ''))) };
}

export async function queueCaseStudySourceScanAction(input: {
    source: WarmthSource;
    mode: HunterMode;
    warmthEvidence: string;
    sourcePageUrl?: string;
    targetTitles?: string[];
    limit?: number;
}) {
    const scannable: WarmthSource[] = ['CONNECTION', 'FOLLOWER', 'PROFILE_VIEWER', 'ENGAGER'];
    if (!scannable.includes(input.source))
        throw new Error('Automatic source scans support connections, followers, engagers, and profile viewers.');
    if (!HUNTER_MODES.includes(input.mode)) throw new Error('Choose a valid hunter mode.');
    if (typeof input.warmthEvidence !== 'string' || input.warmthEvidence.length > 5000)
        throw new Error('Warmth evidence must be at most 5,000 characters.');
    const targetTitles = validateTargetTitles(input.targetTitles);
    const limit = Number(input.limit ?? 25);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SOURCE_SCAN_PROFILES) {
        throw new Error(`Visible profiles to collect must be a whole number between 1 and ${MAX_SOURCE_SCAN_PROFILES}.`);
    }
    let sourcePageUrl = String(input.sourcePageUrl || '').trim();
    if (input.source === 'ENGAGER') {
        if (!sourcePageUrl) throw new Error('Paste the LinkedIn post URL whose engagers you want to scan.');
        sourcePageUrl = await resolveCaseStudyPostUrl(sourcePageUrl);
    }
    acquireSourceScanLock();
    const jobId = `case_study_source_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const jobPath = path.join(QUEUE_DIR, `${jobId}.json`);
    const tempPath = `${jobPath}.tmp`;
    try {
        fs.writeFileSync(
            tempPath,
            JSON.stringify({
                type: 'SOURCE_SCAN',
                jobId,
                source: input.source,
                mode: input.mode,
                warmthEvidence: input.warmthEvidence.trim(),
                sourcePageUrl,
                targetTitles,
                limit,
                createdAt: new Date().toISOString(),
            }),
        );
        fs.renameSync(tempPath, jobPath);
    } catch (error) {
        releaseSourceScanLock();
        try { fs.unlinkSync(tempPath); } catch { /* best effort */ }
        throw error;
    }
    return { jobId };
}

export async function stopCaseStudyRunAction() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(QUEUE_DIR, { recursive: true });
    const tempPath = `${WORKER_CONTROL_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify({ action: 'STOP_CURRENT_RUN', requestedAt: new Date().toISOString() }));
    fs.renameSync(tempPath, WORKER_CONTROL_FILE);
    const removedJobs: string[] = [];
    for (const name of fs.readdirSync(QUEUE_DIR)) {
        if (!name.endsWith('.json')) continue;
        try {
            fs.unlinkSync(path.join(QUEUE_DIR, name));
            removedJobs.push(name);
        } catch { /* a worker may have claimed it between listing and removal */ }
    }
    releaseSourceScanLock();
    const hasClaimedJob = fs.readdirSync(QUEUE_DIR).some((name) => name.endsWith('.processing'));
    const statusPath = path.join(RESULTS_DIR, 'worker-status.json');
    let workerIsActive = false;
    try {
        const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
        const updatedAt = Date.parse(String(status.updatedAt || ''));
        workerIsActive = status.status === 'WORKING' && Number.isFinite(updatedAt) && Date.now() - updatedAt < 45_000;
    } catch { /* an offline worker has nothing active to cancel */ }
    if (!hasClaimedJob && !workerIsActive) {
        try { fs.unlinkSync(WORKER_CONTROL_FILE); } catch { /* already consumed */ }
    }
    return { removed: removedJobs.length, stoppingActiveJob: hasClaimedJob || workerIsActive };
}

/** Explicit operator retry. This is the only path that intentionally bypasses the duplicate gate. */
export async function retryCaseStudyProspectAction(id: string, options: { targetTitles?: string[]; onlyMissedCoach?: boolean; expectedMode?: HunterMode } = {}) {
    fs.mkdirSync(QUEUE_DIR, { recursive: true });
    return caseStudyTransaction(async (client) => {
        const existing = await client.query('SELECT * FROM case_study_prospects WHERE id=$1 FOR UPDATE', [id]);
        if (!existing.rows[0]) throw new Error('Case-study prospect not found.');
        const data = existing.rows[0].data as CaseStudyProspectData;
        const targetTitles = validateTargetTitles(options.targetTitles ?? data.headlineQualification.targetTitles);
        if (options.onlyMissedCoach && (!isMissedCoachCandidate(data, targetTitles)
            || (options.expectedMode && data.mode !== options.expectedMode))) return { jobId: '', skipped: true };
        if (data.stage === 'DO_NOT_CONTACT') throw new Error('This prospect is marked Don’t contact. Remove that stage before scanning.');
        const linkedinUrl = canonicalLinkedinUrl(data.linkedinUrl);
        const jobId = `case_study_retry_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        const jobPath = path.join(QUEUE_DIR, `${jobId}.json`);
        const tempPath = `${jobPath}.tmp`;
        const malformedWebsite = /^https?:\/\/scale_\d+_\d+\//i.test(data.website || '');
        const queuedData: CaseStudyProspectData = {
            ...data,
            website: malformedWebsite ? '' : data.website,
            scanStatus: 'QUEUED',
            nextAction: 'Retry headline qualification and website discovery',
        };
        await client.query(
            'UPDATE case_study_prospects SET data=$2,revision=revision+1,updated_at=NOW() WHERE id=$1',
            [id, JSON.stringify(queuedData)],
        );
        await recordCaseStudyActivity(client, id, 'SCAN_RETRY', 'Headline qualification and website discovery queued for an explicit retry');
        fs.writeFileSync(tempPath, JSON.stringify({
            jobId,
            type: 'PROFILE',
            prospectId: id,
            linkedinUrl,
            source: data.source,
            mode: data.mode,
            warmthEvidence: data.warmthEvidence,
            targetTitles,
            createdAt: new Date().toISOString(),
            explicitRetry: true,
        }));
        fs.renameSync(tempPath, jobPath);
        return { jobId };
    });
}

/** Recovery reuses existing rows and rechecks eligibility under the row lock. */
export async function queueMissedCoachProfilesAction(input: { mode: HunterMode; targetTitles?: string[] }) {
    if (!HUNTER_MODES.includes(input.mode)) throw new Error('Choose a valid hunter mode.');
    const targetTitles = validateTargetTitles(input.targetTitles);
    const snapshot = await readCaseStudySnapshot();
    const candidates = snapshot.prospects.filter(prospect => prospect.data.mode === input.mode
        && isMissedCoachCandidate(prospect.data, targetTitles));
    const jobIds: string[] = [];
    for (const prospect of candidates.slice(0, MAX_SOURCE_SCAN_PROFILES)) {
        const result = await retryCaseStudyProspectAction(prospect.id, { targetTitles, onlyMissedCoach: true, expectedMode: input.mode });
        if (result.jobId) jobIds.push(result.jobId);
    }
    return { queued: jobIds.length, jobIds, remaining: Math.max(0, candidates.length - MAX_SOURCE_SCAN_PROFILES) };
}

export async function saveCaseStudyProspectAction(
    id: string,
    draft: CaseStudyProspectData,
    expectedRevision: number,
) {
    if (draft.stage === 'MESSAGED' && draft.crmLeadId) await ensureDmColumn();
    return caseStudyTransaction(async (client) => {
        const existing = await client.query('SELECT * FROM case_study_prospects WHERE id=$1 FOR UPDATE', [id]);
        if (!existing.rows[0]) throw new Error('Case-study prospect not found.');
        if (existing.rows[0].revision !== expectedRevision)
            throw new Error('This prospect changed in another window. Reload before saving.');
        const old = existing.rows[0].data as CaseStudyProspectData;
        if (old.stage === 'MESSAGED' && old.lastContactedAt && ['FOUND', 'QUALIFIED'].includes(draft.stage))
            throw new Error('Use Undo DM to correct a sent-message mark before changing this stage.');
        if (old.stage === 'DO_NOT_CONTACT' && old.lastContactedAt && ['FOUND', 'QUALIFIED'].includes(draft.stage))
            throw new Error('This lead was already contacted. Restore its prior contacted stage instead.');
        const linkedDraft = { ...draft, crmLeadId: old.crmLeadId, crmHook: old.crmHook,
            doNotContactPreviousStage: old.doNotContactPreviousStage, outreachSuppressedLead: old.outreachSuppressedLead };
        let data =
            old.stage === draft.stage
                ? linkedDraft
                : transitionCaseStudyProspect({ ...linkedDraft, stage: old.stage }, draft.stage);
        data = await syncCrmOutreachSuppression(client, old, data);
        validateCaseStudyProspect(data);
        const result = await client.query(
            `UPDATE case_study_prospects
             SET linkedin_url=$2,data=$3,revision=revision+1,updated_at=NOW()
             WHERE id=$1 RETURNING *`,
            [id, canonicalLinkedinUrl(data.linkedinUrl), JSON.stringify(data)],
        );
        const activity = await recordCaseStudyActivity(
            client,
            id,
            old.stage === data.stage ? 'UPDATED' : 'STAGE',
            old.stage === data.stage
                ? 'Prospect details updated'
                : `${CASE_STUDY_STAGE_LABELS[old.stage]} → ${CASE_STUDY_STAGE_LABELS[data.stage]}`,
        );
        if (data.stage === 'MESSAGED' && data.crmLeadId &&
            (CASE_STUDY_STAGES.indexOf(old.stage) < CASE_STUDY_STAGES.indexOf('MESSAGED') ||
                (old.stage === 'DO_NOT_CONTACT' && !old.lastContactedAt))) {
            await stampLinkedinDmForLead(client, data.crmLeadId);
            await recordCaseStudyActivity(client, id, 'LINKEDIN_DM_SENT', 'LinkedIn DM marked sent from the Hunter; Lead CRM updated');
        }
        return { ...mapCaseStudyProspect(result.rows[0]), activity };
    });
}

export async function addCaseStudyNoteAction(id: string, note: string) {
    if (typeof note !== 'string' || !note.trim() || note.length > 20000)
        throw new Error('Enter a note of up to 20,000 characters.');
    await caseStudyTransaction(async (client) => {
        const prospect = await client.query('SELECT id FROM case_study_prospects WHERE id=$1', [id]);
        if (!prospect.rows[0]) throw new Error('Case-study prospect not found.');
        await recordCaseStudyActivity(client, id, 'NOTE', note.trim());
    });
}
