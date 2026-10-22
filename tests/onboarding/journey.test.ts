import test from 'node:test';
import assert from 'node:assert/strict';
import { blankOpportunity, buildProject, DEFAULT_OFFER, onboardingAccessChecklist, onboardingAccessComplete, onboardingBlockers, onboardingProgress, reconcileOnboardingAccess } from '../../src/lib/business';
import { clientBriefReady, clientJourneyStep, storedJourneyStep, introductionDraft, introductionMailto, journeyFor, newOnboardingJourney, publishingReady, validateJourney } from '../../src/lib/onboarding-journey';
import { toOnboardingBrief } from '../../src/lib/copy-studio/shared/onboarding';
function data() {
    const d = buildProject({ ...blankOpportunity(), name: 'Test Coach', funnel: 'DIRECT_TO_CALL', mode: 'CASE_STUDY' }, DEFAULT_OFFER).onboarding!;
    d.journey = newOnboardingJourney();
    Object.assign(d.form, { offerName: 'Career coaching', offer: 'Six private sessions', audience: 'Career changers', customerProblem: 'Unsure what to do next', desiredOutcome: 'A clear next career step', status: 'COMPLETE', caseStudyConsent: true, testimonialCommitment: true });
    return d;
}

test('an untouched free onboarding starts at zero without counting an inapplicable payment as progress', () => {
    const d = buildProject({ ...blankOpportunity(), name: 'Test Coach', funnel: 'DIRECT_TO_CALL', mode: 'CASE_STUDY' }, DEFAULT_OFFER).onboarding!;
    d.journey = newOnboardingJourney();
    assert.equal(d.payment.status, 'FULLY_PAID');
    assert.equal(onboardingProgress(d), 0);
    d.scope.confirmed = true; assert.equal(onboardingProgress(d), 20);
    d.projectType = 'PAID'; d.payment.status = 'NOT_SENT'; d.scope.confirmed = false;
    assert.equal(onboardingProgress(d), 0);
});
test('five populated facts require preparation approval; legacy completed briefs remain readable', () => {
    const d = data(); assert.equal(clientBriefReady(d), false);
    d.journey!.briefPrepared = true; assert.equal(clientBriefReady(d), true);
    d.form.offer = ''; assert.equal(clientBriefReady(d), true);
    d.form.offer = 'Six private sessions'; delete d.journey; assert.equal(clientBriefReady(d), true);
});

test('saved page prefill is available for client review without another approval click', () => {
    const d = data();
    d.journey!.sourceLabel = 'Reviewed website prefill';
    assert.equal(clientBriefReady(d), true);
    d.form.offer = '';
    assert.equal(clientBriefReady(d), false);
    d.journey!.briefPrepared = true;
    assert.equal(clientBriefReady(d), true, 'Explicitly prepared briefs can ask the client for missing facts');
});

test('focused screens preserve legacy progress and resume each new step exactly', () => {
    assert.deepEqual([0, 1, 2, 3, 4].map(value => clientJourneyStep(value)), [-1, 0, 0, 2, 3]);
    assert.deepEqual([-1, 0, 1, 2, 3].map(storedJourneyStep), [0, 1, 2, 3, 4]);
    assert.deepEqual([0, 1, 2, 3, 4, 5].map(value => clientJourneyStep(value, 2)), [-1, 0, 1, 2, 3, 3]);
    assert.deepEqual([0, 1, 2, 3, 4].map(value => clientJourneyStep(value, 3)), [-1, 0, 1, 2, 3]);
    const d = data(); delete d.journey!.flowVersion;
    assert.equal(journeyFor(d).flowVersion, undefined);
});
test('contacts and introductions cannot complete the publishing handoff', () => {
    const d = data(); Object.assign(d.journey!, { publisher: 'DEVELOPER', websiteManager: 'OTHER', contactName: 'Developer', contactEmail: 'dev@example.com', introductionSent: true });
    assert.equal(publishingReady(d), false); assert.equal(onboardingAccessComplete(d), false);
    assert.ok(onboardingBlockers(d).some(b => b.key === 'publishing'));
    d.journey!.offerConfirmed = true; d.journey!.responsibilityConfirmed = true; d.journey!.verifiedAt = new Date().toISOString();
    assert.equal(publishingReady(d), true); assert.equal(onboardingAccessComplete(d), true);
});
test('booking links request no calendar access; access is limited to the chosen work', () => {
    const d = data(); Object.assign(d.form, { domainProvider: 'Cloudflare', websitePlatform: 'Wix', bookingPlatform: 'Calendly', emailPlatform: 'Kit', analyticsPlatform: 'Google Analytics' });
    d.journey!.publisher = 'COMPEL';
    assert.deepEqual(onboardingAccessChecklist(d).map(a => a.id.split('-').at(-1)), ['domain']);
    d.journey!.accessNeeds.push('booking'); assert.equal(onboardingAccessChecklist(d).length, 2);
    d.access = reconcileOnboardingAccess(d); d.access[0].status = 'VERIFIED';
    d.journey!.accessNeeds = ['booking']; d.access = reconcileOnboardingAccess(d);
    assert.equal(d.access.find(a => a.id.endsWith('-domain'))!.status, 'VERIFIED');
    assert.equal(d.access.find(a => a.id.endsWith('-domain'))!.required, false);
    d.journey!.accessNeeds.push('domain'); d.access = reconcileOnboardingAccess(d);
    assert.equal(d.access.find(a => a.id.endsWith('-domain'))!.required, true);
    assert.equal(d.access.find(a => a.id.endsWith('-domain'))!.status, 'VERIFIED');
});
test('email drafts use the coach’s mail app and cc Compel, without claiming the message was sent', () => {
    const d = data(); d.journey!.contactName = 'Sam'; d.journey!.contactEmail = 'sam@example.com';
    const link = new URL(introductionMailto(d)); assert.equal(link.protocol, 'mailto:');
    assert.equal(link.searchParams.get('cc'), 'aymen@getcompel.co');
    assert.match(link.searchParams.get('body')!, /authorize him/);
    assert.match(introductionDraft(d), /after I approve/); assert.equal(d.journey!.introductionSent, false);
});
test('coach proof is retained in full and original references survive the bridge to Copy Studio', () => {
    const d = data(); d.form.coachBio = 'Twenty years of coaching experience'; d.form.proof = 'Full client account. '.repeat(900);
    d.journey!.requestedChanges = 'Focus on career coaching only';
    d.journey!.reference = { source: { title: 'Original page', url: 'https://example.com/', text: 'Original page voice and full context.', headings: [] }, extraction: { fields: {}, evidence: [], warnings: [] } };
    const project = { id: 'test', revision: 1, updatedAt: new Date().toISOString(), data: { ...buildProject({ ...blankOpportunity(), name: 'Test Coach', funnel: 'DIRECT_TO_CALL' }, DEFAULT_OFFER), onboarding: d } };
    const brief = toOnboardingBrief(project as Parameters<typeof toOnboardingBrief>[0])!;
    assert.equal(brief.brief.proof, d.form.proof.trim()); assert.equal(brief.brief.coachBio, d.form.coachBio);
    assert.match(brief.context.background, /career coaching only/);
    assert.deepEqual(brief.source, d.journey!.reference);
});
test('invalid publishing selections and malformed contact addresses are rejected', () => {
    const j = newOnboardingJourney(); validateJourney(j);
    validateJourney({ ...j, contactEmail: 'partially-typed' });
    assert.throws(() => validateJourney({ ...j, responsibilityConfirmed: true, contactEmail: 'broken' }), /valid email/);
    assert.throws(() => validateJourney({ ...j, step: 9 }), /step/);
    assert.throws(() => validateJourney({ ...j, accessNeeds: ['passwords'] as never }), /access needed/);
});

test('client story corrections reach Copy Studio while the complete original testimonial remains available', () => {
    const d = data();
    d.form.coachBio = 'Previous background.'; d.form.proof = 'Original attributed client testimony.';
    d.journey!.reviewSummaries = { coachBio: 'Corrected background.', differentiation: 'Reviewed approach.', proof: 'Use the second account for this offer.' };
    const project = { id: 'test', revision: 1, updatedAt: '', data: { ...buildProject({ ...blankOpportunity(), name: 'Test Coach', funnel: 'DIRECT_TO_CALL' }, DEFAULT_OFFER), onboarding: d } };
    const brief = toOnboardingBrief(project as Parameters<typeof toOnboardingBrief>[0])!;
    assert.equal(brief.brief.coachBio, 'Corrected background.');
    assert.equal(brief.brief.mechanism, 'Reviewed approach.');
    assert.equal(brief.brief.proof, d.form.proof);
    assert.match(brief.context.background, /Use the second account/);
});
