import test from 'node:test';
import assert from 'node:assert/strict';
import { briefSchema, sectionSchema, extractionSchema, projectSchema, fingerprint } from '../../src/lib/copy-studio/shared/contracts';
import { approvedTestimonials } from '../../src/lib/copy-studio/shared/evidence';
import { proofPresentation } from '../../src/lib/copy-studio/shared/proof-presentation';
import { auditDraft } from '../../src/lib/copy-studio/shared/quality';
import { buildDesignPrompt } from '../../src/lib/copy-studio/shared/design-prompt';
import { findTestimonials, testimonialProof } from '../../src/lib/copy-studio/server/testimonials';
import { restoreApprovedProof, proofForModel } from '../../src/lib/copy-studio/server/approved-proof';
import { extract, generate } from './reviewed-engine';
import { crawlWebsite } from '../../src/lib/copy-studio/server/source';
import type { fetchSourceDocument } from '../../src/lib/copy-studio/server/source-fetch';
import { exportMarkdown } from '../../src/components/copy-studio/export';
import { draft, input, strategy } from './fixtures';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as cheerio from 'cheerio';
import { ProofBody } from '../../src/components/copy-studio/ProofBody';

const names = ['Alex North', 'Bryn West', 'Casey Lake', 'Drew Stone', 'Ellis Reed', 'Frank Vale', 'Gale Hill', 'Harper Sage', 'Indie Woods', 'Jules Green', 'Kai Rose', 'Lane Brook'];
const quotes = names.map((name, index) => `I came to coaching during a career transition and did not know which role to choose. ${index === 0 ? 'My coach helped me compare the roles against my priorities. '.repeat(90) : ''}With that support, I decided on a career direction that fitted my goals. ${name} is the name I use for this account.`);
const source = { title: 'Career Coaching testimonials', url: 'https://coach.example/testimonials', headings: [],
  text: `Career Coaching helps professionals decide on their next role.\n\nPersonal Recommendations\n\n${names.map((name, index) => `${name}\n\n${quotes[index]}`).join('\n\n')}` };
const framed = () => {
  const value = structuredClone(draft);
  Object.assign(value.sections.find(section => section.id === 'proof')!, { headline: 'Choosing a career direction', body: '',
    proofFraming: { introduction: 'These individual accounts describe career decisions.', items: [{ id: 'E1', heading: 'Comparing career options' }] } });
  return value;
};

test('prefill retains more than eight accounts and long whole quotes, even when the model recommends only one', async () => {
  assert.equal(findTestimonials(source, 'Career Coaching').length, 12);
  const result = await extract(async () => JSON.stringify({ offers: [{ name: 'Career Coaching', summary: '', quote: 'Career Coaching helps professionals decide on their next role.' }],
    fields: { offerName: 'Career Coaching' }, evidence: [{ field: 'offerName', quote: 'Career Coaching helps professionals decide on their next role.' }], selectedTestimonialIds: ['T2'], warnings: [] }),
  source, new AbortController().signal, 'Career Coaching');
  const proof = result.extraction.fields.proof!;
  assert.ok(result.extraction.evidence.some(item => item.field === 'offerName'), 'A large testimonial archive must retain the essential field citation.');
  assert.equal(approvedTestimonials(proof).length, 12);
  assert.ok(proof.length > 6000);
  for (const quote of quotes) assert.ok(proof.includes(quote));
  extractionSchema.parse(result.extraction);
  briefSchema.parse({ proof });
});

test('full proof survives generation, disclosure, exports and design handoff beyond the former body limit', async () => {
  const proof = testimonialProof(findTestimonials(source, 'Career Coaching'));
  const request = { ...input, brief: { ...input.brief, proof } };
  const responses = [strategy, framed()];
  const result = await generate(Object.assign(async (_system: string, prompt: string) => {
    assert.ok(Buffer.byteLength(_system + prompt) <= 20_000);
    return JSON.stringify(responses.shift());
  }, { inputByteLimit: 20_000 }), request, new AbortController().signal, () => {});
  const section = result.draft.sections.find(item => item.id === 'proof')!;
  assert.ok(section.body.length > 6000);
  sectionSchema.parse(section);
  const presentation = proofPresentation(section.body)!;
  assert.equal(presentation.featured.length, 3);
  assert.equal(presentation.remaining.length, 9);
  const expanded = [...presentation.featured, ...presentation.remaining].join('\n\n');
  for (const quote of quotes) assert.ok(expanded.includes(quote));
  const project = projectSchema.parse({ id: 'archive', name: 'Archive', updatedAt: '', ...request, result, source: null, generatedFrom: fingerprint(request), history: [] });
  const markdown = exportMarkdown(project);
  const handoff = buildDesignPrompt(project);
  const finalCopy = JSON.parse(handoff.split('FINAL COPY DATA (the page content)\n')[1].split('\n\nEDITORIAL HANDOFF DATA')[0]);
  for (const quote of quotes) {
    assert.ok(markdown.includes(quote));
    assert.ok(finalCopy.find((item: { id: string }) => item.id === 'proof').body.includes(quote));
  }
  assert.match(handoff, /no network request, carousel, pagination, ellipsis, line clamp/);
});

test('large proof uses whole-account writing context without altering stored or restored testimony', () => {
  const proof = testimonialProof(findTestimonials(source, 'Career Coaching'));
  const request = { ...input, brief: { ...input.brief, proof } };
  const before = structuredClone(request);
  const context = proofForModel(request, 2500);
  assert.ok(Buffer.byteLength(context) <= 2500);
  assert.match(context, /complete approved testimonials are retained/);
  assert.deepEqual(request, before);
  const result = restoreApprovedProof(framed(), request);
  for (const quote of quotes) assert.ok(result.sections.find(section => section.id === 'proof')!.body.includes(quote));
  assert.throws(() => briefSchema.parse({ description: 'x'.repeat(6001) }));
  assert.throws(() => sectionSchema.parse({ ...draft.sections[0], body: 'x'.repeat(6001) }));
});

test('rendered disclosure contains every full account exactly once and short archives remain fully visible', () => {
  const proof = testimonialProof(findTestimonials(source, 'Career Coaching'));
  const body = restoreApprovedProof(framed(), { ...input, brief: { ...input.brief, proof } }).sections.find(section => section.id === 'proof')!.body;
  const markup = renderToStaticMarkup(React.createElement(ProofBody, { body }));
  const $ = cheerio.load(markup);
  assert.equal($('details').length, 1);
  assert.equal($('details').attr('open'), undefined);
  assert.equal($('summary').text(), 'Show all testimonials (9 more)');
  assert.equal($('details p').length, 9);
  for (const quote of quotes) assert.equal($('body').text().split(quote).length - 1, 1);
  const short = renderToStaticMarkup(React.createElement(ProofBody, { body: 'A short complete account.' }));
  assert.equal(cheerio.load(short)('details').length, 0);
});

test('author-first and author-last feedback remain separate, with no CTA or training label mistaken for an author or quotation', () => {
  const captured = { ...source, title: 'Client reviews', text: `Personal Recommendations\n\nA Grateful Mom, Bristol\n\nThis support helped my family through a difficult career transition.\n\nSingle Mother of Two, York\n\nMy coach helped me choose a better way forward for my own career.\n\nProfessional Recommendations\n\nPat Lane, Manager\n\n“My experience has increased my confidence and helped me make a professional decision.”\n\nTraining Attendee, London\n\n“Very informative and well laid out session. The workshop was engaging.”\n\nBook a Consultation\n\n“I changed careers with a practical plan and the support to make the decision.”\n\nRobin West, Designer` };
  const found = findTestimonials(captured, 'Career Coaching');
  assert.equal(found.length, 5);
  assert.ok(found.some(item => item.attribution === 'Robin West, Designer'));
  assert.ok(found.some(item => item.attribution === 'Training Attendee, London' && item.category === 'Training feedback'));
  assert.ok(found.every(item => item.attribution !== 'Book a Consultation'));
  assert.ok(!found.find(item => item.attribution.startsWith('Pat Lane'))!.quote.includes('Training Attendee'));
});

test('a long testimonials route is kept whole before ordinary routes share the crawl budget', async () => {
  const long = 'I worked with my coach to compare career options and choose my next role. '.repeat(450);
  const docs: Record<string, string> = {
    '/': `<title>Career Coaching</title><main>${'Homepage copy. '.repeat(2000)}<a href="/testimonials">Testimonials</a></main>`,
    '/testimonials': `<title>Client testimonials</title><main><h1>Testimonials</h1><p>Sam North, London</p><p>${long}END_OF_FULL_TESTIMONIAL.</p></main>`,
  };
  const fetcher: typeof fetchSourceDocument = async url => {
    if (!(url.pathname in docs)) throw new Error('not found');
    return { url, html: docs[url.pathname] };
  };
  const captured = await crawlWebsite('https://coach.example/', new AbortController().signal, fetcher);
  assert.ok(captured.text.includes(long + 'END_OF_FULL_TESTIMONIAL.'));
  assert.equal(captured.crawl!.pages.find(page => page.url.endsWith('/testimonials'))!.truncated, undefined);
});

test('success-story sequences keep third-person and As-my openings with their following authors', () => {
  const captured = { ...source, title: 'Success Stories', url: 'https://coach.example/success-stories',
    text: `Success Stories\n\nVideo Testimonial by Amy\n\nWatch how coaching helped Amy work through her career decisions.\n\nAs my executive and business coach, Terry helped me change careers and prepare for new responsibilities.\n\nSteve, VP Sales, New York\n\nTerry helped me identify the pattern holding me back and take a different approach to my business.\n\nMichael, Designer, New York\n\nTerry is a highly empathetic coach. She helped me investigate my professional ambitions and career options.\n\nRebecca, Entrepreneur, New York` };
  const found = findTestimonials(captured, 'Business Coaching');
  assert.equal(found.length, 3);
  assert.match(found.find(item => item.attribution.startsWith('Steve,'))!.quote, /^As my executive/);
  assert.match(found.find(item => item.attribution.startsWith('Michael,'))!.quote, /^Terry helped me identify/);
  assert.match(found.find(item => item.attribution.startsWith('Rebecca,'))!.quote, /^Terry is a highly empathetic/);
  assert.ok(found.every(item => !item.quote.includes('Watch how')));
});

test('testimonials embedded late on an ordinary homepage survive the page and combined capture budgets', async () => {
  const quote = 'I worked with my coach to compare career options and chose a new role that fitted my priorities.';
  const docs: Record<string, string> = {
    '/': `<title>Career Coaching</title><main><p>${'Homepage copy. '.repeat(2200)}</p><h2>Testimonials</h2><p>${quote}</p><p>Sam North, London</p><a href="/articles">Articles</a></main>`,
    '/articles': `<title>Articles</title><main>${'Other readable copy. '.repeat(1500)}</main>`,
  };
  const fetcher: typeof fetchSourceDocument = async url => {
    if (!(url.pathname in docs)) throw new Error('not found');
    return { url, html: docs[url.pathname] };
  };
  const captured = await crawlWebsite('https://coach.example/', new AbortController().signal, fetcher);
  assert.ok(captured.text.includes(quote));
  assert.equal(captured.crawl!.pages.find(page => page.url === 'https://coach.example/')!.truncated, undefined);
  assert.equal(findTestimonials(captured, 'Career Coaching')[0].attribution, 'Sam North, London');
});

test('review flags missing, abbreviated or misattributed accounts even when another full account remains', () => {
  const proof = testimonialProof(findTestimonials(source, 'Career Coaching'));
  const request = { ...input, brief: { ...input.brief, proof } };
  const complete = restoreApprovedProof(framed(), request);
  const flag = (value: typeof complete) => auditDraft(value, request.brief).some(issue => /missing or abbreviated/.test(issue.message));
  assert.equal(flag(complete), false);
  const shortened = structuredClone(complete);
  const section = shortened.sections.find(item => item.id === 'proof')!;
  section.body = section.body.replace(quotes[0], quotes[0].slice(0, 120));
  assert.equal(flag(shortened), true);
  const misattributed = structuredClone(complete);
  const wrong = misattributed.sections.find(item => item.id === 'proof')!;
  wrong.body = wrong.body.replace(`”\n${names[0]}`, `”\n${names[1]}`);
  assert.equal(flag(misattributed), true);
});
