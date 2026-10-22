import type { Source } from '../shared/contracts';
import { AppError } from './errors';
import { findTestimonials } from './testimonials';

export const byteSize = (value: string) => Buffer.byteLength(value, 'utf8');
const normalized = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim();

/** Search every captured route locally; keep exact passages and their page attribution.
 * The stored capture is never modified. This is retrieval, not an AI summary. */
type ContextSource = Pick<Source, 'title' | 'url' | 'text' | 'headings'> & {
  crawl?: Source['crawl']; selectedOffer?: string; tone?: string;
};
export function sourceContext(
  source: ContextSource, budget: number, target: string, options: { indexedTestimonials?: boolean } = {},
): { value: Omit<ContextSource, 'crawl'> & { contextSelection?: string }; excerpted: boolean } {
  // Crawl records belong in the coverage UI, not in every model request.
  const { crawl, ...original } = source;
  const reference = { ...original, ...(crawl ? { captureCoverage: {
    pagesRead: crawl.pages.filter(page => page.status === 'read').length,
    shortenedPages: crawl.pages.filter(page => page.truncated).length,
    pendingRoutes: crawl.pending.length, complete: crawl.complete,
    warnings: crawl.warnings.slice(0, 3).map(warning => warning.slice(0, 400)),
  } } : {}) };
  if (byteSize(JSON.stringify(reference)) <= budget) return { value: reference, excerpted: false };
  const empty = { ...reference, headings: [] as string[], text: '' };
  const available = budget - byteSize(JSON.stringify(empty)) - 500;
  if (available < 1000) throw new AppError(400, 'The brief and writing instructions leave too little room for the source. Shorten long brief fields or client notes, then retry.');

  const pages = source.text.split(/(?=^SOURCE PAGE: )/m).filter(part => part.trim());
  const terms = [...new Set(normalized(target).match(/[\p{L}\p{N}]{3,}/gu) || [])];
  const seen = new Set<string>();
  const candidates: { text: string; score: number; order: number; page: number; kind: string }[] = [];
  pages.forEach((page, index) => {
    const label = page.match(/^SOURCE PAGE: [^\n]+\n(?:TITLE: [^\n]*\n)?/)?.[0] || `SOURCE PAGE: ${source.url || 'Pasted copy'}\n`;
    const route = label.split('\n')[0];
    const kind = /about|meet|bio|credential/i.test(route) ? 'about'
      : /testimonial|review|result|success|case-stud/i.test(route) ? 'proof' : 'offer';
    const archive = /\/tag\/|\/category\/|\/\d{4}\/\d{1,2}\//i.test(route);
    const routeScore = index === 0 ? 24 : kind !== 'offer' ? 20 : /service|offer|program|coaching|work-with|contact/i.test(route) && !archive ? 12 : 0;
    const body = page.startsWith('SOURCE PAGE: ') ? page.slice(label.length) : page;
    // Bound fragments as well as requests. Keep long-page tail passages eligible.
    const fragments = body.match(/[^\n]+(?:\n(?!\n)[^\n]+)*/g) || [];
    for (const paragraph of fragments) {
      for (let offset = 0; offset < paragraph.length; offset += 900) {
        const text = paragraph.slice(offset, offset + 1100).trim();
        const key = normalized(text);
        if (key.length < 25 || seen.has(key)) continue;
        seen.add(key);
        const matches = terms.filter(term => key.includes(term)).length;
        const relevant = /coaching|clients?|sessions?|program|offer|help|struggl|career|outcome|background|experience|certif|master|degree|founder|testimonial|book|discovery/i.test(text);
        const trust = kind === 'about' && /certif|credential|degree|master|experience in|years of experience|my background|i[’']m|i am/i.test(text) ? 24
          : kind === 'proof' && /helped me|recommend|my experience|with her support|with his support|i (?:was|have|am)/i.test(text) ? 18 : 0;
        candidates.push({ text: `${label}\n${text}`, page: index, kind,
          score: routeScore + matches * 12 + (relevant ? 6 : 0) + trust - (archive ? 12 : 0) - (options.indexedTestimonials && kind === 'proof' ? 40 : 0), order: candidates.length });
      }
    }
  });
  candidates.sort((a, b) => b.score - a.score || a.order - b.order);
  const selected: typeof candidates = [];
  let remaining = available;
  const add = (candidate: typeof candidates[number]) => {
    if (selected.includes(candidate)) return;
    const size = byteSize(JSON.stringify(candidate.text)) + 4;
    if (size > remaining) return;
    selected.push(candidate);
    remaining -= size;
  };
  // Reserve both trust routes and the strongest offer passages before filling by relevance.
  for (const kind of options.indexedTestimonials ? ['about'] : ['about', 'proof']) candidates.filter(item => item.kind === kind).slice(0, 2).forEach(add);
  // Indexed feedback is already supplied separately. Spend that room on the offer,
  // including the homepage's later outcome and next-step paragraphs.
  if (options.indexedTestimonials) candidates.filter(item => item.page === 0).slice(0, 6).forEach(add);
  const usedPages = new Set(selected.map(item => item.page));
  for (const candidate of candidates) {
    if (usedPages.size >= 6) break;
    if (usedPages.has(candidate.page)) continue;
    add(candidate);
    usedPages.add(candidate.page);
  }
  candidates.forEach(add);
  const text = selected.sort((a, b) => a.order - b.order).map(item => item.text).join('\n\n');
  const value = { ...empty, text,
    contextSelection: `Selected exact excerpts from ${new Set(selected.map(item => item.page)).size} of ${pages.length} captured pages after searching all captured text. Other captured material is retained in the project, but is not included in this request. Missing or shortened material is unknown, not evidence of absence.`,
  };
  if (!text || byteSize(JSON.stringify(value)) > budget)
    throw new AppError(400, 'The source could not fit the AI request limit. Shorten long brief fields or use a more specific source.');
  return { value, excerpted: true };
}

/** Models cite passage IDs; the server copies the actual source wording into evidence. */
export function extractionContext(source: Source, budget: number, target: string) {
  const testimonials: ReturnType<typeof findTestimonials> = [];
  for (const item of findTestimonials(source, target)) {
    if (byteSize(JSON.stringify([...testimonials, item])) <= budget * 0.42) testimonials.push(item);
  }
  const selected = sourceContext(source, Math.floor((budget - byteSize(JSON.stringify(testimonials))) * 0.78), target, { indexedTestimonials: testimonials.length > 0 });
  const passages: { id: string; page: string; text: string }[] = [];
  for (const part of selected.value.text.split(/(?=^SOURCE PAGE: )/m).filter(part => part.trim())) {
    const header = part.match(/^SOURCE PAGE: ([^\n]+)\n(?:TITLE: [^\n]*\n)?/);
    const body = header ? part.slice(header[0].length) : part;
    for (let offset = 0; offset < body.length; offset += 1000) {
      const text = body.slice(offset, offset + 1200).trim();
      if (text) passages.push({ id: `P${passages.length + 1}`, page: header?.[1] || source.url || 'Pasted copy', text });
    }
  }
  const { text: _text, ...metadata } = selected.value;
  const value = { ...metadata, passages, testimonials };
  if (byteSize(JSON.stringify(value)) > budget)
    throw new AppError(400, 'The source passage index exceeds the AI request allowance. Use a more specific source.');
  return { value, excerpted: selected.excerpted, quotes: new Map(passages.map(passage => [passage.id, passage.text])) };
}
