'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { research, NOW } = require('./fixtures.cjs');
const q = require('../../src/lib/prospect-qualification.cjs');
require('tsx/cjs/api').register();
const { scoreDiscoveryResult } = require('../../src/lib/discovery-score.ts');

test('qualification requires a real independent coaching offer, confirmed profile and target market', () => {
    const r = research();
    assert.equal(q.assessProspect(r, { now: NOW }).tier, 'A');
    for (const key of ['independentBusiness', 'paidOffer', 'targetMarket']) {
        const next = research(); next.facts[key] = q.emptyFact();
        assert.notEqual(q.assessProspect(next, { now: NOW }).tier, 'A', key);
    }
});

test('testimonials, posting and funnel diagnosis improve rank without blocking outreach qualification', () => {
    const strong = research(), r = research();
    for (const key of ['clientProof', 'demandSignals', 'funnelOpportunity', 'marketingControl']) r.facts[key] = q.emptyFact();
    const a = q.assessProspect(r, { email: 'ava@avamorgan.test', now: NOW });
    assert.equal(a.tier, 'A'); assert.equal(q.pipelineForAssessment(a), 'QUALIFIED');
    assert.ok(a.score < q.assessProspect(strong, { now: NOW }).score);
    assert.equal(a.engagementReady, false);
    r.facts.independentBusiness.state = 'INDICATED';
    assert.equal(q.assessProspect(r, { now: NOW }).tier, 'A');
});

test('existing qualified CRM records remain usable without a new manual research workflow', () => {
    const legacy = { pipeline_status: 'QUALIFIED', email: 'ava@avamorgan.test' };
    assert.equal(q.hasQualifiedEmail(legacy), true);
    assert.equal(q.hasQualifiedEmail({ ...legacy, email: 'support@topmate.io' }), false);
    assert.equal(q.hasQualifiedEmail({ ...legacy, pipeline_status: 'INBOX' }), false);
    const a = q.assessProspect(research(), { email: legacy.email, now: NOW });
    assert.equal(q.hasQualifiedEmail({ ...legacy, prospect_assessment: a }), true);
    assert.equal(q.hasQualifiedEmail({ ...legacy, email: 'other@avamorgan.test', prospect_assessment: a }), false);
});
test('a contactable, active headline alone is investigate, never commercially qualified', () => {
    const r = q.emptyResearch({ linkedinUrl: 'https://www.linkedin.com/in/ava', headline: 'Executive Coach', profileIdentityConfirmed: true }, NOW);
    const a = q.assessProspect(r, { email: 'ava@avamorgan.test', emailProven: true, now: NOW });
    assert.equal(a.tier, 'B'); assert.equal(a.contact.channel, 'OWNERSHIP_UNCLEAR'); assert.equal(a.engagementReady, false);
});

test('older business research lowers its advisory tier without blocking an attributable email and recent activity', () => {
    const a = q.assessProspect(research({ researchedAt: '2024-01-01T12:00:00.000Z' }), { email: 'ava@avamorgan.test', now: NOW });
    assert.equal(a.tier, 'B'); assert.equal(a.businessFit, 'MATCH');
    assert.ok(a.cautions.some(note => note.includes('fresh public research')));
    assert.equal(q.pipelineForAssessment(a), 'QUALIFIED');
});
test('no email or old posting activity does not disqualify a commercially relevant practice', () => {
    const r = research({ lastActivityAt: '2026-07-01T12:00:00.000Z' });
    const a = q.assessProspect(r, { now: NOW });
    assert.equal(a.tier, 'A'); assert.equal(a.contact.channel, 'LINKEDIN_ONLY');
    assert.equal(q.pipelineForAssessment(a), 'NOT_QUALIFIED');
    assert.equal(q.isQualifiedRecord({ pipeline_status: 'QUALIFIED', email: '', prospect_assessment: a }), false);
    assert.ok(a.cautions.some(value => value.includes('freshness')));
});

test('qualification requires attributable email; SMTP acceptance cannot qualify a guessed address', () => {
    const r = research();
    for (const email of ['', '   ', 'broken', 'support@topmate.io', 'other@avamorgan.test']) {
        assert.equal(q.pipelineForAssessment(q.assessProspect(r, {email, emailProven: true})), 'NOT_QUALIFIED');
    }
    assert.equal(q.pipelineForAssessment(q.assessProspect(r, {email:'ava@avamorgan.test'})), 'QUALIFIED');
    r.contacts[0].ownership = 'GUESSED';
    assert.equal(q.pipelineForAssessment(q.assessProspect(r, {email:'ava@avamorgan.test',emailProven:true})), 'NOT_QUALIFIED');
});
test('unconfirmed profile identity cannot earn contact now without an evidence-backed review', () => {
    const r = research({ profileIdentityConfirmed: false });
    assert.equal(q.assessProspect(r, { now: NOW }).tier, 'B');
    const review = q.validateReview({ segment: 'EXECUTIVE', note: 'Confirmed the profile and practice with Ava on a call.' });
    assert.equal(q.assessProspect(r, { review, now: NOW }).tier, 'A');
});
test('delivery readiness requires confirmed demand, economics, capacity and marketing control', () => {
    assert.equal(q.assessProspect(research(), { now: NOW }).engagementReady, false);
    const facts = Object.fromEntries(['economics', 'capacity', 'marketingControl', 'demandSignals'].map(key => [key, { state: 'OBSERVED', note: 'Confirmed real operating figures and permissions with the coach.' }]));
    const review = q.validateReview({ facts });
    assert.equal(q.assessProspect(research(), { review, now: NOW }).engagementReady, true);
});
test('early offers and no capacity are nurture; lack of evidence is investigate', () => {
    const r = research(); r.facts.paidOffer = q.makeFact('NEGATIVE', 'Only free practice sessions', 'Confirmed in conversation.', [{ url: r.linkedinUrl, excerpt: 'The practice currently offers only free introductory sessions.', source: 'MANUAL', observedAt: NOW }]);
    assert.equal(q.assessProspect(r, { now: NOW }).tier, 'C');
    const empty = research(); empty.facts.paidOffer = q.emptyFact(); assert.equal(q.assessProspect(empty, { now: NOW }).tier, 'B');
    const full = research(); full.facts.capacity = q.makeFact('NEGATIVE', 'Not accepting clients', 'Confirmed directly with the coach.', full.facts.paidOffer.evidence);
    assert.equal(q.assessProspect(full, { now: NOW }).tier, 'C');
});

test('an ownership review is bound to its exact email and cannot confirm a replacement address', () => {
    const review = q.validateReview({ contactOwnership: 'CONFIRMED', contactEmail: 'ava@avamorgan.test', note: 'Confirmed this exact address directly with Ava in our conversation.' });
    const a = q.assessProspect(research({ contacts: [] }), { email: 'replacement@avamorgan.test', emailProven: true, review, now: NOW });
    assert.equal(a.contact.channel, 'OWNERSHIP_UNCLEAR'); assert.equal(q.hasAttributableEmail(a), false);
});

test('malformed sources, null records and invalid dates cannot break the shortlist', () => {
    const r = research(); r.pages = [null, { url: 'javascript:alert(1)' }]; r.contacts.push(null);
    r.lastActivityAt = 'not-a-date'; r.facts.clientProof.evidence[0].observedAt = 'invalid';
    const validated = q.validateResearch(r);
    assert.deepEqual(validated.pages, []); assert.equal(validated.lastActivityAt, null);
    assert.equal(validated.facts.clientProof.evidence[0].observedAt, NOW);
    assert.throws(() => q.validateReview({ facts: { clientProof: { state: 'OBSERVED', note: 'An explicit supporting note exists here.', url: 'https://bad url' } } }), /valid HTTP/);
});
test('confirmed corporate-only work is outside ICP and is not rescued by an email', () => {
    const r = research(); r.facts.independentBusiness = q.makeFact('NEGATIVE', 'Internal employee', 'Only an internal employer role.', [{ url: r.linkedinUrl, excerpt: 'Internal leadership coaching for employees of this organisation only.', source: 'PROFILE', observedAt: NOW }]);
    assert.equal(q.assessProspect(r, { email: 'ava@avamorgan.test', now: NOW }).tier, 'OUTSIDE_ICP');
});
test('sports and agile coaching do not qualify as the requested three segments', () => {
    for (const headline of ['Football Coach', 'Agile Coach']) assert.equal(q.assessProspect(q.emptyResearch({ headline }, NOW), { now: NOW }).tier, 'OUTSIDE_ICP');
    assert.deepEqual(q.segmentsFromText('Executive & Business Coach | Career Coaching'), ['EXECUTIVE', 'CAREER', 'BUSINESS']);
});
test('known shared-platform, vendor and placeholder addresses never become coach contacts', () => {
    for (const email of ['ava@instagram.com', 'contact@slideshare.net', 'apisupport@xecurify.com', 'johndoe@yourmail.com', 'support@topmate.io']) {
        assert.equal(q.isUnsafeContact(email), true);
        const a = q.assessProspect(research(), { email, emailProven: true, now: NOW });
        assert.equal(a.contact.channel, 'LINKEDIN_ONLY'); assert.equal(q.hasAttributableEmail(a), false);
    }
});
test('a guessed mailbox remains an ownership question even if SMTP accepts it', () => {
    const r = research(); r.contacts[0].ownership = 'GUESSED';
    const a = q.assessProspect(r, { email: r.contacts[0].address, emailProven: true, now: NOW });
    assert.equal(a.contact.channel, 'OWNERSHIP_UNCLEAR'); assert.equal(q.hasAttributableEmail(a), false);
});
test('contact ownership overrides can explicitly revoke automatic attribution', () => {
    const r = research(); const review = q.validateReview({ contactOwnership: 'UNCONFIRMED', contactEmail: 'ava@avamorgan.test', note: 'The coach says this address belongs to a different person.' });
    const a = q.assessProspect(r, { email: r.contacts[0].address, emailProven: true, review, now: NOW });
    assert.equal(a.contact.channel, 'OWNERSHIP_UNCLEAR'); assert.equal(q.hasAttributableEmail(a), false);
});
test('manual review never manufactures SMTP proof and needs an explicit evidence note', () => {
    assert.throws(() => q.validateReview({ facts: { clientProof: { state: 'OBSERVED', note: '' } } }), /evidence note/);
    assert.throws(() => q.validateReview({ segment: 'CAREER', note: '' }), /supporting/);
    const review = q.validateReview({ contactOwnership: 'CONFIRMED', contactEmail: 'ava@avamorgan.test', note: 'Coach confirmed this is their personal inbox in our conversation.' });
    const a = q.assessProspect(research(), { email: 'ava@avamorgan.test', review, emailProven: false, now: NOW });
    assert.equal(a.contact.channel, 'EMAIL_NEEDS_VERIFICATION');
});
test('original automated research survives manual review for removal and subsequent re-research', () => {
    const r = research(); const review = q.validateReview({ facts: { paidOffer: { state: 'UNKNOWN', note: '' } } });
    const a = q.assessProspect(r, { review, now: NOW });
    assert.equal(a.tier, 'B'); assert.equal(a.baseResearch.facts.paidOffer.state, 'OBSERVED');
    assert.equal(q.assessProspect(a.baseResearch, { now: NOW }).tier, 'A');
});
test('fabricated AI quotations cannot become business evidence', () => {
    const fact = q.groundedFact({ state: 'OBSERVED', value: 'Paid clients', evidence: [{ sourceIndex: 0, excerpt: 'I have a million dollars in revenue.' }] }, [{ text: 'Executive coaching with Ava', url: 'https://avamorgan.test', observedAt: NOW }]);
    assert.equal(fact.state, 'UNKNOWN');
});
test('referenced members and the logged-in user are never substituted for the requested coach', () => {
    const response = { included: [{ firstName: 'Logged-in', lastName: 'Student', publicIdentifier: 'student', headline: 'Student' }, { firstName: 'Ava', lastName: 'Morgan', publicIdentifier: 'ava-morgan', headline: 'Executive Coach' }] };
    assert.equal(q.extractMatchingProfile(response, 'ava-morgan').firstName, 'Ava');
    assert.equal(q.extractMatchingProfile(response, 'missing'), null);
});

test('full target profiles take precedence over mini profiles with missing business details', () => {
    const response = { included: [{ publicIdentifier: 'ava-morgan', firstName: 'Ava' }, { publicIdentifier: 'ava-morgan', firstName: 'Ava', lastName: 'Morgan', headline: 'Executive Coach' }] };
    assert.equal(q.extractMatchingProfile(response, 'ava-morgan').headline, 'Executive Coach');
});

test('current profile geography follows the matched person’s linked geo record, not their employer or another member', () => {
    const profile = { publicIdentifier: 'ava-morgan', firstName: 'Ava', lastName: 'Morgan', headline: 'Executive Coach', locationName: null, geoLocation: { '*geo': 'urn:li:fsd_geo:toronto' }, location: { countryCode: 'CA' } };
    const response = { included: [
        { publicIdentifier: 'other', firstName: 'Other', locationName: 'United States' },
        { entityUrn: 'urn:li:fsd_geo:wrong', defaultLocalizedName: 'United Kingdom' },
        { entityUrn: 'urn:li:fsd_profilePosition:old-job', geoLocationName: 'New York, United States' },
        profile, { entityUrn: 'urn:li:fsd_geo:toronto', defaultLocalizedName: 'Greater Toronto Area' },
    ] };
    assert.equal(q.extractProfileLocation(response, 'ava-morgan'), 'Greater Toronto Area, Canada');
    assert.equal(q.extractProfileLocation(response, 'missing'), '');
    profile.geoLocation['*geo'] = 'urn:li:fsd_geo:missing';
    assert.equal(q.extractProfileLocation(response, 'ava-morgan'), 'Canada');
    delete profile.location;
    assert.equal(q.extractProfileLocation(response, 'ava-morgan'), '');
});

test('legacy location strings and countries outside the ICP remain truthful profile evidence', () => {
    assert.equal(q.extractProfileLocation({ profile: { publicIdentifier: 'ava', locationName: 'London, United Kingdom' } }, 'ava'), 'London, United Kingdom');
    assert.equal(q.extractProfileLocation({ profile: { publicIdentifier: 'ava', locationName: 'Greater Toronto Area', location: { countryCode: 'CA' } } }, 'ava'), 'Greater Toronto Area, Canada');
    assert.equal(q.extractProfileLocation({ profile: { publicIdentifier: 'ava', location: { countryCode: 'ZA' } } }, 'ava'), 'South Africa');
});

test('failed business interpretation remains advisory and does not block the email/activity qualifier', () => {
    const r = research(); r.facts.paidOffer = q.emptyFact();
    for (const note of ['Automated interpretation failed: the configured AI model is unavailable (HTTP 404).', 'Automated interpretation could not complete. Conservative evidence was retained; no commercial facts were assumed.']) {
        r.limitations = [note]; const a = q.assessProspect(r, { email: 'ava@avamorgan.test', now: NOW });
        assert.equal(a.tier, 'B'); assert.equal(q.pipelineForAssessment(a), 'QUALIFIED');
        assert.equal(a.research.limitations[0], note);
    }
    const complete = research({ limitations: r.limitations });
    assert.equal(q.assessProspect(complete, { now: NOW }).tier, 'A');
});

test('contact fields from unrelated included records are ignored', () => {
    const wrong = { entityUrn: 'urn:li:fs_profileContactInfo:student', websites: ['https://student.test'], emailAddress: 'student@student.test' };
    assert.deepEqual(q.extractProfileContactInfo({ data: {}, included: [wrong] }, 'ava-morgan'), {});
    const right = { entityUrn: 'urn:li:fs_profileContactInfo:ava-morgan', websites: ['https://avamorgan.test'] };
    assert.equal(q.extractProfileContactInfo({ data: {}, included: [wrong, right] }, 'ava-morgan').websites[0], 'https://avamorgan.test');
    assert.equal(q.extractProfileContactInfo({ data: { emailAddress: 'ava@avamorgan.test' } }, 'ava-morgan').emailAddress, 'ava@avamorgan.test');
});
test('a former recruiter who declares career coaching is retained for business review', () => {
    const headline = 'Career Coach | Former corporate recruiter | Independent practice';
    const result = scoreDiscoveryResult({ headline, title: `Ava - ${headline} | LinkedIn`, snippet: '' }, { phrases: ['career coach'], roleWords: ['coach', 'coaching'] }, ['recruiter']);
    assert.equal(result.reject, null); assert.ok(result.score >= 20);
    const wrong = scoreDiscoveryResult({ headline: 'Corporate Recruiter', title: 'Ava - Corporate Recruiter', snippet: '' }, { phrases: ['career coach'], roleWords: ['coach'] }, ['recruiter']);
    assert.equal(wrong.reject, 'negative_keyword');
});
