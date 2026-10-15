import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDesignPrompt } from '../../src/lib/copy-studio/shared/design-prompt';
import { fingerprint, projectSchema, type Project } from '../../src/lib/copy-studio/shared/contracts';
import { input, draft } from './fixtures';

const project = (): Project => projectSchema.parse({
  id: 'design-project', name: 'Design handoff', updatedAt: '', ...input,
  source: null, result: { draft: structuredClone(draft), issues: [] }, generatedFrom: fingerprint(input), history: [],
});
const copyData = (prompt: string) => JSON.parse(prompt.split('FINAL COPY DATA (the page content)\n')[1].split('\n\nEDITORIAL HANDOFF DATA')[0]);

test('the design handoff preserves complete final copy, omits empty proof, and isolates editorial notes', () => {
  const saved = project();
  saved.result!.draft.notes.push('INTERNAL_REVIEW_ONLY');
  saved.result!.issues.push({ sectionId: 'hero', severity: 'review', message: 'INTERNAL_CLAIM_FLAG' });
  const prompt = buildDesignPrompt(saved);
  assert.deepEqual(copyData(prompt), saved.result!.draft.sections.filter(section => !['proof', 'about'].includes(section.id)));
  assert.equal(copyData(prompt).some((section: { id: string }) => section.id === 'proof'), false);
  assert.doesNotMatch(JSON.stringify(copyData(prompt)), /INTERNAL_REVIEW_ONLY|INTERNAL_CLAIM_FLAG/);
  assert.match(prompt.split('EDITORIAL HANDOFF DATA')[1], /INTERNAL_REVIEW_ONLY/);
  assert.match(prompt, /No navbar.*navigation menu/);
  assert.match(prompt, /No mesh gradients/);
  assert.match(prompt, /No repeated cards/);
  assert.match(prompt, /No fake testimonials/);
  assert.match(prompt, /375px and 1440px/);
  assert.match(prompt, /Preserve headlines, paragraph wording, bullets, quotations, and button labels exactly/);
});

test('design prompts follow saved edits, restored drafts, and supplied proof exactly', () => {
  const saved = project();
  const before = buildDesignPrompt(saved);
  saved.result!.draft.sections[0].headline = 'An edited headline';
  saved.result!.draft.sections[saved.result!.draft.sections.findIndex(section => section.id === 'proof')] = { id: 'proof', headline: 'Their words', body: '“The words finally fit.”', bullets: [], cta: '' };
  const after = buildDesignPrompt(saved);
  assert.notEqual(after, before);
  assert.equal(copyData(after)[0].headline, 'An edited headline');
  assert.equal(copyData(after).find((section: { id: string }) => section.id === 'proof').body, '“The words finally fit.”');
  saved.result!.draft = structuredClone(draft);
  assert.equal(buildDesignPrompt(saved), before);
});

test('a stale draft uses its original offer snapshot even when the current brief is blank or switches offers', () => {
  const saved = project();
  saved.brief.offerName = 'UNGENERATED_NEW_OFFER';
  saved.brief.audience = '';
  saved.brief.description = '';
  saved.template = 'lead_magnet';
  const prompt = buildDesignPrompt(saved);
  assert.match(prompt, /Clear Offer Sprint/);
  assert.match(prompt, /Independent business coaches/);
  assert.match(prompt, /Build a focused page/);
  assert.doesNotMatch(prompt, /UNGENERATED_NEW_OFFER|Build a concise resource opt-in page/);
});

test('lead magnet and video drafts get distinct, useful section layouts and conversion tasks', () => {
  const saved = project();
  saved.template = 'lead_magnet';
  saved.generatedFrom = fingerprint({ ...input, template: 'lead_magnet' });
  saved.result!.draft.sections = [draft.sections[0], { id: 'optin', headline: 'Get the guide', body: 'For your next offer review.', bullets: ['Email address'], cta: 'Send me the guide' }];
  assert.match(buildDesignPrompt(saved), /one form.*Do not add a booking CTA/);
  assert.match(buildDesignPrompt(saved), /Use only the fields specified in the copy/);
  saved.template = 'vsl';
  saved.generatedFrom = fingerprint({ ...input, template: 'vsl' });
  saved.result!.draft.sections = [draft.sections[0], { id: 'video', headline: 'See the approach', body: '[VIDEO PLACEHOLDER]', bullets: [], cta: 'Book a fit call' }];
  assert.match(buildDesignPrompt(saved), /Build a video-led page/);
  assert.match(buildDesignPrompt(saved), /accessible player when an asset exists/);
});

test('no draft has no prompt, and old backups work without leaking raw source or onboarding metadata', () => {
  const saved = project();
  saved.result = null;
  assert.equal(buildDesignPrompt(saved), '');
  saved.result = { draft: structuredClone(draft), issues: [] };
  saved.generatedFrom = null;
  saved.source = { source: { title: 'Old page', url: '', text: 'OUTDATED_OTHER_OFFER_DATA', headings: [] }, extraction: { fields: {}, evidence: [], warnings: [] } };
  saved.onboarding = { id: 'PRIVATE_ONBOARDING_ID', revision: 1, clientName: 'PRIVATE_CONTACT_NAME', projectName: 'Internal project', updatedAt: '' };
  assert.doesNotMatch(buildDesignPrompt(saved), /OUTDATED_OTHER_OFFER_DATA|PRIVATE_ONBOARDING_ID|PRIVATE_CONTACT_NAME/);
});

test('the quality brief stays portable without enforcing the reference page identity', () => {
  for (const template of ['direct_to_call', 'lead_magnet', 'vsl'] as const) {
    const saved = project();
    saved.generatedFrom = fingerprint({ ...input, template });
    const prompt = buildDesignPrompt(saved);
    assert.match(prompt, /QUALITY STANDARD, NOT A VISUAL TEMPLATE/);
    assert.match(prompt, /DARK THEME REQUIRED/);
    assert.match(prompt, /one continuous dark canvas/);
    assert.doesNotMatch(prompt, /Light, dark and chromatic grounds are all valid/);
    assert.match(prompt, /Content sections remain transparent/);
    assert.match(prompt, /three materially different visual directions/);
    assert.match(prompt, /Dots and overhead lighting are optional/);
    assert.match(prompt, /copy template controls section meaning and order/);
    assert.match(prompt, /one coherent supporting-content grid/);
    assert.match(prompt, /heading directly above its related text or list/);
    assert.match(prompt, /There is no layout-variation quota/);
    assert.doesNotMatch(prompt, /at least three content-appropriate|Do not repeat the problem composition|Distinguish its arrangement from the conversation area through alignment/);
    assert.doesNotMatch(prompt, /#101113|#F1AD94|Outfit|IMPLEMENTATION STARTING POINT|\.light-left|\.light-right|approved charcoal\/soft-light/);
    assert.doesNotMatch(prompt, /luminous light main canvas|distinct tonal or material stage|reliable starting structure is an asymmetric hero/);
    assert.doesNotMatch(prompt, /judgment clear|through divorce|127\.0\.0\.1:3012|\.codex\/visualizations/);
    assert.deepEqual(copyData(prompt), saved.result!.draft.sections.filter(section => !['proof', 'about'].includes(section.id)));
  }
});

test('client asset references use the generated draft snapshot and omit query or fragment values', () => {
  const saved = project();
  const reference = { title: 'Public client page', url: 'https://www.clientstudio.com/coaching/?utm_source=PRIVATE_QUERY#PRIVATE_FRAGMENT', text: 'RAW_REFERENCE_COPY', headings: [], selectedOffer: '', tone: 'preserve' as const };
  saved.generatedFrom = fingerprint({ ...input, reference });
  saved.reference = { ...reference, url: 'https://different-client.com/UNGENERATED_REFERENCE' };
  const prompt = buildDesignPrompt(saved);
  assert.match(prompt, /https:\/\/www\.clientstudio\.com\/coaching\//);
  assert.doesNotMatch(prompt, /PRIVATE_QUERY|PRIVATE_FRAGMENT|RAW_REFERENCE_COPY|different-client|UNGENERATED_REFERENCE/);
});

test('asset reference handoffs exclude credentials, private hosts, access paths and non-web URLs', () => {
  for (const url of [
    'https://PRIVATE_USER:PRIVATE_PASSWORD@clientstudio.com/coaching/',
    'http://127.0.0.1:3000/PRIVATE_PATH',
    'http://localhost/PRIVATE_PATH',
    'https://client.internal/PRIVATE_PATH',
    'https://clientstudio.com/portal/PRIVATE_TOKEN',
    'https://clientstudio.com/%70ortal/PRIVATE_TOKEN',
    'file:///C:/PRIVATE_FILE',
  ]) {
    const saved = project();
    saved.generatedFrom = fingerprint({ ...input, reference: { title: '', url, text: 'RAW_REFERENCE_COPY', headings: [], selectedOffer: '', tone: 'preserve' } });
    const prompt = buildDesignPrompt(saved);
    assert.doesNotMatch(prompt, /PRIVATE_USER|PRIVATE_PASSWORD|PRIVATE_PATH|PRIVATE_TOKEN|PRIVATE_FILE|RAW_REFERENCE_COPY/);
    assert.match(prompt, /No eligible public client source URL/);
  }
});
