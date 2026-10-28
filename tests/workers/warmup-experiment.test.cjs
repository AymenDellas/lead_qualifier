'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),core=require('../../src/lib/linkedin-workers.cjs'),alias=require('../../src/lib/aliasmode-store.cjs'),exp=require('../../src/lib/worker-warmup-experiment.cjs'),{database}=require('./db-fixture.cjs');
const urls=Array.from({length:20},(_,i)=>`https://www.linkedin.com/in/authorized-warmup-${i}/`),identity={name:'John Dilah',profileUrl:'https://www.linkedin.com/in/john-fixture/'},oldHold='LinkedIn reported an access restriction (HTTP 403). Saved pre-test hold.';
const fingerprint={origin:'https://www.linkedin.com',userAgent:'Fixture Chrome',platform:'Win32',screen:{width:1920,height:1080},timezone:'UTC',locale:'en-GB',hardwareConcurrency:4,deviceMemory:8,webglVendor:'Fixture GPU',webglRenderer:'Fixture GPU renderer'};
async function fixture(){const db=await database(),pool=db.pool;await core.ensure(pool);await alias.ensure(pool);const id=await alias.importProfile(pool,{profileId:exp.PROFILE,name:'John',expectedMemberName:identity.name});await pool.query('UPDATE compel_linkedin_accounts SET connected_at=NOW(),confirmed_identity=$2::jsonb,attention_reason=$3 WHERE id=$1',[id,JSON.stringify(identity),oldHold]);await exp.prepare(pool,urls);await exp.start(pool);await pool.query("UPDATE compel_engine_batches SET report=report||jsonb_build_object('notBefore',clock_timestamp()-interval '1 second') WHERE id=$1",[exp.ID]);assert.equal(await core.acquireSession(pool,id,'owner'),true);return {...db,id,pool};}
function fakePage(){let url='about:blank';return {url:()=>url,on:()=>{},goto:async u=>{url=u;}};}
function harness(f,{found=identity,signal,probe=async()=>fingerprint,visitError}={}){const page=fakePage(),seen=[],signalled=[];
 const runner=exp.create({pool:f.pool,accountId:f.id,owner:'owner',core,rendered:{readSignedInIdentity:async()=>found,captureProfile:()=>assert.fail('No qualification reads')},human:{visit:async(p,u,{assertActive})=>{await assertActive();if(visitError)throw visitError;seen.push(u);await p.goto(u);},interact:async()=>{}},probe});
 const callbacks={open:async()=>({page}),inspect:async()=>{},assertSignal:async()=>{if(signal&&page.url().includes('/feed/'))throw signal;},onSignal:async failure=>{signalled.push(failure);await core.pauseProcessing(f.pool,f.id,failure.reason,true,'owner');}};
 return {runner,callbacks,page,seen,signalled};
}
test('one-time rendered experiment performs at most 20 visits with real atomic spacing/slots, no qualification and no enabled processing intent',async()=>{
 const f=await fixture();try{
  const h=harness(f);for(let i=0;i<20;i++){
   await f.pool.query('UPDATE compel_linkedin_accounts SET next_profile_at=NULL WHERE id=$1',[f.id]);const a=await core.readRuntimeAccount(f.pool,f.id),r=await h.runner.step(a,h.callbacks);
   assert.equal(r.done,i===19?true:undefined);assert.equal((await core.readRuntimeAccount(f.pool,f.id)).processing_enabled,false);
   const slot=(await f.pool.query('SELECT EXTRACT(EPOCH FROM(next_profile_at-clock_timestamp())) AS seconds FROM compel_linkedin_accounts WHERE id=$1',[f.id])).rows[0];assert.ok(Number(slot.seconds)>50&&Number(slot.seconds)<=150);
  }
  const b=await exp.load(f.pool);assert.equal(b.state,'WARMUP_COMPLETE');assert.equal(b.report.visits.length,20);assert.equal(b.report.attempts.length,20);assert.deepEqual(h.seen,urls);assert.equal(b.report.scriptedQualificationRequests,0);
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM compel_worker_account_profiles WHERE account_id=$1',[f.id])).rows[0].n,20);
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM compel_worker_jobs WHERE status='cancelled' AND payload->>'warmupExperimentId'=$1",[exp.ID])).rows[0].n,20);
  const a=await core.readRuntimeAccount(f.pool,f.id);assert.equal(a.attention_reason,'');assert.ok(a.session_evidence.recoveryUntil);assert.equal(a.session_evidence.gate,null);
  await assert.rejects(exp.start(f.pool),/already active or finished/);await h.runner.step(a,h.callbacks);assert.equal(h.seen.length,20);
  assert.equal((await core.enqueue(f.pool,[urls[0]])).queuedCount,1,'warmup does not masquerade as completed qualification');
 }finally{await f.close();}
});
test('a new 403 identical to the saved hold stops before a profile start and never clears the hold',async()=>{
 const f=await fixture();try{const failure={stage:'linkedin',code:'LINKEDIN_AUTH',reason:oldHold,retryable:false},h=harness(f,{signal:Object.assign(Error(oldHold),{failure})});const r=await h.runner.step(await core.readRuntimeAccount(f.pool,f.id),h.callbacks);
  assert.equal(r.done,true);assert.equal(h.seen.length,0);assert.equal((await core.readRuntimeAccount(f.pool,f.id)).attention_reason,oldHold);assert.equal((await exp.load(f.pool)).report.attempts.length,0);
 }finally{await f.close();}
});
test('identity mismatch, expired authorization, stale configuration and owner loss cannot authorize a visit',async()=>{
 const f=await fixture();try{
  const h=harness(f,{found:{name:'Other',profileUrl:'https://www.linkedin.com/in/other/'}});await h.runner.step(await core.readRuntimeAccount(f.pool,f.id),h.callbacks);assert.equal(h.seen.length,0);assert.match((await core.readRuntimeAccount(f.pool,f.id)).attention_reason,/identity/);
 }finally{await f.close();}
 for(const change of ["report=jsonb_set(report,'{expiresAt}',to_jsonb((NOW()-interval '1 second')::text))","report=jsonb_set(report,'{controlVersion}',to_jsonb('2000-01-01'::text))"]){const f=await fixture();try{await f.pool.query('UPDATE compel_engine_batches SET '+change+' WHERE id=$1',[exp.ID]);const h=harness(f);await h.runner.step(await core.readRuntimeAccount(f.pool,f.id),h.callbacks);assert.equal(h.seen.length,0);}finally{await f.close();}}
 const lost=await fixture();try{await lost.pool.query("UPDATE compel_worker_sessions SET owner='other' WHERE account_id=$1",[lost.id]);await assert.rejects(exp.authority(lost.pool,{accountId:lost.id,owner:'owner',version:(await core.readRuntimeAccount(lost.pool,lost.id)).control_version}),/ownership/);}finally{await lost.close();}
});
test('normal Pause cancels the experiment, and orphan warmup locks can never enter normal qualification',async()=>{
 const f=await fixture();try{
  const h=harness(f);await h.runner.step(await core.readRuntimeAccount(f.pool,f.id),h.callbacks);await core.pauseProcessing(f.pool,f.id);
  await h.runner.step(await core.readRuntimeAccount(f.pool,f.id),h.callbacks);assert.equal(h.seen.length,1);
  await f.pool.query("INSERT INTO compel_worker_jobs(id,profile_key,payload) VALUES('orphan',$1,$2::jsonb)",[urls[1],JSON.stringify({warmupExperimentId:exp.ID,linkedinUrl:urls[1]})]);
  await f.pool.query('UPDATE compel_linkedin_accounts SET processing_enabled=TRUE,next_profile_at=NULL WHERE id=$1',[f.id]);assert.equal(await core.claim(f.pool,f.id,'owner'),null);
 }finally{await f.close();}
});
test('a failed navigation records its action without URL query credentials or local connection capabilities',async()=>{
 const f=await fixture();try{
  const h=harness(f,{visitError:Error('Runtime.callFunctionOn timed out at https://user:fixturepassword@www.linkedin.com/error_pages/500.html?token=fixture-secret wss://127.0.0.1:1234/devtools/browser/fixture-capability')});
  await h.runner.step(await core.readRuntimeAccount(f.pool,f.id),h.callbacks);const b=await exp.load(f.pool);
  assert.equal(b.state,'WARMUP_STOPPED');assert.equal(b.report.lastAction,'profile_navigation');assert.equal(b.report.attempts.length,1);assert.equal(b.report.visits.length,0);
  assert.match(b.report.reason,/Runtime.callFunctionOn timed out/);assert.ok(!/fixturepassword|fixture-secret|fixture-capability/.test(b.report.reason));assert.equal((await core.readRuntimeAccount(f.pool,f.id)).attention_reason,'');
 }finally{await f.close();}
});
