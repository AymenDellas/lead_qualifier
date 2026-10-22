import type { Source } from '../shared/contracts';

export type SourceTestimonial = { id: string; attribution: string; quote: string; page: string; category?: string };
const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim();
const completeParagraph = (value: string) => /[.!?”"']$/.test(value) || /^[“"][\s\S]+[”"]\s+[^\n]{1,180}$/.test(value);
const testimonialLanguage = (value: string) => /\bcoach(?:ing|ed)?|helped|recommend|sessions?|training|workshop|thank|career|confidence|support|work(?:ed|ing)? with|my experience|was able|have been able/i.test(value);
const categoryHeading = (value: string) => /^(?:personal|professional) recommendations?\s*$/i.test(value);
const authorHeading = (value: string) => {
  if (value.length < 3 || value.length > 220 || categoryHeading(value) || /[!?;“”"]|\n\n/.test(value)) return false;
  const name = value.replace(/^[\p{Pd}\u2212]\s*/u, '').split(/[,|\n]/)[0].trim();
  if (/testimonial|success stor|clients have to say|source page|title:|consultation|coaching|communications|assignments|audiences|media|^the (?:show|process|work|approach)|^skip|^book|^schedule|^meet|^about|^welcome|^what|^why|^how|^contact|^read more/i.test(name)) return false;
  const words = name.split(/\s+/);
  if (words.length > 20 || /^(?:I|My|We|Our|With|This|Very|Lisa[’']s)\b/.test(name)) return false;
  return words.every(word => /^(?:[\p{Lu}][\p{L}’'.:()-]*|&|de|van|von|der|da|of|the|a|and|in)$/u.test(word));
};

/** Keep a testimonial's short author heading with its adjacent feedback paragraph. */
export function findTestimonials(source: Source, target: string): SourceTestimonial[] {
  const title = `${source.title}\n${source.text.match(/^TITLE: ([^\n]+)/m)?.[1] || ''}`;
  const provider = title.match(/\bby\s+([\p{Lu}][\p{L}’'.-]+(?:\s+[\p{Lu}][\p{L}’'.-]+){0,2})(?=\s*[|–—\n]|$)/u)?.[1];
  const providerNames = provider?.toLowerCase().split(/\s+/).filter(name => name.length >= 3) || [];
  // Inline feedback needs a clear quotation and a reference to the provider
  // named in the page title. Unrelated template endorsements stay excluded.
  const inlineFeedback = (quote: string) => /^[“"][\s\S]+[”"]$/.test(quote.trim())
    && providerNames.some(name => normalize(quote).split(/[^\p{L}’'.-]+/u).includes(name));
  const terms = [...new Set(normalize(target).match(/[\p{L}\p{N}]{3,}/gu) || [])]
    .filter(term => !/^(?:the|and|for|with|offer|program|programme|coaching|coach|service|sprint)$/.test(term));
  const found: (SourceTestimonial & { score: number })[] = [];
  for (const page of source.text.split(/(?=^SOURCE PAGE: )/m)) {
    const header = page.match(/^SOURCE PAGE: ([^\n]+)\n(?:TITLE: ([^\n]*)\n)?/);
    const url = header?.[1] || source.url;
    const dedicated = /testimonial|review|success.stor|case.stud|client.result/i.test(`${url} ${header?.[2] || source.title}`);
    const testimonialPage = dedicated || /^(?:testimonials?|success stories|client (?:stories|results|reviews)|(?:personal|professional) recommendations?|what (?:our |my )?clients (?:say|have to say))\s*$/im.test(page);
    if (!testimonialPage && !providerNames.length) continue;
    const body = header ? page.slice(header[0].length) : page;
    const paragraphs = body.split(/\n\s*\n/).map(value => value.trim()).filter(Boolean);
    const quoteFirst = new Set<number>();
    const quoteFirstAuthors = new Set<number>();
    // Many sites put the author after a multi-paragraph quotation.
    for (let start = 0; start < paragraphs.length; start++) {
      if (paragraphs[start].length < 35 || (!testimonialLanguage(paragraphs[start]) && !inlineFeedback(paragraphs[start]))
        || !/^[“"]|\b(?:I|my|me|we|our|us)\b/i.test(paragraphs[start])) continue;
      const preceding = paragraphs[start - 1];
      // In quote-then-author lists, the preceding name belongs to the previous quote.
      // Track that association instead of shifting every quote onto the next speaker.
      if (preceding && authorHeading(preceding) && !quoteFirstAuthors.has(start - 1)
        && preceding !== (header?.[2] || source.title)) continue;
      let end = start;
      while (end + 1 < paragraphs.length && !authorHeading(paragraphs[end + 1]) && !categoryHeading(paragraphs[end + 1]) && completeParagraph(paragraphs[end + 1])) end++;
      const attribution = paragraphs[end + 1];
      const quote = paragraphs.slice(start, end + 1).join('\n\n');
      if (!attribution || !authorHeading(attribution) || !completeParagraph(quote)) continue;
      if (!testimonialPage && !inlineFeedback(quote)) continue;
      if (!dedicated && !testimonialLanguage(quote) && !inlineFeedback(quote)) continue;
      const group = paragraphs.slice(0, start).filter(categoryHeading).at(-1) || '';
      const training = /\btraining|\bworkshop|\bcourse|bullying|harassment|mental (?:health|wellness)|attendee/i.test(attribution + ' ' + quote);
      if (!found.some(item => normalize(item.quote) === normalize(quote) && normalize(item.attribution) === normalize(attribution))) {
        const matches = terms.filter(term => normalize(quote + ' ' + attribution).includes(term)).length;
        found.push({ id: '', attribution, quote, page: url,
          category: training ? 'Training feedback' : /professional/i.test(group) ? 'Professional recommendation' : 'Client experience', score: matches * 20 + 4 });
      }
      for (let index = start; index <= end; index++) quoteFirst.add(index);
      quoteFirstAuthors.add(end + 1);
      start = end;
    }
    let group = '';
    for (let i = 1; i < paragraphs.length; i++) {
      if (categoryHeading(paragraphs[i - 1])) { group = paragraphs[i - 1]; continue; }
      const attribution = paragraphs[i - 1], quote = paragraphs[i];
      if (quoteFirst.has(i) || quoteFirstAuthors.has(i - 1)) continue;
      if (!authorHeading(attribution) || quote.length < 35) continue;
      if (!/^[“"]|\b(?:I|my|me|we|our)\b|recommend|helped|support|thank/i.test(quote)) continue;
      if (!completeParagraph(quote)) continue; // Exclude a visibly cut-off capture tail.
      if (!testimonialPage && !inlineFeedback(quote)) continue;
      if (!dedicated && !testimonialLanguage(quote) && !inlineFeedback(quote)) continue;
      let fullQuote = quote;
      // Preserve a second paragraph belonging to the same speaker, without consuming the next author.
      while (i + 1 < paragraphs.length && !categoryHeading(paragraphs[i + 1]) && !authorHeading(paragraphs[i + 1])
        && completeParagraph(paragraphs[i + 1])) {
        fullQuote += '\n\n' + paragraphs[++i];
      }
      if (found.some(item => normalize(item.quote) === normalize(fullQuote) && normalize(item.attribution) === normalize(attribution))) continue;
      const training = /\btraining|\bworkshop|\bcourse|bullying|harassment|mental (?:health|wellness)|attendee/i.test(attribution + ' ' + fullQuote);
      const category = training ? 'Training feedback' : /professional/i.test(group) ? 'Professional recommendation' : 'Client experience';
      const matches = terms.filter(term => normalize(fullQuote + ' ' + attribution).includes(term)).length;
      found.push({ id: '', attribution, quote: fullQuote, page: url, category,
        score: matches * 20 + (/\bcoaching\b|career|business|confidence/i.test(fullQuote) ? 4 : 0) });
    }
  }
  return found.sort((a, b) => b.score - a.score)
    .map(({ score: _score, ...item }, index) => ({ ...item, id: `T${index + 1}` }));
}

export function testimonialProof(items: SourceTestimonial[]) {
  return items.map(item => `Quote:\n${item.quote}\nAttribution: ${item.attribution}\nSource: ${item.page}${item.category ? `\nCategory: ${item.category}` : ''}`).join('\n\n');
}

