import test from 'node:test';
import assert from 'node:assert/strict';
import { briefSchema, fingerprint, projectSchema } from '../../src/lib/copy-studio/shared/contracts';
import { auditDraft, isLegacyDirectCallDraft, validateStructure } from '../../src/lib/copy-studio/shared/quality';
import { generate, extract, revise } from '../../src/lib/copy-studio/server/engine';
import { buildDesignPrompt } from '../../src/lib/copy-studio/shared/design-prompt';
import { draft, input, strategy } from './fixtures';

const coachBio = 'Jordan Lee is a positioning consultant for independent business coaches. Jordan reviews actual customer conversations to clarify how coaches explain their services.';
const withBio = { ...input, brief: briefSchema.parse({ ...input.brief, coachBio }) };
const bioDraft = () => ({ ...structuredClone(draft), sections: draft.sections.map(section => section.id === 'about'
  ? { id: 'about', headline: 'About Jordan Lee', body: 'I’m Jordan Lee, a positioning consultant for independent business coaches. I work with actual customer conversations to help you explain your service clearly.', bullets: [], cta: '' }
  : structuredClone(section)) });

test('new generation requires the nine-section outline while legacy imports and rewrites preserve older copy', async () => {
  const old = { ...draft, sections: draft.sections.filter(section => section.id !== 'about') };
  assert.equal(isLegacyDirectCallDraft(old, 'direct_to_call'), true);
  assert.throws(() => validateStructure(old, 'direct_to_call'), /about/);
  validateStructure(old, 'direct_to_call', true);
  assert.throws(() => validateStructure({ ...old, sections: old.sections.slice(1) }, 'direct_to_call', true));
  const result = await revise(async () => JSON.stringify(old.sections[0]), { ...input, draft: old, sectionId: 'hero', direction: 'clearer' }, new AbortController().signal);
  assert.equal(result.section.id, 'hero');
});

test('the approved biography and descriptive-title rules reach generation, rewrites, and the design handoff', async () => {
  const calls: { system: string; prompt: string }[] = [];
  const responses = [strategy, bioDraft()];
  const result = await generate(async (system, prompt) => {
    calls.push({ system, prompt }); return JSON.stringify(responses.shift());
  }, withBio, new AbortController().signal, () => {});
  await revise(async (system, prompt) => {
    calls.push({ system, prompt }); return JSON.stringify(result.draft.sections.find(section => section.id === 'about'));
  }, { ...withBio, draft: result.draft, sectionId: 'about', direction: 'stronger' }, new AbortController().signal);
  assert.deepEqual(result.draft.sections.map(section => section.id), ['hero', 'problem', 'approach', 'call', 'fit', 'about', 'proof', 'objections', 'cta']);
  for (const call of calls) {
    assert.match(call.prompt, /Jordan Lee/);
    assert.match(call.system, /Supporting section headings must act as descriptive titles/);
    assert.match(call.system, /The hero stays outcome-led/);
    assert.match(call.system, /Do not invent personal experiences/);
  }
  const saved = projectSchema.parse({ id: 'bio', name: 'Example project', updatedAt: '', ...withBio, result, source: null, generatedFrom: fingerprint(withBio), history: [] });
  const prompt = buildDesignPrompt(saved);
  assert.match(prompt, /authentic approved coach portrait/);
  assert.match(prompt, /"headline": "About Jordan Lee"/);
  assert.match(prompt, /I’m Jordan Lee/);
});

test('approved coach background cannot be silently omitted from a fresh draft', async () => {
  const responses = [strategy, draft, bioDraft()];
  const result = await generate(async () => JSON.stringify(responses.shift()), withBio, new AbortController().signal, () => {});
  assert.equal(responses.length, 0);
  assert.match(result.draft.sections.find(section => section.id === 'about')!.body, /Jordan Lee/);
});

test('missing coach facts omit public biography and request details even if a model fabricates an introduction', async () => {
  const fabricated = bioDraft();
  assert.ok(auditDraft(fabricated, input.brief).some(issue => issue.sectionId === 'about' && issue.severity === 'warning'));
  const responses = [strategy, fabricated, fabricated];
  const result = await generate(async () => JSON.stringify(responses.shift()), input, new AbortController().signal, () => {});
  assert.deepEqual(result.draft.sections.find(section => section.id === 'about'), { id: 'about', headline: '', body: '', bullets: [], cta: '' });
  assert.ok(result.draft.notes.some(note => note.includes('Coach background & credentials')));
  assert.equal(result.issues.length, 0);
});

test('source biography needs exact quotes and is presented as a reviewable brief field', async () => {
  const source = { title: 'Coach page', url: '', headings: [], text: `Clear Offer Sprint. ${coachBio}` };
  const result = await extract(async () => JSON.stringify({ offers: [], fields: { coachBio }, evidence: [{ field: 'coachBio', quote: coachBio }], warnings: [] }), source, new AbortController().signal);
  assert.equal(result.extraction.fields.coachBio, coachBio);
  const unsupported = await extract(async () => JSON.stringify({ offers: [], fields: { coachBio }, evidence: [{ field: 'coachBio', quote: 'An invented qualification.' }], warnings: [] }), source, new AbortController().signal);
  assert.equal(unsupported.extraction.fields.coachBio, undefined);
});

test('rewriting About me cannot create a biography without approved coach facts', async () => {
  let calls = 0;
  await assert.rejects(revise(async () => { calls++; return JSON.stringify(bioDraft().sections.find(section => section.id === 'about')); },
    { ...input, draft, sectionId: 'about', direction: 'stronger' }, new AbortController().signal), /approved background/);
  assert.equal(calls, 0);
});

test('old brief snapshots retain fingerprints with an empty biography and new facts invalidate a draft', () => {
  const { coachBio: omitted, ...oldBrief } = input.brief;
  const oldFingerprint = JSON.stringify({ brief: oldBrief, template: input.template, formula: input.formula });
  assert.equal(fingerprint(input), oldFingerprint);
  assert.notEqual(fingerprint(withBio), oldFingerprint);
  assert.equal(briefSchema.parse(oldBrief).coachBio, '');
});
