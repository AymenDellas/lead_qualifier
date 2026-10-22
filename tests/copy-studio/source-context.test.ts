import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceContext, byteSize } from '../../src/lib/copy-studio/server/source-context';
import { extract, generate, revise } from './reviewed-engine';
import { createCompletion, structured } from '../../src/lib/copy-studio/server/provider';
import { z } from 'zod/v4';
import { importResultSchema } from '../../src/lib/copy-studio/shared/contracts';
import { input, draft, strategy } from './fixtures';

const controller = () => new AbortController();

test('prefill accepts multiple source citations per fact and keeps every field supported in the bounded review index', async () => {
  const keys = ['offerName', 'description', 'audience', 'problem', 'outcome', 'mechanism', 'deliverables', 'cta', 'voice', 'customerLanguage', 'nextStep', 'coachBio'] as const;
  const fields = Object.fromEntries(keys.map(key => [key, key === 'offerName' ? 'Core Coaching' : `Verified source fact about ${key}.`]));
  const evidence = keys.flatMap(field => Array.from({ length: 3 }, (_, index) => ({ field, quote: `Core Coaching: ${fields[field]} Supporting passage ${index + 1}.` })));
  const source = { title: 'Core Coaching', url: 'https://coach.example/', headings: [], text: evidence.map(item => item.quote).join('\n\n') };
  let calls = 0;
  const result = await extract(async () => { calls++; return JSON.stringify({ offers: [{ name: 'Core Coaching', summary: 'Private coaching', quote: evidence[0].quote }], fields, evidence, warnings: [] }); }, source, controller().signal, 'Core Coaching');
  assert.equal(calls, 1, 'Valid extra citations should not trigger a model retry');
  assert.equal(result.extraction.evidence.length, 24);
  for (const key of keys) {
    assert.equal(result.extraction.fields[key], fields[key]);
    assert.ok(result.extraction.evidence.some(item => item.field === key), `${key} must retain a source citation, even when it appears last`);
  }
  importResultSchema.parse(result);
});
const largeSource = () => ({
  title: 'Coach', url: 'https://coach.example/', headings: ['Coach'],
  text: Array.from({ length: 75 }, (_, i) => `SOURCE PAGE: https://coach.example/articles/${i}\nTITLE: Article ${i}\n\n${`General article ${i} about weekly planning and personal priorities. `.repeat(50)}`).join('\n\n')
    + '\n\nSOURCE PAGE: https://coach.example/career-coaching\nTITLE: Career Coaching\n\nCareer Coaching helps career changers choose their next role.\n\nSOURCE PAGE: https://coach.example/about\nTITLE: Meet Jo\n\nJo holds a Master’s in Business Management and has senior leadership experience.\n\nSOURCE PAGE: https://coach.example/testimonials\nTITLE: Client experiences\n\nCareer Coaching client Sam: I chose my next role with a practical plan.',
});

test('retrieval searches the end of a large capture for the offer, biography and proof without mutating it', () => {
  const source = largeSource();
  const original = structuredClone(source);
  const selected = sourceContext(source, 11_000, 'Career Coaching');
  assert.equal(selected.excerpted, true);
  assert.ok(byteSize(JSON.stringify(selected.value)) <= 11_000);
  assert.match(selected.value.text, /Career Coaching helps career changers/);
  assert.match(selected.value.text, /Master’s in Business Management/);
  assert.match(selected.value.text, /Career Coaching client Sam/);
  assert.match(selected.value.text, /SOURCE PAGE: https:\/\/coach.example\/about/);
  assert.deepEqual(source, original);
});

test('small references retain every character and UTF-8 sources obey the byte budget', () => {
  const source = { title: 'Source', url: '', headings: [], text: 'Original voice. Keep every word.' };
  assert.deepEqual(sourceContext(source, 10_000, '').value, source);
  const unicode = { ...source, text: Array.from({ length: 250 }, (_, i) => `Career Coaching ${i} — إدارة العمل والمستقبل المهني بثقة. `.repeat(5)).join('\n\n') };
  const selected = sourceContext(unicode, 9000, 'Career Coaching');
  assert.ok(byteSize(JSON.stringify(selected.value)) <= 9000);
  assert.match(selected.value.text, /إدارة العمل/);
});

test('large-site extraction stays bounded, verifies evidence and returns the complete original capture', async () => {
  const source = largeSource();
  let calls = 0;
  const complete = Object.assign(async (system: string, prompt: string) => {
    calls++;
    assert.ok(byteSize(system + prompt) <= 20_000);
    assert.match(prompt, /Master’s in Business Management/);
    return JSON.stringify({ offers: [{ name: 'Career Coaching', summary: 'Career decisions', quote: 'Career Coaching helps career changers choose their next role.' }],
      fields: { offerName: 'Career Coaching', coachBio: 'Jo holds a Master’s in Business Management.', price: '$500' },
      evidence: [{ field: 'offerName', quote: 'Career Coaching helps career changers choose their next role.' }, { field: 'coachBio', quote: 'Jo holds a Master’s in Business Management and has senior leadership experience.' }, { field: 'price', quote: 'Invented price' }], warnings: [] });
  }, { inputByteLimit: 20_000 });
  const result = await extract(complete, source, controller().signal, 'Career Coaching');
  assert.equal(calls, 1);
  assert.equal(result.source.text, source.text);
  assert.equal(result.extraction.fields.coachBio, 'Jo holds a Master’s in Business Management.');
  assert.equal(result.extraction.fields.price, undefined);
  assert.match(result.extraction.warnings.join(' '), /selected exact excerpts/);
});

test('passage citations produce original quotes and unknown IDs cannot approve fields or offers', async () => {
  const source = largeSource();
  const complete = Object.assign(async (_system: string, prompt: string) => {
    const data = JSON.parse(prompt.split('SOURCE DATA: ')[1]);
    const offer = data.passages.find((passage: { text: string }) => passage.text.includes('helps career changers'));
    const bio = data.passages.find((passage: { text: string }) => passage.text.includes('Master’s in Business Management'));
    return JSON.stringify({ offers: [{ name: 'Career Coaching', summary: 'Career decisions', passageId: offer.id }, { name: 'Jo', summary: 'Not verified', passageId: 'P999999' }],
      fields: { offerName: 'Career Coaching', coachBio: 'Jo holds a Master’s in Business Management.', price: '$500' },
      evidence: [{ field: 'offerName', passageId: offer.id }, { field: 'coachBio', passageId: bio.id }, { field: 'price', passageId: 'P999999', quote: 'Invented price' }], warnings: [] });
  }, { inputByteLimit: 20_000 });
  const result = await extract(complete, source, controller().signal, 'Career Coaching');
  assert.equal(result.extraction.fields.coachBio, 'Jo holds a Master’s in Business Management.');
  assert.equal(result.extraction.fields.price, undefined);
  assert.equal(result.extraction.offers?.length, 1);
  for (const evidence of result.extraction.evidence) assert.ok(source.text.includes(evidence.quote));
  assert.equal(result.extraction.evidence.find(evidence => evidence.field === 'coachBio')?.quote, 'Jo holds a Master’s in Business Management and has senior leadership experience.');
});

test('a different service’s satisfaction score cannot become numeric proof for the chosen offer', async () => {
  const source = { title: 'Services', url: '', headings: [], text: 'Career Coaching helps people choose their next role.\n\nWorkplace training has a 97% participant approval rating.' };
  const run = (proof: string, quote: string, text = source.text) => extract(async () => JSON.stringify({
    offers: [{ name: 'Career Coaching', summary: 'Career decisions', quote: 'Career Coaching helps people choose their next role.' }],
    fields: { offerName: 'Career Coaching', proof }, evidence: [{ field: 'offerName', quote: 'Career Coaching helps people choose their next role.' }, { field: 'proof', quote }], warnings: [],
  }), { ...source, text }, controller().signal, 'Career Coaching');
  const result = await run('97% approval rating', source.text);
  assert.equal(result.extraction.fields.proof, undefined);
  assert.match(result.extraction.warnings.join(' '), /does not explicitly link/);
  const specific = 'Career Coaching has a 94% client approval rating.';
  assert.equal((await run('94% client approval rating', specific, source.text + '\n\n' + specific)).extraction.fields.proof, '94% client approval rating');
});

test('strategy, draft, claim repair and rewrite budget their own source context without dropping approved facts', async () => {
  const payload = { ...input, reference: { ...largeSource(), selectedOffer: 'Career Coaching', tone: 'preserve' as const } };
  const bad = structuredClone(draft);
  bad.sections[0].headline = 'Guaranteed 300% growth';
  const responses = [strategy, bad, { sections: [draft.sections[0]] }, draft.sections[0]];
  const complete = Object.assign(async (system: string, prompt: string) => {
    assert.ok(byteSize(system + prompt) <= 20_000);
    assert.match(prompt, /Master’s in Business Management/);
    const data = JSON.parse(prompt.split('BRIEF DATA: ')[1].split('\nDRAFT DATA:')[0].split('\nCURRENT PAGE DATA:')[0]);
    assert.deepEqual(data.brief, input.brief);
    return JSON.stringify(responses.shift());
  }, { inputByteLimit: 20_000 });
  await generate(complete, payload, controller().signal, () => {});
  await revise(complete, { ...payload, draft, sectionId: 'hero', direction: 'shorter' }, controller().signal);
  assert.equal(responses.length, 0);
  assert.equal(payload.reference.text, largeSource().text);
});

test('an upstream 413 rebuilds source context once; it never retries an unchanged oversized request', async () => {
  const original = globalThis.fetch;
  const sizes: number[] = [];
  try {
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      sizes.push(byteSize(body.messages.map((message: { content: string }) => message.content).join('')));
      return sizes.length === 1 ? Response.json({ error: { message: 'private provider detail' } }, { status: 413 })
        : Response.json({ choices: [{ message: { content: '{"ok":true}' } }] });
    };
    const complete = createCompletion({ apiKey: 'test-token', baseUrl: 'https://provider.invalid', model: 'test', timeoutMs: 1000, inputByteLimit: 20_000 });
    const source = largeSource();
    const result = await structured(complete, z.object({ ok: z.boolean() }), '', () => JSON.stringify(sourceContext(source, complete.inputByteLimit! - 2200, 'Career Coaching').value), controller().signal);
    assert.equal(result.ok, true);
    assert.equal(sizes.length, 2);
    assert.ok(sizes[1] < sizes[0] * 0.65);
    sizes.length = 0;
    await assert.rejects(complete('', 'unchanged prompt', controller().signal), /Retrying the same request will not resolve/);
    assert.equal(sizes.length, 1);
    sizes.length = 0;
    await assert.rejects(structured(complete, z.object({ ok: z.boolean() }), '', () => 'unchanged prompt', controller().signal), /Retrying the same request will not resolve/);
    assert.equal(sizes.length, 1);
    sizes.length = 0;
    globalThis.fetch = async () => { sizes.push(1); return Response.json({}, { status: 413 }); };
    complete.inputByteLimit = 20_000;
    await assert.rejects(structured(complete, z.object({ ok: z.boolean() }), '', () => JSON.stringify(sourceContext(source, complete.inputByteLimit! - 2200, 'Career Coaching').value), controller().signal), /request limit/);
    assert.equal(sizes.length, 2);
  } finally { globalThis.fetch = original; }
});

test('oversized approved facts are rejected before a provider call instead of silently shortened', async () => {
  let calls = 0;
  const complete = Object.assign(async () => { calls++; return '{}'; }, { inputByteLimit: 12_000 });
  await assert.rejects(generate(complete, { ...input, brief: { ...input.brief, description: 'x'.repeat(6000), audience: 'y'.repeat(6000) } }, controller().signal, () => {}), /approved brief is too long/);
  assert.equal(calls, 0);
});

test('rate-limit retries honor Retry-After, stay bounded, and cancellation stops the wait', async () => {
  const original = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return Response.json({}, { status: 429, headers: { 'retry-after': '0' } }); };
    const complete = createCompletion({ apiKey: 'test-token', baseUrl: 'https://provider.invalid', model: 'test', timeoutMs: 1000 });
    await assert.rejects(complete('', '', controller().signal), /usage limit/);
    assert.equal(calls, 3);
    globalThis.fetch = async () => Response.json({}, { status: 429, headers: { 'retry-after': '30' } });
    await assert.rejects(complete('', '', AbortSignal.timeout(15)), /aborted|timeout/i);
  } finally { globalThis.fetch = original; }
});
