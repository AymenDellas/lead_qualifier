import * as cheerio from 'cheerio';
import { MAX_SOURCE_CHARACTERS, type Source } from '../shared/contracts';
import { AppError } from './errors';
import { fetchSourceDocument, validateSourceUrl } from './source-fetch';

export { isPublicAddress, validateSourceUrl } from './source-fetch';

const PAGE_CHARACTERS = 24_000;
const MAX_PAGES = 100;
const MAX_DISCOVERED = 2_000;
const MAX_SITEMAPS = 20;
const CRAWL_TIMEOUT = 120_000;
type FetchDocument = typeof fetchSourceDocument;
type PageResult = NonNullable<Source['crawl']>['pages'][number];

function routePriority(url: URL): number {
  if (url.pathname === '/') return 0;
  if (/\/(?:blog|learn|articles)\//i.test(url.pathname)) return 4;
  if (/(?:about|meet|bio|credential|testimonial|review|result|success|case-stud)/i.test(url.pathname)) return 1;
  if (/(?:offer|service|coaching|work-with|program|contact)/i.test(url.pathname) && !/\/(?:blog|learn|articles)\//i.test(url.pathname)) return 2;
  return 3;
}

export function parsePage(html: string, url: string): Source {
  const $ = cheerio.load(html);
  const title = $('title').first().text().trim().slice(0, 300);
  const description = $('meta[name="description"]').attr('content') ?? '';
  $('script,style,noscript,svg,iframe,nav,footer,[hidden],[aria-hidden="true"],input[type="hidden"]').remove();
  const headings = $('h1,h2,h3').map((_, e) => $(e).text().replace(/\s+/g, ' ').trim()).get().filter(Boolean).slice(0, 60);
  $('br').replaceWith('\n');
  $('p,div,section,article,li,h1,h2,h3,h4,button,a,label').each((_, e) => { $(e).append('\n'); });
  const body = $('body').text().replace(/[\t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title: title || new URL(url).hostname, url, headings, text: [title, description, body].filter(Boolean).join('\n\n') };
}

/** Canonicalize links without turning anchors or tracking parameters into new pages. */
export function crawlRoute(raw: string, base: URL, origin: string): URL | null {
  try {
    const url = validateSourceUrl(new URL(raw, base).href);
    if (url.origin !== origin || url.href.length > 2_000) return null;
    const path = decodeURIComponent(url.pathname);
    if (/(?:^|\/)(?:wp-admin|wp-json|api|admin|login|log-in|signin|sign-in|logout|signout|auth|oauth|account|checkout|cart|portal|reset-password)(?:\/|$)/i.test(path)) return null;
    if (/\.(?:pdf|png|jpe?g|gif|webp|avif|ico|svg|mp[34]|mov|webm|wav|zip|gz|xml|json|css|js|woff2?|ttf|eot|docx?|xlsx?|pptx?)(?:\/)?$/i.test(path)) return null;
    url.hash = '';
    for (const key of Array.from(url.searchParams.keys())) {
      if (/^(?:utm_.+|fbclid|gclid|msclkid|ref|mc_cid|mc_eid)$/i.test(key)) url.searchParams.delete(key);
      else if (/token|password|secret|session|nonce|signature|(?:^|_)key$|^action$/i.test(key)) return null;
    }
    url.searchParams.sort();
    url.pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
    return url;
  } catch { return null; }
}

function pageLinks(html: string, base: URL): string[] {
  const $ = cheerio.load(html);
  // Discover links before removing navigation/footer from the captured copy.
  const links = $('a[href],area[href]').map((_, e) => $(e).attr('href') || '').get();
  const declaredBase = $('base[href]').first().attr('href');
  if (!declaredBase) return links;
  try {
    const linkBase = new URL(declaredBase, base);
    return links.map(link => new URL(link, linkBase).href);
  } catch { return links; }
}

/** Share the reference budget so a long homepage cannot crowd out About or proof pages. */
function combinePages(pages: Source[], records: PageResult[]): string {
  const labels = pages.map(page => `SOURCE PAGE: ${page.url}\nTITLE: ${page.title}\n\n`);
  const budget = MAX_SOURCE_CHARACTERS - labels.join('\n\n').length;
  const sizes = pages.map(() => 0);
  let remaining = budget;
  let active = pages.map((_, index) => index);
  while (remaining > 0 && active.length) {
    const share = Math.max(1, Math.floor(remaining / active.length));
    for (const index of active) {
      const added = Math.min(share, remaining, pages[index].text.length - sizes[index]);
      sizes[index] += added;
      remaining -= added;
    }
    active = active.filter(index => sizes[index] < pages[index].text.length);
  }
  return pages.map((page, index) => {
    if (sizes[index] < page.text.length) {
      const record = records.find(record => record.url === page.url);
      if (record) record.truncated = true;
    }
    return labels[index] + page.text.slice(0, sizes[index]);
  }).join('\n\n');
}

/** Crawl reachable public routes and report gaps instead of claiming full coverage. */
export async function crawlWebsite(
  value: string,
  parentSignal: AbortSignal,
  fetchDocument: FetchDocument = fetchSourceDocument,
  options: { maxPages?: number; timeoutMs?: number } = {},
): Promise<Source> {
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(options.timeoutMs ?? CRAWL_TIMEOUT)]);
  const maxPages = Math.min(MAX_PAGES, Math.max(1, options.maxPages ?? MAX_PAGES));
  const pageFetch = (url: URL, kind: 'page' | 'sitemap' | 'robots', origin?: string) =>
    fetchDocument(url, AbortSignal.any([signal, AbortSignal.timeout(kind === 'page' ? 15_000 : 6_000)]), kind, origin);
  const seed = await pageFetch(validateSourceUrl(value), 'page');
  const origin = seed.url.origin;
  const pending = new Map<string, URL>();
  const discovered = new Set<string>();
  const visited = new Set<string>();
  const captured = new Set<string>();
  const records: PageResult[] = [];
  const pages: Source[] = [];
  const content = new Set<string>();
  const warnings = new Set<string>();
  let discoveryLimited = false;
  const enqueue = (raw: string, base = seed.url) => {
    const url = crawlRoute(raw, base, origin);
    if (!url || discovered.has(url.href)) return;
    if (discovered.size >= MAX_DISCOVERED) { discoveryLimited = true; return; }
    discovered.add(url.href);
    pending.set(url.href, url);
  };
  const capture = (html: string, url: URL, requested: string) => {
    const canonical = crawlRoute(url.href, url, origin);
    if (!canonical) throw new AppError(422, 'The route is not a public page on this website.');
    for (const link of pageLinks(html, url)) enqueue(link, url);
    if (captured.has(canonical.href)) {
      records.push({ url: requested, title: '', status: 'duplicate', detail: `Redirects to ${canonical.href}` });
      return;
    }
    visited.add(canonical.href);
    const page = parsePage(html, canonical.href);
    if (page.text.length < 80) {
      records.push({ url: canonical.href, title: page.title, status: 'unreadable', detail: 'Very little readable HTML; this page may require JavaScript or login. Paste its visible copy to add it.' });
      return;
    }
    captured.add(canonical.href);
    if (content.has(page.text)) {
      records.push({ url: canonical.href, title: page.title, status: 'duplicate', detail: 'Same readable content as another captured page.' });
      return;
    }
    content.add(page.text);
    records.push({ url: canonical.href, title: page.title, status: 'read', ...(page.text.length > PAGE_CHARACTERS ? { truncated: true } : {}) });
    page.text = page.text.slice(0, PAGE_CHARACTERS);
    pages.push(page);
  };
  const seedUrl = crawlRoute(seed.url.href, seed.url, origin);
  if (!seedUrl) throw new AppError(400, 'Use a public marketing page on the client website.');
  discovered.add(seedUrl.href);
  capture(seed.html, seed.url, seedUrl.href);
  enqueue('/');

  // Sitemaps also expose routes not linked from the supplied landing page.
  const maps = new Map<string, URL>();
  const seenMaps = new Set<string>();
  const declaredMaps = new Set<string>();
  const enqueueMap = (raw: string, base = seed.url, declared = true) => {
    try {
      const url = validateSourceUrl(new URL(raw, base).href);
      if (url.href.length > 2_000) return;
      if (declared) declaredMaps.add(url.href);
      if (url.origin !== origin || seenMaps.has(url.href) || maps.has(url.href)) return;
      if (maps.size + seenMaps.size >= MAX_SITEMAPS) { warnings.add('The sitemap discovery limit was reached; additional sitemap routes may be missing.'); return; }
      maps.set(url.href, url);
    } catch { /* Invalid or external sitemap. */ }
  };
  enqueueMap('/sitemap.xml', seed.url, false);
  enqueueMap('/sitemap_index.xml', seed.url, false);
  try {
    const robots = await pageFetch(new URL('/robots.txt', origin), 'robots', origin);
    for (const line of robots.html.split(/\r?\n/)) {
      const match = line.match(/^\s*Sitemap:\s*(\S+)/i);
      if (match) enqueueMap(match[1], robots.url);
    }
  } catch { /* An absent robots file does not prevent public link discovery. */ }
  while (maps.size && !signal.aborted) {
    const batch = Array.from(maps.values()).slice(0, 3);
    for (const url of batch) { maps.delete(url.href); seenMaps.add(url.href); }
    await Promise.all(batch.map(async url => {
      try {
        const sitemap = await pageFetch(url, 'sitemap', origin);
        const $ = cheerio.load(sitemap.html, { xmlMode: true });
        $('sitemap > loc').each((_, e) => { enqueueMap($(e).text().trim(), sitemap.url); });
        $('url > loc').each((_, e) => { enqueue($(e).text().trim(), sitemap.url); });
      } catch { if (declaredMaps.has(url.href)) warnings.add('Some declared sitemap locations could not be read; linked-page discovery was still attempted.'); }
    }));
  }
  while (pending.size && records.length < maxPages && !signal.aborted) {
    const batch = Array.from(pending.values()).filter(url => !visited.has(url.href)).sort((a, b) => routePriority(a) - routePriority(b)).slice(0, Math.min(3, maxPages - records.length));
    for (const url of Array.from(pending.values())) if (visited.has(url.href)) pending.delete(url.href);
    if (!batch.length) break;
    for (const url of batch) { pending.delete(url.href); visited.add(url.href); }
    await Promise.all(batch.map(async url => {
      try {
        const fetched = await pageFetch(url, 'page', origin);
        capture(fetched.html, fetched.url, url.href);
      } catch (error) {
        records.push({ url: url.href, title: '', status: 'failed', detail: signal.aborted ? 'The site crawl time limit was reached.' : error instanceof AppError ? error.message : 'This page could not be read or timed out.' });
      }
    }));
  }
  parentSignal.throwIfAborted();
  if (!pages.length) throw new AppError(422, 'No readable copy was found. These pages may require JavaScript or login. Paste their visible copy instead.');
  const text = combinePages(pages, records);
  const remaining = Array.from(pending.keys()).filter(url => !visited.has(url));
  if (remaining.length) warnings.add(`Crawl stopped with ${remaining.length} discovered routes still unread (${signal.aborted ? 'time limit' : `${maxPages}-page limit`}).`);
  if (discoveryLimited) warnings.add(`Discovery stopped at ${MAX_DISCOVERED} public routes; further routes may exist.`);
  if (signal.aborted) warnings.add('The site crawl time limit was reached. Coverage is partial.');
  if (records.some(page => ['failed', 'unreadable'].includes(page.status))) warnings.add('Some routes could not be read. Check the page list and paste missing copy if needed.');
  if (records.some(page => page.truncated)) warnings.add(`Some page text was shortened (${PAGE_CHARACTERS.toLocaleString('en-US')} characters per page; ${MAX_SOURCE_CHARACTERS.toLocaleString('en-US')} total). Review the captured copy before generating.`);
  warnings.add('Only public HTML routes found through links and sitemaps can be discovered. Unlisted routes, JavaScript-only content, embedded content and login-protected pages may need pasted copy.');
  return {
    title: pages[0].title, url: seed.url.href, text,
    headings: Array.from(new Set(pages.flatMap(page => page.headings))).slice(0, 60),
    crawl: {
      pages: records, discovered: discovered.size, pending: remaining,
      complete: !signal.aborted && !remaining.length && !discoveryLimited && !records.some(page => page.status === 'failed' || page.status === 'unreadable' || page.truncated) && warnings.size === 1,
      warnings: Array.from(warnings),
    },
  };
}

export async function readSource(value: string, parentSignal: AbortSignal): Promise<Source> {
  try { return await crawlWebsite(value, parentSignal); }
  catch (error) {
    if (error instanceof AppError || parentSignal.aborted || (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))) throw error;
    throw new AppError(422, 'The website could not be read. Check the URL or paste the visible copy instead.');
  }
}
