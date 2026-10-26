import { normaliseLinkedinUrl } from './utils';
import { countrySearchExpansion } from './discovery-locations';
import { assessDiscoveryLocation, canonicalDiscoveryTarget, type DiscoveryLocationEvidence } from './discovery-location-evidence.cjs';
import {
  scoreDiscoveryResult,
  DEFAULT_MIN_FIT_SCORE,
  type DiscoveryScore,
  type ScoreReason,
} from './discovery-score';

// ═════════════════════════════════════════════════════════════════
//  TYPES
// ═════════════════════════════════════════════════════════════════

export interface SearchConfig {
  job_titles: string[];
  locations: string[];
  max_urls_target?: number;
  /** Unique accepted profiles to keep, after scoring. max_urls_target is the legacy alias. */
  kept_leads_target?: number;
  max_pages_per_dork?: number;
  negative_keywords?: string[];
  /** Rows scoring below this are not written at all. Defaults to DEFAULT_MIN_FIT_SCORE. */
  min_fit_score?: number;
  /** Groups every row a single run produced, so a run can be evaluated as a unit. */
  run_id?: string;
}

interface NicheSignals {
  phrases: Set<string>;
  role_words: Set<string>;
  titles_lower: string[];
}

/** A scored, accepted discovery result, carrying everything needed to attribute it. */
export interface DiscoveredLead {
  url: string;
  location: string;
  /** Requested search target, kept separately from the person's evidenced country. */
  searchLocation: string;
  locationEvidence: DiscoveryLocationEvidence;
  templateId: string;
  query: string;
  niche: string;
  page: number;
  /** 1-based position within its SERP page. */
  rank: number;
  title: string;
  snippet: string;
  fitScore: number;
  fitReasons: ScoreReason[];
  confidence: 'high' | 'low' | 'none';
  /** Distinct templates that surfaced this profile during this run. */
  seenCount: number;
  runId: string;
}

export interface DorkProgress {
  found: number;
  target: number;
  remaining: number;
  searchPhase: 'country' | 'regional';
  searchArea: string;
  /** Candidates evaluated — the honest denominator. "Found 180" alone says nothing
   *  about whether the fit floor is set sensibly; "scored 640, kept 180" does. */
  scored: number;
  rejected: number;
  totalQueries: number;
  queryIndex: number;
  query: string;
  templateId: string;
  /** One Serper credit per page fetched. */
  creditsSpent: number;
}

export interface DorkRunStats {
  runId: string;
  templates: number;
  creditsSpent: number;
  scored: number;
  kept: number;
  rejected: number;
  belowFloor: number;
  rejectsByReason: Record<string, number>;
  cancelled: boolean;
  target: number;
  targetReached: boolean;
  stopReason: 'target_reached' | 'search_exhausted' | 'cancelled';
  queriesCompleted: number;
}

export interface DorkRunResult {
  leads: DiscoveredLead[];
  stats: DorkRunStats;
}


// ═════════════════════════════════════════════════════════════════
//  NOISE DOMAIN BLOCKLIST
// ═════════════════════════════════════════════════════════════════

const NOISE_DOMAINS = new Set([
  'coachfoundation.com', 'noomii.com', 'thumbtack.com', 'bark.com',
  'yelp.com', 'glassdoor.com', 'indeed.com', 'ziprecruiter.com',
  'crunchbase.com', 'clutch.co', 'g2.com', 'trustpilot.com',
  'topresume.com', 'thecoachingacademy.com', 'lifecoachmagazine.com',
  'coaching-online.org', 'life-coach-directory.com', 'findacoach.com',
  'coachingfederation.org', 'coachingaggregator.com', 'betterup.com',
  'tonyrobbins.com', 'udemy.com', 'coursera.org', 'skillshare.com',
  'masterclass.com', 'fiverr.com', 'upwork.com', 'linkedin.com/company',
  'linkedin.com/jobs', 'linkedin.com/pulse', 'linkedin.com/learning',
]);


// ═════════════════════════════════════════════════════════════════
//  DEFAULT NEGATIVE KEYWORDS
// ═════════════════════════════════════════════════════════════════

const NEGATIVE_KEYWORDS = [
  'recruiter', 'software engineer', 'developer', 'sales manager',
  'project manager', 'product manager', 'data scientist', 'accountant',
  'human resources', 'HR manager', 'marketing manager', 'nurse',
  'teacher', 'professor', 'attorney', 'lawyer', 'dentist', 'doctor',
  'real estate', 'insurance agent',
];


// Query geography controls search coverage; it is never evidence of where the
// person lives. Every organic result passes the explicit location gate below.


// ═════════════════════════════════════════════════════════════════
//  ROLE STEMS (for niche signal extraction)
// ═════════════════════════════════════════════════════════════════

const ROLE_STEMS: Record<string, string[]> = {
  'coach': ['coach', 'coaching'],
  'mentor': ['mentor', 'mentoring', 'mentorship'],
  'consultant': ['consultant', 'consulting', 'consultancy'],
  'trainer': ['trainer', 'training'],
  'advisor': ['advisor', 'adviser', 'advisory'],
  'strategist': ['strategist', 'strategy'],
  'counselor': ['counselor', 'counsellor', 'counseling', 'counselling'],
  'therapist': ['therapist', 'therapy'],
  'facilitator': ['facilitator', 'facilitation'],
  'practitioner': ['practitioner', 'practice'],
  'healer': ['healer', 'healing'],
  'guide': ['guide', 'guidance'],
};

const GENERIC_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'for', 'in', 'at', 'to',
  'business', 'life', 'career', 'executive', 'leadership',
  'performance', 'personal', 'professional', 'senior', 'chief'
]);


// ═════════════════════════════════════════════════════════════════
//  QUERY TEMPLATE GENERATOR
// ═════════════════════════════════════════════════════════════════

/** A dork plus the stable id that credit is attributed to. */
export interface QueryTemplate {
  /** Stable across runs and re-orderings — derived from category + driver word,
   *  never an array index, or every historical number reassigns when the bank
   *  changes. */
  id: string;
  query: string;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Builds the dork bank for one title × location.
 *
 * ## Why this is 35 templates and not 107
 *
 * The old bank spent most of its budget re-asking the same question. Category 2
 * appended `"Experience"`, `"About"`, `"Skills"`, `"Contact info"`, `"Connections"`,
 * `"Activity"`, `"Education"` — words that appear on *every* LinkedIn profile. Those
 * eleven templates were eleven near-identical queries against one slice of the
 * index, and the same is true of the ten generic business nouns in Category 7
 * (`company`, `services`, `solutions`, `group`…). Paging them to exhaustion is
 * exactly why the three-dry-pages abort tripped constantly.
 *
 * What survives is the templates that change the *semantic target* — who the person
 * is, what they say they do, what they are certified in, what they sell. Categories
 * were kept in proportion to how directly they speak to the ICP (solo operator,
 * actively practising, sells a paid offer), so the identity and first-person verb
 * groups are the largest.
 *
 * Three structural exclusions stay in the query string (`-dir -jobs -pulse`) because
 * they are URL-shaped and cannot suppress a real practitioner. Topical negatives are
 * applied to the parsed headline instead — see `runDorkEngine`.
 */
function buildQueryBank(title: string, loc: string, negString: string): QueryTemplate[] {
  const T = title;
  const L = loc;
  const N = negString;
  const out: QueryTemplate[] = [];
  const add = (id: string, query: string) => out.push({ id, query });

  // ─── Core operators (3) ───────────────────────────────────
  // `inurl:linkedin.com/in` and `"T" AND "L"` were dropped: the first duplicates
  // `site:` against the same index path, and Google treats a bare AND as implicit.
  add('core-plain', `site:linkedin.com/in "${T}" "${L}"${N}`);
  add('core-intitle', `site:linkedin.com/in intitle:"${T}" "${L}"${N}`);
  add('core-clean', `site:linkedin.com/in "${T}" "${L}" -dir -jobs -pulse${N}`);

  // ─── Location phrasing (2) ────────────────────────────────
  // LinkedIn writes locations two ways. The rest ("Metropolitan", "based in",
  // "Location * L") matched almost nothing.
  add('loc-greater', `site:linkedin.com/in "${T}" "Greater ${L}"${N}`);
  add('loc-area', `site:linkedin.com/in "${T}" "${L} Area"${N}`);

  // ─── Professional identity (8) ────────────────────────────
  // Every one of these is a *solo* marker, which is the ICP signal hardest to
  // recover later. `CEO` was dropped as corporate-shaped; speaker/author/
  // award-winning skew to public figures who don't reply to cold email.
  for (const signal of [
    'founder', 'owner', 'self-employed', 'independent',
    'freelance', 'entrepreneur', 'practitioner', 'certified',
  ]) {
    add(`id-${slug(signal)}`, `site:linkedin.com/in "${T}" "${L}" "${signal}"${N}`);
  }

  // ─── First-person service verbs (6) ───────────────────────
  // The strongest headline-level evidence that one person delivers the work.
  for (const verb of [
    'I help', 'I work with', 'helping', 'specializing in',
    'working with', 'supporting',
  ]) {
    add(`verb-${slug(verb)}`, `site:linkedin.com/in "${T}" "${L}" "${verb}"${N}`);
  }

  // ─── Coaching credentials (6) ─────────────────────────────
  // MBA and PhD were dropped — they pull corporate and academic profiles. The
  // `senior/lead/head/principal/master ${T}` prefixes went with them: those
  // describe a rank inside someone else's organisation, the opposite of the ICP.
  for (const cert of ['ICF', 'PCC', 'ACC', 'MCC', 'CPC', 'NLP']) {
    add(`cert-${slug(cert)}`, `site:linkedin.com/in "${T}" "${cert}" "${L}"${N}`);
  }

  // ─── The offer being sold (4) ─────────────────────────────
  for (const cs of ['clients', 'program', 'workshop', 'retreat']) {
    add(`offer-${slug(cs)}`, `site:linkedin.com/in "${T}" "${L}" "${cs}"${N}`);
  }

  // ─── Boolean combos (2) ───────────────────────────────────
  add('bool-1on1', `site:linkedin.com/in "${T}" "${L}" ("1:1" OR "one-on-one")${N}`);
  add('bool-nohire', `site:linkedin.com/in "${T}" "${L}" -recruit -hiring -job${N}`);

  // ─── Niche depth (4) ──────────────────────────────────────
  // "discovery call" and "strategy session" name a paid entry point; the other
  // two are vocabulary a practising coach uses and a corporate employee does not.
  for (const nd of ['discovery call', 'strategy session', 'mindset', 'accountability']) {
    add(`depth-${slug(nd)}`, `site:linkedin.com/in "${T}" "${L}" "${nd}"${N}`);
  }

  return out; // 35 templates
}

/**
 * Templates in the original country bank, derived rather than hardcoded.
 * The full run's denominator additionally includes conditional geographical reserve queries.
 */
export function queryBankSize(): number {
  return buildQueryBank('x', 'y', '').length;
}

export function keptLeadTarget(config: Pick<SearchConfig, 'kept_leads_target' | 'max_urls_target'>): number {
  const target = config.kept_leads_target ?? config.max_urls_target ?? 500;
  if (!Number.isSafeInteger(target) || target < 1) throw new Error('Kept leads target must be a positive whole number.');
  return target;
}

interface DiscoveryQuery {
  templateId: string;
  query: string;
  location: string;
  niche: string;
  searchPhase: 'country' | 'regional';
  searchArea: string;
}

/** The regional reserve is only searched if country queries do not fill the kept target. */
export function buildDiscoverySearchPlan(config: SearchConfig): DiscoveryQuery[] {
  const negatives = (config.negative_keywords || []).slice(0, 10);
  const negString = negatives.length ? ' ' + negatives.map(n => `-"${n}"`).join(' ') : '';
  const countryQueries: DiscoveryQuery[] = [];
  const aliasQueries: DiscoveryQuery[] = [];
  const regionalQueries: DiscoveryQuery[] = [];
  const seen = new Set<string>();
  const add = (bank: DiscoveryQuery[], query: DiscoveryQuery) => {
    const key = query.query.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!seen.has(key)) { seen.add(key); bank.push(query); }
  };
  for (const title of config.job_titles) {
    const countries = new Set<string>();
    for (const loc of config.locations) {
      const targetCountry=canonicalDiscoveryTarget(loc);
      if(!targetCountry)throw new Error('Finder supports UK, US and Canada country targets only. Use the full country name instead of an ambiguous city or CA abbreviation.');
      const expansion = countrySearchExpansion(loc);
      const countryKey = targetCountry;
      if (countries.has(countryKey)) continue;
      countries.add(countryKey);
      const countryTerm=targetCountry==='US'?'United States':targetCountry==='UK'?'United Kingdom':'Canada';
      for (const t of buildQueryBank(title, countryTerm, negString)) {
        add(countryQueries, { templateId: t.id, query: t.query, location: loc, niche: title, searchPhase: 'country', searchArea: loc });
      }
      if (!expansion) continue;
      for (const alias of expansion.aliases) {
        for (const t of buildQueryBank(title, alias, negString)) {
          add(aliasQueries, { templateId: t.id, query: t.query, location: loc, niche: title, searchPhase: 'country', searchArea: alias });
        }
      }
      for (const region of expansion.regions) {
        const base = `site:linkedin.com/in "${title}" ${expansion.constraint} "${region}"${negString}`;
        const reserve = [
          ['regional-plain', base],
          ['regional-intitle', `site:linkedin.com/in intitle:"${title}" ${expansion.constraint} "${region}"${negString}`],
          ['regional-owner', `${base} ("founder" OR "owner" OR "independent" OR "self-employed")`],
          ['regional-credential', `${base} ("ICF" OR "PCC" OR "ACC" OR "MCC")`],
          ['regional-1on1', `${base} ("1:1" OR "one-on-one")`],
        ];
        for (const [templateId, query] of reserve) {
          add(regionalQueries, { templateId, query, location: loc, niche: title, searchPhase: 'regional', searchArea: `${region}, ${expansion.country}` });
        }
      }
    }
  }
  // Keep country-first staging, with diversity across titles and locations within each stage.
  return [countryQueries, aliasQueries, regionalQueries].flatMap(bank => {
    const groups = new Map<string, DiscoveryQuery[]>();
    for (const query of bank) {
      const key = `${query.niche}|${query.location}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(query);
    }
    const buckets = [...groups.values()];
    const result: DiscoveryQuery[] = [];
    const depth = Math.max(0, ...buckets.map(bucket => bucket.length));
    for (let i = 0; i < depth; i++) for (const bucket of buckets) if (bucket[i]) result.push(bucket[i]);
    return result;
  });
}


// ═════════════════════════════════════════════════════════════════
//  HELPER FUNCTIONS
// ═════════════════════════════════════════════════════════════════

function isNoiseDomain(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    const host = url.hostname.toLowerCase();
    for (const d of NOISE_DOMAINS) {
      if (host === d || host.endsWith('.' + d)) return true;
    }
    // Also reject non-profile LinkedIn pages
    const path = url.pathname.toLowerCase();
    if (host.includes('linkedin.com') && !path.startsWith('/in/')) return true;
  } catch (e) {
    // Ignore invalid URLs
  }
  return false;
}

function extractNicheSignals(jobTitles: string[]): NicheSignals {
  const phrases = new Set<string>();
  const role_words = new Set<string>();
  const titles_lower: string[] = [];

  for (const title of jobTitles) {
    const titleLower = title.toLowerCase().trim();
    titles_lower.push(titleLower);
    phrases.add(titleLower);

    const words = titleLower.split(' ');

    // Bigrams
    for (let i = 0; i < words.length - 1; i++) {
      phrases.add(`${words[i]} ${words[i + 1]}`);
    }

    // Role words via stem expansion
    for (const word of words) {
      for (const [stem, variants] of Object.entries(ROLE_STEMS)) {
        if (variants.includes(word) || word === stem) {
          variants.forEach(v => role_words.add(v));
        }
      }
    }
  }

  // Remove generic words
  GENERIC_WORDS.forEach(w => role_words.delete(w));

  return { phrases, role_words, titles_lower };
}

function extractHeadlineFromGoogleTitle(googleTitle: string): string | null {
  if (!googleTitle) return null;

  let title = googleTitle.replace(/–/g, '-').replace(/—/g, '-');
  title = title.replace(/\s*[|\-]\s*LinkedIn\s*$/i, '').trim();

  const parts = title.split(' - ').map(p => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return parts.slice(1).join(' - ').toLowerCase();
  }
  return null;
}

/**
 * Scores one SERP result.
 *
 * Location is gated separately using person-location evidence, before scoring.
 * A query keyword cannot establish the person's location.
 *
 * Replaces the old `isResultRelevant`, which answered a yes/no question and then
 * discarded the `confidence` it had just computed — the engine ignored the return
 * value's second field entirely. That distinction is now the difference between
 * weights A1 and A2, and it is persisted.
 */
function evaluateResult(
  item: any,
  nicheSignals: NicheSignals,
  seenCount: number,
): DiscoveryScore {
  const link = (item.link || "").toLowerCase();
  if (isNoiseDomain(link)) {
    return { score: 0, reasons: [], reject: 'no_headline_match', confidence: 'none' };
  }

  const title = item.title || "";
  return scoreDiscoveryResult(
    {
      headline: extractHeadlineFromGoogleTitle(title),
      title,
      snippet: item.snippet || "",
      seenCount,
    },
    { phrases: [...nicheSignals.phrases], roleWords: [...nicheSignals.role_words] },
    NEGATIVE_KEYWORDS,
  );
}


// ═════════════════════════════════════════════════════════════════
//  SERPER API SEARCH
// ═════════════════════════════════════════════════════════════════

class DiscoveryCancelledError extends Error {}

/** One pool per run: exhausted/invalid keys are skipped on every subsequent page. */
export function createSerperSearcher(apiKeys: string | string[]) {
  const keys = [...new Set((Array.isArray(apiKeys) ? apiKeys : [apiKeys]).map(key => key.trim()).filter(Boolean))];
  if (!keys.length) throw new Error('No Serper search API keys are configured.');
  const disabled = new Map<string, string>();
  let nextKey = 0;
  const unavailable = () => new Error(`All configured Serper API keys are unavailable: ${[...new Set(disabled.values())].join('; ')}. Add credits or update an available key before retrying.`);

  return async (query: string, page = 1, onAttempt?: () => void | Promise<void>): Promise<any[]> => {
    let lastError = 'The search service could not be reached.';
    for (let round = 0; round < 3; round++) {
      if (disabled.size === keys.length) throw unavailable();
      const order = Array.from({ length: keys.length }, (_, index) => (nextKey + index) % keys.length);
      let retryDelay = 0;
      for (const index of order) {
        const key = keys[index];
        if (disabled.has(key)) continue;
        nextKey = (index + 1) % keys.length;
        await onAttempt?.();
        let response: Response;
        let data: any;
        try {
          response = await fetch('https://google.serper.dev/search', {
            method: 'POST',
            headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
            body: JSON.stringify({ q: query, num: 10, page }),
            signal: AbortSignal.timeout(20_000),
          });
          data = await response.json().catch(() => null);
        } catch {
          lastError = 'Serper request timed out or could not reach the search service.';
          retryDelay = Math.max(retryDelay, 5000);
          continue;
        }
        if (response.status === 200) return Array.isArray(data?.organic) ? data.organic : [];

        let message = typeof data?.message === 'string' ? data.message : typeof data?.error === 'string' ? data.error : '';
        for (const configuredKey of keys) message = message.replaceAll(configuredKey, '[redacted]');
        message = message.replace(/[\r\n\t]/g, ' ').slice(0, 300);
        lastError = `Serper search failed (HTTP ${response.status})${message ? ': ' + message : '.'}`;
        const exhausted = response.status === 400 && /(?:not enough|insufficient|out of|exhausted|no remaining) credits|credits? (?:exhausted|depleted)|quota (?:exceeded|exhausted)/i.test(message);
        if (exhausted || [401, 402, 403].includes(response.status)) {
          disabled.set(key, lastError);
          continue;
        }
        if (response.status === 429) {
          retryDelay = Math.max(retryDelay, 10000 * Math.pow(2, round));
          continue;
        }
        if (response.status >= 500) {
          retryDelay = Math.max(retryDelay, 5000);
          continue;
        }
        // A malformed request will fail for every key; surface it immediately.
        throw new Error(`Search could not finish: ${lastError}`);
      }
      if (disabled.size === keys.length) throw unavailable();
      if (round < 2 && retryDelay) {
        await onAttempt?.();
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
    throw new Error(`Search could not finish after retries: ${lastError}`);
  };
}


// `prequalifyViaGoogle` was deleted here.
//
// It re-searched every candidate's own slug — a full Serper credit each — purely
// to re-read the headline that the original result had already returned in its
// title tag, which `extractHeadlineFromGoogleTitle` parses for free. It also
// failed open on every error path (`bad_url`, `not_indexed`, `parse_failed`,
// `error:*` all returned `passed: true`), so it rejected almost nothing while
// roughly doubling the credit cost of a run. Everything it checked, the scorer now
// does at zero marginal cost.


// ═════════════════════════════════════════════════════════════════
//  MAIN ENGINE
// ═════════════════════════════════════════════════════════════════

export async function runDorkEngine(
  config: SearchConfig,
  apiKeys: string | string[],
  onProgress?: (p: DorkProgress) => void | Promise<void>,
  onLeadFound?: (lead: DiscoveredLead) => void | Promise<void>,
  shouldCancel?: () => boolean,
): Promise<DorkRunResult> {
  const nicheSignals = extractNicheSignals(config.job_titles);
  // Only terms the caller explicitly asks for go into the query string.
  //
  // The obvious "fix" here is to make NEGATIVE_KEYWORDS apply — it never has, since
  // `config.negative_keywords || NEGATIVE_KEYWORDS` sees an empty array as truthy.
  // But applying it here is a recall regression, not a fix: `-"recruiter"` against
  // site:linkedin.com/in drops any profile whose indexed text mentions a recruiter
  // anywhere — a coach who posted about hiring, or one with a recruiter in "People
  // also viewed". Every term shrinks every template's reach, and the SERP is paid
  // for either way. The blocklist is applied by the scorer instead, against the
  // parsed headline, where it means what it is supposed to mean — this person's
  // stated job is not our ICP — and costs nothing.
  const queries = buildDiscoverySearchPlan(config);
  const maxTarget = keptLeadTarget(config);
  const maxPages = config.max_pages_per_dork ?? 4;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 10) throw new Error('Pages per search must be a whole number from 1 to 10.');
  const minFitScore = config.min_fit_score ?? DEFAULT_MIN_FIT_SCORE;
  if (!Number.isFinite(minFitScore) || minFitScore < 0 || minFitScore > 100) throw new Error('Minimum score must be from 0 to 100.');
  const runId = config.run_id || `run-${Date.now()}`;
  const serperSearch = createSerperSearcher(apiKeys);

  /** url → the accepted lead, so a re-find can bump seenCount without a second write. */
  const kept = new Map<string, DiscoveredLead>();
  const stats: DorkRunStats = {
    runId,
    templates: queries.length,
    creditsSpent: 0,
    scored: 0,
    kept: 0,
    rejected: 0,
    belowFloor: 0,
    rejectsByReason: {},
    cancelled: false,
    target: maxTarget,
    targetReached: false,
    stopReason: 'search_exhausted',
    queriesCompleted: 0,
  };

  const report = async (qIdx: number, qObj: DiscoveryQuery) => { await onProgress?.({
    found: kept.size,
    target: maxTarget,
    remaining: Math.max(0, maxTarget - kept.size),
    searchPhase: qObj.searchPhase,
    searchArea: qObj.searchArea,
    scored: stats.scored,
    rejected: stats.rejected + stats.belowFloor,
    totalQueries: queries.length,
    queryIndex: qIdx + 1,
    query: qObj.query,
    templateId: qObj.templateId,
    creditsSpent: stats.creditsSpent,
  }); };

  console.log(`[DorkEngine] ${queries.length} queries, target ${maxTarget}, maxPages ${maxPages}, fit floor ${minFitScore}`);

  outer:
  for (let qIdx = 0; qIdx < queries.length; qIdx++) {
    const qObj = queries[qIdx];
    if (kept.size >= maxTarget) break;
    if (shouldCancel?.()) { stats.cancelled = true; break; }

    let queryDryPages = 0;
    for (let page = 1; page <= maxPages; page++) {
      if (kept.size >= maxTarget) break;
      if (shouldCancel?.()) { stats.cancelled = true; break outer; }

      let results: any[];
      try {
        results = await serperSearch(qObj.query, page, async () => {
          if (shouldCancel?.()) throw new DiscoveryCancelledError('Discovery stopped.');
          await report(qIdx, qObj);
        });
      } catch (error) {
        if (error instanceof DiscoveryCancelledError) { stats.cancelled = true; break outer; }
        throw error;
      }
      stats.creditsSpent++;
      stats.queriesCompleted = qIdx + 1;

      if (results.length === 0) { await report(qIdx, qObj); break; }

      let newThisPage = 0;

      for (let rank = 0; rank < results.length; rank++) {
        // The target counts kept profiles, and no extra row from this page is written after it is met.
        if (kept.size >= maxTarget) break;
        if (shouldCancel?.()) { stats.cancelled = true; await report(qIdx, qObj); break outer; }
        const item = results[rank];
        const norm = normaliseLinkedinUrl(item.link || '');
        if (!norm) continue;
        const geography=assessDiscoveryLocation(item,qObj.location);
        if(geography.status!=='CONFIRMED'||!geography.evidence){
          stats.scored++;stats.rejected++;
          const reason=geography.reasonCode||'LOCATION_UNCONFIRMED';
          stats.rejectsByReason[reason]=(stats.rejectsByReason[reason]||0)+1;
          continue;
        }

        // A re-find is not a new lead, but it *is* evidence (weight A8): a profile
        // several distinct dorks can reach is well indexed, which usually means an
        // established practitioner rather than a stub.
        //
        // The re-score is what makes A8 reachable at all. Scoring happens on first
        // sighting, when the count is always 1, so without this the weight could
        // never fire. It runs once, at the 1→2 transition — A8 is a flat bonus, so
        // later sightings change nothing and re-scoring them would be waste.
        const already = kept.get(norm);
        if (already) {
          already.seenCount++;
          if (already.seenCount === 2) {
            const rescored = evaluateResult(item, nicheSignals, already.seenCount);
            if (!rescored.reject && rescored.score > already.fitScore) {
              already.fitScore = rescored.score;
              already.fitReasons = rescored.reasons;
            }
          }
          // Re-emitted so the stored seen count matches reality; the writer keeps
          // first-touch provenance and only ever takes a higher score.
          if (onLeadFound) await onLeadFound(already);
          continue;
        }

        stats.scored++;
        const verdict = evaluateResult(item, nicheSignals, 1);

        if (verdict.reject) {
          stats.rejected++;
          stats.rejectsByReason[verdict.reject] = (stats.rejectsByReason[verdict.reject] || 0) + 1;
          continue;
        }

        // The write floor is cheap insurance against filling the table with junk,
        // not the selectivity mechanism — that is the queue ordering, which stays
        // re-tunable and applies retroactively to everything already scored.
        if (verdict.score < minFitScore) {
          stats.belowFloor++;
          continue;
        }

        const lead: DiscoveredLead = {
          url: norm,
          location: geography.evidence.country,
          searchLocation:qObj.location,
          locationEvidence:geography.evidence,
          templateId: qObj.templateId,
          query: qObj.query,
          niche: qObj.niche,
          page,
          rank: rank + 1,
          title: item.title || '',
          snippet: item.snippet || '',
          fitScore: verdict.score,
          fitReasons: verdict.reasons,
          confidence: verdict.confidence,
          seenCount: 1,
          runId,
        };

        if (onLeadFound) await onLeadFound(lead);
        kept.set(norm, lead);
        stats.kept++;
        newThisPage++;
      }

      await report(qIdx, qObj);
      if (newThisPage === 0) {
        queryDryPages++;
        if (queryDryPages >= 3) break;
      } else {
        queryDryPages = 0;
      }

      if (kept.size < maxTarget && page < maxPages) await new Promise(r => setTimeout(r, 500));
    }
  }

  stats.targetReached = kept.size >= maxTarget;
  stats.stopReason = stats.targetReached ? 'target_reached' : stats.cancelled ? 'cancelled' : 'search_exhausted';
  console.log(
    `[DorkEngine] Done. Scored ${stats.scored}, kept ${stats.kept}, ` +
    `rejected ${stats.rejected} (+${stats.belowFloor} below floor), ${stats.creditsSpent} credits.`,
  );

  return { leads: [...kept.values()], stats };
}
