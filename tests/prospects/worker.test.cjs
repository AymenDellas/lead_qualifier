'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const { research, NOW } = require('./fixtures.cjs');
const q = require('../../src/lib/prospect-qualification.cjs');
require('tsx/cjs/api').register();
const { buildDiscoverySearchPlan } = require('../../src/lib/dorkEngine.ts');
const worker = fs.readFileSync(require.resolve('../../worker.cjs'), 'utf8');
function load(name, next, context) {
    const start = worker.indexOf(`async function ${name}(`);
    const end = worker.indexOf(next, start);
    assert.ok(start >= 0 && end > start);
    return vm.runInNewContext(`${worker.slice(start, end)}; ${name}`, { dbWorker: null, failureOf:require('../../src/lib/worker-failure.cjs').failureOf, pipelineForAssessment: q.pipelineForAssessment, ...context, AbortSignal, process: { env: {} } });
}
test('the real enrichment function retains business fit but rejects qualification when no email is found', async () => {
    const r = research({ contacts: [], lastActivityAt: '2024-01-01T12:00:00.000Z' });
    let actualInput;
    const enrich = load('enrichAndFinalize', 'function isProcessRunning', {
        researchProspect: async input => { actualInput = input; return r; }, assessProspect: q.assessProspect,
        prioritizeEmails: emails => emails, hostOf: q.hostOf,
    });
    const result = await enrich({ url: r.linkedinUrl, activityStatus: 'Inactive', emails: [], logs: [] }, null);
    assert.equal(result.status, 'REJECTED'); assert.equal(result.primaryEmail, '');
    assert.equal(result.prospectQualification.tier, 'A');
    assert.equal(actualInput.url, r.linkedinUrl); assert.equal(result.prospectQualification.contact.channel, 'LINKEDIN_ONLY');
});
test('the real CRM persistence path sends evidence without generating opening lines or using sales outcomes', async () => {
    let payload, url; let hookCalls = 0;
    const persist = load('nativePostProcess', 'async function main(', {
        fetch: async (target, options) => { url = target; payload = JSON.parse(options.body); return { ok: true, json: async () => ({ id: 'saved', tier: 'B', assessment: q.assessProspect(research({ facts: { ...research().facts, paidOffer: q.emptyFact() } })) }) }; },
        generateHook: () => hookCalls++, sleep: async () => {}, writeDeadLetter: () => assert.fail('unexpected dead letter'),
    });
    const result = { url: research().linkedinUrl, firstName: 'TEST Ava', status: 'QUALIFIED', logs: [], primaryEmail: '', prospectQualification: q.assessProspect(research()) };
    await persist({ jobId: 'test' }, result, () => {});
    assert.ok(url.endsWith('/api/prospects/research-result')); assert.equal(payload.research.version, 1);
    assert.equal(hookCalls, 0); assert.equal(payload.hook, undefined); assert.equal(payload.outcome, undefined);
    assert.equal(result.crmSaved, true); assert.equal(result.status, 'REJECTED');
});
test('failed CRM saves retain complete business research for recovery instead of reporting success', async () => {
    let attempts = 0, recovery;
    const persist = load('nativePostProcess', 'async function main(', {
        fetch: async () => { attempts++; return { ok: false, status: 503 }; }, sleep: async () => {},
        writeDeadLetter: (_id, _url, payload) => { recovery = payload; },
    });
    const result = { url: research().linkedinUrl, status: 'QUALIFIED', logs: [], prospectQualification: q.assessProspect(research()) };
    await persist({ jobId: 'test' }, result, () => {});
    assert.equal(attempts, 3); assert.equal(result.crmSaved, false); assert.equal(recovery.research.version, 1);
});
test('limited discovery budgets cover all three coaching segments and target markets deterministically', () => {
    const config = { job_titles: ['Executive Coach', 'Career Coach', 'Business Coach'], locations: ['US', 'UK', 'Canada'] };
    const plan = buildDiscoverySearchPlan(config);
    assert.deepEqual([...new Set(plan.slice(0, 9).map(query => query.niche))], config.job_titles);
    assert.deepEqual([...new Set(plan.slice(0, 9).map(query => query.location))], config.locations);
    assert.deepEqual(buildDiscoverySearchPlan(config), plan);
    assert.ok(plan.slice(0, 9).every(query => query.searchPhase === 'country'));
});

test('the worker qualifies email/activity without AI or business gates, and retains undated activity for review', async () => {
    for (const unknown of [false, true]) {
        const r=research({facts:Object.fromEntries(q.FACT_KEYS.map(key=>[key,q.emptyFact()])),segments:[],lastActivityAt:unknown?null:new Date().toISOString(),activityStatus:unknown?'Unknown':'Active'});
        let options;
        const enrich=load('enrichAndFinalize','function isProcessRunning',{
            researchProspect:async (_input,value)=>{options=value;return r;},assessProspect:q.assessProspect,prioritizeEmails:emails=>emails,hostOf:q.hostOf,
        });
        const result=await enrich({url:r.linkedinUrl,emails:[],logs:[]},null);
        assert.equal(options.ai,false);assert.equal(result.status,unknown?'ERROR':'QUALIFIED');
        if(unknown){assert.equal(result.failure.stage,'linkedin');assert.equal(result.failure.retryable,false);assert.match(result.failure.reason,/manual review/);}
    }
});

test('only a transient activity request gets one automatic retry; empty successful feeds do not', async () => {
    const r=research({lastActivityAt:null,activityStatus:'Unknown'});
    const enrich=load('enrichAndFinalize','function isProcessRunning',{
        researchProspect:async()=>r,assessProspect:q.assessProspect,prioritizeEmails:emails=>emails,hostOf:q.hostOf,
    });
    for(const [httpStatus,retryable,retryCount,expected] of [[200,false,0,false],[0,true,0,true],[503,true,0,true],[503,true,1,false]]){
        const result=await enrich({url:r.linkedinUrl,emails:[],logs:[],activityCheck:{httpStatus,retryable}},null,retryCount);
        assert.equal(result.status,'ERROR');assert.equal(result.failure.retryable,expected);
    }
});

test('the final saved-profile pass stops automatic research and explains exhaustion even if routes remain', async () => {
    for(const emailFound of [false,true]) {
        const r=research({lastActivityAt:new Date().toISOString(),...(emailFound?{}:{contacts:[]})});
        r.crawl={version:2,complete:false,retryable:true,maxRoutes:600,attempted:[],visited:[],pending:['https://avamorgan.test/actual-route'],failed:[],roots:['https://avamorgan.test/'],matchedHosts:['avamorgan.test'],candidates:[],stoppedReason:'Pass budget reached',inspected:0};
        const enrich=load('enrichAndFinalize','function isProcessRunning',{
            researchProspect:async()=>r,assessProspect:q.assessProspect,prioritizeEmails:emails=>emails,hostOf:q.hostOf,
        });
        const result=await enrich({url:r.linkedinUrl,emails:[],logs:[]},null,3);
        assert.equal(result.status,emailFound?'QUALIFIED':'ERROR');
        assert.equal(result.prospectQualification.research.crawl.retryable,false);
        assert.match(result.prospectQualification.research.crawl.stoppedReason,/retries exhausted/);
        if(!emailFound){assert.equal(result.failure.retryable,false);assert.match(result.failure.reason,/manual review/);}
    }
});
