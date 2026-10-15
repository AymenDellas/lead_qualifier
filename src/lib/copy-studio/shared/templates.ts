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
        'Make the outcome immediately clear.',
        'An audience callout in body, an outcome-led headline of at most 12 words, one specific subheadline, and the primary CTA.',
      ),
      s(
        'problem',
        'The problem',
        'Show that you understand their situation.',
        'Use a descriptive title naming the problem or its impact, such as The impact on your work, made specific to this audience. Do not use a standalone slogan or another hero-style claim. Name the current struggle in 3–4 grounded sentences. Describe the practical cost of inaction without fear or shame.',
      ),
      s(
        'approach',
        'How I help',
        'Connect their problem to your approach.',
        'Use a clear title introducing the support or approach, such as How I help or Practical coaching for the supplied audience. Explain why the stated mechanism addresses the problem. Focus on the call or offer as described, without inventing services.',
      ),
      s(
        'call',
        'What the conversation covers',
        'Make the next step feel concrete.',
        'Use a clear descriptive title such as What the conversation covers. Write 3–4 bullets drawn from verified deliverables or next-step details. Do not invent call duration, a free audit, deliverables, or a no-sales guarantee.',
      ),
      s(
        'fit',
        'Who this is for',
        'Help qualified visitors recognize themselves.',
        'Use a clear title such as Who this is for. Write 3 concise audience-fit bullets. Do not invent exclusions or eligibility requirements.',
      ),
      s(
        'about',
        'About me',
        'Introduce the coach and explain their relevant background.',
        'Use a straightforward title such as About me, or Meet followed by the supplied coach name. Write a concise, personal introduction using only brief.coachBio: the supplied name, relevant background, experience, credentials, and why their work is relevant to this audience. Prefer first person for an individual coach, matching the supplied voice. Connect the actual background to the visitor situation without promising results. Do not invent years, qualifications, personal divorce or life stories, achievements, client counts, or a reason for starting the business. Do not borrow a testimonial author biography. If coachBio is empty, leave headline/body/CTA empty and bullets empty, and request the coach background in editorial notes.',
      ),
      s(
        'proof',
        'Client results & evidence',
        'Support the promise with evidence.',
        'Use a descriptive title matching the supplied evidence, such as Client testimonials when actual testimonials are present. Use only supplied proof. Keep exact quotations exact. If absent, leave headline/body/CTA empty and bullets empty; put the missing proof in notes, never fake proof in the page.',
      ),
      s(
        'objections',
        'Questions & concerns',
        'Answer real reasons for hesitation.',
        'Use a clear title introducing questions or hesitation, such as Common questions or Two reasons the supplied audience hesitates. Address the 2 most relevant supplied objections with brief grounded paragraphs. Do not invent policies or facts to answer them.',
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
        'An outcome-led headline of at most 12 words, audience-specific subheadline, and one CTA. Say free only if explicitly confirmed.',
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
