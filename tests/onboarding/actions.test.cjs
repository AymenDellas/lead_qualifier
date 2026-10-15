const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent, ...rest) {
    return originalResolve.call(this, request.startsWith('@/') ? path.join(root, 'src', request.slice(2)) : request, parent, ...rest);
};
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename);
const stub = (filename, exports) => { require.cache[require.resolve(filename)] = { id: filename, filename, loaded: true, exports }; };
stub('next/cache', { revalidatePath() {} });
let record;
const client = { async query(sql, params) {
    if (sql.startsWith('SELECT p.')) return { rows: [record] };
    if (sql.startsWith('UPDATE business_projects')) { record.data = JSON.parse(params[1]); return { rows: [record] }; }
    throw new Error(`Unexpected SQL in isolated action test: ${sql}`);
} };
stub(path.join(root, 'src/lib/business-store.ts'), { businessTransaction: fn => fn(client), recordActivity: async () => {}, ensureBusinessSchema: async () => {} });
stub(path.join(root, 'src/lib/pg_setup.ts'), { pool: { query: async () => ({ rows: [{ project: record.data, opportunity: record.opportunity, profile: record.profile }] }) } });
const b = require('../../src/lib/business.ts');
const actions = require('../../src/app/actions/business-actions.ts');
const agreementRoute = require('../../src/app/portal/[token]/agreement/route.ts');
const token = '11111111-1111-4111-8111-111111111111';
function reset() {
    const opportunity = { ...b.blankOpportunity(), name: 'Isolated test coach', funnel: 'DIRECT_TO_CALL', mode: 'CASE_STUDY' };
    record = { id: 'test-project', opportunity_id: 'test-opportunity', data: b.buildProject(opportunity, b.DEFAULT_OFFER), opportunity, profile: b.DEFAULT_OFFER };
    record.data.onboarding.portalToken = token;
}

test('portal action saves both new answers and an older cached form cannot erase them', async () => {
    reset();
    const form = new FormData();
    form.set('token', token);
    form.set('intent', 'save');
    form.set('differentiation', 'We use real decisions from the client week.');
    form.set('unsuitableClients', 'People seeking therapy rather than coaching.');
    await actions.saveClientPortalFormAction(form);
    assert.equal(record.data.onboarding.form.differentiation, form.get('differentiation'));
    assert.equal(record.data.onboarding.form.unsuitableClients, form.get('unsuitableClients'));
    form.delete('differentiation');
    form.delete('unsuitableClients');
    await actions.saveClientPortalFormAction(form);
    assert.match(record.data.onboarding.form.differentiation, /real decisions/);
    assert.match(record.data.onboarding.form.unsuitableClients, /therapy/);
});

test('scope confirmation persists the normalized scope that the client reviewed', async () => {
    reset();
    record.data.onboarding.scope.excluded = '';
    record.data.onboarding.scope.dependencies = 'Signed agreement, required payment, completed form, verified access, and baseline capture.';
    const form = new FormData(); form.set('token', token);
    await actions.confirmClientScopeAction(form);
    assert.equal(record.data.onboarding.scope.confirmed, true);
    assert.equal(record.data.onboarding.scope.excluded, b.DEFAULT_SCOPE_EXCLUSIONS);
    assert.equal(record.data.onboarding.scope.dependencies, b.scopeDependencies('CASE_STUDY'));
    assert.equal(b.normalizeOnboarding(record.data).scope.excluded, b.DEFAULT_SCOPE_EXCLUSIONS);
});

test('client PDF preview returns the uploaded signed document unchanged', async () => {
    reset();
    const original = Buffer.from('%PDF-1.4\nOriginal signed agreement\n%%EOF');
    record.data.onboarding.agreement.status = 'FULLY_SIGNED';
    record.data.onboarding.agreement.signedPdfData = `data:application/pdf;base64,${original.toString('base64')}`;
    const response = await agreementRoute.GET(new Request('http://localhost/'), { params: Promise.resolve({ token }) });
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), original);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
});
