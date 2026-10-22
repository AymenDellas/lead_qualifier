import test from 'node:test';
import assert from 'node:assert/strict';
import { generate, revise } from '../../src/lib/copy-studio/server/engine';
import { PERSUASION_EDITOR, reviewPersuasion } from '../../src/lib/copy-studio/server/persuasion-review';
import { completionDeadline, type Completion } from '../../src/lib/copy-studio/server/provider';
import { auditDraft, mergeDraftIssues, PERSUASION_REVIEW_PREFIX } from '../../src/lib/copy-studio/shared/quality';
import { sectionWritingRole } from '../../src/lib/copy-studio/shared/persuasion';
import { sectionAngleOptions, supportsRevision } from '../../src/lib/copy-studio/shared/revision-options';
import { revisionSchema, type Draft } from '../../src/lib/copy-studio/shared/contracts';
import { draft, input, strategy } from './fixtures';

const signal = () => new AbortController().signal;
const generic = (): Draft => {
  const result = structuredClone(draft);
  result.sections[0] = { ...result.sections[0], headline: 'Gain clarity and confidence', body: 'For business coaches ready for a personalized roadmap.' };
  return result;
};
const finding = { sectionId: 'hero', quote: 'Gain clarity and confidence',
  problem: 'The PAS opening gives interchangeable benefits without recognizing why prospects hesitate.',
  change: 'Recognize that prospects struggle to understand the value of the coach’s existing offer.' };
const pass = { findings: [] };

test('a separate editorial review repairs a generic PAS hero using actual cited copy, without changing the rest of the page', async () => {
  const replies = [strategy, generic(), { findings: [finding] }, { sections: [draft.sections[0]] }, pass];
  const calls: string[] = [];
  const result = await generate(async (system, prompt) => {
    calls.push(system);
    if (system.startsWith(PERSUASION_EDITOR)) {
      assert.match(prompt, /Gain clarity and confidence|Make your offer easier to understand/);
      assert.match(system, /not whether the strategy merely lists/);
    }
    return JSON.stringify(replies.shift());
  }, input, signal(), () => {});
  assert.equal(replies.length, 0);
  assert.equal(calls.filter(system => system.startsWith(PERSUASION_EDITOR)).length, 2);
  assert.deepEqual(result.draft.sections, draft.sections);
  assert.equal(result.draft.strategy.framework?.id, 'pas');
  assert.deepEqual(result.issues, []);
});

test('editorial findings must cite editable text from the allowed section, never an invented phrase or a different section', async () => {
  let count = 0;
  const result = await reviewPersuasion(async () => {
    count++;
    return JSON.stringify({ findings: [{ ...finding, quote: 'This phrase does not exist' }] });
  }, input, generic(), signal(), ['hero']);
  assert.equal(count, 2);
  assert.deepEqual(result.findings, []);
  assert.match(result.issues[0].message, /could not finish/);
  const wrong = await reviewPersuasion(async () => JSON.stringify({ findings: [{ ...finding, sectionId: 'problem', quote: draft.sections[1].headline }] }),
    input, draft, signal(), ['hero']);
  assert.deepEqual(wrong.findings, []);
  assert.match(wrong.issues[0].message, /could not finish/);
});

test('a program deliverable promised on a discovery call is repaired without inventing a replacement benefit', async () => {
  const bad = structuredClone(draft);
  bad.sections[3].body = 'Leave the fit call with your finished positioning brief.';
  const scoped = { ...input, brief: { ...input.brief, nextStep: 'Book a fit call to discuss whether the positioning service fits your needs.' } };
  const review = { findings: [{ sectionId: 'call', quote: bad.sections[3].body,
    problem: 'A program deliverable is promised during the fit call without confirmation.',
    change: 'Describe discussing fit, as confirmed in nextStep; keep the positioning brief as a service deliverable.' }] };
  const replies = [strategy, bad, review, { sections: [draft.sections[3]] }, pass];
  const result = await generate(async () => JSON.stringify(replies.shift()), scoped, signal(), () => {});
  assert.equal(result.draft.sections[3].body, draft.sections[3].body);
  assert.deepEqual(result.issues, []);
});

test('repair is bounded and unresolved weaknesses remain visible as review points', async () => {
  const replies = [strategy, generic(), { findings: [finding] }, { sections: [generic().sections[0]] }, { findings: [finding] }];
  const result = await generate(async () => JSON.stringify(replies.shift()), input, signal(), () => {});
  assert.equal(replies.length, 0);
  assert.equal(result.issues.length, 1);
  assert.ok(result.issues[0].message.startsWith(PERSUASION_REVIEW_PREFIX));
});

test('a failed editorial repair retains the usable draft and its finding; new unsupported claims or CTA changes cannot replace it', async () => {
  for (const changed of [
    { ...draft.sections[0], headline: 'Guaranteed 300% growth' },
    { ...draft.sections[0], cta: 'Buy the program' },
    { ...draft.sections[0], id: 'cta' },
  ]) {
    const replies = [strategy, generic(), { findings: [finding] }, { sections: [changed] }, { sections: [changed] }];
    const result = await generate(async () => JSON.stringify(replies.shift()), input, signal(), () => {});
    assert.equal(result.draft.sections[0].headline, finding.quote);
    assert.equal(result.draft.sections[0].cta, draft.sections[0].cta);
    assert.match(result.issues[0].message, /interchangeable/);
  }
});

test('editorial provider failures and excessive context are disclosed without losing completed copy or exposing private errors', async () => {
  const replies = [strategy, draft];
  const result = await generate(async system => {
    if (system.startsWith(PERSUASION_EDITOR)) throw new Error('secret upstream detail');
    return JSON.stringify(replies.shift());
  }, input, signal(), () => {});
  assert.equal(result.draft.sections[0].headline, draft.sections[0].headline);
  assert.match(result.issues[0].message, /could not finish/);
  assert.doesNotMatch(JSON.stringify(result.issues), /secret/);
  let called = false;
  const complete: Completion = Object.assign(async () => { called = true; return JSON.stringify(pass); }, { inputByteLimit: 100 });
  const tooLarge = await reviewPersuasion(complete, input, draft, signal(), ['hero']);
  assert.equal(called, false);
  assert.match(tooLarge.issues[0].message, /could not finish/);
});

test('cancelling an editorial check propagates cancellation instead of returning a reviewed result', async () => {
  const controller = new AbortController();
  await assert.rejects(reviewPersuasion(async () => {
    controller.abort(new Error('Operator cancelled'));
    throw controller.signal.reason;
  }, input, draft, controller.signal, ['hero']), /Operator cancelled/);
});

test('late completed copy is returned with visible review flags before the enclosing request deadline', async t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  const result = await generate(async () => {
    calls++;
    if (calls === 1) return JSON.stringify(strategy);
    assert.equal(calls, 2, 'An exhausted editorial budget must not start another provider request');
    now += 271_000;
    return JSON.stringify(draft);
  }, input, signal(), () => {});
  assert.equal(calls, 2);
  assert.deepEqual(result.draft.sections, draft.sections);
  assert.ok(result.issues.length > 0);
  assert.ok(result.issues.every(issue => issue.message.startsWith(PERSUASION_REVIEW_PREFIX) && /could not finish/.test(issue.message)));
});

test('an editorial repair that exhausts its budget preserves the existing draft and actionable finding', async t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const replies = [strategy, generic(), { findings: [finding] }, { sections: [draft.sections[0]] }];
  const result = await generate(async () => {
    const next = replies.shift();
    if (!replies.length) now += 151_000;
    return JSON.stringify(next);
  }, input, signal(), () => {});
  assert.equal(replies.length, 0);
  assert.equal(result.draft.sections[0].headline, finding.quote);
  assert.match(result.issues[0].message, /interchangeable/);
});

test('editorial deadlines abort slow provider calls while leaving the enclosing generation active', async () => {
  let aborted = false;
  const parent = new AbortController();
  const slow: Completion = (_system, _prompt, callSignal) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(JSON.stringify(pass)), 5000);
    const abort = () => {
      aborted = true;
      clearTimeout(timer);
      reject(callSignal.reason);
    };
    if (callSignal.aborted) abort();
    else callSignal.addEventListener('abort', abort, { once: true });
  });
  slow.inputByteLimit = 80_000;
  const bounded = completionDeadline(slow, Date.now() + 300);
  bounded.inputByteLimit = 70_000;
  assert.equal(slow.inputByteLimit, 70_000);
  await assert.rejects(bounded('', '', parent.signal), /time|abort/i);
  assert.equal(aborted, true);
  assert.equal(parent.signal.aborted, false);
  const result = await reviewPersuasion(bounded, input, draft, parent.signal, ['hero']);
  assert.match(result.issues[0].message, /could not finish/);
});

test('section angles preserve the page framework and the full role survives compact requests', async () => {
  const calls: { system: string; prompt: string }[] = [];
  const request = { ...input, draft, sectionId: 'hero', direction: 'problem_led' as const };
  const complete: Completion = Object.assign(async (system: string, prompt: string) => {
    calls.push({ system, prompt });
    assert.ok(Buffer.byteLength(system + prompt) <= 20_000);
    return JSON.stringify(system.startsWith(PERSUASION_EDITOR) ? pass : draft.sections[0]);
  }, { inputByteLimit: 20_000 });
  const result = await revise(complete, request, signal());
  assert.equal(result.section.id, 'hero');
  assert.equal(request.formula, 'recommended');
  assert.equal(request.draft.strategy.framework, undefined);
  const writing = calls.find(call => !call.system.startsWith(PERSUASION_EDITOR))!;
  assert.match(writing.prompt, /SECTION WRITING ROLE/);
  assert.match(writing.prompt, /present difficulty recognizable/);
  assert.match(writing.prompt, /No invented stakes/);
  assert.doesNotMatch(writing.system, /hero remains outcome-led/);
  assert.equal(revisionSchema.parse(request).direction, 'problem_led');
});

test('section rewrites review only that section and cannot repair another part of the page', async () => {
  const replies = [generic().sections[0], { findings: [finding] }, { sections: [draft.sections[0]] }, pass];
  const result = await revise(async (system, prompt) => {
    if (system.startsWith(PERSUASION_EDITOR)) assert.match(prompt, /"focusIds":\["hero"\]/);
    return JSON.stringify(replies.shift());
  }, { ...input, draft, sectionId: 'hero', direction: 'problem_led' }, signal());
  assert.deepEqual(result.section, draft.sections[0]);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(draft.sections[1], generic().sections[1]);
});

test('angle choices fit section roles and cannot be applied to protected testimonials', async () => {
  assert.equal(sectionAngleOptions('hero').length, 4);
  assert.equal(sectionAngleOptions('proof').length, 0);
  assert.equal(supportsRevision('about', 'difference_led'), true);
  assert.equal(supportsRevision('about', 'problem_led'), false);
  let called = false;
  await assert.rejects(revise(async () => { called = true; return '{}'; }, { ...input, draft, sectionId: 'proof', direction: 'problem_led' }, signal()), /does not fit/);
  assert.equal(called, false);
});

test('framework opening guidance differs by framework and never forces an outcome headline on PAS', () => {
  for (const formula of ['pas', 'aida', 'bab', 'star', 'fourps'] as const) {
    const role = sectionWritingRole({ ...input, formula }, 'hero');
    assert.ok(role.stages.length);
    assert.doesNotMatch(role.instruction, /outcome-led headline/);
  }
  assert.match(sectionWritingRole(input, 'hero').instruction, /present difficulty/);
  assert.match(sectionWritingRole({ ...input, formula: 'star' }, 'hero').instruction, /documented situation/);
});

test('an editor cannot invent a problem-only PAS restriction to reject a recognizable problem-plus-benefit headline', async () => {
  let calls = 0;
  const result = await reviewPersuasion(async () => JSON.stringify(++calls === 1 ? { findings: [{ ...finding,
    problem: 'A benefit violates the assigned problem-only hero role.' }] } : pass), input, generic(), signal(), ['hero']);
  assert.equal(calls, 2);
  assert.deepEqual(result, { findings: [], issues: [] });
});

test('conversational sales-process assurances still require approval rather than slipping past no-sales-pitch checks', () => {
  for (const body of ['It is not a sales pitch.', 'The conversation happens without sales pressure.', 'There is no pressure.']) {
    const page = { ...draft, sections: [{ ...draft.sections[3], body }] };
    assert.ok(auditDraft(page, input.brief).some(issue => /sales-process promise/.test(issue.message)));
    assert.ok(!auditDraft(page, { ...input.brief, nextStep: 'The call is not a sales pitch and happens without sales pressure.' })
      .some(issue => /sales-process promise/.test(issue.message)));
  }
  const page = { ...draft, sections: [{ ...draft.sections[0], body: 'For business coaches, without any long-term commitment.' }] };
  assert.ok(auditDraft(page, { ...input.brief, nextStep: 'The call is not a sales pitch.' }).some(issue => /sales-process promise/.test(issue.message)));
  assert.ok(!auditDraft(page, { ...input.brief, nextStep: 'Book a call without any long-term commitment.' }).some(issue => /sales-process promise/.test(issue.message)));
});

test('several unsupported sections are repaired in bounded batches while unchanged copy stays intact', async () => {
  const bad = structuredClone(draft);
  for (const id of ['hero', 'problem', 'approach', 'call', 'cta']) bad.sections.find(section => section.id === id)!.body += ' Guaranteed 300% growth.';
  let writing = 0;
  const result = await generate(async (system, prompt) => {
    assert.ok(Buffer.byteLength(system + prompt) <= 20_000);
    if (system.startsWith(PERSUASION_EDITOR)) return JSON.stringify(pass);
    writing++;
    if (writing === 1) return JSON.stringify(strategy);
    if (writing === 2) return JSON.stringify(bad);
    const data = JSON.parse(prompt.split('\nDRAFT DATA: ')[1].split('\nWARNINGS:')[0]);
    assert.ok(data.sections.length <= 2);
    return JSON.stringify({ sections: data.sections.map((section: { id: string }) => draft.sections.find(old => old.id === section.id)) });
  }, input, signal(), () => {});
  assert.equal(writing, 5);
  assert.deepEqual(result.draft.sections, draft.sections);
  assert.deepEqual(result.issues, []);
});

test('unrelated rewrites and manual edits cannot silently erase unresolved editorial findings', () => {
  const issues = [{ sectionId: 'hero', severity: 'review' as const, message: `${PERSUASION_REVIEW_PREFIX}Opening needs a recognizable situation.` }];
  assert.deepEqual(mergeDraftIssues(draft, input.brief, issues, ['cta']), issues);
  assert.deepEqual(mergeDraftIssues(draft, input.brief, issues, []), issues);
  assert.deepEqual(mergeDraftIssues(draft, input.brief, issues, ['hero'], []), []);
  assert.deepEqual(mergeDraftIssues(draft, input.brief, [], ['hero'], issues), issues);
});

test('missing-price booking instructions belong in notes rather than invented public objection answers', () => {
  const page = { ...draft, sections: [{ ...draft.sections[7], body: 'Pricing and program length are not listed here. Ask when you book.' }] };
  assert.ok(auditDraft(page, input.brief).some(issue => /missing-price questions/.test(issue.message)));
  assert.ok(!auditDraft(page, { ...input.brief, price: '$750' }).some(issue => /missing-price questions/.test(issue.message)));
});
