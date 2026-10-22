const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent, ...rest) {
    return originalResolve.call(this, request.startsWith('@/') ? path.join(root, 'src', request.slice(2)) : request, parent, ...rest);
};
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename);
const stub = (filename, exports) => { require.cache[require.resolve(filename)] = { id: filename, filename, loaded: true, exports }; };
stub('next/cache', { revalidatePath() {} });
let record;
const client = { async query(sql, params) {
    if (sql.startsWith('SELECT p.')) return { rows: [{ ...record }] };
    if (sql.startsWith('UPDATE business_projects')) { record.data = JSON.parse(params[1]); record.revision = (record.revision || 0) + 1; return { rows: [record] }; }
    throw new Error(`Unexpected SQL in isolated action test: ${sql}`);
} };
stub(path.join(root, 'src/lib/business-store.ts'), { businessTransaction: fn => fn(client), recordActivity: async () => {}, ensureBusinessSchema: async () => {} });
stub(path.join(root, 'src/lib/pg_setup.ts'), { pool: { query: async () => ({ rows: [{ project: record.data, opportunity: record.opportunity, profile: record.profile }] }) } });
const b = require('../../src/lib/business.ts');
const actions = require('../../src/app/actions/business-actions.ts');
const agreementRoute = require('../../src/app/portal/[token]/agreement/route.ts');
const token = '11111111-1111-4111-8111-111111111111';
function reset() {
    const opportunity = { ...b.blankOpportunity(), name: 'Isolated test coach', funnel: 'DIRECT_TO_CALL', mode: 'CASE_STUDY' };
    record = { id: 'test-project', opportunity_id: 'test-opportunity', data: b.buildProject(opportunity, b.DEFAULT_OFFER), opportunity, profile: b.DEFAULT_OFFER };
    record.data.onboarding.portalToken = token;
    record.revision = 0;
}

test('portal action saves both new answers and an older cached form cannot erase them', async () => {
    reset();
    const form = new FormData();
    form.set('token', token);
    form.set('intent', 'save');
    form.set('offerName', 'The Practical Decisions Program');
    form.set('differentiation', 'We use real decisions from the client week.');
    form.set('unsuitableClients', 'People seeking therapy rather than coaching.');
    await actions.saveClientPortalFormAction(form);
    assert.equal(record.data.onboarding.form.offerName, 'The Practical Decisions Program');
    assert.equal(record.data.onboarding.form.differentiation, form.get('differentiation'));
    assert.equal(record.data.onboarding.form.unsuitableClients, form.get('unsuitableClients'));
    form.delete('differentiation');
    form.delete('offerName');
    form.delete('unsuitableClients');
    await actions.saveClientPortalFormAction(form);
    assert.equal(record.data.onboarding.form.offerName, 'The Practical Decisions Program');
    assert.match(record.data.onboarding.form.differentiation, /real decisions/);
    assert.match(record.data.onboarding.form.unsuitableClients, /therapy/);
});

test('portal completion requires every essential answer and saves the separate offer name', async () => {
    const values = { offerName: 'Practical Decisions', offer: 'Six private coaching sessions', audience: 'New managers', customerProblem: 'Decisions keep getting delayed', desiredOutcome: 'Make clear decisions' };
    for (const [missing] of b.REQUIRED_ONBOARDING_FORM_FIELDS) {
        reset();
        const form = new FormData();
        form.set('token', token); form.set('intent', 'complete');
        for (const [key, value] of Object.entries(values)) if (key !== missing) form.set(key, value);
        form.set('caseStudyConsent', 'accepted'); form.set('caseStudyConsentVersion', b.CASE_STUDY_CONSENT_VERSION);
        await assert.rejects(actions.saveClientPortalFormAction(form), /required onboarding/);
        assert.equal(record.data.onboarding.form.status, 'NOT_SENT');
    }
    reset();
    const form = new FormData(); form.set('token', token); form.set('intent', 'complete');
    for (const [key, value] of Object.entries(values)) form.set(key, value);
    form.set('caseStudyConsent', 'accepted'); form.set('caseStudyConsentVersion', b.CASE_STUDY_CONSENT_VERSION);
    await actions.saveClientPortalFormAction(form);
    assert.equal(record.data.onboarding.form.status, 'COMPLETE');
    assert.equal(record.data.onboarding.form.offerName, values.offerName);
});

test('scope confirmation persists the normalized scope that the client reviewed', async () => {
    reset();
    record.data.onboarding.scope.excluded = '';
    record.data.onboarding.scope.dependencies = 'Signed agreement, required payment, completed form, verified access, and baseline capture.';
    const form = new FormData(); form.set('token', token);
    await actions.confirmClientScopeAction(form);
    assert.equal(record.data.onboarding.scope.confirmed, true);
    assert.equal(record.data.onboarding.scope.excluded, b.DEFAULT_SCOPE_EXCLUSIONS);
    assert.equal(record.data.onboarding.scope.dependencies, b.scopeDependencies('CASE_STUDY'));
    assert.equal(b.normalizeOnboarding(record.data).scope.excluded, b.DEFAULT_SCOPE_EXCLUSIONS);
});

test('client PDF preview returns the uploaded signed document unchanged', async () => {
    reset();
    const original = Buffer.from('%PDF-1.4\nOriginal signed agreement\n%%EOF');
    record.data.onboarding.agreement.status = 'FULLY_SIGNED';
    record.data.onboarding.agreement.signedPdfData = `data:application/pdf;base64,${original.toString('base64')}`;
    const response = await agreementRoute.GET(new Request('http://localhost/'), { params: Promise.resolve({ token }) });
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), original);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
});

function guided() {
    reset();
    const { newOnboardingJourney } = require('../../src/lib/onboarding-journey.ts');
    record.data.onboarding.journey = { ...newOnboardingJourney(), briefPrepared: true };
    Object.assign(record.data.onboarding.form, { offerName: 'Career Coaching', offer: 'Six private sessions', audience: 'Career changers', customerProblem: 'Unsure where to go next', desiredOutcome: 'Choose a clear next step', assets: 'https://example.com/photos', traffic: '250 visits' });
    const form = new FormData(); form.set('token', token); form.set('guidedVersion', '1'); form.set('revision', '0'); form.set('intent', 'save'); return form;
}
test('guided saves preserve omitted hidden answers and reject stale revisions without losing data', async () => {
    const form = guided(); form.set('differentiation', 'We use actual client situations');
    const result = await actions.saveGuidedOnboardingAction(form);
    assert.equal(result.ok, true); assert.equal(result.revision, 1);
    assert.equal(record.data.onboarding.form.assets, 'https://example.com/photos');
    assert.equal(record.data.onboarding.form.traffic, '250 visits');
    const before = JSON.stringify(record.data);
    const stale = await actions.saveGuidedOnboardingAction(form);
    assert.equal(stale.ok, false); assert.match(stale.error, /another window/);
    assert.equal(JSON.stringify(record.data), before);
});
test('a client cannot approve an unprepared brief or grant themselves verified publishing', async () => {
    const form = guided();
    record.data.onboarding.journey.briefPrepared = false;
    form.set('journeyPatch', JSON.stringify({ briefPrepared: true, responsibilityConfirmed: true, verifiedAt: new Date().toISOString() }));
    assert.equal((await actions.saveGuidedOnboardingAction(form)).ok, false);
    record.data.onboarding.journey.briefPrepared = true;
    assert.equal((await actions.saveGuidedOnboardingAction(form)).ok, true);
    assert.equal(record.data.onboarding.journey.responsibilityConfirmed, false);
    assert.equal(record.data.onboarding.journey.verifiedAt, '');
    const old = new FormData(); old.set('token', token); old.set('intent', 'complete');
    await assert.rejects(actions.saveClientPortalFormAction(old), /guided brief/);
});
test('edits require renewed offer confirmation and publishing changes invalidate verification', async () => {
    const form = guided(); Object.assign(record.data.onboarding.journey, { offerConfirmed: true, publisher: 'COMPEL', responsibilityConfirmed: true, verifiedAt: new Date().toISOString() });
    form.set('offer', 'A new one-to-one program');
    form.set('journeyPatch', JSON.stringify({ publisher: 'DEVELOPER', contactName: 'Pat', contactEmail: 'pat@example.com', introductionSent: true }));
    assert.equal((await actions.saveGuidedOnboardingAction(form)).ok, true);
    assert.equal(record.data.onboarding.journey.offerConfirmed, false);
    assert.equal(record.data.onboarding.journey.responsibilityConfirmed, false);
    assert.equal(record.data.onboarding.journey.verifiedAt, '');
});
test('guided completion requires offer review and publishing choice, but can submit with access pending', async () => {
    const form = guided(); form.set('intent', 'complete');
    assert.equal((await actions.saveGuidedOnboardingAction(form)).ok, false);
    form.set('confirmOffer', 'yes'); form.set('caseStudyConsentPresent', 'yes'); form.set('caseStudyConsent', 'accepted'); form.set('caseStudyConsentVersion', b.CASE_STUDY_CONSENT_VERSION);
    form.set('confirmScope', 'yes');
    form.set('journeyPatch', JSON.stringify({ websiteManager: 'SELF', publisher: 'COMPEL', step: 4 }));
    assert.equal((await actions.saveGuidedOnboardingAction(form)).ok, true);
    assert.equal(record.data.onboarding.form.status, 'COMPLETE');
    assert.equal(record.data.onboarding.journey.offerConfirmed, true);
    assert.ok(b.onboardingBlockers(record.data.onboarding).some(item => item.key === 'publishing'));
});

test('guided progress can resume on the saved step without losing proof or legacy information', async () => {
    const form = guided(); form.set('proof', 'A full testimonial with its original attribution. '.repeat(500));
    form.set('journeyPatch', JSON.stringify({ step: 2, requestedChanges: 'Promote only the career offer' }));
    const first = await actions.saveGuidedOnboardingAction(form); assert.equal(first.ok, true);
    assert.equal(record.data.onboarding.journey.step, 2);
    const resumed = b.normalizeOnboarding(JSON.parse(JSON.stringify(record.data)));
    assert.equal(resumed.journey.step, 2); assert.equal(resumed.form.proof, form.get('proof').trim());
    const next = new FormData(); next.set('token', token); next.set('guidedVersion', '1'); next.set('revision', String(first.revision)); next.set('intent', 'save'); next.set('journeyPatch', JSON.stringify({ step: 3, contactEmail: 'partially-typed' }));
    assert.equal((await actions.saveGuidedOnboardingAction(next)).ok, true);
    assert.equal(record.data.onboarding.form.proof, resumed.form.proof);
    assert.equal(record.data.onboarding.form.traffic, '250 visits'); assert.equal(record.data.onboarding.journey.step, 3);
});

test('editable review summaries never replace original proof, source references, or internal verification', async () => {
    const form = guided();
    record.data.onboarding.form.proof = 'Original, attributed testimony. '.repeat(500);
    const original = record.data.onboarding.form.proof;
    form.set('journeyPatch', JSON.stringify({ flowVersion: 2, step: 2, reviewSummaries: { coachBio: 'Reviewed background.', proof: 'Client correction to the featured result.' }, reference: { source: 'forged' }, responsibilityConfirmed: true }));
    assert.equal((await actions.saveGuidedOnboardingAction(form)).ok, true);
    assert.equal(record.data.onboarding.form.proof, original);
    assert.equal(record.data.onboarding.journey.reviewSummaries.proof, 'Client correction to the featured result.');
    assert.equal(record.data.onboarding.journey.reference, null);
    assert.equal(record.data.onboarding.journey.responsibilityConfirmed, false);
    form.set('revision', '1'); form.set('journeyPatch', JSON.stringify({ reviewSummaries: { proof: 'x'.repeat(2001) } }));
    assert.equal((await actions.saveGuidedOnboardingAction(form)).ok, false);
    assert.equal(record.data.onboarding.journey.reviewSummaries.proof, 'Client correction to the featured result.');
});

test('the last screen confirms scope atomically without signing the agreement', async () => {
    const form = guided();
    form.set('intent', 'complete'); form.set('confirmOffer', 'yes');
    form.set('journeyPatch', JSON.stringify({ flowVersion: 2, step: 5, websiteManager: 'SELF', publisher: 'COMPEL' }));
    form.set('caseStudyConsentPresent', 'yes'); form.set('caseStudyConsent', 'accepted'); form.set('caseStudyConsentVersion', b.CASE_STUDY_CONSENT_VERSION);
    assert.equal((await actions.saveGuidedOnboardingAction(form)).ok, false);
    assert.equal(record.data.onboarding.scope.confirmed, false);
    form.set('confirmScope', 'yes');
    assert.equal((await actions.saveGuidedOnboardingAction(form)).ok, true);
    assert.equal(record.data.onboarding.scope.confirmed, true);
    assert.ok(record.data.onboarding.scope.confirmedAt);
    assert.equal(record.data.onboarding.agreement.status, 'DRAFT');
    assert.equal(record.data.onboarding.form.status, 'COMPLETE');
});

test('access receipts stay on the same revision queue and cannot downgrade verified access', async () => {
    const form = guided();
    const access = { id: 'manual-tool', generated: false, platform: 'Example', reason: 'Publish the page', instructions: 'Invite the project contact', permission: 'Editor', status: 'REQUESTED', required: true, nonBlocking: false };
    record.data.onboarding.access = [access, { ...access, id: 'verified-tool', status: 'VERIFIED' }];
    form.set('receivedAccessIds', JSON.stringify(['manual-tool', 'verified-tool']));
    assert.equal((await actions.saveGuidedOnboardingAction(form)).ok, true);
    assert.equal(record.data.onboarding.access.find(a => a.id === 'manual-tool').status, 'RECEIVED');
    assert.equal(record.data.onboarding.access.find(a => a.id === 'verified-tool').status, 'VERIFIED');
    form.set('revision', '1'); form.set('receivedAccessIds', JSON.stringify(['unknown-tool']));
    assert.equal((await actions.saveGuidedOnboardingAction(form)).ok, false);
});

test('both website-contact branches require a sent introduction before leaving Going live or submitting', async () => {
    for (const [websiteManager, publisher] of [['OTHER', 'COMPEL'], ['SELF', 'DEVELOPER']]) {
        const form = guided();
        const details = { flowVersion: 3, step: 3, websiteManager, publisher, contactName: 'Website contact', contactEmail: 'contact@example.com', introductionSent: false };
        form.set('journeyPatch', JSON.stringify(details));
        assert.equal((await actions.saveGuidedOnboardingAction(form)).ok, true, 'Unfinished introductions can still save as drafts');
        form.set('revision', '1'); form.set('journeyPatch', JSON.stringify({ ...details, step: 4 }));
        const blocked = await actions.saveGuidedOnboardingAction(form);
        assert.equal(blocked.ok, false); assert.match(blocked.error, /Send the introduction email/);
        assert.equal(record.data.onboarding.journey.step, 3);
        form.set('intent', 'complete'); form.set('confirmOffer', 'yes'); form.set('confirmScope', 'yes');
        form.set('caseStudyConsentPresent', 'yes'); form.set('caseStudyConsent', 'accepted'); form.set('caseStudyConsentVersion', b.CASE_STUDY_CONSENT_VERSION);
        assert.equal((await actions.saveGuidedOnboardingAction(form)).ok, false, 'Completion cannot bypass the introduction requirement');
        form.set('journeyPatch', JSON.stringify({ ...details, step: 4, introductionSent: true }));
        assert.equal((await actions.saveGuidedOnboardingAction(form)).ok, true);
        assert.equal(record.data.onboarding.journey.introductionSent, true);
        assert.equal(record.data.onboarding.form.status, 'COMPLETE');
    }
});
