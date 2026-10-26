const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
require('tsx/cjs/api').register();
const { runDorkEngine, buildDiscoverySearchPlan, keptLeadTarget, queryBankSize, createSerperSearcher } = require('../src/lib/dorkEngine.ts');
const { createFinderProgressStore, finderRuntimeDirectory } = require('../src/lib/finder-progress.ts');

// Real engine and scoring; all search responses are simulated. No API credits or CRM writes.
const lead = (id, title = 'Executive Coach', location = 'Austin, Texas, United States') => ({
    link: `https://www.linkedin.com/in/finder-test-${id}/`,
    title: `Person ${id} - ${title} | LinkedIn`, snippet: `Location: ${location} · Experience: Independent practice`,
});
const config = (overrides = {}) => ({
    job_titles: ['Executive Coach'], locations: ['US'], kept_leads_target: 3,
    max_pages_per_dork: 1, min_fit_score: 20, ...overrides,
});
async function simulatedSearch(responder, run) {
    const originalFetch = global.fetch;
    const requests = [];
    global.fetch = async (_url, request) => {
        const payload = JSON.parse(request.body);
        requests.push(payload);
        const result = await responder(payload, requests.length, request.headers['X-API-KEY']);
        return { status: result.status ?? 200, json: async () => result.body ?? ({ organic: result.results ?? [] }) };
    };
    try { return await run(requests); } finally { global.fetch = originalFetch; }
}

test('3,000 means kept leads, and the engine continues after more than 3,000 scored', async () => {
    const writes = [], progress = [];
    await simulatedSearch((payload, page) => ({ results: Array.from({ length: 10 }, (_, rank) =>
        lead(`${page}-${rank}`, rank % 2 ? 'Executive Coach' : 'Software Engineer',payload.q.includes('Canada')?'Toronto, Ontario, Canada':'Austin, Texas, United States')) }), async requests => {
        const result = await runDorkEngine(config({
            job_titles: ['Executive Coach', 'Career Coach', 'Business Coach'], locations: ['US', 'Canada'],
            kept_leads_target: 3000,
        }), 'simulated-key', p => progress.push(p), l => { writes.push(l); });
        assert.equal(result.stats.kept, 3000);
        assert.equal(result.stats.scored, 6000,JSON.stringify(result.stats));
        assert.equal(result.stats.rejected, 3000);
        assert.equal(result.stats.stopReason, 'target_reached');
        assert.equal(result.stats.targetReached, true);
        assert.equal(result.leads.length, 3000);
        assert.equal(writes.length, 3000);
        assert.equal(new Set(writes.map(l => l.url)).size, 3000);
        assert.equal(requests.length, 600);
        assert.ok(progress.some(p => p.searchPhase === 'regional'));
        assert.equal(progress.at(-1).target, 3000);
        assert.equal(progress.at(-1).remaining, 0);
    });
});

test('stops exactly at the kept target inside a result page', async () => {
    const writes = [];
    await simulatedSearch(() => ({ results: Array.from({ length: 10 }, (_, i) => lead(i)) }), async requests => {
        const result = await runDorkEngine(config(), 'simulated-key', undefined, l => { writes.push(l); });
        assert.equal(result.stats.kept, 3);
        assert.equal(result.stats.scored, 3);
        assert.equal(writes.length, 3);
        assert.equal(requests.length, 1);
    });
});

test('duplicates and rejected profiles do not consume the kept target; regional reserve fills it', async () => {
    const writes = [];
    await simulatedSearch(payload => ({ results: payload.q.includes('"Alabama"')
        || payload.q.includes('"Ontario"') || /"(?:California|Texas|New York)"/.test(payload.q)
        ? [lead('existing'), lead('fresh')]
        : [lead('existing'), lead('rejected', 'Software Engineer')] }), async () => {
        const result = await runDorkEngine(config({ kept_leads_target: 2 }), 'simulated-key', undefined, l => { writes.push(l); });
        assert.equal(result.stats.kept, 2);
        assert.equal(result.stats.stopReason, 'target_reached');
        assert.equal(new Set(writes.map(l => l.url)).size, 2);
        assert.ok(result.stats.scored > 2);
        assert.ok(result.leads.some(l => l.templateId.startsWith('regional-')));
    });
});

test('country partitions retain requested titles, countries and original provenance location', () => {
    const plan = buildDiscoverySearchPlan(config({
        job_titles: ['Executive Coach', 'Career Coach', 'Business Coach'], locations: ['US', 'Canada'],
    }));
    const regional = plan.filter(q => q.searchPhase === 'regional');
    assert.equal(queryBankSize(), 35);
    assert.equal(plan.length, new Set(plan.map(q => q.query)).size);
    assert.ok(regional.some(q => q.searchArea === 'Ontario, CA' && q.location === 'Canada'));
    assert.ok(regional.some(q => q.searchArea === 'California, US' && q.location === 'US'));
    for (const q of regional) {
        assert.ok(q.query.includes(`"${q.niche}"`));
        assert.ok(q.location === 'Canada' ? q.query.includes('"Canada"') : q.query.includes('("United States" OR "USA" OR "US")'));
    }
    const firstRegion = plan.findIndex(q => q.searchPhase === 'regional');
    assert.ok(plan.slice(0, firstRegion).every(q => q.searchPhase === 'country'));
    assert.ok(plan.slice(firstRegion).every(q => q.searchPhase === 'regional'));
    assert.equal(buildDiscoverySearchPlan(config({ locations: ['US', 'USA', 'United States'] })).length,
        buildDiscoverySearchPlan(config()).length);
});

test('exhaustion reports a shortfall instead of claiming the kept target was met', async () => {
    await simulatedSearch(() => ({ results: [lead('only-profile')] }), async requests => {
        const result = await runDorkEngine(config({ locations: ['US'], kept_leads_target: 3000 }), 'simulated-key');
        assert.equal(result.stats.kept, 1);
        assert.equal(result.stats.targetReached, false);
        assert.equal(result.stats.stopReason, 'search_exhausted');
        assert.equal(result.stats.queriesCompleted, buildDiscoverySearchPlan(config()).length);
        assert.equal(requests.length, buildDiscoverySearchPlan(config()).length);
    });
});

test('the minimum score is preserved during all search phases', async () => {
    await simulatedSearch(() => ({ results: [lead('low-score')] }), async () => {
        const result = await runDorkEngine(config({ kept_leads_target: 1, min_fit_score: 100 }), 'simulated-key');
        assert.equal(result.stats.kept, 0);
        assert.ok(result.stats.belowFloor > 0);
        assert.equal(result.stats.stopReason, 'search_exhausted');
    });
});

test('four pages is a per-query limit, not a limit on the entire run', async () => {
    await simulatedSearch((_payload, count) => ({ results: [lead(count)] }), async requests => {
        const result = await runDorkEngine(config({ kept_leads_target: 5, max_pages_per_dork: 4 }), 'simulated-key');
        assert.equal(result.stats.kept, 5);
        assert.deepEqual(requests.map(r => r.page), [1, 2, 3, 4, 1]);
    });
});

test('manual stop preserves kept leads and skips remaining searches', async () => {
    let cancelled = false;
    await simulatedSearch(() => ({ results: Array.from({ length: 10 }, (_, i) => lead(i)) }), async requests => {
        const result = await runDorkEngine(config({ kept_leads_target: 3000 }), 'simulated-key', undefined,
            () => { cancelled = true; }, () => cancelled);
        assert.equal(result.stats.kept, 1);
        assert.equal(result.stats.stopReason, 'cancelled');
        assert.equal(result.stats.cancelled, true);
        assert.equal(requests.length, 1);
    });
});

test('search service failures are errors, not empty results or false exhaustion', async () => {
    await simulatedSearch(() => ({ status: 401 }), async requests => {
        await assert.rejects(runDorkEngine(config(), 'simulated-key'), /HTTP 401/);
        assert.equal(requests.length, 1);
    });
});

test('an exhausted key fails over and is skipped for every subsequent search page', async () => {
    const usedKeys = [];
    await simulatedSearch((_payload, _count, key) => {
        usedKeys.push(key);
        return key === 'exhausted-key' ? { status: 400, body: { message: 'Not enough credits' } } : { results: [lead('working')] };
    }, async () => {
        const search = createSerperSearcher(['exhausted-key', 'working-key']);
        assert.equal((await search('first query')).length, 1);
        assert.equal((await search('second query')).length, 1);
        assert.deepEqual(usedKeys, ['exhausted-key', 'working-key', 'working-key']);
    });
});

test('invalid and rate-limited keys try the next configured key without aborting the run', async () => {
    for (const status of [401, 403, 429, 503]) {
        await simulatedSearch((_payload, _count, key) => key === 'unavailable-key'
            ? { status, body: { message: 'Unavailable' } } : { results: [lead('working')] }, async requests => {
            const result = await runDorkEngine(config({ kept_leads_target: 1 }), ['unavailable-key', 'working-key']);
            assert.equal(result.stats.kept, 1);
            assert.equal(result.stats.stopReason, 'target_reached');
            assert.equal(requests.length, 2);
        });
    }
});

test('if every key is exhausted, report the actual credit failure once per key', async () => {
    await simulatedSearch(() => ({ status: 400, body: { message: 'Not enough credits' } }), async requests => {
        await assert.rejects(runDorkEngine(config(), ['empty-a', 'empty-b']), /All configured Serper API keys are unavailable.*Not enough credits/);
        assert.equal(requests.length, 2);
    });
});

test('a genuine malformed search request does not rotate through every key', async () => {
    await simulatedSearch(() => ({ status: 400, body: { message: 'Invalid query' } }), async requests => {
        await assert.rejects(runDorkEngine(config(), ['key-a', 'key-b']), /HTTP 400.*Invalid query/);
        assert.equal(requests.length, 1);
    });
});

test('network failure tries another key and secret values never enter errors', async () => {
    await simulatedSearch((_payload, _count, key) => {
        if (key === 'offline-key') throw new Error('Simulated network failure');
        return { results: [lead('working')] };
    }, async requests => {
        const result = await runDorkEngine(config({ kept_leads_target: 1 }), ['offline-key', 'working-key']);
        assert.equal(result.stats.kept, 1);
        assert.equal(requests.length, 2);
    });
    await simulatedSearch(() => ({ status: 401, body: { message: 'Invalid secret-test-key' } }), async () => {
        await assert.rejects(runDorkEngine(config(), ['secret-test-key']), error => !error.message.includes('secret-test-key') && error.message.includes('[redacted]'));
    });
});

test('Stop is honoured between key failover attempts', async () => {
    let cancelled = false;
    await simulatedSearch(() => { cancelled = true; return { status: 400, body: { message: 'Not enough credits' } }; }, async requests => {
        const result = await runDorkEngine(config(), ['exhausted-key', 'working-key'], undefined, undefined, () => cancelled);
        assert.equal(result.stats.stopReason, 'cancelled');
        assert.equal(result.stats.kept, 0);
        assert.equal(requests.length, 1);
    });
});

test('legacy target field is accepted and invalid targets fail clearly', () => {
    assert.equal(keptLeadTarget({ max_urls_target: 3000 }), 3000);
    assert.equal(keptLeadTarget({ max_urls_target: 10, kept_leads_target: 3000 }), 3000);
    for (const target of [0, -1, 2.5, NaN, Infinity, '3000'])
        assert.throws(() => keptLeadTarget({ kept_leads_target: target }), /positive whole number/);
});

function apiHarness({ failSave = false, progressFiles } = {}) {
    const taskDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'compel-finder-test-'));
    const writes = [];
    const progressStore = createFinderProgressStore({ directory: path.join(taskDirectory, 'runtime'),
        legacyDirectory: path.join(taskDirectory, 'queue-results'), fileSystem: progressFiles, retryDelays: [0, 0, 0] });
    const module = { exports: {} };
    const source = fs.readFileSync(path.join(__dirname, '../src/app/api/find-leads/route.ts'), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    vm.runInNewContext(compiled, {
        module, exports: module.exports, console, Error,
        process: { env: { SERPER_API_KEY_1: 'simulated-key' }, cwd: () => taskDirectory },
        require: name => name === '@/lib/dorkEngine' ? require('../src/lib/dorkEngine.ts')
            : name === '@/lib/discovery-score' ? require('../src/lib/discovery-score.ts')
            : name === '@/lib/discovery-location-evidence.cjs' ? require('../src/lib/discovery-location-evidence.cjs')
            : name === '@/lib/finder-progress' ? { createFinderProgressStore: () => progressStore }
            : name === '@/lib/db' ? { insertDiscoveryProvenance: async row => {
                if (failSave) throw new Error('Simulated database failure');
                writes.push(row);
            } } : require(name),
    }, { filename: 'find-leads-route-test.cjs' });
    return {
        writes,
        progressStore,
        post: body => module.exports.POST(new Request('http://localhost/api/find-leads', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        })),
        completed: async jobId => {
            // Full finite country expansion can exceed three seconds on an
            // 8 GB Windows machine while local browser fixtures are running.
            const deadline = Date.now() + 30000;
            while (Date.now() < deadline) {
                const data = await progressStore.read(jobId);
                if (data && data.status !== 'running') return data;
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            throw new Error('Simulated API job did not finish.');
        },
    };
}

test('API preserves the kept target and exports the complete kept set beyond the 50-row preview', async () => {
    const api = apiHarness();
    await simulatedSearch((_payload, count) => ({ results: Array.from({ length: 10 }, (_, i) => lead(`${count}-${i}`)) }), async requests => {
        const response = await api.post(config({ locations: ['US'], kept_leads_target: 70 }));
        assert.equal(response.status, 200);
        const launched = await response.json();
        assert.equal(launched.target, 70);
        const finished = await api.completed(launched.jobId);
        assert.equal(finished.status, 'done');
        assert.equal(finished.target, 70);
        assert.equal(finished.remaining, 0);
        assert.equal(finished.stopReason, 'target_reached');
        assert.equal(finished.queryIndex, 7);
        assert.equal(finished.results.length, 70);
        assert.equal(api.writes.length, 70);
        assert.equal(requests.length, 7);
    });
});

test('Windows Finder runtime is outside the synced workspace and isolated per project', () => {
    const project = path.join(os.tmpdir(), 'OneDrive', 'project-a');
    const appData = path.join(os.tmpdir(), 'LocalAppData');
    const directory = finderRuntimeDirectory(project, 'win32', appData);
    assert.ok(directory.startsWith(path.join(appData, 'Compel', 'lead-finder')));
    assert.equal(directory.startsWith(project), false);
    assert.notEqual(directory, finderRuntimeDirectory(path.join(os.tmpdir(), 'project-b'), 'win32', appData));
    assert.equal(finderRuntimeDirectory(project, 'linux'), path.join(project, 'queue-results'));
});

test('atomic progress saves retry temporary Windows locks without exposing partial JSON', async () => {
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'compel-finder-lock-'));
        const jobId = `find-${Date.now()}`;
        const file = path.join(directory, `${jobId}.json`);
        fs.writeFileSync(file, JSON.stringify({ status: 'running', found: 1 }));
        let attempts = 0;
        const store = createFinderProgressStore({ directory, legacyDirectory: directory, retryDelays: [0, 0, 0],
            fileSystem: { ...fs.promises, rename: async (source, target) => {
                attempts++;
                if (attempts < 4) {
                    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).found, 1);
                    throw Object.assign(new Error('Simulated file lock'), { code });
                }
                await fs.promises.rename(source, target);
            } },
        });
        await store.write(jobId, { status: 'running', found: 25 });
        assert.equal(attempts, 4);
        assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).found, 25);
        assert.equal((await store.read(jobId)).found, 25);
        assert.deepEqual(fs.readdirSync(directory).filter(name => name.endsWith('.tmp')), []);
    }
});

test('persistent progress-file locks cannot stop a run or lose its live terminal result', async () => {
    const api = apiHarness({ progressFiles: { ...fs.promises, rename: async () => {
        throw Object.assign(new Error('Simulated persistent file lock'), { code: 'EPERM' });
    } } });
    await simulatedSearch((_payload, count) => ({ results: Array.from({ length: 10 }, (_, i) => lead(`${count}-${i}`)) }), async requests => {
        const response = await api.post(config({ kept_leads_target: 25 }));
        assert.equal(response.status, 200);
        const launched = await response.json();
        const finished = await api.completed(launched.jobId);
        assert.equal(finished.status, 'done');
        assert.equal(finished.stopReason, 'target_reached');
        assert.equal(finished.found, 25);
        assert.equal(api.writes.length, 25);
        assert.equal(finished.results.length, 25);
        assert.match(finished.progressPersistenceWarning, /EPERM.*live progress and CRM saves continue/);
        assert.equal(requests.length, 3);
    });
});

test('polling another store instance sees live progress even when persistence and logging fail', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'compel-finder-cache-'));
    const jobId = `find-${Date.now()}`;
    const writer = createFinderProgressStore({ directory, legacyDirectory: directory, retryDelays: [],
        onPersistenceError: () => { throw new Error('Simulated logging failure'); },
        fileSystem: { ...fs.promises, rename: async () => { throw Object.assign(new Error('File lock'), { code: 'EPERM' }); } } });
    const reader = createFinderProgressStore({ directory, legacyDirectory: directory });
    await writer.write(jobId, { status: 'running', found: 208, target: 5000 });
    assert.equal((await reader.read(jobId)).found, 208);
    assert.equal((await reader.read(jobId)).status, 'running');
});

test('legacy progress remains readable and Stop reaches both old and new flag paths', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compel-finder-legacy-'));
    const directory = path.join(root, 'runtime');
    const legacyDirectory = path.join(root, 'queue-results');
    fs.mkdirSync(legacyDirectory);
    const jobId = `find-${Date.now()}`;
    fs.writeFileSync(path.join(legacyDirectory, `${jobId}.json`), JSON.stringify({ jobId, status: 'error', found: 208, heartbeatAt: Date.now() }));
    const store = createFinderProgressStore({ directory, legacyDirectory });
    assert.equal((await store.read(jobId)).found, 208);
    await store.cancel(jobId);
    assert.equal(store.cancelled(jobId), true);
    assert.ok(fs.existsSync(path.join(directory, `${jobId}.cancel`)));
    assert.ok(fs.existsSync(path.join(legacyDirectory, `${jobId}.cancel`)));
    await store.clearCancel(jobId);
    assert.equal(store.cancelled(jobId), false);
});

test('a later successful progress save clears the persistence warning', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'compel-finder-recovery-'));
    const jobId = `find-${Date.now()}`;
    let blocked = true;
    const store = createFinderProgressStore({ directory, legacyDirectory: directory, retryDelays: [],
        fileSystem: { ...fs.promises, rename: async (source, target) => {
            if (blocked) throw Object.assign(new Error('File lock'), { code: 'EPERM' });
            await fs.promises.rename(source, target);
        } } });
    await store.write(jobId, { status: 'running', found: 208 });
    assert.ok((await store.read(jobId)).progressPersistenceWarning);
    blocked = false;
    await store.write(jobId, { status: 'running', found: 209 });
    assert.equal((await store.read(jobId)).progressPersistenceWarning, undefined);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, `${jobId}.json`), 'utf8')).found, 209);
});

test('API reports exhaustion with the unmet kept target and actual completed query count', async () => {
    const api = apiHarness();
    await simulatedSearch(() => ({ results: [] }), async () => {
        const response = await api.post(config({ locations: ['US'], kept_leads_target: 3000 }));
        const launched = await response.json();
        const finished = await api.completed(launched.jobId);
        assert.equal(finished.stopReason, 'search_exhausted');
        assert.equal(finished.targetReached, false);
        assert.equal(finished.remaining, 3000);
        assert.equal(finished.queryIndex, buildDiscoverySearchPlan(config()).length);
    });
});

test('API rejects an invalid target before launching any search', async () => {
    const api = apiHarness();
    await simulatedSearch(() => { throw new Error('No search should be launched.'); }, async requests => {
        const response = await api.post(config({ kept_leads_target: 0 }));
        assert.equal(response.status, 400);
        assert.match((await response.json()).error, /positive whole number/);
        assert.equal(requests.length, 0);
    });
});

test('CRM write failure cannot be reported as a successfully kept target', async () => {
    const api = apiHarness({ failSave: true });
    await simulatedSearch(() => ({ results: [lead('unsaved')] }), async requests => {
        const response = await api.post(config({ kept_leads_target: 1 }));
        const launched = await response.json();
        const finished = await api.completed(launched.jobId);
        assert.equal(finished.status, 'error');
        assert.match(finished.error, /could not be saved/);
        assert.equal(finished.found, 0);
        assert.equal(api.writes.length, 0);
        assert.equal(requests.length, 1);
    });
});

test('foreign, missing, market-only and conflicting locations never reach the Finder CRM writer',async()=>{
 const api=apiHarness();
 await simulatedSearch(()=>({results:[
  {...lead('india'),snippet:'Location: Bengaluru, Karnataka, India · I coach US clients'},
  {...lead('france'),snippet:'Paris, France · Executive Coach'},
  {...lead('missing'),title:'Person - Executive Coach for US leaders | LinkedIn',snippet:'Serving clients in the United States'},
  {...lead('employer'),snippet:'Microsoft United States · Executive Coach'},
  {...lead('conflict'),attributes:{Location:'Toronto, Canada'},snippet:'Location: Austin, Texas, United States'},
  lead('confirmed'),
 ]}),async requests=>{
  const response=await api.post(config({locations:['United States'],kept_leads_target:1}));assert.equal(response.status,200);
  const finished=await api.completed((await response.json()).jobId);assert.equal(finished.status,'done');
  assert.equal(api.writes.length,1);assert.match(api.writes[0].linkedin_url,/confirmed$/);
  assert.equal(api.writes[0].location,'US');assert.equal(api.writes[0].discoveryLocation,'United States');
  assert.equal(api.writes[0].locationEvidence.country,'US');assert.match(api.writes[0].locationEvidence.rawText,/Austin/);
  assert.equal(finished.stats.rejectsByReason.LOCATION_OUTSIDE_TARGET,2);
  assert.equal(finished.stats.rejectsByReason.LOCATION_NOT_SHOWN,2);
  assert.equal(finished.stats.rejectsByReason.LOCATION_CONFLICT,1);assert.equal(requests.length,1);
 });
});

test('unsupported and ambiguous Finder locations fail before spending search credits',async()=>{
 const api=apiHarness();
 await simulatedSearch(()=>{throw Error('Search must not run');},async requests=>{
  for(const location of ['India','France','CA','London','America']){
   const response=await api.post(config({locations:[location]}));assert.equal(response.status,400,location);assert.match((await response.json()).error,/UK, US and Canada/);
  }
  assert.equal(requests.length,0);
 });
});
