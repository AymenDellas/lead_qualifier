'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),core=require('../../src/lib/linkedin-workers.cjs'),alias=require('../../src/lib/aliasmode-store.cjs'),exp=require('../../src/lib/worker-warmup-experiment.cjs'),rendered=require('../../src/lib/linkedin-browser-page.cjs'),{createAccountRuntime}=require('../../src/lib/account-runtime.cjs'),{database}=require('./db-fixture.cjs'),{fixture}=require('./aliasmode-fixture.cjs');
test('the real runtime only renders warmup pages and stops on a fresh 403; all fixture traffic is intercepted',async()=>{
 const db=await database(),f=await fixture(),pool=db.pool;let runtime;
 try{
  await core.ensure(pool);await alias.ensure(pool);const id=await alias.importProfile(pool,{profileId:exp.PROFILE,name:'John fixture',expectedMemberName:'John Dilah'}),identity={name:'John Dilah',profileUrl:'https://www.linkedin.com/in/owner-john-fixture/'},urls=Array.from({length:20},(_,i)=>`https://www.linkedin.com/in/runtime-warmup-${i}/`);
  await pool.query('UPDATE compel_linkedin_accounts SET connected_at=NOW(),confirmed_identity=$2::jsonb,attention_reason=$3 WHERE id=$1',[id,JSON.stringify(identity),'Saved 403 hold reviewed by user']);
  await exp.prepare(pool,urls);await exp.start(pool);await pool.query("UPDATE compel_engine_batches SET report=report||jsonb_build_object('notBefore',clock_timestamp()-interval '1 second') WHERE id=$1",[exp.ID]);await core.acquireSession(pool,id,'owner');
  const browser=f.create(exp.PROFILE),surface=await browser.open({headless:false}),page=surface.page,requests=[];
  await page.setRequestInterception(true);page.on('request',r=>{requests.push(r.url());void r.respond({status:r.url()===urls[1]?403:200,contentType:r.url().includes('/voyager/api/')?'application/json':'text/html',body:r.url().includes('/voyager/api/')?'{}':'<!doctype html><title>Intercepted fixture</title><main style="height:2000px"><h1>Fixture page</h1></main><script>fetch("/voyager/api/fixture-background")</script>'}).catch(()=>{});});
  const runner=exp.create({pool,accountId:id,owner:'owner',core,rendered:{readSignedInIdentity:async()=>identity}});
  runtime=createAccountRuntime({pool,accountId:id,owner:'owner',core,browserOwner:browser,warmupExperiment:runner,reader:{inspected:rendered.inspected,captureProfile:()=>assert.fail('No qualification API reads')},researchQueue:{handoff:()=>assert.fail('No public research')},discoveryStore:{claimSource:()=>assert.fail('No discovery')}});
  await runtime.tick();assert.equal((await exp.load(pool)).report.visits.length,1);assert.equal(runtime.snapshot().reasonCode,'PROFILE_INTERVAL');assert.equal(runtime.snapshot().sessionReady,true);assert.equal((await core.readRuntimeAccount(pool,id)).processing_enabled,false);
  await pool.query('UPDATE compel_linkedin_accounts SET next_profile_at=NULL WHERE id=$1',[id]);await runtime.tick();await runtime.tick();
  const report=await exp.load(pool);assert.equal(report.state,'WARMUP_STOPPED');assert.equal(report.report.visits.length,1);assert.equal(report.report.attempts.length,2);assert.match((await core.readRuntimeAccount(pool,id)).attention_reason,/HTTP 403/);assert.equal(report.report.scriptedQualificationRequests,0);assert.ok(report.report.traffic.nativeVoyager>=1);
  assert.equal(requests.filter(u=>urls.includes(u)).length,2);assert.ok(requests.every(u=>u==='https://www.linkedin.com/feed/'||urls.includes(u)||u.includes('/voyager/api/fixture-background')||u.endsWith('/favicon.ico')));
 }finally{await runtime?.close({preserveIntent:true});await f.close();await db.close();}
});
