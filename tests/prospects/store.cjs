'use strict';
// An isolated PostgreSQL database; no application credentials or outbound calls.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');
const ts = require('typescript');
const { NOW, research, prospect } = require('./fixtures.cjs');
const root = path.resolve(__dirname, '../..');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent, ...args) {
    if (request.startsWith('@/')) request = path.join(root, 'src', request.slice(2));
    return originalResolve.call(this, request, parent, ...args);
};
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText, filename);

(async () => {
    const runtime = process.env.DISCOVERY_TEST_RUNTIME_DIR;
    assert.ok(runtime, 'Set DISCOVERY_TEST_RUNTIME_DIR to the temporary PGlite runtime.');
    const { PGlite } = require(path.join(runtime, 'node_modules/@electric-sql/pglite'));
    const db = await PGlite.create();
    const query = async (sql, params) => {
        const result = params?.length ? await db.query(sql, params) : (await db.exec(sql)).at(-1);
        return { ...result, rowCount: result?.affectedRows ?? 0 };
    };
    const pool = { query, connect: async () => ({ query, release() {} }) };
    Object.defineProperty(require('pg'), 'Pool', { configurable: true, value: class { constructor() { return pool; } } });
    const setup = require('../../src/lib/pg_setup.ts');
    await setup.createSchema();
    const store = require('../../src/lib/prospect-store.ts');
    const q = require('../../src/lib/prospect-qualification.cjs');
    const qualified = require('../../src/app/api/crm/leads/qualified/route.ts');
    const list = require('../../src/app/api/prospects/route.ts');
    const seed = async row => {
        const entries = Object.entries(row);
        await db.query(`INSERT INTO leads (${entries.map(([k]) => k).join(',')}) VALUES (${entries.map((_, i) => '$' + (i + 1)).join(',')})`, entries.map(([, value]) => typeof value === 'object' && value !== null ? JSON.stringify(value) : value));
    };
    const read = async id => (await db.query('SELECT * FROM leads WHERE id=$1', [id])).rows[0];
    const save = (r, extras = {}) => store.saveProspectResearch({ linkedinUrl: r.linkedinUrl, research: r, ...extras });
    const get = (route, params = '') => route.GET(new Request('http://localhost/api/test' + params)).then(r => r.json());
    try {
        await store.ensureProspectSchema(); await store.ensureProspectSchema();
        await db.exec(store.PROSPECT_SCHEMA_SQL);
        console.log('PASS additive schema can be applied repeatedly');
        await seed(prospect('legacy', { linkedin_url: 'https://www.linkedin.com/in/legacy-test', prospect_assessment: null, prospect_researched_at: null }));
        assert.equal((await get(qualified)).count, 1);
        assert.equal((await get(list, '?tier=UNREVIEWED')).total, 1);
        console.log('PASS existing qualified records retain verified-email exports without extra manual research');
        await db.query("UPDATE leads SET do_not_contact=TRUE WHERE id='legacy'");

        let r = research({ linkedinUrl: 'https://www.linkedin.com/in/researched-test' });
        let saved = await save(r);
        assert.equal(saved.pipeline_status, 'QUALIFIED'); assert.equal(saved.prospect_assessment.tier, 'A');
        assert.equal(saved.email_status, 'UNVERIFIED'); assert.equal(saved.email_verification_method, null);
        assert.equal((await get(qualified)).count, 0);
        await db.query("UPDATE leads SET email_status='VALID',email_verification_method='SMTP_DIRECT',email_verification_score=98,email_verified_at=$2,email_verification_expires_at=$3 WHERE id=$1", [saved.id, new Date().toISOString(), new Date(Date.now() + 86400000).toISOString()]);
        assert.equal((await get(qualified)).count, 1);
        console.log('PASS business qualification does not forge mailbox proof; only fresh direct proof enters the send list');

        const review = await store.saveProspectReview(saved.id, { facts: { paidOffer: { state: 'UNKNOWN', note: '' } }, contactOwnership: 'CONFIRMED', note: 'The coach personally confirmed this exact inbox in our conversation.' }, NOW);
        assert.equal(review.pipeline_status, 'NOT_QUALIFIED'); assert.equal(review.prospect_review.contactEmail, saved.email);
        await assert.rejects(store.saveProspectReview(saved.id, { facts: {} }, NOW), /another window/);
        const restored = await store.saveProspectReview(saved.id, { facts: {} }, NOW, review.prospect_review.reviewedAt);
        assert.equal(restored.prospect_assessment.tier, 'A');
        assert.equal(restored.email_verification_method, 'SMTP_DIRECT');
        console.log('PASS removing manual overrides restores original evidence and stale reviews cannot overwrite newer ones');

        const override = await store.saveProspectReview(saved.id, { facts: { paidOffer: { state: 'UNKNOWN', note: '' } } }, NOW, restored.prospect_review.reviewedAt);
        const nextDate = new Date(Date.parse(NOW) + 1000).toISOString();
        r = { ...r, researchedAt: nextDate };
        saved = await save(r);
        assert.equal(saved.prospect_review.reviewedAt, override.prospect_review.reviewedAt);
        assert.equal(saved.prospect_assessment.tier, 'B');
        await assert.rejects(store.saveProspectReview(saved.id, { facts: {} }, NOW, override.prospect_review.reviewedAt), /researched again/);
        console.log('PASS fresh research retains intentional review decisions and rejects stale research saves');

        await db.query("UPDATE leads SET contacted=TRUE,contacted_source='MANUAL',do_not_contact=TRUE,hook='existing content',outcome='legacy outcome' WHERE id=$1", [saved.id]);
        const newAddress = 'new@avamorgan.test';
        saved = await save({ ...r, contacts: [{ address: newAddress, url: r.website, ownership: 'DOMAIN_MATCH', source: 'website' }] }, { email: newAddress });
        assert.equal(saved.email, newAddress); assert.equal(saved.email_verification_method, null); assert.equal(saved.email_verification_score, null);
        assert.equal(saved.contacted, true); assert.equal(saved.do_not_contact, true); assert.equal(saved.hook, 'existing content'); assert.equal(saved.outcome, 'legacy outcome');
        assert.equal((await get(list, '?tier=ALL&includeManaged=true')).leads.some(l => l.id === saved.id), false);
        console.log('PASS address changes revoke proof; suppression, contact history and unrelated fields survive research');

        const noEmail = await save(research({ linkedinUrl: 'https://www.linkedin.com/in/no-email-test', contacts: [] }));
        assert.equal(noEmail.prospect_assessment.tier, 'A'); assert.equal(noEmail.email, ''); assert.equal(noEmail.prospect_assessment.contact.channel, 'LINKEDIN_ONLY');
        const guessedResearch = research({ linkedinUrl: 'https://www.linkedin.com/in/guessed-email-test', contacts: [{ address: 'guess@avamorgan.test', url: 'https://avamorgan.test', ownership: 'GUESSED', source: 'pattern_guess' }] });
        await seed(prospect('guessed', { linkedin_url: guessedResearch.linkedinUrl, email: 'guess@avamorgan.test', prospect_assessment: q.assessProspect(guessedResearch, { email: 'guess@avamorgan.test', emailProven: true }) }));
        const riskyResearch = research({ linkedinUrl: 'https://www.linkedin.com/in/risky-test', contacts: [{ address: 'risk@avamorgan.test', url: 'https://avamorgan.test', ownership: 'DOMAIN_MATCH', source: 'website' }] });
        await seed(prospect('risky', { linkedin_url: riskyResearch.linkedinUrl, email: 'risk@avamorgan.test', email_status: 'RISKY', email_verification_reason: 'Catch-all recipient accepted', prospect_assessment: q.assessProspect(riskyResearch, { email: 'risk@avamorgan.test' }) }));
        assert.equal((await get(qualified)).count, 0);
        assert.deepEqual((await get(qualified, '?include=risky,unverifiable')).data.map(l => l.id), ['risky']);
        console.log('PASS contactless practices remain prospects; optional email tiers cannot bypass ownership or business fit');

        await seed(prospect('career', { linkedin_url: 'https://www.linkedin.com/in/career-test', email: '', prospect_assessment: q.assessProspect(research({ segments: ['CAREER'], segment: 'CAREER', contacts: [] })) }));
        const career = await get(list, '?tier=A&segment=CAREER');
        assert.equal(career.total, 1); assert.equal(career.counts.A, 1); assert.equal(career.leads[0].id, 'career');
        const missing = await get(list, '?tier=A&search=NoSuchCoach'); assert.equal(missing.total, 0);
        const invalid = await list.GET(new Request('http://localhost/api/test?tier=wrong')); assert.equal(invalid.status, 400);
        await assert.rejects(save(research({ linkedinUrl: 'https://www.linkedin.com/in/another' }), { linkedinUrl: 'https://www.linkedin.com/in/mismatch' }), /does not match/);
        console.log('PASS shortlist segmentation, searching, counts and profile identity validation');

        let probeCount = 0, probeReturnsProof = false;
        const verifierPath = path.join(root, 'src/app/actions/email-verifier-actions.ts');
        require.cache[verifierPath] = { id: verifierPath, filename: verifierPath, loaded: true, exports: { verifyEmail: async email => {
            probeCount++;
            if (!probeReturnsProof) throw new Error('TEST SMTP host is unavailable');
            return { email, status: 'VALID', method: 'SMTP_DIRECT', reason: 'TEST recipient accepted and random control rejected', score: 98,
                checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(), checks: { smtpValid: true, catchAll: false } };
        } } };
        const arrival = require('../../src/app/api/prospects/research-result/route.ts');
        const postedResearch = research({ linkedinUrl: 'https://www.linkedin.com/in/arrival-test' });
        const post = () => arrival.POST(new Request('http://localhost/api/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ linkedinUrl: postedResearch.linkedinUrl, research: postedResearch }) }));
        const unavailableProbe = await (await post()).json();
        assert.equal(unavailableProbe.ok, true); assert.equal(unavailableProbe.tier, 'A');
        assert.equal(unavailableProbe.assessment.contact.channel, 'EMAIL_NEEDS_VERIFICATION');
        probeReturnsProof = true; const proven = await (await post()).json();
        assert.equal(proven.assessment.contact.channel, 'EMAIL_READY');
        await post(); assert.equal(probeCount, 2);
        console.log('PASS worker arrival API saves business evidence through probe failures, persists real proof and avoids duplicate fresh probes');

        const stale = prospect('stale', { linkedin_url: 'https://www.linkedin.com/in/stale-test', email: 'stale@avamorgan.test', prospect_assessment: { ...prospect('unused').prospect_assessment, researchedAt: '2024-01-01T12:00:00.000Z', research: research({ researchedAt: '2024-01-01T12:00:00.000Z' }), baseResearch: research({ researchedAt: '2024-01-01T12:00:00.000Z' }) }, prospect_researched_at: '2024-01-01T12:00:00.000Z' });
        await seed(stale);
        assert.equal((await get(list, '?tier=A')).leads.some(l => l.id === stale.id), false);
        const staleList = await get(list, '?tier=B&search=stale-test'); assert.equal(staleList.total, 1);
        assert.equal(staleList.leads[0].prospect_assessment.tier, 'B');
        assert.equal((await get(qualified)).data.some(l => l.id === stale.id), false);
        console.log('PASS expired business evidence is consistently excluded from Contact now counts, filters and send exports');

        await seed(prospect('url-variant', { linkedin_url: 'https://uk.linkedin.com/in/VARIANT-test/?trk=legacy', do_not_contact: true, prospect_assessment: null }));
        const variant = await save(research({ linkedinUrl: 'https://www.linkedin.com/in/variant-test' }));
        assert.equal(variant.id, 'url-variant'); assert.equal(variant.do_not_contact, true);
        const { normaliseLinkedinUrl } = require('../../src/lib/utils.ts');
        assert.equal(normaliseLinkedinUrl('https://not-linkedin.com/in/ava'), null);
        console.log('PASS URL variants reuse the existing person and preserve suppression instead of creating a clean duplicate');

        if (process.argv.includes('--preview')) {
            await db.query('DELETE FROM leads');
            const rows = [
                prospect('preview-executive', { first_name: 'TEST · Ava', last_name: 'Morgan' }),
                prospect('preview-career', { linkedin_url: 'https://www.linkedin.com/in/test-jordan-career', first_name: 'TEST · Jordan', last_name: 'Reed', email: '', discovery_niche: 'Career Coach', prospect_assessment: q.assessProspect(research({ segments: ['CAREER'], segment: 'CAREER', headline: 'Independent Career Coach', contacts: [] })) }),
                prospect('preview-business', { linkedin_url: 'https://www.linkedin.com/in/test-business', first_name: 'TEST · Sam', last_name: 'Lane', discovery_niche: 'Business Coach', prospect_assessment: q.assessProspect(research({ segments: ['BUSINESS'], segment: 'BUSINESS', headline: 'Independent Business Coach', facts: { ...research().facts, clientProof: q.emptyFact() } })) }),
                prospect('preview-nurture', { linkedin_url: 'https://www.linkedin.com/in/test-nurture', first_name: 'TEST · Robin', last_name: 'Park', prospect_assessment: q.assessProspect(research({ facts: { ...research().facts, paidOffer: q.makeFact('NEGATIVE', 'Practice in preparation', 'An explicit statement describes a planned practice.', research().facts.paidOffer.evidence) } })) }),
                prospect('preview-unreviewed', { linkedin_url: 'https://www.linkedin.com/in/test-unreviewed', first_name: 'TEST · Casey', last_name: 'Quinn', prospect_assessment: null, prospect_researched_at: null }),
            ];
            for (const row of rows) await seed(row);
            const { PGLiteSocketServer } = require(path.join(runtime, 'node_modules/@electric-sql/pglite-socket'));
            const server = new PGLiteSocketServer({ db, port: 55461, host: '127.0.0.1', maxConnections: 40 });
            await server.start();
            console.log('Prospect TEST database listening on 127.0.0.1:55461. All rows are fixtures.');
            process.on('SIGINT', async () => { await server.stop(); await db.close(); process.exit(0); });
            return;
        }
    } finally { if (!process.argv.includes('--preview')) await db.close(); }
})().catch(error => { console.error(error); process.exit(1); });
