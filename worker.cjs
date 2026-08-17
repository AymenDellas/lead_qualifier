/**
 * Persistent LinkedIn Worker
 * 
 * ONE browser. ONE tab. Processes jobs from a queue directory.
 * Never spawns new Chrome instances. Never crashes from zombie processes.
 * 
 * Usage:
 *   node worker.cjs          → Fresh start (clears stale queue jobs)
 *   node worker.cjs --resume → Resumes processing any leftover queue jobs
 */

const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

puppeteerExtra.use(StealthPlugin());

// ── Config ──
const ACTIVITY_DAYS_THRESHOLD = 60;
const BROWSER_PROFILES_DIR = path.join(__dirname, '.browser-profiles');
const QUEUE_DIR = path.join(__dirname, 'queue');
const RESULTS_DIR = path.join(__dirname, 'queue-results');
const POLL_INTERVAL_MS = 2000;
const RESULT_TTL_DAYS = 7; // Auto-purge results older than this

// ── CLI Flags ──
const RESUME_MODE = process.argv.includes('--resume');

// ── Ensure dirs exist ──
if (!fs.existsSync(QUEUE_DIR)) fs.mkdirSync(QUEUE_DIR, { recursive: true });
if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const LIMITS_FILE = path.join(DATA_DIR, 'worker-limits.json');

// ── Load env ──
function loadEnv() {
    const envPath = path.join(__dirname, '.env.local');
    if (!fs.existsSync(envPath)) throw new Error('.env.local not found');
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
        const clean = line.replace(/\r/g, '');
        const match = clean.match(/^([^#=]+)=(.+)$/);
        if (match) process.env[match[1].trim()] = match[2].trim();
    }
}

function getAccounts() {
    const raw = process.env.LINKEDIN_ACCOUNTS;
    if (!raw) throw new Error('LINKEDIN_ACCOUNTS not set in .env.local');
    return JSON.parse(raw);
}

// ── Utilities ──
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(msg) { console.log(`[Worker] ${new Date().toLocaleTimeString()} — ${msg}`); }

function isRecentActivity(dateStr) {
    if (!dateStr) return false;
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return false;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - ACTIVITY_DAYS_THRESHOLD);
    return d > cutoff;
}

// ── Email Priority Scoring ──
function prioritizeEmails(emails, firstName, websiteDomain) {
    if (!emails || emails.length <= 1) return emails;
    const fn = (firstName || '').toLowerCase();
    const wd = (websiteDomain || '').toLowerCase();
    const scored = emails.map(email => {
        const [local, domain] = email.split('@');
        let priority = 50;
        // BEST: firstName@theirdomain.com
        if (wd && domain === wd && fn && local.toLowerCase().includes(fn)) priority = 10;
        // GREAT: hello/hi@theirdomain.com
        else if (wd && domain === wd && ['hello','hi','hey'].includes(local)) priority = 20;
        // GOOD: personal-looking email on their domain
        else if (wd && domain === wd && !['info','support','admin','billing','help','sales','team','office','noreply','no-reply'].includes(local)) priority = 25;
        // OK: info/contact on their domain
        else if (wd && domain === wd && ['info','contact'].includes(local)) priority = 35;
        // DECENT: personal Gmail/Yahoo
        else if (['gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com','protonmail.com'].includes(domain)) priority = 40;
        // MEH: support/admin
        else if (['support','admin','billing','help','sales','team','office'].includes(local)) priority = 80;
        return { email, priority };
    });
    scored.sort((a, b) => a.priority - b.priority);
    return scored.map(s => s.email);
}

// ── Startup: Handle stale queue ──
function handleStaleQueue() {
    const files = fs.readdirSync(QUEUE_DIR).filter(f => f.endsWith('.json'));
    if (files.length === 0) return;

    // Always resume in production. We do not want to wipe pending jobs on container restarts.
    log(`📂 Found ${files.length} pending job(s) in queue on startup. Resuming processing.`);
}

// ── Startup: Purge old result files ──
function purgeOldResults() {
    const cutoff = Date.now() - (RESULT_TTL_DAYS * 24 * 60 * 60 * 1000);
    const files = fs.readdirSync(RESULTS_DIR).filter(f => f.endsWith('.json') && f !== 'worker-status.json');
    let purged = 0;
    for (const f of files) {
        try {
            const stat = fs.statSync(path.join(RESULTS_DIR, f));
            if (stat.mtimeMs < cutoff) {
                fs.unlinkSync(path.join(RESULTS_DIR, f));
                purged++;
            }
        } catch { /* ignore */ }
    }
    if (purged > 0) log(`🗑️  Purged ${purged} result file(s) older than ${RESULT_TTL_DAYS} days`);
}

// ── Write worker status ──
function writeStatus(status, extra = {}) {
    try {
        fs.writeFileSync(
            path.join(RESULTS_DIR, 'worker-status.json'),
            JSON.stringify({ status, ...extra, updatedAt: new Date().toISOString() })
        );
    } catch { /* non-fatal */ }
}

// ── HTTP fetch utility (used by website scraper + fallback chain) ──
const https = require('https');
const http = require('http');
const fetchPage = (url, timeout = 10000, redirectCount = 0) => {
    return new Promise((resolve, reject) => {
        if (redirectCount >= 5) return reject(new Error('Too many redirects'));

        let req;
        const hardTimeout = setTimeout(() => {
            if (req) req.destroy();
            reject(new Error('Hard Timeout'));
        }, timeout + 5000);

        const done = (err, res) => {
            clearTimeout(hardTimeout);
            if (err) reject(err);
            else resolve(res);
        };

        const lib = url.startsWith('https') ? https : http;
        req = lib.get(url, {
            timeout,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                let redirect = res.headers.location;
                if (redirect.startsWith('/')) redirect = new URL(redirect, url).href;
                fetchPage(redirect, timeout, redirectCount + 1).then(data => done(null, data)).catch(done);
                return;
            }
            let data = '';
            res.on('data', chunk => {
                data += chunk;
                if (data.length > 5 * 1024 * 1024) {
                    req.destroy();
                    done(new Error('Response too large'));
                }
            });
            res.on('end', () => done(null, data));
            res.on('error', done);
        });
        req.on('error', done);
        req.on('timeout', () => { req.destroy(); done(new Error('Timeout')); });
    });
};

// ── Webhook callback to n8n ──
async function fireWebhook(webhookUrl, payload, maxRetries = 3) {
    const body = JSON.stringify(payload);
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const result = await new Promise((resolve, reject) => {
                const url = new URL(webhookUrl);
                const lib = url.protocol === 'https:' ? https : http;
                const req = lib.request({
                    hostname: url.hostname,
                    port: url.port || (url.protocol === 'https:' ? 443 : 80),
                    path: url.pathname + url.search,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(body),
                    },
                    timeout: 10000,
                }, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => resolve({ status: res.statusCode, data }));
                });
                req.on('error', reject);
                req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
                req.write(body);
                req.end();
            });
            if (result.status >= 200 && result.status < 300) {
                log(`  [Webhook] ✅ Delivered to n8n (attempt ${attempt})`);
                return true;
            }
            log(`  [Webhook] HTTP ${result.status} (attempt ${attempt}/${maxRetries})`);
        } catch (e) {
            log(`  [Webhook] Failed: ${e.message} (attempt ${attempt}/${maxRetries})`);
        }
        if (attempt < maxRetries) await sleep(1000 * Math.pow(2, attempt - 1));
    }
    log(`  [Webhook] ❌ All ${maxRetries} attempts failed — result saved to disk only`);
    return false;
}

// ── Website email scraping (Puppeteer-powered with HTTP fallback) ──

// Shared email extraction helpers (used by both Puppeteer and HTTP paths)
const emailExtractHelpers = {
    extractEmails: (text) => {
        const regex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
        const badTlds = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'bmp', 'ico',
            'css', 'js', 'json', 'xml', 'html', 'htm', 'php', 'asp', 'woff', 'woff2',
            'ttf', 'eot', 'otf', 'mp4', 'mp3', 'pdf', 'zip', 'doc', 'docx'];
        return [...new Set((text.match(regex) || []).map(e => e.toLowerCase()))]
            .filter(e => !badTlds.includes(e.split('.').pop()));
    },

    isPlaceholder: (email) => {
        const skip = ['example.com', 'test.com', 'email.com', 'domain.com', 'yoursite.com',
            'sentry.io', 'wixpress.com', 'squarespace.com', 'wordpress.com', 'w3.org',
            'schema.org', 'googleusercontent.com', 'gstatic.com', 'gravatar.com',
            'bootstrapcdn.com', 'jsdelivr.net', 'cloudflare.com', 'google.com',
            'facebook.com', 'twitter.com', 'github.com'];
        const emailDomain = email.split('@')[1] || '';
        return skip.some(d => emailDomain === d || emailDomain.endsWith('.' + d)) || email.startsWith('noreply') || email.startsWith('no-reply');
    },

    stripHtml: (html) => html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&[a-z]+;/gi, ' ')
        .replace(/\s+/g, ' '),

    decodeCfEmail: (encoded) => {
        try {
            const r = parseInt(encoded.substr(0, 2), 16);
            let email = '';
            for (let i = 2; i < encoded.length; i += 2) {
                email += String.fromCharCode(parseInt(encoded.substr(i, 2), 16) ^ r);
            }
            return email;
        } catch { return null; }
    },

    extractAllFromHtml: (html, text, emails) => {
        // mailto: links (including with query params like ?subject=...)
        const mailtoRegex = /mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})(?:\?|"|'| |&|;|$)/gi;
        let m;
        while ((m = mailtoRegex.exec(html)) !== null) emails.add(m[1].toLowerCase());

        // Plain text emails
        for (const e of emailExtractHelpers.extractEmails(text)) emails.add(e);
        for (const e of emailExtractHelpers.extractEmails(html)) emails.add(e);

        // Obfuscated: name [at] domain [dot] com
        const obfRegex = /([a-zA-Z0-9._%+-]+)\s*(?:\[at\]|\(at\)|\{at\}|\bat\b)\s*([a-zA-Z0-9.-]+)\s*(?:\[dot\]|\(dot\)|\{dot\}|\bdot\b)\s*([a-zA-Z]{2,6})/gi;
        while ((m = obfRegex.exec(text)) !== null) emails.add(`${m[1]}@${m[2]}.${m[3]}`.toLowerCase());

        // Cloudflare email protection
        const cfRegex = /\/cdn-cgi\/l\/email-protection#([a-f0-9]+)/gi;
        while ((m = cfRegex.exec(html)) !== null) { const dec = emailExtractHelpers.decodeCfEmail(m[1]); if (dec) emails.add(dec.toLowerCase()); }
        const dataRegex = /data-cfemail="([a-f0-9]+)"/gi;
        while ((m = dataRegex.exec(html)) !== null) { const dec = emailExtractHelpers.decodeCfEmail(m[1]); if (dec) emails.add(dec.toLowerCase()); }

        // Custom data attributes: data-email, data-contact, data-address, data-mail
        const dataEmailRegex = /data-(?:email|contact|address|mail)\s*=\s*["']([^"']+@[^"']+)["']/gi;
        while ((m = dataEmailRegex.exec(html)) !== null) emails.add(m[1].toLowerCase().replace(/^mailto:/i, ''));

        // onclick/href attributes with email content
        const onclickRegex = /(?:onclick|data-href)\s*=\s*["'][^"']*?([\w._%+-]+@[\w.-]+\.[\w]{2,})[^"']*?["']/gi;
        while ((m = onclickRegex.exec(html)) !== null) emails.add(m[1].toLowerCase());

        // JSON-LD structured data (Squarespace, Wix, WordPress)
        const ldJsonRegex = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
        let ldMatch;
        while ((ldMatch = ldJsonRegex.exec(html)) !== null) {
            try {
                const json = JSON.parse(ldMatch[1].trim());
                const walkJson = (obj, depth = 0) => {
                    if (depth > 10 || !obj || typeof obj !== 'object') return;
                    for (const [key, val] of Object.entries(obj)) {
                        if ((key === 'email' || key === 'contactPoint') && typeof val === 'string' && val.includes('@')) {
                            const clean = val.replace(/^mailto:/i, '').toLowerCase().trim();
                            if (!emailExtractHelpers.isPlaceholder(clean)) emails.add(clean);
                        }
                        if (typeof val === 'object') walkJson(val, depth + 1);
                    }
                };
                walkJson(json);
            } catch { /* invalid JSON-LD */ }
        }

        // HTML entity obfuscation decode (&#106;&#111;&#104;&#110;&#64;...)
        const entityRegex = /(&#\d{2,3};){5,}/g;
        const entityMatches = html.match(entityRegex) || [];
        for (const encoded of entityMatches) {
            const decoded = encoded.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)));
            for (const e of emailExtractHelpers.extractEmails(decoded)) { if (!emailExtractHelpers.isPlaceholder(e)) emails.add(e); }
        }

        // Meta tags with email content
        const metaRegex = /<meta[^>]*content\s*=\s*["']([^"']*@[^"']+)["'][^>]*>/gi;
        while ((m = metaRegex.exec(html)) !== null) {
            for (const e of emailExtractHelpers.extractEmails(m[1])) { if (!emailExtractHelpers.isPlaceholder(e)) emails.add(e); }
        }
    }
};

// Priority paths to check (expanded from original 7 to cover more patterns)
const CONTACT_PATHS = [
    '/contact', '/contact-us', '/about', '/about-me', '/about-us',
    '/get-in-touch', '/work-with-me', '/connect', '/reach-out',
    '/lets-talk', '/lets-connect', '/hire-me', '/booking',
    '/schedule', '/services', '/support', '/help',
    '/team', '/start', '/inquiry', '/enquiry'
];

// Priority keywords for internal link sorting
const LINK_PRIORITY = ['contact', 'about', 'team', 'connect', 'reach', 'get-in-touch', 
    'info', 'work-with', 'hire', 'booking', 'schedule', 'support', 'help', 'inquiry'];

// ── Puppeteer-based website scraper (renders JavaScript) ──
async function scrapeWebsiteWithBrowser(browserInstance, websiteUrl) {
    const baseUrl = websiteUrl.replace(/\/$/, '');
    const domain = baseUrl.replace(/^https?:\/\/(www\.)?/, '').split('/')[0].toLowerCase();
    const emails = new Set();
    const crawled = new Set();
    let context = null;

    try {
        // Create incognito context to avoid leaking LinkedIn cookies
        context = await browserInstance.createBrowserContext();
        const page = await context.newPage();
        
        // Set reasonable viewport and user agent
        await page.setViewport({ width: 1366, height: 768 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Block heavy resources to speed up loading
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const type = req.resourceType();
            if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
                req.abort();
            } else {
                req.continue();
            }
        });

        // Helper: navigate to a URL and extract HTML + text
        const scrapePage = async (url, timeout = 15000) => {
            try {
                await page.goto(url, { waitUntil: 'networkidle2', timeout });
                // Wait a bit more for lazy-loaded content
                await sleep(1500);
                
                const html = await page.content();
                const text = await page.evaluate(() => document.body ? document.body.innerText : '');
                
                // Also extract emails that Puppeteer can see in the rendered DOM
                const domEmails = await page.evaluate(() => {
                    const found = [];
                    // All mailto: links
                    document.querySelectorAll('a[href^="mailto:"]').forEach(a => {
                        const email = a.href.replace('mailto:', '').split('?')[0].trim().toLowerCase();
                        if (email && email.includes('@')) found.push(email);
                    });
                    // data-email and similar attributes
                    document.querySelectorAll('[data-email], [data-contact], [data-mail], [data-address]').forEach(el => {
                        const val = el.getAttribute('data-email') || el.getAttribute('data-contact') || 
                                    el.getAttribute('data-mail') || el.getAttribute('data-address') || '';
                        if (val.includes('@')) found.push(val.toLowerCase());
                    });
                    // Cloudflare email protection — decode in browser context
                    document.querySelectorAll('[data-cfemail]').forEach(el => {
                        try {
                            const enc = el.getAttribute('data-cfemail');
                            if (!enc) return;
                            const r = parseInt(enc.substr(0, 2), 16);
                            let decoded = '';
                            for (let i = 2; i < enc.length; i += 2) {
                                decoded += String.fromCharCode(parseInt(enc.substr(i, 2), 16) ^ r);
                            }
                            if (decoded.includes('@')) found.push(decoded.toLowerCase());
                        } catch {}
                    });
                    // Footer text specifically (high-value area for emails)
                    const footer = document.querySelector('footer');
                    if (footer) {
                        const footerText = footer.innerText || '';
                        const re = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
                        const matches = footerText.match(re) || [];
                        matches.forEach(m => found.push(m.toLowerCase()));
                    }
                    return found;
                });
                
                for (const e of domEmails) emails.add(e);
                return { html, text };
            } catch (e) {
                log(`  [BrowserScrape] Failed to load ${url}: ${e.message}`);
                return null;
            }
        };

        // ── Step 1: Scrape homepage ──
        log(`  [BrowserScrape] Loading homepage: ${baseUrl}`);
        const homepage = await scrapePage(baseUrl);
        if (!homepage || homepage.html.length < 200) {
            log(`  [BrowserScrape] Homepage too small or failed, falling back to HTTP`);
            if (context) await context.close().catch(() => {});
            return null; // Signal to fall back to HTTP
        }
        crawled.add(baseUrl);
        emailExtractHelpers.extractAllFromHtml(homepage.html, homepage.text, emails);

        // ── Step 2: Find internal links from homepage ──
        const internalLinks = await page.evaluate((baseDomain) => {
            const links = [];
            document.querySelectorAll('a[href]').forEach(a => {
                let href = a.href;
                if (!href || href.startsWith('mailto:') || href.startsWith('tel:') || 
                    href.startsWith('javascript:') || href.startsWith('data:')) return;
                if (href.match(/\.(pdf|jpg|jpeg|png|gif|svg|css|js|ico|woff|mp4|zip|webp)$/i)) return;
                try {
                    const url = new URL(href);
                    const linkDomain = url.hostname.replace(/^www\./, '').toLowerCase();
                    if (linkDomain !== baseDomain && linkDomain !== 'www.' + baseDomain) return;
                    const clean = url.origin + url.pathname.replace(/\/$/, '');
                    links.push(clean);
                } catch {}
            });
            return [...new Set(links)];
        }, domain);

        // Also grab footer links specifically (often have contact pages not in main nav)
        const footerLinks = await page.evaluate((baseDomain) => {
            const footer = document.querySelector('footer');
            if (!footer) return [];
            const links = [];
            footer.querySelectorAll('a[href]').forEach(a => {
                let href = a.href;
                if (!href || href.startsWith('mailto:') || href.startsWith('tel:')) return;
                try {
                    const url = new URL(href);
                    const linkDomain = url.hostname.replace(/^www\./, '').toLowerCase();
                    if (linkDomain !== baseDomain && linkDomain !== 'www.' + baseDomain) return;
                    links.push(url.origin + url.pathname.replace(/\/$/, ''));
                } catch {}
            });
            return [...new Set(links)];
        }, domain);

        // Merge and deduplicate, prioritize contact-related pages
        const allLinks = [...new Set([...footerLinks, ...internalLinks])].filter(l => !crawled.has(l) && l !== baseUrl);
        allLinks.sort((a, b) => {
            const aScore = LINK_PRIORITY.findIndex(p => a.toLowerCase().includes(p));
            const bScore = LINK_PRIORITY.findIndex(p => b.toLowerCase().includes(p));
            return (aScore === -1 ? 99 : aScore) - (bScore === -1 ? 99 : bScore);
        });

        // ── Step 3: Crawl top priority internal links (up to 12) ──
        for (const pageUrl of allLinks.slice(0, 12)) {
            if (emails.size > 0) {
                // Already found emails — no need to crawl more aggressively
                // But still check 1-2 more contact-type pages for better emails
                const isContactPage = LINK_PRIORITY.slice(0, 5).some(p => pageUrl.toLowerCase().includes(p));
                if (!isContactPage) continue;
            }
            crawled.add(pageUrl);
            const pageResult = await scrapePage(pageUrl, 12000);
            if (pageResult) {
                emailExtractHelpers.extractAllFromHtml(pageResult.html, pageResult.text, emails);
                log(`  [BrowserScrape] Crawled: ${pageUrl} (${emails.size} emails so far)`);
            }
        }

        // ── Step 4: Blind-guess common contact paths not yet visited ──
        for (const guessPath of CONTACT_PATHS) {
            const guessUrl = baseUrl + guessPath;
            if (crawled.has(guessUrl)) continue;
            // If we already have emails, only try the top 3 paths
            if (emails.size > 0 && CONTACT_PATHS.indexOf(guessPath) > 2) continue;
            
            crawled.add(guessUrl);
            const guessResult = await scrapePage(guessUrl, 8000);
            if (guessResult && guessResult.html.length > 500) {
                emailExtractHelpers.extractAllFromHtml(guessResult.html, guessResult.text, emails);
                log(`  [BrowserScrape] Blind guess hit: ${guessPath} (${emails.size} emails so far)`);
            }
        }

        // Close the incognito context
        await context.close().catch(() => {});
        context = null;

        // ── Step 5: Filter and MX-verify ──
        const candidateEmails = [...emails].filter(e => e.includes('@') && !emailExtractHelpers.isPlaceholder(e));
        log(`  [BrowserScrape] Raw: ${emails.size}, after filter: ${candidateEmails.length} → ${candidateEmails.join(', ') || 'none'}`);
        
        const dns = require('dns').promises;
        const verifiedEmails = [];
        // Parallelize MX lookups for speed
        const mxResults = await Promise.allSettled(candidateEmails.map(async (email) => {
            const emailDomain = email.split('@')[1];
            try {
                const records = await dns.resolveMx(emailDomain);
                if (records && records.length > 0) return { email, ok: true };
            } catch { /* MX failed, try A record fallback per RFC 5321 */ }
            try {
                const aRecords = await dns.resolve4(emailDomain);
                if (aRecords && aRecords.length > 0) return { email, ok: true, fallback: true };
            } catch { /* A record also failed */ }
            return { email, ok: false };
        }));
        for (const r of mxResults) {
            if (r.status === 'fulfilled' && r.value.ok) {
                verifiedEmails.push(r.value.email);
                log(`  [BrowserScrape] MX verified${r.value.fallback ? ' (A-record)' : ''}: ${r.value.email}`);
            } else if (r.status === 'fulfilled') {
                log(`  [BrowserScrape] MX failed (no records): ${r.value.email}`);
            }
        }
        log(`  [BrowserScrape] Final verified: ${verifiedEmails.length}`);
        return verifiedEmails;

    } catch (e) {
        log(`  [BrowserScrape] Fatal: ${e.message}`);
        if (context) await context.close().catch(() => {});
        return null; // Signal to fall back to HTTP
    }
}

// ── HTTP fallback scraper (original logic, improved) ──
async function scrapeWebsiteForEmails(websiteUrl) {
    try {
        const baseUrl = websiteUrl.replace(/\/$/, '');
        const domain = baseUrl.replace(/^https?:\/\/(www\.)?/, '').split('/')[0].toLowerCase();
        let allText = '';
        let allHtml = '';
        const crawled = new Set();

        let homepageHtml = '';
        for (let attempt = 0; attempt < 2; attempt++) {
            try { 
                homepageHtml = await fetchPage(baseUrl, 20000); 
                break;
            } catch (e) { 
                if (attempt === 0) {
                    log(`  [EmailScrape] Attempt 1 failed for ${baseUrl}: ${e.message}, retrying...`);
                    await sleep(2000);
                } else {
                    log(`  [EmailScrape] Attempt 2 failed for ${baseUrl}: ${e.message}`);
                    return [];
                }
            }
        }
        if (!homepageHtml || homepageHtml.length < 100) return [];
        log(`  [EmailScrape] Homepage: ${homepageHtml.length} bytes from ${baseUrl}`);

        crawled.add(baseUrl);
        allText += ' ' + emailExtractHelpers.stripHtml(homepageHtml);
        allHtml += homepageHtml;

        const hrefRegex = /href=["']([^"'#]+)["']/gi;
        const internalLinks = [];
        let hrefMatch;
        while ((hrefMatch = hrefRegex.exec(homepageHtml)) !== null) {
            let href = hrefMatch[1].trim();
            if (href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:') || href.startsWith('//') || href.startsWith('data:')) continue;
            if (href.match(/\.(pdf|jpg|jpeg|png|gif|svg|css|js|ico|woff|woff2|mp4|zip|webp)$/i)) continue;
            if (href.startsWith('/')) href = baseUrl + href;
            else if (!href.startsWith('http')) href = baseUrl + '/' + href;
            try {
                const linkDomain = href.replace(/^https?:\/\/(www\.)?/, '').split('/')[0].toLowerCase();
                if (linkDomain !== domain && linkDomain !== 'www.' + domain) continue;
            } catch { continue; }
            href = href.replace(/\/$/, '').split('?')[0].split('#')[0];
            if (!crawled.has(href) && href !== baseUrl) {
                internalLinks.push(href);
                crawled.add(href);
            }
        }

        // Also extract footer links from HTML
        const footerMatch = homepageHtml.match(/<footer[\s\S]*?<\/footer>/i);
        if (footerMatch) {
            const footerHrefRegex = /href=["']([^"'#]+)["']/gi;
            let fMatch;
            while ((fMatch = footerHrefRegex.exec(footerMatch[0])) !== null) {
                let href = fMatch[1].trim();
                if (href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) continue;
                if (href.startsWith('/')) href = baseUrl + href;
                else if (!href.startsWith('http')) href = baseUrl + '/' + href;
                try {
                    const linkDomain = href.replace(/^https?:\/\/(www\.)?/, '').split('/')[0].toLowerCase();
                    if (linkDomain !== domain && linkDomain !== 'www.' + domain) continue;
                } catch { continue; }
                href = href.replace(/\/$/, '').split('?')[0].split('#')[0];
                if (!crawled.has(href) && href !== baseUrl && !internalLinks.includes(href)) {
                    internalLinks.unshift(href); // Footer links get priority
                    crawled.add(href);
                }
            }
            // Also extract emails directly from footer HTML
            allText += ' ' + emailExtractHelpers.stripHtml(footerMatch[0]);
        }

        internalLinks.sort((a, b) => {
            const aScore = LINK_PRIORITY.findIndex(p => a.toLowerCase().includes(p));
            const bScore = LINK_PRIORITY.findIndex(p => b.toLowerCase().includes(p));
            return (aScore === -1 ? 99 : aScore) - (bScore === -1 ? 99 : bScore);
        });

        for (const pageUrl of internalLinks.slice(0, 12)) {
            try {
                const pageHtml = await fetchPage(pageUrl, 15000);
                if (pageHtml && pageHtml.length > 100) {
                    allText += ' ' + emailExtractHelpers.stripHtml(pageHtml);
                    allHtml += pageHtml;
                }
            } catch { /* skip */ }
        }

        // Blind-guess common contact pages (parallel batches of 5 for speed)
        const guessUrls = CONTACT_PATHS.map(p => ({ path: p, url: baseUrl + p })).filter(g => !crawled.has(g.url));
        for (let gi = 0; gi < guessUrls.length; gi += 5) {
            const batch = guessUrls.slice(gi, gi + 5);
            const results = await Promise.allSettled(batch.map(async (g) => {
                try {
                    const html = await fetchPage(g.url, 6000);
                    return { path: g.path, url: g.url, html: (html && html.length > 500) ? html : null };
                } catch { return { path: g.path, url: g.url, html: null }; }
            }));
            for (const r of results) {
                if (r.status === 'fulfilled' && r.value.html) {
                    crawled.add(r.value.url);
                    allText += ' ' + emailExtractHelpers.stripHtml(r.value.html);
                    allHtml += r.value.html;
                    log(`  [EmailScrape] Blind guess hit: ${r.value.path}`);
                }
            }
        }

        const emails = new Set();
        emailExtractHelpers.extractAllFromHtml(allHtml, allText, emails);

        const candidateEmails = [...emails].filter(e => e.includes('@') && !emailExtractHelpers.isPlaceholder(e));
        log(`  [EmailScrape] Raw emails found: ${emails.size}, after filter: ${candidateEmails.length} → ${candidateEmails.join(', ') || 'none'}`);
        const dns = require('dns').promises;
        const verifiedEmails = [];
        // Parallelize MX lookups for speed
        const mxResults = await Promise.allSettled(candidateEmails.map(async (email) => {
            const emailDomain = email.split('@')[1];
            try {
                const records = await dns.resolveMx(emailDomain);
                if (records && records.length > 0) return { email, ok: true };
            } catch { /* MX failed, try A record fallback per RFC 5321 */ }
            try {
                const aRecords = await dns.resolve4(emailDomain);
                if (aRecords && aRecords.length > 0) return { email, ok: true, fallback: true };
            } catch { /* A record also failed */ }
            return { email, ok: false };
        }));
        for (const r of mxResults) {
            if (r.status === 'fulfilled' && r.value.ok) {
                verifiedEmails.push(r.value.email);
                log(`  [EmailScrape] MX verified${r.value.fallback ? ' (A-record)' : ''}: ${r.value.email}`);
            } else if (r.status === 'fulfilled') {
                log(`  [EmailScrape] MX failed (no records): ${r.value.email}`);
            }
        }
        log(`  [EmailScrape] Final verified: ${verifiedEmails.length}`);
        return verifiedEmails;
    } catch (e) { log(`  [EmailScrape] Fatal: ${e.message}`); return []; }
}


// ── Voyager API call via browser fetch() ──
async function voyagerFetch(page, apiPath) {
    return await page.evaluate(async (p) => {
        try {
            const csrfMatch = document.cookie.match(/JSESSIONID="?([^";]+)"?/);
            const csrf = csrfMatch ? csrfMatch[1] : '';
            const res = await fetch(`https://www.linkedin.com${p}`, {
                headers: {
                    'accept': 'application/vnd.linkedin.normalized+json+2.1',
                    'x-restli-protocol-version': '2.0.0',
                    'x-li-lang': 'en_US',
                    'csrf-token': csrf,
                },
                credentials: 'include',
                signal: AbortSignal.timeout(15000),
            });
            if (res.status === 200) return { status: 200, data: await res.json() };
            return { status: res.status };
        } catch (e) { return { status: 0, error: e.message }; }
    }, apiPath);
}

// ── Scrape a single profile via Voyager API ──
async function scrapeProfile(page, profileUrl, browserInstance) {
    const result = {
        url: profileUrl, firstName: '', lastName: '', headline: '',
        activityStatus: 'Unknown', emails: [], websites: [],
        website: '', primaryEmail: '', websiteSource: '',
        emailSource: '',
        latestPostText: '',
        status: 'PENDING', logs: [],
    };
    const slug = profileUrl.replace(/\/+$/, '').split('/').pop().split('?')[0];

    try {
        // ── 1. Contact Info (website + email) ──
        result.logs.push('Fetching contact info via Voyager API...');
        let contactRes = await voyagerFetch(page, `/voyager/api/identity/profiles/${slug}/profileContactInfo`);
        if (contactRes.status !== 200) {
            await sleep(1000);
            contactRes = await voyagerFetch(page, `/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${slug}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.ProfileContactInfo-14`);
        }

        if (contactRes.status === 200) {
            const data = contactRes.data?.data || contactRes.data;
            const included = contactRes.data?.included || [];
            let websites = data.websites || [];
            let emailAddress = data.emailAddress || null;
            for (const item of included) {
                if (item.websites && websites.length === 0) websites = item.websites;
                if (item.emailAddress && !emailAddress) emailAddress = item.emailAddress;
            }
            result.websites = websites.map(w => (typeof w === 'string' ? w : (w.url || w.label || ''))).filter(Boolean);
            if (emailAddress) {
                const email = typeof emailAddress === 'string' ? emailAddress : (emailAddress.emailAddress || emailAddress.email || '');
                if (email) { result.emails.push(email); result.emailSource = 'linkedin'; }
            }
            if (result.websites.length > 0) result.website = result.websites[0];
            result.logs.push(`Contact: ${result.websites.length} website(s), ${result.emails.length} email(s)`);
        } else {
            result.logs.push(`Contact info failed: ${contactRes.status}`);
        }

        await sleep(500);

        // ── 2. Profile Data (name, headline, URN) ──
        result.logs.push('Fetching profile data via Voyager API...');
        let profileRes = await voyagerFetch(page, `/voyager/api/identity/profiles/${slug}/profileView`);
        if (profileRes.status !== 200) {
            await sleep(1000);
            profileRes = await voyagerFetch(page, `/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${slug}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-101`);
        }

        let profileUrn = null;
        if (profileRes.status === 200) {
            const str = JSON.stringify(profileRes.data);
            const urnMatch = str.match(/urn:li:fsd_profile:(ACoA[a-zA-Z0-9_-]+)/);
            if (urnMatch) profileUrn = `urn:li:fsd_profile:${urnMatch[1]}`;
            const included = profileRes.data?.included || [];
            
            // Find the correct profile by matching the slug
            let foundBySlug = false;
            for (const item of included) {
                if (item.publicIdentifier === slug || item.vanityName === slug) {
                    if (item.firstName) {
                        result.firstName = item.firstName;
                        result.lastName = item.lastName || '';
                        result.logs.push(`Name: ${item.firstName} ${item.lastName || ''}`);
                    }
                    if (item.headline) result.headline = item.headline;
                    foundBySlug = true;
                    break;
                }
            }
            // Fallback: use first profile-like item with firstName + lastName
            if (!foundBySlug) {
                for (const item of included) {
                    if (item.firstName && item.lastName && item.$type?.includes('Profile')) {
                        result.firstName = item.firstName;
                        result.lastName = item.lastName || '';
                        result.logs.push(`Name: ${item.firstName} ${item.lastName} (fallback)`);
                        if (item.headline) result.headline = item.headline;
                        break;
                    }
                }
            }
        } else {
            result.logs.push(`Profile data failed: ${profileRes.status}`);
        }

        await sleep(500);

        // ── Website Fallback Chain (if contact modal had no website) ──
        if (result.websites.length === 0) {
            result.logs.push('No website in contact info — trying fallback chain...');

            // Layer 2: Parse About/Summary section for URLs
            if (profileRes.status === 200) {
                const fallbackIncluded = profileRes.data?.included || [];
                for (const item of fallbackIncluded) {
                    const summary = item.summary || '';
                    if (summary) {
                        const urlRegex = /https?:\/\/[^\s"'<>)\]]+/gi;
                        const aboutUrls = (summary.match(urlRegex) || [])
                            .filter(u => !u.includes('linkedin.com') && !u.includes('licdn.com'))
                            .map(u => u.replace(/[.,;:!?)]+$/, ''));
                        if (aboutUrls.length > 0) {
                            result.websites.push(...aboutUrls);
                            result.website = aboutUrls[0];
                            result.websiteSource = 'about_section';
                            result.logs.push(`Fallback L2: Found ${aboutUrls.length} URL(s) in About section`);
                        }
                    }
                }
            }

            // Layer 3: Featured section links
            if (result.websites.length === 0) {
                try {
                    const featuredRes = await voyagerFetch(page, `/voyager/api/identity/profiles/${slug}/featuredContent`);
                    if (featuredRes.status === 200) {
                        const fStr = JSON.stringify(featuredRes.data);
                        const fUrlRegex = /https?:\/\/[^\s"'<>\\]+/g;
                        const featuredUrls = (fStr.match(fUrlRegex) || [])
                            .filter(u => !u.includes('linkedin.com') && !u.includes('licdn.com')
                                      && !u.includes('media.licdn') && !u.includes('static.licdn'))
                            .map(u => u.replace(/[\\"',]+$/, ''));
                        const uniqueFeatured = [...new Set(featuredUrls)];
                        if (uniqueFeatured.length > 0) {
                            result.websites.push(...uniqueFeatured.slice(0, 3));
                            result.website = uniqueFeatured[0];
                            result.websiteSource = 'featured_section';
                            result.logs.push(`Fallback L3: Found ${uniqueFeatured.length} URL(s) in Featured section`);
                        }
                    }
                } catch (e) { result.logs.push(`Fallback L3 failed: ${e.message}`); }
                await sleep(1000);
            }

            // Layer 4: Domain name guessing (firstName + lastName .com)
            if (result.websites.length === 0 && result.firstName) {
                const fn = result.firstName.toLowerCase().replace(/[^a-z]/g, '');
                const ln = (result.lastName || '').toLowerCase().replace(/[^a-z]/g, '');
                const domainGuesses = [];
                if (fn && ln) {
                    domainGuesses.push(`${fn}${ln}.com`, `${fn}-${ln}.com`);
                }
                if (fn) {
                    domainGuesses.push(`${fn}coaching.com`, `coach${fn}.com`, `the${fn}.com`);
                }
                const dns = require('dns').promises;
                for (const domain of domainGuesses) {
                    try {
                        await dns.resolve(domain);
                        // Domain exists — verify it returns real HTML
                        const testUrl = `https://${domain}`;
                        const testHtml = await fetchPage(testUrl, 5000).catch(() => null);
                        if (testHtml && testHtml.length > 500) {
                            result.websites.push(testUrl);
                            result.website = testUrl;
                            result.websiteSource = 'domain_guess';
                            result.logs.push(`Fallback L4: Guessed domain ${domain} exists!`);
                            break;
                        }
                    } catch { /* domain doesn't exist */ }
                }
            }
        } else {
            result.websiteSource = 'contact_modal';
        }

        // ── 3. Activity Check ──
        if (profileUrn) {
            result.logs.push('Checking activity via Voyager API...');
            const actRes = await voyagerFetch(page,
                `/voyager/api/identity/profileUpdatesV2?count=10&includeLongTermHistory=true&moduleKey=creator_profile_all_content_view%3Adesktop&numComments=0&numLikes=0&profileUrn=${encodeURIComponent(profileUrn)}&q=memberShareFeed`
            );
            if (actRes.status === 200) {
                const str = JSON.stringify(actRes.data);
                
                // --- DEBUG DUMP ---
                fs.writeFileSync(path.join(RESULTS_DIR, 'debug-activity-feed.json'), str);
                // ------------------
                
                // Method 1: Extract activity URN snowflake IDs (most reliable)
                const activityUrns = str.match(/urn:li:activity:(\d+)/g) || [];
                const urnDates = [];
                for (const urn of activityUrns) {
                    try {
                        const id = BigInt(urn.match(/\d+/)[0]);
                        const tsMs = Number(id >> BigInt(22));
                        const d = new Date(tsMs);
                        if (d.getFullYear() > 2015 && d.getFullYear() < 2100) urnDates.push(d);
                    } catch {}
                }
                
                // Method 2: Extract timestamp fields
                const timestamps = [];
                let m;
                const regex = /"(?:createdAt|postedAt|publishedAt|lastModifiedAt)"\s*:\s*(\d{13})/g;
                while ((m = regex.exec(str)) !== null) timestamps.push(parseInt(m[1]));
                
                // Method 3: Check paging metadata (if elements exist, there's activity)
                const hasElements = str.includes('"elements"') && !str.includes('"elements":[]');
                
                log(`  [Activity] URN dates: ${urnDates.length}, Timestamp fields: ${timestamps.length}, Has elements: ${hasElements}, Response size: ${str.length}`);
                
                if (urnDates.length > 0) {
                    urnDates.sort((a, b) => b - a);
                    const days = Math.floor((Date.now() - urnDates[0].getTime()) / 86400000);
                    result.activityStatus = days <= ACTIVITY_DAYS_THRESHOLD ? 'Active' : 'Inactive';
                    result.logs.push(`Latest post (URN): ${urnDates[0].toISOString().slice(0,10)} (${days} days ago) → ${result.activityStatus}`);
                } else if (timestamps.length > 0) {
                    timestamps.sort((a, b) => b - a);
                    const days = Math.floor((Date.now() - timestamps[0]) / 86400000);
                    result.activityStatus = days <= ACTIVITY_DAYS_THRESHOLD ? 'Active' : 'Inactive';
                    result.logs.push(`Latest post (timestamp): ${days} days ago → ${result.activityStatus}`);
                } else if (hasElements) {
                    // Has content but no parseable dates — assume active
                    result.activityStatus = 'Active';
                    result.logs.push('Activity elements found but no dates — assuming Active');
                } else {
                    result.activityStatus = 'Inactive';
                    result.logs.push('No posts found → Inactive');
                }

                // ── Extract latest post text for hook generation ──
                try {
                    const postTexts = [];
                    
                    // Helper to deeply extract text from a commentary object
                    function extractTextFrom(val) {
                        if (typeof val === 'string') return val;
                        if (val && typeof val === 'object') {
                            if (val.text && typeof val.text.text === 'string') return val.text.text;
                            if (typeof val.text === 'string') return val.text;
                        }
                        return null;
                    }

                    // Recursively search the entire activity response for post commentary
                    function searchForCommentary(obj) {
                        if (!obj || typeof obj !== 'object') return;
                        if (Array.isArray(obj)) {
                            for (const item of obj) searchForCommentary(item);
                            return;
                        }
                        
                        // Skip actor/profile objects to avoid grabbing headlines
                        const type = (obj.$type || obj['$type'] || '').toLowerCase();
                        if (type.includes('profile') || type.includes('actor') || type.includes('member')) return;

                        for (const [key, value] of Object.entries(obj)) {
                            if (key === 'commentary' || key === 'shareCommentary') {
                                const txt = extractTextFrom(value);
                                if (txt && txt.length > 50) postTexts.push(txt);
                            } else {
                                searchForCommentary(value);
                            }
                        }
                    }

                    if (actRes.data) {
                        searchForCommentary(actRes.data);
                    }

                    if (postTexts.length > 0) {
                        // Take the longest post (usually the most substantive)
                        postTexts.sort((a, b) => b.length - a.length);
                        result.latestPostText = postTexts[0].substring(0, 2000);
                        result.logs.push(`Captured latest post text (${result.latestPostText.length} chars)`);
                    } else {
                        result.logs.push('No post text found in activity feed');
                    }
                } catch (postExtractErr) {
                    result.logs.push(`Post text extraction failed: ${postExtractErr.message}`);
                }
            } else {
                result.activityStatus = 'Unknown';
                result.logs.push(`Activity check failed: ${actRes.status}`);
            }
        } else {
            result.activityStatus = 'Unknown';
            result.logs.push('No URN — cannot check activity');
        }

        // ── 4. Website email crawl (if websites found and no email yet) ──
        if (result.websites.length > 0 && result.emails.length === 0) {
            const ignoreCrawl = ['vagaro.com', 'calendly.com', 'linktr.ee', 'youtube.com', 'facebook.com',
                'linktree.com', 'docs.google.com', 'drive.google.com', 'bit.ly', 'tinyurl.com'];
            for (let siteUrl of result.websites) {
                if (ignoreCrawl.some(d => siteUrl.toLowerCase().includes(d))) { result.logs.push(`Phase 2: Skipping: ${siteUrl}`); continue; }
                
                try {
                    siteUrl = siteUrl.replace(/^https?:\/\/t(www\.)/, 'https://$1');
                    siteUrl = siteUrl.replace(/^t(www\.)/, 'https://$1');
                    if (!siteUrl.startsWith('http')) siteUrl = 'https://' + siteUrl;
                    
                    const parsed = new URL(siteUrl);
                    const rootUrl = `${parsed.protocol}//${parsed.hostname}`;
                    result.logs.push(`Phase 2: Crawling ${rootUrl} (from ${siteUrl})`);
                    
                    // Try Puppeteer-based scraper first (renders JS), fall back to HTTP
                    let websiteEmails = null;
                    if (browserInstance) {
                        result.logs.push(`Phase 2: Using Puppeteer browser (JS rendering enabled)`);
                        websiteEmails = await scrapeWebsiteWithBrowser(browserInstance, rootUrl);
                    }
                    if (websiteEmails === null) {
                        result.logs.push(`Phase 2: Falling back to HTTP scraper`);
                        websiteEmails = await scrapeWebsiteForEmails(rootUrl);
                    }
                    
                    if (websiteEmails.length > 0) {
                        result.emails = [...new Set([...result.emails, ...websiteEmails])];
                        result.emailSource = 'website_scraped';
                        result.logs.push(`Phase 2: Found ${websiteEmails.length} email(s): ${websiteEmails.join(', ')}`);
                        result.website = rootUrl;
                        break;
                    } else { result.logs.push(`Phase 2: No emails on ${rootUrl}`); }
                } catch (e) { result.logs.push(`Phase 2 failed: ${e.message}`); }
            }
            if (result.websites.length > 0 && !result.website) result.website = result.websites[0];
        }

        // ── 5. Email Guessing (last resort — if we have a domain but no emails) ──
        if (result.emails.length === 0 && result.website && result.firstName) {
            try {
                const parsedSite = new URL(result.website);
                const guessDomain = parsedSite.hostname.replace(/^www\./, '');
                // Skip guessing for generic platforms
                const skipGuess = ['gmail.com','yahoo.com','hotmail.com','wix.com','squarespace.com',
                    'wordpress.com','godaddy.com','weebly.com','webflow.io','carrd.co','notion.site',
                    'calendly.com','linktr.ee','linktree.com'];
                if (!skipGuess.some(s => guessDomain === s || guessDomain.endsWith('.' + s))) {
                    const fn = result.firstName.toLowerCase().replace(/[^a-z]/g, '');
                    const ln = (result.lastName || '').toLowerCase().replace(/[^a-z]/g, '');
                    const guesses = [`${fn}@${guessDomain}`, `hello@${guessDomain}`, `contact@${guessDomain}`];
                    if (ln) {
                        guesses.push(`${fn}.${ln}@${guessDomain}`, `${fn}${ln}@${guessDomain}`, `${fn[0]}${ln}@${guessDomain}`);
                    }
                    const dns = require('dns').promises;
                    // First check if domain accepts email at all
                    try {
                        const mxRecords = await dns.resolveMx(guessDomain);
                        if (mxRecords && mxRecords.length > 0) {
                            // Domain accepts email — use first name guess as best bet
                            result.emails.push(guesses[0]);
                            result.emailSource = 'pattern_guess';
                            result.logs.push(`Email guess (MX verified domain): ${guesses[0]}`);
                        }
                    } catch { /* no MX records */ }
                }
            } catch (e) { result.logs.push(`Email guessing failed: ${e.message}`); }
        }

        // ── 6. Email Prioritization ──
        if (result.emails.length > 0) {
            const wd = result.website ?
                result.website.replace(/^https?:\/\/(www\.)?/, '').split('/')[0].toLowerCase() : '';
            result.emails = prioritizeEmails(result.emails, result.firstName, wd);
            result.primaryEmail = result.emails[0];
        }

        // ── Final status ──
        // A lead is QUALIFIED only if they have emails AND are active.
        // Inactive profiles are rejected regardless of email availability.
        if (result.emails.length > 0) {
            result.status = result.activityStatus === 'Active' ? 'QUALIFIED' : 'REJECTED';
        } else if (result.activityStatus === 'Active') {
            result.status = 'ACTIVE_NO_CONTACT';
        } else if (result.activityStatus === 'Inactive') {
            result.status = 'REJECTED';
        } else {
            result.status = 'ACTIVITY_FAILED';
        }
    } catch (e) {
        result.logs.push(`Fatal error: ${e.message}`);
        result.status = 'ERROR';
    }

    return result;
}

// ── Graceful Shutdown ──
let browser = null;
let browserPid = null;
let isShuttingDown = false;

// ── Windows-aware process tree killer ──
function isProcessRunning(pid) {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

async function killBrowserProcess(b, pid) {
    // Step 1: Try graceful close
    if (b) {
        try { await b.close(); } catch { /* ignore */ }
    }

    if (!pid) return;

    // Step 2: Wait up to 3s for graceful exit
    for (let i = 0; i < 6; i++) {
        if (!isProcessRunning(pid)) { log('Browser exited cleanly ✅'); return; }
        await sleep(500);
    }

    // Step 3: Force kill entire process tree (cross-platform)
    log(`Browser PID ${pid} still alive — force-killing process tree...`);
    try {
        if (process.platform === 'win32') {
            execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
            log('Process tree killed via taskkill ✅');
        } else {
            // Linux/macOS: kill the process group (negative PID)
            try { process.kill(-pid, 'SIGKILL'); } catch {}
            // Also try pkill as fallback for child processes
            try { execSync(`pkill -P ${pid} 2>/dev/null || true`, { stdio: 'ignore' }); } catch {}
            log('Process tree killed via SIGKILL ✅');
        }

    } catch (e) {
        log(`taskkill failed: ${e.message} — trying process.kill`);
        try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
    }

    // Step 4: Wait for process to actually die
    for (let i = 0; i < 10; i++) {
        if (!isProcessRunning(pid)) return;
        await sleep(500);
    }
    log(`⚠️ PID ${pid} may still be alive after kill attempts`);
}

// ── Chrome profile lock cleanup ──
function cleanupChromeLocks(profileDir) {
    const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
    for (const lockFile of lockFiles) {
        const lockPath = path.join(profileDir, lockFile);
        try {
            if (fs.existsSync(lockPath)) {
                fs.unlinkSync(lockPath);
                log(`Removed stale lock: ${lockFile}`);
            }
        } catch { /* ignore — file may not exist */ }
    }
}

async function shutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    log(`${signal} received — shutting down gracefully...`);
    writeStatus('offline', { reason: signal });
    
    await killBrowserProcess(browser, browserPid);
    browser = null;
    browserPid = null;
    process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ── Browser lifecycle management ──
const RECYCLE_EVERY_N_JOBS = 50; // Restart browser every 50 jobs to prevent OOM

async function launchBrowser(profileDir, headless = true) {
    const lockFile = path.join(profileDir, 'SingletonLock');
    try { fs.unlinkSync(lockFile); log('Cleared stale browser lock'); } catch (e) {}

    const b = await puppeteerExtra.launch({
        headless: headless,
        userDataDir: profileDir,
        args: [
            '--no-sandbox', '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-gpu', '--disable-dev-shm-usage',
            '--window-size=1366,768',
            // Memory management flags
            '--js-flags=--max-old-space-size=512',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-default-apps',
            '--disable-sync',
            '--no-first-run',
        ],
        env: Object.assign({}, process.env, { DISPLAY: ':99' })
    });

    // Track the PID for reliable cleanup
    const proc = b.process();
    browserPid = proc ? proc.pid : null;
    if (browserPid) log(`Chrome launched (PID: ${browserPid}, headless: ${headless})`);

    return b;
}

async function loginAndGetPage(b, accounts) {
    // Reuse the default tab Chrome opens instead of creating a second one
    const pages = await b.pages();
    const page = pages.length > 0 ? pages[0] : await b.newPage();
    await page.setViewport({ width: 1366, height: 768 });

    log('Checking login...');
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);
    let url = page.url();
    if (url.includes('/feed') && !url.includes('authwall') && !url.includes('/login')) {
        log('Already logged in ✅');
    } else {
        log(`Logging in as ${accounts[0].email}...`);
        await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(3000);
        try {
            await page.waitForSelector('#username, #session_key', { timeout: 15000 });
            const usernameInput = await page.$('#username') ? '#username' : '#session_key';
            const passwordInput = await page.$('#password') ? '#password' : '#session_password';
            
            await page.type(usernameInput, accounts[0].email, { delay: 120 });
            await sleep(800);
            await page.type(passwordInput, accounts[0].password, { delay: 120 });
            await sleep(800);
            await page.click('button[type="submit"]');
            await sleep(5000);
        } catch (e) { 
            log(`⚠️ Login form not found: ${e.message}`); 
        }

        url = page.url();
        if (url.includes('/feed')) {
            log('Login successful ✅');
        } else {
            // Return null to signal that manual login is needed
            return null;
        }
    }
    return page;
}

function getMemoryMB() {
    const mem = process.memoryUsage();
    return Math.round(mem.rss / 1024 / 1024);
}

// ── Extracted post-processing function (runs in background while next profile scrapes) ──
async function nativePostProcess(job, result, log) {
    const appUrl = process.env.APP_URL || 'http://qualifier:3000';
    const region = job.targetRegion || 'na';
    log(`  [NativeFlow] Post-processing ${job.jobId} (region=${region}, status=${result.status})...`);

    async function fetchWithRetry(url, opts, label, maxRetries = 3) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(30000) });
                const body = await res.text();
                if (res.ok) {
                    try { return { ok: true, data: JSON.parse(body) }; } catch { return { ok: true, data: body }; }
                }
                log(`  [NativeFlow] ${label} attempt ${attempt}/${maxRetries} failed: HTTP ${res.status} — ${body.substring(0, 200)}`);
            } catch (e) {
                log(`  [NativeFlow] ${label} attempt ${attempt}/${maxRetries} error: ${e.message}`);
            }
            if (attempt < maxRetries) await sleep(2000 * attempt);
        }
        return { ok: false, data: null };
    }

    try {
        if (result.status === 'QUALIFIED') {
            const hasWebsite = result.websites && result.websites.length > 0;
            if (hasWebsite) {
                log(`  [NativeFlow] QUALIFIED + Website → Generating hook from ${result.websites[0]}...`);
                const hookResult = await fetchWithRetry(
                    `${appUrl}/api/generate-hook`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            websiteText: result.websites[0],
                            linkedinPostText: result.latestPostText || ''
                        })
                    },
                    'Hook generation'
                );
                const hook = hookResult.ok ? (hookResult.data?.result?.hook || '') : '';
                if (hook) log(`  [NativeFlow] ✅ Hook: "${hook.substring(0, 80)}..."`);
                else log(`  [NativeFlow] ⚠️ No hook generated (will save lead without hook)`);

                log(`  [NativeFlow] Pushing to CRM → /api/crm/leads/${region}_qualified`);
                const crmResult = await fetchWithRetry(
                    `${appUrl}/api/crm/leads/${region}_qualified`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            firstName: result.firstName,
                            lastName: result.lastName,
                            email: result.primaryEmail || '',
                            all_emails: result.emails || [],
                            email_status: result.emailSource === 'pattern_guess' ? 'GUESSED' : 'UNVERIFIED',
                            linkedin_url: result.url,
                            hook: hook,
                            website: result.website || result.websites[0],
                            website_source: result.websiteSource || ''
                        })
                    },
                    'CRM save (qualified)'
                );
                if (crmResult.ok) log(`  [NativeFlow] ✅ Lead saved to CRM (${region}_qualified)`);
                else log(`  [NativeFlow] ❌ CRM save FAILED after retries`);
            } else {
                log(`  [NativeFlow] QUALIFIED but no website — skipping (matches n8n flow)`);
            }
        } else {
            log(`  [NativeFlow] NOT QUALIFIED → Pushing to /api/crm/leads/not_qualified`);
            const crmResult = await fetchWithRetry(
                `${appUrl}/api/crm/leads/not_qualified`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ linkedin_url: result.url })
                },
                'CRM save (not_qualified)'
            );
            if (crmResult.ok) log(`  [NativeFlow] ✅ Lead marked not_qualified in CRM`);
            else log(`  [NativeFlow] ❌ CRM not_qualified save FAILED after retries`);
        }
    } catch (err) {
        log(`  [NativeFlow] ❌ Fatal error in post-processing: ${err.message}`);
    }
}

// ── Main Loop ──
async function main() {
    loadEnv();
    const accounts = getAccounts();
    const profileDir = path.join(BROWSER_PROFILES_DIR, 'account-0');
    if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });

    // Startup housekeeping
    handleStaleQueue();
    purgeOldResults();

    let totalJobsProcessed = 0;
    let cycleJobCount = 0;
    
    // ── Enhanced stats tracking ──
    const sessionStartedAt = new Date().toISOString();
    let dailyQualified = 0;
    let dailyRejected = 0;
    let dailyErrors = 0;
    let lastJobDurationMs = 0;
    let jobDurations = []; // rolling window for avg calculation
    const pendingPostProcessing = []; // track background post-processing promises

    // Outer loop: manages browser lifecycle
    while (!isShuttingDown) {
        // Try headless first (silent, no visible windows)
        log(`Launching browser in HEADLESS mode... (cycle start, total processed: ${totalJobsProcessed})`);
        
        browser = await launchBrowser(profileDir, true);
        let page;
        try {
            page = await loginAndGetPage(browser, accounts);
        } catch (e) {
            log(`❌ Headless login check failed: ${e.message}`);
            page = null;
        }

        // If headless login failed, fall back to headful for manual login
        if (!page) {
            log('⚠️ Session expired or CAPTCHA needed — switching to HEADFUL mode for manual login...');
            await killBrowserProcess(browser, browserPid);
            browser = null;
            browserPid = null;

            browser = await launchBrowser(profileDir, false);
            try {
                const headfulPage = await loginAndGetPage(browser, accounts);
                if (!headfulPage) {
                    // loginAndGetPage returned null = needs manual intervention
                    log('⚠️ Please complete login or CAPTCHA in the browser window within 10 minutes...');
                    const pages = await browser.pages();
                    const manualPage = pages.length > 0 ? pages[0] : await browser.newPage();
                    let loggedIn = false;
                    for (let i = 0; i < 120; i++) {
                        await sleep(5000);
                        try {
                            const currentUrl = manualPage.url();
                            if (currentUrl.includes('/feed') && !currentUrl.includes('authwall')) {
                                log('Manual login detected ✅');
                                loggedIn = true;
                                break;
                            }
                        } catch { /* page may have navigated */ }
                    }
                    if (!loggedIn) {
                        log('❌ Manual login timed out. Exiting.');
                        await killBrowserProcess(browser, browserPid);
                        process.exit(1);
                    }
                    page = manualPage;
                } else {
                    page = headfulPage;
                }
            } catch (e) {
                log(`❌ Headful login also failed: ${e.message}. Retrying in 30s...`);
                await killBrowserProcess(browser, browserPid);
                browser = null;
                browserPid = null;
                await sleep(30000);
                continue;
            }

            // Login succeeded in headful mode — close it and relaunch headlessly
            log('Login session saved. Switching back to HEADLESS mode...');
            await killBrowserProcess(browser, browserPid);
            browser = null;
            browserPid = null;
            await sleep(2000);

            browser = await launchBrowser(profileDir, true);
            try {
                page = await loginAndGetPage(browser, accounts);
                if (!page) {
                    log('❌ Headless still failed after manual login. Running in headful mode for this cycle.');
                    await killBrowserProcess(browser, browserPid);
                    browser = null;
                    browserPid = null;
                    browser = await launchBrowser(profileDir, false);
                    page = await loginAndGetPage(browser, accounts);
                    if (!page) {
                        log('❌ Cannot login. Exiting.');
                        await killBrowserProcess(browser, browserPid);
                        process.exit(1);
                    }
                }
            } catch (e) {
                log(`❌ Headless relaunch failed: ${e.message}. Retrying in 30s...`);
                await killBrowserProcess(browser, browserPid);
                browser = null;
                browserPid = null;
                await sleep(30000);
                continue;
            }
        }

        log('🟢 Worker is READY. Watching queue/ for jobs...');
        log(`   Queue dir: ${QUEUE_DIR}`);
        log(`   Results dir: ${RESULTS_DIR}`);
        log(`   Memory: ${getMemoryMB()} MB | Recycle after: ${RECYCLE_EVERY_N_JOBS} jobs`);

        writeStatus('ready', { startedAt: new Date().toISOString(), totalJobsProcessed });

        cycleJobCount = 0;
        let lastHeartbeat = Date.now();
        let needsRecycle = false;

        // Inner loop: processes jobs with current browser
        while (!isShuttingDown && !needsRecycle) {
            try {
                // Heartbeat every 30s
                if (Date.now() - lastHeartbeat > 30000) {
                    writeStatus('ready', { totalJobsProcessed, cycleJobCount, memoryMB: getMemoryMB(), idle: true });
                    lastHeartbeat = Date.now();
                }

                const files = fs.readdirSync(QUEUE_DIR).filter(f => f.endsWith('.json')).sort();
                
                if (files.length === 0) {
                    await sleep(POLL_INTERVAL_MS);
                    continue;
                }

                // ── Check Daily Limit ──
                const dailyLimit = parseInt(process.env.DAILY_SCRAPE_LIMIT || '0', 10);
                if (dailyLimit > 0) {
                    let limitData = { date: '', count: 0 };
                    try {
                        if (fs.existsSync(LIMITS_FILE)) limitData = JSON.parse(fs.readFileSync(LIMITS_FILE, 'utf8'));
                    } catch {}
                    
                    const today = new Date().toISOString().split('T')[0];
                    if (limitData.date !== today) {
                        limitData = { date: today, count: 0 };
                    }
                    
                    if (limitData.count >= dailyLimit) {
                        writeStatus('paused', { reason: `Daily limit of ${dailyLimit} reached`, nextReset: 'midnight' });
                        log(`⏳ Daily limit of ${dailyLimit} reached. Sleeping for 15 minutes before checking again...`);
                        await sleep(15 * 60 * 1000);
                        continue;
                    }
                    
                    // Pre-increment to reserve the slot
                    limitData.count++;
                    try { fs.writeFileSync(LIMITS_FILE, JSON.stringify(limitData)); } catch {}
                }

                const jobFile = files[0];
                const jobPath = path.join(QUEUE_DIR, jobFile);
                
                let job;
                try {
                    job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
                } catch (e) {
                    log(`⚠️ Bad job file ${jobFile}: ${e.message} — removing`);
                    try { fs.unlinkSync(jobPath); } catch { }
                    await sleep(2000);
                    continue;
                }
                
                // (Job claimed, will unlink on completion to avoid losing mid-scrape)

                const jobId = job.jobId;
                const profileUrl = job.linkedinUrl;
                const jobStartTime = Date.now();

                log(`Processing job ${jobId}: ${profileUrl} [${cycleJobCount + 1}/${RECYCLE_EVERY_N_JOBS} in cycle, ${getMemoryMB()} MB]`);
                
                // Read daily stats for status
                let dailyCount = 0;
                let dailyLimitVal = parseInt(process.env.DAILY_SCRAPE_LIMIT || '0', 10);
                try {
                    if (fs.existsSync(LIMITS_FILE)) {
                        const ld = JSON.parse(fs.readFileSync(LIMITS_FILE, 'utf8'));
                        const today = new Date().toISOString().split('T')[0];
                        if (ld.date === today) dailyCount = ld.count;
                    }
                } catch {}
                
                writeStatus('processing', { 
                    jobId, url: profileUrl, totalJobsProcessed, cycleJobCount,
                    sessionStartedAt, dailyCount, dailyLimit: dailyLimitVal,
                    dailyQualified, dailyRejected, dailyErrors,
                    lastJobDurationMs, avgJobDurationMs: jobDurations.length > 0 ? Math.round(jobDurations.reduce((a,b) => a+b, 0) / jobDurations.length) : 0,
                    memoryMB: getMemoryMB(),
                    pendingPostProcessing: pendingPostProcessing.length
                });

                // Health check: is browser/page still alive?
                let pageAlive = false;
                try { 
                    await page.evaluate(() => true); 
                    pageAlive = true;
                } catch {
                    log('⚠️ Page crashed mid-cycle. Recycling browser...');
                }

                let result;
                if (pageAlive) {
                    try {
                        result = await scrapeProfile(page, profileUrl, browser);
                    } catch (e) {
                        log(`⚠️ scrapeProfile threw: ${e.message}`);
                        result = { url: profileUrl, firstName: '', headline: '', activityStatus: 'Unknown', emails: [], websites: [], website: '', status: 'ERROR', logs: [`Fatal: ${e.message}`] };
                    }
                } else {
                    result = { url: profileUrl, firstName: '', headline: '', activityStatus: 'Unknown', emails: [], websites: [], website: '', status: 'ERROR', logs: ['Browser page crashed before scrape'] };
                }

                // Track duration
                const jobDuration = Date.now() - jobStartTime;
                lastJobDurationMs = jobDuration;
                jobDurations.push(jobDuration);
                if (jobDurations.length > 50) jobDurations.shift(); // rolling window of 50

                // Track daily result counters
                if (result.status === 'QUALIFIED') dailyQualified++;
                else if (result.status === 'ERROR') dailyErrors++;
                else dailyRejected++;

                totalJobsProcessed++;
                cycleJobCount++;

                // Write result
                const resultPath = path.join(RESULTS_DIR, `${jobId}.json`);
                fs.writeFileSync(resultPath, JSON.stringify({ status: 'done', result, completedAt: new Date().toISOString() }));

                try { fs.unlinkSync(jobPath); } catch { }

                // Fire webhook callback to n8n if configured
                if (job.webhookUrl) {
                    await fireWebhook(job.webhookUrl, { jobId, status: 'done', result, completedAt: new Date().toISOString() });
                }
                
                // --- Fire-and-forget post-processing (runs in background while next profile scrapes) ---
                if (job.nativePostProcess) {
                    const ppPromise = nativePostProcess(job, result, log)
                        .catch(err => log(`  [NativeFlow] ❌ Background error: ${err.message}`))
                        .finally(() => {
                            const idx = pendingPostProcessing.indexOf(ppPromise);
                            if (idx >= 0) pendingPostProcessing.splice(idx, 1);
                        });
                    pendingPostProcessing.push(ppPromise);
                }

                log(`✅ Job ${jobId} done → ${result.status} | ${result.firstName} | Emails: ${result.emails.length} | ${Math.round(jobDuration/1000)}s (Total: ${totalJobsProcessed}, Mem: ${getMemoryMB()} MB)`);
                writeStatus('ready', { 
                    totalJobsProcessed, cycleJobCount, lastJob: jobId, memoryMB: getMemoryMB(),
                    sessionStartedAt, dailyCount, dailyLimit: dailyLimitVal,
                    dailyQualified, dailyRejected, dailyErrors,
                    lastJobDurationMs, avgJobDurationMs: jobDurations.length > 0 ? Math.round(jobDurations.reduce((a,b) => a+b, 0) / jobDurations.length) : 0,
                    pendingPostProcessing: pendingPostProcessing.length
                });

                // Check if we need to recycle the browser
                if (!pageAlive || cycleJobCount >= RECYCLE_EVERY_N_JOBS) {
                    needsRecycle = true;
                    log(`🔄 Browser recycle triggered (${!pageAlive ? 'page crashed' : `${cycleJobCount} jobs reached`}). Restarting browser...`);
                }

                // Clear page memory between jobs: navigate back to LinkedIn feed
                if (!needsRecycle && pageAlive) {
                    try {
                        await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 15000 });
                    } catch { /* ignore */ }
                }

                // Delay between profiles
                await sleep(1500);

            } catch (e) {
                log(`Error in poll loop: ${e.message}`);
                await sleep(5000);
            }
        }

        // Wait for any pending post-processing to finish before recycling
        if (pendingPostProcessing.length > 0) {
            log(`⏳ Waiting for ${pendingPostProcessing.length} background post-processing tasks to finish...`);
            await Promise.allSettled(pendingPostProcessing);
            pendingPostProcessing.length = 0;
            log(`✅ All background tasks complete.`);
        }

        // Close the old browser before starting a new one — use proper Windows process killing
        log(`Closing browser for recycle... (processed ${cycleJobCount} jobs this cycle)`);
        await killBrowserProcess(browser, browserPid);
        browser = null;
        browserPid = null;

        // Force garbage collection if available
        if (global.gc) {
            global.gc();
            log(`GC forced. Memory after: ${getMemoryMB()} MB`);
        }

        // Brief pause before relaunching
        if (!isShuttingDown) {
            log('Waiting 5s before relaunching browser...');
            await sleep(5000);
        }
    }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });

