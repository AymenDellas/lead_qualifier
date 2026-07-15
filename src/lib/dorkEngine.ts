import { normaliseLinkedinUrl } from './utils';

// Types
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

const NOISE_DOMAINS = new Set([
  'coachfoundation.com', 'noomii.com', 'thumbtack.com', 'bark.com',
  'yelp.com', 'glassdoor.com', 'indeed.com', 'ziprecruiter.com',
  'crunchbase.com', 'clutch.co', 'g2.com', 'trustpilot.com',
  'topresume.com', 'thecoachingacademy.com', 'lifecoachmagazine.com',
  'coaching-online.org', 'life-coach-directory.com', 'findacoach.com',
  'coachingfederation.org', 'coachingaggregator.com', 'betterup.com',
  'tonyrobbins.com', 'udemy.com', 'coursera.org',
]);

const NEGATIVE_KEYWORDS = [
  'recruiter', 'software engineer', 'developer', 'sales manager',
  'project manager', 'product manager', 'data scientist', 'accountant',
  'human resources', 'HR manager', 'marketing manager', 'nurse',
  'teacher', 'professor', 'attorney', 'lawyer', 'dentist', 'doctor',
  'real estate', 'insurance agent',
];

const ROLE_STEMS: Record<string, string[]> = {
  'coach': ['coach', 'coaching'],
  'mentor': ['mentor', 'mentoring', 'mentorship'],
  'consultant': ['consultant', 'consulting'],
  'trainer': ['trainer', 'training'],
  'advisor': ['advisor', 'adviser', 'advisory'],
  'strategist': ['strategist', 'strategy'],
  'counselor': ['counselor', 'counsellor', 'counseling', 'counselling'],
  'therapist': ['therapist', 'therapy'],
  'facilitator': ['facilitator', 'facilitation'],
};

const GENERIC_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'for', 'in', 'at', 'to',
  'business', 'life', 'career', 'executive', 'leadership',
  'performance', 'personal', 'professional', 'senior', 'chief'
]);

function isNoiseDomain(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    const host = url.hostname.toLowerCase();
    for (const d of NOISE_DOMAINS) {
      if (host === d || host.endsWith('.' + d)) return true;
    }
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

    // Role words
    for (const word of words) {
      for (const [stem, variants] of Object.entries(ROLE_STEMS)) {
        if (variants.includes(word) || word === stem) {
          variants.forEach(v => role_words.add(v));
        }
      }
    }
  }

  // Remove generic words from role_words
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

function isResultRelevant(item: any, nicheSignals: NicheSignals, location: string): { isRelevant: boolean, confidence: string } {
  const title = item.title || "";
  const snippet = (item.snippet || "").toLowerCase();
  const link = (item.link || "").toLowerCase();

  if (location) {
    const locLower = location.toLowerCase();
    if (!title.toLowerCase().includes(locLower) && !snippet.includes(locLower)) {
      return { isRelevant: false, confidence: 'none' };
    }
  }

  if (isNoiseDomain(link)) return { isRelevant: false, confidence: 'none' };

  const headline = extractHeadlineFromGoogleTitle(title);

  if (headline) {
    for (const phrase of nicheSignals.phrases) {
      if (headline.includes(phrase)) return { isRelevant: true, confidence: 'high' };
    }
    for (const rw of nicheSignals.role_words) {
      const regex = new RegExp(`\\b${rw}\\b`);
      if (regex.test(headline)) return { isRelevant: true, confidence: 'low' };
    }
    return { isRelevant: false, confidence: 'none' };
  }

  const combined = `${title.toLowerCase()} ${snippet}`;
  for (const phrase of nicheSignals.phrases) {
    if (combined.includes(phrase)) return { isRelevant: true, confidence: 'low' };
  }
  for (const rw of nicheSignals.role_words) {
    if (combined.includes(rw)) return { isRelevant: true, confidence: 'low' };
  }

  return { isRelevant: false, confidence: 'none' };
}

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
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      if (res.status !== 200) {
        console.error(`Serper API Error: ${res.status} - ${await res.text()}`);
        return [];
      }

      const data = await res.json();
      return data.organic || [];
    } catch (e) {
      console.error(`Serper Request Failed:`, e);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  return [];
}

async function prequalifyViaGoogle(url: string, apiKeys: string | string[], nicheSignals: NicheSignals): Promise<{url: string, passed: boolean, reason: string}> {
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

export async function runDorkEngine(
  config: SearchConfig, 
  apiKeys: string | string[],
  onProgress?: (found: number, totalQueries: number, qIdx: number, query: string) => void
): Promise<DorkResult[]> {
  const nicheSignals = extractNicheSignals(config.job_titles);
  const negatives = (config.negative_keywords || NEGATIVE_KEYWORDS).slice(0, 8);
  const negString = negatives.length > 0 ? ' ' + negatives.map(n => `-"${n}"`).join(' ') : '';

  const queries: { query: string, location: string }[] = [];
  for (const title of config.job_titles) {
    for (const loc of config.locations) {
      queries.push({
        query: `site:linkedin.com/in "${title}" "${loc}"${negString}`,
        location: loc
      });
    }
  }

  // Shuffle queries
  queries.sort(() => Math.random() - 0.5);

  const maxTarget = config.max_urls_target || 500;
  const maxPages = Math.min(config.max_pages_per_dork || 3, 5);
  const prequalEnabled = config.prequalify !== false;

  const allUrls = new Map<string, string>(); // url -> location
  let prequalPending = new Set<string>();
  const pendingLocations = new Map<string, string>();

  let queriesUsed = 0;

  for (let qIdx = 0; qIdx < queries.length; qIdx++) {
    const qObj = queries[qIdx];
    
    if (allUrls.size + prequalPending.size >= maxTarget) break;

    let queryDryPages = 0;
    for (let page = 1; page <= maxPages; page++) {
      if (allUrls.size + prequalPending.size >= maxTarget) break;

      const results = await serperSearch(qObj.query, apiKeys, page);
      queriesUsed++;

      if (results.length === 0) break;

      let newThisPage = 0;
      let dupesThisPage = 0;

      for (const item of results) {
        const link = item.link || '';
        const norm = normaliseLinkedinUrl(link);
        if (!norm) continue;

        const { isRelevant, confidence } = isResultRelevant(item, nicheSignals, qObj.location);
        
        if (isRelevant) {
          if (!allUrls.has(norm) && !prequalPending.has(norm)) {
            if (prequalEnabled) {
              prequalPending.add(norm);
              pendingLocations.set(norm, qObj.location);
            } else {
              allUrls.set(norm, qObj.location);
            }
            newThisPage++;
          } else {
            dupesThisPage++;
          }
        }
      }

      if (newThisPage === 0) {
        queryDryPages++;
        if (queryDryPages >= 1) break;
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
      
      // Parallel layer 2 verification
      const verifyResults = await Promise.all(
        batch.map(url => prequalifyViaGoogle(url, apiKeys, nicheSignals))
      );
      
      for (const res of verifyResults) {
        if (res.passed) {
          allUrls.set(res.url, pendingLocations.get(res.url) || 'Unknown');
        }
      }
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
        allUrls.set(res.url, pendingLocations.get(res.url) || 'Unknown');
      }
    }
  }

  return Array.from(allUrls.entries())
    .map(([url, location]) => ({ url, location }))
    .slice(0, maxTarget);
}
