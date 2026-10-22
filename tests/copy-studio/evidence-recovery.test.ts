import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRecoveredEvidence, evidenceSignature, needsEvidenceReview, recordEvidenceReview } from '../../src/lib/copy-studio/shared/evidence-recovery';
import { projectSchema, generationPayload, EXTRACTION_VERSION } from '../../src/lib/copy-studio/shared/contracts';
import { generateCopy, importSource } from '../../src/components/copy-studio/api';
import { generate } from './reviewed-engine';
import { draft, input, strategy } from './fixtures';

const quote = 'Coaching helped me choose a new career and make a practical plan.';
const proof = `Quote:\n${quote}\nAttribution: Sam R., Bristol\nSource: https://coach.example/testimonials`;
const source = {
  source: { title: 'Career Coaching', url: 'https://coach.example/', headings: [],
    text: 'SOURCE PAGE: https://coach.example/testimonials\nTITLE: Testimonials\n\nSam R., Bristol\n\n' + quote },
  extraction: { fields: {}, evidence: [], warnings: [] },
};
const recovered = { ...source, selectedOffer: input.brief.offerName, extractionVersion: EXTRACTION_VERSION,
  extraction: { fields: { proof, audience: 'Do not replace the existing audience.' }, evidence: [{ field: 'proof' as const, quote }], warnings: [] } };
const legacy = () => projectSchema.parse({
  id: 'old-project', name: 'Old project', updatedAt: '', ...input,
  result: { draft, issues: [] }, source, generatedFrom: 'previous-fingerprint', history: [],
});

test('regenerating an old saved project detects missing evidence even when a previous draft exists', () => {
  const saved = legacy();
  assert.equal(saved.brief.proof, '');
  assert.ok(saved.result);
  assert.equal(needsEvidenceReview(saved), true);
  assert.equal(needsEvidenceReview(projectSchema.parse(saved)), true); // Saved JSON is not auto-migrated into approved facts.
  assert.equal(generationPayload(saved).brief.proof, '');
});

test('recovering evidence changes only proof and source, preserving the existing copy, edits and history', () => {
  const saved = legacy();
  const original = structuredClone(saved);
  const next = applyRecoveredEvidence(saved, recovered, true);
  assert.equal(next.brief.proof, proof);
  assert.deepEqual({ ...next.brief, proof: '' }, saved.brief);
  assert.equal(next.result, saved.result);
  assert.equal(next.history, saved.history);
  assert.equal(next.generatedFrom, saved.generatedFrom);
  assert.equal(next.source, recovered);
  assert.equal(needsEvidenceReview(next), false);
  assert.deepEqual(saved, original);
  assert.deepEqual(projectSchema.parse(next).evidenceReview, next.evidenceReview);
});

test('an explicit omission is remembered until the offer or source changes', () => {
  const skipped = applyRecoveredEvidence(legacy(), recovered, false);
  assert.equal(skipped.brief.proof, '');
  assert.equal(needsEvidenceReview(skipped), false);
  assert.equal(needsEvidenceReview(projectSchema.parse(skipped)), false);
  assert.equal(needsEvidenceReview({ ...skipped, brief: { ...skipped.brief, offerName: 'Different service' } }), true);
  assert.equal(needsEvidenceReview({ ...skipped, source: { ...recovered, source: { ...source.source, text: source.source.text + 'Updated evidence.' } } }), true);
  assert.equal(needsEvidenceReview(recordEvidenceReview(legacy(), 'excluded')), false);
});

test('no source, a disabled reference, a new offer and existing approved proof do not trigger recovery', () => {
  assert.equal(needsEvidenceReview({ ...legacy(), source: null }), false);
  assert.equal(needsEvidenceReview({ ...legacy(), referenceMode: 'off' }), false);
  assert.equal(needsEvidenceReview({ ...legacy(), context: { mode: 'new', direction: '', background: '', mustKeep: '', avoid: '' } }), false);
  assert.equal(needsEvidenceReview({ ...legacy(), brief: { ...input.brief, proof: 'Approved testimonial' } }), false);
});

test('a failed check can be skipped without clearing saved source or changing the draft', () => {
  const saved = legacy();
  const next = applyRecoveredEvidence(saved, null, false);
  assert.equal(next.source, saved.source);
  assert.equal(next.result, saved.result);
  assert.equal(next.brief, saved.brief);
  assert.equal(needsEvidenceReview(next), false);
  assert.throws(() => applyRecoveredEvidence(saved, source, true), /No supported evidence/);
  assert.throws(() => applyRecoveredEvidence(saved, null, true), /No supported evidence/);
});

test('review signatures are bounded and distinguish other clients and offer descriptions', () => {
  const saved = legacy();
  assert.ok(evidenceSignature(saved).length < 100);
  assert.notEqual(evidenceSignature(saved), evidenceSignature({ ...saved, brief: { ...saved.brief, description: 'A different offer.' } }));
});

test('the existing-project API flow sends recovered proof to generation without a fresh five-field prefill', async () => {
  const originalFetch = globalThis.fetch;
  const requests: { path: string; body: any }[] = [];
  try {
    globalThis.fetch = async (url, options) => {
      requests.push({ path: String(url), body: JSON.parse(options!.body as string) });
      return String(url).endsWith('/import') ? Response.json(recovered)
        : new Response(`data: ${JSON.stringify({ type: 'result', result: { draft, issues: [] } })}\n\n`);
    };
    const saved = legacy();
    assert.equal(needsEvidenceReview(saved), true);
    const extracted = await importSource({ url: saved.source!.source.url, targetOffer: saved.brief.offerName }, new AbortController().signal);
    const approved = applyRecoveredEvidence(saved, extracted, true);
    await generateCopy(approved, new AbortController().signal, () => {});
    assert.deepEqual(requests.map(request => request.path), ['/api/copy-studio/import', '/api/copy-studio/generate']);
    assert.equal(requests[1].body.brief.proof, proof);
    assert.equal(requests[1].body.brief.audience, saved.brief.audience);
    assert.equal(requests[1].body.reference.text, recovered.source.text);
  } finally { globalThis.fetch = originalFetch; }
});

test('a regenerated old project retries omitted proof and renders the recovered exact quote', async () => {
  const approved = applyRecoveredEvidence(legacy(), recovered, true);
  const withProof = structuredClone(draft);
  Object.assign(withProof.sections.find(section => section.id === 'proof')!, { headline: 'A client’s career decision', body: 'A client describes their career change.' });
  withProof.sections.find(section => section.id === 'proof')!.proofFraming = { introduction: 'One client describes the support behind a career decision.', items: [{ id: 'E1', heading: 'Choosing a career direction' }] };
  const responses = [strategy, draft, withProof];
  const result = await generate(async () => JSON.stringify(responses.shift()), generationPayload(approved), new AbortController().signal, () => {});
  const section = result.draft.sections.find(section => section.id === 'proof')!;
  assert.ok(section.body.includes(quote));
  assert.match(section.body, /Sam R., Bristol/);
  assert.ok(section.headline);
});
