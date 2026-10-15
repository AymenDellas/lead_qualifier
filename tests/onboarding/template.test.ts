import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_OFFER, DEFAULT_SCOPE_EXCLUSIONS, blankOpportunity, buildProject, normalizeOnboarding, onboardingBlockers, onboardingFormComplete, scopeDependencies } from '../../src/lib/business';
import { validateProject } from '../../src/lib/business-validation';
import { agreementPdf } from '../../src/lib/agreement-pdf';

const project = (free = true) => buildProject({ ...blankOpportunity(), name: 'Template Test Coach', funnel: 'DIRECT_TO_CALL', mode: free ? 'CASE_STUDY' : 'PERFORMANCE', fee: free ? 0 : 2000 }, DEFAULT_OFFER);
const legacyDependencies = 'Signed agreement, required payment, completed form, verified access, and baseline capture.';

test('free and paid templates carry explicit exclusions and type-specific payment requirements', () => {
    for (const free of [true, false]) {
        const data = project(free).onboarding!;
        assert.equal(data.scope.excluded, DEFAULT_SCOPE_EXCLUSIONS);
        for (const text of ['Lead generation', 'Advertising', 'Third-party', 'Ongoing optimization', 'Unless agreed separately']) assert.ok(data.scope.excluded.includes(text));
        assert.equal(data.scope.dependencies, scopeDependencies(free ? 'CASE_STUDY' : 'PAID'));
        if (free) {
            assert.doesNotMatch(data.scope.dependencies, /required payment|initial payment/i);
            assert.match(data.scope.dependencies, /No project payment is required/);
            assert.ok(!onboardingBlockers(data).some(item => item.key === 'payment'));
        } else assert.ok(onboardingBlockers(data).some(item => item.key === 'payment'));
    }
});

test('untouched legacy defaults upgrade, while custom and confirmed scope and signed documents remain intact', () => {
    const saved = project();
    saved.onboarding!.scope.excluded = '';
    saved.onboarding!.scope.dependencies = legacyDependencies;
    const migrated = normalizeOnboarding(saved);
    assert.equal(migrated.scope.excluded, DEFAULT_SCOPE_EXCLUSIONS);
    assert.equal(migrated.scope.dependencies, scopeDependencies('CASE_STUDY'));
    assert.equal(saved.onboarding!.scope.excluded, '');
    saved.onboarding!.scope.excluded = 'Advertising is included under the separate media agreement.';
    saved.onboarding!.scope.dependencies = 'Client approval and the separate media agreement.';
    assert.deepEqual(normalizeOnboarding(saved).scope, saved.onboarding!.scope);
    saved.onboarding!.scope.excluded = '';
    saved.onboarding!.scope.confirmed = true;
    assert.equal(normalizeOnboarding(saved).scope.excluded, '');
    saved.onboarding!.scope.confirmed = false;
    saved.onboarding!.agreement.status = 'FULLY_SIGNED';
    saved.onboarding!.agreement.signedPdfData = 'data:application/pdf;base64,c2lnbmVk';
    const original = structuredClone(saved.onboarding!.agreement);
    assert.equal(normalizeOnboarding(saved).scope.excluded, '');
    assert.deepEqual(normalizeOnboarding(saved).agreement, original);
});

test('new business answers are optional, validated, saved by normalization and backward compatible', () => {
    const saved = project();
    const form = saved.onboarding!.form;
    Object.assign(form, { status: 'COMPLETE', offer: 'Private coaching', audience: 'Managers', customerProblem: 'Hard decisions', desiredOutcome: 'Clear decisions', caseStudyConsent: true, testimonialCommitment: true });
    assert.equal(onboardingFormComplete(saved.onboarding!), true);
    form.differentiation = 'We review your actual decisions.';
    form.unsuitableClients = 'Clients wanting us to manage their team.';
    validateProject(saved);
    const normalized = normalizeOnboarding(JSON.parse(JSON.stringify(saved)));
    assert.equal(normalized.form.differentiation, form.differentiation);
    assert.equal(normalized.form.unsuitableClients, form.unsuitableClients);
    delete (form as Partial<typeof form>).differentiation;
    delete (form as Partial<typeof form>).unsuitableClients;
    assert.equal(normalizeOnboarding(saved).form.differentiation, '');
    assert.equal(normalizeOnboarding(saved).form.unsuitableClients, '');
    form.differentiation = 'x'.repeat(20_001);
    assert.throws(() => validateProject(saved), /Approach differentiation/);
});

test('client blockers retain the same start gate with client-facing actions and no admin instructions', () => {
    const data = project(false).onboarding!;
    const internal = onboardingBlockers(data);
    const client = onboardingBlockers(data, 'client');
    assert.deepEqual(client.map(item => item.key), internal.map(item => item.key));
    assert.doesNotMatch(JSON.stringify(client), /manual override|Collect the structured|Record the full payment|The client needs/i);
    assert.match(client.find(item => item.key === 'form')!.detail, /Complete the business questions/);
    data.agreement.status = 'SIGNED_CLIENT';
    assert.equal(onboardingBlockers(data, 'client').find(item => item.key === 'agreement')!.label, 'Waiting for Compel to sign');
    data.overrides = ['agreement'];
    assert.ok(!onboardingBlockers(data, 'client').some(item => item.key === 'agreement'));
});

test('both agreement PDFs include the actual scope and exclusions before signature lines', async () => {
    for (const free of [true, false]) {
        const data = project(free).onboarding!;
        data.scope.included += '\nBooking qualification questions';
        const original = JSON.stringify(data);
        const pdf = await agreementPdf(data).text();
        assert.ok(pdf.startsWith('%PDF-1.4'));
        for (const text of ['NOT INCLUDED', 'Lead generation', 'Advertising', 'Third-party', 'Ongoing optimization', 'Booking qualification questions', 'BEFORE WORK STARTS']) {
            assert.ok(pdf.includes(text), text);
            assert.ok(pdf.indexOf(text) < pdf.indexOf('(SIGNATURES)'), text);
        }
        if (free) {
            assert.ok(!pdf.includes('(PAYMENT TERMS)'));
            assert.ok(pdf.includes('No project payment is required.'));
        } else assert.ok(pdf.includes('(PAYMENT TERMS)'));
        assert.equal(JSON.stringify(data), original);
    }
});

test('the agreement uses the client-visible included scope instead of obsolete deliverables', async () => {
    const data = project().onboarding!;
    data.agreement.deliverables = 'Obsolete package with paid advertising';
    data.scope.included = 'Landing page and booking integration only';
    const pdf = await agreementPdf(data).text();
    assert.match(pdf, /Landing page and booking integration only/);
    assert.doesNotMatch(pdf, /Obsolete package with paid advertising/);
});
