'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { NOW, research, prospect } = require('./fixtures.cjs');
const { assessProspect, emptyFact } = require('../../src/lib/prospect-qualification.cjs');
const { planLead, summary } = require('../../scripts/reclassify-engine-results.cjs');

test('recovery promotes saved core fit with unknown proof and funnel findings without changing other CRM fields', () => {
    const r = research();
    r.facts.clientProof = emptyFact(); r.facts.funnelOpportunity = emptyFact();
    const row = prospect('saved-coach', { pipeline_status: 'REVIEW', prospect_assessment: assessProspect(r, { now: NOW }), contacted: true, do_not_contact: true });
    const original = JSON.stringify(row);
    const result = planLead(row, () => false, NOW);
    assert.equal(result.stage, 'QUALIFIED'); assert.equal(result.assessment.tier, 'A');
    assert.equal(result.assessment.contact.channel, 'EMAIL_NEEDS_VERIFICATION');
    assert.equal(JSON.stringify(row), original);
    assert.equal(summary([result], [row], NOW).stagesChanged, 1);
});

test('recovery retains advisory business reviews while respecting explicit email ownership revocation', () => {
    const r = research(); r.facts.targetMarket = emptyFact();
    const missing = planLead(prospect('missing', { pipeline_status: 'REVIEW', prospect_assessment: assessProspect(r, { now: NOW }) }), () => true, NOW);
    assert.equal(missing.stage, 'QUALIFIED'); assert.equal(missing.assessment.tier, 'B');
    const reviewed = planLead(prospect('reviewed', { pipeline_status: 'REVIEW', prospect_review: { reviewedAt: NOW, facts: { independentBusiness: { state: 'NEGATIVE', note: 'The coach confirmed that they work exclusively inside their employer.' } } } }), () => true, NOW);
    assert.equal(reviewed.stage, 'QUALIFIED'); assert.equal(reviewed.assessment.businessFit, 'OUTSIDE_ICP');
    const revoked = planLead(prospect('revoked', { pipeline_status: 'QUALIFIED', prospect_review: { reviewedAt: NOW, contactEmail: 'ava@avamorgan.test', contactOwnership: 'UNCONFIRMED', note: 'Ava confirmed this mailbox belongs to a different person.' } }), () => true, NOW);
    assert.equal(revoked.stage, 'NOT_QUALIFIED'); assert.equal(revoked.assessment.contact.ownership, 'UNCONFIRMED');
});

test('recovery ignores unresearched records and preserves stages managed outside the engine', () => {
    assert.equal(planLead(prospect('legacy', { prospect_assessment: null }), () => true, NOW), null);
    assert.equal(planLead(prospect('managed', { pipeline_status: 'OUTREACH' }), () => true, NOW).stage, 'OUTREACH');
});
