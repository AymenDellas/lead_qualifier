import type { TemplateId, FormulaId } from './contracts';

export type OutlineSection = { id: string; name: string; purpose: string; instruction: string };
export type Template = {
  id: TemplateId;
  name: string;
  short: string;
  description: string;
  action: string;
  sections: OutlineSection[];
};
const s = (id: string, name: string, purpose: string, instruction: string): OutlineSection => ({
  id,
  name,
  purpose,
  instruction,
});
export const templates: Record<TemplateId, Template> = {
  direct_to_call: {
    id: 'direct_to_call',
    name: 'Direct to call',
    short: 'Book a conversation',
    description: 'A focused page that turns the right visitors into qualified calls.',
    action: 'Book a discovery call',
    sections: [
      s(
        'hero',
        'The first impression',
        'Make this audience’s situation and the relevant next step immediately recognizable.',
        'An audience callout in body, a specific headline of at most 12 words, concise supporting context, and the primary CTA. Follow the selected framework’s opening role rather than imposing a benefit headline on every framework. Describe only confirmed discovery-call outcomes; program deliverables do not automatically happen on the call.',
      ),
      s(
        'problem',
        'The problem',
        'Show that you understand their situation.',
        'Write a short descriptive heading about this audience’s actual difficulty. Use 3–4 grounded sentences to recognize it and its practical cost, without inventing consequences or using fear or shame.',
      ),
      s(
        'approach',
        'How I help',
        'Connect their problem to your approach.',
        'Write a specific heading naming the kind of support relevant to this situation. Explain how the approved mechanism addresses the stated problem. Do not invent methods or follow-through services.',
      ),
      s(
        'call',
        'What the conversation covers',
        'Make the next step feel concrete.',
        'Give this conversation a clear descriptive heading based on its actual purpose. Describe only the confirmed call details in a short paragraph or up to 4 bullets. Distinguish the discovery conversation from paid-program deliverables; do not promise a plan, coaching sessions or ongoing support on the call unless explicitly confirmed for that call.',
      ),
      s(
        'fit',
        'Who this is for',
        'Help qualified visitors recognize themselves.',
        'Give this section a natural descriptive heading identifying the audience or fit. Use up to 3 concise criteria drawn from the approved audience. Do not invent exclusions or eligibility rules.',
      ),
      s(
        'about',
        'About me',
        'Introduce the coach and explain their relevant background.',
        'Use the supplied coach’s actual name in a natural introduction heading. Write a concise personal introduction from approved coachBio facts only. Connect relevant experience to this audience without inventing credentials, personal stories or results. If coachBio is empty, leave this section empty and request it in notes.',
      ),
      s(
        'proof',
        'Client results & evidence',
        'Support the promise with evidence.',
        'Build a complete social-proof section with a descriptive heading about the actual evidence, a grounded introduction, and topic-specific headings for the approved testimonials. Preserve each client’s situation, support and change in full relevant testimony, not isolated fragments. Put directly relevant client experiences first and clearly distinguish professional recommendations. The server renders exact approved quotations and attributions from proofFraming IDs. Do not generalize individual results. If proof is absent, leave this section empty and explain in notes.',
      ),
      s(
        'objections',
        'Questions & concerns',
        'Answer real reasons for hesitation.',
        'Use a descriptive heading about the actual concerns addressed here. Answer supplied objections using approved facts. If none are supplied, clarify a reasonable question about the known offer. Do not introduce price, commitment, policies or sales-process assurances that the brief does not confirm.',
      ),
      s(
        'cta',
        'The next step',
        'Give them one clear action.',
        'Restate the outcome, describe the confirmed next step, and use the same primary CTA as the hero. Include price, terms, guarantee, or real urgency only if provided and relevant.',
      ),
    ],
  },
  lead_magnet: {
    id: 'lead_magnet',
    name: 'Lead magnet',
    short: 'Grow your email list',
    description: 'A concise opt-in page that makes the value of your resource tangible.',
    action: 'Send me the resource',
    sections: [
      s(
        'hero',
        'The first impression',
        'Sell the outcome of the resource.',
        'A specific headline of at most 12 words, audience-specific support, and one CTA. Follow the selected framework’s opening role while explaining the supplied resource’s relevance. Say free only if explicitly confirmed.',
      ),
      s(
        'inside',
        'What is inside',
        'Make the resource worth the opt-in.',
        '3–5 benefit-led bullets, each tied to a supplied deliverable. No invented chapters, templates, or numbers.',
      ),
      s(
        'fit',
        'Made for them',
        'Confirm this solves their particular problem.',
        '2–3 short statements about the supplied audience and use case.',
      ),
      s(
        'proof',
        'Why this resource',
        'Establish a reason to trust it.',
        'Use only supplied evidence, exact quotes if available. If there is no proof, return empty fields and note the omission.',
      ),
      s(
        'optin',
        'The opt-in',
        'Make the exchange clear and simple.',
        'A short form headline and explanation, email field label as a bullet, and a resource-specific CTA. Do not ask for unnecessary personal data.',
      ),
      s(
        'next',
        'What happens next',
        'Set honest expectations.',
        'Use the stated delivery and follow-up details only. Never invent privacy commitments, unsubscribe promises, no-spam claims, or instant delivery. If unknown, leave blank and put a note in notes.',
      ),
    ],
  },
  vsl: {
    id: 'vsl',
    name: 'Video sales letter',
    short: 'Turn attention into action',
    description: 'A page that earns the video view, builds conviction, and invites action.',
    action: 'Book a discovery call',
    sections: [
      s(
        'hero',
        'The first impression',
        'Earn attention with a relevant promise.',
        'An audience callout, a headline of at most 12 words, one sentence of supporting context. No invented timeframes or guarantees.',
      ),
      s(
        'video',
        'The video invitation',
        'Give them a reason to press play.',
        'Write a short viewer-facing invitation, the literal [VIDEO PLACEHOLDER], and a CTA below. Put editorial video guidance in notes, not body.',
      ),
      s(
        'outcomes',
        'What becomes possible',
        'Translate features into useful outcomes.',
        'Exactly 3 benefit bullets based on the supplied offer. Do not begin bullets with You will or Learn how to.',
      ),
      s(
        'approach',
        'Why this approach',
        'Explain the mechanism without hype.',
        'Connect the confirmed mechanism and deliverables to the stated problem. No invented founder story or proprietary process.',
      ),
      s(
        'proof',
        'Reasons to believe',
        'Substantiate the promise.',
        'Use supplied proof only, preserving quotations. If absent, return empty fields and put a proof request in notes.',
      ),
      s(
        'fit',
        'Is this right for them?',
        'Help visitors assess the fit.',
        '3–4 specific audience-fit bullets based on the brief. Only state exclusions if supplied.',
      ),
      s(
        'objections',
        'The remaining questions',
        'Resolve the biggest doubts.',
        'Address the top 2 supplied objections using known facts. Do not manufacture policies, assurances, or credentials.',
      ),
      s(
        'cta',
        'The next step',
        'Move from interest to one action.',
        'A short outcome recap, verified next-step details, and the same primary CTA. Include only supplied price/terms/urgency where useful.',
      ),
    ],
  },
};
export const formulas: Record<FormulaId, { name: string; description: string }> = {
  recommended: { name: 'Recommended', description: 'Match the persuasion flow to the page goal.' },
  pas: { name: 'PAS', description: 'Problem → Agitation → Solution' },
  aida: { name: 'AIDA', description: 'Attention → Interest → Desire → Action' },
  bab: {
    name: 'Before / After / Bridge',
    description: 'Current situation → Desired outcome → Credible path',
  },
  star: {
    name: 'STAR',
    description: 'Situation → Task → Action → Result. Uses case-study facts only when supplied.',
  },
  fourps: { name: '4 Ps', description: 'Promise → Picture → Proof → Push' },
};
