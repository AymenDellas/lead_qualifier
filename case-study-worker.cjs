'use strict';
// Retired legacy launcher: do not bypass PostgreSQL leases or AdsPower bindings.
if(require.main===module){console.error('The standalone Case Study worker is retired. Use the CompelOS AliasMode agent.');process.exitCode=1;}
module.exports={};
// LEGACY CHROME REFERENCE — inactive; retained at the user’s request.
// /**
//  * Compel Case Study Hunter worker.
//  *
//  * This process is intentionally separate from worker.cjs. It only discovers
//  * warm LinkedIn profiles, qualifies their headline, finds their public website,
//  * and saves a Case Study Hunter record for manual outreach.
//  */
// const fs = require('node:fs');
// const path = require('node:path');
// const puppeteerExtra = require('puppeteer-extra');
// const StealthPlugin = require('puppeteer-extra-plugin-stealth');
// const {
//     DEFAULT_TARGET_TITLES,
//     extractContactWebsites,
//     extractFeaturedWebsites,
//     extractSummaryWebsites,
//     normalizeTitles,
//     normalizeWebsiteCandidate,
//     qualifyHeadline,
// } = require('./case-study-worker-core.cjs');
//
// puppeteerExtra.use(StealthPlugin());
//
// const ROOT = __dirname;
// const PROFILE_DIR = path.join(ROOT, '.browser-profiles-case-study', 'account-0');
// const QUEUE_DIR = path.join(ROOT, 'case-study-queue');
// const RESULTS_DIR = path.join(ROOT, 'case-study-results');
// const FAILED_DIR = path.join(RESULTS_DIR, 'failed-pushes');
// const STATUS_FILE = path.join(RESULTS_DIR, 'worker-status.json');
// const LOG_FILE = path.join(RESULTS_DIR, 'worker-log.jsonl');
// const DATA_DIR = path.join(ROOT, 'data');
// const LIMITS_FILE = path.join(DATA_DIR, 'case-study-worker-limits.json');
// const PID_FILE = path.join(DATA_DIR, 'case-study-worker.pid');
// const CONTROL_FILE = path.join(DATA_DIR, 'case-study-worker-control.json');
// const SOURCE_SCAN_LOCK = path.join(QUEUE_DIR, '.source-scan.lock');
// const POLL_MS = 2000;
// const HEARTBEAT_MS = 15000;
// const RECYCLE_AFTER = 25;
// const RECENT_LOG_LIMIT = 120;
// const MAX_SOURCE_SCAN_PROFILES = 150;
//
// for (const directory of [PROFILE_DIR, QUEUE_DIR, RESULTS_DIR, FAILED_DIR, DATA_DIR]) {
//     fs.mkdirSync(directory, { recursive: true });
// }
//
// function loadEnv() {
//     const envPath = path.join(ROOT, '.env.local');
//     if (!fs.existsSync(envPath)) throw new Error('.env.local not found');
//     for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
//         const match = line.replace(/\r/g, '').match(/^([^#=]+)=(.*)$/);
//         if (!match || process.env[match[1].trim()] !== undefined) continue;
//         process.env[match[1].trim()] = match[2].trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
//     }
// }
//
// loadEnv();
//
// const DAILY_LIMIT = Math.max(1, Number.parseInt(process.env.CASE_STUDY_DAILY_SCRAPE_LIMIT || '150', 10));
// const PROFILE_DELAY_MIN_MS = Math.max(1000, Number.parseInt(process.env.CASE_STUDY_PROFILE_DELAY_MIN_MS || '12000', 10));
// const PROFILE_DELAY_MAX_MS = Math.max(PROFILE_DELAY_MIN_MS, Number.parseInt(process.env.CASE_STUDY_PROFILE_DELAY_MAX_MS || '25000', 10));
// const ENV_TARGET_TITLES = normalizeTitles(process.env.CASE_STUDY_JOB_TITLES || DEFAULT_TARGET_TITLES);
//
// let browser = null;
// let linkedInPage = null;
// let stopping = false;
// let activeJob = '';
// let activeJobType = '';
// let cancelRequested = false;
// let clearedByStop = 0;
// let processedInCycle = 0;
// let heartbeat = null;
// let lockOwned = false;
// let state = { status: 'STARTING', phase: 'STARTING', message: 'Starting Case Study worker', currentProfile: '' };
// const recentLogs = [];
//
// const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// const jitter = (min, max) => sleep(min + Math.floor(Math.random() * Math.max(1, max - min + 1)));
//
// class JobCancelledError extends Error {
//     constructor() {
//         super('The current Case Study run was stopped by the operator.');
//         this.name = 'JobCancelledError';
//     }
// }
//
// function atomicJson(file, data) {
//     const temp = `${file}.${process.pid}.tmp`;
//     fs.writeFileSync(temp, JSON.stringify(data, null, 2));
//     fs.renameSync(temp, file);
// }
//
// function todayKey() {
//     return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Casablanca' }).format(new Date());
// }
//
// function readUsage() {
//     try {
//         const value = JSON.parse(fs.readFileSync(LIMITS_FILE, 'utf8'));
//         return value.date === todayKey() ? value : { date: todayKey(), count: 0 };
//     } catch {
//         return { date: todayKey(), count: 0 };
//     }
// }
//
// function queueSize() {
//     try { return fs.readdirSync(QUEUE_DIR).filter((file) => file.endsWith('.json')).length; }
//     catch { return 0; }
// }
//
// function writeStatus(extra = {}) {
//     const usage = readUsage();
//     const payload = {
//         ...state,
//         ...extra,
//         pid: process.pid,
//         activeJob,
//         activeJobType,
//         queueSize: queueSize(),
//         dailyCount: usage.count,
//         dailyLimit: DAILY_LIMIT,
//         recentLogs,
//         updatedAt: new Date().toISOString(),
//     };
//     // Status is telemetry, never a reason to fail a prospect. OneDrive can
//     // briefly lock the destination during rename; match the original worker's
//     // non-fatal direct-write fallback in that case.
//     try {
//         atomicJson(STATUS_FILE, payload);
//     } catch {
//         try { fs.writeFileSync(STATUS_FILE, JSON.stringify(payload, null, 2)); } catch { /* next heartbeat retries */ }
//     }
// }
//
// function consumeStopRequest() {
//     if (!fs.existsSync(CONTROL_FILE)) return false;
//     try {
//         const control = JSON.parse(fs.readFileSync(CONTROL_FILE, 'utf8'));
//         fs.unlinkSync(CONTROL_FILE);
//         if (control.action !== 'STOP_CURRENT_RUN') return false;
//         cancelRequested = true;
//         clearedByStop = 0;
//         for (const name of fs.readdirSync(QUEUE_DIR)) {
//             if (!name.endsWith('.json')) continue;
//             try {
//                 fs.unlinkSync(path.join(QUEUE_DIR, name));
//                 clearedByStop += 1;
//             } catch { /* a claimed job is handled by the active cancellation path */ }
//         }
//         releaseSourceScanLock();
//         return true;
//     } catch {
//         try { fs.unlinkSync(CONTROL_FILE); } catch { /* already removed */ }
//         return false;
//     }
// }
//
// function throwIfCancelled() {
//     consumeStopRequest();
//     if (cancelRequested) throw new JobCancelledError();
// }
//
// async function cancellableSleep(ms) {
//     const deadline = Date.now() + ms;
//     while (Date.now() < deadline) {
//         throwIfCancelled();
//         await sleep(Math.min(500, deadline - Date.now()));
//     }
//     throwIfCancelled();
// }
//
// async function idleSleep(ms) {
//     const deadline = Date.now() + ms;
//     while (Date.now() < deadline) {
//         if (consumeStopRequest()) return true;
//         await sleep(Math.min(500, deadline - Date.now()));
//     }
//     return false;
// }
//
// function releaseSourceScanLock() {
//     try { fs.unlinkSync(SOURCE_SCAN_LOCK); } catch { /* already released */ }
// }
//
// function setPhase(phase, message, extra = {}) {
//     state = {
//         ...state,
//         status: ['IDLE', 'DAILY_LIMIT', 'WAITING_FOR_LOGIN', 'STOPPED', 'FATAL'].includes(phase) ? phase : 'WORKING',
//         phase,
//         message,
//         ...extra,
//     };
//     writeStatus();
// }
//
// function log(message, phase = state.phase) {
//     const entry = { at: new Date().toISOString(), phase, message: String(message) };
//     recentLogs.push(entry);
//     if (recentLogs.length > RECENT_LOG_LIMIT) recentLogs.shift();
//     fs.appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`);
//     console.log(`[CaseStudy] ${new Date().toLocaleTimeString()} — ${message}`);
//     state = { ...state, phase, message: String(message) };
//     writeStatus();
// }
//
// function processAlive(pid) {
//     if (!Number.isInteger(pid) || pid <= 0) return false;
//     try { process.kill(pid, 0); return true; } catch { return false; }
// }
//
// function acquireLock() {
//     if (fs.existsSync(PID_FILE)) {
//         const existing = Number.parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10);
//         if (existing !== process.pid && processAlive(existing)) {
//             throw new Error(`Case Study worker is already running with PID ${existing}.`);
//         }
//     }
//     fs.writeFileSync(PID_FILE, String(process.pid));
//     lockOwned = true;
// }
//
// function releaseLock() {
//     if (!lockOwned) return;
//     try {
//         if (fs.existsSync(PID_FILE) && Number.parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10) === process.pid) {
//             fs.unlinkSync(PID_FILE);
//         }
//         lockOwned = false;
//     } catch { /* shutdown best effort */ }
// }
//
// function reserveDailyProfile() {
//     const usage = readUsage();
//     if (usage.count >= DAILY_LIMIT) return false;
//     usage.count += 1;
//     atomicJson(LIMITS_FILE, usage);
//     return true;
// }
//
// function claimNextJob(preferSource = false) {
//     const names = fs.readdirSync(QUEUE_DIR).filter((file) => file.endsWith('.json')).sort();
//     if (preferSource) names.sort((a, b) => {
//         const isSource = (name) => {
//             try { return JSON.parse(fs.readFileSync(path.join(QUEUE_DIR, name), 'utf8')).type === 'SOURCE_SCAN' ? 0 : 1; }
//             catch { return 1; }
//         };
//         return isSource(a) - isSource(b) || a.localeCompare(b);
//     });
//     for (const name of names) {
//         const source = path.join(QUEUE_DIR, name);
//         const claimed = path.join(QUEUE_DIR, `${name}.${process.pid}.processing`);
//         try {
//             fs.renameSync(source, claimed);
//             return { path: claimed, job: JSON.parse(fs.readFileSync(claimed, 'utf8')) };
//         } catch { /* another process or incomplete write */ }
//     }
//     return null;
// }
//
// function completeJob(claimed) {
//     try { fs.unlinkSync(claimed.path); } catch { /* already gone */ }
// }
//
// function restoreJob(claimed) {
//     try {
//         const original = claimed.path.replace(/\.\d+\.processing$/, '');
//         fs.renameSync(claimed.path, original);
//     } catch { /* leave processing file for manual recovery */ }
// }
//
// function canonicalLinkedIn(value) {
//     try {
//         const url = new URL(value, 'https://www.linkedin.com');
//         const slug = url.pathname.match(/^\/in\/([^/?#]+)/i)?.[1];
//         return slug ? `https://www.linkedin.com/in/${slug}/` : '';
//     } catch { return ''; }
// }
//
// function sourceUrl(source, suppliedUrl) {
//     if (source === 'CONNECTION') return 'https://www.linkedin.com/mynetwork/invite-connect/connections/';
//     if (source === 'FOLLOWER') return 'https://www.linkedin.com/mynetwork/network-manager/people-follow/followers/';
//     if (source === 'PROFILE_VIEWER') return 'https://www.linkedin.com/me/profile-views/';
//     if (source === 'ENGAGER') return suppliedUrl || '';
//     return '';
// }
//
// function enqueueProfile(profileUrl, parent) {
//     const url = canonicalLinkedIn(profileUrl);
//     if (!url) return false;
//     const slug = new URL(url).pathname.split('/').filter(Boolean).at(-1);
//     const jobId = `${Date.now()}-${slug}-${Math.random().toString(36).slice(2, 7)}`;
//     atomicJson(path.join(QUEUE_DIR, `${jobId}.json`), {
//         jobId,
//         type: 'PROFILE',
//         linkedinUrl: url,
//         source: parent.source,
//         mode: parent.mode,
//         warmthEvidence: parent.warmthEvidence,
//         targetTitles: normalizeTitles(parent.targetTitles || ENV_TARGET_TITLES),
//         createdAt: new Date().toISOString(),
//     });
//     return true;
// }
//
// function connectionPaginationPayload(startIndex) {
//     const requestedStateKeys = [{ key: { value: { $case: 'id', id: 'connectionsListSortOption' } }, namespace: 'connectionsListSortOptionMenu' }];
//     const payload = { startIndex, sortByOptionBinding: { key: 'connectionsListSortOption', namespace: 'connectionsListSortOptionMenu' } };
//     const requestMetadata = { $type: 'proto.sdui.common.RequestMetadata' };
//     return {
//         pagerId: 'com.linkedin.sdui.pagers.mynetwork.connectionsList',
//         clientArguments: {
//             $type: 'proto.sdui.actions.requests.RequestedArguments',
//             requestedStateKeys,
//             payload,
//             requestMetadata,
//             states: [{
//                 key: 'connectionsListSortOption',
//                 namespace: 'connectionsListSortOptionMenu',
//                 value: 'sortByRecentlyAdded',
//                 originalProtoCase: 'stringValue',
//                 protoKey: { $type: 'proto.sdui.Key', value: { $case: 'id', id: 'connectionsListSortOption' } },
//             }],
//             screenId: 'com.linkedin.sdui.flagshipnav.mynetwork.Connections',
//             knownTemplateIds: [],
//         },
//         paginationRequest: {
//             $type: 'proto.sdui.actions.requests.PaginationRequest',
//             pagerId: 'com.linkedin.sdui.pagers.mynetwork.connectionsList',
//             trigger: {
//                 $case: 'itemDistanceTrigger',
//                 itemDistanceTrigger: { $type: 'proto.sdui.actions.requests.ItemDistanceTrigger', preloadDistance: 3, preloadLength: 250 },
//             },
//             retryCount: 2,
//             requestedArguments: { $type: 'proto.sdui.actions.requests.RequestedArguments', requestedStateKeys, payload, requestMetadata },
//         },
//     };
// }
//
// function safeLinkedInHeaders(headers = {}) {
//     return Object.fromEntries(Object.entries(headers)
//         .filter(([name]) => name === 'content-type' || name === 'csrf-token' || name.startsWith('x-li-')));
// }
//
// async function fetchConnectionBatch(startIndex, capturedHeaders) {
//     throwIfCancelled();
//     return linkedInPage.evaluate(async ({ postData, headers }) => {
//         try {
//             const csrf = document.cookie.match(/JSESSIONID="?([^";]+)"?/)?.[1] || '';
//             const response = await fetch('/flagship-web/rsc-action/actions/pagination?sduiid=com.linkedin.sdui.pagers.mynetwork.connectionsList', {
//                 method: 'POST',
//                 credentials: 'include',
//                 headers: { ...headers, 'content-type': 'application/json', 'csrf-token': csrf, 'x-li-rsc-stream': 'true' },
//                 body: postData,
//             });
//             const body = await response.text();
//             const slugs = [...new Set([...body.matchAll(/ConnectionCard_\d+-([A-Za-z0-9_-]+)/g)].map((match) => match[1]))];
//             return { status: response.status, slugs, bodyLength: body.length };
//         } catch (error) {
//             return { status: 0, slugs: [], bodyLength: 0, error: error.message };
//         }
//     }, { postData: JSON.stringify(connectionPaginationPayload(startIndex)), headers: safeLinkedInHeaders(capturedHeaders) });
// }
//
// async function removePipelineDuplicates(urls) {
//     if (!urls.length) return { existingUrls: [], newUrls: [] };
//     setPhase('CHECKING_DUPLICATES', `Comparing ${urls.length} LinkedIn profile URL(s) with the prospect pipeline`);
//     const endpoint = `${process.env.APP_URL || 'http://localhost:3000'}/api/case-study/duplicate-check`;
//     const result = { existingUrls: [], newUrls: [] };
//     const key = (url) => String(url).toLowerCase().replace(/\/+$/, '');
//     // The endpoint accepts 100 URLs per request, independently of the scan target.
//     for (let offset = 0; offset < urls.length; offset += 100) {
//         const batch = urls.slice(offset, offset + 100);
//         let checked = null;
//         let lastError = '';
//         for (let attempt = 1; attempt <= 3; attempt += 1) {
//             throwIfCancelled();
//             let retryable = true;
//             try {
//                 const response = await fetch(endpoint, {
//                     method: 'POST',
//                     headers: { 'content-type': 'application/json' },
//                     body: JSON.stringify({ urls: batch }),
//                     signal: AbortSignal.timeout(30000),
//                 });
//                 const body = await response.json().catch(() => ({}));
//                 throwIfCancelled();
//                 if (response.ok && Array.isArray(body.newUrls) && Array.isArray(body.existingUrls)) {
//                     const existing = new Set(body.existingUrls.map(key));
//                     const fresh = new Set(body.newUrls.map(key));
//                     const requested = new Set(batch.map(key));
//                     const classified = new Set([...existing, ...fresh]);
//                     if (classified.size === requested.size && [...classified].every((url) => requested.has(url)) &&
//                         ![...existing].some((url) => fresh.has(url))) {
//                         checked = {
//                             existingUrls: batch.filter((url) => existing.has(key(url))),
//                             newUrls: batch.filter((url) => fresh.has(key(url))),
//                         };
//                         break;
//                     }
//                 }
//                 lastError = `HTTP ${response.status}: ${String(body.error || 'incomplete or invalid duplicate-check response')}`;
//                 retryable = response.status < 400 || response.status >= 500 || [408, 429].includes(response.status);
//             } catch (error) {
//                 if (error instanceof JobCancelledError) throw error;
//                 lastError = error.message;
//             }
//             log(`Duplicate check attempt ${attempt}/3 failed for profiles ${offset + 1}-${offset + batch.length}: ${lastError}`, 'CHECKING_DUPLICATES');
//             if (!retryable) break;
//             if (attempt < 3) await cancellableSleep(attempt * 1000);
//         }
//         if (!checked) throw new Error(`Prospect pipeline duplicate check failed, so no profiles were queued: ${lastError}`);
//         result.existingUrls.push(...checked.existingUrls);
//         result.newUrls.push(...checked.newUrls);
//     }
//     return result;
// }
//
// async function advanceSourceList(stagnantPasses) {
//     const before = await linkedInPage.evaluate(() => {
//         const container = document.querySelector('main#workspace, main');
//         return {
//             top: container?.scrollTop || window.scrollY,
//             height: container?.scrollHeight || document.documentElement.scrollHeight,
//             links: document.querySelectorAll('a[href*="/in/"]').length,
//         };
//     });
//
//     await linkedInPage.evaluate((stagnant) => {
//         const container = document.querySelector('main#workspace, main');
//         if (!container) return;
//         const delta = 420 + Math.floor(Math.random() * 180);
//         container.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: delta }));
//         container.scrollBy({ top: delta, behavior: 'smooth' });
//         container.dispatchEvent(new Event('scroll', { bubbles: true }));
//         if (stagnant >= 2) {
//             const links = [...container.querySelectorAll('a[href*="/in/"]')];
//             links.at(-1)?.scrollIntoView({ block: 'end', inline: 'nearest' });
//             container.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 900 }));
//             container.dispatchEvent(new Event('scrollend', { bubbles: true }));
//         }
//     }, stagnantPasses);
//     await cancellableSleep(1700 + Math.floor(Math.random() * 700));
//
//     const clickedLoadMore = await linkedInPage.evaluate(() => {
//         const button = [...document.querySelectorAll('button')].find((candidate) => {
//             const text = `${candidate.textContent || ''} ${candidate.getAttribute('aria-label') || ''}`.trim();
//             const rect = candidate.getBoundingClientRect();
//             return /(?:load|show|see) more/i.test(text) && rect.width > 0 && rect.height > 0 && !candidate.disabled;
//         });
//         if (button) button.click();
//         return Boolean(button);
//     });
//     if (clickedLoadMore) await cancellableSleep(1500);
//
//     const after = await linkedInPage.evaluate(() => {
//         const container = document.querySelector('main#workspace, main');
//         return {
//             top: container?.scrollTop || window.scrollY,
//             height: container?.scrollHeight || document.documentElement.scrollHeight,
//             links: document.querySelectorAll('a[href*="/in/"]').length,
//         };
//     });
//     return {
//         moved: after.top !== before.top || after.height !== before.height || after.links !== before.links,
//         clickedLoadMore,
//     };
// }
//
// async function scanSource(job) {
//     const sourceRequests = [];
//     const captureRequest = (request) => {
//         const resourceType = request.resourceType();
//         const url = request.url();
//         if (['xhr', 'fetch'].includes(resourceType) && /linkedin\.com/i.test(url)) {
//             const requestHeaders = request.headers();
//             sourceRequests.push({
//                 resourceType,
//                 method: request.method(),
//                 url,
//                 postData: /rsc-action\/actions\/pagination/i.test(url) ? request.postData() : undefined,
//                 headers: /flagship-web\/rsc-action/i.test(url) ? safeLinkedInHeaders(requestHeaders) : undefined,
//             });
//             if (sourceRequests.length > 200) sourceRequests.shift();
//         }
//     };
//     linkedInPage.on('request', captureRequest);
//     try {
//     const target = sourceUrl(job.source, job.sourcePageUrl);
//     if (!target) throw new Error('This source scan has no valid LinkedIn page URL.');
//     const limit = Number(job.limit ?? 25);
//     if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SOURCE_SCAN_PROFILES) {
//         throw new Error(`Source scan limit must be a whole number between 1 and ${MAX_SOURCE_SCAN_PROFILES}.`);
//     }
//     setPhase('SCANNING_SOURCE', `Opening ${job.source.toLowerCase().replaceAll('_', ' ')} source`, { currentProfile: '' });
//     throwIfCancelled();
//     await linkedInPage.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
//     await cancellableSleep(2500);
//     const found = new Set();
//     const newProfiles = [];
//     let skipped = 0;
//     let stagnantPasses = 0;
//     const scanLabel = { CONNECTION: 'Connections', FOLLOWER: 'Followers', PROFILE_VIEWER: 'Profile viewers', ENGAGER: 'Engagers' }[job.source] || 'Source';
//     const profileKey = (url) => url.toLowerCase().replace(/\/+$/, '');
//     const reportProgress = () => log(`${scanLabel} scan collected ${newProfiles.length}/${limit} new profile(s); ${skipped} already in the prospect pipeline, ${found.size} unique profile(s) checked.`, 'SCANNING_SOURCE');
//     const collectProfiles = async (urls) => {
//         const candidates = new Map();
//         for (const url of urls) {
//             const canonical = canonicalLinkedIn(url);
//             if (canonical && !found.has(profileKey(canonical))) candidates.set(profileKey(canonical), canonical);
//         }
//         const fresh = [...candidates.values()];
//         // Check only unseen URLs. Pipeline duplicates consume no slots in the target.
//         let offset = 0;
//         while (offset < fresh.length && newProfiles.length < limit) {
//             throwIfCancelled();
//             const batch = fresh.slice(offset, offset + Math.min(100, limit - newProfiles.length));
//             const checked = await removePipelineDuplicates(batch);
//             const existing = new Set(checked.existingUrls.map(profileKey));
//             for (const url of batch) {
//                 found.add(profileKey(url));
//                 if (existing.has(profileKey(url))) skipped += 1;
//                 else newProfiles.push(url);
//             }
//             offset += batch.length;
//             reportProgress();
//         }
//     };
//     const initialUrls = await linkedInPage.$$eval('a[href*="/in/"]', (anchors) => anchors.map((anchor) => anchor.href));
//     await collectProfiles(initialUrls);
//     if (!found.size) reportProgress();
//
//     if (job.source === 'CONNECTION' && newProfiles.length < limit) {
//         const headerSource = sourceRequests.find((request) => /flagship-web\/rsc-action/i.test(request.url) && request.headers);
//         // Pagination follows source positions, never the number of non-duplicates.
//         let startIndex = new Set(initialUrls.map(canonicalLinkedIn).filter(Boolean).map(profileKey)).size;
//         let repeatedBatches = 0;
//         while (newProfiles.length < limit) {
//             throwIfCancelled();
//             setPhase('SCANNING_SOURCE', `Loading LinkedIn connections ${startIndex + 1}-${startIndex + 10} (${newProfiles.length}/${limit} new profiles collected)`);
//             const batch = await fetchConnectionBatch(startIndex, headerSource?.headers);
//             if (batch.status !== 200) {
//                 throw new Error(`LinkedIn connection pagination failed with HTTP ${batch.status || 0}${batch.error ? `: ${batch.error}` : ''}.`);
//             }
//             if (!batch.slugs.length) {
//                 log(`LinkedIn returned no additional connections after index ${startIndex}; the end of the available list was reached.`, 'SCANNING_SOURCE');
//                 break;
//             }
//             const before = found.size;
//             await collectProfiles(batch.slugs.map((slug) => `/in/${slug}/`));
//             repeatedBatches = found.size === before ? repeatedBatches + 1 : 0;
//             if (repeatedBatches >= 3) {
//                 log(`LinkedIn returned the same connections for 3 consecutive pages; stopping at ${newProfiles.length}/${limit} new profile(s).`, 'SCANNING_SOURCE');
//                 break;
//             }
//             startIndex += Math.max(10, batch.slugs.length);
//             if (newProfiles.length < limit) await cancellableSleep(650 + Math.floor(Math.random() * 500));
//         }
//     }
//     if (job.source !== 'CONNECTION') {
//     while (newProfiles.length < limit && stagnantPasses < 6) {
//         throwIfCancelled();
//         const before = found.size;
//         const movement = await advanceSourceList(stagnantPasses);
//         const urls = await linkedInPage.$$eval('a[href*="/in/"]', (anchors) => anchors.map((a) => a.href));
//         await collectProfiles(urls);
//         if (newProfiles.length >= limit) break;
//         stagnantPasses = found.size === before ? stagnantPasses + 1 : 0;
//         if (!movement.moved && !movement.clickedLoadMore && stagnantPasses >= 4) {
//             setPhase('SCANNING_SOURCE', `Waiting for LinkedIn to load more profiles (${newProfiles.length}/${limit} new)`);
//         }
//     }
//     }
//     if (newProfiles.length < limit) {
//         const diagnostic = await linkedInPage.evaluate(() => ({
//             url: location.href,
//             title: document.title,
//             documentScroll: {
//                 y: window.scrollY,
//                 viewport: window.innerHeight,
//                 height: document.documentElement.scrollHeight,
//             },
//             mainTextTail: (document.querySelector('main#workspace, main')?.textContent || '').trim().replace(/\s+/g, ' ').slice(-1200),
//             linkedinResources: performance.getEntriesByType('resource')
//                 .map((entry) => entry.name)
//                 .filter((url) => /linkedin\.com\/(?:voyager\/api|graphql)/i.test(url))
//                 .slice(-80),
//             profileLinks: [...document.querySelectorAll('a[href*="/in/"]')].slice(0, 15).map((anchor) => ({
//                 href: anchor.href,
//                 text: (anchor.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120),
//             })),
//             buttons: [...document.querySelectorAll('button')].map((button) => ({
//                 text: (button.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 100),
//                 label: button.getAttribute('aria-label') || '',
//                 disabled: button.disabled,
//             })).filter((button) => button.text || button.label).slice(-30),
//             scrollables: [...document.querySelectorAll('main, section, div, ul')].filter((element) => {
//                 const style = getComputedStyle(element);
//                 return element.scrollHeight > element.clientHeight + 40 || /(auto|scroll)/.test(style.overflowY);
//             }).map((element) => ({
//                 tag: element.tagName,
//                 id: element.id,
//                 className: String(element.className || '').slice(0, 160),
//                 role: element.getAttribute('role') || '',
//                 ariaLabel: element.getAttribute('aria-label') || '',
//                 scrollTop: element.scrollTop,
//                 clientHeight: element.clientHeight,
//                 scrollHeight: element.scrollHeight,
//                 profileLinks: element.querySelectorAll('a[href*="/in/"]').length,
//             })).sort((left, right) => right.profileLinks - left.profileLinks || right.scrollHeight - left.scrollHeight).slice(0, 25),
//         }));
//         atomicJson(path.join(RESULTS_DIR, 'source-scan-last-diagnostic.json'), {
//             capturedAt: new Date().toISOString(),
//             requested: limit,
//             collected: newProfiles.length,
//             discovered: found.size,
//             skipped,
//             diagnostic: { ...diagnostic, sourceRequests },
//         });
//         await linkedInPage.screenshot({ path: path.join(RESULTS_DIR, 'source-scan-last-diagnostic.png'), fullPage: false }).catch(() => {});
//         log(`Source list stopped at ${newProfiles.length}/${limit} new profile(s), with ${skipped} pipeline duplicate(s) skipped. Diagnostic captured for ${diagnostic.url}.`, 'SCANNING_SOURCE');
//     }
//     throwIfCancelled();
//     let queued = 0;
//     for (const url of newProfiles) {
//         throwIfCancelled();
//         queued += enqueueProfile(url, job) ? 1 : 0;
//     }
//     log(`Source scan queued ${queued}/${limit} new profile(s); ${skipped} already in the prospect pipeline, ${found.size} unique profile(s) checked.`, 'CHECKING_DUPLICATES');
//     return { status: 'SOURCE_SCANNED', discovered: found.size, skipped, queued };
//     } finally {
//         linkedInPage.off('request', captureRequest);
//     }
// }
//
// async function voyagerFetch(apiPath) {
//     return linkedInPage.evaluate(async (requestPath) => {
//         try {
//             const csrf = document.cookie.match(/JSESSIONID="?([^";]+)"?/)?.[1] || '';
//             const response = await fetch(`https://www.linkedin.com${requestPath}`, {
//                 credentials: 'include',
//                 headers: {
//                     accept: 'application/vnd.linkedin.normalized+json+2.1',
//                     'csrf-token': csrf,
//                     'x-li-lang': 'en_US',
//                     'x-restli-protocol-version': '2.0.0',
//                 },
//                 signal: AbortSignal.timeout(15000),
//             });
//             return { status: response.status, data: response.ok ? await response.json() : null };
//         } catch (error) {
//             return { status: 0, error: error.message };
//         }
//     }, apiPath);
// }
//
// function profileFields(payload, slug) {
//     const included = Array.isArray(payload?.included) ? payload.included : [];
//     const candidates = [...included, payload?.data, payload].filter(Boolean);
//     const matched = candidates.find((item) => item.publicIdentifier === slug || item.vanityName === slug) ||
//         candidates.find((item) => item.firstName && (item.headline || item.lastName)) || {};
//     return {
//         firstName: String(matched.firstName || ''),
//         lastName: String(matched.lastName || ''),
//         headline: String(matched.headline || ''),
//         location: String(matched.geoLocationName || matched.locationName || matched.geoLocation?.geo?.defaultLocalizedName || ''),
//     };
// }
//
// async function readProfile(linkedinUrl) {
//     throwIfCancelled();
//     const slug = new URL(linkedinUrl).pathname.split('/').filter(Boolean).at(-1);
//     setPhase('READING_PROFILE', `Reading LinkedIn profile ${slug}`, { currentProfile: linkedinUrl });
//     await linkedInPage.goto(linkedinUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
//     await cancellableSleep(1800);
//     let response = await voyagerFetch(`/voyager/api/identity/profiles/${slug}/profileView`);
//     if (response.status !== 200) {
//         throwIfCancelled();
//         response = await voyagerFetch(`/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(slug)}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-101`);
//     }
//     const fields = response.status === 200 ? profileFields(response.data, slug) : { firstName: '', lastName: '', headline: '', location: '' };
//     if (!fields.headline || !fields.firstName) {
//         const dom = await linkedInPage.evaluate(() => {
//             const pick = (...selectors) => {
//                 for (const selector of selectors) {
//                     const text = document.querySelector(selector)?.textContent?.trim();
//                     if (text) return text;
//                 }
//                 return '';
//             };
//             const name = pick('main h1', 'h1');
//             return {
//                 name,
//                 headline: pick('main .text-body-medium', '[data-generated-suggestion-target] + div'),
//                 location: pick('main .text-body-small.inline', 'main span.text-body-small'),
//             };
//         });
//         if (!fields.firstName && dom.name) {
//             const parts = dom.name.split(/\s+/);
//             fields.firstName = parts.shift() || '';
//             fields.lastName = parts.join(' ');
//         }
//         fields.headline ||= dom.headline;
//         fields.location ||= dom.location;
//     }
//     return { ...fields, slug, profilePayload: response.data || {} };
// }
//
// async function findWebsite(profile) {
//     throwIfCancelled();
//     setPhase('FINDING_WEBSITE', `Finding a public website for ${profile.firstName || profile.slug}`);
//     let contact = await voyagerFetch(`/voyager/api/identity/profiles/${profile.slug}/profileContactInfo`);
//     if (contact.status !== 200) {
//         await cancellableSleep(1000);
//         contact = await voyagerFetch(`/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(profile.slug)}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.ProfileContactInfo-14`);
//     }
//     const contactWebsites = contact.status === 200 ? extractContactWebsites(contact.data) : [];
//     if (contactWebsites.length) {
//         log(`Found website in LinkedIn contact info: ${contactWebsites[0]}`, 'FINDING_WEBSITE');
//         return contactWebsites[0];
//     }
//
//     const aboutWebsites = extractSummaryWebsites(profile.profilePayload);
//     if (aboutWebsites.length) {
//         log(`Found website in the LinkedIn About section: ${aboutWebsites[0]}`, 'FINDING_WEBSITE');
//         return aboutWebsites[0];
//     }
//
//     const featured = await voyagerFetch(`/voyager/api/identity/profiles/${profile.slug}/featuredContent`);
//     throwIfCancelled();
//     const featuredWebsites = featured.status === 200 ? extractFeaturedWebsites(featured.data) : [];
//     if (featuredWebsites.length) {
//         log(`Found website in LinkedIn Featured content: ${featuredWebsites[0]}`, 'FINDING_WEBSITE');
//         return featuredWebsites[0];
//     }
//
//     // Match the original worker's final fallback: conservative personal-domain
//     // guesses are accepted only when DNS resolves and the site returns real HTML.
//     const firstName = String(profile.firstName || '').toLowerCase().replace(/[^a-z]/g, '');
//     const lastName = String(profile.lastName || '').toLowerCase().replace(/[^a-z]/g, '');
//     const domainGuesses = [];
//     if (firstName && lastName) domainGuesses.push(`${firstName}${lastName}.com`, `${firstName}-${lastName}.com`);
//     if (firstName) domainGuesses.push(`${firstName}coaching.com`, `coach${firstName}.com`, `the${firstName}.com`);
//     const dns = require('node:dns').promises;
//     for (const domain of domainGuesses) {
//         throwIfCancelled();
//         try {
//             await dns.resolve(domain);
//             const candidate = `https://${domain}`;
//             const response = await fetchHtml(candidate, 6000);
//             if (response.html.length > 500) {
//                 log(`Found verified personal-domain fallback: ${response.url}`, 'FINDING_WEBSITE');
//                 return normalizeWebsiteCandidate(response.url) || candidate;
//             }
//         } catch { /* this conservative guess did not resolve to a usable website */ }
//     }
//
//     log('No public website was found in LinkedIn contact info, About, Featured, or verified personal-domain fallbacks.', 'FINDING_WEBSITE');
//     return '';
// }
//
// async function fetchHtml(url, timeout = 18000) {
//     throwIfCancelled();
//     const response = await fetch(url, {
//         redirect: 'follow',
//         headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36' },
//         signal: AbortSignal.timeout(timeout),
//     });
//     if (!response.ok) throw new Error(`HTTP ${response.status}`);
//     const contentType = response.headers.get('content-type') || '';
//     if (contentType && !/(?:text\/html|application\/xhtml\+xml)/i.test(contentType)) {
//         throw new Error(`Non-HTML response (${contentType.split(';')[0]})`);
//     }
//     const advertisedSize = Number(response.headers.get('content-length') || 0);
//     if (advertisedSize > 5 * 1024 * 1024) throw new Error('Response too large');
//     const reader = response.body?.getReader();
//     if (!reader) return { url: response.url, html: '', status: response.status };
//     const decoder = new TextDecoder();
//     let html = '';
//     let bytes = 0;
//     while (true) {
//         throwIfCancelled();
//         const { done, value } = await reader.read();
//         if (done) break;
//         bytes += value.byteLength;
//         if (bytes > 5 * 1024 * 1024) {
//             await reader.cancel();
//             throw new Error('Response too large');
//         }
//         html += decoder.decode(value, { stream: true });
//     }
//     html += decoder.decode();
//     return { url: response.url, html, status: response.status };
// }
//
// function profileAssessment(reason, qualification, websiteScan) {
//     return {
//         coachFit: qualification.qualified ? 'YES' : 'NO',
//         scores: { icpFit: 0, warmth: 0, funnelWeakness: 0, commercialPotential: 0, total: 0 },
//         headlineQualification: qualification,
//         websiteScan,
//         observations: [],
//         whyContact: reason,
//         mainWeakness: '',
//         outreachAngle: '',
//         suggestedDm: '',
//         recommendedNextAction: qualification.qualified ? 'Find and verify the public website' : 'Keep out of the active queue',
//     };
// }
//
// async function processProfile(job) {
//     throwIfCancelled();
//     const profile = await readProfile(job.linkedinUrl);
//     throwIfCancelled();
//     setPhase('QUALIFYING_HEADLINE', `Checking headline: ${profile.headline || 'No headline found'}`, { currentProfile: job.linkedinUrl });
//     const qualification = qualifyHeadline(profile.headline, job.targetTitles || ENV_TARGET_TITLES);
//     log(qualification.reason, 'QUALIFYING_HEADLINE');
//     const base = { url: job.linkedinUrl, ...profile, websites: [], website: '', primaryEmail: '' };
//     delete base.profilePayload;
//     delete base.slug;
//     if (!qualification.qualified) {
//         return {
//             ...base,
//             status: 'REJECTED_HEADLINE',
//             caseStudy: profileAssessment(qualification.reason, qualification, {
//                 method: 'NOT_RUN', pages: [], challenge: '', completedAt: new Date().toISOString(),
//             }),
//         };
//     }
//
//     const website = await findWebsite(profile);
//     throwIfCancelled();
//     const nextAction = website ? 'Review the profile and website, then write your LinkedIn DM' : 'Find the public website or review the LinkedIn profile before outreach';
//     return {
//         ...base,
//         website,
//         websites: website ? [website] : [],
//         status: 'QUALIFIED',
//         caseStudy: {
//             ...profileAssessment(qualification.reason, qualification, {
//                 method: website ? 'FOUND' : 'NOT_FOUND', pages: [], challenge: '', completedAt: new Date().toISOString(),
//             }),
//             recommendedNextAction: nextAction,
//         },
//     };
// }
//
// async function saveResult(job, result) {
//     throwIfCancelled();
//     setPhase('SAVING_RESULT', `Saving ${result.status.toLowerCase().replaceAll('_', ' ')} result`);
//     atomicJson(path.join(RESULTS_DIR, `${job.jobId}.json`), { job, result, completedAt: new Date().toISOString() });
//     const endpoint = `${process.env.APP_URL || 'http://localhost:3000'}/api/case-study/worker-result`;
//     let lastError = '';
//     for (let attempt = 1; attempt <= 3; attempt += 1) {
//         throwIfCancelled();
//         try {
//             const response = await fetch(endpoint, {
//                 method: 'POST',
//                 headers: { 'content-type': 'application/json' },
//                 body: JSON.stringify({ job, result }),
//                 signal: AbortSignal.timeout(30000),
//             });
//             if (response.ok) {
//                 log('Case Study record saved.', 'SAVING_RESULT');
//                 return;
//             }
//             lastError = `HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`;
//         } catch (error) { lastError = error.message; }
//         log(`Save attempt ${attempt}/3 failed: ${lastError}`, 'SAVING_RESULT');
//         if (attempt < 3) await cancellableSleep(attempt * 1500);
//     }
//     atomicJson(path.join(FAILED_DIR, `${job.jobId}.json`), { job, result, endpoint, error: lastError, savedAt: new Date().toISOString() });
//     throw new Error(`Could not save the Case Study record: ${lastError}`);
// }
//
// async function launchBrowser(headless) {
//     return puppeteerExtra.launch({
//         headless,
//         protocolTimeout: 90000,
//         userDataDir: PROFILE_DIR,
//         defaultViewport: null,
//         args: [
//             '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
//             '--disable-background-networking', '--disable-default-apps', '--disable-sync', '--no-first-run',
//         ],
//         env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99' },
//     });
// }
//
// async function launchBrowserWithRetry(headless) {
//     let lastError;
//     for (let attempt = 1; attempt <= 3; attempt += 1) {
//         try {
//             return await launchBrowser(headless);
//         } catch (error) {
//             lastError = error;
//             log(`Browser startup attempt ${attempt}/3 failed: ${error.message}`, 'STARTING');
//             if (attempt < 3) await sleep(attempt * 4000);
//         }
//     }
//     throw lastError || new Error('Browser startup failed.');
// }
//
// function accounts() {
//     const parsed = JSON.parse(process.env.LINKEDIN_ACCOUNTS || '[]');
//     if (!Array.isArray(parsed) || !parsed[0]?.email || !parsed[0]?.password) throw new Error('LINKEDIN_ACCOUNTS is not configured.');
//     return parsed;
// }
//
// async function checkLogin(page, allowCredentials = true) {
//     setPhase('CHECKING_LINKEDIN_LOGIN', 'Checking the isolated LinkedIn session');
//     await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 45000 });
//     await sleep(2500);
//     if (/linkedin\.com\/feed/i.test(page.url())) return true;
//     if (!allowCredentials) return false;
//     const account = accounts()[0];
//     await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
//     const userSelector = (await page.$('#username')) ? '#username' : '#session_key';
//     const passSelector = (await page.$('#password')) ? '#password' : '#session_password';
//     if (!(await page.$(userSelector)) || !(await page.$(passSelector))) return false;
//     await page.type(userSelector, account.email, { delay: 90 });
//     await page.type(passSelector, account.password, { delay: 90 });
//     await page.click('button[type="submit"]');
//     await sleep(5000);
//     return /linkedin\.com\/feed/i.test(page.url());
// }
//
// async function openCleanLinkedInPage() {
//     // browser.pages() attaches to every restored tab. A large saved Chrome
//     // session can time out before the worker gets a chance to close them.
//     const session = await browser.target().createCDPSession();
//     let closed = 0;
//     try {
//         const { targetInfos } = await session.send('Target.getTargets');
//         for (const target of targetInfos.filter((value) => value.type === 'page')) {
//             try {
//                 const result = await session.send('Target.closeTarget', { targetId: target.targetId });
//                 if (result.success) closed += 1;
//             } catch (error) {
//                 log(`Could not close a restored browser tab: ${error.message}`, 'STARTING');
//             }
//         }
//     } finally {
//         await session.detach().catch(() => {});
//     }
//     if (closed > 1) log(`Closed ${closed} restored browser tabs from earlier sessions.`, 'STARTING');
//     const page = await browser.newPage();
//     await page.setViewport({ width: 1366, height: 850 });
//     return page;
// }
//
// async function openLoggedInBrowser() {
//     browser = await launchBrowserWithRetry(true);
//     linkedInPage = await openCleanLinkedInPage();
//     if (await checkLogin(linkedInPage)) {
//         log('LinkedIn session is ready.', 'CHECKING_LINKEDIN_LOGIN');
//         return;
//     }
//     await browser.close().catch(() => {});
//     browser = await launchBrowserWithRetry(false);
//     linkedInPage = await openCleanLinkedInPage();
//     const automatic = await checkLogin(linkedInPage);
//     if (automatic) {
//         log('LinkedIn session is ready in the visible browser.', 'CHECKING_LINKEDIN_LOGIN');
//         return;
//     }
//     setPhase('WAITING_FOR_LOGIN', 'Complete the LinkedIn login or human check in the visible browser');
//     log('Waiting up to 10 minutes for manual LinkedIn login.', 'WAITING_FOR_LOGIN');
//     const deadline = Date.now() + 10 * 60 * 1000;
//     while (Date.now() < deadline && !stopping) {
//         await sleep(5000);
//         if (/linkedin\.com\/feed/i.test(linkedInPage.url())) {
//             log('Manual LinkedIn login detected.', 'CHECKING_LINKEDIN_LOGIN');
//             return;
//         }
//     }
//     throw new Error('LinkedIn login was not completed within 10 minutes.');
// }
//
// async function recycleBrowser() {
//     setPhase('RECYCLING_BROWSER', 'Recycling the browser after the completed batch');
//     if (browser) await browser.close().catch(() => {});
//     browser = null;
//     linkedInPage = null;
//     processedInCycle = 0;
//     await openLoggedInBrowser();
// }
//
// async function ensureBrowserHealthy() {
//     try {
//         if (!browser?.connected || !linkedInPage || linkedInPage.isClosed()) throw new Error('browser unavailable');
//         await linkedInPage.evaluate(() => true);
//     } catch {
//         await recycleBrowser();
//     }
// }
//
// async function shutdown(signal) {
//     if (stopping) return;
//     stopping = true;
//     if (heartbeat) clearInterval(heartbeat);
//     setPhase('STOPPED', `Stopping after ${signal}`);
//     if (browser) await browser.close().catch(() => {});
//     releaseLock();
// }
//
// async function main() {
//     acquireLock();
//     fs.writeFileSync(LOG_FILE, '');
//     heartbeat = setInterval(() => writeStatus(), HEARTBEAT_MS);
//     log('Purpose-built Case Study worker started. No messages, connections, likes, emails, or CRM lead work are automated.', 'STARTING');
//     await openLoggedInBrowser();
//     while (!stopping) {
//         if (consumeStopRequest() || cancelRequested) {
//             cancelRequested = false;
//             log(`Stop request handled. ${clearedByStop} pending job(s) cleared; the worker is ready for another run.`, 'IDLE');
//         }
//         await ensureBrowserHealthy();
//         const usage = readUsage();
//         const sourceWaiting = fs.readdirSync(QUEUE_DIR).some((name) => {
//             if (!name.endsWith('.json')) return false;
//             try { return JSON.parse(fs.readFileSync(path.join(QUEUE_DIR, name), 'utf8')).type === 'SOURCE_SCAN'; } catch { return false; }
//         });
//         if (usage.count >= DAILY_LIMIT && !sourceWaiting) {
//             setPhase('DAILY_LIMIT', `Daily profile limit reached (${usage.count}/${DAILY_LIMIT})`);
//             await idleSleep(30000);
//             continue;
//         }
//         const claimed = claimNextJob(usage.count >= DAILY_LIMIT);
//         if (!claimed) {
//             setPhase('IDLE', 'Waiting for Case Study Hunter jobs', { currentProfile: '' });
//             await idleSleep(POLL_MS);
//             continue;
//         }
//         const { job } = claimed;
//         cancelRequested = false;
//         activeJob = String(job.jobId || path.basename(claimed.path));
//         activeJobType = String(job.type || 'PROFILE');
//         let jobCancelled = false;
//         try {
//             let result;
//             if (job.type === 'SOURCE_SCAN') {
//                 result = await scanSource(job);
//                 atomicJson(path.join(RESULTS_DIR, `${job.jobId}.json`), { job, result, completedAt: new Date().toISOString() });
//             } else {
//                 if (!canonicalLinkedIn(job.linkedinUrl)) throw new Error('Job has no valid LinkedIn profile URL.');
//                 if (!reserveDailyProfile()) {
//                     restoreJob(claimed);
//                     setPhase('DAILY_LIMIT', `Daily profile limit reached (${DAILY_LIMIT}/${DAILY_LIMIT})`);
//                     activeJob = '';
//                     await sleep(30000);
//                     continue;
//                 }
//                 result = await processProfile(job);
//                 await saveResult(job, result);
//                 processedInCycle += 1;
//                 log(`${result.firstName || 'Prospect'} completed as ${result.status}.`, 'SAVING_RESULT');
//             }
//             completeJob(claimed);
//             state = {
//                 ...state,
//                 lastCompletedJobId: activeJob,
//                 lastCompletedJobType: activeJobType,
//                 lastCompletedAt: new Date().toISOString(),
//                 lastCompletionStatus: 'COMPLETED',
//                 lastSourceScanResult: job.type === 'SOURCE_SCAN' ? result : state.lastSourceScanResult,
//             };
//             writeStatus();
//         } catch (error) {
//             if (error instanceof JobCancelledError) {
//                 jobCancelled = true;
//                 completeJob(claimed);
//                 state = {
//                     ...state,
//                     lastCompletedJobId: activeJob,
//                     lastCompletedJobType: activeJobType,
//                     lastCompletedAt: new Date().toISOString(),
//                     lastCompletionStatus: 'CANCELLED',
//                 };
//                 log(`Current Case Study run stopped. ${clearedByStop} pending job(s) cleared; the worker remains ready.`, 'CANCELLED');
//             } else {
//                 log(`Job failed: ${error.stack || error.message}`, 'ERROR');
//             }
//             if (!(error instanceof JobCancelledError) && job.type !== 'SOURCE_SCAN' && job.linkedinUrl) {
//                 const result = {
//                     url: job.linkedinUrl,
//                     status: 'ERROR',
//                     caseStudy: profileAssessment(error.message, { qualified: false, matches: [], reason: 'Scan failed before qualification completed.' }, {
//                         method: 'ERROR', pages: [], challenge: '', completedAt: new Date().toISOString(), error: error.message,
//                     }),
//                 };
//                 try { await saveResult(job, result); completeJob(claimed); } catch { restoreJob(claimed); }
//             } else if (!(error instanceof JobCancelledError)) {
//                 atomicJson(path.join(RESULTS_DIR, `${job.jobId || Date.now()}.json`), { job, error: error.message, completedAt: new Date().toISOString() });
//                 completeJob(claimed);
//             }
//         } finally {
//             if (job.type === 'SOURCE_SCAN') releaseSourceScanLock();
//             activeJob = '';
//             activeJobType = '';
//             cancelRequested = false;
//             state.currentProfile = '';
//             writeStatus();
//         }
//         if (processedInCycle >= RECYCLE_AFTER) await recycleBrowser();
//         if (job.type !== 'SOURCE_SCAN' && !jobCancelled && !stopping) {
//             const waitMs = PROFILE_DELAY_MIN_MS + Math.floor(Math.random() * Math.max(1, PROFILE_DELAY_MAX_MS - PROFILE_DELAY_MIN_MS + 1));
//             setPhase('IDLE', `Cooling down for ${Math.ceil(waitMs / 1000)} seconds before the next profile`);
//             await idleSleep(waitMs);
//         }
//     }
// }
//
// process.on('SIGINT', () => shutdown('SIGINT').then(() => process.exit(0)));
// process.on('SIGTERM', () => shutdown('SIGTERM').then(() => process.exit(0)));
// process.on('exit', releaseLock);
//
// main().catch(async (error) => {
//     console.error(`[CaseStudy] Fatal — ${error.stack || error.message}`);
//     stopping = true;
//     if (heartbeat) clearInterval(heartbeat);
//     if (lockOwned) {
//         state = { ...state, status: 'FATAL', phase: 'FATAL', message: error.message };
//         try { writeStatus(); } catch { /* best effort */ }
//         if (browser) await browser.close().catch(() => {});
//         releaseLock();
//     }
//     process.exitCode = 1;
// });
//
