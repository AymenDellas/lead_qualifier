"use server";

import { cleanUrl, extractEmails, validateEmail, verifyEmailDomain, guessEmails, CONTACT_PAGE_PATHS, LINK_PRIORITY_KEYWORDS } from "@/lib/utils";
import https from 'https';
import fs from 'fs';
import path from 'path';

// ── Types ──

export type Lead = {
    url: string;
    status: 'PENDING' | 'SCANNING' | 'QUALIFIED' | 'REJECTED' | 'ACTIVITY_FAILED' | 'ACTIVE_NO_CONTACT' | 'ERROR';
    firstName?: string;
    headline?: string;
    activityStatus?: string;
    timedOut?: boolean;
    website?: string;
    websites: string[];
    emails: string[];
    logs: string[];
};

export type SavedRun = {
    filename: string;
    savedAt: string;
    processedCount: number;
    totalCount: number;
    qualifiedCount: number;
    emailsFound: number;
};

// ── Progress Save/Load for crash recovery ──
const PROGRESS_DIR = path.join(process.cwd(), 'progress');

export async function saveProgress(leads: Lead[], processedCount: number, totalCount: number): Promise<string> {
    try {
        if (!fs.existsSync(PROGRESS_DIR)) fs.mkdirSync(PROGRESS_DIR, { recursive: true });
        const data = { savedAt: new Date().toISOString(), processedCount, totalCount, leads };

        const latestPath = path.join(PROGRESS_DIR, 'progress_latest.json');
        fs.writeFileSync(latestPath, JSON.stringify(data, null, 2));

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
        if (safe === 'progress_latest.json') return false;
        const filePath = path.join(PROGRESS_DIR, safe);
        if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); return true; }
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

// ────────────────────────────────────────────────────────
// Standalone Website Email Extraction (Email Hunter tab)
// No LinkedIn authentication needed.
// ────────────────────────────────────────────────────────
export type WebsiteScrapeResult = {
    website: string;
    emails: string[];
    status: 'SUCCESS' | 'NO_EMAILS' | 'ERROR';
    error?: string;
};

export async function scrapeWebsiteEmails(websiteUrl: string): Promise<WebsiteScrapeResult> {
    try {
        let url = websiteUrl.trim();
        if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'https://' + url;
        url = url.replace(/\/$/, '');

        console.log(`[Website Scraper] Starting deep crawl: ${url}`);

        const deepWebPromise = discoverDeepWeb(url);
        const timeoutPromise = new Promise<{ emails: string[] }>((_, reject) =>
            setTimeout(() => reject(new Error('Deep web crawl timed out after 60s')), 60000)
        );
        const result = await Promise.race([deepWebPromise, timeoutPromise]);

        if (result.emails.length > 0) {
            console.log(`[Website Scraper] Found ${result.emails.length} email(s) on ${url}`);
            return { website: url, emails: result.emails, status: 'SUCCESS' };
        } else {
            console.log(`[Website Scraper] No emails found on ${url}`);
            return { website: url, emails: [], status: 'NO_EMAILS' };
        }
    } catch (error) {
        console.error(`[Website Scraper] Error for ${websiteUrl}:`, error);
        return {
            website: websiteUrl, emails: [], status: 'ERROR',
            error: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}

// ── Deep Web Crawl Engine ──

function decodeCloudflareEmail(encodedString: string): string {
    try {
        let email = "";
        const key = parseInt(encodedString.substring(0, 2), 16);
        for (let i = 2; i < encodedString.length; i += 2) {
            email += String.fromCharCode(parseInt(encodedString.substring(i, i + 2), 16) ^ key);
        }
        return email;
    } catch { return ""; }
}

async function discoverDeepWeb(website: string, firstName?: string): Promise<{ emails: string[] }> {
    try {
        const websiteDomain = website.replace(/^https?:\/\/(www\.)?/, '').split('/')[0].toLowerCase();
        const baseUrl = website.replace(/\/$/, '');
        let allCleanText = '';
        let allRawHtml = '';
        const crawledUrls = new Set<string>();

        // Step 1: Fetch homepage
        console.log(`Phase 2 Deep Web: Crawling ${baseUrl} for links...`);
        let homepageHtml = '';
        try { homepageHtml = await fetchPageWithFallback(baseUrl, 10000); }
        catch { console.log('Phase 2 Deep Web: Homepage fetch failed.'); return { emails: [] }; }

        if (!homepageHtml || homepageHtml.length < 100) {
            console.log('Phase 2 Deep Web: Homepage returned empty/minimal content.');
            return { emails: [] };
        }

        crawledUrls.add(baseUrl);
        allCleanText += ' ' + stripHtmlToText(homepageHtml);
        allRawHtml += homepageHtml;

        // Step 2: Contact page URL guesses
        const contactGuesses: string[] = [];
        for (const p of CONTACT_PAGE_PATHS) {
            const guessUrl = baseUrl + p;
            if (!crawledUrls.has(guessUrl)) contactGuesses.push(guessUrl);
        }

        // Step 3: Discover internal links
        const discoveredLinks = discoverInternalLinks(homepageHtml, baseUrl, websiteDomain);
        console.log(`Phase 2 Deep Web: Discovered ${discoveredLinks.length} internal link(s)`);

        // Step 4: Merge & dedupe
        const allLinks: string[] = [];
        const seen = new Set<string>(crawledUrls);
        for (const url of contactGuesses) {
            const norm = url.replace(/\/$/, '').split('?')[0].split('#')[0];
            if (!seen.has(norm)) { seen.add(norm); allLinks.push(norm); }
        }
        for (const url of discoveredLinks) {
            const norm = url.replace(/\/$/, '').split('?')[0].split('#')[0];
            if (!seen.has(norm)) { seen.add(norm); allLinks.push(norm); }
        }

        // Step 5: Crawl pages (max 15)
        const pagesToCrawl = allLinks.slice(0, 15);
        console.log(`Phase 2 Deep Web: Will crawl up to ${pagesToCrawl.length} pages...`);
        for (const pageUrl of pagesToCrawl) {
            try {
                crawledUrls.add(pageUrl);
                const pageHtml = await fetchPage(pageUrl, 8000);
                if (pageHtml && pageHtml.length > 100) {
                    allCleanText += ' ' + stripHtmlToText(pageHtml);
                    allRawHtml += pageHtml;
                }
            } catch { /* skip failed pages */ }
        }

        console.log(`Phase 2 Deep Web: Crawled ${crawledUrls.size} pages total.`);

        // Step 6: Extract emails from all content
        const emails = new Set<string>();

        if (allCleanText.length > 0) {
            for (const e of extractEmails(allCleanText).filter(validateEmail)) emails.add(e);

            const mailtoRegex = /mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/gi;
            let mailtoMatch;
            while ((mailtoMatch = mailtoRegex.exec(allRawHtml)) !== null) emails.add(mailtoMatch[1].toLowerCase());

            for (const e of extractEmails(allRawHtml).filter(validateEmail)) emails.add(e);

            const obfuscatedRegex = /([a-zA-Z0-9._%+-]+)\s*(?:\[at\]|\(at\)|\{at\}|\bat\b)\s*([a-zA-Z0-9.-]+)\s*(?:\[dot\]|\(dot\)|\{dot\}|\bdot\b)\s*([a-zA-Z]{2,6})/gi;
            let obMatch;
            while ((obMatch = obfuscatedRegex.exec(allCleanText)) !== null) {
                const email = `${obMatch[1]}@${obMatch[2]}.${obMatch[3]}`.toLowerCase();
                if (validateEmail(email)) emails.add(email);
            }

            const cgiRegex = /\/cdn-cgi\/l\/email-protection#([a-f0-9]+)/gi;
            let cgiMatch;
            while ((cgiMatch = cgiRegex.exec(allRawHtml)) !== null) {
                const dec = decodeCloudflareEmail(cgiMatch[1]);
                if (dec) emails.add(dec.toLowerCase());
            }
            const dataRegex = /data-cfemail="([a-f0-9]+)"/gi;
            let dataMatch;
            while ((dataMatch = dataRegex.exec(allRawHtml)) !== null) {
                const dec = decodeCloudflareEmail(dataMatch[1]);
                if (dec) emails.add(dec.toLowerCase());
            }

            const ldJsonEmails = extractFromLdJson(allRawHtml);
            for (const e of ldJsonEmails) emails.add(e);
        }

        // Step 7: Filter & optionally guess
        const filteredEmails = [...emails].filter(validateEmail).filter(e => !isPlaceholderEmail(e));

        if (filteredEmails.length === 0 && firstName && websiteDomain) {
            console.log(`Phase 2 Deep Web: No emails found — trying email guessing for ${firstName}@${websiteDomain}...`);
            const guesses = guessEmails(firstName, websiteDomain);
            for (const guess of guesses) {
                if (validateEmail(guess) && !isPlaceholderEmail(guess)) {
                    const hasMx = await verifyEmailDomain(guess);
                    if (hasMx) {
                        console.log(`Phase 2 Deep Web: [Guess] MX-verified: ${guess}`);
                        filteredEmails.push(guess);
                        break;
                    }
                }
            }
        }

        if (filteredEmails.length > 0) {
            console.log(`Phase 2 Deep Web: Found ${filteredEmails.length} email(s): ${filteredEmails.join(', ')}`);
        } else {
            console.log('Phase 2 Deep Web: No emails found on any page.');
        }
        return { emails: filteredEmails };

    } catch (error) {
        console.error("Deep Web Discovery Error:", error instanceof Error ? error.message : error);
        return { emails: [] };
    }
}

// ── Discover internal links from a page's HTML ──
function discoverInternalLinks(html: string, baseUrl: string, domain: string): string[] {
    const links: string[] = [];
    const seen = new Set<string>();
    const hrefRegex = /href=["']([^"'#]+)["']/gi;
    let match;
    while ((match = hrefRegex.exec(html)) !== null) {
        let href = match[1].trim();
        if (href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) continue;
        if (href.startsWith('//') || href.startsWith('data:')) continue;
        if (href.match(/\.(pdf|jpg|jpeg|png|gif|svg|css|js|ico|woff|woff2|ttf|mp4|mp3|zip|doc|docx|webp|avif|bmp|eot|otf)$/i)) continue;
        if (href.match(/\/(?:img|image|asset|static|cdn|media|wp-content\/uploads)\//i)) continue;

        if (href.startsWith('/')) href = baseUrl + href;
        else if (!href.startsWith('http')) href = baseUrl + '/' + href;

        try {
            const linkDomain = href.replace(/^https?:\/\/(www\.)?/, '').split('/')[0].toLowerCase();
            if (linkDomain !== domain && linkDomain !== 'www.' + domain) continue;
        } catch { continue; }

        href = href.replace(/\/$/, '').split('?')[0].split('#')[0];
        if (!seen.has(href) && href !== baseUrl) { seen.add(href); links.push(href); }
    }

    links.sort((a, b) => {
        const aPriority = LINK_PRIORITY_KEYWORDS.some(k => a.toLowerCase().includes(k)) ? 0 : 1;
        const bPriority = LINK_PRIORITY_KEYWORDS.some(k => b.toLowerCase().includes(k)) ? 0 : 1;
        return aPriority - bPriority;
    });
    return links;
}

// ── Strip HTML to plain text ──
function stripHtmlToText(html: string): string {
    return html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, ' ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ').trim();
}

// ── Placeholder email check ──
function isPlaceholderEmail(email: string): boolean {
    const e = email.toLowerCase();
    const [local, domain] = e.split('@');
    const fakeDomains = ['domain.com', 'example.com', 'test.com', 'yourdomain.com', 'company.com',
        'website.com', 'site.com', 'sample.com', 'yourcompany.com', 'placeholder.com',
        'yoursite.com', 'youremail.com', 'email.example', 'sentry.io', 'wixpress.com',
        'w3.org', 'godaddy.com', 'secureserver.net', 'wordpress.com', 'squarespace.com',
        'mailchimp.com', 'hubspot.com', 'constantcontact.com', 'sendgrid.net', 'mailgun.org',
        'intercom.io', 'zendesk.com', 'freshdesk.com', 'crisp.chat', 'drift.com',
        'helpscout.net', 'convertkit.com', 'klaviyo.com', 'activecampaign.com',
        'aweber.com', 'getresponse.com', 'drip.com', 'mandrillapp.com', 'postmarkapp.com',
        'sparkpost.com', 'sendinblue.com', 'brevo.com', 'googlemail.com'];
    if (fakeDomains.includes(domain)) return true;
    const placeholderLocals = ['user', 'username', 'your-email', 'youremail', 'your-name',
        'yourname', 'name', 'email', 'test', 'demo', 'example', 'foo', 'bar', 'someone', 'recipient'];
    if (placeholderLocals.includes(local)) return true;
    if (/^\d+$/.test(local)) return true;
    return false;
}

// ── JSON-LD extraction ──
function extractFromLdJson(html: string): string[] {
    const emails: string[] = [];
    const ldJsonRegex = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = ldJsonRegex.exec(html)) !== null) {
        try {
            const json = JSON.parse(match[1].trim());
            const walk = (obj: any, depth: number = 0) => {
                if (depth > 10 || !obj || typeof obj !== 'object') return;
                for (const key of Object.keys(obj)) {
                    const val = obj[key];
                    if ((key === 'email' || key === 'contactPoint' || key === 'author') && typeof val === 'string' && val.includes('@')) {
                        const clean = val.replace(/^mailto:/i, '').toLowerCase().trim();
                        if (validateEmail(clean) && !isPlaceholderEmail(clean)) emails.push(clean);
                    }
                    if (typeof val === 'object') walk(val, depth + 1);
                }
            };
            walk(json);
        } catch { /* not valid JSON-LD */ }
    }
    return [...new Set(emails)];
}

// ── Fetch with protocol/www fallback ──
async function fetchPageWithFallback(url: string, timeoutMs: number): Promise<string> {
    try {
        const result = await fetchPage(url, timeoutMs);
        if (result && result.length > 100) return result;
    } catch { /* fall through */ }

    const hasWww = url.includes('://www.');
    const altUrl = hasWww ? url.replace('://www.', '://') : url.replace('://', '://www.');
    try {
        const result = await fetchPage(altUrl, timeoutMs);
        if (result && result.length > 100) return result;
    } catch { /* fall through */ }

    if (url.startsWith('https://')) {
        try {
            const result = await fetchPage(url.replace('https://', 'http://'), timeoutMs);
            if (result && result.length > 100) return result;
        } catch { /* fall through */ }
    }
    throw new Error(`All fetch attempts failed for ${url}`);
}

// ── HTTP(S) page fetcher ──
function fetchPage(url: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : require('http');
        let isResolved = false;
        try {
            const req = protocol.request(url, {
                method: 'GET', timeout: timeoutMs,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                }
            }, (res: any) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    if (isResolved) return;
                    isResolved = true;
                    const nextUrl = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, url).href;
                    fetchPage(nextUrl, timeoutMs).then(resolve).catch(reject);
                    return;
                }
                let data = '';
                res.on('data', (chunk: any) => data += chunk);
                res.on('end', () => { if (!isResolved) { isResolved = true; resolve(data); } });
            });
            req.on('timeout', () => { if (!isResolved) { isResolved = true; req.destroy(); reject(new Error('timeout')); } });
            req.on('error', (err: any) => { if (!isResolved) { isResolved = true; reject(err); } });
            req.end();
            setTimeout(() => { if (!isResolved) { isResolved = true; req.destroy(); reject(new Error('timeout')); } }, timeoutMs + 1000);
        } catch (e) { if (!isResolved) { isResolved = true; reject(e); } }
    });
}
