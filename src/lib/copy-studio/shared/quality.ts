import type { Brief, Draft, Issue, TemplateId } from './contracts';
import { templates } from './templates';
import { approvedTestimonials } from './evidence';

export const PERSUASION_REVIEW_PREFIX = 'Persuasion review: ';

export function mergeDraftIssues(draft: Draft, brief: Brief, previous: Issue[], changedIds: string[], incoming: Issue[] = []): Issue[] {
  const issues = [...auditDraft(draft, brief),
    ...previous.filter(issue => issue.message.startsWith(PERSUASION_REVIEW_PREFIX) && !changedIds.includes(issue.sectionId)),
    ...incoming.filter(issue => changedIds.includes(issue.sectionId)),
  ];
  return issues.filter((issue, index) => issues.findIndex(other => other.sectionId === issue.sectionId
    && other.message === issue.message && other.severity === issue.severity) === index);
}

const previousDirectCallIds = 'hero|problem|approach|call|fit|proof|objections|cta';
export const isGenericProofHeading = (headline: string) => /^(?:what\b.{0,70}\b(?:say|said)|testimonials|success stories|client (?:reviews|testimonials|stories)|client (?:outcomes|experiences|results)(?: and professional (?:endorsements?|recommendations?))?(?: of coaching services)?)\W*$/i.test(headline.trim());
export function isLegacyDirectCallDraft(draft: Draft, template: TemplateId): boolean {
  return template === 'direct_to_call' && draft.sections.map(s => s.id).join('|') === previousDirectCallIds;
}

export function validateStructure(draft: Draft, template: TemplateId, allowLegacy = false): void {
  const expected = templates[template].sections.map((s) => s.id);
  if (draft.sections.map((s) => s.id).join('|') !== expected.join('|') &&
      !(allowLegacy && isLegacyDirectCallDraft(draft, template)))
    throw new Error(`Sections must appear exactly once in this order: ${expected.join(', ')}`);
  for (const section of draft.sections) {
    if (
      !['proof', 'next', 'about'].includes(section.id) &&
      (!section.headline.trim() || (!section.body.trim() && section.bullets.length === 0))
    ) {
      throw new Error(`Section ${section.id} must have a headline and useful copy.`);
    }
  }
  const actionSection = template === 'lead_magnet' ? 'optin' : 'cta';
  if (!draft.sections.find((s) => s.id === actionSection)?.cta.trim())
    throw new Error('The primary conversion section needs a CTA.');
}

export function auditDraft(draft: Draft, brief: Brief): Issue[] {
  const issues: Issue[] = [];
  const facts = Object.values(brief).join(' ').toLowerCase();
  const factNumbers = new Set(
    (facts.match(/\d+(?:[.,]\d+)*%?/g) ?? []).map((v) => v.replace(/,/g, '')),
  );
  const testimonials = approvedTestimonials(brief.proof);
  const normalizeQuote = (value: string) => value.replace(/\s+/g, ' ').trim();
  const primaryCta = draft.sections.find(section => section.id === 'hero')?.cta.trim()
    || draft.sections.find(section => section.cta.trim())?.cta.trim();
  for (const section of draft.sections) {
    const copy = [section.headline, section.body, ...section.bullets, section.cta].join(' ');
    const add = (message: string, severity: Issue['severity'] = 'review') =>
      issues.push({ sectionId: section.id, severity, message });
    if (section.cta.trim() && primaryCta && section.cta.trim() !== primaryCta)
      add('Use the same approved primary CTA label throughout the page.', 'warning');
    const quoted = [...copy.matchAll(/[“"]([^“”"]{25,})[”"]/g)].map(match => match[1]);
    if (section.id === 'proof' && testimonials.length) {
      if (isGenericProofHeading(section.headline))
        add('Use a specific heading about the experiences this evidence supports, rather than a generic testimonial label.', 'warning');
      if (section.headline.trim().split(/\s+/).length > 10 || (section.proofFraming?.introduction.trim().split(/\s+/).length || 0) > 35
        || section.proofFraming?.items.some(item => item.heading.trim().split(/\s+/).length > 8 || /^(?:a |the )?(?:client|professional|customer|author|recommender) (?:achieved|notes|reports|describes|found|says)\b/i.test(item.heading)))
        add('Keep social-proof framing concise: a short topic heading, one clear introduction, and short topic phrases for the individual accounts. Put detailed result claims in the original quotations.', 'warning');
      if (/\bcolleagues|\bco-workers|\bpartners/i.test(section.proofFraming?.introduction || '') && !/\bcolleagues|\bco-workers|\bpartners/i.test(brief.proof))
        add('The testimonial source does not establish a colleague or partner relationship. Use the actual attribution and evidence category.', 'warning');
      if (/life[-‑ ]changing|real impact|incredible|remarkable|powerful results/i.test([section.proofFraming?.introduction, ...(section.proofFraming?.items.map(item => item.heading) || [])].join(' ')))
        add('Frame this testimony with its concrete situation and experience; remove promotional labels such as life-changing or real impact from the framing.', 'warning');
      const proofBody = normalizeQuote(section.body);
      const missing = testimonials.filter(item => {
        const quote = normalizeQuote(item.quote.replace(/^[“"]|[”"]$/g, '').trim());
        const author = normalizeQuote(item.attribution);
        return ![`${quote}” ${author}`, `${quote}" ${author}`, `${quote} ${author}`].some(pair => proofBody.includes(pair));
      });
      if (missing.length) add(`${missing.length} approved testimonial${missing.length === 1 ? ' is' : 's are'} missing or abbreviated, or paired with a different attribution. Keep every full quotation with its original author; feature the strongest and put the rest under Show all testimonials.`, 'warning');
      if (quoted.some(quote => !testimonials.some(item => normalizeQuote(item.quote).includes(normalizeQuote(quote)))))
        add('A testimonial quotation was changed or invented. Copy its wording from the approved evidence.', 'warning');
    }
    const prose = quoted.reduce((text, quote) => text.replace(quote, ''), copy);
    const plainProse = prose.toLowerCase().replace(/[\u2010-\u2015\u2212]/g, '-');
    const policyFacts = [brief.description, brief.deliverables, brief.price, brief.guarantee, brief.nextStep].join(' ').toLowerCase().replace(/[-\u2010-\u2015\u2212]/g, ' ');
    if (!brief.price.trim() && /\bpricing\b|\b(?:price|prices)\b/i.test(prose))
      add('Pricing is not supplied in the brief. Keep missing-price questions and booking advice in editorial notes, not public copy.', 'warning');
    const audienceWords = (brief.audience.toLowerCase().match(/[\p{L}]{3,}/gu) || [])
      .filter(word => !/^(?:the|and|for|with|who|have|their|they|are|that|want|looking|existing|independent|seeking|need|from|into|this|your)$/.test(word));
    if (section.id === 'hero' && audienceWords.length && !audienceWords.some(word => plainProse.includes(word)))
      add('The hero does not clearly identify the approved audience. Replace the generic invitation with a recognizable audience callout.', 'warning');
    if (/extend (?:the|our|your) (?:discussion|call)|(?:schedule|book|arrange|offer).{0,40}(?:follow[- ]up|another|additional|extra) (?:call|session|appointment)/i.test(plainProse)
      && !/follow up|extend (?:the|our|your) (?:discussion|call)|(?:another|additional|extra) (?:call|session|appointment)/i.test(policyFacts))
      add('Follow-up or extended-call arrangements are not confirmed in the brief. Remove this process promise.', 'warning');
    if (/lost income|loss of income|cost(?:ing)? you money|missed wages|financial strain|financial hardship/i.test(plainProse) && !/lost income|loss of income|missed wages|financial loss|financial strain|financial hardship/i.test(facts))
      add('This financial consequence is not supplied in the brief. Describe the stated practical difficulty without inventing financial stakes.', 'warning');
    if (/—/.test(prose)) add('Replace em dashes in written copy with natural sentence punctuation; preserve original testimonial wording.', 'warning');
    if (section.id === 'proof' && !brief.proof.trim() && copy.trim())
      add(
        'Proof was written without evidence in the brief. Remove it or supply a verified source.',
        'warning',
      );
    if (section.id === 'about' && !brief.coachBio?.trim() && copy.trim())
      add(
        'The About me section needs approved coach background. Add it to the brief or omit this section.',
        'warning',
      );
    const newNumbers = [...new Set(copy.match(/\d+(?:[.,]\d+)*%?/g) ?? [])].filter(
      (v) => !factNumbers.has(v.replace(/,/g, '')),
    );
    if (newNumbers.length)
      add(`Check numbers that do not appear in your brief: ${newNumbers.join(', ')}.`, 'warning');
    if (
      !brief.urgency.trim() &&
      /limited (?:spots|seats|time)|only \w+ (?:spots|seats)|(?:offer|price) ends|before (?:midnight|it'?s too late)|act (?:now|fast)|price (?:goes up|increases)/i.test(
        copy,
      )
    )
      add('This urgency is not supported by a deadline or capacity limit in the brief.', 'warning');
    if (
      !brief.guarantee.trim() &&
      /money.back|risk.free|guaranteed|refund|no.questions.asked/i.test(copy)
    )
      add('Check this guarantee or refund claim against your actual terms.', 'warning');
    const promises = plainProse.match(/no[- ]spam|never (?:share|sell) your|unsubscribe (?:anytime|at any time)|no[- ]sales[- ]pitch|no[- ]obligation|no[- ]commitment|low[- ]commitment/gi) || [];
    const assurances = [
      [/(?:not|isn'?t|isn’t) (?:a )?sales pitch/i, /no sales pitch|not (?:a )?sales pitch/i],
      [/(?:without|no)[- ](?:sales[- ])?pressure/i, /without (?:sales )?pressure|no (?:sales )?pressure/i],
      [/(?:without|no) (?:any )?(?:long[- ]term |ongoing )?commitment/i, /(?:without|no) (?:any )?(?:long term |ongoing )?commitment/i],
    ];
    if (promises.some(promise => !policyFacts.includes(promise.replace(/-/g, ' ')))
      || assurances.some(([copyPattern, factPattern]) => copyPattern.test(plainProse) && !factPattern.test(policyFacts)))
      add('This privacy or sales-process promise is not confirmed in the brief. Remove it or provide approved terms.', 'warning');
    const wordDurations = plainProse.match(/\b(?:one|two|three|four|five|six|seven|eight|nine|ten|half|an?)\s*[- ]\s*(?:minute|hour)s?\b/g) || [];
    const durationNumbers: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, half: 0.5, a: 1, an: 1 };
    const minutes = (phrase: string) => {
      const [amount, unit] = phrase.replace(/-/g, ' ').split(/\s+/);
      return (durationNumbers[amount] ?? Number(amount)) * (unit.startsWith('hour') ? 60 : 1);
    };
    const approvedDurations = policyFacts.match(/\b(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|half|an?)\s+(?:minute|hour)s?\b/g) || [];
    if (wordDurations.some(duration => !approvedDurations.some(approved => minutes(duration) === minutes(approved))))
      add('The call or session duration is not confirmed in the brief, including durations written in words. Remove it or provide the actual duration.', 'warning');
    if (/\b(?:free|complimentary)\b/i.test(copy) && !/\b(?:free|complimentary)\b/i.test(facts))
      add('The brief does not confirm that this offer or next step is free.', 'warning');
    if (/unlock (?:your |their |full )?potential|game.changer|revolutionary|transform your life|\bleverage\b/i.test(prose))
      add('Replace the broad claim with a specific, supported benefit.', 'warning');
    if (/\[(?!VIDEO PLACEHOLDER\])[^\]]+\]/.test(copy))
      add('Resolve the placeholder before using this copy.');
    if (section.id === 'hero' && section.headline.split(/\s+/).length > 12)
      add('Consider shortening the hero headline to 12 words or fewer.');
  }
  return issues;
}
