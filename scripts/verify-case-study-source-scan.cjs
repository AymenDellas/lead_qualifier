const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// Execute the real worker functions with simulated LinkedIn pages and a capped
// duplicate-check service. Never start a browser or write to the user's queue.
const worker = fs.readFileSync(path.join(__dirname, '..', 'case-study-worker.cjs'), 'utf8');
function extract(start, end) {
    const from = worker.indexOf(start);
    const to = worker.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `Worker function boundaries missing: ${start}`);
    return worker.slice(from, to);
}
const workerFunctions = [
    extract('function canonicalLinkedIn(', 'function sourceUrl('),
    extract('function sourceUrl(', 'function enqueueProfile('),
    extract('async function removePipelineDuplicates(', 'async function advanceSourceList('),
    extract('async function scanSource(', 'async function voyagerFetch('),
].join('\n');
const profile = (n) => `https://www.linkedin.com/in/scan-test-${n}/`;
const profiles = (count, start = 0) => Array.from({ length: count }, (_, n) => profile(n + start));
const key = (url) => url.toLowerCase().replace(/\/+$/, '');

function harness(options = {}) {
    const source = options.source || profiles(140);
    const existing = new Set((options.existing || []).map(key));
    const initial = options.initial || source.slice(0, 20);
    const queued = [], checks = [], indices = [], logs = [], diagnostics = [], listeners = new Set();
    let cancelled = false;
    let pageIndex = 0;
    class JobCancelledError extends Error { constructor() { super('Stopped'); this.name = 'JobCancelledError'; } }
    const throwIfCancelled = () => { if (cancelled) throw new JobCancelledError(); };
    const context = vm.createContext({
        URL, AbortSignal, process: { env: {} }, path, RESULTS_DIR: '/unused',
        MAX_SOURCE_SCAN_PROFILES: 150, JobCancelledError, throwIfCancelled,
        setPhase: (phase, message) => logs.push({ phase, message }),
        log: (message, phase) => logs.push({ phase, message }),
        cancellableSleep: async () => throwIfCancelled(),
        safeLinkedInHeaders: (headers) => headers,
        atomicJson: (_file, value) => diagnostics.push(value),
        enqueueProfile: (url) => { queued.push(url); return true; },
        linkedInPage: {
            on: (_name, handler) => listeners.add(handler),
            off: (_name, handler) => listeners.delete(handler),
            goto: async () => {},
            $$eval: async () => options.visiblePages ? options.visiblePages[pageIndex] : initial,
            evaluate: async () => ({ url: 'https://www.linkedin.com/test-source/' }),
            screenshot: async () => {},
        },
        fetchConnectionBatch: async (index) => {
            throwIfCancelled();
            indices.push(index);
            if (options.onPage) options.onPage(index, () => { cancelled = true; });
            const urls = options.repeatLastPage ? initial : source.slice(index, index + 10);
            return { status: 200, slugs: urls.map((url) => new URL(url).pathname.split('/')[2]) };
        },
        advanceSourceList: async () => {
            const before = pageIndex;
            pageIndex = Math.min(pageIndex + 1, (options.visiblePages?.length || 1) - 1);
            return { moved: before !== pageIndex, clickedLoadMore: false };
        },
        fetch: async (_url, request) => {
            const { urls } = JSON.parse(request.body);
            checks.push(urls);
            if (options.onCheck) {
                const override = options.onCheck(urls, checks.length, () => { cancelled = true; });
                if (override) return override;
            }
            if (urls.length < 1 || urls.length > 100) return response(400, { error: 'Send from 1 to 100 LinkedIn profile URLs.' });
            return response(200, {
                existingUrls: urls.filter((url) => existing.has(key(url))),
                newUrls: urls.filter((url) => !existing.has(key(url))),
            });
        },
    });
    vm.runInContext(workerFunctions, context);
    return {
        queued, checks, indices, logs, diagnostics, listeners,
        cancel: () => { cancelled = true; },
        check: (urls) => context.removePipelineDuplicates(urls),
        scan: (limit = 120, sourceType = 'CONNECTION') => context.scanSource({ source: sourceType, limit, mode: 'CASE_STUDY', sourcePageUrl: 'https://www.linkedin.com/posts/test-post' }),
    };
}
function response(status, body) { return { status, ok: status >= 200 && status < 300, json: async () => body }; }

for (const count of [100, 120, 150]) {
    test(`duplicate checks support ${count} profiles within the API's 100-URL limit`, async () => {
        const h = harness({ existing: profiles(20) });
        const result = await h.check(profiles(count));
        assert.equal(result.existingUrls.length, 20);
        assert.equal(result.newUrls.length, count - 20);
        assert.deepEqual(h.checks.map((batch) => batch.length), count > 100 ? [100, count - 100] : [count]);
    });
}

test('120 requested plus 20 pipeline duplicates queues 120 new profiles from 140 connections', async () => {
    const h = harness({ existing: profiles(20) });
    const result = await h.scan();
    assert.equal(result.queued, 120);
    assert.equal(result.skipped, 20);
    assert.equal(result.discovered, 140);
    assert.deepEqual(h.queued, profiles(120, 20));
    assert.deepEqual(h.indices, Array.from({ length: 12 }, (_, i) => 20 + i * 10));
    assert.match(h.logs.at(-1).message, /120\/120 new.*20 already/);
    assert.equal(h.listeners.size, 0);
});

test('150 target stays exact when the initial rendered page contains over 100 profiles', async () => {
    const h = harness({ source: profiles(180), initial: profiles(160), existing: profiles(20) });
    const result = await h.scan(150);
    assert.equal(result.queued, 150);
    assert.equal(result.discovered, 170);
    assert.deepEqual(h.queued, profiles(150, 20));
    assert.deepEqual(h.indices, [160]);
    assert.ok(h.checks.every((batch) => batch.length <= 100));
});

test('repeated anchors and URL case/query variants are only checked and queued once', async () => {
    const h = harness({ initial: [profile(0), profile(0).toUpperCase(), `${profile(0)}?trk=test`, profile(1), profile(2), 'https://www.linkedin.com/feed/'], existing: [profile(0)] });
    const result = await h.scan(2);
    assert.equal(result.discovered, 3);
    assert.equal(result.skipped, 1);
    assert.deepEqual(h.queued, [profile(1), profile(2)]);
    assert.equal(h.checks.flat().length, 3);
    assert.equal(h.indices.length, 0);
});

test('exhausted source queues only the available new profiles and reports the shortfall', async () => {
    const h = harness({ source: profiles(45), existing: profiles(20) });
    const result = await h.scan();
    assert.equal(result.queued, 25);
    assert.equal(result.skipped, 20);
    assert.deepEqual(h.queued, profiles(25, 20));
    assert.equal(h.diagnostics[0].collected, 25);
    assert.match(h.logs.at(-1).message, /25\/120 new/);
});

test('an entirely duplicated source reaches the end without queuing anyone', async () => {
    const h = harness({ source: profiles(40), existing: profiles(40) });
    const result = await h.scan(10);
    assert.equal(result.queued, 0);
    assert.equal(result.skipped, 40);
    assert.deepEqual(h.indices, [20, 30, 40]);
});

test('repeated connection pages terminate without duplicate jobs', async () => {
    const h = harness({ repeatLastPage: true });
    const result = await h.scan();
    assert.equal(result.queued, 20);
    assert.equal(h.indices.length, 3);
    assert.equal(h.checks.length, 1);
    assert.match(h.logs.map((entry) => entry.message).join('\n'), /same connections for 3 consecutive pages/);
});

for (const sourceType of ['FOLLOWER', 'PROFILE_VIEWER', 'ENGAGER']) {
    test(`${sourceType} continues past duplicate-only pages until new profiles are found`, async () => {
        const visiblePages = Array.from({ length: 36 }, (_, page) => profiles(10, page * 10));
        visiblePages.push(profiles(2, 360));
        const h = harness({ visiblePages, existing: profiles(360) });
        const result = await h.scan(2, sourceType);
        assert.equal(result.queued, 2);
        assert.equal(result.skipped, 360);
        assert.deepEqual(h.queued, profiles(2, 360));
    });
}

test('stalled scrolling sources stop and preserve the smaller new set', async () => {
    const h = harness({ visiblePages: [profiles(10), profiles(20)], existing: profiles(10) });
    const result = await h.scan(120, 'FOLLOWER');
    assert.equal(result.queued, 10);
    assert.equal(result.skipped, 10);
    assert.equal(h.checks.length, 2);
});

test('a failed later duplicate check queues nothing, even after finding new candidates', async () => {
    const h = harness({ onCheck: (_urls, call) => call >= 2 ? response(503, { error: 'Database unavailable' }) : undefined });
    await assert.rejects(h.scan(), /duplicate check failed.*503/);
    assert.equal(h.checks.length, 4);
    assert.equal(h.queued.length, 0);
    assert.equal(h.listeners.size, 0);
});

test('a transient duplicate-check failure recovers without rechecking successful batches', async () => {
    const h = harness({ onCheck: (_urls, call) => call === 2 ? response(503, { error: 'Temporary outage' }) : undefined });
    const result = await h.check(profiles(150));
    assert.equal(result.newUrls.length, 150);
    assert.deepEqual(h.checks.map((batch) => batch.length), [100, 50, 50]);
});

test('invalid duplicate-check responses cannot silently drop or queue unchecked profiles', async () => {
    const h = harness({ onCheck: () => response(200, { existingUrls: [], newUrls: [] }) });
    await assert.rejects(h.scan(), /incomplete or invalid duplicate-check response/);
    assert.equal(h.checks.length, 3);
    assert.equal(h.queued.length, 0);
});

test('HTTP 400 is not retried with the same invalid request', async () => {
    const h = harness({ onCheck: () => response(400, { error: 'Bad request' }) });
    await assert.rejects(h.scan(), /400/);
    assert.equal(h.checks.length, 1);
    assert.equal(h.queued.length, 0);
});

test('stop during a duplicate check cancels immediately without queuing or retrying', async () => {
    const h = harness({ onCheck: (_urls, _call, cancel) => { cancel(); } });
    await assert.rejects(h.scan(), { name: 'JobCancelledError' });
    assert.equal(h.checks.length, 1);
    assert.equal(h.queued.length, 0);
    assert.equal(h.listeners.size, 0);
});

test('stop during pagination queues none of the profiles collected so far', async () => {
    const h = harness({ onPage: (_index, cancel) => cancel() });
    await assert.rejects(h.scan(), { name: 'JobCancelledError' });
    assert.equal(h.checks.length, 1);
    assert.equal(h.queued.length, 0);
});
