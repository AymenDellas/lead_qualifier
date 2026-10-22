'use strict';
// Real actions/API and the shared queue in an isolated PostgreSQL schema.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const {Pool} = require('pg'), {randomUUID} = require('node:crypto');
const core = require('../../src/lib/linkedin-workers.cjs');
const originalLoad = Module._load;
Module._load = function(request, parent, ...args) {
    if (request === '@/lib/worker-admin') return {requireWorkerAdmin:async()=>{}};
    return originalLoad.call(this, request, parent, ...args);
};
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent, ...args) {
    if (request.startsWith('@/')) request = path.join(root, 'src', request.slice(2));
    return originalResolve.call(this, request, parent, ...args);
};
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText, filename);

(async () => {
    for(const line of fs.readFileSync(path.join(root,'.env.local'),'utf8').split('\n')) {
        const match=line.replace(/\r/g,'').match(/^([^#=]+)=(.+)$/);
        if(match)process.env[match[1].trim()]=match[2].trim().replace(/^(['"])([\s\S]*)\1$/,'$2');
    }
    const schema='compel_batch_test_'+randomUUID().replaceAll('-','');
    assert.match(schema,/^compel_batch_test_[a-f0-9]{32}$/);
    const raw=new Pool({connectionString:process.env.DATABASE_URL,max:4,connectionTimeoutMillis:10000,ssl:{rejectUnauthorized:false}});
    const qualify=sql=>sql.replace(/\b(leads|compel_worker_events|compel_worker_config|compel_linkedin_accounts|compel_worker_usage|compel_worker_sessions|compel_worker_jobs)\b/g,`"${schema}".$1`);
    // This queue test has no Hunter membership table; never consult real public tables.
    const query=(client,sql,values)=>sql.includes("to_regclass('public.case_study_prospects')")?Promise.resolve({rows:[{table_name:null,lead_table:null}],rowCount:1}):client.query(qualify(sql),values);
    const pool={query:(sql,values)=>query(raw,sql,values),connect:async()=>{
        const client=await raw.connect();return{query:(sql,values)=>query(client,sql,values),release:()=>client.release()};
    }};
    Object.defineProperty(require('pg'), 'Pool', { configurable: true, value: class { constructor() { return pool; } } });
    try {
        await raw.query(`CREATE SCHEMA "${schema}"`);
        await require('../../src/lib/pg_setup.ts').createSchema();
        const actions = require('../../src/app/actions/prospect-actions.ts');
        const jobsRoute = require('../../src/app/api/prospects/jobs/route.ts');
        await pool.query(`INSERT INTO leads(id, linkedin_url, first_name, discovery_niche, fit_score, created_at)
            SELECT 'fixture-' || n, 'https://www.linkedin.com/in/test-coach-' || n, 'TEST Coach ' || n,
                'Executive Coach', 2500 - n, '2026-10-06T12:00:00Z'::timestamptz FROM generate_series(1, 2400) n;
            UPDATE leads SET do_not_contact=TRUE WHERE id='fixture-2400';
            UPDATE leads SET contacted=TRUE, contacted_source='GMAIL_SENT' WHERE id='fixture-2399';
            INSERT INTO leads(id,linkedin_url,first_name,discovery_niche,fit_score)
                VALUES ('fixture-duplicate','https://www.linkedin.com/in/TEST-COACH-371','TEST Duplicate','Executive Coach',0);`);
        await core.enqueue(pool,Array.from({length:370},(_,n)=>`https://www.linkedin.com/in/test-coach-${n+1}`));
        const first = await actions.queueNextProspectsAction('ALL', 500);
        assert.equal(first.jobs.length, 500);
        assert.equal(first.skipped.length, 0);
        assert.ok(first.jobs.some(job => job.leadId === 'fixture-371'));
        assert.ok(first.jobs.every(job => Number(job.leadId.slice(8)) > 370));
        const firstUrls=(await pool.query('SELECT profile_key FROM compel_worker_jobs WHERE id=ANY($1::text[])',[first.jobs.map(job=>job.id)])).rows;
        assert.equal(new Set(firstUrls.map(job=>job.profile_key)).size,500);
        const second = await actions.queueNextProspectsAction('EXECUTIVE', 1000);
        assert.equal(second.jobs.length, 1000);
        assert.ok(second.jobs.every(job => !first.jobs.some(previous => previous.leadId === job.leadId)));
        console.log('PASS 500/1,000-person batches skip existing queued people and canonical duplicates');

        const selected = await actions.queueProspectResearchAction(Array.from({ length: 50 }, (_, i) => `fixture-${1900 + i}`));
        assert.equal(selected.jobs.length, 50);
        const remaining = await actions.queueNextProspectsAction('ALL');
        assert.equal(remaining.jobs.length, 200);
        const last = await actions.queueNextProspectsAction('ALL', 1000);
        assert.ok(last.jobs.every(job => !['fixture-2399', 'fixture-2400'].includes(job.leadId)));
        assert.equal((await actions.queueNextProspectsAction('ALL', 1000)).jobs.length, 0);
        console.log('PASS default 200, selected page of 50, suppression/contact exclusions and pool exhaustion');

        const countJobs=async()=>Number((await pool.query('SELECT count(*) AS n FROM compel_worker_jobs')).rows[0].n);
        const countBefore = await countJobs();
        for (const value of [0, -1, 1001, 1.5, NaN, Infinity, '500']) {
            await assert.rejects(actions.queueNextProspectsAction('ALL', value), /whole number/);
        }
        await assert.rejects(actions.queueProspectResearchAction(Array(1001).fill('fixture-1')), /1,000/);
        assert.equal(await countJobs(), countBefore);
        console.log('PASS invalid batch sizes cannot write queue jobs');

        const ids = first.jobs.slice(0, 100).map(job => job.id);
        for(const [index,saved] of [true,false].entries())await pool.query("UPDATE compel_worker_jobs SET status='done',completed_at=NOW(),result=$2::jsonb WHERE id=$1",[ids[index],JSON.stringify({status:'QUALIFIED',crmSaved:saved,prospectQualification:{tier:'A'}})]);
        await core.importAccounts(pool,[{email:'worker@example.test',password:'fixture password'}]);
        await core.acquireSession(pool,'legacy-0','fixture-owner');
        await core.heartbeat(pool,'legacy-0','fixture-owner',{status:'ready'});
        const response = await jobsRoute.GET(new Request(`http://localhost/api/prospects/jobs?ids=${ids.join(',')}`));
        const result = await response.json();
        assert.equal(response.status, 200); assert.equal(result.jobs.length, 100);
        assert.equal(result.jobs[0].status, 'done'); assert.equal(result.jobs[1].status, 'error');
        assert.equal(result.jobs[2].status, 'queued'); assert.equal(result.worker.ready, true);
        const tooMany = await jobsRoute.GET(new Request(`http://localhost/api/prospects/jobs?ids=${[...ids, first.jobs[100].id].join(',')}`));
        assert.equal(tooMany.status, 400);
        const invalid = await jobsRoute.GET(new Request('http://localhost/api/prospects/jobs?ids=../../data'));
        assert.equal(invalid.status, 400);
        console.log('PASS bounded polling of 100 jobs, errors, worker heartbeat and path validation');
    } finally { await raw.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await raw.end(); }
})().catch(error => { console.error(error); process.exit(1); });
