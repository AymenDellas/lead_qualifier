/**
 * Persistent LinkedIn Worker
 *
 * One isolated browser and LinkedIn session per account process. The supervisor
 * coordinates the selected accounts through leased database jobs.
 *
 * Usage:
 *   npm run worker              → Watch explicit dashboard account requests
 *   node worker.cjs --start      → Explicit legacy single-account processing
 */

const puppeteer = require('puppeteer');
const {pageSignal, failure:sessionFailure,isFeed,sameMember}=require('./src/lib/linkedin-session-policy.cjs');
const pageReader=require('./src/lib/linkedin-browser-page.cjs');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { researchProspect } = require('./src/lib/prospect-research.cjs');
const {failureOf}=require('./src/lib/worker-failure.cjs');
const prospectingStore=require('./src/lib/coach-prospecting-store.cjs');
const prospectingWorker=require('./src/lib/coach-prospecting-worker.cjs');
let prospectingContext=false;
let prospectingFailure=null;
let linkedinStop=null;
let checkDay='';
let linkedinChecks={};
let sessionChecks={};
let localNextCheckAt=0;
const { VERSION: QUALIFICATION_VERSION, assessProspect, pipelineForAssessment, isPlatformWebsite, isUnsafeContact, hostOf } = require('./src/lib/prospect-qualification.cjs');



// ── Config ──
const ACTIVITY_DAYS_THRESHOLD = 30;
const BROWSER_PROFILES_DIR = path.join(__dirname, '.browser-profiles');
const QUEUE_DIR = path.join(__dirname, 'queue');
const RESULTS_DIR = path.join(__dirname, 'queue-results');
const POLL_INTERVAL_MS = 2000;
const RESULT_TTL_DAYS = 7; // Auto-purge results older than this
// How many leads may be in the post-LinkedIn enrichment stage at once. These do
// not touch LinkedIn, so they're safe to run in parallel with the scrape loop.
const ENRICH_CONCURRENCY = Math.max(1, parseInt(process.env.ENRICH_CONCURRENCY || '3', 10));
// Application profile budget; this is not an allowance guaranteed by LinkedIn.
const DEFAULT_DAILY_SCRAPE_LIMIT = '400';

// ── CLI Flags ──
const RESUME_MODE = process.argv.includes('--resume');
const MANUAL_LOGIN_MODE = process.argv.includes('--login');
const CHECK_LOGIN_MODE = process.argv.includes('--check-login');
const SIGN_OUT_MODE = process.argv.includes('--logout');
const accountArg = process.argv.indexOf('--account');
const ACCOUNT_ID = accountArg >= 0 ? process.argv[accountArg + 1] : null;
if (accountArg >= 0 && !/^(?:legacy-\d+|[a-f0-9-]{36})$/.test(ACCOUNT_ID || '')) throw new Error('Invalid worker account ID.');
let dbWorker = null;
let databaseCleanup = null;
let settleJobs = async () => {};
let latestStatus = { status: 'starting' };
let signedInIdentity = null;

// ── Ensure dirs exist ──
if (!fs.existsSync(QUEUE_DIR)) fs.mkdirSync(QUEUE_DIR, { recursive: true });
if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const LIMITS_FILE = path.join(DATA_DIR, 'worker-limits.json');
const CHECKS_FILE = path.join(DATA_DIR, 'worker-checks.json');
const WORKER_PID_FILE = path.join(DATA_DIR, ACCOUNT_ID ? `worker-${ACCOUNT_ID}.pid` : 'worker.pid');
let workerLockOwned = false;

function acquireWorkerLock() {
    if (!ACCOUNT_ID) {
        for (const name of ['worker-supervisor.pid', 'worker-legacy-0.pid']) {
            try {
                const pid = JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8')).pid;
                if (Number.isInteger(pid) && isProcessRunning(pid)) { log('Account workers already manage this browser session. Use the dashboard account controls.'); return false; }
            } catch { /* no managed session */ }
        }
    }
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            fs.writeFileSync(WORKER_PID_FILE, JSON.stringify({ pid: process.pid }), { flag: 'wx' });
            workerLockOwned = true;
            return true;
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            let pid;
            try { pid = JSON.parse(fs.readFileSync(WORKER_PID_FILE, 'utf8')).pid; } catch { }
            if (!Number.isInteger(pid) || pid <= 0 || isProcessRunning(pid)) {
                log(`A worker is already running or starting. This duplicate will exit without launching Chrome.`);
                return false;
            }
            try { fs.unlinkSync(WORKER_PID_FILE); } catch { return false; }
        }
    }
    return false;
}

function releaseWorkerLock() {
    if (!workerLockOwned) return;
    try {
        if (JSON.parse(fs.readFileSync(WORKER_PID_FILE, 'utf8')).pid === process.pid) fs.unlinkSync(WORKER_PID_FILE);
    } catch { /* cleanup after process exit */ }
    workerLockOwned = false;
}
// Recovery net for nativePostProcess: a lead that's fully scraped/enriched but
// fails to save to the CRM (after retries) lands here instead of being lost.
const FAILED_PUSHES_DIR = path.join(RESULTS_DIR, 'failed-pushes');
if (!fs.existsSync(FAILED_PUSHES_DIR)) fs.mkdirSync(FAILED_PUSHES_DIR, { recursive: true });

// ── Load env ──
function loadEnv() {
    const envPath = path.join(__dirname, '.env.local');
    if (!fs.existsSync(envPath)) throw new Error('.env.local not found');
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
        const clean = line.replace(/\r/g, '');
        const match = clean.match(/^([^#=]+)=(.+)$/);
        if (!match) continue;
        // Strip surrounding quotes the way dotenv (and therefore Next.js) does.
        // Without this a quoted value is passed through with its quotes attached,
        // which silently corrupts anything parsed as a URL or JSON.
        const value = match[2].trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
        process.env[match[1].trim()] = value;
    }
}

async function startDatabaseAccount() {
    if (!ACCOUNT_ID) return;
    const core = require('./src/lib/linkedin-workers.cjs');
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4, connectionTimeoutMillis: 10000,
        ssl: process.env.DATABASE_CA_CERT ? { ca: process.env.DATABASE_CA_CERT.replace(/\\n/g, '\n'), rejectUnauthorized: true } : { rejectUnauthorized: false } });
    const owner = require('node:crypto').randomUUID();
    await core.ensure(pool);
    await prospectingStore.ensure(pool);
    const account = (await pool.query('SELECT *,login_requested_at::text AS login_request_token,logout_requested_at::text AS logout_request_token FROM compel_linkedin_accounts WHERE id=$1 AND archived IS FALSE', [ACCOUNT_ID])).rows[0];
    if (!account || !await core.acquireSession(pool, ACCOUNT_ID, owner)) { await pool.end(); return false; }
    dbWorker = { core, pool, owner, account, timer: null };
    if (MANUAL_LOGIN_MODE) await core.consumeLoginRequest(pool, ACCOUNT_ID, account.login_request_token);
    let updating = false;
    dbWorker.timer = setInterval(async () => {
        if (updating) return;
        updating = true;
        try { await core.heartbeat(pool, ACCOUNT_ID, owner, latestStatus); }
        catch { await shutdown('Database connection or account lease lost; jobs are retained.', 1); }
        finally { updating = false; }
    }, 20000);
    dbWorker.timer.unref();
    return true;
}
async function stopDatabaseAccount() {
    if (databaseCleanup) return databaseCleanup;
    if (!dbWorker) return;
    const closing = dbWorker;
    dbWorker = null;
    clearInterval(closing.timer);
    databaseCleanup = (async () => {
        try { await closing.core.releaseSession(closing.pool, ACCOUNT_ID, closing.owner, latestStatus); } catch { /* leases expire after a disconnected host */ }
        await closing.pool.end();
    })();
    return databaseCleanup;
}

// ── Utilities ──
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
/** Randomised pause. Fixed round-number delays are both slower than they need to
 *  be and more regular than a human, which is the worst of both. */
function jitter(min, max) { return sleep(min + Math.floor(Math.random() * (max - min))); }
function log(msg) { console.log(`[Worker] ${new Date().toLocaleTimeString()} — ${msg}`); }

// Recovery net: called when a CRM save fails after retries so the already-scraped
// lead data isn't just lost. Never throws — a dead-letter write failing shouldn't
// crash the job.
function writeDeadLetter(jobId, endpoint, payload) {
    try {
        const filePath = path.join(FAILED_PUSHES_DIR, `${jobId}.json`);
        fs.writeFileSync(filePath, JSON.stringify({ savedAt: new Date().toISOString(), endpoint, payload }, null, 2));
        log(`  [NativeFlow] 💾 Saved failed push to ${filePath} for manual recovery`);
    } catch (e) {
        log(`  [NativeFlow] ⚠️ Failed to write dead-letter for ${jobId}: ${e.message}`);
    }
}

function isRecentActivity(dateStr) {
    if (!dateStr) return false;
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return false;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - ACTIVITY_DAYS_THRESHOLD);
    return d > cutoff;
}

// Vendor domains that show up in a site's own markup — payment widgets, CMS
// chrome, theme authors. An address here belongs to the platform, not the lead.
const THIRD_PARTY_MAIL_DOMAINS = [
    'surecart.com', 'jouwweb.nl', 'wix.com', 'squarespace.com', 'shopify.com',
    'wordpress.com', 'wordpress.org', 'godaddy.com', 'weebly.com', 'webflow.com',
    'carrd.co', 'notion.so', 'kajabi.com', 'teachable.com', 'thinkific.com',
    'systeme.io', 'clickfunnels.com', 'hubspot.com', 'mailchimp.com', 'calendly.com',
    'about.me', 'linktr.ee', 'stripe.com', 'paypal.com', 'zoom.us', 'acuityscheduling.com',
];

// Local parts that are a company's back office. Harmless on the lead's own domain
// (a solo operator's support@ is still them), but on someone else's domain they're
// unambiguously the vendor's.
const VENDOR_ROLE_LOCALS = [
    'support', 'privacy', 'legal', 'abuse', 'billing', 'notifications', 'notification',
    'noreply', 'no-reply', 'donotreply', 'security', 'compliance', 'help', 'helpdesk',
];

/**
 * Drops addresses that were scraped off a page but don't belong to the lead.
 * Emailing a vendor's support desk isn't a wasted send — it's a spam complaint
 * from a company with an abuse team.
 */
function rejectNonLeadEmails(emails, websiteDomain, logs) {
    const wd = (websiteDomain || '').toLowerCase();
    return emails.filter(email => {
        const [localRaw, domainRaw] = email.split('@');
        if (!localRaw || !domainRaw) return false;
        const local = localRaw.toLowerCase();
        const domain = domainRaw.toLowerCase();
        const onLeadDomain = Boolean(wd) && (domain === wd || domain.endsWith('.' + wd));

        if (THIRD_PARTY_MAIL_DOMAINS.some(d => domain === d || domain.endsWith('.' + d))) {
            logs?.push(`Rejected ${email}: third-party platform address, not the lead's`);
            return false;
        }
        if (!onLeadDomain && VENDOR_ROLE_LOCALS.includes(local)) {
            logs?.push(`Rejected ${email}: back-office address on a domain that isn't the lead's`);
            return false;
        }
        // Long digit runs never appear in a hand-written address; they're the
        // signature of a regex over-capture across concatenated page text.
        if (/\d{5,}/.test(local)) {
            logs?.push(`Rejected ${email}: looks like a mangled extraction`);
            return false;
        }
        return true;
    });
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
        // Prefer the published practice inbox over an unfamiliar staff mailbox.
        else if (wd && domain === wd && !['info','support','admin','billing','help','sales','team','office','noreply','no-reply'].includes(local)) priority = 60;
        // OK: info/contact on their domain
        else if (wd && domain === wd && ['info','contact'].includes(local)) priority = 22;
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
    if(isShuttingDown&&!['offline','paused','signed_out'].includes(status))return;
    const currentChecks=checkDay===new Date().toISOString().slice(0,10)?linkedinChecks:{};
    latestStatus = { status, qualificationVersion: QUALIFICATION_VERSION, prospectingVersion:'COACH_EVIDENCE_V1', accountId: ACCOUNT_ID,
        dailyRequests:Object.entries(currentChecks).reduce((sum,[kind,count])=>sum+(kind==='cache'?0:count),0),dailyCachedProfiles:currentChecks.cache||0,
        ...extra, signedIn: signedInIdentity, updatedAt: new Date().toISOString() };
    try {
        fs.writeFileSync(
            path.join(RESULTS_DIR, ACCOUNT_ID ? `worker-status-${ACCOUNT_ID}.json` : 'worker-status.json'),
            JSON.stringify(latestStatus)
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

// ── Shared permits for page loads and page controls ──
async function recordLinkedInCheck(kind) {
    if(linkedinStop)throw Object.assign(new Error(linkedinStop.reason),{failure:linkedinStop});
    const day=new Date().toISOString().slice(0,10);
    if(checkDay!==day){
        checkDay=day;linkedinChecks={};
        if(!dbWorker)try{const saved=JSON.parse(fs.readFileSync(CHECKS_FILE,'utf8'));if(saved.day===day){linkedinChecks=saved.counts||{};localNextCheckAt=Number(saved.nextCheckAt)||0;}}catch{/* no saved counters */}
    }
    if(dbWorker) {
        if(kind==='cache')await dbWorker.core.recordLinkedInCheck(dbWorker.pool,ACCOUNT_ID,dbWorker.owner,kind);
        else while(!isShuttingDown) {
            const permit=await dbWorker.core.reserveLinkedInCheck(dbWorker.pool,ACCOUNT_ID,dbWorker.owner,kind,{manual:MANUAL_LOGIN_MODE&&CHECK_LOGIN_MODE});
            if(permit.stopped){linkedinStop={stage:'control',code:'WORKER_PAUSED',reason:permit.reason,retryable:false};throw Object.assign(new Error(permit.reason),{failure:linkedinStop});}
            if(!permit.waitMs)break;
            if(permit.reason)writeStatus('sleeping',{reason:permit.reason});
            await sleep(Math.min(permit.waitMs,1000));
        }
    }
    if(!dbWorker&&kind!=='cache') {
        const used=Object.entries(linkedinChecks).reduce((sum,[key,count])=>sum+(key==='cache'?0:count),0);
        if(used>=100){linkedinStop={stage:'linkedin',code:'WORKER_PAUSED',reason:'Daily LinkedIn check budget reached.',retryable:false};throw Object.assign(new Error(linkedinStop.reason),{failure:linkedinStop});}
        if(localNextCheckAt>Date.now())await sleep(localNextCheckAt-Date.now());
        localNextCheckAt=Date.now()+15000;
    }
    if(isShuttingDown)throw new Error('Account worker stopped.');
    linkedinChecks[kind]=(linkedinChecks[kind]||0)+1;
    sessionChecks[kind]=(sessionChecks[kind]||0)+1;
    if(!dbWorker)fs.writeFileSync(CHECKS_FILE,JSON.stringify({day,counts:linkedinChecks,nextCheckAt:localNextCheckAt}));
}
function checkLinkedInAccess(status,url='') {
    if(![401,403,429,999].includes(status)&&!/(?:linkedin\.com)?\/(?:checkpoint|challenge|login|authwall)(?:\/|\?|$)/i.test(url))return;
    linkedinStop={stage:'linkedin',code:status===429?'LINKEDIN_RATE_LIMIT':'LINKEDIN_AUTH',reason:status===429?'LinkedIn reported a limit. Review the account before signing in to resume.':'LinkedIn requires sign-in or a security check. Review the account before resuming.',retryable:false};
    prospectingFailure=linkedinStop;
    throw Object.assign(new Error(linkedinStop.reason),{failure:linkedinStop});
}
// Every LinkedIn read now follows rendered pages and controls. Browser identity
// and captured evidence are never reconstructed through private endpoints.
async function scrapeProfile(page, profileUrl, browserInstance, onCheckpoint, resume) {
    try {
        return await pageReader.captureProfile(page,profileUrl,{
            accountId:ACCOUNT_ID||'legacy-0',beforeCheck:recordLinkedInCheck,
            checkResponse:checkLinkedInAccess,onCheckpoint,resume,
        });
    } catch(error) {
        if(error.failure?.stage==='linkedin') {
            if(['LINKEDIN_AUTH','LINKEDIN_RATE_LIMIT'].includes(error.failure.code))linkedinStop=error.failure;
        }
        return {url:profileUrl,firstName:'',headline:'',activityStatus:'Unknown',emails:[],websites:[],website:'',status:'ERROR',
            failure:error.failure||{stage:'linkedin',code:'PAGE_CHANGED',reason:'The rendered LinkedIn page could not be read. Saved evidence is retained for review.',retryable:false},logs:['Page reading stopped: '+error.message]};
    }
}

// ── Stage 2: enrichment (no LinkedIn session required) ──
// Follow the site’s discovered public routes; no LinkedIn browser is needed.
async function enrichAndFinalize(result, browserInstance, retryCount = 0) {
    try {
        delete result.failure;
        const previousResearch = result.prospectQualification?.baseResearch || result.prospectQualification?.research;
        result.logs.push('Finding a published email and checking LinkedIn activity within 30 days. Crawling actual website links...');
        let knownWebsite='';
        if(dbWorker&&result.profileIdentityConfirmed){
            try{const slug=result.url.match(/\/in\/([^/?#]+)/i)?.[1]?.toLowerCase();knownWebsite=(await dbWorker.pool.query("SELECT website FROM leads WHERE lower(substring(linkedin_url from '/in/([^/?#]+)'))=$1 AND NULLIF(website,'') IS NOT NULL ORDER BY created_at LIMIT 1",[slug])).rows[0]?.website||'';}catch{result.logs.push('Saved website lookup unavailable; published profile links are retained.');}
        }
        const renderPage=typeof browserInstance?.createBrowserContext==='function'?require('./src/lib/public-page-browser.cjs').createPageRenderer(browserInstance):undefined;
        const research = await researchProspect({
            ...result, linkedinUrl: result.url, knownWebsite, email: result.primaryEmail || result.emails[0] || '',
        }, { ai: false, previousResearch,renderPage,qualificationFirst:true });
        if (retryCount >= 3 && research.crawl && !research.crawl.complete && research.crawl.retryable !== false) {
            research.crawl.retryable = false;
            research.crawl.stoppedReason = 'Automatic website retries exhausted; saved routes remain for manual review. ' + research.crawl.stoppedReason;
        }
        for (const limitation of research.limitations.filter(note => /^Automated interpretation/.test(note))) result.logs.push(limitation);
        // Business facts are advisory. A guessed email never qualifies a lead.
        result.website = research.website || '';
        result.emails = research.contacts.filter(c => ['PUBLISHED', 'DOMAIN_MATCH'].includes(c.ownership)).map(c => c.address);
        result.emails = prioritizeEmails([...new Set(result.emails)], result.firstName, hostOf(research.website));
        // An address published by this person's LinkedIn profile is the first
        // choice, ahead of a shared practice inbox found on a website.
        result.emails.sort((a,b)=>Number(research.contacts.find(c=>c.address===b)?.source==='linkedin')-Number(research.contacts.find(c=>c.address===a)?.source==='linkedin'));
        result.primaryEmail = result.emails[0] || '';
        const chosen = research.contacts.find(c => c.address === result.primaryEmail);
        result.emailSource = chosen?.source === 'website' ? 'website_scraped' : chosen?.source || '';
        result.prospectQualification = assessProspect(research, { email: result.primaryEmail });
        const q = result.prospectQualification.qualification;
        result.status = pipelineForAssessment(result.prospectQualification) === 'QUALIFIED' ? 'QUALIFIED' : q.needsRetry || q.needsAttention ? 'ERROR' : 'REJECTED';
        if (result.status === 'ERROR') {
            if(q.activity==='UNKNOWN'||!research.profileIdentityConfirmed) {
                // An empty/undated successful feed is unresolved evidence, not
                // a transport failure. Repeating the full profile three times
                // cannot supply a missing date. Retain it for explicit review.
                const transient=result.activityCheck?.retryable===true;
                const retryable=transient&&retryCount<1;
                const detail=research.activityEvidence?.endpoint==='profile_activity_page'?research.activityEvidence.reason:result.prospectQualification.blockers[0];
                result.failure={stage:'linkedin',code:research.profileIdentityConfirmed?'ACTIVITY_UNCONFIRMED':'PROFILE_IDENTITY',
                    reason:detail+(retryable?'':' The saved profile is retained for manual review.'),retryable};
            } else result.failure={stage:'research',code:'CRAWL_INCOMPLETE',reason:research.crawl?.stoppedReason||'Website could not be fully read; the saved profile is retained.',retryable:research.crawl?.retryable!==false};
        }
        if (research.crawl) result.logs.push(`Website crawl: ${research.crawl.inspected} pages read, ${research.crawl.contactPages} contact pages, ${research.crawl.descriptionPages} description pages; ${research.crawl.complete ? 'all discovered routes inspected' : research.crawl.pending.length + ' pending, ' + research.crawl.failed.length + ' blocked'}.`);
        result.logs.push('Qualification: ' + result.status + ' — ' + result.prospectQualification.nextAction);
        if (!result.primaryEmail) result.logs.push('No attributable email found; the LinkedIn profile remains available.');
    } catch (error) {
        result.logs.push('Research could not complete: ' + error.message);
        result.status = 'ERROR';
        result.failure={stage:'research',code:'RESEARCH_FAILED',reason:'Website or qualification research could not complete.',retryable:true};
    }
    return result;
}


function isProcessRunning(pid) {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

const browserCleanups = new Map();
function killBrowserProcess(b, pid) {
    const key = pid || b;
    if (browserCleanups.has(key)) return browserCleanups.get(key);
    const task = closeBrowserProcess(b, pid).finally(() => browserCleanups.delete(key));
    browserCleanups.set(key, task);
    return task;
}

async function closeBrowserProcess(b, pid) {
    // Step 1: Try graceful close
    if (b) {
        try { await Promise.race([b.close(), sleep(2500)]); } catch { /* force cleanup below */ }
    }

    if (!Number.isInteger(pid) || pid <= 0) return;

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

// Shared by the main loop, browser launch/recycle and signal handlers.
let browser = null;
let browserPid = null;
let isShuttingDown = false;
let browserLaunchTask = null;
let shutdownTask = null;

function shutdown(signal, exitCode = 0) {
    if (shutdownTask) return shutdownTask;
    isShuttingDown = true;
    shutdownTask=(async()=>{
    if (dbWorker) {
        // Persist the stop before waiting for outstanding website research.
        try{await dbWorker.core.pauseProcessing(dbWorker.pool,ACCOUNT_ID,linkedinStop?.reason||signal,
            ['LINKEDIN_AUTH','LINKEDIN_RATE_LIMIT'].includes(linkedinStop?.code),dbWorker.owner);}
        catch{log('Could not persist the account stop. Browser activity is still stopping; the lease will expire.');}
        await settleJobs();
    }
    log(`${signal} received — shutting down gracefully...`);
    if (!(SIGN_OUT_MODE&&latestStatus.status==='signed_out') && !(latestStatus.status==='paused'&&exitCode!==0)) writeStatus('offline', { reason: signal });

    let launchingBrowser = null;
    if (browserLaunchTask) {
        try { launchingBrowser = await browserLaunchTask; } catch { /* failed launch */ }
    }
    await killBrowserProcess(browser || launchingBrowser, browserPid || launchingBrowser?.process()?.pid);
    browser = null;
    browserPid = null;
    releaseWorkerLock();
    await stopDatabaseAccount();
    process.exit(exitCode);
    })();
    return shutdownTask;
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('message', message => { if (message?.type === 'stop') shutdown('Account stopped from dashboard.'); });
process.on('exit', () => {
    // Unexpected exits also reap this worker's own browser tree. Never target
    // all chrome.exe processes: the user's normal browser must stay untouched.
    if (Number.isInteger(browserPid) && browserPid > 0) {
        try {
            if (process.platform === 'win32') execSync(`taskkill /F /T /PID ${browserPid}`, { stdio: 'ignore' });
            else process.kill(browserPid, 'SIGKILL');
        } catch { /* browser may already be closed */ }
    }
    releaseWorkerLock();
});

// ── Browser lifecycle management ──
const RECYCLE_EVERY_N_JOBS = 50; // Stop after 50 jobs; another browser needs an explicit start.
const workerPages = new WeakMap();

async function prepareWorkerPage(b, allowPages) {
    // Do not call browser.pages(): it initializes every restored page and its
    // network session before we can close it. That can overwhelm a saved profile.
    const session = await b.target().createCDPSession();
    try {
        const { targetInfos } = await session.send('Target.getTargets');
        const restored = targetInfos.filter(target => target.type === 'page');
        // Keep a window alive while removing restored tabs. Headful Chrome can
        // exit when its final tab closes, before Puppeteer opens the login page.
        const keeper = await session.send('Target.createTarget', { url: 'about:blank' });
        for (const target of restored) {
            const result = await session.send('Target.closeTarget', { targetId: target.targetId });
            if (!result.success) throw new Error('Could not close a saved worker tab.');
        }
        if (restored.length > 1) log(`Closed ${restored.length} saved worker tabs before initializing LinkedIn.`);
        allowPages();
        workerPages.set(b, await b.newPage());
        const closed = await session.send('Target.closeTarget', { targetId: keeper.targetId });
        if (!closed.success) throw new Error('Could not close the temporary worker tab.');
    } finally {
        await session.detach().catch(() => {});
    }
}

async function launchBrowser(profileDir, headless = false) {
    let acceptPages = false;
    browserLaunchTask = puppeteer.launch({
        headless: headless,
        userDataDir: profileDir,
        timeout: 30000, protocolTimeout: 30000,
        // Suppress page/plugin initialization until saved tabs have been closed.
        waitForInitialPage: false,
        targetFilter: target => target.type() !== 'page' || acceptPages,
        handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
        args: [
            ...(process.platform==='linux'&&process.getuid?.()===0?['--no-sandbox','--disable-setuid-sandbox']:[]),
            ...(process.platform==='linux'?['--disable-dev-shm-usage']:[]),
            '--window-size=1366,768',
        ],
        env: Object.assign({}, process.env, process.platform==='linux'&&!process.env.DISPLAY?{DISPLAY:':99'}:{})
    });
    let b;
    try { b = await browserLaunchTask; } finally { browserLaunchTask = null; }

    // Track the PID for reliable cleanup
    const proc = b.process();
    browserPid = proc ? proc.pid : null;
    if (browserPid) log(`Chrome launched (PID: ${browserPid}, headless: ${headless})`);

    try {
        await prepareWorkerPage(b, () => { acceptPages = true; });
    } catch (error) {
        await killBrowserProcess(b, browserPid);
        browserPid = null;
        throw error;
    }
    return b;
}

async function inspectSessionPage(page, response, manual=false) {
    const url=page.url();
    let text='';
    try{text=await page.evaluate(()=>{
        const alert=document.querySelector('[role="alert"], [role="dialog"]');
        return (document.title+'\n'+(alert?.innerText||(!location.pathname.startsWith('/feed')?document.body?.innerText||'':''))).slice(0,12000);
    });}catch(error){if(page.isClosed())throw error;}
    return pageSignal({url:page.url()||url,status:response?.status?.()||0,text:typeof text==='string'?text:'',manual});
}
function watchSessionPage(page) {
    page.on('response',response=>{
        try {
            const request=response.request();
            if(!['document','xhr','fetch'].includes(request.resourceType())||!/(^|\.)linkedin\.com$/i.test(new URL(response.url()).hostname))return;
            if(request.isNavigationRequest()&&response.frame()!==page.mainFrame())return;
            const signal=pageSignal({url:response.url(),status:response.status()});
            if(!signal||isShuttingDown)return;
            linkedinStop=sessionFailure(signal);prospectingFailure=linkedinStop;
            writeStatus('paused',{reason:signal.reason,manualResumeRequired:linkedinStop?.code!=='WORKER_PAUSED'});
            shutdown('LinkedIn needs account review.',1).catch(error=>log('Account stop failed: '+error.message));
        }catch(error){log('Session response check failed: '+error.message);}
    });
}
async function loginAndGetPage(b) {
    const page=workerPages.get(b);
    await page.setViewport({width:1366,height:768});
    watchSessionPage(page);
    await recordLinkedInCheck('identity');
    const response=await page.goto('https://www.linkedin.com/feed/',{waitUntil:'domcontentloaded',timeout:45000});
    if(isShuttingDown)return null;
    const signal=await inspectSessionPage(page,response);
    if(signal){linkedinStop=sessionFailure(signal);throw Object.assign(new Error(signal.reason),{failure:linkedinStop});}
    if(!isFeed(page.url())) {
        linkedinStop=sessionFailure({code:'LINKEDIN_AUTH',reason:'LinkedIn session could not be confirmed. Use manual sign-in; no password was submitted.'});
        throw Object.assign(new Error(linkedinStop.reason),{failure:linkedinStop});
    }
    return page;
}
async function manualSignIn(profileDir) {
    browser=await launchBrowser(profileDir,false);
    if(isShuttingDown)return;
    const page=workerPages.get(browser);
    await page.setViewport({width:1366,height:768});
    let loginResponse;
    let reason='Sign-in browser is open on the worker computer. Complete login or the LinkedIn security check there.';
    try {
        loginResponse=await page.goto('https://www.linkedin.com/login',{waitUntil:'domcontentloaded',timeout:45000});
    } catch(error) {
        if(page.isClosed()||!browser.isConnected())throw error;
        // A timeout or interrupted navigation does not mean the browser failed.
        // Leave the user's account window open so they can refresh and sign in.
        log(`LinkedIn sign-in page did not finish loading: ${error.message}`);
        reason='The sign-in browser is open, but LinkedIn did not finish loading. Refresh the page in that window and complete sign-in.';
    }
    await page.bringToFront();
    const initialSignal=await inspectSessionPage(page,loginResponse,true);
    if(initialSignal){
        if(dbWorker)await dbWorker.core.pauseProcessing(dbWorker.pool,ACCOUNT_ID,initialSignal.reason,true,dbWorker.owner);
        reason=initialSignal.reason+' The manual window stays open for you to review it.';
    }
    writeStatus('awaiting_login',{reason});
    log('Manual sign-in browser opened. No saved password was entered.');
    for(let attempt=0;attempt<120&&!isShuttingDown;attempt++) {
        if(page.isClosed()||!browser.isConnected())throw new Error('Manual sign-in window was closed.');
        if(isFeed(page.url())) {
            const signal=await inspectSessionPage(page,null,true);
            if(signal){linkedinStop=sessionFailure(signal);throw new Error(signal.reason);}
            const identity=await pageReader.readSignedInIdentity(page,{beforeCheck:recordLinkedInCheck,checkResponse:checkLinkedInAccess});
            if(identity) {
                if(dbWorker)try{await dbWorker.core.confirmManualSignIn(dbWorker.pool,ACCOUNT_ID,dbWorker.owner,identity);}
                catch(error){linkedinStop=sessionFailure({code:'LINKEDIN_AUTH',reason:error.message});throw error;}
                signedInIdentity=identity;writeStatus('ready',{reason:`Signed in as ${identity.name}. Processing is idle until explicitly started.`});
                log(`Manual login confirmed as ${identity.name} (${identity.profileUrl}).`);
                await shutdown('Manual sign-in complete');return;
            }
            linkedinStop=sessionFailure({code:'LINKEDIN_AUTH',reason:'LinkedIn identity could not be confirmed. Processing remains paused; no repeated identity checks were sent.'});
            throw new Error(linkedinStop.reason);
        }
        const signal=await inspectSessionPage(page,null,true);
        if(signal&&dbWorker)await dbWorker.core.pauseProcessing(dbWorker.pool,ACCOUNT_ID,signal.reason,true,dbWorker.owner);
        await sleep(5000);
    }
    if(!isShuttingDown){writeStatus('paused',{reason:'Manual sign-in timed out. Click Sign in on worker computer to reopen the browser.'});await shutdown('Manual sign-in timed out',1);}
}

function getMemoryMB() {
    const mem = process.memoryUsage();
    return Math.round(mem.rss / 1024 / 1024);
}

// ── Extracted post-processing function (runs in background while next profile scrapes) ──
async function nativePostProcess(job, result, log) {
    if (!result.prospectQualification?.research) return;
    const unresolved=result.status==='ERROR';
    if(unresolved){
        // A failed first attempt stays in the research queue. A recheck with
        // confirmed identity must withdraw a stale CRM qualification if its
        // email/activity evidence can no longer support it.
        if(!dbWorker||!result.prospectQualification.research.profileIdentityConfirmed)return;
        const slug=result.url.match(/\/in\/([^/?#]+)/i)?.[1]?.toLowerCase();
        const existing=await dbWorker.pool.query("SELECT id FROM leads WHERE lower(substring(linkedin_url from '/in/([^/?#]+)'))=$1 AND pipeline_status='QUALIFIED' LIMIT 1",[slug]);
        if(!existing.rowCount)return;
    }
    const appUrl = process.env.APP_URL || 'http://localhost:3000';
    const endpoint = appUrl + '/api/prospects/research-result';
    const payload = {
        linkedinUrl: result.url, firstName: result.firstName, lastName: result.lastName,
        email: result.primaryEmail || '', emailSource: result.emailSource || '',
        websiteSource: result.websiteSource || '', research: result.prospectQualification.research,
    };
    if (dbWorker) {
        try {
            const { saveWorkerResearch } = require('./src/lib/worker-research-store.cjs');
            const saved = await saveWorkerResearch(dbWorker.pool, {...payload,jobId:job.jobId,owner:dbWorker.owner});
            result.crmSaved = true; result.crmLeadId = saved.id;
            result.prospectQualification = saved.assessment;
            result.primaryEmail = saved.assessment.contact.email;
            if (result.primaryEmail && !result.emails.includes(result.primaryEmail)) result.emails.unshift(result.primaryEmail);
            result.status = unresolved ? 'ERROR' : saved.pipelineStatus === 'QUALIFIED' ? 'QUALIFIED' : 'REJECTED';
            return;
        } catch(error) {
            result.crmSaved = false; result.status = 'ERROR';
            result.logs.push('CRM save failed; research retained for recovery.');
            writeDeadLetter(job.jobId, 'database', payload);
            throw error;
        }
    }
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(120000) });
            if (response.ok) {
                const saved = await response.json();
                result.crmSaved = true;
                result.crmLeadId = saved.id;
                if (saved.assessment) result.prospectQualification = saved.assessment;
                result.status = (saved.pipelineStatus || pipelineForAssessment(result.prospectQualification)) === 'QUALIFIED' ? 'QUALIFIED' : 'REJECTED';
                log('  [Research] Saved to CRM: ' + result.status + '.');
                return;
            }
            log('  [Research] CRM save attempt ' + attempt + ' failed: HTTP ' + response.status);
        } catch (error) { log('  [Research] CRM save attempt ' + attempt + ' failed: ' + error.message); }
        if (attempt < 3) await sleep(2000 * attempt);
    }
    result.crmSaved = false;
    result.logs.push('Business research completed but CRM save failed; retained for recovery.');
    writeDeadLetter(job.jobId, endpoint, payload);
}


async function main() {
    loadEnv();
    if(!ACCOUNT_ID&&!MANUAL_LOGIN_MODE&&!CHECK_LOGIN_MODE&&!process.argv.includes('--start')) {
        log('Use dashboard account controls to start processing. Legacy workers require an explicit --start.');return;
    }
    if (!acquireWorkerLock()) return;
    if (await startDatabaseAccount() === false) { releaseWorkerLock(); return; }
    if (SIGN_OUT_MODE) {
        if (!dbWorker?.account.logout_request_token) { await shutdown('No sign-out request.'); return; }
        const profileDir = path.join(BROWSER_PROFILES_DIR, dbWorker.account.profile_key);
        try {
            browser = await launchBrowser(profileDir, false);
            if (isShuttingDown) return;
            await require('./src/lib/linkedin-signout.cjs').signOut(browser,log);
            await killBrowserProcess(browser,browserPid); browser=null; browserPid=null;
            if (!await dbWorker.core.finishLogout(dbWorker.pool,ACCOUNT_ID,dbWorker.account.logout_request_token)) throw new Error('Account request changed before sign-out was saved.');
            signedInIdentity=null;
            writeStatus('signed_out',{reason:'LinkedIn signed out. Use Sign in on worker computer to reconnect.'});
            await shutdown('LinkedIn signed out');
        } catch(error) {
            writeStatus('paused',{reason:`Sign-out failed: ${error.message}`});
            await shutdown('Sign-out failed',1);
        }
        return;
    }
    const profileDir = path.join(BROWSER_PROFILES_DIR, dbWorker ? dbWorker.account.profile_key : 'account-0');
    if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });
    if(MANUAL_LOGIN_MODE&&CHECK_LOGIN_MODE){
        try{await manualSignIn(profileDir);}catch(error){
            writeStatus('paused',{reason:linkedinStop?.reason||'The sign-in browser could not open or load LinkedIn. Click Sign in on worker computer to try again.',manualResumeRequired:Boolean(linkedinStop)});
            log(`Manual sign-in failed: ${error.message}`);await shutdown('Manual sign-in failed',1);
        }
        return;
    }
    if(dbWorker&&!await dbWorker.core.processingAllowed(dbWorker.pool,ACCOUNT_ID,dbWorker.owner)) {
        await shutdown('Processing has not been explicitly started.');return;
    }

    // Startup housekeeping
    handleStaleQueue();
    purgeOldResults();

    let totalJobsProcessed = 0;
    let cycleJobCount = 0;

    // ── Enhanced stats tracking ──
    const sessionStartedAt = new Date().toISOString();
    let dailyQualified = 0;
    let dailyRejected = 0;
    let dailyReview = 0;
    let dailyNurture = 0;
    let dailyErrors = 0;
    let lastJobDurationMs = 0;
    let jobDurations = []; // rolling window for avg calculation
    const pendingPostProcessing = []; // track background post-processing promises
    settleJobs = () => Promise.allSettled([...pendingPostProcessing]);
    const inFlightJobs = new Set();

    // Outer loop: manages browser lifecycle
    while (!isShuttingDown) {
        // Reuse the same visible browser mode as manual sign-in.
        log(`Launching the saved account browser... (cycle start, total processed: ${totalJobsProcessed})`);

        browser = await launchBrowser(profileDir, false);
        if (isShuttingDown) return;
        let page;
        try {
            page = await loginAndGetPage(browser);
        } catch (e) {
            if(linkedinStop){writeStatus('paused',{reason:linkedinStop.reason,manualResumeRequired:linkedinStop?.code!=='WORKER_PAUSED'});await shutdown('LinkedIn needs account review.',1);return;}
            // A navigation/CDP timeout does not establish that login expired.
            // Stop after this attempt; a new browser requires an explicit start.
            log(`❌ Browser could not check LinkedIn: ${e.message}`);
            await killBrowserProcess(browser, browserPid);
            browser = null; browserPid = null;
            if (isShuttingDown) return;
            writeStatus('paused', { reason: 'Browser could not load LinkedIn. Processing is paused; check the connection before explicitly starting again.' });
            log('Browser startup failed. No automatic login or browser retry will run. Pending jobs are preserved.');
            await shutdown('Browser startup failed',1);return;
        }
        if(linkedinStop){writeStatus('paused',{reason:linkedinStop.reason,manualResumeRequired:linkedinStop?.code!=='WORKER_PAUSED'});await shutdown('LinkedIn needs account review.',1);return;}

        if(!page||isShuttingDown)return;

        signedInIdentity = await pageReader.readSignedInIdentity(page,{beforeCheck:recordLinkedInCheck,checkResponse:checkLinkedInAccess});
        if(!signedInIdentity||dbWorker?.account.confirmed_identity&&!sameMember(dbWorker.account.confirmed_identity,signedInIdentity)){
            linkedinStop=sessionFailure({code:'LINKEDIN_AUTH',reason:'The signed-in LinkedIn member could not be matched to this account. Processing stopped; reconnect manually.'});
            writeStatus('paused',{reason:linkedinStop.reason,manualResumeRequired:linkedinStop?.code!=='WORKER_PAUSED'});await shutdown('LinkedIn identity needs review.',1);return;
        }
        if (signedInIdentity) log(`Signed in as ${signedInIdentity.name} (${signedInIdentity.profileUrl || signedInIdentity.memberUrn}).`);
        else log('Signed-in LinkedIn profile could not be confirmed; no saved email was substituted.');
        log('🟢 Worker is READY. Watching queue/ for jobs...');
        log(`   Queue dir: ${QUEUE_DIR}`);
        log(`   Results dir: ${RESULTS_DIR}`);
        log(`   Memory: ${getMemoryMB()} MB | Pause after: ${RECYCLE_EVERY_N_JOBS} jobs`);

        writeStatus('ready', { startedAt: new Date().toISOString(), totalJobsProcessed });

        if (CHECK_LOGIN_MODE) {
            log('Startup login check passed. Pending jobs were not processed.');
            await shutdown('Startup check complete');
            return;
        }

        cycleJobCount = 0;
        let lastHeartbeat = Date.now();
        let needsRecycle = false;

        // Inner loop: processes jobs with current browser
        while (!isShuttingDown && !needsRecycle) {
            try {
                if(linkedinStop){
                    if(dbWorker)await prospectingStore.pauseAccount(dbWorker.pool,ACCOUNT_ID,linkedinStop.reason);
                    writeStatus('paused',{reason:linkedinStop.reason,manualResumeRequired:linkedinStop?.code!=='WORKER_PAUSED'});await shutdown('LinkedIn needs account review.',1);return;
                }
                // Heartbeat every 30s
                if (Date.now() - lastHeartbeat > 30000) {
                    writeStatus('ready', { totalJobsProcessed, cycleJobCount, memoryMB: getMemoryMB(), idle: true });
                    lastHeartbeat = Date.now();
                }

                let reservation, job, jobFile, jobPath;
                if (dbWorker) {
                    const sourceRun=await prospectingStore.claimSource(dbWorker.pool,ACCOUNT_ID,dbWorker.owner);
                    if(sourceRun){
                        if(!signedInIdentity){const reason='LinkedIn viewer identity could not be confirmed. Sign in on the worker computer before prospecting.';await prospectingStore.pauseAccount(dbWorker.pool,ACCOUNT_ID,reason);writeStatus('paused',{reason,manualResumeRequired:linkedinStop?.code!=='WORKER_PAUSED'});await shutdown('Prospecting needs account identity confirmation.',1);return;}
                        writeStatus('processing',{phase:'PROSPECT_DISCOVERY',url:sourceRun.data.sourceUrl,runId:sourceRun.id});
                        const discovery=await prospectingWorker.discover(page,sourceRun,{pool:dbWorker.pool,owner:dbWorker.owner,log,beforeCheck:recordLinkedInCheck});
                    if(discovery.paused){
                        if(!linkedinStop)linkedinStop=sessionFailure({code:/rate limit/i.test(discovery.paused)?'LINKEDIN_RATE_LIMIT':'LINKEDIN_AUTH',reason:discovery.paused});
                        writeStatus('paused',{reason:discovery.paused,manualResumeRequired:linkedinStop?.code!=='WORKER_PAUSED'});await shutdown('Prospecting paused for LinkedIn attention.',1);return;
                    }
                        continue;
                    }
                    reservation = await dbWorker.core.claim(dbWorker.pool, ACCOUNT_ID, dbWorker.owner);
                    if (reservation?.disabled) { await shutdown('Account disabled or no longer selected.'); return; }
                    if (reservation?.limited) {
                        writeStatus('paused', { reason: `Daily limit of ${reservation.dailyLimit} reached`, ...reservation });
                        await sleep(POLL_INTERVAL_MS); continue;
                    }
                    if (!reservation) { await sleep(POLL_INTERVAL_MS); continue; }
                    job = reservation.job; jobFile = `${job.jobId}.json`;
                    jobPath = path.join(QUEUE_DIR, jobFile);
                } else {
                const files = fs.readdirSync(QUEUE_DIR).filter(f => f.endsWith('.json') && !inFlightJobs.has(f)).sort();

                if (files.length === 0) {
                    await sleep(POLL_INTERVAL_MS);
                    continue;
                }

                jobFile = files[0];
                jobPath = path.join(QUEUE_DIR, jobFile);

                try {
                    job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
                } catch (e) {
                    log(`⚠️ Bad job file ${jobFile}: ${e.message} — removing`);
                    try { fs.unlinkSync(jobPath); } catch { }
                    await sleep(2000);
                    continue;
                }

                // ── Check Daily Limit ──
                // Runs after the job file is confirmed parseable, so a corrupt/bad
                // job file (handled above) never burns a real slot off the count.
                const dailyLimit = parseInt(process.env.DAILY_SCRAPE_LIMIT || DEFAULT_DAILY_SCRAPE_LIMIT, 10);
                if (dailyLimit > 0) {
                    let limitData = { date: '', count: 0 };
                    try {
                        if (fs.existsSync(LIMITS_FILE)) limitData = JSON.parse(fs.readFileSync(LIMITS_FILE, 'utf8'));
                    } catch {}

                    const today = new Date().toISOString().split('T')[0];
                    if (limitData.date !== today) {
                        limitData = { date: today, count: 0 };
                    }

                    const budgetProfile=job.linkedinUrl?.match(/\/in\/([^/?#]+)/i)?.[1]?.toLowerCase();
                    const seen=Array.isArray(limitData.profiles)?limitData.profiles:[];
                    const alreadyCounted=budgetProfile&&seen.includes(budgetProfile);
                    if (!job.resumeResult&&!alreadyCounted&&limitData.count >= dailyLimit) {
                        writeStatus('paused', { reason: `Daily limit of ${dailyLimit} reached`, nextReset: 'midnight' });
                        log(`⏳ Daily limit of ${dailyLimit} reached. Sleeping for 15 minutes before checking again...`);
                        await sleep(15 * 60 * 1000);
                        continue;
                    }

                    // Preserve legacy usage; reserve each newly seen profile
                    // once per UTC day, including after a local worker restart.
                    if(!job.resumeResult&&!alreadyCounted){limitData.count++;if(budgetProfile)seen.push(budgetProfile);}
                    limitData.profiles=seen;
                    try { fs.writeFileSync(LIMITS_FILE, JSON.stringify(limitData)); } catch {}
                }
                }

                // (Job claimed, will unlink on completion to avoid losing mid-scrape)

                const jobId = job.jobId;
                inFlightJobs.add(jobFile);
                const profileUrl = job.linkedinUrl;
                const jobStartTime = Date.now();

                log(`Processing job ${jobId}: ${profileUrl} [${cycleJobCount + 1}/${RECYCLE_EVERY_N_JOBS} in cycle, ${getMemoryMB()} MB]`);

                // Read daily stats for status
                let dailyCount = reservation?.dailyCount || 0;
                let dailyLimitVal = reservation?.dailyLimit || parseInt(process.env.DAILY_SCRAPE_LIMIT || DEFAULT_DAILY_SCRAPE_LIMIT, 10);
                try {
                    if (!dbWorker && fs.existsSync(LIMITS_FILE)) {
                        const ld = JSON.parse(fs.readFileSync(LIMITS_FILE, 'utf8'));
                        const today = new Date().toISOString().split('T')[0];
                        if (ld.date === today) dailyCount = ld.count;
                    }
                } catch {}

                writeStatus('processing', {
                    jobId, url: profileUrl, totalJobsProcessed, cycleJobCount,
                    sessionStartedAt, dailyCount, dailyLimit: dailyLimitVal,
                    dailyQualified, dailyRejected, dailyReview, dailyNurture, dailyErrors,
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
                if(isShuttingDown){inFlightJobs.delete(jobFile);break;}

                let result;
                const checksBefore={...sessionChecks};
                if(job.prospecting&&!signedInIdentity){
                    const reason='LinkedIn viewer identity could not be confirmed. Sign in on the worker computer before prospecting.';
                    await prospectingStore.pauseAccount(dbWorker.pool,ACCOUNT_ID,reason);
                    await dbWorker.core.defer(dbWorker.pool,jobId,dbWorker.owner,{status:'ERROR',failure:{stage:'linkedin',code:'LINKEDIN_AUTH',reason,retryable:false}},new Date().toISOString());
                    writeStatus('paused',{reason,manualResumeRequired:linkedinStop?.code!=='WORKER_PAUSED'});await shutdown('Prospecting needs account identity confirmation.',1);return;
                }
                if(job.resumeCapture) {
                    result=await scrapeProfile(page,profileUrl,browser,captured=>dbWorker.core.checkpoint(dbWorker.pool,jobId,dbWorker.owner,captured),job.resumeResult);
                } else if(job.resumeResult) {
                    await recordLinkedInCheck('cache');
                    result=structuredClone(job.resumeResult);result.status='PENDING';
                    result.logs=['Resuming saved LinkedIn profile; no new LinkedIn scrape or daily slot used.'];
                    if(result.failure?.code==='AI_SIZE')result.compactAI=true;
                    if(job.activityOnly&&result.activityStatus==='Unknown'&&result.profileIdentityConfirmed){
                        try{
                            const activity=await require('./src/lib/linkedin-activity-page.cjs').checkSavedActivity(browser,result.url,{page,beforeCheck:recordLinkedInCheck,checkResponse:checkLinkedInAccess});
                            if(activity){Object.assign(result,activity);result.logs.push('Saved profile activity recovery: '+activity.activityStatus+' — '+activity.activityEvidence.reason);if(dbWorker)await dbWorker.core.checkpoint(dbWorker.pool,jobId,dbWorker.owner,result);}
                            else result.logs.push('Saved profile activity recovery: no confirmed feed or observed activity route.');
                        }catch(error){if(error.failure&&['LINKEDIN_AUTH','LINKEDIN_RATE_LIMIT'].includes(error.failure.code))linkedinStop=error.failure;result.logs.push('Saved profile activity recovery could not finish: '+error.message);}
                    }
                } else if (pageAlive) {
                    try {
                        prospectingFailure=null;prospectingContext=Boolean(job.prospecting);
                        result = await scrapeProfile(page, profileUrl, browser, dbWorker ? captured=>dbWorker.core.checkpoint(dbWorker.pool,jobId,dbWorker.owner,captured) : undefined);
                    } catch (e) {
                        log(`⚠️ scrapeProfile threw: ${e.message}`);
                        result = { url: profileUrl, firstName: '', headline: '', activityStatus: 'Unknown', emails: [], websites: [], website: '', status: 'ERROR', failure:e.failure||prospectingFailure||undefined, logs: [`Fatal: ${e.message}`] };
                    } finally {prospectingContext=false;}
                } else {
                    result = { url: profileUrl, firstName: '', headline: '', activityStatus: 'Unknown', emails: [], websites: [], website: '', status: 'ERROR', logs: ['Browser page crashed before scrape'] };
                }
                result.linkedinChecks=Object.fromEntries(Object.entries(sessionChecks).filter(([kind])=>kind!=='cache').map(([kind,count])=>[kind,count-(checksBefore[kind]||0)]));
                result.linkedinCacheHit=Boolean(job.resumeResult&&!job.resumeCapture);
                if(linkedinStop){result.status='ERROR';result.failure=linkedinStop;}
                if(result.status==='ERROR') {
                    result.failure=result.failure||failureOf(result);
                    if(linkedinStop||['LINKEDIN_AUTH','LINKEDIN_RATE_LIMIT'].includes(result.failure.code)){
                        linkedinStop=result.failure;
                        if(dbWorker){
                            await prospectingStore.pauseAccount(dbWorker.pool,ACCOUNT_ID,result.failure.reason);
                            await dbWorker.core.defer(dbWorker.pool,jobId,dbWorker.owner,result,new Date().toISOString());
                        }
                        writeStatus('paused',{reason:result.failure.reason,manualResumeRequired:linkedinStop?.code!=='WORKER_PAUSED'});await shutdown('LinkedIn needs account review.',1);return;
                    }
                    needsRecycle=true;
                } else if(dbWorker&&!job.resumeResult) {
                    await dbWorker.core.checkpoint(dbWorker.pool,jobId,dbWorker.owner,result);
                }

                // The LinkedIn half of the job is finished here. Everything that
                // remains — business research, contact attribution and CRM persistence —
                // needs no LinkedIn session, so it runs in the background while this
                // loop immediately claims the next profile. LinkedIn time is the
                // scarce, rate-limited resource; nothing else should consume it.
                const linkedinDurationMs = Date.now() - jobStartTime;
                totalJobsProcessed++;
                cycleJobCount++;
                // Retain the job through research and persistence so a restart can resume it.

                const finishJob = (async () => {
                    if(job.prospecting){
                        try{result=await prospectingWorker.finish(dbWorker.pool,dbWorker.owner,job,result);}
                        catch(error){result={...result,status:'ERROR',failure:{stage:'research',code:'PROSPECT_RESEARCH',reason:'Prospect research could not finish. The captured profile is retained for an explicit retry.',retryable:false},logs:[...(result.logs||[]),'Prospect research stopped: '+error.message]};}
                    } else if (result.status !== 'ERROR') {
                        try {
                            result = await enrichAndFinalize(result, browser, job.retryCount || 0);
                        } catch (e) {
                            log(`⚠️ Enrichment threw for ${jobId}: ${e.message}`);
                            if (result.status === 'PENDING') result.status = 'ERROR';
                        }
                    }

                    const jobDuration = Date.now() - jobStartTime;
                    lastJobDurationMs = jobDuration;
                    jobDurations.push(jobDuration);
                    if (jobDurations.length > 50) jobDurations.shift(); // rolling window of 50

                    if (job.nativePostProcess) {
                        await nativePostProcess(job, result, log)
                            .catch(err => { result.crmSaved = false; log(`  [Research] Save error: ${err.message}`); });
                    }
                    if(result.status==='ERROR'&&dbWorker&&!job.prospecting) {
                        result.failure=result.failure||failureOf(result);
                        if(result.failure.stage!=='linkedin' && result.failure.retryable && job.retryCount < 3) {
                            const retryAt=result.failure.retryAt||new Date(Date.now()+(result.failure.stage==='linkedin'?15000:60000)).toISOString();
                            result.failure.retryAt=retryAt;
                            if (result.failure.stage !== 'linkedin') await dbWorker.core.checkpoint(dbWorker.pool,jobId,dbWorker.owner,result);
                            await dbWorker.core.defer(dbWorker.pool,jobId,dbWorker.owner,result,retryAt);
                            log(`Recovery scheduled for ${jobId}: ${result.failure.reason}`);
                            return;
                        }
                        if (result.failure.retryable) {
                            result.failure.retryable = false;
                            delete result.failure.retryAt;
                            result.failure.reason = 'Automatic retries exhausted; the saved profile is retained for manual retry. ' + result.failure.reason;
                        }
                    }
                    if (result.status === 'QUALIFIED') dailyQualified++;
                    else if (result.status === 'ERROR') dailyErrors++;
                    else if (result.status === 'REJECTED') dailyRejected++;
                    else if (result.status === 'NURTURE') dailyNurture++;
                    else dailyReview++;

                    if (dbWorker) {
                        result.accountId = ACCOUNT_ID;
                        await dbWorker.core.complete(dbWorker.pool, jobId, dbWorker.owner, result);
                    }
                    fs.writeFileSync(
                        path.join(RESULTS_DIR, `${jobId}.json`),
                        JSON.stringify({ status: 'done', result, completedAt: new Date().toISOString() })
                    );
                    if (!dbWorker) { try { fs.unlinkSync(jobPath); } catch { } }

                    if (job.webhookUrl) {
                        await fireWebhook(job.webhookUrl, { jobId, status: 'done', result, completedAt: new Date().toISOString() });
                    }

                    log(`✅ Job ${jobId} done → ${result.status} | ${result.firstName} | Emails: ${result.emails.length} | ${Math.round(jobDuration / 1000)}s total, ${Math.round(linkedinDurationMs / 1000)}s on LinkedIn (Total: ${totalJobsProcessed}, Mem: ${getMemoryMB()} MB)`);
                })();

                const tracked = finishJob
                    .catch(err => log(`❌ Job ${jobId} post-scrape stage failed: ${err.message}`))
                    .finally(() => {
                        inFlightJobs.delete(jobFile);
                        const idx = pendingPostProcessing.indexOf(tracked);
                        if (idx >= 0) pendingPostProcessing.splice(idx, 1);
                    });
                pendingPostProcessing.push(tracked);

                // Cap how many leads sit mid-enrichment at once, so a run of slow
                // websites can't pile up unbounded work behind a fast scrape loop.
                while (pendingPostProcessing.length >= ENRICH_CONCURRENCY) {
                    await Promise.race(pendingPostProcessing);
                }

                writeStatus('ready', {
                    totalJobsProcessed, cycleJobCount, lastJob: jobId, memoryMB: getMemoryMB(),
                    sessionStartedAt, dailyCount, dailyLimit: dailyLimitVal,
                    dailyQualified, dailyRejected, dailyReview, dailyNurture, dailyErrors,
                    lastJobDurationMs, avgJobDurationMs: jobDurations.length > 0 ? Math.round(jobDurations.reduce((a,b) => a+b, 0) / jobDurations.length) : 0,
                    pendingPostProcessing: pendingPostProcessing.length
                });

                // Check if we need to recycle the browser
                if (!pageAlive || cycleJobCount >= RECYCLE_EVERY_N_JOBS) {
                    needsRecycle = true;
                    log(`🔄 Browser recycle triggered (${!pageAlive ? 'page crashed' : `${cycleJobCount} jobs reached`}). Pausing account...`);
                }

                // Reuse the same account tab. The next job follows normal profile
                // pages; no feed reload or private endpoint fallback is required.

                // Delay between profiles
                await jitter(700, 1600);

            } catch (e) {
                log(`Error in poll loop: ${e.message}`);
                await sleep(5000);
            }
        }

        // Wait for any pending post-processing to finish before stopping.
        // Enrichment tasks may still be using this browser for a rendered crawl,
        // so they must all settle before it is killed.
        if (pendingPostProcessing.length > 0) {
            log(`⏳ Waiting for ${pendingPostProcessing.length} background enrichment tasks to finish...`);
            await Promise.allSettled(pendingPostProcessing);
            pendingPostProcessing.length = 0;
            log(`✅ All background tasks complete.`);
        }

        // Close the old browser before starting a new one — use proper Windows process killing
        log(`Closing account browser... (processed ${cycleJobCount} jobs this cycle)`);
        await killBrowserProcess(browser, browserPid);
        browser = null;
        browserPid = null;

        // Force garbage collection if available
        if (global.gc) {
            global.gc();
            log(`GC forced. Memory after: ${getMemoryMB()} MB`);
        }

        if (!isShuttingDown) {
            const reason='The worker browser stopped or reached its cycle limit. Start processing explicitly to continue.';
            writeStatus('paused',{reason});await shutdown(reason,1);return;
        }
    }
}

main().catch(async e => {
    if(linkedinStop)writeStatus('paused',{reason:linkedinStop.reason,manualResumeRequired:['LINKEDIN_AUTH','LINKEDIN_RATE_LIMIT'].includes(linkedinStop.code)});
    else console.error('Fatal:',e.message);
    await shutdown(linkedinStop?'Account processing stopped':'Fatal error',1);
}).finally(async()=>{if(shutdownTask)await shutdownTask;await stopDatabaseAccount();});
