"use server";

import { cleanUrl, extractEmails, validateEmail } from "@/lib/utils";
import { validateEnv } from "@/lib/env";
import https from 'https';
import fs from 'fs';
import path from 'path';

// Validate environment on first server action call
let envValidated = false;
function ensureEnv() {
    if (!envValidated) {
        validateEnv();
        envValidated = true;
    }
}

const BRIGHT_DATA_API_KEY = process.env.BRIGHT_DATA_API_KEY;
const BD_DATASET_ACTIVITY = process.env.BD_DATASET_ACTIVITY || 'gd_l190586f_profiles_recent_activity';
const BD_DATASET_PROFILES = process.env.BD_DATASET_PROFILES || 'gd_l190586f_profiles';
const BD_DATASET_WEB_SCRAPER = process.env.BD_DATASET_WEB_SCRAPER || 'gd_l190586f_web_scraper';
const LINKEDIN_LI_AT = process.env.LINKEDIN_LI_AT;

// Helper: Check if a URL belongs to LinkedIn or its infrastructure
function isLinkedInDomain(url: string): boolean {
    const lower = url.toLowerCase();
    return lower.includes('linkedin.com') || lower.includes('licdn.com') ||
        lower.includes('licdn.net') || lower.includes('linkedin.cn');
}

// Random delay helper (mimics human browsing)
function randomDelay(minMs: number, maxMs: number): Promise<void> {
    const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    console.log(`⏳ Waiting ${(ms / 1000).toFixed(1)}s before next request...`);
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Centralized HTML entity decoder — eliminates duplication across extraction functions
function decodeHtmlEntities(html: string): string {
    return html
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&#x27;/g, "'")
        .replace(/&#x2F;/g, '/')
        .replace(/&nbsp;/g, ' ');
}

export type Lead = {
    url: string;
    status: 'PENDING' | 'SCANNING' | 'QUALIFIED' | 'REJECTED' | 'ACTIVITY_FAILED';
    firstName?: string;
    activityStatus?: string;
    timedOut?: boolean;
    website?: string;
    websites: string[];
    emails: string[];
    logs: string[];
};

export async function processLeads(urls: string[], limit: number) {
    ensureEnv();
    const processedUrls = urls.slice(0, limit);
    const results: Lead[] = [];

    for (const url of processedUrls) {
        const lead = await processSingleLead(url);
        results.push(lead);
    }

    return results;
}

// ── Progress Save/Load for crash recovery ──
const PROGRESS_DIR = path.join(process.cwd(), 'progress');

export async function saveProgress(leads: Lead[], processedCount: number, totalCount: number): Promise<string> {
    try {
        if (!fs.existsSync(PROGRESS_DIR)) fs.mkdirSync(PROGRESS_DIR, { recursive: true });
        const data = {
            savedAt: new Date().toISOString(),
            processedCount,
            totalCount,
            leads
        };

        // Always update the latest file
        const latestPath = path.join(PROGRESS_DIR, 'progress_latest.json');
        fs.writeFileSync(latestPath, JSON.stringify(data, null, 2));

        // Also save a timestamped copy (one per run, overwritten each save during same run)
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const stampedPath = path.join(PROGRESS_DIR, `results_${timestamp}.json`);
        fs.writeFileSync(stampedPath, JSON.stringify(data, null, 2));

        console.log(`💾 Progress saved: ${processedCount}/${totalCount} leads → ${latestPath}`);
        return latestPath;
    } catch (err) {
        console.error('Failed to save progress:', err);
        return '';
    }
}

export async function loadProgress(): Promise<{ leads: Lead[], processedCount: number, totalCount: number } | null> {
    try {
        const filePath = path.join(PROGRESS_DIR, 'progress_latest.json');
        if (!fs.existsSync(filePath)) return null;
        const raw = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw);
        console.log(`📂 Loaded progress: ${data.processedCount}/${data.totalCount} leads from ${data.savedAt}`);
        return { leads: data.leads, processedCount: data.processedCount, totalCount: data.totalCount };
    } catch (err) {
        console.error('Failed to load progress:', err);
        return null;
    }
}

// ── Saved Runs Management ──

export type SavedRun = {
    filename: string;
    savedAt: string;
    processedCount: number;
    totalCount: number;
    qualifiedCount: number;
    emailsFound: number;
};

export async function listSavedRuns(): Promise<SavedRun[]> {
    try {
        if (!fs.existsSync(PROGRESS_DIR)) return [];
        const files = fs.readdirSync(PROGRESS_DIR)
            .filter(f => f.endsWith('.json') && f !== 'progress_latest.json')
            .sort().reverse();

        const runs: SavedRun[] = [];
        for (const filename of files.slice(0, 20)) {
            try {
                const raw = fs.readFileSync(path.join(PROGRESS_DIR, filename), 'utf-8');
                const data = JSON.parse(raw);
                runs.push({
                    filename,
                    savedAt: data.savedAt || '',
                    processedCount: data.processedCount || 0,
                    totalCount: data.totalCount || 0,
                    qualifiedCount: (data.leads || []).filter((l: Lead) => l.status === 'QUALIFIED').length,
                    emailsFound: (data.leads || []).reduce((acc: number, l: Lead) => acc + (l.emails?.length || 0), 0),
                });
            } catch { /* skip corrupt files */ }
        }
        return runs;
    } catch {
        return [];
    }
}

export async function loadSavedRun(filename: string): Promise<{ leads: Lead[], processedCount: number, totalCount: number } | null> {
    try {
        // Sanitize filename to prevent path traversal
        const safe = path.basename(filename);
        const filePath = path.join(PROGRESS_DIR, safe);
        if (!fs.existsSync(filePath)) return null;
        const raw = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw);
        return { leads: data.leads || [], processedCount: data.processedCount || 0, totalCount: data.totalCount || 0 };
    } catch {
        return null;
    }
}

export async function deleteSavedRun(filename: string): Promise<boolean> {
    try {
        const safe = path.basename(filename);
        // Don't allow deleting the latest progress file
        if (safe === 'progress_latest.json') return false;
        const filePath = path.join(PROGRESS_DIR, safe);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            return true;
        }
        return false;
    } catch {
        return false;
    }
}

export async function exportResultsCSV(leads: Lead[]): Promise<string> {
    const csvCell = (val: string) => `"${val.replace(/"/g, '""')}"`;
    const headers = ['LinkedIn URL', 'First Name', 'Status', 'Activity Status', 'Websites', 'Emails'];
    const rows = leads.map(l => [
        csvCell(l.url),
        csvCell(l.firstName || ''),
        csvCell(l.status),
        csvCell(l.activityStatus || ''),
        csvCell((l.websites || []).join('; ') || l.website || ''),
        csvCell(l.emails.join('; ')),
    ].join(','));

    return [headers.join(','), ...rows].join('\n');
}

export async function processSingleLead(url: string): Promise<Lead> {
    ensureEnv();
    let lead: Lead = {
        url,
        status: 'SCANNING',
        websites: [],
        emails: [],
        logs: [`Started validation for ${url}`]
    };

    // Phase 1: LinkedIn Activity Gate — single attempt, no retries
    let activityResolved = false;

    try {
        const { approved, timedOut, failed } = await gateLeadActivity(url);

        if (failed || timedOut) {
            console.log(`Phase 1: Activity check ${failed ? 'failed' : 'timed out'} for ${url}.`);
            lead.logs.push(`Phase 1: Activity check ${failed ? 'failed' : 'timed out'}.`);
        } else if (!approved) {
            lead.status = 'REJECTED';
            lead.activityStatus = 'Inactive';
            lead.logs.push('Phase 1: No activity in last 60 days. Skipped.');
            return lead;
        } else {
            lead.activityStatus = 'Active';
            lead.logs.push('Phase 1: Activity confirmed within 60 days.');
            activityResolved = true;
        }
    } catch (phase1Error) {
        console.error('Phase 1 Error:', phase1Error instanceof Error ? phase1Error.message : phase1Error);
        lead.logs.push(`Phase 1 Error: ${phase1Error instanceof Error ? phase1Error.message : 'Unknown'}`);
    }

    if (!activityResolved) {
        lead.status = 'ACTIVITY_FAILED';
        lead.activityStatus = 'Failed';
        lead.logs.push('Phase 1: Activity check failed — skipping.');
        return lead;
    }

    // Phase 2: Metadata & Email Extraction
    try {
        const extraction = await discoverLeadData(url);
        lead.website = extraction.website;
        lead.websites = extraction.websites;
        lead.emails = extraction.emails;
        lead.firstName = extraction.firstName;

        if (lead.emails.length > 0) {
            lead.logs.push(`Phase 2: Found ${lead.emails.length} email(s).`);
        } else {
            lead.logs.push('Phase 2: No emails found.');
        }
        if (lead.firstName) {
            lead.logs.push(`Phase 2: Extracted first name: ${lead.firstName}`);
        }
    } catch (phase2Error) {
        console.error('Phase 2 Error:', phase2Error instanceof Error ? phase2Error.message : phase2Error);
        lead.logs.push(`Phase 2 Error: ${phase2Error instanceof Error ? phase2Error.message : 'Unknown error'}`);
    }

    // All leads that pass Phase 1 (or have unknown activity) are QUALIFIED
    lead.status = 'QUALIFIED';
    return lead;
}

/**
 * Retry a previously-failed lead — skips Phase 1 (activity check) entirely
 * and goes straight to Phase 2 (contact discovery).
 * Used by the Retry Failed button for leads that exhausted their activity retries.
 */
export async function retrySingleLead(url: string): Promise<Lead> {
    ensureEnv();
    let lead: Lead = {
        url,
        status: 'SCANNING',
        websites: [],
        emails: [],
        logs: [`[RETRY] Skipping activity check, going straight to contact discovery for ${url}`],
        activityStatus: 'Skipped (retry)',
    };

    // Go straight to Phase 2: Metadata & Email Extraction
    try {
        const extraction = await discoverLeadData(url);
        lead.website = extraction.website;
        lead.websites = extraction.websites;
        lead.emails = extraction.emails;
        lead.firstName = extraction.firstName;

        if (lead.emails.length > 0) {
            lead.logs.push(`Phase 2: Found ${lead.emails.length} email(s).`);
        } else {
            lead.logs.push('Phase 2: No emails found.');
        }
        if (lead.firstName) {
            lead.logs.push(`Phase 2: Extracted first name: ${lead.firstName}`);
        }
    } catch (phase2Error) {
        console.error('[RETRY] Phase 2 Error:', phase2Error instanceof Error ? phase2Error.message : phase2Error);
        lead.logs.push(`Phase 2 Error: ${phase2Error instanceof Error ? phase2Error.message : 'Unknown error'}`);
    }

    lead.status = 'QUALIFIED';
    return lead;
}

async function gateLeadActivity(linkedinUrl: string): Promise<{ approved: boolean, profileData?: any, timedOut: boolean, failed?: boolean }> {
    let activityUrl = linkedinUrl.replace(/\/$/, '');
    const urlMatch = activityUrl.match(/linkedin\.com\/in\/([^\/]+)/);
    if (urlMatch && urlMatch[1]) {
        activityUrl = `https://www.linkedin.com/in/${urlMatch[1]}`;
    }

    try {
        console.log(`Phase 1: Checking activity for ${activityUrl}...`);

        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - 90);

        // Timeout the entire activity check after 120 seconds
        const MAX_RETRIES = 2;

        const activityPromise = (async () => {
            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                try {
                    if (attempt > 1) {
                        console.log(`Phase 1: Retry attempt ${attempt}/${MAX_RETRIES} after 5s delay...`);
                        await new Promise(r => setTimeout(r, 5000));
                    }

                    const response = await fetch(`https://api.brightdata.com/datasets/v3/scrape?dataset_id=${BD_DATASET_ACTIVITY}&notify=false&include_errors=true&type=discover_new&discover_by=profile_url`, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${BRIGHT_DATA_API_KEY}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            input: [{
                                url: activityUrl,
                                start_date: startDate.toISOString(),
                                end_date: endDate.toISOString()
                            }]
                        }),
                    });

                    if (!response.ok) {
                        const errBody = await response.text().catch(() => '');
                        console.error(`Phase 1: API returned ${response.status}: ${errBody.substring(0, 200)}`);
                        // Retry on transient errors (5xx, 429)
                        if (attempt < MAX_RETRIES && (response.status >= 500 || response.status === 429)) {
                            continue;
                        }
                        // Final attempt or non-retryable error — signal failure
                        return { approved: false, profileData: null, timedOut: false, failed: true };
                    }

                    const textResponse = await response.text();
                    let result: any[] = [];

                    try {
                        const json = JSON.parse(textResponse);
                        if (Array.isArray(json)) {
                            result = json;
                        } else if (json.snapshot_id) {
                            console.log(`Phase 1: Polling snapshot ${json.snapshot_id}...`);
                            const polled = await pollBrightData(json.snapshot_id, 20);
                            result = Array.isArray(polled) ? polled : [];
                        } else if (json.id) {
                            console.log(`Phase 1: Polling snapshot ${json.id}...`);
                            const polled = await pollBrightData(json.id, 20);
                            result = Array.isArray(polled) ? polled : [];
                        } else if (json.error_code || json.error) {
                            // ── API returned an error object (NOT a real activity item) ──
                            // e.g. { error_code: "dead_page", error: "No posts found for the selected period..." }
                            console.log(`Phase 1: API returned error: [${json.error_code || 'unknown'}] ${(json.error || '').substring(0, 200)}`);

                            if (json.error_code === 'dead_page') {
                                // "dead_page" = API explicitly says NO recent activity → INACTIVE
                                console.log('Phase 1: dead_page → lead is INACTIVE.');
                                return { approved: false, profileData: null, timedOut: false };
                            }
                            // Other error codes → treat as failure to retry
                            return { approved: false, profileData: null, timedOut: false, failed: true };
                        } else {
                            result = [json];
                        }
                    } catch (e) {
                        // NDJSON fallback
                        const lines = textResponse.split('\n').filter(line => line.trim() !== '');
                        for (const line of lines) {
                            try { result.push(JSON.parse(line)); } catch (pe) { }
                        }
                    }

                    console.log(`Phase 1: Got ${result.length} activity item(s).`);

                    // ── DEBUG: Print full data for every activity item ──
                    for (let idx = 0; idx < result.length; idx++) {
                        const item = result[idx];
                        const keys = Object.keys(item);
                        console.log(`Phase 1 [DEBUG] Item ${idx + 1}/${result.length} keys: [${keys.join(', ')}]`);
                        // Print ALL date-like fields
                        for (const key of keys) {
                            const val = item[key];
                            if (typeof val === 'string' && (key.toLowerCase().includes('date') || key.toLowerCase().includes('time') || key.toLowerCase().includes('posted') || key.toLowerCase().includes('created') || key.toLowerCase().includes('published') || key.toLowerCase().includes('updated'))) {
                                console.log(`Phase 1 [DEBUG]   DATE FIELD: ${key} = "${val}"`);
                            }
                        }
                        // Print a compact summary of the item (first 500 chars of JSON)
                        const itemJson = JSON.stringify(item);
                        console.log(`Phase 1 [DEBUG]   Full data (${itemJson.length} chars): ${itemJson.substring(0, 500)}${itemJson.length > 500 ? '...' : ''}`);
                    }

                    if (result.length > 0) {
                        // First, filter out any error items that might be in the array
                        const errorItems = result.filter(item => item.error_code || item.error || item.__error);
                        const validItems = result.filter(item => !item.error_code && !item.error && !item.__error);

                        if (errorItems.length > 0) {
                            console.log(`Phase 1: ${errorItems.length} error item(s) in results.`);
                            for (const ei of errorItems) {
                                console.log(`Phase 1: Error in array: [${ei.error_code || 'unknown'}] ${(ei.error || '').substring(0, 200)}`);
                                if (ei.error_code === 'dead_page') {
                                    console.log('Phase 1: dead_page in array → lead is INACTIVE.');
                                    return { approved: false, profileData: null, timedOut: false };
                                }
                            }
                        }

                        // Look for date fields — NOTE: "timestamp" is EXCLUDED because
                        // it refers to the API request time (always today), NOT a post date.
                        const posts = validItems.filter(item =>
                            item.date_posted || item.date ||
                            item.created_at || item.published_at || item.posted_date ||
                            item.activity_date || item.time
                        );
                        console.log(`Phase 1: ${posts.length} valid item(s) have recognized date fields (out of ${validItems.length} valid items).`);

                        if (posts.length > 0) {
                            const getDateValue = (item: any) =>
                                item.date_posted || item.date ||
                                item.created_at || item.published_at || item.posted_date ||
                                item.activity_date || item.time || '1970-01-01';

                            const latestPost = posts.sort((a: any, b: any) =>
                                new Date(getDateValue(b)).getTime() - new Date(getDateValue(a)).getTime()
                            )[0];
                            const latestDateStr = getDateValue(latestPost);
                            const lastActivityDate = new Date(latestDateStr);
                            const sixtyDaysAgo = new Date();
                            sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);

                            const isActive = lastActivityDate > sixtyDaysAgo;
                            console.log(`Phase 1: Latest activity date: "${latestDateStr}" → parsed as ${lastActivityDate.toISOString()} — ${isActive ? 'ACTIVE ✓' : 'INACTIVE ✗'} (cutoff: ${sixtyDaysAgo.toISOString()})`);

                            return { approved: isActive, profileData: null, timedOut: false };
                        }
                    }

                    // No posts found or no date fields → can't confirm activity → FAIL (don't auto-approve)
                    console.log('Phase 1: No datable posts found — treating as FAILED (not auto-approving).');
                    return { approved: false, profileData: null, timedOut: false, failed: true };
                } catch (innerError) {
                    console.error(`Phase 1: Activity attempt ${attempt} error:`, innerError instanceof Error ? innerError.message : innerError);
                    if (attempt >= MAX_RETRIES) {
                        return { approved: false, profileData: null, timedOut: false, failed: true };
                    }
                }
            }
            // Should never reach here, but just in case
            return { approved: false, profileData: null, timedOut: false, failed: true };
        })();

        const timeoutPromise = new Promise<{ approved: boolean, profileData: any, timedOut: boolean, failed?: boolean }>((resolve) =>
            setTimeout(() => {
                // IMPORTANT: Do NOT auto-approve timed-out leads.
                // Signal both timedOut and failed so the retry loop treats this properly.
                resolve({ approved: false, profileData: null, timedOut: true, failed: true });
            }, 120000)
        );

        const result = await Promise.race([activityPromise, timeoutPromise]);

        if (result.timedOut) {
            console.warn('Phase 1: Activity check timed out after 120s — NOT auto-approving.');
        }

        return result;

    } catch (error) {
        console.error("Phase 1 Error:", error instanceof Error ? error.message : error);
        return { approved: false, profileData: null, timedOut: false, failed: true };
    }
}

// ────────────────────────────────────────────────────────
// Phase 2: Contact Info Extraction via Voyager API only
// ────────────────────────────────────────────────────────
async function discoverLeadData(linkedinUrl: string, cachedProfile?: any): Promise<{ website?: string, websites: string[], emails: string[], firstName?: string }> {
    try {
        let emails: string[] = [];
        let websites: string[] = [];
        let firstName: string | undefined;

        // Normalize URL & extract profile slug
        let profileUrl = linkedinUrl.replace(/\/$/, '');
        const urlMatch = profileUrl.match(/linkedin\.com\/in\/([^\/]+)/);
        const profileSlug = urlMatch?.[1];
        if (profileSlug) {
            profileUrl = `https://www.linkedin.com/in/${profileSlug}`;
        }

        // ── LinkedIn Contact Info Extraction ──
        if (LINKEDIN_LI_AT && profileSlug) {
            console.log(`Phase 2: Extracting contact info for "${profileSlug}"...`);
            const contactResult = await fetchProfileContactInfo(profileSlug);

            if (contactResult) {
                websites = contactResult.websites;
                // Validate all emails from contact overlay (Friction 7: JSON emails were unvalidated)
                const validatedContactEmails = contactResult.emails
                    .filter(validateEmail)
                    .filter(e => !isPlaceholderEmail(e));
                if (validatedContactEmails.length > 0) emails.push(...validatedContactEmails);
                if (contactResult.firstName) firstName = contactResult.firstName;
                console.log(`Phase 2: firstName=${firstName || '?'}, websites=[${websites.join(', ')}], emails=[${validatedContactEmails.join(', ')}]`);
            } else {
                console.log('Phase 2: Contact extraction returned no results.');
            }
        } else if (!LINKEDIN_LI_AT) {
            console.error('Phase 2: LINKEDIN_LI_AT not set!');
        }

        // ── Fallback: Extract first name from URL slug ──
        if (!firstName && profileSlug) {
            const cleanSlug = profileSlug.replace(/-?\d+$/, ''); // strip trailing digits

            if (cleanSlug.includes('-')) {
                // Hyphenated slug (e.g., 'leah-gervais' → 'Leah')
                const slugName = cleanSlug.split('-')[0];
                if (slugName && slugName.length >= 2 && slugName.length <= 15) {
                    firstName = slugName.charAt(0).toUpperCase() + slugName.slice(1).toLowerCase();
                    console.log(`Phase 2: First name from hyphenated slug: ${firstName}`);
                }
            } else {
                // Unhyphenated slug: try camelCase split (e.g., 'LeahGervais' → 'Leah')
                const camelMatch = cleanSlug.match(/^([A-Z][a-z]+)([A-Z][a-z]+)/);
                if (camelMatch && camelMatch[1].length >= 2 && camelMatch[1].length <= 15) {
                    firstName = camelMatch[1];
                    console.log(`Phase 2: First name from camelCase slug: ${firstName}`);
                }
            }
        }

        // ── Deep Web Crawl on the best personal website ──
        let primaryWebsite = websites.length > 0 ? cleanUrl(websites[0]) : undefined;
        // Ensure URL has protocol for fetch to work
        if (primaryWebsite && !primaryWebsite.startsWith('http://') && !primaryWebsite.startsWith('https://')) {
            primaryWebsite = 'https://' + primaryWebsite;
        }
        if (primaryWebsite) {
            try {
                // Timeout deep web crawl after 30 seconds to prevent hanging
                const deepWebPromise = discoverDeepWeb(primaryWebsite);
                const timeoutPromise = new Promise<{ emails: string[] }>((_, reject) =>
                    setTimeout(() => reject(new Error('Deep web crawl timed out after 30s')), 30000)
                );
                const deepWeb = await Promise.race([deepWebPromise, timeoutPromise]);
                emails = [...new Set([...emails, ...deepWeb.emails])];
            } catch (err) {
                console.warn(`Phase 2: Deep web crawl failed: ${err instanceof Error ? err.message : err}`);
            }
        }

        // Filter out any LinkedIn domains from websites array (final safety net)
        websites = websites.filter(w => !isLinkedInDomain(w));

        // Final deduplication and validation pass on all emails
        const finalEmails = [...new Set(emails)].filter(validateEmail).filter(e => !isPlaceholderEmail(e));
        return { website: websites[0], websites, emails: finalEmails, firstName };
    } catch (error) {
        console.error("Phase 2 Error:", error);
        return { websites: [], emails: [] };
    }
}

// ────────────────────────────────────────────────────────
// Fetch contact info by loading the authenticated contact overlay.
// Step 1: GET the profile page to establish session cookies
// Step 2: GET /in/{slug}/overlay/contact-info/ — the contact overlay page
// The overlay HTML is parsed for redirect URLs, embedded JSON, and emails.
// ────────────────────────────────────────────────────────
async function fetchProfileContactInfo(profileSlug: string): Promise<{ websites: string[], emails: string[], firstName?: string } | null> {
    const MAX_RETRIES = 3;

    const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
    ];
    const ua = userAgents[Math.floor(Math.random() * userAgents.length)];

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            // Exponential backoff
            const baseDelay = attempt === 1 ? 3000 : (attempt * 8000);
            const jitter = Math.random() * 5000;
            const delay = baseDelay + jitter;
            console.log(`Phase 2: [Attempt ${attempt}/${MAX_RETRIES}] Waiting ${(delay / 1000).toFixed(1)}s before LinkedIn request...`);
            await new Promise(r => setTimeout(r, delay));

            // ── STEP 1: Visit profile page for session cookies ──
            console.log(`Phase 2: Getting session cookies for "${profileSlug}"...`);

            const session = await new Promise<{ cookies: string[], status: number, html: string }>((resolve, reject) => {
                const req = https.request({
                    hostname: 'www.linkedin.com',
                    port: 443,
                    path: `/in/${profileSlug}`,
                    method: 'GET',
                    headers: {
                        'cookie': `li_at=${LINKEDIN_LI_AT}`,
                        'user-agent': ua,
                        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                        'accept-language': 'en-US,en;q=0.9',
                    }
                }, (res) => {
                    let html = '';
                    res.on('data', (chunk) => { html += chunk; });
                    res.on('end', () => resolve({
                        cookies: res.headers['set-cookie'] || [],
                        status: res.statusCode || 0,
                        html
                    }));
                });
                req.on('error', reject);
                req.setTimeout(15000, () => { req.destroy(new Error('timeout')); });
                req.end();
            });

            console.log(`Phase 2: Session status: ${session.status}, cookies: ${session.cookies.length}`);

            if (session.status === 429 || session.status === 999) {
                console.warn(`Phase 2: LinkedIn rate limit (${session.status}). Retrying...`);
                continue;
            }

            if (session.status >= 400) {
                console.error(`Phase 2: Profile page returned ${session.status}`);
                if (attempt < MAX_RETRIES) continue;
                return null;
            }

            const allCookies = session.cookies.map(c => c.split(';')[0]);
            const cookieString = [`li_at=${LINKEDIN_LI_AT}`, ...allCookies].join('; ');

            await randomDelay(2000, 4000);

            // ── STEP 2: Fetch the contact overlay page ──
            console.log(`Phase 2: Fetching contact overlay for "${profileSlug}"...`);

            const overlayHtml = await new Promise<string>((resolve, reject) => {
                const req = https.request({
                    hostname: 'www.linkedin.com',
                    port: 443,
                    path: `/in/${profileSlug}/overlay/contact-info/`,
                    method: 'GET',
                    headers: {
                        'cookie': cookieString,
                        'user-agent': ua,
                        'accept': 'text/html,application/xhtml+xml',
                        'accept-encoding': 'identity',
                        'referer': `https://www.linkedin.com/in/${profileSlug}`,
                    }
                }, (res) => {
                    let data = '';
                    res.on('data', (chunk) => data += chunk);
                    res.on('end', () => {
                        console.log(`Phase 2: Overlay status: ${res.statusCode}, size: ${data.length} bytes`);
                        resolve(data);
                    });
                });
                req.on('error', reject);
                req.setTimeout(15000, () => { req.destroy(new Error('timeout')); });
                req.end();
            });

            if (overlayHtml.length > 5000) {
                const contactData = parseOverlayHtml(overlayHtml);
                // Extract first name using multiple strategies
                // IMPORTANT: LinkedIn embeds the VIEWER's profile data in <code> JSON blocks too.
                // JSON patterns like "firstName":"..." find the VIEWER's name first (e.g., "Aymen").
                // Therefore, we prioritize <title>, og:title, and <h1> which ALWAYS show the
                // viewed profile's name, not the viewer's. JSON is the LAST resort.
                let firstName: string | undefined;

                // Helper to validate a name candidate
                const isValidName = (name: string) => {
                    const lower = name.toLowerCase();
                    return name.length >= 2 && name.length <= 30
                        && !['linkedin', 'null', 'undefined', 'contact', 'profile', 'info',
                            'member', 'user', 'page', 'home', 'welcome', 'sign', 'log',
                            'about', 'blog', 'the', 'and', 'view', 'see'].includes(lower)
                        && /^[A-Za-z\u00C0-\u024F]/.test(name) // starts with a letter
                        && !/^\d/.test(name); // doesn't start with a digit
                };

                // Helper to strip parentheticals like (He/Him), (She/Her) from name strings
                const stripParenthetical = (text: string) => text.replace(/\s*\([^)]*\)\s*/g, ' ').trim();

                // ── Try 1 (MOST RELIABLE): <title> tag from profile page ──
                // Always shows the viewed profile's name, e.g. "Dave Labowitz | LinkedIn"
                {
                    const titleMatch = session.html.match(/<title[^>]*>([^<]+)/i);
                    if (titleMatch) {
                        const rawName = titleMatch[1].trim().split(/\s*[|–—\-]\s*/)[0].trim();
                        const namePart = stripParenthetical(rawName);
                        const parts = namePart.split(/\s+/);
                        if (parts.length > 0 && isValidName(parts[0])) {
                            firstName = parts[0];
                            console.log(`Phase 2: Extracted first name from <title>: ${firstName}`);
                        }
                    }
                }

                // ── Try 2: og:title meta tag ──
                if (!firstName) {
                    const ogTitleMatch = session.html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i)
                        || session.html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
                    if (ogTitleMatch) {
                        const rawName = ogTitleMatch[1].trim().split(/\s*[-–—|,]\s*/)[0].trim();
                        const namePart = stripParenthetical(rawName);
                        const parts = namePart.split(/\s+/);
                        if (parts.length > 0 && isValidName(parts[0])) {
                            firstName = parts[0];
                            console.log(`Phase 2: Extracted first name from og:title: ${firstName}`);
                        }
                    }
                }

                // ── Try 3: <h1> tag from profile page ──
                if (!firstName) {
                    const h1Match = session.html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
                    if (h1Match) {
                        const rawName = stripParenthetical(h1Match[1].trim());
                        const parts = rawName.split(/\s+/);
                        if (parts.length > 0 && isValidName(parts[0])) {
                            firstName = parts[0];
                            console.log(`Phase 2: Extracted first name from <h1> tag: ${firstName}`);
                        }
                    }
                }

                // ── Try 4 (LAST RESORT): JSON patterns in <code> blocks ──
                // WARNING: These may match the VIEWER's name. Only use if title/h1 failed.
                if (!firstName) {
                    const decodedOverlay = decodeHtmlEntities(overlayHtml);
                    const decodedSession = decodeHtmlEntities(session.html);
                    const namePatterns = [
                        /"firstName"\s*:\s*"([^"]{2,30})"/,
                        /"first_name"\s*:\s*"([^"]{2,30})"/,
                        /"member_name"\s*:\s*"([^"]{2,30})"/,
                    ];

                    // Try to find the name in code blocks that ALSO contain the profile slug
                    // This ensures we're reading the profile's data, not the viewer's
                    const codeRegex = /<code[^>]*>([\s\S]*?)<\/code>/gi;
                    let codeMatch;
                    while (!firstName && (codeMatch = codeRegex.exec(decodedOverlay)) !== null) {
                        const block = decodeHtmlEntities(codeMatch[1]);
                        // Only consider code blocks that reference the profile being viewed
                        if (!block.includes(profileSlug) && !block.includes('contactInfo')) continue;
                        for (const pattern of namePatterns) {
                            const m = block.match(pattern);
                            if (m && isValidName(m[1].trim())) {
                                firstName = m[1].trim();
                                console.log(`Phase 2: Extracted first name from profile-specific code block: ${firstName}`);
                                break;
                            }
                        }
                    }
                }

                if (firstName) {
                    console.log(`Phase 2: Final first name: ${firstName}`);
                } else {
                    console.log(`Phase 2: Could not extract first name from HTML.`);
                }

                return { ...contactData, firstName };
            }

            console.log('Phase 2: Overlay response too small, likely throttled.');
            if (attempt < MAX_RETRIES) continue;
            return null;

        } catch (err) {
            console.error(`Phase 2: Attempt ${attempt} failed: ${err instanceof Error ? err.message : err}`);
            if (attempt >= MAX_RETRIES) return null;
        }
    }

    return null;
}

// ── Parse the overlay HTML for contact data ──
function parseOverlayHtml(overlayHtml: string): { websites: string[], emails: string[] } {
    let websites: string[] = [];
    let emails: string[] = [];

    // Social media / non-personal domains to skip
    const skipDomains = ['linkedin.com', 'licdn.com', 'facebook.com', 'twitter.com', 'x.com',
        'instagram.com', 'youtube.com', 'tiktok.com', 'github.com',
        'medium.com', 'substack.com', 'calendly.com', 'linktr.ee'];

    // ── Method 1: Extract website URLs via redirect pattern ──
    type LabeledWebsite = { url: string, label: string };
    const labeledWebsites: LabeledWebsite[] = [];

    const redirectRegex = /redir\/redirect\/\?url=([^&"\\]+)/g;
    let match;
    while ((match = redirectRegex.exec(overlayHtml)) !== null) {
        try {
            let decodedUrl = decodeURIComponent(match[1]);
            if (!decodedUrl.startsWith('http://') && !decodedUrl.startsWith('https://')) {
                decodedUrl = 'https://' + decodedUrl;
            }
            const isSkipped = skipDomains.some(d => decodedUrl.includes(d));
            if (isSkipped || websites.includes(decodedUrl)) continue;

            const searchEnd = Math.min(overlayHtml.length, match.index + 2000);
            const context = overlayHtml.substring(match.index, searchEnd);
            let label = 'Other';
            const labelMatch = context.match(/\(Personal\)|\(Company\)|\(Blog\)|\(Portfolio\)|\(Other\)/i);
            if (labelMatch) {
                label = labelMatch[0].replace(/[()]/g, '');
            }

            websites.push(decodedUrl);
            labeledWebsites.push({ url: decodedUrl, label });
            console.log(`Phase 2: [Redirect] Found website: ${decodedUrl} (${label})`);
        } catch (e) { /* malformed URL */ }
    }

    // Sort: Personal first, then Blog/Portfolio, then Company/Other last
    if (labeledWebsites.length > 0) {
        const labelPriority: Record<string, number> = {
            'Personal': 0, 'Blog': 1, 'Portfolio': 2, 'Other': 3, 'Company': 4
        };
        labeledWebsites.sort((a, b) =>
            (labelPriority[a.label] ?? 3) - (labelPriority[b.label] ?? 3)
        );
        websites = labeledWebsites.map(w => w.url);
        console.log(`Phase 2: Prioritized website: ${labeledWebsites[0].url} (${labeledWebsites[0].label})`);
    }

    // ── Method 2: Fallback to embedded JSON extraction if no redirect URLs found ──
    if (websites.length === 0) {
        console.log('Phase 2: No redirect URLs found — trying embedded JSON extraction...');
        const jsonResult = extractFromEmbeddedJSON(overlayHtml);
        if (jsonResult.website) {
            const isSkipped = skipDomains.some(d => jsonResult.website!.includes(d));
            if (!isSkipped) {
                websites.push(jsonResult.website);
                console.log(`Phase 2: [JSON] Found website: ${jsonResult.website}`);
            }
        }
        if (jsonResult.emails.length > 0) {
            emails.push(...jsonResult.emails);
            console.log(`Phase 2: [JSON] Found ${jsonResult.emails.length} email(s): ${jsonResult.emails.join(', ')}`);
        }
    }

    // ── Method 3: Fallback — scan for raw URLs in the HTML ──
    if (websites.length === 0) {
        console.log('Phase 2: JSON extraction found nothing — scanning for raw URLs...');
        // Regex captures full multi-level domains (e.g., static.licdn.com, not just static.licdn)
        const urlRegex = /https?:\/\/(?:www\.)?([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,6})(?:\/[^\s"'<>)\]]*)?/g;
        const seenDomains = new Set<string>();
        let urlMatch;
        while ((urlMatch = urlRegex.exec(overlayHtml)) !== null) {
            const fullUrl = urlMatch[0];
            const domain = urlMatch[1].toLowerCase();
            // Skip LinkedIn infrastructure and common non-personal domains
            const isSkipped = skipDomains.some(d => domain.includes(d)) ||
                domain.includes('licdn') || domain.includes('linkedin') ||
                domain.includes('microsoft') || domain.includes('bing.com') ||
                domain.includes('google') || domain.includes('cloudfront') ||
                domain.includes('amazonaws') || domain.includes('sentry') ||
                domain.includes('w3.org') || domain.includes('schema.org') ||
                domain.includes('cloudflare') || domain.includes('fastly') ||
                domain.includes('akamai') || domain.includes('cdn.') ||
                domain.endsWith('.js') || domain.endsWith('.css') ||
                domain.endsWith('.png') || domain.endsWith('.jpg') ||
                domain.endsWith('.svg') || domain.endsWith('.woff2');
            if (!isSkipped && !seenDomains.has(domain)) {
                seenDomains.add(domain);
                const cleanedUrl = fullUrl.split('"')[0].split("'")[0];
                websites.push(cleanedUrl);
                console.log(`Phase 2: [RawURL] Found: ${domain} → ${cleanedUrl}`);
                if (websites.length >= 3) break;
            }
        }
    }

    // ── Extract mailto: links directly from overlay HTML (Friction 8) ──
    const mailtoRegex = /mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/gi;
    let mailtoMatch;
    while ((mailtoMatch = mailtoRegex.exec(overlayHtml)) !== null) {
        const found = mailtoMatch[1].toLowerCase();
        if (validateEmail(found) && !isPlaceholderEmail(found) && !emails.includes(found)) {
            emails.push(found);
            console.log(`Phase 2: [Mailto] Found email: ${found}`);
        }
    }

    // Extract emails from the overlay HTML text (use stricter validation)
    const cleanText = stripHtmlToText(overlayHtml);
    const foundEmails = extractEmails(cleanText).filter(validateEmail).filter(e => !isPlaceholderEmail(e));
    const allEmails = [...new Set([...emails, ...foundEmails])];

    if (allEmails.length > 0) {
        console.log(`Phase 2: Found ${allEmails.length} email(s): ${allEmails.join(', ')}`);
    }

    console.log(`Phase 2: Final results — websites: [${websites.join(', ')}], emails: [${allEmails.join(', ')}]`);
    return { websites, emails: allEmails };
}

// ────────────────────────────────────────────────
// Helper: Extract contact data from LinkedIn's embedded JSON
// LinkedIn embeds profile data inside <code> tags as JSON.
// We parse every <code> block and recursively search for
// contact-related keys like emailAddress, websites, phoneNumbers, firstName.
// ────────────────────────────────────────────────
function extractFromEmbeddedJSON(html: string): { website?: string, emails: string[] } {
    let website: string | undefined;
    let emails: string[] = [];

    // Extract all <code> tag contents
    const codeRegex = /<code[^>]*>([\s\S]*?)<\/code>/gi;
    let match: RegExpExecArray | null;

    while ((match = codeRegex.exec(html)) !== null) {
        const raw = match[1];
        // Skip tiny fragments
        if (raw.length < 50) continue;

        try {
            // Use centralized HTML entity decoder
            const decoded = decodeHtmlEntities(raw);

            const json = JSON.parse(decoded);
            searchJSON(json, (key: string, value: any) => {
                // Email (validate before collecting)
                if ((key === 'emailAddress' || key === 'email') && typeof value === 'string' && value.includes('@')) {
                    const email = value.toLowerCase();
                    if (validateEmail(email) && !isPlaceholderEmail(email)) {
                        emails.push(email);
                    }
                }
                // NOTE: firstName is NOT extracted here because LinkedIn embeds the VIEWER's
                // profile data in <code> blocks too, and it would always return the viewer's name.
                // firstName extraction is handled in fetchProfileContactInfo via <title>/<h1> tags.

                // Website from contactInfo or websites array
                if (key === 'websites' && Array.isArray(value)) {
                    for (const w of value) {
                        const url = w?.url || w?.link || (typeof w === 'string' ? w : null);
                        if (url && !url.includes('linkedin.com')) {
                            website = website || url;
                        }
                    }
                }
                if (key === 'website' && typeof value === 'string' && !value.includes('linkedin.com')) {
                    website = website || value;
                }
                if (key === 'companyUrl' && typeof value === 'string' && !value.includes('linkedin.com')) {
                    website = website || value;
                }
            });
        } catch (e) {
            // Not valid JSON, skip
        }
    }

    return { website, emails: [...new Set(emails)] };
}

// Recursively walk a JSON object and call callback for every key-value pair
function searchJSON(obj: any, callback: (key: string, value: any) => void, depth = 0) {
    if (depth > 15 || !obj || typeof obj !== 'object') return;
    for (const key of Object.keys(obj)) {
        callback(key, obj[key]);
        if (typeof obj[key] === 'object') {
            searchJSON(obj[key], callback, depth + 1);
        }
    }
}

// ────────────────────────────────────────────────
// Helper: Broad regex extraction from raw HTML
// Scans for email patterns and external website hrefs
// ────────────────────────────────────────────────
function extractFromHTML(html: string): { website?: string, emails: string[] } {
    let website: string | undefined;
    const emails: string[] = [];

    // Find all mailto: links
    const mailtoRegex = /mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/gi;
    let m: RegExpExecArray | null;
    while ((m = mailtoRegex.exec(html)) !== null) {
        emails.push(m[1].toLowerCase());
    }

    // Broader email regex on decoded text
    const decoded = html.replace(/&amp;/g, '&').replace(/&quot;/g, '"');
    const emailRegex = /([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/g;
    while ((m = emailRegex.exec(decoded)) !== null) {
        const addr = m[1].toLowerCase();
        // Skip LinkedIn's own domains
        if (!addr.includes('linkedin.com') && !addr.includes('licdn.com')) {
            emails.push(addr);
        }
    }

    // Find external website links (filter out socials)
    const socialDomains = ['linkedin.com', 'facebook.com', 'twitter.com', 'x.com', 'instagram.com', 'youtube.com', 'tiktok.com', 'github.com', 'licdn.com'];
    const hrefRegex = /href="(https?:\/\/[^"]+)"/gi;
    while ((m = hrefRegex.exec(html)) !== null) {
        const url = m[1];
        const isSocial = socialDomains.some(d => url.includes(d));
        if (!isSocial && !url.includes('javascript:') && !url.includes('brightdata.com')) {
            website = website || url;
        }
    }

    // Also check for pv-contact-info sections (in case they DO appear)
    const websiteMatch = html.match(/pv-contact-info[^>]*website[\s\S]*?href="([^"]+)"/i);
    if (websiteMatch && !isLinkedInDomain(websiteMatch[1])) website = websiteMatch[1];

    const emailSection = html.match(/pv-contact-info[^>]*email[\s\S]*?mailto:([^"]+)"/i);
    if (emailSection) emails.push(emailSection[1].toLowerCase());

    return { website, emails: [...new Set(emails)] };
}

// Decodes emails obfuscated by Cloudflare's Email Address Protection feature.
// Example: `/cdn-cgi/l/email-protection#a8ccc9decde8ccc9decdc4c9cac7dfc1dcd286cbc7c5`
function decodeCloudflareEmail(encodedString: string): string {
    try {
        let email = "";
        const key = parseInt(encodedString.substring(0, 2), 16);
        for (let i = 2; i < encodedString.length; i += 2) {
            let charCode = parseInt(encodedString.substring(i, i + 2), 16) ^ key;
            email += String.fromCharCode(charCode);
        }
        return email;
    } catch {
        return "";
    }
}

async function discoverDeepWeb(website: string): Promise<{ emails: string[] }> {
    try {
        // Extract the domain from the website URL
        const websiteDomain = website.replace(/^https?:\/\/(www\.)?/, '').split('/')[0].toLowerCase();
        const baseUrl = website.replace(/\/$/, '');
        let allCleanText = '';
        let allRawHtml = '';
        const crawledUrls = new Set<string>();

        // ── Step 1: Fetch homepage and discover internal links ──
        console.log(`Phase 2 Deep Web: Crawling ${baseUrl} for links...`);
        let homepageHtml = '';
        try {
            homepageHtml = await fetchPage(baseUrl, 10000);
        } catch (e) {
            console.log('Phase 2 Deep Web: Homepage fetch failed.');
            return { emails: [] };
        }

        if (!homepageHtml || homepageHtml.length < 100) {
            console.log('Phase 2 Deep Web: Homepage returned empty/minimal content.');
            return { emails: [] };
        }

        crawledUrls.add(baseUrl);
        allCleanText += ' ' + stripHtmlToText(homepageHtml);
        allRawHtml += homepageHtml;

        // ── Step 2: Discover internal links from homepage ──
        const discoveredLinks = discoverInternalLinks(homepageHtml, baseUrl, websiteDomain);
        console.log(`Phase 2 Deep Web: Discovered ${discoveredLinks.length} internal link(s): ${discoveredLinks.slice(0, 5).join(', ')}${discoveredLinks.length > 5 ? '...' : ''}`);

        // ── Step 3: Crawl discovered links (max 8 pages, 8s timeout each) ──
        const pagesToCrawl = discoveredLinks.filter(url => !crawledUrls.has(url)).slice(0, 8);
        for (const pageUrl of pagesToCrawl) {
            try {
                crawledUrls.add(pageUrl);
                const pageHtml = await fetchPage(pageUrl, 8000);
                if (pageHtml && pageHtml.length > 100) {
                    allCleanText += ' ' + stripHtmlToText(pageHtml);
                    allRawHtml += pageHtml;
                }
            } catch (e) {
                // Skip failed pages
            }
        }

        console.log(`Phase 2 Deep Web: Crawled ${crawledUrls.size} pages total.`);

        // ── Step 4: Extract emails from all crawled content ──
        if (allCleanText.length > 0) {
            // Method A: Extract from stripped text
            const textEmails = extractEmails(allCleanText).filter(validateEmail);

            // Method B: Extract mailto: links from raw HTML of all pages
            const mailtoEmails: string[] = [];
            const mailtoRegex = /mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/gi;
            let mailtoMatch;
            while ((mailtoMatch = mailtoRegex.exec(allRawHtml)) !== null) {
                mailtoEmails.push(mailtoMatch[1].toLowerCase());
            }

            // Method C: Extract emails directly from raw HTML (href values, data attributes, etc.)
            const rawHtmlEmails = extractEmails(allRawHtml).filter(validateEmail);

            // Method D: Detect obfuscated emails (e.g., 'name [at] domain [dot] com')
            const obfuscatedEmails: string[] = [];
            const obfuscatedRegex = /([a-zA-Z0-9._%+-]+)\s*(?:\[at\]|\(at\)|\{at\}|\bat\b)\s*([a-zA-Z0-9.-]+)\s*(?:\[dot\]|\(dot\)|\{dot\}|\bdot\b)\s*([a-zA-Z]{2,6})/gi;
            let obMatch;
            while ((obMatch = obfuscatedRegex.exec(allCleanText)) !== null) {
                const email = `${obMatch[1]}@${obMatch[2]}.${obMatch[3]}`.toLowerCase();
                if (validateEmail(email)) obfuscatedEmails.push(email);
            }

            // Method E: Decode Cloudflare obfuscated emails
            const cloudflareEmails: string[] = [];
            const cgiRegex = /\/cdn-cgi\/l\/email-protection#([a-f0-9]+)/gi;
            let cgiMatch;
            while ((cgiMatch = cgiRegex.exec(allRawHtml)) !== null) {
                const dec = decodeCloudflareEmail(cgiMatch[1]);
                if (dec) cloudflareEmails.push(dec.toLowerCase());
            }
            const dataRegex = /data-cfemail="([a-f0-9]+)"/gi;
            let dataMatch;
            while ((dataMatch = dataRegex.exec(allRawHtml)) !== null) {
                const dec = decodeCloudflareEmail(dataMatch[1]);
                if (dec) cloudflareEmails.push(dec.toLowerCase());
            }

            const combinedEmails = [...new Set([...textEmails, ...mailtoEmails, ...rawHtmlEmails, ...obfuscatedEmails, ...cloudflareEmails])]
                .filter(validateEmail)
                .filter(email => !isPlaceholderEmail(email));

            if (combinedEmails.length > 0) {
                console.log(`Phase 2 Deep Web: Found ${combinedEmails.length} email(s): ${combinedEmails.join(', ')}`);
            } else {
                console.log('Phase 2 Deep Web: No emails found on any page.');
            }
            return { emails: combinedEmails };
        }

        console.log('Phase 2 Deep Web: No content extracted from any page.');
        return { emails: [] };
    } catch (error) {
        console.error("Deep Web Discovery Error:", error instanceof Error ? error.message : error);
        return { emails: [] };
    }
}

// ── Discover internal links from a page's HTML ──
function discoverInternalLinks(html: string, baseUrl: string, domain: string): string[] {
    const links: string[] = [];
    const seen = new Set<string>();

    // Match href attributes
    const hrefRegex = /href=["']([^"'#]+)["']/gi;
    let match;
    while ((match = hrefRegex.exec(html)) !== null) {
        let href = match[1].trim();

        // Skip non-page links
        if (href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) continue;
        // Skip protocol-relative URLs (usually CDN/external resources like //img1.wsimg.com)
        if (href.startsWith('//')) continue;
        // Skip data URIs
        if (href.startsWith('data:')) continue;
        // Skip file extensions that are not HTML pages
        if (href.match(/\.(pdf|jpg|jpeg|png|gif|svg|css|js|ico|woff|woff2|ttf|mp4|mp3|zip|doc|docx|webp|avif|bmp|eot|otf)$/i)) continue;
        // Skip URLs that look like image/asset paths
        if (href.match(/\/(?:img|image|asset|static|cdn|media|wp-content\/uploads)\//i)) continue;

        // Resolve relative URLs
        if (href.startsWith('/')) {
            href = baseUrl + href;
        } else if (!href.startsWith('http')) {
            href = baseUrl + '/' + href;
        }

        // Only keep internal links (same domain)
        try {
            const linkDomain = href.replace(/^https?:\/\/(www\.)?/, '').split('/')[0].toLowerCase();
            if (linkDomain !== domain && linkDomain !== 'www.' + domain) continue;
        } catch { continue; }

        // Normalize and dedupe
        href = href.replace(/\/$/, '').split('?')[0].split('#')[0];
        if (!seen.has(href) && href !== baseUrl) {
            seen.add(href);
            links.push(href);
        }
    }

    // Prioritize likely contact/about pages first
    const priorityKeywords = ['contact', 'about', 'team', 'people', 'staff', 'connect', 'reach', 'get-in-touch', 'enquir', 'privacy', 'legal', 'faq', 'support', 'help', 'info', 'footer'];
    links.sort((a, b) => {
        const aLower = a.toLowerCase();
        const bLower = b.toLowerCase();
        const aPriority = priorityKeywords.some(k => aLower.includes(k)) ? 0 : 1;
        const bPriority = priorityKeywords.some(k => bLower.includes(k)) ? 0 : 1;
        return aPriority - bPriority;
    });

    return links;
}

// ── Strip HTML to plain visible text ──
// Removes scripts, styles, comments, and HTML tags to get only content
function stripHtmlToText(html: string): string {
    return html
        // Remove script blocks
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
        // Remove style blocks
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
        // Remove noscript blocks
        .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
        // Remove HTML comments
        .replace(/<!--[\s\S]*?-->/g, ' ')
        // Remove SVG blocks
        .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, ' ')
        // Convert common entities
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        // Replace tags with spaces (preserve word boundaries)
        .replace(/<[^>]+>/g, ' ')
        // Collapse whitespace
        .replace(/\s+/g, ' ')
        .trim();
}

// ── Check if an email is a placeholder/example (NOT a real address) ──
function isPlaceholderEmail(email: string): boolean {
    const e = email.toLowerCase();
    const [local, domain] = e.split('@');

    // Reject emails from known placeholder/example domains
    const fakeDomains = ['domain.com', 'example.com', 'test.com',
        'yourdomain.com', 'company.com', 'website.com', 'site.com',
        'sample.com', 'yourcompany.com', 'placeholder.com',
        'yoursite.com', 'youremail.com', 'email.example',
        'sentry.io', 'wixpress.com', 'w3.org',
        'godaddy.com', 'secureserver.net', 'wordpress.com', 'squarespace.com',
        'mailchimp.com', 'hubspot.com', 'constantcontact.com',
        // Infrastructure/platform domains (Friction 11)
        'sendgrid.net', 'mailgun.org', 'intercom.io', 'zendesk.com',
        'freshdesk.com', 'crisp.chat', 'drift.com', 'helpscout.net',
        'convertkit.com', 'klaviyo.com', 'activecampaign.com',
        'aweber.com', 'getresponse.com', 'drip.com',
        'mandrillapp.com', 'postmarkapp.com', 'sparkpost.com',
        'sendinblue.com', 'brevo.com', 'googlemail.com'];
    if (fakeDomains.includes(domain)) return true;

    // Reject literal placeholders that appear in code/templates
    const placeholderLocals = ['user', 'username', 'your-email', 'youremail',
        'your-name', 'yourname', 'name', 'email', 'test', 'demo',
        'example', 'foo', 'bar', 'someone', 'recipient'];
    if (placeholderLocals.includes(local)) return true;

    // Reject if local part is all digits (tracking/system emails)
    if (/^\d+$/.test(local)) return true;

    return false;
}

// ── Helper: Fetch a single page via direct HTTP(S) with timeout ──
function fetchPage(url: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : require('http');

        // Use an abort controller if we were using native fetch, but for http/https we need to track the req
        let isResolved = false;

        try {
            const req = protocol.request(url, {
                method: 'GET',
                // Set the socket timeout explicitly
                timeout: timeoutMs,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Cache-Control': 'max-age=0',
                    'Connection': 'keep-alive',
                    'Upgrade-Insecure-Requests': '1',
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'none',
                    'Sec-Fetch-User': '?1',
                    'sec-ch-ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
                    'sec-ch-ua-mobile': '?0',
                    'sec-ch-ua-platform': '"Windows"'
                }
            }, (res: any) => {
                // Follow redirects (301, 302, 303, 307, 308)
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    if (isResolved) return;
                    isResolved = true;
                    // Handle relative redirects
                    const nextUrl = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, url).href;
                    fetchPage(nextUrl, timeoutMs).then(resolve).catch(reject);
                    return;
                }

                let data = '';
                res.on('data', (chunk: any) => data += chunk);
                res.on('end', () => {
                    if (!isResolved) {
                        isResolved = true;
                        resolve(data);
                    }
                });
            });

            // Handle request-level socket timeouts
            req.on('timeout', () => {
                if (!isResolved) {
                    isResolved = true;
                    req.destroy(); // Forcefully kill the socket!
                    reject(new Error('timeout'));
                }
            });

            req.on('error', (err: any) => {
                if (!isResolved) {
                    isResolved = true;
                    reject(err);
                }
            });

            req.end();

            // Failsafe overarching timer just in case the socket timeout fails
            setTimeout(() => {
                if (!isResolved) {
                    isResolved = true;
                    req.destroy();
                    reject(new Error('timeout'));
                }
            }, timeoutMs + 1000);

        } catch (e) {
            if (!isResolved) {
                isResolved = true;
                reject(e);
            }
        }
    });
}

async function pollBrightData(snapshotId: string, maxAttempts: number = 60): Promise<any> {
    let attempts = 0;
    while (attempts < maxAttempts) {
        try {
            const res = await fetch(`https://api.brightdata.com/datasets/v3/snapshot/${snapshotId}?format=json`, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${BRIGHT_DATA_API_KEY}` }
            });

            if (res.status === 200) {
                const data = await res.json();
                if (Array.isArray(data)) return data;
                if (data && (data.status === 'running' || data.status === 'pending')) {
                    // still running
                } else if (data && data.status === 'ready' && data.data) {
                    return data.data;
                } else {
                    return data;
                }
            }
            await new Promise(r => setTimeout(r, 5000));
            attempts++;
        } catch (e) {
            await new Promise(r => setTimeout(r, 5000));
            attempts++;
        }
    }
    return null;
}
