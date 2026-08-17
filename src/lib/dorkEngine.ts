import { normaliseLinkedinUrl } from './utils';

// ═════════════════════════════════════════════════════════════════
//  TYPES
// ═════════════════════════════════════════════════════════════════

export interface SearchConfig {
  job_titles: string[];
  locations: string[];
  max_urls_target?: number;
  max_pages_per_dork?: number;
  prequalify?: boolean;
  negative_keywords?: string[];
}

interface NicheSignals {
  phrases: Set<string>;
  role_words: Set<string>;
  titles_lower: string[];
}

interface DorkResult {
  url: string;
  location: string;
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


// ═════════════════════════════════════════════════════════════════
//  LOCATION ALIASES
//  Expands short location names (e.g. "US") into an array of
//  city/state/country names so result filtering doesn't reject
//  someone in "San Francisco, California" when searching for "US".
// ═════════════════════════════════════════════════════════════════

const LOCATION_ALIASES: Record<string, string[]> = {
  'us': [
    'united states', 'usa', 'u.s.', 'america',
    'new york', 'los angeles', 'chicago', 'houston', 'phoenix',
    'philadelphia', 'san antonio', 'san diego', 'dallas', 'san jose',
    'austin', 'jacksonville', 'san francisco', 'columbus', 'charlotte',
    'indianapolis', 'seattle', 'denver', 'washington', 'boston',
    'nashville', 'detroit', 'portland', 'las vegas', 'memphis',
    'louisville', 'baltimore', 'milwaukee', 'albuquerque', 'tucson',
    'fresno', 'sacramento', 'atlanta', 'miami', 'raleigh',
    'minneapolis', 'tampa', 'orlando', 'pittsburgh', 'cleveland',
    'st. louis', 'kansas city', 'colorado springs', 'omaha',
    'california', 'texas', 'florida', 'illinois', 'pennsylvania',
    'ohio', 'georgia', 'north carolina', 'michigan', 'new jersey',
    'virginia', 'arizona', 'massachusetts', 'tennessee', 'indiana',
    'missouri', 'maryland', 'wisconsin', 'colorado', 'minnesota',
    'south carolina', 'alabama', 'louisiana', 'kentucky', 'oregon',
    'oklahoma', 'connecticut', 'iowa', 'utah', 'nevada', 'arkansas',
    'kansas', 'mississippi', 'nebraska', 'new mexico', 'idaho', 'hawaii',
    'greater new york', 'greater los angeles', 'greater chicago',
    'greater boston', 'greater seattle', 'greater denver',
    'greater atlanta', 'greater miami', 'greater dallas',
    'san francisco bay', 'silicon valley', 'tri-state',
  ],
  'uk': [
    'united kingdom', 'england', 'scotland', 'wales', 'northern ireland',
    'great britain', 'britain',
    'london', 'birmingham', 'manchester', 'glasgow', 'newcastle',
    'sheffield', 'leeds', 'liverpool', 'bristol', 'edinburgh',
    'cardiff', 'belfast', 'nottingham', 'leicester', 'coventry',
    'bradford', 'brighton', 'oxford', 'cambridge', 'reading',
    'southampton', 'portsmouth', 'exeter', 'york', 'bath',
    'norwich', 'plymouth', 'aberdeen', 'dundee', 'swansea',
    'surrey', 'kent', 'essex', 'sussex', 'hampshire',
    'devon', 'cornwall', 'lancashire', 'yorkshire', 'hertfordshire',
    'greater london', 'greater manchester',
    'west midlands', 'east midlands', 'south east', 'south west',
    'north west', 'north east', 'east anglia',
  ],
  'canada': [
    'toronto', 'vancouver', 'montreal', 'calgary', 'edmonton',
    'ottawa', 'winnipeg', 'quebec', 'hamilton', 'kitchener',
    'victoria', 'halifax', 'oshawa', 'windsor', 'saskatoon',
    'regina', 'kelowna', 'quebec city', 'barrie', 'london, on',
    'ontario', 'british columbia', 'alberta', 'nova scotia',
    'manitoba', 'saskatchewan', 'new brunswick', 'prince edward island',
    'greater toronto', 'greater vancouver', 'greater montreal',
  ],
  'australia': [
    'sydney', 'melbourne', 'brisbane', 'perth', 'adelaide',
    'canberra', 'hobart', 'darwin', 'gold coast', 'newcastle',
    'new south wales', 'victoria', 'queensland', 'western australia',
    'south australia', 'tasmania', 'greater sydney', 'greater melbourne',
  ],
};

function expandLocation(location: string): string[] {
  const lower = location.toLowerCase().trim();
  const aliases = LOCATION_ALIASES[lower];
  if (aliases) {
    return [lower, ...aliases];
  }
  return [lower];
}


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
//  107 elite dork patterns per title × location combination.
//  Organized by category so each template hits a DIFFERENT slice
//  of Google's LinkedIn index.
// ═════════════════════════════════════════════════════════════════

function buildQueryBank(title: string, loc: string, negString: string): string[] {
  const T = title;
  const L = loc;
  const N = negString;

  const queries: string[] = [];

  // ─── CATEGORY 1: CORE OPERATORS (5) ───────────────────────
  // Each uses a different Google operator → different index path
  queries.push(
    `site:linkedin.com/in "${T}" "${L}"${N}`,
    `site:linkedin.com/in intitle:"${T}" "${L}"${N}`,
    `inurl:linkedin.com/in "${T}" "${L}"${N}`,
    `site:linkedin.com/in "${T}" AND "${L}"${N}`,
    `site:linkedin.com/in "${T}" "${L}" -dir -jobs -pulse${N}`,
  );

  // ─── CATEGORY 2: LINKEDIN PROFILE SECTIONS (11) ──────────
  // Target different indexed sections of LinkedIn profiles
  for (const section of [
    'Experience', 'About', 'Skills', 'Contact info', 'Connections',
    'Activity', 'Education', 'Certifications', 'Recommendations',
    'Honors', 'Projects'
  ]) {
    queries.push(`site:linkedin.com/in "${T}" "${L}" "${section}"${N}`);
  }

  // ─── CATEGORY 3: LOCATION FORMAT VARIATIONS (7) ──────────
  queries.push(
    `site:linkedin.com/in "${T}" "Greater ${L}"${N}`,
    `site:linkedin.com/in "${T}" "${L} Area"${N}`,
    `site:linkedin.com/in "${T}" "Greater ${L} Area"${N}`,
    `site:linkedin.com/in "${T}" "${L} Metropolitan"${N}`,
    `site:linkedin.com/in "${T}" near "${L}"${N}`,
    `site:linkedin.com/in intitle:"${T}" "Location * ${L}"${N}`,
    `site:linkedin.com/in "${T}" "based in ${L}"${N}`,
  );

  // ─── CATEGORY 4: PROFESSIONAL IDENTITY (18) ──────────────
  // Keywords that indicate someone is ACTIVELY practicing this role
  for (const signal of [
    'helping', 'founder', 'CEO', 'owner', 'speaker', 'author',
    'certified', 'specialist', 'expert', 'freelance', 'independent',
    'self-employed', 'entrepreneur', 'practitioner', 'dedicated',
    'award-winning', 'published', 'licensed'
  ]) {
    queries.push(`site:linkedin.com/in "${T}" "${L}" "${signal}"${N}`);
  }

  // ─── CATEGORY 5: ACTION/SERVICE VERBS (14) ───────────────
  // Words people use in headlines to describe what they DO
  for (const verb of [
    'I help', 'I work with', 'specializing in', 'empowering',
    'transforming', 'supporting', 'guiding', 'enabling',
    'passionate about', 'committed to', 'focused on',
    'working with', 'partnering with', 'dedicated to'
  ]) {
    queries.push(`site:linkedin.com/in "${T}" "${L}" "${verb}"${N}`);
  }

  // ─── CATEGORY 6: CREDENTIAL & SENIORITY (14) ─────────────
  // Title modifiers that find different people
  for (const prefix of [
    'certified', 'senior', 'lead', 'head', 'principal', 'master'
  ]) {
    queries.push(`site:linkedin.com/in "${prefix} ${T}" "${L}"${N}`);
  }
  // Certification acronyms common in coaching/consulting
  for (const cert of ['ICF', 'PCC', 'ACC', 'MCC', 'CPC', 'NLP', 'MBA', 'PhD']) {
    queries.push(`site:linkedin.com/in "${T}" "${cert}" "${L}"${N}`);
  }

  // ─── CATEGORY 7: BUSINESS SIGNALS (10) ───────────────────
  for (const biz of [
    'company', 'agency', 'firm', 'studio', 'consulting',
    'services', 'solutions', 'group', 'institute', 'academy'
  ]) {
    queries.push(`site:linkedin.com/in "${T}" "${L}" "${biz}"${N}`);
  }

  // ─── CATEGORY 8: CLIENT/DELIVERY (10) ────────────────────
  for (const cs of [
    'clients', 'results', 'transformation', 'program',
    'workshop', 'retreat', 'course', 'webinar', 'podcast', 'blog'
  ]) {
    queries.push(`site:linkedin.com/in "${T}" "${L}" "${cs}"${N}`);
  }

  // ─── CATEGORY 9: BOOLEAN COMBOS (8) ─────────────────────
  queries.push(
    `site:linkedin.com/in ("${T}" OR "${T}s") "${L}"${N}`,
    `site:linkedin.com/in intitle:"${T}" AND "${L}" -company -jobs${N}`,
    `site:linkedin.com/in "${T}" "${L}" -recruit -hiring -job${N}`,
    `site:linkedin.com/in "${T}" "${L}" ("website" OR "blog")${N}`,
    `site:linkedin.com/in "${T}" "${L}" ("book" OR "author")${N}`,
    `site:linkedin.com/in "${T}" "${L}" ("TEDx" OR "keynote")${N}`,
    `site:linkedin.com/in "${T}" "${L}" ("training" OR "workshop")${N}`,
    `site:linkedin.com/in "${T}" "${L}" ("1:1" OR "one-on-one")${N}`,
  );

  // ─── CATEGORY 10: NICHE-DEPTH (10) ──────────────────────
  for (const nd of [
    'mindset', 'growth', 'accountability', 'clarity',
    'breakthrough', 'strategy session', 'discovery call',
    'high-performance', 'goal-setting', 'work-life balance'
  ]) {
    queries.push(`site:linkedin.com/in "${T}" "${L}" "${nd}"${N}`);
  }

  return queries; // 107 templates total
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
 * Check if a Google result is relevant to our niche.
 *
 * IMPORTANT: We do NOT hard-reject based on location here.
 * The Google query itself already includes the location string,
 * so Google handles geo-filtering. This function focuses purely
 * on NICHE relevance (is this person actually a coach/consultant/etc).
 */
function isResultRelevant(
  item: any,
  nicheSignals: NicheSignals,
  location: string,
  locationVariants: string[]
): { isRelevant: boolean, confidence: string } {
  const title = item.title || "";
  const snippet = (item.snippet || "").toLowerCase();
  const link = (item.link || "").toLowerCase();

  // Hard reject noise domains
  if (isNoiseDomain(link)) return { isRelevant: false, confidence: 'none' };

  // Extract the LinkedIn headline from Google's title tag
  const headline = extractHeadlineFromGoogleTitle(title);

  // Check if any negative keyword appears prominently
  const combined = `${(headline || '').toLowerCase()} ${snippet}`;

  if (headline) {
    // HIGH confidence: headline directly contains a niche phrase
    for (const phrase of nicheSignals.phrases) {
      if (headline.includes(phrase)) return { isRelevant: true, confidence: 'high' };
    }
    // LOW confidence: headline contains a role word
    for (const rw of nicheSignals.role_words) {
      const regex = new RegExp(`\\b${rw}\\b`);
      if (regex.test(headline)) return { isRelevant: true, confidence: 'low' };
    }
    // If we got a headline but it doesn't match at all → reject
    return { isRelevant: false, confidence: 'none' };
  }

  // No headline parsed → check title + snippet for niche phrases
  const fullText = `${title.toLowerCase()} ${snippet}`;
  for (const phrase of nicheSignals.phrases) {
    if (fullText.includes(phrase)) return { isRelevant: true, confidence: 'low' };
  }
  for (const rw of nicheSignals.role_words) {
    if (fullText.includes(rw)) return { isRelevant: true, confidence: 'low' };
  }

  return { isRelevant: false, confidence: 'none' };
}


// ═════════════════════════════════════════════════════════════════
//  SERPER API SEARCH
// ═════════════════════════════════════════════════════════════════

async function serperSearch(query: string, apiKeys: string | string[], page: number = 1): Promise<any[]> {
  const url = "https://google.serper.dev/search";
  const payload = { q: query, num: 10, page };
  const keys = Array.isArray(apiKeys) ? apiKeys : [apiKeys];

  for (let attempt = 0; attempt < 3; attempt++) {
    const apiKey = keys[Math.floor(Math.random() * keys.length)];
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'X-API-KEY': apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (res.status === 429) {
        const wait = 10000 * Math.pow(2, attempt);
        console.log(`[DorkEngine] Rate limited, waiting ${wait / 1000}s...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      if (res.status !== 200) {
        console.error(`[DorkEngine] Serper API Error: ${res.status} - ${await res.text()}`);
        return [];
      }

      const data = await res.json();
      return data.organic || [];
    } catch (e) {
      console.error(`[DorkEngine] Serper Request Failed:`, e);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  return [];
}


// ═════════════════════════════════════════════════════════════════
//  LAYER 2: PRE-QUALIFICATION VIA GOOGLE
//  Re-searches each candidate's LinkedIn slug to verify their
//  headline actually matches the target niche.
// ═════════════════════════════════════════════════════════════════

async function prequalifyViaGoogle(
  url: string,
  apiKeys: string | string[],
  nicheSignals: NicheSignals
): Promise<{ url: string, passed: boolean, reason: string }> {
  try {
    const slugMatch = url.match(/\/in\/([\w-]+)/);
    if (!slugMatch) return { url, passed: true, reason: 'bad_url' };

    const slug = slugMatch[1];
    const query = `site:linkedin.com/in/${slug}`;

    const results = await serperSearch(query, apiKeys, 1);

    if (results.length === 0) return { url, passed: true, reason: 'not_indexed' };

    const googleTitle = results[0].title || '';
    const headline = extractHeadlineFromGoogleTitle(googleTitle);

    if (!headline) return { url, passed: true, reason: 'parse_failed' };

    for (const phrase of nicheSignals.phrases) {
      if (headline.includes(phrase)) return { url, passed: true, reason: `verified:${phrase}` };
    }

    for (const rw of nicheSignals.role_words) {
      const regex = new RegExp(`\\b${rw}\\b`);
      if (regex.test(headline)) return { url, passed: true, reason: `verified:${rw}` };
    }

    return { url, passed: false, reason: `off_niche:${headline.substring(0, 60)}` };
  } catch (e: any) {
    return { url, passed: true, reason: `error:${e.message.substring(0, 40)}` };
  }
}


// ═════════════════════════════════════════════════════════════════
//  MAIN ENGINE
// ═════════════════════════════════════════════════════════════════

export async function runDorkEngine(
  config: SearchConfig,
  apiKeys: string | string[],
  onProgress?: (found: number, totalQueries: number, qIdx: number, query: string) => void,
  onLeadFound?: (url: string, location: string) => void
): Promise<DorkResult[]> {
  const nicheSignals = extractNicheSignals(config.job_titles);
  const negatives = (config.negative_keywords || NEGATIVE_KEYWORDS).slice(0, 8);
  const negString = negatives.length > 0 ? ' ' + negatives.map(n => `-"${n}"`).join(' ') : '';

  // ── Build the full query bank ──
  const queries: { query: string, location: string }[] = [];
  for (const title of config.job_titles) {
    for (const loc of config.locations) {
      const templates = buildQueryBank(title, loc, negString);
      for (const q of templates) {
        queries.push({ query: q, location: loc });
      }
    }
  }

  // Shuffle for diversity — ensures we hit different categories
  // even if we stop early after reaching the target
  queries.sort(() => Math.random() - 0.5);

  const maxTarget = config.max_urls_target || 5000;
  const maxPages = config.max_pages_per_dork || 20;
  const prequalEnabled = config.prequalify !== false;

  // Pre-compute location expansions for each location
  const locationExpansions = new Map<string, string[]>();
  for (const loc of config.locations) {
    locationExpansions.set(loc, expandLocation(loc));
  }

  const allUrls = new Map<string, string>(); // url → location
  let prequalPending = new Set<string>();
  const pendingLocations = new Map<string, string>();

  console.log(`[DorkEngine] Starting with ${queries.length} queries, target: ${maxTarget}, maxPages: ${maxPages}`);

  for (let qIdx = 0; qIdx < queries.length; qIdx++) {
    const qObj = queries[qIdx];

    if (allUrls.size + prequalPending.size >= maxTarget) break;

    const locVariants = locationExpansions.get(qObj.location) || [qObj.location.toLowerCase()];

    let queryDryPages = 0;
    for (let page = 1; page <= maxPages; page++) {
      if (allUrls.size + prequalPending.size >= maxTarget) break;

      const results = await serperSearch(qObj.query, apiKeys, page);

      if (results.length === 0) break;

      let newThisPage = 0;

      for (const item of results) {
        const link = item.link || '';
        const norm = normaliseLinkedinUrl(link);
        if (!norm) continue;

        const { isRelevant } = isResultRelevant(item, nicheSignals, qObj.location, locVariants);

        if (isRelevant) {
          if (!allUrls.has(norm) && !prequalPending.has(norm)) {
            if (prequalEnabled) {
              prequalPending.add(norm);
              pendingLocations.set(norm, qObj.location);
            } else {
              allUrls.set(norm, qObj.location);
              if (onLeadFound) onLeadFound(norm, qObj.location);
            }
            newThisPage++;
          }
        }
      }

      if (newThisPage === 0) {
        queryDryPages++;
        if (queryDryPages >= 3) break;
      } else {
        queryDryPages = 0;
      }

      if (onProgress) {
        onProgress(allUrls.size + prequalPending.size, queries.length, qIdx + 1, qObj.query);
      }

      if (page < maxPages) await new Promise(r => setTimeout(r, 500));
    }

    // Process prequal batch if large enough
    if (prequalEnabled && prequalPending.size >= 10) {
      const batch = Array.from(prequalPending);
      prequalPending.clear();

      const verifyResults = await Promise.all(
        batch.map(url => prequalifyViaGoogle(url, apiKeys, nicheSignals))
      );

      for (const res of verifyResults) {
        if (res.passed) {
          const loc = pendingLocations.get(res.url) || 'Unknown';
          allUrls.set(res.url, loc);
          if (onLeadFound) onLeadFound(res.url, loc);
        }
      }

      console.log(`[DorkEngine] Prequal batch: ${batch.length} checked, ${verifyResults.filter(r => r.passed).length} passed`);
    }
  }

  // Final prequal batch
  if (prequalPending.size > 0) {
    const batch = Array.from(prequalPending);
    prequalPending.clear();
    const verifyResults = await Promise.all(
      batch.map(url => prequalifyViaGoogle(url, apiKeys, nicheSignals))
    );
    for (const res of verifyResults) {
      if (res.passed) {
        const loc = pendingLocations.get(res.url) || 'Unknown';
        allUrls.set(res.url, loc);
        if (onLeadFound) onLeadFound(res.url, loc);
      }
    }
    console.log(`[DorkEngine] Final prequal: ${batch.length} checked, ${verifyResults.filter(r => r.passed).length} passed`);
  }

  console.log(`[DorkEngine] Complete. Found ${allUrls.size} unique leads.`);

  return Array.from(allUrls.entries())
    .map(([url, location]) => ({ url, location }))
    .slice(0, maxTarget);
}
