'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createAccountRuntime } = require('../../src/lib/account-runtime.cjs');
const { fullCapture } = require('../../src/lib/worker-research-queue.cjs');

const viewer = { name: 'Fixture Account', profileUrl: 'https://www.linkedin.com/in/fixture-account/' };
const person = 'https://www.linkedin.com/in/fixture-coach/';
function fixture(accountId = 'fixture-account') {
    let open = false, url = 'https://www.linkedin.com/feed/', capture, allowance = {}, sleepHook = async () => {}, source = null, discovery = async () => ({});
    const account = { id: accountId, enabled: true, authorized: false, confirmed_identity: viewer, login_token: 'connect-1', processing_until: 'start-1', attention_reason: '' };
    const pending = Array.from({ length: 370 }, (_, i) => ({ jobId: 'fixture-' + i, linkedinUrl: person }));
    const checkpoints = [], deferred = [], completed = [], handoffs = [], holds = [], permits = [], statuses = [], discoveryHolds = [];
    const calls = { opens: 0, closes: 0, claims: 0, captures: 0, identities: 0, navigation: 0, logouts: 0, minimizes:0,reveals:0 };
    const page = { on() {}, mainFrame: () => page, url: () => url, isClosed: () => !open,
        goto: async () => { calls.navigation++; }, bringToFront: async () => {},
    };
    const browser = { isConnected: () => open };
    const browserOwner = { isOpen: () => open, open: async () => { if (!open) calls.opens++; open = true; return { browser, page }; }, close: async () => { if (open) calls.closes++; open = false; },minimize:async()=>{calls.minimizes++;},reveal:async()=>{calls.reveals++;} };
    const core = {
        readRuntimeAccount: async () => ({ ...account }),
        consumeLoginRequest: async () => { account.login_token = null; return true; },
        confirmManualSignIn: async () => { account.attention_reason = ''; },
        processingAllowed: async () => account.authorized && !account.attention_reason,
        pauseProcessing: async (_pool, id, reason, attention, owner) => { assert.equal(id, accountId); assert.equal(owner, 'owner'); account.authorized = false; holds.push({ reason, attention }); if (attention) account.attention_reason = reason; },
        reserveLinkedInCheck: async (_pool, id, owner, kind) => { assert.equal(id, accountId); assert.equal(owner, 'owner'); permits.push(kind); return typeof allowance === 'function' ? allowance(kind) : allowance; },
        claim: async () => { calls.claims++; return pending.length ? { job: pending.shift() } : null; },
        releaseClaim:async(_pool,jobId)=>{pending.unshift({jobId,linkedinUrl:person});},
        checkpoint: async (_pool, jobId, owner, value) => checkpoints.push({ jobId, owner, value: structuredClone(value) }),
        complete: async (_pool, jobId, owner, result) => completed.push({ jobId, owner, result }),
        defer: async (_pool, jobId, owner, result, retryAt) => { deferred.push({ jobId, owner, result, retryAt }); pending.unshift({ jobId, linkedinUrl: person, resumeResult: result }); },
        finishLogout: async () => { calls.logouts++; account.logout_token = null; account.signed_out_at = '2026-10-24T10:00:00.000Z'; return true; },
    };
    capture = async (_page, target, options) => { await options.beforeCheck('profile_page'); return { url: target, firstName: 'Fixture', emails: [], logs: [], profileIdentityConfirmed: true, linkedinCapture: { version: 2, complete: true } }; };
    const reader = {
        inspected: async (_page, options) => { options.checkResponse(200, url); return { url }; },
        readSignedInIdentity: async () => { calls.identities++; return viewer; },
        captureProfile: async (...args) => { calls.captures++; return capture(...args); },
    };
    const runtime = createAccountRuntime({ prefetch:false,pool: {}, accountId, owner: 'owner', core, browserOwner, reader,
        now: () => Date.parse('2026-10-24T10:00:00.000Z'), sleep: ms => sleepHook(ms), onStatus: value => statuses.push(value),
        discoveryStore: { claimSource: async () => source, pauseAccount: async (_pool, id, reason) => discoveryHolds.push({ id, reason }) },
        prospecting: { discover: (...args) => discovery(...args) },
        researchQueue: { fullCapture, handoff: async (_pool, jobId, owner, value) => handoffs.push({ jobId, owner, value }) },
        signOut: async b => { assert.equal(b, browser); },
    });
    const tick=runtime.tick;runtime.tick=async()=>{await tick();await runtime.drain();};
    return { runtime, account, calls, pending, checkpoints, completed, deferred, handoffs, holds, permits, statuses, discoveryHolds, page,
        connect: async () => { await runtime.tick(); await runtime.tick(); },
        set capture(value) { capture = value; }, set allowance(value) { allowance = value; }, set sleep(value) { sleepHook = value; },
        set url(value) { url = value; }, set source(value) { source = value; }, set discovery(value) { discovery = value; }, set open(value) { open = value; } };
}

test('an idle runtime does not open a saved browser, navigate, validate identity, or claim queued profiles', async () => {
    const f = fixture(); f.account.login_token = null;
    await f.runtime.tick(); await f.runtime.tick();
    assert.equal(f.calls.opens, 0); assert.equal(f.calls.navigation, 0); assert.equal(f.calls.identities, 0); assert.equal(f.calls.claims, 0);
    assert.equal(f.pending.length, 370); assert.equal(f.runtime.snapshot().status, 'idle');
});
test('processing minimizes the session; manual connection and account warnings reveal it without a restart',async()=>{
 const f=fixture();await f.connect();assert.equal(f.calls.reveals,1);assert.equal(f.calls.minimizes,0);
 f.account.authorized=true;await f.runtime.tick();assert.equal(f.calls.minimizes,1);assert.equal(f.calls.opens,1);
 f.account.authorized=false;await f.runtime.tick();assert.equal(f.calls.reveals,1,'ordinary Pause keeps the window in the background');
 await f.runtime.handleSignal({stage:'linkedin',code:'LINKEDIN_AUTH',reason:'Review required',retryable:false});
 assert.equal(f.calls.reveals,2);assert.equal(f.calls.closes,0);assert.equal(f.account.authorized,false);
});

test('an explicit Start captures one queued profile and hands complete evidence to independent research', async () => {
    const f = fixture(); await f.connect(); f.account.authorized = true; await f.runtime.tick();
    assert.equal(f.calls.opens, 1); assert.equal(f.calls.captures, 1); assert.equal(f.calls.identities, 1);
    assert.equal(f.pending.length, 369); assert.equal(f.handoffs.length, 1);
    assert.equal(f.handoffs[0].value.linkedinAccountId, 'fixture-account'); assert.equal(f.handoffs[0].value.linkedinCapture.complete, true);
    assert.equal(f.completed.length, 0, 'Account capture must not mark research as complete.');
    assert.equal(f.runtime.snapshot().browserOpen, true); assert.equal(f.calls.closes, 0);
});

test('legacy pacing values cannot sleep or block an owned profile action',async()=>{
 const f=fixture();await f.connect();f.account.authorized=true;f.allowance={waitMs:60000};f.sleep=async()=>assert.fail('No throttle sleeps');await f.runtime.tick();assert.equal(f.handoffs.length,1);assert.ok(!f.statuses.some(s=>s.status==='sleeping'));assert.equal(f.account.authorized,true);
});

test('a stale or deleted queued URL fails only that profile and the batch continues without another Start',async()=>{
 for(const code of ['PROFILE_REDIRECT','PROFILE_UNAVAILABLE']) {
  const f=fixture();await f.connect();f.account.authorized=true;
  f.capture=async()=>{throw Object.assign(Error('Unavailable queued URL'),{failure:{stage:'linkedin',code,reason:'Unavailable queued URL',retryable:false}});};
  await f.runtime.tick();assert.equal(f.completed.length,1);assert.equal(f.completed[0].result.failure.code,code);
  f.capture=async(_page,url,options)=>{await options.beforeCheck('profile_page');return {url,profileIdentityConfirmed:true,linkedinCapture:{version:2,complete:true}};};
  await f.runtime.tick();await f.runtime.tick();assert.equal(f.handoffs.length,2);assert.deepEqual(f.holds,[]);assert.equal(f.account.authorized,true);assert.equal(f.calls.opens,1);
 }
});

test('pause stops new claims while preserving the same visible browser and every remaining profile', async () => {
    const f = fixture(); await f.connect(); f.account.authorized = true; await f.runtime.tick();
    f.account.authorized = false; await f.runtime.tick(); await f.runtime.tick();
    assert.equal(f.calls.claims, 1); assert.equal(f.pending.length, 369); assert.equal(f.calls.closes, 0);
    assert.equal(f.runtime.snapshot().status, 'idle'); assert.equal(f.runtime.snapshot().sessionReady, true);
    f.account.authorized = true; await f.runtime.tick();
    assert.equal(f.calls.opens, 1); assert.equal(f.calls.navigation, 1); assert.equal(f.calls.identities, 1); assert.equal(f.handoffs.length, 2);
});

test('a pause during a pacing wait defers the current job with its partial capture intact', async () => {
    const f = fixture(); await f.connect();
    const partial = { url: person, firstName: 'Fixture', profileIdentityConfirmed: true, linkedinCapture: { version: 2, stage: 'contact', complete: false }, logs: [], emails: [] };
    f.capture = async (_page, _url, options) => { await options.beforeCheck('profile_page'); await options.onCheckpoint(partial); await options.beforeCheck('contact'); assert.fail('The contact interaction must not execute after pause.'); };
    f.allowance=kind=>{if(kind==='contact')f.account.authorized=false;return {};};
    f.account.authorized = true; await f.runtime.tick();
    assert.equal(f.deferred.length, 1); assert.equal(f.completed.length, 0); assert.equal(f.handoffs.length, 0); assert.equal(f.pending.length, 370);
    assert.equal(f.checkpoints.length, 1); assert.equal(f.deferred[0].result.linkedinCapture.stage, 'contact');
    assert.equal(f.deferred[0].result.linkedinCapture.complete, false); assert.equal(f.deferred[0].result.failure.code, 'WORKER_PAUSED');
    assert.equal(f.holds.some(value => value.attention), false); assert.equal(f.calls.closes, 0);
    await f.runtime.tick(); assert.equal(f.calls.captures, 1);
    f.allowance = {};
    f.capture = async (_page, _url, options) => { assert.equal(options.resume.linkedinCapture.stage, 'contact'); return { ...partial, linkedinCapture: { version: 2, complete: true } }; };
    f.account.authorized = true; await f.runtime.tick();
    assert.equal(f.handoffs.length, 1); assert.equal(f.calls.opens, 1); assert.equal(f.pending.length, 369);
});

test('a LinkedIn restriction holds the account and preserves queued work without another page interaction', async () => {
    const f = fixture(); await f.connect();
    f.capture = async (_page, url, options) => {
        await options.beforeCheck('profile_page');
        await options.onCheckpoint({ url, firstName: 'Fixture', linkedinCapture: { version: 2, complete: false, stage: 'contact' } });
        options.checkResponse(429, url); assert.fail('Capture cannot continue after a restriction.');
    };
    f.account.authorized = true; await f.runtime.tick();
    assert.equal(f.deferred.length, 1); assert.equal(f.pending.length, 370); assert.equal(f.completed.length, 0);
    assert.ok(f.account.attention_reason); assert.ok(f.holds.some(value => value.attention)); assert.equal(f.discoveryHolds.length, 1);
    assert.equal(f.runtime.snapshot().manualResumeRequired, true); assert.equal(f.calls.closes, 0);
    f.account.authorized = true; await f.runtime.tick(); await f.runtime.tick();
    assert.equal(f.calls.captures, 1); assert.equal(f.calls.claims, 1); assert.equal(f.calls.opens, 1);
    await assert.rejects(f.runtime.permit('contact'), error => error.failure.code === 'LINKEDIN_RATE_LIMIT');
    assert.deepEqual(f.permits, ['profile_page']);
});

test('a changed profile format preserves evidence and pauses with the visible browser still open', async () => {
    const f = fixture(); await f.connect();
    f.capture = async (_page, url, options) => { await options.onCheckpoint({ url, firstName: 'Fixture', linkedinCapture: { version: 2, stage: 'activity', complete: false } }); throw Error('Profile layout no longer matches.'); };
    f.account.authorized = true; await f.runtime.tick();
    assert.equal(f.completed.length, 1); assert.equal(f.completed[0].result.failure.code, 'PAGE_CHANGED');
    assert.equal(f.completed[0].result.firstName, 'Fixture'); assert.equal(f.completed[0].result.linkedinCapture.stage, 'activity');
    assert.equal(f.runtime.snapshot().status, 'ready'); assert.equal(f.runtime.snapshot().browserOpen, true);
    assert.equal(f.calls.closes, 0); assert.equal(f.account.authorized, true); assert.ok(f.holds.every(value => !value.attention));
    assert.equal(f.completed[0].result.status,'REVIEW');await f.runtime.tick();assert.equal(f.calls.captures,2,'nonretryable format failure cannot stop the remaining queue');
});

test('a cached complete capture enters public research without opening another profile', async () => {
    const f = fixture(); await f.connect();
    f.pending[0].resumeResult = { url: person, firstName: 'Saved', profileIdentityConfirmed: true, linkedinCapture: { complete: true } };
    f.account.authorized = true; await f.runtime.tick();
    assert.equal(f.calls.captures, 0); assert.deepEqual(f.permits, []); assert.equal(f.handoffs.length, 1);
    assert.equal(f.handoffs[0].value.firstName, 'Saved'); assert.equal(f.calls.navigation, 1);
});

test('expired saved login pauses after the explicit Start and never submits credentials or automatically retries', async () => {
    const f = fixture(); f.account.login_token = null; f.account.authorized = true; f.url = 'https://www.linkedin.com/login';
    await f.runtime.tick(); await f.runtime.tick();
    assert.equal(f.calls.opens, 1); assert.equal(f.calls.navigation, 1); assert.equal(f.calls.captures, 0); assert.equal(f.calls.claims, 1);
    assert.ok(f.account.attention_reason); assert.equal(f.pending.length, 370); assert.equal(f.calls.closes, 0);
    assert.equal(f.runtime.snapshot().browserOpen, true);
});

test('a Start navigation timeout retries within three attempts then shows an actionable failure',async()=>{
 const f=fixture();f.account.login_token=null;f.account.authorized=true;f.page.goto=async()=>{f.calls.navigation++;throw Error('Navigation timeout');};for(let n=0;n<3;n++)await f.runtime.tick();assert.equal(f.calls.opens,3);assert.equal(f.calls.navigation,3);assert.equal(f.pending.length,370);assert.equal(f.account.authorized,false);assert.equal(f.runtime.snapshot().startupStage,'FAILED');assert.ok(f.runtime.snapshot().action);
});

test('sign-out affects only the selected saved session and preserves every queued profile', async () => {
    const f = fixture(); await f.connect(); f.account.logout_token = 'logout-token'; await f.runtime.tick();
    assert.equal(f.calls.logouts, 1); assert.equal(f.calls.closes, 1); assert.equal(f.runtime.snapshot().status, 'signed_out');
    assert.equal(f.runtime.snapshot().signedIn, null); assert.equal(f.runtime.snapshot().browserOpen, false); assert.equal(f.pending.length, 370);
    await f.runtime.tick(); assert.equal(f.calls.opens, 1); assert.equal(f.calls.claims, 0);
});

test('repeated shutdown closes the owner once and retains pending work and completed handoff', async () => {
    const f = fixture(); await f.connect(); f.account.authorized = true; await f.runtime.tick();
    await Promise.all([f.runtime.close(), f.runtime.close()]); await f.runtime.tick();
    assert.equal(f.calls.closes, 1); assert.equal(f.pending.length, 369); assert.equal(f.handoffs.length, 1);
    assert.equal(f.calls.claims, 1); assert.equal(f.runtime.snapshot().status, 'offline');
});

test('a browser disconnect reopens the saved profile and continues authorized work',async()=>{
 const f=fixture();await f.connect();f.account.authorized=true;f.open=false;f.runtime.disconnected(Error('Chrome closed.'));await f.runtime.tick();assert.equal(f.account.authorized,true);assert.equal(f.calls.opens,2);assert.equal(f.calls.captures,1);assert.equal(f.handoffs.length,1);assert.equal(f.runtime.snapshot().sessionReady,true);
});
