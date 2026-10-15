import type { Brief, Draft, Issue, TemplateId } from './contracts';
import { templates } from './templates';

const previousDirectCallIds = 'hero|problem|approach|call|fit|proof|objections|cta';
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
  for (const section of draft.sections) {
    const copy = [section.headline, section.body, ...section.bullets, section.cta].join(' ');
    const add = (message: string, severity: Issue['severity'] = 'review') =>
      issues.push({ sectionId: section.id, severity, message });
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
    if (
      /(?:no spam|never (?:share|sell) your|unsubscribe (?:anytime|at any time)|no sales pitch|no obligation|no commitment)/i.test(
        copy,
      )
    )
      add('Confirm this privacy or sales-process promise before publishing.');
    if (/\b(?:free|complimentary)\b/i.test(copy) && !/\b(?:free|complimentary)\b/i.test(facts))
      add('The brief does not confirm that this offer or next step is free.', 'warning');
    if (/unlock your potential|game.changer|revolutionary|transform your life/i.test(copy))
      add('Replace the broad claim with a specific, supported benefit.');
    if (/\[(?!VIDEO PLACEHOLDER\])[^\]]+\]/.test(copy))
      add('Resolve the placeholder before using this copy.');
    if (section.id === 'hero' && section.headline.split(/\s+/).length > 12)
      add('Consider shortening the hero headline to 12 words or fewer.');
  }
  return issues;
}
