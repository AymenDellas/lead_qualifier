'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createResearchRunner,createPublicFetcher,researchUrl}=require('../../src/lib/worker-research-runner.cjs');
const queue=require('../../src/lib/worker-research-queue.cjs');
const url='https://www.linkedin.com/in/research-fixture/';
const capture=()=>({url,firstName:'Ava',profileIdentityConfirmed:true,linkedinAccountId:'account-one',linkedinCapturedAt:'2026-10-24T09:00:00Z',linkedinCapture:{version:2,complete:true},status:'PENDING',emails:[],logs:[]});
const research=()=>({website:'https://fixture.example.test',profileIdentityConfirmed:true,contacts:[
 {address:'hello@fixture.example.test',ownership:'PUBLISHED',source:'website'},
 {address:'ava@fixture.example.test',ownership:'PUBLISHED',source:'website'},
 {address:'personal@example.test',ownership:'PUBLISHED',source:'linkedin'},
 {address:'guessed@fixture.example.test',ownership:'UNCONFIRMED',source:'website'},
],limitations:[],crawl:{complete:true,retryable:false}});
function fixture(overrides={}){
 const calls={complete:[],checkpoint:[],defer:[],save:[],finish:[],launch:[],render:[],research:[],close:0};
 const job={jobId:'job-fixture',resumeResult:capture(),retryCount:0,nativePostProcess:true};
 const assessment={qualification:{activity:'ACTIVE',needsRetry:false,needsAttention:false},contact:{email:'personal@example.test'},research:research()};
 const pool={query:async sql=>({rows:[],rowCount:0})};
 const core=Object.fromEntries(['complete','checkpoint','defer'].map(kind=>[kind,async(...args)=>calls[kind].push(args)]));
 const browser={close:async()=>{calls.close++;},createBrowserContext:()=>assert.fail('The injected renderer owns contexts')};
  const options={pool,owner:'research-owner',core,queue:{...queue,claim:async()=>({job})},discoveryStore:{runIsActive:async()=>true},
  researchProspect:async(input,settings)=>{calls.research.push({input,settings});return research();},
  assessProspect:(value,{email})=>({...assessment,research:value,contact:{email}}),pipelineForAssessment:()=> 'QUALIFIED',
  saveWorkerResearch:async(...args)=>{calls.save.push(args);return {id:'lead-fixture',assessment:args[1].research?{...assessment,research:args[1].research}:assessment,pipelineStatus:'QUALIFIED'};},
  finishProspecting:async(...args)=>{calls.finish.push(args);return {...args[3],status:'QUALIFIED'};},
  launch:async settings=>{calls.launch.push(settings);return browser;},
  createPageRenderer:(_browser,settings)=>async(value)=>{calls.render.push({value,settings});return {html:'fixture'};},
  now:()=>Date.parse('2026-10-24T10:00:00Z'),...overrides,
 };
 return {job,calls,pool,options,runner:createResearchRunner(options)};
}
test('saved profiles complete independently of account processing without opening any browser',async()=>{
 const f=fixture();const outcome=await f.runner.runOnce();
 assert.equal(outcome.deferred,false);assert.equal(outcome.result.status,'QUALIFIED');
 assert.equal(outcome.result.linkedinAccountId,'account-one');
 assert.equal(outcome.result.primaryEmail,'personal@example.test','profile-published email outranks a website inbox');
 assert.ok(!outcome.result.emails.includes('guessed@fixture.example.test'));
 assert.equal(f.calls.save.length,1);assert.equal(f.calls.complete.length,1);assert.equal(f.calls.launch.length,0);
 assert.equal(f.calls.save[0][1].owner,'research-owner');assert.equal(f.calls.save[0][1].jobId,'job-fixture');
 assert.equal(f.job.resumeResult.status,'PENDING','saved checkpoint is not mutated');
 await f.runner.close();
});
test('rendering uses a separate temporary public browser and retains the guarded renderer',async()=>{
 const f=fixture();f.options.researchProspect=async(_input,settings)=>{await settings.renderPage('https://fixture.example.test/');return research();};
 const runner=createResearchRunner(f.options);
 await runner.process(f.job);await runner.close();
 assert.equal(f.calls.launch.length,1);assert.equal(f.calls.launch[0].headless,true);
 assert.equal(f.calls.launch[0].userDataDir,undefined);assert.equal(f.calls.render.length,1);assert.equal(f.calls.close,1);
 assert.equal(typeof f.calls.render[0].settings.fetchResource,'function');
});
test('website retries retain snapshots and stay in the public research lane',async()=>{
 
 const f=fixture({researchProspect:async()=>{throw Error('Website unavailable');}});
 const first=await f.runner.process(f.job);
 assert.equal(first.deferred,true);assert.equal(first.result.failure.stage,'research');
 assert.equal(first.result.profileIdentityConfirmed,true);assert.equal(f.calls.checkpoint.length,1);assert.equal(f.calls.defer.length,1);
 assert.equal(f.calls.defer[0][4],'2026-10-24T10:00:00.000Z');assert.equal(f.calls.complete.length,0);
 const final=await f.runner.process({...f.job,retryCount:3});
 assert.equal(final.deferred,false);assert.equal(final.result.failure.retryable,false);assert.equal(f.calls.complete.length,1);
});

test('the separate public browser closes after idle and relaunches only on a new render need',async()=>{
 const f=fixture();f.options.publicBrowserIdleMs=5;
 f.options.researchProspect=async(_input,settings)=>{await settings.renderPage('https://fixture.example.test/');return research();};
 const runner=createResearchRunner(f.options);
 try{
  await runner.process(f.job);await new Promise(resolve=>setTimeout(resolve,20));assert.equal(f.calls.close,1);
  await runner.process({...f.job,jobId:'next-job'});assert.equal(f.calls.launch.length,2);
 }finally{await runner.close();}
 assert.equal(f.calls.close,2);
});
test('unconfirmed captured activity is retained for review and never schedules LinkedIn work',async()=>{
 const f=fixture({assessProspect:r=>({research:r,qualification:{activity:'UNKNOWN',needsAttention:true},blockers:['Recent activity needs review.']}),pipelineForAssessment:()=> 'ERROR'});
 const outcome=await f.runner.process(f.job);
 assert.equal(outcome.result.status,'REVIEW');assert.equal(outcome.result.failure.stage,'qualification');assert.equal(outcome.result.failure.retryable,false);
 assert.equal(outcome.deferred,false);assert.equal(f.calls.defer.length,0);assert.equal(f.calls.save.length,1);assert.equal(f.calls.save[0][1].reviewRequired,true);
});
test('CRM failures retry the saved website research without another crawl',async()=>{
 let saves=0;
 const f=fixture({saveWorkerResearch:async()=>{if(!saves++)throw Error('Database unavailable');return {id:'saved',assessment:{research:research(),contact:{email:'personal@example.test'}},pipelineStatus:'QUALIFIED'};}});
 const first=await f.runner.process(f.job);assert.equal(first.result.failure.stage,'crm');assert.equal(first.deferred,true);
 const second=await f.runner.process({...f.job,resumeResult:first.result,retryCount:1});
 assert.equal(second.result.crmSaved,true);assert.equal(f.calls.research.length,1);assert.equal(saves,2);
});
test('prospecting uses its existing finish integration once and never writes the CRM a second time',async()=>{
 const f=fixture();await f.runner.process({...f.job,prospecting:{runId:'fixture-run'}});
 assert.equal(f.calls.finish.length,1);assert.equal(f.calls.save.length,0);
 assert.equal(f.calls.finish[0][3].prospectQualification.research.website,'https://fixture.example.test');
});
test('qualified incomplete website work is completed for continuation, with saved routes passed on resume',async()=>{
 const previous={...research(),crawl:{complete:false,retryable:true,pending:['https://fixture.example.test/contact']}};
 const f=fixture({researchProspect:async(_input,settings)=>{assert.equal(settings.previousResearch.crawl.pending[0],previous.crawl.pending[0]);return previous;}});
 const result=await f.runner.process({...f.job,resumeResult:{...capture(),prospectQualification:{research:previous}},websiteContinuation:true});
 assert.equal(result.result.status,'QUALIFIED');assert.equal(f.calls.complete.length,1);assert.equal(f.calls.defer.length,0);
 assert.equal(f.calls.complete[0][3].prospectQualification.research.crawl.complete,false);
});
test('a lost job lease cannot be reported as completed or turn into another website retry',async()=>{
 const f=fixture({core:{checkpoint:async()=>assert.fail('No retry'),defer:async()=>assert.fail('No retry'),complete:async()=>{throw Error('Job lease lost');}}});
 await assert.rejects(f.runner.process(f.job),/lease lost/);
});
test('partial captures are refused before research or CRM work',async()=>{
 const f=fixture();
 await assert.rejects(f.runner.process({...f.job,resumeResult:{...capture(),linkedinCapture:{complete:false}}}),/complete captured profile/);
 assert.equal(f.calls.research.length,0);assert.equal(f.calls.save.length,0);
 assert.equal(queue.fullCapture({...capture(),linkedinCapture:undefined}),true,'legacy full snapshots remain readable');
 assert.equal(queue.fullCapture({...capture(),profileIdentityConfirmed:false}),false);
});
test('a failed final acknowledgement retains completed research and the exact job for fenced recovery',async()=>{
 const f=fixture({core:{checkpoint:async()=>{},defer:async()=>{},complete:async()=>{throw Error('Database connection lost');}}});
 await assert.rejects(f.runner.runOnce(),error=>{assert.equal(error.engineJobId,f.job.jobId);assert.equal(error.resumeResult.failure.code,'RESULT_SAVE_PENDING');assert.ok(error.resumeResult.prospectQualification.research);assert.equal(error.resumeResult.profileIdentityConfirmed,true);return true;});await f.runner.close();
});
test('public HTTP redirects cannot reach LinkedIn and each hop retains DNS-pinned reader options',async()=>{
 const requests=[];
 const fetchPage=createPublicFetcher(async(value,settings)=>{
  requests.push({value,settings});return {status:302,headers:{location:'https://www.linkedin.com/in/fixture/'},body:Buffer.alloc(0)};
 });
 await assert.rejects(fetchPage('https://fixture.example.test/'),/cannot request LinkedIn/);
 assert.equal(requests.length,1);assert.equal(requests[0].settings.resource,true);assert.equal(requests[0].settings.followRedirects,false);
 for(const value of ['https://www.linkedin.com/feed/','https://static.licdn.com/a.js','http://127.0.0.1/','http://localhost/'])assert.throws(()=>researchUrl(value));
 assert.equal(researchUrl('https://linkedin.com.example.test/').hostname,'linkedin.com.example.test');
});
test('research queue queries fence ownership and never consult account authorization',async()=>{
 const statements=[];
 const pool={query:async(sql,values)=>{
  statements.push({sql,values});
  if(sql.includes('RETURNING j.*'))return {rowCount:1,rows:[{id:'same-id',payload:{jobId:'wrong-id'},checkpoint:capture(),retry_count:2}]};
  return {rowCount:sql.includes('WHERE id=$1 AND owner=$2')?0:1,rows:[]};
 }};
 await queue.ensure(pool);const claimed=await queue.claim(pool,'owner');
 assert.equal(claimed.job.jobId,'same-id');assert.equal(claimed.job.retryCount,2);
 await assert.rejects(queue.handoff(pool,'same-id','wrong-owner',capture()),/lease lost/);
 await queue.heartbeat(pool,'owner');await queue.release(pool,'owner');
 const sql=statements.map(s=>s.sql).join('\n');
 assert.ok(sql.includes('FOR UPDATE SKIP LOCKED'));assert.ok(sql.includes("lane='research'"));assert.ok(sql.includes('lease_until>NOW()'));
 assert.ok(!sql.includes('compel_linkedin_accounts'));assert.ok(!sql.includes('compel_worker_sessions'));
});
