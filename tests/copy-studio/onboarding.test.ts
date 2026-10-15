import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_OFFER, blankOpportunity, buildProject, type ClientProject } from '../../src/lib/business';
import { matchOnboardings, toOnboardingBrief } from '../../src/lib/copy-studio/shared/onboarding';
import { briefSchema, copyContextSchema, fingerprint, projectSchema } from '../../src/lib/copy-studio/shared/contracts';
import { changeOfferContext } from '../../src/lib/copy-studio/shared/workspace';
import { input } from './fixtures';

function client(id = 'client-a', landingPage = 'https://coach.example/executive'): ClientProject {
  const data = buildProject({ ...blankOpportunity(), name: 'Example Coach', funnel: 'VSL', fee: 4000 }, DEFAULT_OFFER);
  data.onboarding!.clientName = 'Example Coach';
  data.onboarding!.website = 'https://www.coach.example/';
  Object.assign(data.onboarding!.form, {
    offer: 'Executive Program\nSix individual sessions.', audience: 'Newly promoted leaders',
    customerProblem: 'Leading former peers', desiredOutcome: 'Lead with clearer expectations',
    landingPageUrl: landingPage, mustStay: 'Keep the approved positioning', avoid: 'Do not promote the group course',
    trafficSources: 'LinkedIn', importantContext: 'Visitors are considering their first management role.',
    differentiation: 'We work through decisions from your actual week instead of a fixed course.',
    unsuitableClients: 'People seeking done-for-you team management.',
  });
  data.onboarding!.payment.price = 4000;
  data.onboarding!.portalToken = 'private-token';
  data.onboarding!.agreement.signedPdfData = 'private-signature';
  return { id, opportunityId: 'opportunity', offerVersion: 1, revision: 3, updatedAt: '2026-10-12T12:00:00Z', data };
}

test('onboarding maps client offer answers while excluding agency fees, deliverables and private portal data', () => {
  const record = toOnboardingBrief(client())!;
  assert.equal(record.brief.offerName, 'Executive Program');
  assert.equal(record.brief.description, 'Executive Program\nSix individual sessions.');
  assert.equal(record.brief.audience, 'Newly promoted leaders');
  assert.equal(record.template, 'vsl');
  assert.equal(record.context.avoid, 'Do not promote the group course');
  assert.match(record.context.background, /Traffic sources: LinkedIn/);
  assert.match(record.context.background, /first management role/);
  assert.equal(record.brief.mechanism, 'We work through decisions from your actual week instead of a fixed course.');
  assert.match(record.context.background, /Unsuitable clients.*People seeking done-for-you team management/);
  assert.equal(record.brief.price, '');
  assert.equal(record.brief.deliverables, '');
  assert.equal(record.brief.proof, '');
  assert.doesNotMatch(JSON.stringify(record), /private-token|private-signature|4000|Nurture email sequence/);
});

test('client detection normalizes www and ranks exact landing pages before other same-domain projects', () => {
  const executive = toOnboardingBrief(client())!;
  const group = toOnboardingBrief(client('client-b', 'https://coach.example/group'))!;
  const unrelated = { ...group, id: 'unrelated', website: 'https://unrelated.example', landingPageUrl: 'https://unrelated.example/group' };
  assert.deepEqual(matchOnboardings([group, unrelated, executive], 'https://www.coach.example/executive/?campaign=test').map((item) => item.id), ['client-a', 'client-b']);
  assert.deepEqual(matchOnboardings([executive], 'https://coach.example.attacker.test/executive'), []);
  assert.deepEqual(matchOnboardings([executive], 'invalid input'), []);
});

test('a different offer gets a clean brief and switching back restores the old offer facts', () => {
  const project = projectSchema.parse({
    id: 'project', name: input.brief.offerName, updatedAt: '', ...input,
    brief: { ...input.brief, proof: 'A real quote for the original offer', price: '$750' },
    result: null, source: null, generatedFrom: null, history: [],
  });
  const focused = changeOfferContext(project, copyContextSchema.parse({ mode: 'focused' }));
  assert.equal(focused.brief.offerName, '');
  assert.equal(focused.brief.price, '');
  assert.equal(focused.brief.proof, '');
  focused.brief = briefSchema.parse({ offerName: 'Executive Program', description: 'Six coaching sessions', price: '$2000' });
  const restored = changeOfferContext(focused, copyContextSchema.parse({}));
  assert.deepEqual(restored.brief, project.brief);
  assert.equal(changeOfferContext(restored, copyContextSchema.parse({ mode: 'focused' })).brief.price, '$2000');
  assert.equal(projectSchema.parse(restored).onboarding, null);
});

test('old projects retain their fingerprints while direction changes invalidate a previous draft', () => {
  assert.equal(fingerprint(input), fingerprint({ ...input, context: copyContextSchema.parse({}) }));
  assert.notEqual(fingerprint(input), fingerprint({ ...input, context: copyContextSchema.parse({ direction: 'Focus on newly promoted leaders' }) }));
});
