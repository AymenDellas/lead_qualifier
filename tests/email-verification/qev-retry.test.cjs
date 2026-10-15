'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const timeouts = [];
function load(file) {
    const mod = { exports: {} };
    const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../..', file), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    new Function('require', 'module', 'exports', 'AbortSignal', code)(
        name => name === 'server-only' ? {} : require(name), mod, mod.exports,
        { timeout: ms => { timeouts.push(ms); return new AbortController().signal; } },
    );
    return mod.exports;
}
const qev = load('src/lib/quickemailverification.ts');
const crm = load('src/lib/crm-email-verification.ts');
const fixtureKey = 'test-secret-never-displayed';
function runtime(fetch, extra = {}) {
    process.env.QUICKEMAILVERIFICATION_API_KEY = fixtureKey;
    return { fetch, sleep: async () => {}, ...extra };
}
function verdict(url, extra = {}, credits = 99) {
    return new Response(JSON.stringify({ success: 'true', email: url.searchParams.get('email'),
        result: 'valid', reason: 'accepted_email', safe_to_send: 'true', accept_all: 'false',
        disposable: 'false', role: 'false', free: 'false', mx_record: 'mx.fixture.test', ...extra }),
        { headers: { 'x-qev-remaining-credits': String(credits) } });
}

test('a temporary timeout is retried once with longer patience and keeps the provider verdict', async () => {
    let calls = 0;
    timeouts.length = 0;
    const results = await qev.verifyQevBatch(['person@fixture.test'], runtime(async url => {
        calls++;
        if (calls === 1) throw new DOMException('Request timed out', 'TimeoutError');
        return verdict(url);
    }));
    assert.equal(calls, 2); assert.deepEqual(timeouts, [45000, 45000]);
    assert.equal(results[0].status, 'VALID'); assert.equal(results[0].error, undefined);
    assert.equal(results[0].remainingCredits, 99);
});

test('a 470-row CRM run continues after the twentieth row times out and preserves saved results', async () => {
    const rows = Array.from({ length: 470 }, (_, i) => ({ id: String(i), email: `lead${i}@fixture.test`, email_status: 'UNVERIFIED' }));
    rows[20].email_status = 'RISKY';
    const byId = new Map(rows.map(row => [row.id, row]));
    const selected = new Set(byId.keys()), saved = [];
    let calls = 0, failedCalls = 0, active = 0, maxActive = 0;
    const options = runtime(async url => {
        calls++; active++; maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setImmediate(resolve));
        active--;
        if (url.searchParams.get('email') === 'lead20@fixture.test') {
            failedCalls++; throw new Error(`fetch failed for a URL containing ${fixtureKey}`);
        }
        return verdict(url, {}, 2000 - calls);
    });
    let run = crm.startVerificationRun(rows.length);
    for (let i = 0; i < rows.length; i += 4) {
        const report = await crm.verifyCrmEmailBatch(rows.slice(i, i + 4).map(row => row.id), {
            getLeads: async ids => ids.map(id => byId.get(id)),
            verify: emails => qev.verifyQevBatch(emails, options),
            save: async (id, result) => {
                saved.push(id);
                const updated = { ...byId.get(id), email_status: result.status };
                byId.set(id, updated); return updated;
            },
        });
        assert.equal(report.stopRun, false);
        for (const row of [...report.updated, ...report.skipped]) selected.delete(row.id);
        run = crm.addVerificationBatch(run, report);
        assert.ok(report.failed.every(row => !row.reason.includes(fixtureKey)));
    }
    assert.equal(calls, 471); assert.equal(failedCalls, 2); assert.equal(maxActive, 2);
    assert.equal(saved.length, 469); assert.equal(run.processed, 470);
    assert.equal(run.valid, 469); assert.equal(run.unknown, 0); assert.equal(run.failed, 1);
    assert.deepEqual([...selected], ['20']);
    assert.equal(byId.get('20').email_status, 'RISKY', 'A transport failure cannot overwrite an existing verdict');
    assert.ok(run.remainingCredits > 0);
});

test('temporary HTTP failures recover, but successful unknown mailbox verdicts are not rechecked', async () => {
    for (const status of [408, 500, 502, 503, 504]) {
        let calls = 0;
        const [result] = await qev.verifyQevBatch(['person@fixture.test'], runtime(async url => {
            calls++;
            return calls === 1 ? new Response('Unavailable', { status }) : verdict(url);
        }));
        assert.equal(calls, 2); assert.equal(result.status, 'VALID');
    }
    let calls = 0;
    const [unknown] = await qev.verifyQevBatch(['person@fixture.test'], runtime(async url => {
        calls++; return verdict(url, { result: 'unknown', reason: 'timeout', safe_to_send: 'false' });
    }));
    assert.equal(calls, 1); assert.equal(unknown.status, 'UNKNOWN'); assert.equal(unknown.error, undefined);
});

test('rate limits respect Retry-After, and a long cooldown pauses new requests', async () => {
    let calls = 0; const delays = [];
    const [result] = await qev.verifyQevBatch(['person@fixture.test'], runtime(async url => {
        calls++;
        return calls === 1 ? new Response('Rate limit', { status: 429, headers: { 'retry-after': '3' } }) : verdict(url);
    }, { sleep: async ms => { delays.push(ms); } }));
    assert.deepEqual(delays, [3000]); assert.equal(calls, 2); assert.equal(result.status, 'VALID');
    calls = 0;
    const [paused] = await qev.verifyQevBatch(['person@fixture.test'], runtime(async () => {
        calls++; return new Response('Rate limit', { status: 429, headers: { 'retry-after': '120' } });
    }, { sleep: async () => assert.fail('A long cooldown must not block the action') }));
    assert.equal(calls, 1); assert.equal(paused.stopRun, true); assert.ok(paused.error);
});

test('a sustained outage pauses before sending requests for the rest of the list', async () => {
    let calls = 0;
    const results = await qev.verifyQevBatch(Array.from({ length: 30 }, (_, i) => `lead${i}@fixture.test`), runtime(async () => {
        calls++; return new Response('Unsafe body', { status: 503 });
    }));
    assert.ok(calls <= 8, `Unexpectedly sent ${calls} requests`);
    assert.equal(results.length, 30); assert.ok(results.every(row => row.error && row.status === 'UNKNOWN'));
    assert.ok(results.some(row => row.stopRun));
    assert.ok(results.every(row => !row.reason.includes('Unsafe body')));
});

test('quota and configuration errors stop without retrying or leaking provider error bodies', async () => {
    for (const status of [400, 401, 402, 403, 404]) {
        let calls = 0;
        const [result] = await qev.verifyQevBatch(['person@fixture.test'], runtime(async () => {
            calls++; return new Response(`secret ${fixtureKey}`, { status, headers: { 'x-qev-remaining-credits': '0' } });
        }));
        assert.equal(calls, 1); assert.equal(result.stopRun, true); assert.equal(result.remainingCredits, 0);
        assert.ok(!result.error.includes(fixtureKey));
    }
});

test('the action deadline caps retry patience and leaves unchecked addresses retryable', async () => {
    let clock = 0, calls = 0; timeouts.length = 0;
    const [result] = await qev.verifyQevBatch(['person@fixture.test'], runtime(async url => {
        calls++;
        if (calls === 1) { clock = 238000; return new Response('Unavailable', { status: 503 }); }
        return verdict(url);
    }, { now: () => clock, sleep: async ms => { clock += ms; } }));
    assert.equal(result.status, 'VALID'); assert.deepEqual(timeouts, [45000, 1000]);
    clock = 0; calls = 0;
    const expired = await qev.verifyQevBatch(['first@fixture.test', 'next@fixture.test', 'last@fixture.test'], runtime(async url => {
        calls++; clock = 240000; return verdict(url);
    }, { now: () => clock }));
    assert.equal(calls, 1); assert.equal(expired[0].status, 'VALID');
    assert.ok(expired.slice(1).every(row => row.stopRun && row.error));
});

test('duplicates keep their source and consume one successful provider check', async () => {
    let calls = 0;
    const results = await qev.verifyQevBatch([{ address: 'Person@fixture.test', source: 'crm' },
        { address: 'person@fixture.test', source: 'worker' }], runtime(async url => { calls++; return verdict(url); }));
    assert.equal(calls, 1); assert.deepEqual(results.map(row => row.source), ['crm', 'worker']);
    assert.ok(results.every(row => row.status === 'VALID'));
});
