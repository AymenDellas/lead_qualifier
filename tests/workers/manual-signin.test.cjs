'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { createAccountRuntime } = require('../../src/lib/account-runtime.cjs');
const { sameMember } = require('../../src/lib/linkedin-session-policy.cjs');
const viewer = { name: 'Fixture Viewer', profileUrl: 'https://www.linkedin.com/in/fixture-viewer/' };
const feed = 'https://www.linkedin.com/feed/';
const security = { stage: 'linkedin', code: 'LINKEDIN_AUTH', reason: 'LinkedIn requires a security check.', retryable: false };

function fixture() {
    let state = {}, time = Date.parse('2026-10-24T10:00:00.000Z'), open = false, menuBlocked = false, navigationTimeout = false,limit=null;
    const account = { id: 'fixture-account', enabled: true, authorized: false, login_token: 'connect-1', confirmed_identity: viewer, processing_until: 'start-1', attention_reason: '' };
    const statuses = [], holds = [], confirmations = [], reads = [], menuReads = [], permits = [], navigations = [];
    const calls = { opens: 0, closes: 0, claims: 0, fronts: 0, consumed: 0 };
    const events=new (require('node:events').EventEmitter)();
    const page = { on:(...args)=>events.on(...args), mainFrame: () => page, url: () => state.url || feed,
        goto: async url => { navigations.push(url); if (navigationTimeout) throw Error('Navigation timeout'); },
        bringToFront: async () => { calls.fronts++; }, isClosed: () => !open,
    };
    const browser = { isConnected: () => open };
    const browserOwner = { isOpen: () => open, open: async () => { calls.opens++; open = true; return { browser, page }; }, close: async () => { calls.closes++; open = false; } };
    const core = {
        readRuntimeAccount: async () => ({ ...account }),
        consumeLoginRequest: async (_pool, id, token) => { assert.equal(id, account.id); assert.equal(token, account.login_token); account.login_token = null; calls.consumed++; return true; },
        confirmManualSignIn: async (_pool, id, owner, identity) => { assert.equal(id, account.id); assert.equal(owner, 'fixture-owner'); confirmations.push(identity); account.confirmed_identity = identity; account.attention_reason = ''; },
        processingAllowed: async () => account.authorized && !account.attention_reason,
        reserveLinkedInCheck: async (_pool, _id, _owner, kind, options) => { permits.push({ kind, ...options }); return menuBlocked ? { waitMs: 60000, reason: 'Identity budget is resting.' } : {}; },
        pauseProcessing: async (_pool, _id, reason, attention) => { holds.push({ reason, attention }); account.authorized = false; if (attention) account.attention_reason = reason; },
        claim: async () => { calls.claims++; return limit; },
    };
    const reader = {
        inspected: async (_page, options) => {
            if (state.signal) throw Object.assign(Error(state.signal.reason), { failure: state.signal });
            options.checkResponse(state.httpStatus || 200, page.url()); return { url: page.url() };
        },
        readSignedInIdentity: async (_page, options) => {
            assert.equal(options.manual, true);
            if (options.passive) {
                assert.equal(options.beforeCheck, undefined); reads.push(state);
                if (state.error) throw state.error;
                return state.identity || null;
            }
            assert.equal(options.leaveMenuOpen, true); menuReads.push(state);
            await options.beforeCheck('identity'); return state.menuIdentity || null;
        },
    };
    const researchQueue={fullCapture:()=>false,handoff:async()=>{}};
    const runtime = createAccountRuntime({ pool: {}, core, accountId: account.id, owner: 'fixture-owner', browserOwner, reader,
        prospecting: {}, researchQueue, discoveryStore: { claimSource: async () => null, pauseAccount: async () => {} },
        now: () => time, sleep: async () => assert.fail('Manual identity confirmation must not sleep on an interaction permit.'), onStatus: status => statuses.push(status),
    });
    return { runtime, reader, page, events, account, calls, statuses, holds, confirmations, reads, menuReads, permits, navigations, browserOwner,
        set state(value) { state = value; }, set time(value) { time = value; }, set menuBlocked(value) { menuBlocked = value; },
        set limit(value){limit=value;},set navigationTimeout(value) { navigationTimeout = value; }, set open(value) { open = value; } };
}

test('Connect opens one browser and passive identity confirmation leaves it idle without claiming leads', async () => {
    const f = fixture(); await f.runtime.tick();
    assert.equal(f.calls.opens, 1); assert.deepEqual(f.navigations, [feed]); assert.equal(f.calls.claims, 0);
    assert.equal(f.runtime.snapshot().status, 'awaiting_login');
    await f.runtime.tick(); await f.runtime.tick();
    assert.equal(f.confirmations.length, 0); assert.equal(f.calls.closes, 0);
    f.state = { identity: viewer }; await f.runtime.tick();
    assert.deepEqual(f.confirmations, [viewer]); assert.equal(f.runtime.snapshot().status, 'idle');
    assert.equal(f.runtime.snapshot().sessionReady, true); assert.equal(f.runtime.snapshot().browserOpen, true);
    assert.equal(f.calls.opens, 1); assert.equal(f.calls.closes, 0); assert.equal(f.calls.claims, 0);
    assert.equal(f.statuses.at(-1).signedIn, viewer);
});

test('Start after connection reuses the idle browser without navigation or another identity check', async () => {
    const f = fixture(); await f.runtime.tick(); f.state = { identity: viewer }; await f.runtime.tick();
    const reads = f.reads.length, menuReads = f.menuReads.length;
    f.account.authorized = true; await f.runtime.tick(); await f.runtime.tick();
    assert.equal(f.calls.opens, 1); assert.deepEqual(f.navigations, [feed]);
    assert.equal(f.reads.length, reads); assert.equal(f.menuReads.length, menuReads); assert.deepEqual(f.permits, []);
    assert.equal(f.calls.claims, 2); assert.equal(f.runtime.snapshot().status, 'ready');
});

test('security checks keep the manual window open and persist a hold until a matching member is confirmed', async () => {
    const f = fixture(); await f.runtime.tick();
    f.state = { url: 'https://www.linkedin.com/checkpoint/', signal: security }; await f.runtime.tick(); await f.runtime.tick();
    assert.ok(f.holds.every(value => value.attention)); assert.ok(f.account.attention_reason);
    assert.equal(f.reads.length, 0); assert.equal(f.confirmations.length, 0); assert.equal(f.calls.closes, 0);
    f.state = { identity: viewer }; await f.runtime.tick();
    assert.equal(f.confirmations.length, 1); assert.equal(f.account.attention_reason, '');
    assert.equal(f.runtime.snapshot().status, 'idle'); assert.equal(f.runtime.snapshot().sessionReady, true);
    assert.notEqual(f.runtime.snapshot().manualResumeRequired, true, 'Resolved manual confirmation must clear the restriction flag in the published status.');
    assert.ok(!f.runtime.snapshot().reasonCode, 'Resolved manual confirmation must clear the prior restriction reason code.');
    assert.equal(f.calls.claims, 0); assert.equal(f.account.authorized, false);
});

test('initial navigation timeout and a changing DOM keep the same manual window available', async () => {
    const f = fixture(); f.navigationTimeout = true; await f.runtime.tick();
    f.state = { error: Error('Execution context was destroyed') }; await f.runtime.tick();
    assert.equal(f.confirmations.length, 0); assert.equal(f.calls.closes, 0);
    f.state = { identity: viewer }; await f.runtime.tick();
    assert.equal(f.confirmations.length, 1); assert.equal(f.calls.opens, 1); assert.equal(f.navigations.length, 1);
    assert.equal(f.runtime.snapshot().status, 'idle');
});

test('a wrong member cannot be confirmed while the user switches to the intended account', async () => {
    const f = fixture(), wrong = { name: 'Wrong Member', profileUrl: 'https://www.linkedin.com/in/wrong-member/' };
    assert.equal(sameMember(viewer, wrong), false); await f.runtime.tick();
    f.state = { identity: wrong }; await f.runtime.tick(); await f.runtime.tick();
    assert.equal(f.confirmations.length, 0); assert.ok(f.holds.some(value => /different LinkedIn member/.test(value.reason)));
    assert.equal(f.calls.closes, 0); f.state = { identity: viewer }; await f.runtime.tick();
    assert.deepEqual(f.confirmations, [viewer]); assert.equal(f.runtime.snapshot().signedIn, viewer);
});

test('unconfirmed identity reaches manual review without closing the browser or starting work', async () => {
    const f = fixture(); await f.runtime.tick();
    for (let i = 0; i < 4; i++) await f.runtime.tick();
    assert.equal(f.menuReads.length, 1); assert.deepEqual(f.permits, [{ kind: 'identity', manual: true }]);
    f.time = Date.parse('2026-10-24T10:11:00.000Z'); await f.runtime.tick();
    assert.equal(f.runtime.snapshot().status, 'awaiting_login'); assert.equal(f.runtime.snapshot().startupStage, 'SESSION_REVIEW');
    assert.equal(f.calls.closes, 0); assert.equal(f.calls.claims, 0); assert.equal(f.confirmations.length, 0);
    assert.equal(f.runtime.snapshot().browserOpen, true);
});

test('closing the manual browser is detected without reopening it or claiming a profile', async () => {
    const f = fixture(); await f.runtime.tick(); f.open = false; await f.runtime.tick();
    assert.equal(f.runtime.snapshot().reasonCode, 'BROWSER_CLOSED'); assert.equal(f.calls.opens, 1);
    assert.equal(f.calls.claims, 0); assert.equal(f.confirmations.length, 0);
});

test('a member rendered only in the Me menu is confirmed through one permitted interaction', async () => {
    const f = fixture(); await f.runtime.tick(); f.state = { menuIdentity: viewer }; await f.runtime.tick();
    assert.equal(f.menuReads.length, 1); assert.deepEqual(f.permits, [{ kind: 'identity', manual: true }]);
    assert.deepEqual(f.confirmations, [viewer]); assert.equal(f.calls.closes, 0);
});

test('a resting menu permit never blocks later passive identity confirmation or creates a security hold', async () => {
    const f = fixture(); f.menuBlocked = true; await f.runtime.tick(); await f.runtime.tick(); await f.runtime.tick();
    assert.equal(f.menuReads.length, 1); assert.deepEqual(f.holds, []); assert.equal(f.calls.claims, 0);
    f.state = { identity: viewer }; await f.runtime.tick();
    assert.deepEqual(f.confirmations, [viewer]); assert.equal(f.runtime.snapshot().status, 'idle');
    assert.equal(f.calls.opens, 1); assert.equal(f.calls.closes, 0);
});

test('daily cap keeps intent and resume time visible after automatic idle browser closure',async()=>{
 const f=fixture();await f.runtime.tick();f.state={identity:viewer};await f.runtime.tick();f.account.authorized=true;const resumeAt='2026-10-25T23:00:00.000Z';f.limit={limited:true,used:2,limit:2,resumeAt,timezone:'Africa/Casablanca'};await f.runtime.tick();assert.equal(f.runtime.snapshot().status,'DAILY_LIMIT_REACHED');await f.runtime.recycle('idle timeout');assert.equal(f.runtime.snapshot().status,'DAILY_LIMIT_REACHED');assert.equal(f.runtime.snapshot().nextEligibleAt,resumeAt);assert.equal(f.runtime.snapshot().browserOpen,false);assert.equal(f.account.authorized,true);
});

test('manual sign-in hands off to headless processing, and a held account returns to visible manual review only on request',async()=>{
 const f=fixture(),modes=[];f.account.launch_mode='headless';let mode=null;const launch=f.browserOwner.open;f.browserOwner.isHeadless=()=>mode;f.browserOwner.open=async options=>{mode=options.headless;modes.push(mode);return launch();};
 const read=f.reader.readSignedInIdentity;f.reader.readSignedInIdentity=async(page,options)=>options.manual?read(page,options):viewer;
 f.reader.captureProfile=async(_page,url,options)=>{await options.beforeCheck('profile_page');return {url,profileIdentityConfirmed:true,linkedinCapture:{complete:true}};};
 await f.runtime.tick();f.state={identity:viewer};await f.runtime.tick();assert.deepEqual(modes,[false]);
 f.account.authorized=true;f.limit={job:{jobId:'fixture',linkedinUrl:'https://www.linkedin.com/in/fixture/'}};await f.runtime.tick();await f.runtime.drain();assert.deepEqual(modes,[false,true]);assert.equal(f.calls.closes,1);
 await f.runtime.handleSignal(security);assert.equal(f.account.authorized,false);assert.ok(f.account.attention_reason);assert.deepEqual(modes,[false,true]);
 await f.runtime.recycle('review');assert.equal(f.runtime.snapshot().manualResumeRequired,true);assert.equal(f.runtime.snapshot().reasonCode,'LINKEDIN_AUTH');
 f.account.login_token='manual-2';await f.runtime.tick();assert.deepEqual(modes,[false,true,false]);assert.ok(f.account.attention_reason,'opening review alone cannot clear the hold');
 await f.runtime.close();
});

test('password-reset navigation re-arms one manual menu read on the new feed document',async()=>{
 const f=fixture();await f.runtime.tick();await f.runtime.tick();assert.equal(f.menuReads.length,1);
 f.state={url:'https://www.linkedin.com/checkpoint/password-reset/'};f.events.emit('framenavigated',f.page);await f.runtime.tick();assert.ok(f.holds.some(h=>h.attention));
 f.state={url:feed,menuIdentity:viewer};f.events.emit('framenavigated',f.page);await f.runtime.tick();assert.equal(f.menuReads.length,2);assert.deepEqual(f.confirmations,[viewer]);assert.equal(f.runtime.snapshot().status,'idle');assert.equal(f.account.authorized,false);assert.equal(f.calls.claims,0);await f.runtime.close();
});
test('a menu that has not hydrated does not permanently consume the manual identity attempt',async()=>{
 const f=fixture();let attempts=0;const read=f.reader.readSignedInIdentity;f.reader.readSignedInIdentity=async(page,options)=>{if(options.passive)return read(page,options);attempts++;options.onMenuAttempt(attempts>1);if(attempts===1)return null;return read(page,options);};
 await f.runtime.tick();await f.runtime.tick();assert.equal(f.confirmations.length,0);f.state={menuIdentity:viewer};await f.runtime.tick();assert.equal(attempts,2);assert.deepEqual(f.confirmations,[viewer]);assert.equal(f.calls.claims,0);await f.runtime.close();
});
