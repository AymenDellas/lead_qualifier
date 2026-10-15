const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
function load(file) {
    const mod = { exports: {} };
    const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    new Function('require', 'module', 'exports', code)(name => name === 'server-only' ? {} : require(name), mod, mod.exports);
    return mod.exports;
}
const qev = load('src/lib/quickemailverification.ts');
const persist = load('src/lib/verification-persist.ts');
const proof = load('src/lib/email-verification-proof.ts');
const crm = load('src/lib/crm-email-verification.ts');
const fixture = overrides => ({ success: 'true', email: 'person@fixture.test', result: 'valid', reason: 'accepted_email',
    safe_to_send: 'true', accept_all: 'false', disposable: 'false', role: 'false', free: 'false',
    mx_record: 'mx.fixture.test', mx_domain: 'fixture.test', ...overrides });
const map = overrides => qev.mapQevResult(' Person@Fixture.Test ', fixture(overrides), 99);

(async () => {
    assert.equal(map().status, 'VALID');
    assert.equal(map({ free: 'true' }).status, 'VALID', 'Provider-confirmed safe free-provider mailboxes remain usable');
    assert.equal(map({ success: true, safe_to_send: true, accept_all: false, role: false, disposable: false }).status, 'VALID');
    for (const override of [{ accept_all: 'true' }, { disposable: 'true' }, { role: 'true' },
        { safe_to_send: 'false' }, { safe_to_send: undefined }, { accept_all: undefined }]) {
        const result = map(override);
        assert.equal(result.status, 'RISKY');
        assert.equal(result.safeToSend, false);
        assert.equal(result.expiresAt, undefined);
        assert.notEqual(persist.toPersistedVerification(result).status, 'VALID');
    }
    assert.equal(map({ result: 'invalid', safe_to_send: 'false', reason: 'rejected_email' }).status, 'INVALID');
    assert.equal(persist.toPersistedVerification(map({ result: 'invalid', reason: 'invalid_domain' })).status, 'INVALID');
    assert.equal(map({ result: 'invalid', reason: 'exceeded_storage' }).status, 'RISKY');
    assert.equal(map({ result: 'unknown', reason: 'timeout' }).status, 'UNKNOWN');
    assert.equal(map({ email: 'another@fixture.test' }).stopRun, true);
    assert.throws(() => persist.toPersistedVerification(map({ success: 'false' })), /matching/);
    assert.equal(qev.readQevCredits(new Headers()), null);
    assert.equal(qev.readQevCredits(new Headers({ 'X-QEV-Remaining-Credits': '0' })), 0);
    assert.equal(qev.readQevCredits(new Headers({ 'X-QEV-Remaining-Credits': 'unknown' })), null);

    const saved = persist.toPersistedVerification(map({ free: 'true' }));
    const lead = { email_status: saved.status, email_verification_method: saved.method,
        email_verification_score: saved.score, email_verified_at: saved.checkedAt, email_verification_expires_at: saved.expiresAt };
    assert.equal(proof.hasFreshEmailVerification(lead), true);
    assert.equal(proof.hasFreshEmailVerification({ ...lead, email_verification_method: 'DNS_PREFILTER' }), false);
    assert.equal(proof.hasFreshEmailVerification({ ...lead, email_verification_score: null }), false);
    assert.equal(proof.hasFreshEmailVerification(lead, Date.parse(saved.expiresAt) + 1), false);
    assert.equal(proof.hasExpiredEmailVerification(lead, Date.parse(saved.expiresAt) + 1), true);
    assert.equal(proof.hasFreshEmailVerification({ ...lead, email_verification_method: 'SMTP_DIRECT' }), true);

    process.env.QUICKEMAILVERIFICATION_API_KEY = 'fixture-secret-do-not-echo';
    const realFetch = global.fetch;
    let calls = 0;
    global.fetch = async url => {
        assert.equal(url.origin + url.pathname, 'https://api.quickemailverification.com/v1/verify');
        assert.equal(url.searchParams.get('apikey'), process.env.QUICKEMAILVERIFICATION_API_KEY);
        calls++;
        return new Response(JSON.stringify(fixture({ email: url.searchParams.get('email') })), {
            headers: { 'x-qev-remaining-credits': String(100 - calls) },
        });
    };
    const batch = await qev.verifyQevBatch(['person@fixture.test', { address: 'Other@fixture.test', source: 'crm' },
        { address: 'PERSON@fixture.test', source: 'automation' }]);
    assert.equal(calls, 2, 'One provider credit per unique address');
    assert.deepEqual(batch.map(row => row.email), ['person@fixture.test', 'other@fixture.test', 'person@fixture.test']);
    assert.deepEqual(batch.map(row => row.remainingCredits), [98, 98, 98]);
    assert.equal(batch[1].source, 'crm');
    assert.equal(batch[2].source, 'automation');

    for (const status of [400, 401, 402, 403, 404]) {
        calls = 0;
        global.fetch = async () => { calls++; return new Response('Secret or unsafe error body', {
            status, headers: { 'x-qev-remaining-credits': '0' },
        }); };
        const results = await qev.verifyQevBatch(Array.from({ length: 8 }, (_, i) => `lead${i}@fixture.test`));
        assert.ok(calls <= 2, 'A quota/configuration failure stops requests without retries');
        assert.ok(results.every(row => row.status === 'UNKNOWN' && row.error && row.stopRun));
        assert.ok(results.every(row => !row.reason.includes('Secret') && !row.reason.includes('fixture-secret')));
        let writes = 0;
        const report = await crm.verifyCrmEmailBatch(['existing'], {
            getLeads: async () => [{ id: 'existing', email: results[0].email, email_status: 'VALID' }],
            verify: async () => [results[0]], save: async () => { writes++; },
        });
        assert.equal(writes, 0, 'Provider failures never erase an existing CRM verdict');
        assert.equal(report.failed.length, 1);
        assert.equal(report.remainingCredits, 0);
        assert.equal(report.stopRun, true);
        const run = crm.addVerificationBatch(crm.startVerificationRun(1), report);
        assert.equal(run.remainingCredits, 0);
        assert.equal(run.verificationProvider, 'QuickEmailVerification');
    }
    global.fetch = async () => { throw new Error('fetch URL contains fixture-secret-do-not-echo'); };
    const unavailable = (await qev.verifyQevBatch(['person@fixture.test'], { sleep: async () => {} }))[0];
    assert.ok(!unavailable.reason.includes('fixture-secret'));
    assert.equal(unavailable.stopRun, false, 'An isolated request failure does not stop the list');
    global.fetch = realFetch;
    console.log('QuickEmailVerification checks passed: string/boolean flags, safe exports, risky/invalid/unknown results, credits, deduplication, and failures preserving CRM verdicts. No live credits used.');
})().catch(error => { console.error(error); process.exitCode = 1; });
