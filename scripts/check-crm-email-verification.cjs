const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../src/lib/crm-email-verification.ts'), 'utf8');
const mod = { exports: {} };
new Function('module', 'exports', ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(mod, mod.exports);
const { verifyCrmEmailBatch, startVerificationRun, addVerificationBatch, getUnknownCause, getUnknownLabel } = mod.exports;

function fixtures(rows, failIds = []) {
    const saved = [];
    let probes = 0;
    return { saved, get probes() { return probes; }, dependencies: {
        getLeads: async ids => rows.filter(row => ids.includes(row.id)).reverse(),
        verify: async emails => { probes++; return emails.map(({ address }) => ({ email: address, status: 'UNKNOWN' })); },
        save: async (id, result) => {
            if (failIds.includes(id)) throw new Error('fixture persistence failure');
            saved.push(id);
            return { ...rows.find(row => row.id === id), email_status: result.status,
                email_verification_reason: 'Server refused our probe — blocked using Spamhaus' };
        },
    } };
}

(async () => {
    // Reproduce the screenshot: 75 processed, 46 actual verdicts, 29 absent emails.
    const rows = Array.from({ length: 94 }, (_, i) => ({ id: String(i), email: i < 29 ? '' : `lead${i}@fixture.test` }));
    const fixture = fixtures(rows);
    fixture.dependencies.verify = async emails => emails.map(({ address }) => ({
        email: address, status: /^lead(?:29|30)@/.test(address) ? 'VALID' : /^lead(?:31|32|33)@/.test(address) ? 'RISKY' : 'UNKNOWN',
    }));
    let run = startVerificationRun(94);
    for (let i = 0; i < 75; i += 25) run = addVerificationBatch(run,
        await verifyCrmEmailBatch(rows.slice(i, i + 25).map(row => row.id), fixture.dependencies));
    assert.equal(run.processed, 75);
    assert.equal(run.valid, 2);
    assert.equal(run.invalid, 0);
    assert.equal(run.risky, 3);
    assert.equal(run.unknown, 41);
    assert.equal(run.noEmail, 29);
    assert.equal(run.valid + run.invalid + run.risky + run.unknown + run.noEmail + run.missing + run.failed, 75);
    run = addVerificationBatch(run, await verifyCrmEmailBatch(rows.slice(75).map(row => row.id), fixture.dependencies));
    assert.equal(run.processed, 94);
    assert.equal(run.unknown, 60);
    assert.equal(run.causes.hostBlocked, 60);
    assert.equal(fixture.saved.length, 65);

    const absent = fixtures([{ id: 'blank', email: '   ' }]);
    const emptyReport = await verifyCrmEmailBatch(['blank', 'missing', 'blank'], absent.dependencies);
    assert.deepEqual(emptyReport.skipped, [{ id: 'blank', reason: 'NO_EMAIL' }, { id: 'missing', reason: 'NOT_FOUND' }]);
    assert.equal(absent.probes, 0, 'No-email selection must not start an SMTP batch');
    assert.equal(absent.saved.length, 0);
    assert.deepEqual(await verifyCrmEmailBatch([], absent.dependencies), { updated: [], skipped: [], failed: [] });

    const partial = fixtures(rows.slice(29, 32), ['30']);
    const partialReport = await verifyCrmEmailBatch(['29', '30', '31'], partial.dependencies);
    assert.deepEqual(partialReport.updated.map(row => row.id), ['29', '31']);
    assert.deepEqual(partialReport.failed.map(row => row.id), ['30']);
    const partialRun = addVerificationBatch(startVerificationRun(3), partialReport);
    assert.equal(partialRun.processed, 3);
    assert.equal(partialRun.failed, 1);
    assert.equal(partialRun.unknown, 2);

    const creditedRun = addVerificationBatch(startVerificationRun(3), {
        updated: [], skipped: [], failed: [], verificationProvider: 'QuickEmailVerification', remainingCredits: 77,
    });
    const afterTimeout = addVerificationBatch(creditedRun, {
        updated: [], skipped: [], failed: [{ id: '30', reason: 'Request timed out' }],
        verificationProvider: 'QuickEmailVerification', remainingCredits: null,
    });
    assert.equal(afterTimeout.remainingCredits, 77, 'A failed response without a credit header retains the last known balance');
    assert.equal(addVerificationBatch(afterTimeout, {
        updated: [], skipped: [], failed: [], verificationProvider: 'QuickEmailVerification', remainingCredits: 0,
    }).remainingCredits, 0, 'An explicit zero balance must still be shown');

    const mismatched = fixtures(rows.slice(29, 31));
    mismatched.dependencies.verify = async () => [{ email: 'someone-else@fixture.test', status: 'VALID' }];
    const mismatchReport = await verifyCrmEmailBatch(['29', '30'], mismatched.dependencies);
    assert.equal(mismatchReport.failed.length, 2);
    assert.equal(mismatched.saved.length, 0, 'Missing/misaligned verdicts must not be saved against another email');

    const failedRequest = fixtures(rows.slice(29, 30));
    failedRequest.dependencies.verify = async () => { throw new Error('SMTP runtime unavailable'); };
    await assert.rejects(verifyCrmEmailBatch(['29'], failedRequest.dependencies), /SMTP runtime unavailable/);
    assert.equal(failedRequest.saved.length, 0);
    await assert.rejects(verifyCrmEmailBatch(Array.from({ length: 101 }, (_, i) => String(i)), fixture.dependencies), /100/);

    for (const [reason, cause] of [
        ['Client host blocked using Spamhaus', 'hostBlocked'],
        ["Zoho does not accept email from dynamic IPs", 'hostBlocked'],
        ['BANNER: DNS-P3 No PTR Record', 'senderIdentity'],
        ['Recipient address rejected: Cannot find your hostname', 'senderIdentity'],
        ['Server refused our probe: SPF rejected', 'senderIdentity'],
        ['421 service unavailable; temporarily deferred', 'temporary'],
        ['SMTP transport error during TLS: certificate mismatch', 'connection'],
        ['SMTP deadline exceeded during BANNER', 'connection'],
        ['DNS timed out', 'dns'],
        ['getaddrinfo ENOTFOUND', 'dns'],
        ['No decisive mailbox reply', 'other'],
    ]) assert.equal(getUnknownCause(reason), cause, reason);
    assert.equal(getUnknownLabel('blocked using Spamhaus'), 'IP BLOCKED');
    assert.equal(getUnknownLabel(null), 'UNKNOWN');
    console.log('CRM verification checks passed: screenshot count gap, missing emails/rows, partial saves, result alignment, request failures, and unknown causes. No live database or mail servers used.');
})().catch(error => { console.error(error); process.exitCode = 1; });
