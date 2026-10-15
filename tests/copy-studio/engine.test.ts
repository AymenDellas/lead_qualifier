import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod/v4';
import {
  briefSchema,
  fingerprint,
  generationSchema,
  copyContextSchema,
} from '../../src/lib/copy-studio/shared/contracts';
import { auditDraft, validateStructure } from '../../src/lib/copy-studio/shared/quality';
import { parseJson, structured } from '../../src/lib/copy-studio/server/provider';
import { generate, extract, revise } from '../../src/lib/copy-studio/server/engine';
import { draft, input, strategy } from './fixtures';

test('incomplete briefs fail before a provider call', () => {
  assert.throws(() =>
    generationSchema.parse({ ...input, brief: briefSchema.parse({ offerName: 'Test' }) }),
  );
});
test('every section is required exactly once and in order', () => {
  validateStructure(draft, 'direct_to_call');
  assert.throws(() =>
    validateStructure(
      { ...draft, sections: [...draft.sections.slice(1), draft.sections[0]] },
      'direct_to_call',
    ),
  );
  assert.throws(() =>
    validateStructure({ ...draft, sections: draft.sections.slice(1) }, 'direct_to_call'),
  );
});
test('parses fenced JSON but does not accept invalid JSON', () => {
  assert.deepEqual(parseJson('```json\n{"ok":true}\n```'), { ok: true });
  assert.throws(() => parseJson('not JSON'));
});
test('malformed structured output is retried once and recovered', async () => {
  let calls = 0;
  const result = await structured(
    async () => (++calls === 1 ? '{broken' : '{"ok":true}'),
    z.object({ ok: z.boolean() }),
    '',
    '',
    new AbortController().signal,
  );
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
});
test('persistent malformed output fails after the bounded repair', async () => {
  let calls = 0;
  await assert.rejects(
    structured(
      async () => {
        calls++;
        return '{}';
      },
      z.object({ ok: z.boolean() }),
      '',
      '',
      new AbortController().signal,
    ),
    /did not match/,
  );
  assert.equal(calls, 2);
});
test('flags invented numbers, proof, guarantees, and scarcity', () => {
  const bad = {
    ...draft,
    sections: [
      {
        id: 'proof',
        headline: '100% guaranteed results',
        body: 'Only 3 spots. A risk-free program.',
        bullets: [],
        cta: '',
      },
    ],
  };
  const messages = auditDraft(bad, input.brief)
    .map((i) => i.message)
    .join(' ');
  assert.match(messages, /without evidence/);
  assert.match(messages, /numbers/);
  assert.match(messages, /urgency/);
  assert.match(messages, /guarantee/);
});
test('valid supplied terms do not create unsupported-number warnings', () => {
  const withPrice = {
    ...draft,
    sections: [
      {
        id: 'cta',
        headline: 'Your sprint',
        body: 'The sprint costs $750.',
        bullets: [],
        cta: 'Book a call',
      },
    ],
  };
  assert.equal(auditDraft(withPrice, { ...input.brief, price: '$750' }).length, 0);
});
test('generation runs strategy, writing, review, and returns the validated result', async () => {
  const responses = [strategy, draft];
  const stages: string[] = [];
  const result = await generate(
    async () => JSON.stringify(responses.shift()),
    input,
    new AbortController().signal,
    (stage) => stages.push(stage),
  );
  assert.equal(result.draft.sections.length, 9);
  assert.deepEqual(result.issues, []);
  assert.equal(responses.length, 0);
  assert.equal(stages.length, 3);
});
test('unsupported claims trigger a factual revision before the result is returned', async () => {
  const bad = structuredClone(draft);
  bad.sections[0].headline = 'Guaranteed 300% growth';
  const responses = [strategy, bad, draft];
  const result = await generate(
    async () => JSON.stringify(responses.shift()),
    input,
    new AbortController().signal,
    () => {},
  );
  assert.equal(responses.length, 0);
  assert.equal(result.issues.length, 0);
  assert.equal(result.draft.sections[0].headline, draft.sections[0].headline);
});
test('extraction removes facts whose purported quotations are not in the source', async () => {
  const result = await extract(
    async () =>
      JSON.stringify({
        offers: [],
        fields: { offerName: 'Clear Offer Sprint', price: '$100', guarantee: 'Guaranteed results' },
        evidence: [
          { field: 'offerName', quote: 'Clear Offer Sprint' },
          { field: 'price', quote: 'Costs $100' },
        ],
        warnings: [],
      }),
    {
      title: 'Test',
      url: '',
      headings: [],
      text: 'The Clear Offer Sprint helps business coaches explain their offers.',
    },
    new AbortController().signal,
  );
  assert.deepEqual(Object.keys(result.extraction.fields), ['offerName']);
  assert.equal(result.extraction.evidence.length, 1);
  assert.equal(result.extraction.warnings.length, 2);
});
test('revision cannot replace a different section', async () => {
  await assert.rejects(
    revise(
      async () => JSON.stringify(draft.sections[1]),
      { ...input, draft, sectionId: 'hero', direction: 'shorter' },
      new AbortController().signal,
    ),
    /did not match/,
  );
});
test('fingerprints normalize field order and detect changes', () => {
  assert.equal(fingerprint(input), fingerprint({ ...input, brief: { ...input.brief } }));
  assert.notEqual(
    fingerprint(input),
    fingerprint({ ...input, brief: { ...input.brief, price: '$750' } }),
  );
});

const multiOfferSource = {
  title: 'Two coaching offers', url: 'https://coach.example', headings: [],
  text: 'Executive Program: six individual coaching sessions. Group Course: four weekly workshops. Executive Program costs $2000. Group Course costs $500.',
};
const offers = [
  { name: 'Executive Program', summary: 'Individual coaching', quote: 'Executive Program: six individual coaching sessions.' },
  { name: 'Group Course', summary: 'Group workshops', quote: 'Group Course: four weekly workshops.' },
];
test('multi-offer extraction requires an explicit choice and removes unsupported offer candidates', async () => {
  const result = await extract(async () => JSON.stringify({
    offers: [...offers, { name: 'Invented Course', summary: '', quote: 'Does not exist' }],
    fields: { offerName: 'Executive Program', price: '$2000' },
    evidence: [{ field: 'price', quote: 'Executive Program costs $2000.' }], warnings: [],
  }), multiOfferSource, new AbortController().signal);
  assert.equal(result.extraction.offers?.length, 2);
  assert.deepEqual(result.extraction.fields, {});
  assert.equal(result.selectedOffer, '');
});

test('targeted extraction receives the chosen offer and refuses a different offer returned by the provider', async () => {
  let promptSeen = '';
  const result = await extract(async (_system, prompt) => {
    promptSeen = prompt;
    return JSON.stringify({ offers, fields: { offerName: 'Group Course', price: '$500' }, evidence: [
      { field: 'offerName', quote: 'Group Course: four weekly workshops.' }, { field: 'price', quote: 'Group Course costs $500.' },
    ], warnings: [] });
  }, multiOfferSource, new AbortController().signal, 'Executive Program');
  assert.match(promptSeen, /TARGET OFFER DATA: "Executive Program"/);
  assert.deepEqual(result.extraction.fields, {});
  assert.match(result.extraction.warnings.join(' '), /could not be uniquely verified/);
});

test('generation and section rewrites both receive the selected offer direction and client constraints', async () => {
  const context = copyContextSchema.parse({ mode: 'focused', direction: 'Position for new executives', mustKeep: 'Use the approved name', avoid: 'Exclude the group course' });
  const prompts: string[] = [];
  const responses = [strategy, draft];
  await generate(async (_system, prompt) => { prompts.push(prompt); return JSON.stringify(responses.shift()); }, { ...input, context }, new AbortController().signal, () => {});
  await revise(async (_system, prompt) => { prompts.push(prompt); return JSON.stringify(draft.sections[0]); }, { ...input, context, draft, sectionId: 'hero', direction: 'shorter' }, new AbortController().signal);
  assert.equal(prompts.length, 3);
  for (const prompt of prompts) {
    assert.match(prompt, /Position for new executives/);
    assert.match(prompt, /Exclude the group course/);
  }
});
