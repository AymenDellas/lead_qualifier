import {
  briefSchema,
  type Draft,
  type GenerationInput,
} from '../../src/lib/copy-studio/shared/contracts';

export const input: GenerationInput = {
  template: 'direct_to_call',
  formula: 'recommended',
  brief: briefSchema.parse({
    offerName: 'Clear Offer Sprint',
    description: 'A positioning service for business coaches.',
    audience: 'Independent business coaches with an existing service.',
    problem: 'Prospects struggle to understand the value of their offer.',
    outcome: 'Explain the offer in clear language.',
    mechanism: 'Review actual customer conversations.',
    deliverables: 'Positioning brief and messaging review.',
    cta: 'Book a fit call',
  }),
};
export const strategy = {
  angle: 'Make the offer easier to understand.',
  promise: 'A clearer way to explain your service.',
  objection: 'Whether another messaging exercise will be useful.',
  action: 'Book a fit call',
  missingEvidence: ['No customer results have been supplied.'],
  frameworkPlan: [
    { stage: 'Problem', application: 'Recognize that prospects struggle to understand the existing offer.', sectionIds: ['hero', 'problem'] },
    { stage: 'Agitation', application: 'Show how an unclear explanation leaves suitable prospects hesitating.', sectionIds: ['problem'] },
    { stage: 'Solution', application: 'Connect the customer-language review to a clearer offer and the fit call.', sectionIds: ['approach', 'cta'] },
  ],
};
export const draft: Draft = {
  strategy,
  sections: [
    {
      id: 'hero',
      headline: 'Make your offer easier to understand',
      body: 'For business coaches whose prospects struggle to see the value.',
      bullets: [],
      cta: 'Book a fit call',
    },
    {
      id: 'problem',
      headline: 'The cost of unclear messaging',
      body: 'Prospects hesitate when they cannot understand the offer.',
      bullets: [],
      cta: '',
    },
    {
      id: 'approach',
      headline: 'How I help clarify your offer',
      body: 'Review customer conversations to explain the offer in language they recognize.',
      bullets: [],
      cta: '',
    },
    {
      id: 'call',
      headline: 'What the conversation covers',
      body: 'See how a positioning brief and messaging review relate to your offer.',
      bullets: [],
      cta: '',
    },
    {
      id: 'fit',
      headline: 'For established business coaches',
      body: '',
      bullets: ['You already have a service.', 'You want to explain it clearly.'],
      cta: '',
    },
    { id: 'about', headline: '', body: '', bullets: [], cta: '' },
    { id: 'proof', headline: '', body: '', bullets: [], cta: '' },
    {
      id: 'objections',
      headline: 'Common questions about the sprint',
      body: 'The review starts from customer language and the offer you already deliver.',
      bullets: [],
      cta: '',
    },
    {
      id: 'cta',
      headline: 'Give your offer a clearer explanation',
      body: 'Discuss the fit for your business.',
      bullets: [],
      cta: 'Book a fit call',
    },
  ],
  notes: ['Add verified evidence before publishing a proof section.'],
};
