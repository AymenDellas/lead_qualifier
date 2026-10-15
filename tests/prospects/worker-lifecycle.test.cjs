'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const qualification = require('../../src/lib/prospect-qualification.cjs');
const workerPath = require.resolve('../../worker.cjs');
const source = fs.readFileSync(workerPath, 'utf8');

// Execute the complete worker entry point with an in-memory queue and browser.
// No real environment files, jobs, LinkedIn sessions or CRM requests are used.
async function runWorker({ signal = 'SIGINT', stopBeforeLaunch = false, duplicate = false, closeHangs = false, extraTabs = 0, loginFails = false, navigationFailures = 0, manualLogin = false, checkLogin = false, accountId = null, signOut = false }) {
    const root = path.dirname(workerPath);
    const queueDir = path.join(root, 'queue');
    const files = new Map();
    const pidFile = path.join(root, 'data', accountId ? `worker-${accountId}.pid` : 'worker.pid');
    if (duplicate) files.set(pidFile, JSON.stringify({ pid: 7777 }));
    for (let i = 0; i < 370; i++) {
        const jobId = `fixture-${String(i).padStart(3, '0')}`;
        files.set(path.join(queueDir, `${jobId}.json`), JSON.stringify({
            jobId, linkedinUrl: 'https://www.linkedin.com/in/test-coach/',
        }));
    }
    const logs = [], errors = [], exits = [], launches = [], signals = new Map(), signalTasks = [], killed = [], closedTabs = [], browserEvents = [];
    let newPages = 0, poolEnds = 0;
    let cookies=[{name:'li_at',domain:'.linkedin.com'}],logoutSaved=false;
    let alive = false, stopRequested = false;
    const requestStop = () => {
        if (stopRequested) return;
        stopRequested = true;
        // Repeated signals must not run a second shutdown.
        signalTasks.push(signals.get(signal)(), signals.get(signal)());
    };
    const fakeFs = {
        existsSync: file => path.extname(file) ? files.has(file) || path.basename(file) === '.env.local' : true,
        mkdirSync: () => assert.fail('fixture directories already exist'),
        readdirSync: dir => [...files.keys()].filter(file => path.dirname(file) === dir).map(file => path.basename(file)),
        readFileSync: file => {
            if (path.basename(file) === '.env.local') {
                return 'LINKEDIN_ACCOUNTS=[{"email":"test@example.invalid","password":"fixture"}]';
            }
            assert.ok(files.has(file), `Unexpected fixture read: ${file}`);
            return files.get(file);
        },
        writeFileSync: (file, value, options) => {
            if (options?.flag === 'wx' && files.has(file)) throw Object.assign(new Error('Fixture lock exists'), { code: 'EEXIST' });
            files.set(file, value);
            if (path.basename(file) === 'fixture-000.json' && path.dirname(file) !== queueDir) {
                queueMicrotask(requestStop);
            }
        },
        unlinkSync: file => { files.delete(file); },
    };
    const page = {
        setViewport: async () => {}, isClosed: () => false, bringToFront:async()=>browserEvents.push('front'),
        goto: async () => {
            browserEvents.push('navigate');
            if (navigationFailures > 0) { navigationFailures--; throw Object.assign(new Error('Navigation timeout of 45000 ms exceeded'), { name: 'TimeoutError' }); }
        },
        url: () => loginFails || signOut ? 'https://www.linkedin.com/login' : 'https://www.linkedin.com/feed/', evaluate: async (_fn,url) => typeof url==='string'&&url.includes('voyager/api/me')?{status:200,data:{miniProfile:{firstName:'Fixture',lastName:'Account',publicIdentifier:'fixture-account',entityUrn:'urn:li:fs_miniProfile:fixture'}}}:true,
    };
    const makeBrowser = options => ({
        process: () => ({ pid: 1234 }),
        pages: () => assert.fail('Startup must not initialize restored pages with browser.pages()'),
        target: () => ({ createCDPSession: async () => ({
            send: async (command, args) => {
                if (command === 'Target.getTargets') {
                    browserEvents.push('list-targets');
                    return { targetInfos: [{ targetId: 'browser', type: 'browser' }, { targetId: 'service-worker', type: 'service_worker' },
                        ...Array.from({ length: extraTabs + 1 }, (_, i) => ({ targetId: String(i), type: 'page' }))] };
                }
                assert.equal(command, 'Target.closeTarget');
                browserEvents.push('close-target'); closedTabs.push(Number(args.targetId));
                return { success: true };
            },
            detach: async () => browserEvents.push('detach'),
        }) }),
        newPage: async () => {
            assert.equal(options.targetFilter({ type: () => 'page' }), true);
            newPages++; browserEvents.push('new-page'); return page;
        },
        close: async () => { if (closeHangs) await new Promise(() => {}); alive = false; },
        cookies:async()=>cookies,deleteCookie:async(...values)=>{cookies=cookies.filter(cookie=>!values.includes(cookie));},
    });
    const modules = {
        fs: fakeFs, path,
        'child_process': { execSync: command => { assert.equal(command, 'taskkill /F /T /PID 1234'); killed.push(command); alive = false; } },
        'puppeteer-extra': { use: () => {}, launch: async options => {
            assert.equal(options.waitForInitialPage, false);
            assert.equal(options.targetFilter({ type: () => 'page' }), false);
            assert.equal(options.targetFilter({ type: () => 'browser' }), true);
            launches.push(options); alive = true; return makeBrowser(options);
        } },
        'puppeteer-extra-plugin-stealth': () => ({}),
        './src/lib/prospect-qualification.cjs': qualification,
        './src/lib/linkedin-activity.cjs': require('../../src/lib/linkedin-activity.cjs'),
        './src/lib/profile-public-contacts.cjs': require('../../src/lib/profile-public-contacts.cjs'),
        './src/lib/prospect-research.cjs': { researchProspect: () => assert.fail('No live research') },
        './src/lib/linkedin-session-identity.cjs': require('../../src/lib/linkedin-session-identity.cjs'),
        './src/lib/linkedin-signout.cjs': require('../../src/lib/linkedin-signout.cjs'),
        './src/lib/worker-failure.cjs': require('../../src/lib/worker-failure.cjs'),
        http: {}, https: {},
        pg: { Pool: class { async query() { return {rows:[{id:accountId,email:`${accountId}@example.invalid`,secret:'encrypted',profile_key:`profile-${accountId}`,logout_request_token:signOut?'logout-token':null} ]}; } async end() { assert.equal(++poolEnds,1,'shutdown and main finally must share one database cleanup'); } } },
        'node:crypto': require('node:crypto'),
        './src/lib/linkedin-workers.cjs': { ensure:async()=>{},acquireSession:async()=>true,decrypt:()=>{assert.equal(signOut,false,'sign-out must not read or use saved passwords');return 'fixture';},releaseSession:async()=>{},consumeLoginRequest:async()=>true,
            finishLogout:async()=>{logoutSaved=true;return true;},
            claim:async()=>({job:JSON.parse(files.get(path.join(queueDir,'fixture-000.json'))),dailyCount:1,dailyLimit:400}),
            checkpoint:async()=>{},complete:async()=>{},heartbeat:async()=>{} },
    };
    const context = vm.createContext({
        __dirname: root, global: {}, structuredClone,
        require: name => { assert.ok(Object.hasOwn(modules, name), `Unexpected module: ${name}`); return modules[name]; },
        process: {
            pid: 4444, argv: ['node', workerPath, ...(accountId ? ['--account',accountId] : []), ...(manualLogin ? ['--login'] : []), ...(checkLogin ? ['--check-login'] : []), ...(signOut ? ['--logout'] : [])], env: { DAILY_SCRAPE_LIMIT: '0' }, platform: 'win32',
            on: (name, handler) => signals.set(name, handler), exit: code => { exits.push(code); signals.get('exit')?.(); },
            memoryUsage: () => ({ rss: 64 * 1024 * 1024 }),
            kill: pid => { if (duplicate && pid === 7777) return; if (pid !== 1234 || !alive) throw new Error('fixture process exited'); },
        },
        console: {
            log: message => { logs.push(message); if (stopBeforeLaunch && message.includes('pending job(s)')) requestStop(); },
            error: (...args) => errors.push(args.map(String).join(' ')),
        },
        setTimeout: callback => { queueMicrotask(callback); return 1; }, clearTimeout: () => {},
        setInterval:()=>({unref(){}}),clearInterval:()=>{},
        fixtureScrape: async (_page, url) => ({ url, firstName: 'TEST Coach', emails: [], logs: [], status: 'PENDING' }),
        fixtureEnrich: async result => ({ ...result, status: 'REJECTED' }),
    });
    // Strict mode also catches browser/PID assignments that accidentally rely on
    // implicit globals, which normal CommonJS execution would otherwise permit.
    const completion = vm.runInContext(`'use strict';\n${source}`, context, { timeout: 1000 });
    vm.runInContext('scrapeProfile = fixtureScrape; enrichAndFinalize = fixtureEnrich;', context);
    await completion;
    await Promise.all(signalTasks);
    assert.deepEqual(errors, []);
    if(accountId)assert.equal(poolEnds,1);
    const statusPath = path.join(root, 'queue-results', accountId ? `worker-status-${accountId}.json` : 'worker-status.json');
    const status = files.has(statusPath) ? JSON.parse(files.get(statusPath)) : null;
    if(signOut) {
        assert.equal(status.status,'signed_out');assert.equal(status.signedIn,null);assert.equal(logoutSaved,true);
        assert.equal(cookies.length,0);assert.equal(alive,false);assert.equal(files.has(pidFile),false);
        assert.equal([...files.keys()].filter(file=>path.dirname(file)===queueDir).length,370,'sign-out cannot process or remove queued leads');
        assert.deepEqual(exits,[0]);return {launches,logs};
    }
    if(manualLogin&&checkLogin) {
        assert.deepEqual(exits,[0]);assert.equal(status.status,'offline');assert.equal(status.reason,'Manual sign-in complete');
        assert.equal(launches.length,1);assert.equal(launches[0].headless,false);assert.ok(browserEvents.includes('front'));
        assert.equal([...files.keys()].filter(file=>path.dirname(file)===queueDir).length,370);
        return {launches,logs};
    }
    if (duplicate || loginFails || status?.reason?.includes('Browser could not load')) {
        assert.equal([...files.keys()].filter(file => path.dirname(file) === queueDir).length, 370);
        assert.equal(alive, false);
        if (duplicate) { assert.equal(launches.length, 0); assert.ok(files.has(pidFile)); }
        else { assert.ok(launches.every(options => options.headless)); assert.equal(files.has(pidFile), false); }
        return { files, launches, logs, queueDir, killed, closedTabs, newPages, browserEvents };
    }
    assert.deepEqual(exits, [0]);
    assert.ok(logs.some(message => message.includes('Found 370 pending job(s)')));
    assert.equal(logs.filter(message => message.includes('shutting down gracefully')).length, 1);
    assert.equal(status.status, 'offline');
    assert.equal(status.reason, checkLogin ? 'Startup check complete' : signal);
    assert.equal(alive, false);
    assert.equal(files.has(pidFile), false);
    return { files, launches, logs, queueDir, killed, closedTabs, newPages, browserEvents, configuredAccounts: JSON.parse(context.process.env.LINKEDIN_ACCOUNTS) };
}

test('account workers launch distinct browser profiles and use their own login identity', async () => {
    const first=await runWorker({accountId:'legacy-0',checkLogin:true});
    const second=await runWorker({accountId:'legacy-1',checkLogin:true});
    assert.notEqual(first.launches[0].userDataDir,second.launches[0].userDataDir);
    assert.match(first.launches[0].userDataDir,/profile-legacy-0$/);
    assert.match(second.launches[0].userDataDir,/profile-legacy-1$/);
    assert.equal(first.configuredAccounts[0].email,'legacy-0@example.invalid');
    assert.equal(second.configuredAccounts[0].email,'legacy-1@example.invalid');
});
test('account sign-out clears authentication, preserves every queued lead and never auto-logins',async()=>{
    const result=await runWorker({accountId:'legacy-0',signOut:true});
    assert.equal(result.launches.length,1);assert.ok(result.launches[0].headless);
});
test('an explicit account sign-in opens a visible login browser immediately without claiming leads',async()=>{
    await runWorker({accountId:'legacy-0',manualLogin:true,checkLogin:true});
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    test(`worker resumes a pending queue, saves the completed job and handles ${signal}`, async () => {
        const { files, launches, logs, queueDir } = await runWorker({ signal });
        assert.equal(launches.length, 1);
        assert.ok(logs.some(message => message.includes('Worker is READY')));
        assert.equal([...files.keys()].filter(file => path.dirname(file) === queueDir).length, 369);
        const result = JSON.parse(files.get(path.join(path.dirname(workerPath), 'queue-results', 'fixture-000.json')));
        assert.equal(result.status, 'done');
        assert.equal(result.result.status, 'REJECTED');
    });
}

test('shutdown before browser launch leaves all pending jobs available for restart', async () => {
    const { files, launches, queueDir } = await runWorker({ signal: 'SIGTERM', stopBeforeLaunch: true });
    assert.equal(launches.length, 0);
    assert.equal([...files.keys()].filter(file => path.dirname(file) === queueDir).length, 370);
});

test('a second worker cannot launch Chrome or touch the first worker’s queue or lock', async () => {
    const { logs } = await runWorker({ duplicate: true });
    assert.ok(logs.some(message => message.includes('duplicate will exit')));
});

test('shutdown forcibly reaps only its tracked Chrome tree if browser.close hangs', async () => {
    const { killed, launches } = await runWorker({ closeHangs: true });
    assert.equal(launches.length, 1); assert.deepEqual(killed, ['taskkill /F /T /PID 1234']);
});

test('restored worker tabs are closed before any page/plugin initialization and only one fresh page is opened', async () => {
    const { launches, closedTabs, newPages, browserEvents } = await runWorker({ extraTabs: 30 });
    assert.equal(launches.length, 1); assert.deepEqual(closedTabs, Array.from({ length: 31 }, (_, i) => i));
    assert.equal(newPages, 1);
    assert.ok(browserEvents.lastIndexOf('close-target') < browserEvents.indexOf('new-page'));
    assert.ok(browserEvents.indexOf('new-page') < browserEvents.indexOf('navigate'));
});

test('an expired login cannot silently open a visible browser', async () => {
    const { files, logs } = await runWorker({ loginFails: true });
    const status = JSON.parse(files.get(path.join(path.dirname(workerPath), 'queue-results', 'worker-status.json')));
    assert.equal(status.status, 'paused'); assert.match(status.reason, /--login/);
    assert.ok(logs.some(message => message.includes('Pending jobs are preserved')));
});

test('a navigation timeout retries once in headless mode and never becomes a login-expired verdict', async () => {
    for (const manualLogin of [false, true]) {
        const { files, launches, logs, queueDir } = await runWorker({ navigationFailures: 10, manualLogin });
        const status = JSON.parse(files.get(path.join(path.dirname(workerPath), 'queue-results', 'worker-status.json')));
        assert.equal(status.status, 'paused'); assert.match(status.reason, /login status could not be determined/);
        assert.equal(launches.length, 2); assert.ok(launches.every(options => options.headless));
        assert.ok(logs.some(message => message.includes('Retrying the browser startup once')));
        assert.ok(logs.every(message => !message.includes('LinkedIn login is required')));
        assert.equal([...files.keys()].filter(file => path.dirname(file) === queueDir).length, 370);
    }
});

test('a transient startup timeout recovers with one fresh browser and processes the original queued job', async () => {
    const { files, launches, queueDir } = await runWorker({ navigationFailures: 1 });
    assert.equal(launches.length, 2); assert.ok(launches.every(options => options.headless));
    assert.equal([...files.keys()].filter(file => path.dirname(file) === queueDir).length, 369);
});

test('startup verification can confirm login and close Chrome without claiming any queued profile', async () => {
    const { files, launches, logs, queueDir } = await runWorker({ checkLogin: true });
    assert.equal(launches.length, 1); assert.ok(launches[0].headless);
    assert.equal([...files.keys()].filter(file => path.dirname(file) === queueDir).length, 370);
    assert.ok(logs.some(message => message.includes('Startup login check passed')));
});
