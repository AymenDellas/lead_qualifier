'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { research, NOW } = require('./fixtures.cjs');
const q = require('../../src/lib/prospect-qualification.cjs');
const { createResearchRunner } = require('../../src/lib/worker-research-runner.cjs');

function fixture(value, overrides = {}) {
    const completed = [], checkpoints = [], deferred = [], saves = [], reads = [];
    let existingQualified = true;
    const pool = { query: async sql => ({ rows: [], rowCount: sql.includes('SELECT id FROM leads') && existingQualified ? 1 : 0 }) };
    const core = {
        complete: async (_pool, id, owner, result) => { assert.equal(owner, 'fixture-owner'); completed.push({ id, result }); },
        checkpoint: async (_pool, id, owner, result) => checkpoints.push({ id, owner, result }),
        defer: async (_pool, id, owner, result, retryAt) => deferred.push({ id, owner, result, retryAt }),
    };
    const runner = createResearchRunner({
        pool, owner: 'fixture-owner', core, now: () => Date.parse(NOW),
        researchProspect: async (input, options) => { reads.push({ input, options }); return structuredClone(value); },
        assessProspect: (input, options) => q.assessProspect(input, { ...options, now: NOW }),
        saveWorkerResearch: async (_pool, input) => {
            saves.push(input);
            const assessment = q.assessProspect(input.research, { email: input.email, now: NOW });
            return { id: 'saved-lead', assessment, pipelineStatus: q.pipelineForAssessment(assessment) };
        },
        launch: async () => assert.fail('HTTP-only enrichment must not open any browser.'),
        finishProspecting: async () => assert.fail('Ordinary qualification must not use prospecting outcomes.'),
        ...overrides,
    });
    function job(extra = {}) {
        return { jobId: 'fixture', resumeResult: {
            url: value.linkedinUrl, firstName: 'Ava', profileIdentityConfirmed: true,
            linkedinCapture: { version: 2, complete: true }, emails: [], logs: [],
        }, ...extra };
    }
    return { runner, job, completed, checkpoints, deferred, saves, reads, set existingQualified(value) { existingQualified = value; } };
}

test('enrichment retains business fit but rejects qualification when no email is found', async () => {
    const r = research({ contacts: [], lastActivityAt: '2024-01-01T12:00:00.000Z' }), f = fixture(r);
    const { result } = await f.runner.process(f.job());
    assert.equal(result.status, 'REJECTED'); assert.equal(result.primaryEmail, '');
    assert.equal(result.prospectQualification.tier, 'A');
    assert.equal(f.reads[0].input.linkedinUrl, r.linkedinUrl.replace(/\/$/, '') + '/');
    assert.equal(result.prospectQualification.contact.channel, 'LINKEDIN_ONLY');
    assert.equal(f.completed.length, 1); assert.equal(f.deferred.length, 0);
});

test('email/activity qualification has no AI or business gates and retains undated activity for review', async () => {
    for (const unknown of [false, true]) {
        const r = research({ facts: Object.fromEntries(q.FACT_KEYS.map(key => [key, q.emptyFact()])), segments: [], lastActivityAt: unknown ? null : NOW, activityStatus: unknown ? 'Unknown' : 'Active' });
        const f = fixture(r), { result } = await f.runner.process(f.job());
        assert.equal(f.reads[0].options.ai, false); assert.equal(result.status, unknown ? 'REVIEW' : 'QUALIFIED');
        if (unknown) { assert.equal(result.failure.stage, 'qualification'); assert.equal(result.failure.retryable, false); }
        assert.equal(f.completed.length, 1); assert.equal(f.deferred.length, 0);
    }
});

test('public enrichment never schedules another LinkedIn request for uncertain activity', async () => {
    const r = research({ lastActivityAt: null, activityStatus: 'Unknown' });
    for (const [httpStatus, retryable, retryCount] of [[200, false, 0], [0, true, 0], [503, true, 0], [503, true, 1]]) {
        const f = fixture(r), job = f.job({ retryCount }); job.resumeResult.activityCheck = { httpStatus, retryable };
        const { result, deferred } = await f.runner.process(job);
        assert.equal(result.status, 'REVIEW'); assert.equal(result.failure.code, 'ACTIVITY_UNCONFIRMED');
        assert.equal(result.failure.retryable, false); assert.equal(deferred, false);
        assert.equal(f.completed.length, 1); assert.equal(f.checkpoints.length, 0);
    }
});

test('the final saved-profile pass stops automatic website research even if routes remain', async () => {
    for (const emailFound of [false, true]) {
        const r = research({ ...(emailFound ? {} : { contacts: [] }) });
        r.crawl = { version: 2, complete: false, retryable: true, maxRoutes: 600, attempted: [], visited: [], pending: ['https://avamorgan.test/actual-route'], failed: [], roots: ['https://avamorgan.test/'], matchedHosts: ['avamorgan.test'], candidates: [], stoppedReason: 'Pass budget reached', inspected: 0 };
        const f = fixture(r), { result, deferred } = await f.runner.process(f.job({ retryCount: 3 }));
        assert.equal(result.status, emailFound ? 'QUALIFIED' : 'REVIEW'); assert.equal(deferred, false);
        assert.equal(result.prospectQualification.research.crawl.retryable, false);
        assert.match(result.prospectQualification.research.crawl.stoppedReason, /retries exhausted/);
        assert.deepEqual(result.prospectQualification.research.crawl.pending, r.crawl.pending);
        if (!emailFound) assert.equal(result.failure.retryable, false);
    }
});

test('native CRM persistence sends evidence and applies the saved qualification without hooks or sales outcomes', async () => {
    const savedAssessment = q.assessProspect(research({ contacts: [] }), { now: NOW });
    let payload;
    const f = fixture(research(), { saveWorkerResearch: async (_pool, input) => { payload = input; return { id: 'saved', pipelineStatus: 'NOT_QUALIFIED', assessment: savedAssessment }; } });
    const { result } = await f.runner.process(f.job({ nativePostProcess: true }));
    assert.equal(payload.research.version, 1); assert.equal(payload.owner, 'fixture-owner'); assert.equal(payload.jobId, 'fixture');
    assert.equal(payload.hook, undefined); assert.equal(payload.outcome, undefined);
    assert.equal(result.crmSaved, true); assert.equal(result.crmLeadId, 'saved');
    assert.equal(result.status, 'REJECTED'); assert.equal(result.primaryEmail, '');
});

test('a failed CRM save checkpoints complete research and defers recovery without reporting success', async () => {
    let attempts = 0;
    const f = fixture(research(), { saveWorkerResearch: async () => { attempts++; throw Error('CRM unavailable'); } });
    const { result, deferred } = await f.runner.process(f.job({ nativePostProcess: true }));
    assert.equal(attempts, 1); assert.equal(result.crmSaved, false); assert.equal(result.failure.stage, 'crm');
    assert.equal(deferred, true); assert.equal(f.completed.length, 0); assert.equal(f.checkpoints.length, 1); assert.equal(f.deferred.length, 1);
    assert.equal(f.checkpoints[0].result.prospectQualification.research.version, 1);
    assert.equal(f.checkpoints[0].result.linkedinCapture.complete, true);
    assert.equal(f.deferred[0].retryAt, new Date(Date.parse(NOW)).toISOString());
});

test('a published LinkedIn address takes priority over a shared website inbox', async () => {
    const r = research({ contacts: [{ address: 'hello@practice.test', url: 'https://practice.test/', source: 'website', ownership: 'DOMAIN_MATCH' }, { address: 'ava@direct.test', url: research().linkedinUrl, source: 'linkedin', ownership: 'PUBLISHED' }] });
    const f = fixture(r), { result } = await f.runner.process(f.job());
    assert.equal(result.primaryEmail, 'ava@direct.test'); assert.equal(result.emailSource, 'linkedin'); assert.equal(result.status, 'QUALIFIED');
});

test('an unresolved recheck withdraws stale CRM qualification while retaining the error and saved evidence', async () => {
    const f = fixture(research({ lastActivityAt: null, activityStatus: 'Unknown' }));
    const { result } = await f.runner.process(f.job({ nativePostProcess: true }));
    assert.equal(f.saves.length, 1); assert.equal(result.status, 'REVIEW'); assert.equal(result.failure.code, 'ACTIVITY_UNCONFIRMED');
    assert.equal(result.failure.retryable, false); assert.equal(result.crmSaved, true);
    assert.equal(result.prospectQualification.research.profileIdentityConfirmed, true);
    f.existingQualified = false;
    const second = await f.runner.process(f.job({ nativePostProcess: true }));
    assert.equal(f.saves.length, 2); assert.equal(second.result.crmSaved, true);
    assert.equal(second.result.status, 'REVIEW');
});
