'use strict';
const assert = require('node:assert/strict'), { test } = require('node:test');
const q = require('../../src/lib/prospect-qualification.cjs');
const { research } = require('./fixtures.cjs');
const now = new Date().toISOString();
const assess = overrides => q.assessProspect(research({ researchedAt: now, lastActivityAt: now, ...overrides }), { email: 'ava@avamorgan.test', now });

test('email plus recent activity qualifies even when all business facts, segment and market are unknown or negative', () => {
    const facts = Object.fromEntries(q.FACT_KEYS.map(key => [key, q.emptyFact()]));
    for (const state of ['UNKNOWN', 'NEGATIVE']) {
        const r = research({ researchedAt: now, lastActivityAt: now, segments: [], segment: 'UNKNOWN', profileLocation: '', facts: state === 'UNKNOWN' ? facts : research().facts });
        if (state === 'NEGATIVE') for (const fact of Object.values(r.facts)) if (fact.evidence.length) fact.state = 'NEGATIVE';
        const a = q.assessProspect(r, { email: 'ava@avamorgan.test', now });
        assert.equal(a.qualification.qualified, true); assert.equal(a.blockers.length, 0);
        assert.equal(q.pipelineForAssessment(a), 'QUALIFIED');
    }
});
test('missing, guessed or placeholder emails never qualify an active profile', () => {
    for (const email of ['', 'example@email.com', 'asset@2x.png', 'ava@avamorgan.test']) {
        const a = q.assessProspect(research({ researchedAt: now, lastActivityAt: now, contacts: [] }), { email, now });
        assert.equal(a.qualification.qualified, false); assert.equal(q.pipelineForAssessment(a), 'NOT_QUALIFIED');
    }
});
test('dated old activity is rejected; undated, unconfirmed or future activity requires review', () => {
    for (const [lastActivityAt, activityStatus, expected] of [[new Date(Date.now()-31*86400000).toISOString(),'Inactive','INACTIVE'],[null,'Inactive','UNKNOWN'],[null,'Unknown','UNKNOWN'],[new Date(Date.now()+86400000).toISOString(),'Active','UNKNOWN']]) {
        const a = assess({ lastActivityAt, activityStatus });
        assert.equal(a.qualification.activity, expected); assert.equal(a.qualification.needsRetry, expected === 'UNKNOWN');
        assert.equal(q.pipelineForAssessment(a), expected === 'UNKNOWN' ? 'REVIEW' : 'NOT_QUALIFIED');
    }
});
test('saved old-policy assessments use actual activity and contact evidence instead of business tiers', () => {
    const a = assess({}); delete a.qualification; a.tier = 'OUTSIDE_ICP'; a.businessFit = 'OUTSIDE_ICP';
    assert.equal(q.hasAttributableEmail(a), true);
    a.research.lastActivityAt = '2024-01-01T12:00:00Z';
    assert.equal(q.hasAttributableEmail(a), false);
});
