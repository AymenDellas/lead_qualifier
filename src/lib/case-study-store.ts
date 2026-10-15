import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from './pg_setup';
import { syncHunterContacted } from './hunter-contact-sync';
import {
    blankCaseStudyProspect,
    type CaseStudyActivity,
    type CaseStudyProspect,
    type CaseStudyProspectData,
    type CaseStudySnapshot,
    type HunterMode,
    type WarmthSource,
} from './case-study';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS case_study_prospects (
    id UUID PRIMARY KEY,
    linkedin_url TEXT NOT NULL UNIQUE,
    revision INTEGER NOT NULL DEFAULT 0,
    data JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS case_study_activities (
    id UUID PRIMARY KEY,
    prospect_id UUID NOT NULL REFERENCES case_study_prospects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    note TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS case_study_prospect_stage ON case_study_prospects((data->>'stage'));
CREATE INDEX IF NOT EXISTS case_study_activity_prospect ON case_study_activities(prospect_id, created_at DESC);
`;

let schemaReady: Promise<void> | undefined;
export function ensureCaseStudySchema(): Promise<void> {
    if (!schemaReady)
        schemaReady = (async () => {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query('SELECT pg_advisory_xact_lock(83472111)');
                await client.query(SCHEMA);
                await client.query('COMMIT');
            } catch (error) {
                await client.query('ROLLBACK');
                throw error;
            } finally {
                client.release();
            }
        })().catch((error) => {
            schemaReady = undefined;
            throw error;
        });
    return schemaReady;
}

export async function caseStudyTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    await ensureCaseStudySchema();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

const iso = (value: Date | string) => new Date(value).toISOString();
function normalizeCaseStudyData(data: Partial<CaseStudyProspectData> | undefined, linkedinUrl = ''): CaseStudyProspectData {
    const blank = blankCaseStudyProspect(linkedinUrl);
    return {
        ...blank,
        ...(data || {}),
        scores: { ...blank.scores, ...(data?.scores || {}) },
        headlineQualification: {
            ...blank.headlineQualification,
            ...(data?.headlineQualification || {}),
        },
        websiteScan: { ...blank.websiteScan, ...(data?.websiteScan || {}) },
        delivery: { ...blank.delivery, ...(data?.delivery || {}) },
    };
}
export const mapCaseStudyProspect = (row: any): CaseStudyProspect => ({
    id: row.id,
    revision: row.revision,
    data: normalizeCaseStudyData(row.data, row.linkedin_url),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
});
export const mapCaseStudyActivity = (row: any): CaseStudyActivity => ({
    id: row.id,
    prospectId: row.prospect_id,
    kind: row.kind,
    note: row.note,
    createdAt: iso(row.created_at),
});

export async function recordCaseStudyActivity(
    client: PoolClient,
    prospectId: string,
    kind: string,
    note: string,
) {
    const inserted = await client.query(
        'INSERT INTO case_study_activities(id,prospect_id,kind,note) VALUES($1,$2,$3,$4) RETURNING *',
        [randomUUID(), prospectId, kind, note],
    );
    return mapCaseStudyActivity(inserted.rows[0]);
}

export async function readCaseStudySnapshot(): Promise<CaseStudySnapshot> {
    return caseStudyTransaction(async (client) => {
        const prospects = await client.query(
            `SELECT * FROM case_study_prospects
             ORDER BY created_at DESC`,
        );
        const activities = await client.query(
            `SELECT * FROM (
                SELECT *, ROW_NUMBER() OVER(PARTITION BY prospect_id ORDER BY created_at DESC) AS rn
                FROM case_study_activities
             ) a WHERE rn <= 30 ORDER BY created_at DESC`,
        );
        return {
            prospects: prospects.rows.map(mapCaseStudyProspect),
            activities: activities.rows.map(mapCaseStudyActivity),
        };
    });
}

/** Returns the pipeline URLs already present, using a case-insensitive canonical comparison. */
export async function findExistingCaseStudyLinkedinUrls(urls: string[]): Promise<string[]> {
    if (!urls.length) return [];
    return caseStudyTransaction(async (client) => {
        const keys = [...new Set(urls.map((value) => value.toLowerCase().replace(/\/+$/, '')))];
        const result = await client.query(
            `SELECT linkedin_url FROM case_study_prospects
             WHERE LOWER(REGEXP_REPLACE(linkedin_url, '/+$', '')) = ANY($1::text[])`,
            [keys],
        );
        return result.rows.map((row) => String(row.linkedin_url));
    });
}

export async function upsertQueuedCaseStudyProspect(
    client: PoolClient,
    linkedinUrl: string,
    source: WarmthSource,
    mode: HunterMode,
    warmthEvidence: string,
) {
    const existing = await client.query(
        'SELECT * FROM case_study_prospects WHERE linkedin_url=$1 FOR UPDATE',
        [linkedinUrl],
    );
    if (existing.rows[0]) {
        const old = normalizeCaseStudyData(existing.rows[0].data, linkedinUrl);
        const data: CaseStudyProspectData = {
            ...old,
            source,
            mode,
            warmthEvidence: warmthEvidence || old.warmthEvidence,
            scanStatus: 'QUEUED',
            nextAction: 'Run headline qualification and website discovery',
        };
        const updated = await client.query(
            'UPDATE case_study_prospects SET data=$2,revision=revision+1,updated_at=NOW() WHERE id=$1 RETURNING *',
            [existing.rows[0].id, JSON.stringify(data)],
        );
        await recordCaseStudyActivity(client, existing.rows[0].id, 'QUEUED', 'Prospect queued for a fresh scan');
        await syncHunterContacted(client);
        return mapCaseStudyProspect(updated.rows[0]);
    }
    const id = randomUUID();
    const data = blankCaseStudyProspect(linkedinUrl, source, mode);
    data.warmthEvidence = warmthEvidence;
    const inserted = await client.query(
        'INSERT INTO case_study_prospects(id,linkedin_url,data) VALUES($1,$2,$3) RETURNING *',
        [id, linkedinUrl, JSON.stringify(data)],
    );
    await recordCaseStudyActivity(client, id, 'FOUND', `Found via ${source.toLowerCase().replaceAll('_', ' ')}`);
    await syncHunterContacted(client);
    return mapCaseStudyProspect(inserted.rows[0]);
}

function safeUrl(value: unknown) {
    if (typeof value !== 'string' || !value) return '';
    try {
        const parsed = new URL(value);
        return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
    } catch {
        return '';
    }
}

function safeWebsite(value: unknown) {
    const safe = safeUrl(value);
    if (!safe) return '';
    try {
        const host = new URL(safe).hostname.replace(/^www\./, '').toLowerCase();
        if (!host.includes('.') || host.includes('_') || /^scale_\d+_\d+$/i.test(host)) return '';
        return safe;
    } catch {
        return '';
    }
}

/** Called by the duplicated worker. Manual CRM/delivery fields always win over a re-scan. */
export async function upsertCaseStudyWorkerResult(job: any, result: any) {
    const linkedinUrl = String(result?.url || job?.linkedinUrl || '');
    if (!linkedinUrl.includes('linkedin.com/in/')) throw new Error('Worker result has no LinkedIn profile URL.');
    return caseStudyTransaction(async (client) => {
        const existing = await client.query(
            'SELECT * FROM case_study_prospects WHERE linkedin_url=$1 FOR UPDATE',
            [linkedinUrl],
        );
        const base: CaseStudyProspectData = existing.rows[0]
            ? normalizeCaseStudyData(existing.rows[0].data, linkedinUrl)
            : blankCaseStudyProspect(linkedinUrl, job.source || 'MANUAL', job.mode || 'CASE_STUDY');
        const assessment = result?.caseStudy || {};
        const websiteDiscoveryAttempted = Boolean(assessment.websiteScan?.method && assessment.websiteScan.method !== 'NOT_RUN');
        const scannedQualified = result?.status === 'QUALIFIED' && base.stage === 'FOUND';
        const selectedMode = job?.mode || base.mode;
        const data: CaseStudyProspectData = {
            ...base,
            name:
                [result?.firstName, result?.lastName].filter(Boolean).join(' ').trim() ||
                base.name,
            linkedinUrl,
            headline: String(result?.headline || base.headline || '').slice(0, 1000),
            location: String(result?.location || base.location || '').slice(0, 500),
            website: safeWebsite(result?.website || result?.websites?.[0]) || (websiteDiscoveryAttempted ? '' : safeWebsite(base.website)),
            email: String(result?.primaryEmail || result?.emails?.[0] || base.email || '').slice(0, 500),
            source: job?.source || base.source,
            warmthEvidence: String(job?.warmthEvidence || base.warmthEvidence || '').slice(0, 5000),
            mode: selectedMode,
            stage: scannedQualified ? 'QUALIFIED' : base.stage,
            scanStatus: result?.status === 'ERROR' ? 'ERROR' : 'COMPLETE',
            coachFit: ['YES', 'MAYBE', 'NO'].includes(assessment.coachFit) ? assessment.coachFit : 'MAYBE',
            headlineQualification: {
                qualified: Boolean(assessment.headlineQualification?.qualified),
                matches: Array.isArray(assessment.headlineQualification?.matches)
                    ? assessment.headlineQualification.matches.slice(0, 30).map((value: unknown) => String(value).slice(0, 100))
                    : base.headlineQualification.matches,
                reason: String(assessment.headlineQualification?.reason || base.headlineQualification.reason || '').slice(0, 5000),
                targetTitles: Array.isArray(job?.targetTitles)
                    ? job.targetTitles.slice(0, 30).map((value: unknown) => String(value).trim().slice(0, 100)).filter(Boolean)
                    : base.headlineQualification.targetTitles,
            },
            websiteScan: {
                method: ['', 'NOT_RUN', 'FOUND', 'NOT_FOUND', 'RENDERED_BROWSER', 'HTTP_FALLBACK', 'BLOCKED', 'FAILED', 'ERROR'].includes(assessment.websiteScan?.method)
                    ? assessment.websiteScan.method
                    : base.websiteScan.method,
                pages: Array.isArray(assessment.websiteScan?.pages)
                    ? assessment.websiteScan.pages.map(safeUrl).filter(Boolean).slice(0, 20)
                    : base.websiteScan.pages,
                challenge: String(assessment.websiteScan?.challenge || '').slice(0, 1000),
                completedAt: String(assessment.websiteScan?.completedAt || '').slice(0, 50),
            },
            // Keep the legacy fields empty for compatibility with saved records.
            scores: { ...blankCaseStudyProspect().scores },
            whyContact: String(assessment.headlineQualification?.reason || '').slice(0, 9000),
            mainWeakness: '',
            outreachAngle: '',
            suggestedDm: '',
            recommendedNextAction: String(assessment.recommendedNextAction || '').slice(0, 5000),
            observations: [],
            nextAction: base.stage === 'DO_NOT_CONTACT'
                ? 'Do not contact this prospect'
                : !['FOUND', 'QUALIFIED'].includes(base.stage)
                    ? base.nextAction
                    : result?.status === 'REJECTED_HEADLINE'
                        ? 'Keep out of the active queue'
                        : String(assessment.recommendedNextAction || 'Review the LinkedIn profile and website before outreach'),
            notes: base.notes,
            delivery: base.delivery,
        };
        let saved;
        if (existing.rows[0]) {
            const updated = await client.query(
                'UPDATE case_study_prospects SET data=$2,revision=revision+1,updated_at=NOW() WHERE id=$1 RETURNING *',
                [existing.rows[0].id, JSON.stringify(data)],
            );
            saved = updated.rows[0];
        } else {
            const inserted = await client.query(
                'INSERT INTO case_study_prospects(id,linkedin_url,data) VALUES($1,$2,$3) RETURNING *',
                [randomUUID(), linkedinUrl, JSON.stringify(data)],
            );
            saved = inserted.rows[0];
        }
        await recordCaseStudyActivity(
            client,
            saved.id,
            result?.status === 'ERROR' ? 'SCAN_ERROR' : result?.status === 'REJECTED_HEADLINE' ? 'HEADLINE_REJECTED' : 'PROFILE_QUALIFIED',
            result?.status === 'ERROR'
                ? 'Profile discovery failed; the prospect remains available for retry'
                : result?.status === 'REJECTED_HEADLINE'
                    ? data.headlineQualification.reason
                    : `${data.headlineQualification.reason} · ${data.website ? 'Website found: ' + data.website : 'No public website found'}`,

        );
        await syncHunterContacted(client);
        return mapCaseStudyProspect(saved);
    });
}
