import test from 'node:test';
import assert from 'node:assert/strict';
import { approvedProofEntries, exactExcerpt, restoreApprovedProof, testimonialWordLimit } from '../../src/lib/copy-studio/server/approved-proof';
import { findTestimonials, testimonialProof } from '../../src/lib/copy-studio/server/testimonials';
import { approvedTestimonials } from '../../src/lib/copy-studio/shared/evidence';
import { draftSchema } from '../../src/lib/copy-studio/shared/contracts';
import { auditDraft } from '../../src/lib/copy-studio/shared/quality';
import { generate, revise } from './reviewed-engine';
import { extractionContext, byteSize } from '../../src/lib/copy-studio/server/source-context';
import { ProviderSizeError } from '../../src/lib/copy-studio/server/provider';
import { input, draft, strategy } from './fixtures';

const clientQuote = 'I came to coaching during a difficult career transition. I had several options but did not know how to weigh them. My coach helped me understand my priorities and compare the roles against the work I wanted to do. I chose a new career direction with a practical plan and felt more confident about my next move.';
const endorsement = 'My experience working with this coach helped me act with greater professional confidence. I appreciated the practical advice and the attention given to the decisions I was facing at work. I recommend this support to other professionals.';
const items = [
  { id: 'T1', attribution: 'Sam R., Bristol', quote: clientQuote, page: 'https://coach.example/testimonials', category: 'Client experience' },
  { id: 'T2', attribution: 'Pat L., Operations Manager', quote: endorsement, page: 'https://coach.example/testimonials', category: 'Professional recommendation' },
];
const proof = testimonialProof(items);
const withProof = { ...input, brief: { ...input.brief, proof } };

test('inline attributed feedback is found without a testimonials route and unrelated template quotes stay excluded', () => {
  const title = 'Relationship Coaching by Josie Smith | Coaching & Courses';
  const quote = '“Josie has a way of hearing people and guiding them toward patterns they had not seen. Our work together gave me the courage to continue a deeper journey within myself.”';
  const unrelated = '“Hannah helped me work through the Empower program and I would recommend that course to anyone.”';
  const source = { title, url: 'https://coach.example/', headings: [], text: `SOURCE PAGE: https://coach.example/\nTITLE: ${title}\n\nPrivate coaching for relationships.\n\nAnonymous\n\n${quote}\n\nTaylor Green\n\n${unrelated}` };
  const result = findTestimonials(source, 'Private coaching');
  assert.equal(result.length, 1);
  assert.equal(result[0].attribution, 'Anonymous');
  assert.equal(result[0].quote, quote);
  assert.equal(result[0].page, source.url);
  assert.equal(findTestimonials({ ...source, title: 'Pasted page copy' }, 'Private coaching').length, 1, 'Offer selection retains provider identity in the captured homepage title');
});
const framed = () => {
  const next = structuredClone(draft);
  Object.assign(next.sections.find(section => section.id === 'proof')!, {
    headline: 'Career decisions and professional confidence', body: '',
    proofFraming: { introduction: 'These individual accounts describe support with career and professional decisions.', items: [
      { id: 'E1', heading: 'Choosing a career direction' }, { id: 'E2', heading: 'Confidence in professional decisions' },
    ] },
  });
  return next;
};

test('default social proof preserves the full situation, support and change, not short highlight fragments', () => {
  const result = restoreApprovedProof(framed(), withProof);
  const section = result.sections.find(section => section.id === 'proof')!;
  assert.ok(section.body.includes(clientQuote));
  assert.ok(section.body.includes(endorsement));
  assert.ok(section.body.startsWith('These individual accounts'));
  assert.match(section.body, /Choosing a career direction/);
  assert.match(section.body, /Professional recommendation: Confidence in professional decisions/);
  assert.ok(section.body.indexOf('Sam R.') < section.body.indexOf('Pat L.'));
  assert.doesNotMatch(section.body, /https:|Category:|Quote:/);
  assert.deepEqual(draftSchema.parse(result).sections, result.sections);
  assert.equal(auditDraft(result, withProof.brief).length, 0);
});

test('the old two-quote cap is removed and every approved item that fits is retained', () => {
  const three = [...items, { ...items[0], attribution: 'Jo N., York', quote: 'I compared my career options with a practical plan and chose the role that suited my priorities.' }];
  const result = restoreApprovedProof(framed(), { ...withProof, brief: { ...withProof.brief, proof: testimonialProof(three) } });
  assert.match(result.sections.find(section => section.id === 'proof')!.body, /Jo N., York/);
});

test('legacy approved proof gains source category without importing any unapproved testimonials', () => {
  const legacyProof = `Quote:\n${endorsement}\nAttribution: Pat L., Operations Manager\nSource: https://coach.example/testimonials`;
  const reference = { title: 'Testimonials', url: 'https://coach.example/testimonials', headings: [], tone: 'preserve' as const, selectedOffer: '',
    text: `Professional Recommendations\n\nPat L., Operations Manager\n\n${endorsement}\n\nSam R., Bristol\n\n${clientQuote}` };
  const entries = approvedProofEntries({ ...withProof, brief: { ...withProof.brief, proof: legacyProof }, reference });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].category, 'Professional recommendation');
  assert.equal(approvedTestimonials(legacyProof)[0].category, undefined);
  assert.equal(approvedTestimonials(proof)[1].category, 'Professional recommendation');
});

test('older excerpt requests cannot remove or abbreviate the complete social-proof archive', () => {
  assert.equal(testimonialWordLimit({ ...withProof, context: { mode: 'current', direction: '', background: '', mustKeep: 'Headline at most 12 words.', avoid: '' } }), undefined);
  const capped = { ...withProof, context: { mode: 'current' as const, direction: '', background: '', mustKeep: 'Use one testimonial excerpt of at most 24 words.', avoid: '' } };
  assert.equal(testimonialWordLimit(capped), 24);
  const excerpt = exactExcerpt(clientQuote, 'career direction', 24);
  assert.ok(clientQuote.includes(excerpt));
  assert.match(excerpt, /^[A-Z].*[.!?]$/);
  assert.ok(excerpt.split(/\s+/).length <= 24);
  const result = restoreApprovedProof(framed(), capped);
  assert.ok(result.sections.find(section => section.id === 'proof')!.body.includes(clientQuote));
  assert.match(result.sections.find(section => section.id === 'proof')!.body, /Pat L.,/);
});

test('catalog keeps multiple paragraphs together and distinguishes training from professional recommendations', () => {
  const first = 'I was uncertain which career path would fit my priorities.';
  const second = 'With coaching I compared the options and chose my next role with confidence.';
  const source = { title: 'Testimonials', url: 'https://coach.example/testimonials', headings: [], text:
    `Personal Recommendations\n\nSam R., Bristol\n\n${first}\n\n${second}\n\nProfessional Recommendations\n\nPat L., Operations Manager\n\n${endorsement}\n\nTraining Attendee, London\n\nThis workshop helped our team understand workplace safety rules and the course was useful.` };
  const career = findTestimonials(source, 'Career Coaching');
  assert.equal(career.find(item => item.attribution === 'Sam R., Bristol')?.quote, first + '\n\n' + second);
  assert.equal(career.find(item => item.attribution === 'Pat L., Operations Manager')?.category, 'Professional recommendation');
  assert.ok(career.some(item => item.attribution.includes('Training Attendee') && item.category === 'Training feedback'));
  assert.ok(findTestimonials(source, 'Workplace training').some(item => item.category === 'Training feedback'));
  const indexed = extractionContext(source, 12_000, 'Career Coaching');
  assert.ok(byteSize(JSON.stringify(indexed.value)) <= 12_000);
});

test('generation and proof rewrites preserve framing while the server inserts complete exact quotes', async () => {
  const responses = [strategy, framed()];
  const prompts: string[] = [];
  const result = await generate(async (_system, prompt) => { prompts.push(prompt); return JSON.stringify(responses.shift()); }, withProof, new AbortController().signal, () => {});
  assert.ok(result.draft.sections.find(section => section.id === 'proof')!.body.includes(clientQuote));
  assert.match(prompts[1], /approvedEvidence/);
  assert.match(prompts[1], /Professional recommendation/);
  const proofSection = framed().sections.find(section => section.id === 'proof')!;
  const revision = await revise(async (system, prompt, _signal, maxTokens) => {
    assert.equal(maxTokens, 1800);
    assert.ok(byteSize(system + prompt) < 6000);
    assert.doesNotMatch(prompt, /CURRENT PAGE DATA/);
    return JSON.stringify({ headline: proofSection.headline, ...proofSection.proofFraming });
  }, { ...withProof, draft: result.draft, sectionId: 'proof', direction: 'stronger' }, new AbortController().signal);
  assert.ok(revision.section.body.includes(clientQuote));
  assert.match(revision.section.body, /These individual accounts/);
  assert.equal(revision.issues.length, 0);
});

test('generic social-proof headings are flagged instead of silently passing as offer-specific writing', () => {
  const bad = restoreApprovedProof(framed(), withProof);
  bad.sections.find(section => section.id === 'proof')!.headline = 'What Clients Have Said';
  assert.ok(auditDraft(bad, withProof.brief).some(issue => /specific heading/.test(issue.message)));
  bad.sections.find(section => section.id === 'proof')!.headline = 'What Clients and Professionals Say';
  assert.ok(auditDraft(bad, withProof.brief).some(issue => /specific heading/.test(issue.message)));
});

test('framing cannot invent colleague relationships or substitute hype for the actual experience', async () => {
  const bad = framed();
  bad.sections.find(section => section.id === 'proof')!.proofFraming!.introduction = 'Clients and colleagues describe the real impact of coaching.';
  const issues = auditDraft(restoreApprovedProof(bad, withProof), withProof.brief);
  assert.ok(issues.some(issue => /colleague or partner/.test(issue.message)));
  assert.ok(issues.some(issue => /promotional labels/.test(issue.message)));
  const replies = [strategy, bad, { sections: [framed().sections.find(section => section.id === 'proof')] }];
  const result = await generate(async () => JSON.stringify(replies.shift()), withProof, new AbortController().signal, () => {});
  assert.equal(replies.length, 0);
  assert.ok(result.draft.sections.find(section => section.id === 'proof')!.body.startsWith('These individual accounts'));
});

test('a focused editorial pass fixes persistent framing issues without regenerating or shortening testimony', async () => {
  const bad = framed();
  bad.sections.find(section => section.id === 'proof')!.headline = 'What Clients and Professionals Say';
  const improved = { headline: 'Career decisions and professional confidence', ...framed().sections.find(section => section.id === 'proof')!.proofFraming! };
  const replies = [strategy, bad, { sections: [bad.sections.find(section => section.id === 'proof')] }, improved];
  let editorialTokens = 0;
  const result = await generate(async (_system, _prompt, _signal, maxTokens) => {
    if (maxTokens) editorialTokens = maxTokens;
    return JSON.stringify(replies.shift());
  }, withProof, new AbortController().signal, () => {});
  assert.equal(replies.length, 0);
  assert.equal(editorialTokens, 1800);
  const section = result.draft.sections.find(section => section.id === 'proof')!;
  assert.equal(section.headline, improved.headline);
  assert.ok(section.body.includes(clientQuote) && section.body.includes(endorsement));
  assert.equal(result.issues.length, 0);
});

test('a bare quotation strip is rejected and retried with proper framing before returning a draft', async () => {
  const bare = framed();
  delete bare.sections.find(section => section.id === 'proof')!.proofFraming;
  bare.sections.find(section => section.id === 'proof')!.body = `“${clientQuote}”\nSam R., Bristol`;
  const responses = [strategy, bare, framed()];
  const result = await generate(async () => JSON.stringify(responses.shift()), withProof, new AbortController().signal, () => {});
  assert.equal(responses.length, 0);
  assert.ok(result.draft.sections.find(section => section.id === 'proof')!.body.startsWith('These individual accounts'));
});

test('full testimonials survive claim repair within the production provider request limit', async () => {
  const good = framed();
  good.sections.find(section => section.id === 'problem')!.body = 'Business coaches need to explain an existing service clearly so prospects can understand the offer. '.repeat(35);
  const bad = structuredClone(good);
  bad.sections[0].headline += ' 300%';
  const replies = [strategy, bad, { sections: [good.sections[0]] }];
  const sizes: number[] = [];
  const request = { ...withProof, reference: { title: 'Original offer', url: 'https://coach.example', headings: [], selectedOffer: '', tone: 'preserve' as const,
    text: 'The original coaching offer explains the positioning service and the business coach audience. '.repeat(2000) } };
  const completion = Object.assign(async (system: string, prompt: string) => {
    sizes.push(byteSize(system + prompt));
    assert.ok(sizes.at(-1)! <= 20_000);
    return JSON.stringify(replies.shift());
  }, { inputByteLimit: 20_000 });
  const result = await generate(completion, request, new AbortController().signal, () => {});
  assert.equal(sizes.length, 3);
  const section = result.draft.sections.find(section => section.id === 'proof')!;
  assert.ok(section.body.includes(clientQuote) && section.body.includes(endorsement));
  assert.equal(result.issues.length, 0);
});

test('a detailed model strategy cannot crowd out approved proof or make the next writing pass fail', async () => {
  const detailed = { ...strategy,
    angle: 'Explain the existing positioning offer clearly for the business coach audience. '.repeat(12),
    promise: 'Help business coaches explain their existing offer in clearer language. '.repeat(12),
    frameworkPlan: strategy.frameworkPlan.map(step => ({ ...step, application: step.application.repeat(4).slice(0, 590) })),
  };
  const replies = [detailed, framed()];
  const request = { ...withProof, reference: { title: 'Original offer', url: 'https://coach.example', headings: [], selectedOffer: '', tone: 'preserve' as const,
    text: 'The original coaching offer explains the positioning service and the business coach audience. '.repeat(2000) } };
  const completion = Object.assign(async (system: string, prompt: string) => {
    assert.ok(byteSize(system + prompt) <= 20_000);
    return JSON.stringify(replies.shift());
  }, { inputByteLimit: 20_000 });
  const result = await generate(completion, request, new AbortController().signal, () => {});
  assert.ok(result.draft.sections.find(section => section.id === 'proof')!.body.includes(clientQuote));
  assert.equal(replies.length, 0);
});

test('a smaller provider allowance after planning reduces reference material instead of dropping approved evidence', async () => {
  let calls = 0;
  const request = { ...withProof, reference: { title: 'Original offer', url: 'https://coach.example', headings: [], selectedOffer: '', tone: 'preserve' as const,
    text: 'The original coaching offer explains the positioning service and the business coach audience. '.repeat(2000) } };
  const completion = Object.assign(async (system: string, prompt: string) => {
    calls++;
    if (calls === 1) return JSON.stringify(strategy);
    if (calls === 2) { completion.inputByteLimit = 16_000; throw new ProviderSizeError(); }
    assert.ok(byteSize(system + prompt) <= 16_000);
    assert.ok(prompt.includes(clientQuote) && prompt.includes(endorsement));
    return JSON.stringify(framed());
  }, { inputByteLimit: 20_000 });
  const result = await generate(completion, request, new AbortController().signal, () => {});
  assert.equal(calls, 3);
  assert.ok(result.draft.sections.find(section => section.id === 'proof')!.body.includes(clientQuote));
});
