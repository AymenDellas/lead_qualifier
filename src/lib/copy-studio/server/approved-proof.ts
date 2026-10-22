import type { Brief, Draft, GenerationInput } from '../shared/contracts';
import { approvedTestimonials } from '../shared/evidence';
import { findTestimonials } from './testimonials';
import { AppError } from './errors';

export function approvedProofEntries(input: GenerationInput) {
  const captured = input.reference ? findTestimonials(input.reference, input.brief.offerName) : [];
  return approvedTestimonials(input.brief.proof).map((item, index) => ({
    ...item, id: `E${index + 1}`,
    category: item.category || captured.find(candidate => candidate.attribution === item.attribution
      && candidate.quote === item.quote)?.category || 'Client experience',
  })).sort((a, b) => Number(a.category === 'Training feedback') - Number(b.category === 'Training feedback')
    || evidenceStrength(b.quote, input.brief) + Number(b.category === 'Client experience') * 2
      - evidenceStrength(a.quote, input.brief) - Number(a.category === 'Client experience') * 2);
}

function evidenceStrength(quote: string, brief: Brief): number {
  const terms = [...new Set(`${brief.offerName} ${brief.problem} ${brief.outcome}`.toLowerCase().match(/[\p{L}]{4,}/gu) || [])]
    .filter(term => !/^(?:with|that|this|their|your|from|have|they|what|into|than|more|coaching|coach|service|offer)$/.test(term));
  const copy = quote.toLowerCase();
  return terms.filter(term => copy.includes(term)).length * 3
    + (/\b(?:chose|decided|secured|landed|promoted|launched|achieved|changed|started|was able|have been able)\b/i.test(quote) ? 6 : 0)
    + (/\b(?:before|when|initially|uncertain|struggl|transition|did not know)\b/i.test(quote) ? 3 : 0)
    + (/helped|support|worked with|coaching/i.test(quote) ? 2 : 0);
}

/** Whole quotes fit the writing context or stay in the archive; never make excerpts. */
export function proofForModel(input: GenerationInput, budget = 12_000): string {
  if (Buffer.byteLength(input.brief.proof, 'utf8') <= budget) return input.brief.proof;
  const entries = approvedProofEntries(input);
  if (!entries.length) throw new AppError(400, 'This unstructured proof exceeds the writing allowance. Split it into complete Quote / Attribution records rather than shortening testimony.');
  const extra = input.brief.proof.replace(/(?:^|\n)Quote:\n[\s\S]*?\nAttribution: [^\n]+(?:\nSource: [^\n]+)?(?:\nCategory: [^\n]+)?/g, '').trim();
  const parts = [extra, `ARCHIVE CONTEXT (not public copy): ${entries.length} complete approved testimonials are retained and inserted by the server. Only whole accounts that fit this writing context are repeated below. Do not infer that omitted accounts lack evidence, rewrite them, or invent their contents.`].filter(Boolean);
  for (const entry of entries.slice(0, 3)) {
    const block = `${entry.id}\nQuote:\n${entry.quote}\nAttribution: ${entry.attribution}\nCategory: ${entry.category}`;
    if (Buffer.byteLength([...parts, block].join('\n\n'), 'utf8') <= budget) parts.push(block);
  }
  return parts.join('\n\n');
}

export function testimonialWordLimit(input: GenerationInput): number | undefined {
  const instructions = [input.context?.mustKeep, input.context?.direction].filter(Boolean).join('\n');
  const match = instructions.match(/(?:testimonial|quote|excerpt)[^.!?\n]{0,70}?(?:at most|maximum of|no more than) (\d+) words/i)
    || instructions.match(/(?:at most|maximum of|no more than) (\d+) words[^.!?\n]{0,70}?(?:testimonial|quote|excerpt)/i);
  return match ? Math.max(1, Number(match[1])) : undefined;
}

export function exactExcerpt(quote: string, topic: string, limit: number): string {
  const text = quote.replace(/^[“"]|[”"]$/g, '').trim();
  const words = text.match(/\S+/g) || [];
  if (words.length <= limit) return text;
  const terms = [...new Set(topic.toLowerCase().match(/[\p{L}]{4,}/gu) || [])]
    .filter(term => !/^(?:coaching|coach|with|their|that|this|your|from|they|have|want|through|toward|customized)$/.test(term));
  const sentences = text.split(/(?<=[.!?])\s+/).map(value => value.trim()).filter(Boolean);
  const score = (value: string) => terms.filter(term => value.toLowerCase().includes(term)).length;
  const candidates: string[] = [];
  for (let start = 0; start < sentences.length; start++) {
    for (let end = start; end < sentences.length; end++) {
      const excerpt = sentences.slice(start, end + 1).join(' ');
      if (excerpt.split(/\s+/).length > limit) break;
      candidates.push(excerpt);
    }
  }
  candidates.sort((a, b) => score(b) - score(a) || b.length - a.length);
  // An impossible cap is a review issue, never permission to cut a sentence into a claim fragment.
  return candidates[0] || text;
}

/** Testimonials are approved source data. Never let the model rewrite their wording. */
export function restoreApprovedProof(draft: Draft, input: GenerationInput): Draft {
  const items = approvedProofEntries(input);
  if (!items.length) return draft;
  const extraProof = input.brief.proof.replace(/(?:^|\n)Quote:\n[\s\S]*?\nAttribution: [^\n]+(?:\nSource: [^\n]+)?(?:\nCategory: [^\n]+)?/g, '').trim();
  const notes = draft.notes.filter(note => !/testimonial excerpt (?:used|trimmed)|excerpt.*\b\d+ words\b/i.test(note));
  const sections = draft.sections.map(section => {
    if (section.id !== 'proof') return section;
    const parts = section.proofFraming?.introduction.trim() ? [section.proofFraming.introduction.trim()] : [];
    for (const item of items) {
      const heading = section.proofFraming?.items.find(frame => frame.id === item.id)?.heading.trim();
      const label = item.category === 'Professional recommendation'
        ? heading && !/professional recommendation/i.test(heading) ? `Professional recommendation: ${heading}` : heading || item.category
        : heading || item.category;
      const quote = item.quote.replace(/^[“"]|[”"]$/g, '').trim();
      const block = `${label}\n\n“${quote}”\n${item.attribution}`;
      parts.push(block);
    }
    if (extraProof) parts.push(extraProof);
    return { ...section, body: parts.join('\n\n'), bullets: [], cta: '' };
  });
  return { ...draft, sections, notes: [...new Set(notes)].slice(-12) };
}
