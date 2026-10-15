const assert = require('node:assert/strict');
const { analyzeFunnelHtml, analyzeFunnelPages, buildOutreach, scoreProspect } = require('../case-study-engine.cjs');
const {
    detectHumanCheck,
    extractContactWebsites,
    extractFeaturedWebsites,
    normalizeWebsiteCandidate,
    qualifyHeadline,
} = require('../case-study-worker-core.cjs');

assert.equal(qualifyHeadline('Executive Coach for SaaS founders').qualified, true);
assert.deepEqual(qualifyHeadline('Fractional CFO for growing companies').matches, []);
assert.equal(qualifyHeadline('Professional Football Coach').qualified, false);
assert.match(qualifyHeadline('Professional Football Coach').reason, /sports coaching/i);
assert.match(detectHumanCheck('Just a moment...', 'Checking your browser'), /Cloudflare/i);
assert.equal(
    normalizeWebsiteCandidate('https://scale_400_400/B4EZ1um41vJAAg-/0/1775677183308?e=1791417600&v=beta'),
    '',
);
assert.deepEqual(
    extractContactWebsites({
        data: { websites: [{ url: 'https://coach-example.com/work-with-me' }] },
        included: [{ vectorImage: { rootUrl: 'https://media.licdn.com/dms/image/' }, artifacts: [{ fileIdentifyingUrlPathSegment: 'scale_400_400/B4EZ1' }] }],
    }),
    ['https://coach-example.com/work-with-me'],
);
assert.deepEqual(
    extractContactWebsites({
        data: { websites: [{ label: 'https://coach-label.example/services' }, { label: 'Company website' }] },
    }),
    ['https://coach-label.example/services'],
);
assert.deepEqual(
    extractFeaturedWebsites({ image: 'https://media.licdn.com/dms/image/example.png', navigationUrl: 'https://coach-example.com/program' }),
    ['https://coach-example.com/program'],
);
assert.equal(
    normalizeWebsiteCandidate('https://www.linkedin.com/redir/redirect?url=https%3A%2F%2Fcoach-example.com%2Fabout'),
    'https://coach-example.com/about',
);

const html = `
<html>
  <head><title>Sarah Jones Coaching</title></head>
  <body>
    <h1>Unlock your potential</h1>
    <p>Private executive coaching for leaders.</p>
    <a href="https://calendly.com/sarah/strategy">Book a call</a>
  </body>
</html>`;
const analysis = analyzeFunnelHtml(html, 'https://sarah.example');
assert.ok(analysis.observations.some((item) => item.id === 'VAGUE_HERO'));
assert.ok(analysis.observations.some((item) => item.id === 'DIRECT_CALENDAR'));
assert.ok(analysis.observations.some((item) => item.id === 'NO_NURTURE'));

const multiPage = analyzeFunnelPages([
    { url: 'https://sarah.example', html: '<h1>Executive coaching for leaders ready to grow revenue</h1><a href="/coaching">Coaching</a>' },
    { url: 'https://sarah.example/coaching', html: '<h2>Private coaching program</h2><p>Subscribe for the free guide.</p><form><input type="email"></form><p>Client testimonial</p><p>Client results increased 40%</p>' },
]);
assert.equal(multiPage.signals.hasOptIn, true);
assert.ok(multiPage.signals.proofCount >= 2);
assert.ok(!multiPage.observations.some((item) => item.id === 'NO_NURTURE'));
assert.ok(!multiPage.observations.some((item) => item.id === 'WEAK_PROOF'));

const oxanaRegression = analyzeFunnelPages([{
    url: 'https://oxanawillekecoaching.com/',
    evidenceSource: 'RENDERED_DOM',
    heroText: 'Stop The Job Search Overwhelm. Start Getting Offers.',
    visibleLinks: [{ href: 'https://calendly.com/oksanka/discovery-call', text: 'BOOK YOUR FREE JOB SEARCH STRATEGY CALL', top: 963 }],
    html: '<h1>Ready to attract recruiters your way?</h1><p>FREE LinkedIn Optimization Guide</p>',
}]);
assert.equal(oxanaRegression.hero, 'Stop The Job Search Overwhelm. Start Getting Offers.');
assert.ok(!oxanaRegression.observations.some((item) => item.id === 'VAGUE_HERO'));
assert.ok(oxanaRegression.observations.some((item) => item.id === 'DIRECT_CALENDAR'));

const eagleGreyRegression = analyzeFunnelPages([{
    url: 'http://www.eaglegrey.com/',
    evidenceSource: 'RENDERED_DOM',
    heroText: 'Elevate your leadership presence, cultivate authority, and secure your next Executive role.',
    visibleLinks: [{ href: 'https://calendly.com/ricksears/call', text: 'Complimentary 30-Minute Transition Strategy Consult', top: 602 }],
    html: '<title>EagleGrey - Executive Level Career Transition</title><p>Executive Transition Program</p>',
}]);
assert.equal(eagleGreyRegression.hero, 'Elevate your leadership presence, cultivate authority, and secure your next Executive role.');
assert.ok(!eagleGreyRegression.observations.some((item) => ['NO_H1', 'VAGUE_HERO'].includes(item.id)));

const namedHeroRegression = analyzeFunnelPages([{
    url: 'https://drmollymcq.com/',
    evidenceSource: 'RENDERED_DOM',
    heroText: 'DR. MOLLY MCQUEARY, CMPC',
    heroContext: 'DR. MOLLY MCQUEARY, CMPC — SPORT AND PERFORMANCE PSYCHOLOGY COACH FOR HIGH PERFORMING INDIVIDUALS AND ORGANIZATIONS. I help athletes and leaders reach the next level.',
    html: '<h1>DR. MOLLY MCQUEARY, CMPC</h1>',
}]);
assert.ok(!namedHeroRegression.observations.some((item) => item.id === 'VAGUE_HERO'));

const rawFallbackRegression = analyzeFunnelPages([{
    url: 'https://builder.example/',
    evidenceSource: 'HTTP_HTML',
    html: '<h1>Old hidden builder headline</h1><p>Executive coaching program</p>',
}]);
assert.ok(!rawFallbackRegression.observations.some((item) => ['NO_H1', 'VAGUE_HERO'].includes(item.id)));

const caseStudy = scoreProspect({
    headline: 'Executive Coach',
    location: 'London, United Kingdom',
    website: 'https://sarah.example',
    source: 'ENGAGER',
    mode: 'CASE_STUDY',
    analysis,
});
assert.equal(caseStudy.coachFit, 'YES');
assert.ok(caseStudy.scores.total >= 80);
assert.equal(
    caseStudy.scores.total,
    caseStudy.scores.icpFit + caseStudy.scores.warmth + caseStudy.scores.funnelWeakness + caseStudy.scores.commercialPotential,
);

const client = scoreProspect({
    headline: 'Executive Coach',
    location: 'London, United Kingdom',
    website: 'https://sarah.example',
    source: 'ENGAGER',
    mode: 'CLIENT',
    analysis,
});
assert.ok(client.scores.commercialPotential > caseStudy.scores.commercialPotential);
assert.ok(client.scores.warmth < caseStudy.scores.warmth);

const outreach = buildOutreach(
    {
        firstName: 'Sarah',
        website: 'https://sarah.example',
        source: 'ENGAGER',
        mode: 'CASE_STUDY',
        analysis,
    },
    caseStudy,
);
assert.match(outreach.suggestedDm, /Unlock your potential/i);
assert.match(outreach.suggestedDm, /short Loom/i);
assert.doesNotMatch(outreach.suggestedDm, /I help coaches increase conversions/i);

console.log('Case Study Hunter engine checks passed.');

async function databaseChecks() {
    const fs = require('node:fs');
    const path = require('node:path');
    const Module = require('node:module');
    const ts = require('typescript');
    const runtime = process.env.CASE_STUDY_TEST_RUNTIME_DIR;
    if (!runtime) throw new Error('Set CASE_STUDY_TEST_RUNTIME_DIR to a temporary npm project containing @electric-sql/pglite.');
    const root = path.resolve(__dirname, '..');
    const originalCwd = process.cwd();
    // Queue-action fixtures must never write jobs for the user's live worker.
    const testWorkspace = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'compel-qualification-test-'));
    process.chdir(testWorkspace);
    const originalResolve = Module._resolveFilename;
    Module._resolveFilename = function (request, parent, ...args) {
        if (request.startsWith('@/')) request = path.join(root, 'src', request.slice(2));
        return originalResolve.call(this, request, parent, ...args);
    };
    require.extensions['.ts'] = (module, filename) => module._compile(
        ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2022,
                esModuleInterop: true,
            },
        }).outputText,
        filename,
    );
    const { PGlite } = require(path.join(runtime, 'node_modules', '@electric-sql', 'pglite'));
    const db = await PGlite.create();
    const query = async (sql, params) => {
        const result = params?.length ? await db.query(sql, params) : (await db.exec(sql)).at(-1);
        return { ...result, rowCount: result?.affectedRows ?? 0 };
    };
    const pool = { connect: async () => ({ query, release() {} }), query };
    const setupPath = path.join(root, 'src', 'lib', 'pg_setup.ts');
    require.cache[setupPath] = { id: setupPath, filename: setupPath, loaded: true, exports: { pool } };
    const store = require('../src/lib/case-study-store.ts');
    const actions = require('../src/app/actions/case-study-actions.ts');
    try {
        assert.equal((await actions.loadCaseStudyAction()).prospects.length, 0);
        const job = {
            linkedinUrl: 'https://www.linkedin.com/in/sarah-jones/',
            source: 'ENGAGER',
            mode: 'CASE_STUDY',
            warmthEvidence: 'Commented on the pricing post.',
            targetTitles: ['Executive Coach'],
        };
        const result = {
            url: job.linkedinUrl,
            firstName: 'Sarah',
            lastName: 'Jones',
            headline: 'Executive Coach',
            location: 'London, United Kingdom',
            website: 'https://sarah.example',
            primaryEmail: 'sarah@sarah.example',
            status: 'QUALIFIED',
            caseStudy: {
                coachFit: 'YES',
                headlineQualification: { qualified: true, matches: ['Executive Coach'], reason: 'Matched Executive Coach in the LinkedIn headline.' },
                websiteScan: { method: 'FOUND', pages: [], challenge: '', completedAt: new Date().toISOString() },
                scores: { icpFit: 35, warmth: 18, funnelWeakness: 22, commercialPotential: 12, total: 87 },
                observations: [{ id: 'VAGUE_HERO', label: 'Vague hero', evidence: 'The hero says “Unlock your potential”.', url: 'https://sarah.example', severity: 8 }],
                whyContact: 'Warm executive coach with a visible funnel leak.',
                mainWeakness: 'Vague hero',
                outreachAngle: 'The hero does not make the offer clear.',
                suggestedDm: 'Hey Sarah — I noticed the hero does not make the offer clear.',
                recommendedNextAction: 'DM now',
            },
        };
        let prospect = await store.upsertCaseStudyWorkerResult(job, result);
        assert.equal(prospect.data.stage, 'QUALIFIED');
        assert.equal(prospect.data.scores.total, 0);
        assert.deepEqual(prospect.data.observations, []);
        assert.equal(prospect.data.suggestedDm, '');
        assert.equal(prospect.data.headlineQualification.qualified, true);
        assert.equal(prospect.data.websiteScan.method, 'FOUND');
        assert.equal(prospect.data.website, 'https://sarah.example/');
        const existingUrls = await store.findExistingCaseStudyLinkedinUrls([
            'https://www.linkedin.com/in/SARAH-JONES/',
            'https://www.linkedin.com/in/not-seen-before/',
        ]);
        assert.deepEqual(existingUrls, [job.linkedinUrl]);
        const duplicateQueue = await actions.queueCaseStudyProspectsAction({
            urls: [job.linkedinUrl],
            source: 'CONNECTION',
            mode: 'CASE_STUDY',
            warmthEvidence: 'Existing connection.',
            targetTitles: ['Executive Coach'],
        });
        assert.equal(duplicateQueue.queued.length, 0);
        assert.deepEqual(duplicateQueue.skipped, [job.linkedinUrl]);
        prospect = await actions.saveCaseStudyProspectAction(
            prospect.id,
            { ...prospect.data, stage: 'MESSAGED' },
            prospect.revision,
        );
        assert.match(prospect.data.nextAction, /Follow up/);
        assert.equal(prospect.activity.kind, 'STAGE');
        assert.match(prospect.activity.note, /Qualified.*Messaged/);
        assert.ok(Date.parse(prospect.data.nextActionDueAt) - Date.parse(prospect.data.lastContactedAt) === 48 * 3600000);
        await assert.rejects(
            actions.saveCaseStudyProspectAction(prospect.id, prospect.data, prospect.revision - 1),
            /another window/,
        );
        prospect = await actions.saveCaseStudyProspectAction(
            prospect.id,
            { ...prospect.data, stage: 'REPLIED' },
            prospect.revision,
        );
        assert.equal(prospect.data.nextAction, 'Send the specific Loom / audit now');
        const before = ['https://sarah.example/before.png'];
        prospect = await actions.saveCaseStudyProspectAction(
            prospect.id,
            {
                ...prospect.data,
                stage: 'CASE_STUDY_AGREED',
                delivery: { ...prospect.data.delivery, beforeScreenshots: before },
            },
            prospect.revision,
        );
        prospect = await store.upsertCaseStudyWorkerResult(job, { ...result, status: 'REVIEW' });
        assert.equal(prospect.data.stage, 'CASE_STUDY_AGREED');
        assert.deepEqual(prospect.data.delivery.beforeScreenshots, before);
        prospect = await actions.saveCaseStudyProspectAction(
            prospect.id,
            {
                ...prospect.data,
                stage: 'TESTIMONIAL_RESULTS',
                delivery: { ...prospect.data.delivery, caseStudyUrl: 'https://getcompel.co/case-studies/sarah' },
            },
            prospect.revision,
        );
        const clientProspect = await store.upsertCaseStudyWorkerResult(
            { ...job, linkedinUrl: 'https://www.linkedin.com/in/tom-smith/', mode: 'CLIENT', source: 'CONNECTION' },
            {
                ...result,
                url: 'https://www.linkedin.com/in/tom-smith/',
                firstName: 'Tom',
                lastName: 'Smith',
                caseStudy: { ...result.caseStudy, outreachAngle: 'The hero hides the coaching offer.' },
            },
        );
        assert.equal(clientProspect.data.suggestedDm, '');
        assert.equal(clientProspect.data.outreachAngle, '');
        const { buildHunterDailyPlan } = require('../src/lib/case-study.ts');
        assert.ok(buildHunterDailyPlan([clientProspect]).message.some((row) => row.id === clientProspect.id));
        await actions.addCaseStudyNoteAction(prospect.id, 'Call confirmed.');
        const snapshot = await actions.loadCaseStudyAction();
        assert.ok(snapshot.activities.some((activity) => activity.note === 'Call confirmed.'));
        // The CRM outreach exclusion must be an actual stage and suppress the
        // linked Lead CRM row, whether chosen inline or inside the record.
        const outreachActions = require('../src/app/actions/linkedin-outreach-actions.ts');
        const { blankCaseStudyProspect } = require('../src/lib/case-study.ts');
        const dncProspectId = require('node:crypto').randomUUID();
        const dncLeadId = 'lead-dnc-check';
        const dncData = blankCaseStudyProspect('https://www.linkedin.com/in/dnc-check/', 'MANUAL', 'CLIENT');
        dncData.stage = 'QUALIFIED';
        dncData.crmLeadId = dncLeadId;
        await store.caseStudyTransaction(async (client) => {
            await client.query(`CREATE TABLE leads (
                id TEXT PRIMARY KEY, linkedin_url TEXT, do_not_contact BOOLEAN NOT NULL DEFAULT FALSE,
                outcome TEXT, linkedin_dm_at TIMESTAMPTZ, contacted BOOLEAN,
                contacted_at TIMESTAMPTZ, contacted_source TEXT,
                email TEXT, hook TEXT, pipeline_status TEXT, email_status TEXT,
                email_verification_method TEXT, email_verification_reason TEXT,
                email_verification_score INTEGER, email_verified_at TIMESTAMPTZ,
                email_verification_expires_at TIMESTAMPTZ
            )`);
            await client.query('INSERT INTO leads(id) VALUES($1)', [dncLeadId]);
            await client.query('INSERT INTO case_study_prospects(id,linkedin_url,data) VALUES($1,$2,$3)',
                [dncProspectId, dncData.linkedinUrl, JSON.stringify(dncData)]);
        });
        const readDnc = async () => store.caseStudyTransaction(async (client) => {
            const lead = await client.query('SELECT do_not_contact FROM leads WHERE id=$1', [dncLeadId]);
            const record = await client.query('SELECT data,revision FROM case_study_prospects WHERE id=$1', [dncProspectId]);
            return { suppressed: lead.rows[0].do_not_contact, data: record.rows[0].data, revision: record.rows[0].revision };
        });
        await outreachActions.setCrmOutreachDoNotContactAction(dncProspectId, true);
        let dncState = await readDnc();
        assert.equal(dncState.data.stage, 'DO_NOT_CONTACT');
        assert.equal(dncState.data.doNotContactPreviousStage, 'QUALIFIED');
        assert.equal(dncState.suppressed, true);
        await assert.rejects(outreachActions.markHunterProspectLinkedinDmSentAction(dncProspectId), /contact/i);
        await outreachActions.setCrmOutreachDoNotContactAction(dncProspectId, false);
        dncState = await readDnc();
        assert.equal(dncState.data.stage, 'QUALIFIED');
        assert.equal(dncState.suppressed, false);
        await actions.saveCaseStudyProspectAction(dncProspectId, { ...dncState.data, stage: 'DO_NOT_CONTACT' }, dncState.revision);
        dncState = await readDnc();
        assert.equal(dncState.data.stage, 'DO_NOT_CONTACT');
        assert.equal(dncState.suppressed, true);
        await actions.saveCaseStudyProspectAction(dncProspectId, { ...dncState.data, stage: 'QUALIFIED' }, dncState.revision);
        dncState = await readDnc();
        assert.equal(dncState.data.stage, 'QUALIFIED');
        assert.equal(dncState.suppressed, false);
        const secondProspectId = require('node:crypto').randomUUID();
        const secondLeadId = 'lead-bulk-check';
        const secondData = blankCaseStudyProspect('https://www.linkedin.com/in/bulk-check/', 'MANUAL', 'CLIENT');
        secondData.stage = 'QUALIFIED';
        secondData.crmLeadId = secondLeadId;
        await store.caseStudyTransaction(async (client) => {
            await client.query('INSERT INTO leads(id) VALUES($1)', [secondLeadId]);
            await client.query('INSERT INTO case_study_prospects(id,linkedin_url,data) VALUES($1,$2,$3)',
                [secondProspectId, secondData.linkedinUrl, JSON.stringify(secondData)]);
        });
        const bulkIds = [dncProspectId, secondProspectId];
        let bulk = await outreachActions.setCrmOutreachStatusesAction(bulkIds, 'DO_NOT_CONTACT');
        assert.equal(bulk.updated.length, 2);
        assert.equal(bulk.activities.length, 2);
        assert.equal((await readDnc()).suppressed, true);
        bulk = await outreachActions.setCrmOutreachStatusesAction(bulkIds, 'NOT_CONTACTED');
        assert.equal(bulk.updated.length, 2);
        assert.equal((await readDnc()).suppressed, false);
        bulk = await outreachActions.setCrmOutreachStatusesAction(bulkIds, 'MESSAGED');
        assert.equal(bulk.updated.length, 2);
        assert.equal(bulk.updated.every((item) => item.data.stage === 'MESSAGED'), true);
        const secondMessaged = bulk.updated.find((item) => item.id === secondProspectId);
        await actions.saveCaseStudyProspectAction(secondProspectId,
            { ...secondMessaged.data, stage: 'REPLIED' }, secondMessaged.revision);
        bulk = await outreachActions.setCrmOutreachStatusesAction(bulkIds, 'NOT_CONTACTED');
        assert.equal(bulk.updated.length, 1);
        assert.equal(bulk.updated[0].id, dncProspectId);
        assert.equal(bulk.skipped.length, 1);
        assert.equal(bulk.skipped[0].id, secondProspectId);
        const { syncHunterContacted } = require('../src/lib/hunter-contact-sync.ts');
        await store.caseStudyTransaction(async (client) => {
            await client.query(`INSERT INTO leads(id,linkedin_url,contacted,contacted_source)
                VALUES ('url-member','HTTP://uk.linkedin.com/in/SARAH-JONES/?trk=test',false,null),
                       ('gmail-member','https://linkedin.com/in/tom-smith',true,'GMAIL'),
                       ('non-member','https://linkedin.com/in/somebody-else',false,null)`);
            const synced = await syncHunterContacted(client);
            assert.ok(synced.memberIds.has('url-member'));
            assert.ok(synced.memberIds.has(dncLeadId));
            assert.ok(!synced.memberIds.has('non-member'));
            const rows = await client.query('SELECT * FROM leads ORDER BY id');
            const member = rows.rows.find(row => row.id === 'url-member');
            assert.equal(member.contacted, true);
            assert.equal(member.contacted_source, 'HUNTER');
            assert.equal(member.linkedin_dm_at, null);
            assert.equal(member.contacted_at, null);
            assert.equal(rows.rows.find(row => row.id === 'gmail-member').contacted_source, 'GMAIL');
            assert.equal(rows.rows.find(row => row.id === dncLeadId).contacted, true);
            assert.equal((await syncHunterContacted(client)).updated, 0);
        });
        const leadDb = require('../src/lib/db.ts');
        let manual = await leadDb.updateLead('non-member', { contacted: true, contacted_source: 'MANUAL' });
        assert.equal(manual.contacted_source, 'MANUAL');
        assert.equal(manual.contacted, true);
        manual = await leadDb.updateLead('non-member', { contacted: false, contacted_source: null });
        assert.equal(manual.contacted, false);
        assert.equal(manual.contacted_source, null);
        await assert.rejects(leadDb.updateLead('url-member', { contacted: false }), /Hunter/);
        const proof = { status: 'VALID', method: 'SMTP_DIRECT', reason: 'Fixture proof', score: 95,
            checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now()+86400000).toISOString(), expectedEmail: 'first@example.test' };
        await leadDb.updateLead('url-member', { email: 'first@example.test' });
        let member = await leadDb.updateLeadEmailVerification('url-member', proof);
        assert.equal(member.in_hunter, true);
        member = await leadDb.updateLead('url-member', { hook: 'New hook' });
        assert.equal(member.email_status, 'VALID');
        member = await leadDb.updateLead('url-member', { email: 'second@example.test', email_status: 'VALID' });
        assert.equal(member.email_status, 'UNVERIFIED');
        assert.equal(member.email_verification_method, null);
        assert.equal(member.email_verification_expires_at, null);
        await assert.rejects(leadDb.updateLeadEmailVerification('url-member', proof), /Email changed/);
        await store.caseStudyTransaction(async client => {
            await client.query("UPDATE leads SET email_status='VALID' WHERE id='non-member'");
            assert.equal(await leadDb.revokeUnprovenEmailLabels(client), 1);
            assert.equal(await leadDb.revokeUnprovenEmailLabels(client), 0);
        });
        assert.deepEqual((await actions.loadCaseStudyAction()).prospects.find(item => item.id === prospect.id)
            .data.headlineQualification.targetTitles, ['Executive Coach']);
        const missedIds = {};
        for (const [key, headline, override] of [
            ['career', 'Career Ownership Coach', {}],
            ['executive', 'Executive Coaching', {}],
            ['suppressed', 'Executive Coaching', { stage: 'DO_NOT_CONTACT' }],
            ['contacted', 'Executive Coaching', { lastContactedAt: new Date().toISOString() }],
            ['imported', 'Executive Coaching', { source: 'MANUAL', crmLeadId: 'crm-fixture' }],
            ['client', 'Executive Coaching', { mode: 'CLIENT' }],
        ]) {
            const data = { ...blankCaseStudyProspect(`https://www.linkedin.com/in/missed-${key}/`, 'CONNECTION', 'CASE_STUDY'),
                headline, scanStatus: 'COMPLETE', coachFit: 'NO', notes: 'Keep this note', ...override };
            const id = require('node:crypto').randomUUID();
            await query('INSERT INTO case_study_prospects(id,linkedin_url,data) VALUES($1,$2,$3)', [id, data.linkedinUrl, JSON.stringify(data)]);
            missedIds[key] = id;
        }
        const recovered = await actions.queueMissedCoachProfilesAction({ mode: 'CASE_STUDY', targetTitles: ['Executive Coach'] });
        assert.equal(recovered.queued, 1);
        const recoveredJob = JSON.parse(fs.readFileSync(path.join(testWorkspace, 'case-study-queue', `${recovered.jobIds[0]}.json`), 'utf8'));
        assert.equal(recoveredJob.prospectId, missedIds.executive);
        assert.deepEqual(recoveredJob.targetTitles, ['Executive Coach']);
        assert.equal((await actions.queueMissedCoachProfilesAction({ mode: 'CASE_STUDY', targetTitles: ['Executive Coach'] })).queued, 0);
        const broadRecovery = await actions.queueMissedCoachProfilesAction({ mode: 'CASE_STUDY' });
        assert.equal(broadRecovery.queued, 1);
        const snapshotAfterRecovery = await actions.loadCaseStudyAction();
        assert.equal(snapshotAfterRecovery.prospects.find(item => item.id === missedIds.career).data.scanStatus, 'QUEUED');
        assert.equal(snapshotAfterRecovery.prospects.find(item => item.id === missedIds.career).data.notes, 'Keep this note');
        for (const key of ['suppressed', 'contacted', 'imported', 'client'])
            assert.equal(snapshotAfterRecovery.prospects.find(item => item.id === missedIds[key]).data.scanStatus, 'COMPLETE', key);
        assert.equal((await actions.retryCaseStudyProspectAction(missedIds.suppressed, { onlyMissedCoach: true })).skipped, true);
        assert.equal((await actions.retryCaseStudyProspectAction(missedIds.client, { onlyMissedCoach: true, expectedMode: 'CASE_STUDY' })).skipped, true);
        const qualifiedAgain = await store.upsertCaseStudyWorkerResult(recoveredJob, { ...result,
            url: recoveredJob.linkedinUrl, headline: 'Executive Coaching' });
        assert.deepEqual(qualifiedAgain.data.headlineQualification.targetTitles, ['Executive Coach']);
        const retry = await actions.retryCaseStudyProspectAction(qualifiedAgain.id);
        const retryJob = JSON.parse(fs.readFileSync(path.join(testWorkspace, 'case-study-queue', `${retry.jobId}.json`), 'utf8'));
        assert.deepEqual(retryJob.targetTitles, ['Executive Coach']);
        console.log('Case Study Hunter database checks passed, including missed-coach recovery and retry title preservation.');
        if (process.argv.includes('--preview')) {
            const { PGLiteSocketServer } = require(path.join(runtime, 'node_modules', '@electric-sql', 'pglite-socket'));
            const server = new PGLiteSocketServer({ db, port: 55449, host: '127.0.0.1' });
            await server.start();
            console.log('Case Study test database listening on 127.0.0.1:55449.');
            process.on('SIGINT', async () => {
                await server.stop();
                await db.close();
                process.exit(0);
            });
            return;
        }
    } finally {
        process.chdir(originalCwd);
        if (!process.argv.includes('--preview')) await db.close();
    }
}

if (process.argv.includes('--database')) {
    databaseChecks().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
