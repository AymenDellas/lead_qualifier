/* Run: DISCOVERY_TEST_RUNTIME_DIR=<temporary PGlite runtime> node scripts/verify-discovery-calls.cjs
 * Isolated Postgres integration tests. Uses the existing temporary PGlite runtime,
 * never application credentials. --preview exposes only this test database. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...args) {
    if (request.startsWith('@/')) request = path.join(root, 'src', request.slice(2));
    return originalResolve.call(this, request, parent, ...args);
};
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText, filename);

(async () => {
    const runtime = process.env.DISCOVERY_TEST_RUNTIME_DIR;
    assert.ok(runtime, 'Set DISCOVERY_TEST_RUNTIME_DIR to the temporary PGlite runtime.');
    const { PGlite } = require(path.join(runtime, 'node_modules', '@electric-sql', 'pglite'));
    const db = await PGlite.create();
    const query = async (sql, params) => {
        const result = params?.length ? await db.query(sql, params) : (await db.exec(sql)).at(-1);
        return { ...result, rowCount: result?.affectedRows ?? 0 };
    };
    const pool = { connect: async () => ({ query, release() {} }), query };
    const setupPath = path.join(root, 'src/lib/pg_setup.ts');
    require.cache[setupPath] = { id: setupPath, filename: setupPath, loaded: true, exports: { pool } };
    const rawActions = require('../src/app/actions/discovery-call-actions.ts');
    const shared = require('../src/lib/discovery-calls.ts');
    const actions = { ...rawActions };
    for (const name of ['createDiscoveryCallAction', 'saveDiscoveryCallAction', 'saveDiscoveryTemplateAction', 'startDiscoveryOnboardingAction']) {
        actions[name] = async (...args) => shared.unwrapDiscoveryResult(await rawActions[name](...args));
    }
    const business = require('../src/lib/business.ts');
    const { blankCaseStudyProspect } = require('../src/lib/case-study.ts');
    try {
        const initial = await actions.loadDiscoveryCallsAction();
        assert.equal(initial.calls.length, 0);
        assert.equal(initial.template.data.questions.length, 9);
        assert.match(initial.template.data.offerScript, /we’re gonna be building three pillars/);
        assert.equal((await actions.loadDiscoveryCallsAction()).template.revision, 1);
        console.log('PASS additive schema and preferred templates initialize idempotently');

        const sourceId = randomUUID();
        const suppressedId = randomUUID();
        const source = { ...blankCaseStudyProspect('https://www.linkedin.com/in/discovery-test/'), name: 'TEST · Lisa', email: 'lisa@example.com', website: 'https://example.com', headline: 'Executive Coach', stage: 'CALL_BOOKED', notes: 'Travel until October 7', delivery: { ...blankCaseStudyProspect().delivery, discoveryCallAt: '2026-10-07T10:00:00.000Z' } };
        await db.query('INSERT INTO case_study_prospects(id,linkedin_url,data) VALUES($1,$2,$3)', [sourceId, source.linkedinUrl, JSON.stringify(source)]);
        await db.query('INSERT INTO case_study_prospects(id,linkedin_url,data) VALUES($1,$2,$3)', [suppressedId, 'https://www.linkedin.com/in/suppressed-discovery-test/', JSON.stringify({ ...source, stage: 'DO_NOT_CONTACT' })]);
        assert.equal((await actions.loadDiscoveryCallsAction()).sources.length, 1);
        let call = await actions.createDiscoveryCallAction(shared.blankDiscoveryCall(), sourceId);
        assert.equal(call.data.name, source.name);
        assert.match(call.data.context, /Travel until October 7/);
        assert.equal(call.data.scheduledAt, source.delivery.discoveryCallAt);
        assert.equal((await actions.createDiscoveryCallAction(shared.blankDiscoveryCall(), sourceId)).id, call.id);
        await assert.rejects(actions.createDiscoveryCallAction(shared.blankDiscoveryCall(), suppressedId), /no longer available/);
        console.log('PASS prospect context imports, duplicate preparation reopens the call, suppressed prospects stay excluded');

        const update = structuredClone(call.data);
        update.questions.find(q => q.id === 'success').answer = 'More qualified calls';
        update.questions.find(q => q.id === 'offer').answer = 'Executive coaching package';
        update.questions.find(q => q.id === 'buyer').answer = 'Senior leaders';
        update.questions.find(q => q.id === 'preserve').answer = 'Keep the existing logo';
        update.questions.find(q => q.id === 'priority').answer = 'Improve show rate first';
        update.agreedScope = 'Landing page, booking flow, and call reminders';
        update.excludedScope = 'Paid advertising';
        update.notes = 'Client prefers concise messages.';
        update.nextAction = 'Send formal onboarding';
        const staleRevision = call.revision;
        call = await actions.saveDiscoveryCallAction(call.id, update, call.revision);
        assert.equal((await actions.loadDiscoveryCallsAction()).calls[0].data.notes, update.notes);
        await assert.rejects(actions.saveDiscoveryCallAction(call.id, { ...update, notes: 'stale overwrite' }, staleRevision), /another window/);
        assert.equal((await actions.loadDiscoveryCallsAction()).calls[0].data.notes, update.notes);
        await assert.rejects(actions.saveDiscoveryCallAction(call.id, { ...update, website: 'javascript:alert(1)' }, call.revision));
        await assert.rejects(actions.saveDiscoveryCallAction(call.id, { ...update, questions: [...update.questions, update.questions[0]] }, call.revision));
        console.log('PASS persisted answers, stale-save protection, and input validation');

        const template = structuredClone(initial.template.data);
        template.offerScript = 'My saved three-pillar explanation';
        const changed = await actions.saveDiscoveryTemplateAction(template, 1);
        assert.equal(changed.revision, 2);
        await assert.rejects(actions.saveDiscoveryTemplateAction(template, 1), /another window/);
        const manual = await actions.createDiscoveryCallAction({ ...shared.blankDiscoveryCall(changed.data), name: 'TEST · Manual', email: 'manual@example.com' });
        assert.equal(manual.sourceProspectId, null);
        assert.equal(manual.data.offerScript, template.offerScript);
        assert.notEqual(call.data.offerScript, manual.data.offerScript);
        console.log('PASS reusable templates apply to new calls and preserve existing call wording');

        await assert.rejects(actions.startDiscoveryOnboardingAction(call.id, call.revision), /agreed/);
        call = await actions.saveDiscoveryCallAction(call.id, { ...call.data, outcome: 'AGREED' }, call.revision);
        await assert.rejects(actions.startDiscoveryOnboardingAction(call.id, staleRevision), /changed/);
        const project = await actions.startDiscoveryOnboardingAction(call.id, call.revision);
        assert.equal(project.data.onboarding.form.offer, 'Executive coaching package');
        assert.equal(project.data.onboarding.form.audience, 'Senior leaders');
        assert.match(project.data.onboarding.form.desiredOutcome, /More qualified calls/);
        assert.match(project.data.onboarding.form.desiredOutcome, /show rate/);
        assert.equal(project.data.onboarding.scope.included, update.agreedScope);
        assert.equal(project.data.onboarding.scope.excluded, update.excludedScope);
        assert.equal(project.data.onboarding.form.mustStay, 'Keep the existing logo');
        assert.equal(project.data.onboarding.scope.confirmed, false);
        assert.equal(project.data.onboarding.form.caseStudyConsent, false);
        assert.equal(project.data.onboarding.agreement.status, 'DRAFT');
        assert.equal(project.data.onboarding.form.status, 'NOT_SENT');
        assert.match(project.data.brief, /Client prefers concise messages/);
        assert.ok(project.data.onboarding.portalToken);
        assert.equal((await actions.startDiscoveryOnboardingAction(call.id, call.revision)).id, project.id);
        assert.equal((await db.query('SELECT COUNT(*)::int AS count FROM business_projects')).rows[0].count, 1);
        console.log('PASS reviewed onboarding handoff carries the brief, preserves formal approvals, and prevents duplicate projects');

        const noEmail = await actions.createDiscoveryCallAction({ ...shared.blankDiscoveryCall(), name: 'TEST · Missing email', outcome: 'AGREED' });
        const noEmailProject = await actions.startDiscoveryOnboardingAction(noEmail.id, noEmail.revision);
        assert.equal(noEmailProject.data.onboarding.email, '');
        console.log('PASS onboarding handoff accepts an omitted email');

        const emptyCall = await actions.saveDiscoveryCallAction(manual.id, { ...manual.data, questions: [] }, manual.revision);
        assert.deepEqual(emptyCall.data.questions, []);
        assert.deepEqual((await actions.loadDiscoveryCallsAction()).calls.find(item => item.id === manual.id).data.questions, []);
        const emptyTemplate = await actions.saveDiscoveryTemplateAction({ ...template, questions: [] }, changed.revision);
        assert.deepEqual(emptyTemplate.data.questions, []);
        await actions.saveDiscoveryTemplateAction(initial.template.data, emptyTemplate.revision);
        console.log('PASS deleting the final question persists for calls and reusable templates');

        if (process.argv.includes('--preview')) {
            const nextSource = { ...source, name: 'TEST · Upcoming coach', linkedinUrl: 'https://www.linkedin.com/in/discovery-upcoming-test/' };
            await db.query('INSERT INTO case_study_prospects(id,linkedin_url,data) VALUES($1,$2,$3)', [randomUUID(), nextSource.linkedinUrl, JSON.stringify(nextSource)]);
            // Only the isolated database is exposed to the local visual verification server.
            const { PGLiteSocketServer } = require(path.join(runtime, 'node_modules', '@electric-sql', 'pglite-socket'));
            const server = new PGLiteSocketServer({ db, port: 55459, host: '127.0.0.1' });
            await server.start();
            console.log('Discovery TEST database listening on 127.0.0.1:55459.');
            process.on('SIGINT', async () => { await server.stop(); await db.close(); process.exit(0); });
            return;
        }
    } finally { if (!process.argv.includes('--preview')) await db.close(); }
})().catch(error => { console.error(error); process.exit(1); });
