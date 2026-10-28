'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),core=require('../../src/lib/linkedin-workers.cjs'),alias=require('../../src/lib/aliasmode-store.cjs'),store=require('../../src/lib/account-session-store.cjs'),{database}=require('./db-fixture.cjs');
const input=id=>({accountId:id,revision:0,engine:'aliasmode-chromium',launchMode:'headful',proxyId:'dedicated-one',proxyHost:'proxy.test',proxyPort:8000,proxyCountry:'GB',proxyTimezone:'Europe/London',expectedExitIp:'192.0.2.10',policy:{}});
test('dedicated proxy references are unique and settings preserve hold, recovery deadline and paused intent',async()=>{
 const db=await database(),pool=db.pool;try{
  await core.ensure(pool);await alias.ensure(pool);
  const one=await alias.importProfile(pool,{profileId:'one',name:'One',expectedMemberName:'One'}),two=await alias.importProfile(pool,{profileId:'two',name:'Two',expectedMemberName:'Two'});
  await pool.query("UPDATE compel_linkedin_accounts SET attention_reason='Exact hold',session_evidence='{\"recoveryUntil\":\"2026-11-01T00:00:00Z\"}' WHERE id=$1",[one]);
  await store.configure(pool,input(one));
  const a=(await pool.query('SELECT * FROM compel_linkedin_accounts WHERE id=$1',[one])).rows[0];
  assert.equal(a.attention_reason,'Exact hold');assert.equal(a.processing_enabled,false);assert.equal(a.session_evidence.recoveryUntil,'2026-11-01T00:00:00Z');assert.equal(a.proxy_secret_ref,'aliasmode:one');
  await assert.rejects(store.configure(pool,input(two)),/already bound/);await assert.rejects(store.configure(pool,input(one)),/changed/);
  await assert.rejects(store.request(pool,one,'diagnostics'),/manual review/);
  await assert.rejects(store.configure(pool,{...input(two),password:'must-not-store'}),/passwords/);
 }finally{await db.close();}
});
test('session evidence saves are owner/configuration fenced and cannot run through an expired lease',async()=>{
 const db=await database(),pool=db.pool;try{
  await core.ensure(pool);await alias.ensure(pool);const id=await alias.importProfile(pool,{profileId:'one',name:'One',expectedMemberName:'One'});
  await core.acquireSession(pool,id,'owner');const a=await core.readRuntimeAccount(pool,id);
  await store.updateOwned(pool,a,'owner',{gate:{verdict:'UNKNOWN'}});
  await assert.rejects(store.updateOwned(pool,a,'other',{gate:{verdict:'PASS'}}),/ownership/);
  await pool.query("UPDATE compel_worker_sessions SET lease_until=NOW()-interval '1 second' WHERE account_id=$1",[id]);
  await assert.rejects(store.updateOwned(pool,a,'owner',{gate:{verdict:'PASS'}}),/ownership/);
 }finally{await db.close();}
});
test('ramp ceiling and randomized start spacing are reserved atomically in PostgreSQL',async()=>{
 const db=await database(),pool=db.pool,p=require('../../src/lib/account-session-policy.cjs'),daily=require('../../src/lib/engine-daily-policy.cjs');try{
  await core.ensure(pool);await alias.ensure(pool);const id=await alias.importProfile(pool,{profileId:'one',name:'One',expectedMemberName:'One'});
  await pool.query("UPDATE compel_linkedin_accounts SET processing_enabled=TRUE,connected_at=NOW(),proxy_id='fixture-proxy',proxy_host='proxy.test',proxy_port=8000,proxy_country='GB',proxy_timezone='UTC' WHERE id=$1",[id]);
  await core.acquireSession(pool,id,'owner');const a=await core.readRuntimeAccount(pool,id),key=p.evidenceKey(a),at=Date.now();
  const e={network:{verdict:'PASS',key},fingerprint:{hash:'fixture'},gate:{verdict:'PASS',key,fingerprintHash:'fixture'},warmupDays:[4,3,2,1].map(n=>p.localDay(at-n*86400000,'UTC')),rampStartedAt:new Date(at).toISOString()};
  await pool.query('UPDATE compel_linkedin_accounts SET session_evidence=$2::jsonb WHERE id=$1',[id,JSON.stringify(e)]);
  const results=await Promise.all(Array.from({length:17},(_,i)=>daily.reserve(pool,{accountId:id,owner:'owner',profileUrl:`https://www.linkedin.com/in/ramp-${i}/`,jobId:'fixture-'+i,intervalMs:0})));
  assert.equal(results.filter(r=>r.charged).length,15);assert.equal(results.filter(r=>r.limited).length,2);assert.equal((await daily.usage(pool,id)).used,15);
  await pool.query("UPDATE compel_linkedin_accounts SET session_evidence='{}',next_profile_at=NULL WHERE id=$1",[id]);
  const slot=await daily.reserve(pool,{accountId:id,owner:'owner',profileUrl:'https://www.linkedin.com/in/spacing/',jobId:'spacing'});
  const row=(await pool.query('SELECT EXTRACT(EPOCH FROM(next_profile_at-clock_timestamp()))*1000 AS wait_ms FROM compel_linkedin_accounts WHERE id=$1',[id])).rows[0];
  assert.ok(slot.intervalMs>=60000&&slot.intervalMs<=150000);assert.ok(Number(row.wait_ms)>55000&&Number(row.wait_ms)<=150000,'spacing uses the PostgreSQL clock, independent of worker clock skew');
 }finally{await db.close();}
});
test('human review approves only the exact current unclear report and never clears holds or starts processing',async()=>{
 const db=await database(),pool=db.pool,p=require('../../src/lib/account-session-policy.cjs');try{
  await core.ensure(pool);await alias.ensure(pool);const id=await alias.importProfile(pool,{profileId:'one',name:'One',expectedMemberName:'One'});
  await store.configure(pool,input(id));const a=await core.readRuntimeAccount(pool,id),key=p.evidenceKey(a);
  const e={network:{verdict:'PASS',key},fingerprint:{hash:'baseline'},gate:{verdict:'UNKNOWN',key,reportId:'report-one',fingerprintHash:'baseline',sites:[{url:'https://browserscan.net/',verdict:'UNKNOWN'}]}};
  await pool.query('UPDATE compel_linkedin_accounts SET session_evidence=$2::jsonb WHERE id=$1',[id,JSON.stringify(e)]);
  await pool.query('UPDATE compel_linkedin_accounts SET connected_at=NOW() WHERE id=$1',[id]);
  await assert.rejects(core.startProcessing(pool,id),/diagnostic gate/);
  await assert.rejects(store.approveUnknown(pool,{accountId:id,revision:1,reportId:'old-report'}),/report or configuration changed/);
  await store.approveUnknown(pool,{accountId:id,revision:1,reportId:'report-one'});
  let row=await core.readRuntimeAccount(pool,id);assert.equal(row.processing_enabled,false);assert.equal(row.attention_reason,'');assert.equal(row.session_evidence.gate.verdict,'HUMAN_APPROVED');assert.equal(p.lifecycle(row).state,'WARMUP');
  await core.acquireSession(pool,id,'owner');await pool.query("UPDATE compel_worker_sessions SET status=$2::jsonb WHERE account_id=$1",[id,JSON.stringify({runtimeVersion:'SESSION_V2',startupStage:'SESSION_CHECK_COMPLETE',browserOpen:true,sessionReady:false,status:'idle'})]);
  await core.startProcessing(pool,id);assert.equal((await core.readRuntimeAccount(pool,id)).processing_enabled,true);await core.pauseProcessing(pool,id);
  e.gate.verdict='FAIL';e.gate.sites[0].verdict='FAIL';await pool.query('UPDATE compel_linkedin_accounts SET session_evidence=$2::jsonb WHERE id=$1',[id,JSON.stringify(e)]);
  await assert.rejects(store.approveUnknown(pool,{accountId:id,revision:1,reportId:'report-one'}),/Confirmed failures/);
  e.gate.verdict='UNKNOWN';e.gate.sites[0]={verdict:'UNKNOWN',probe:{webdriver:true}};await pool.query('UPDATE compel_linkedin_accounts SET session_evidence=$2::jsonb WHERE id=$1',[id,JSON.stringify(e)]);
  await assert.rejects(store.approveUnknown(pool,{accountId:id,revision:1,reportId:'report-one'}),/Confirmed failures/);
  e.gate.verdict='UNKNOWN';e.gate.sites[0].verdict='UNKNOWN';await pool.query("UPDATE compel_linkedin_accounts SET session_evidence=$2::jsonb,attention_reason='Exact existing hold' WHERE id=$1",[id,JSON.stringify(e)]);
  await assert.rejects(store.approveUnknown(pool,{accountId:id,revision:1,reportId:'report-one'}),/account hold/);row=await core.readRuntimeAccount(pool,id);assert.equal(row.attention_reason,'Exact existing hold');
 }finally{await db.close();}
});
test('identity recapture holds on unseen drift and close cancels pending diagnostics without clearing the hold',async()=>{
 const db=await database(),pool=db.pool,p=require('../../src/lib/account-session-policy.cjs'),{createSessionGuard}=require('../../src/lib/account-session-guard.cjs');try{
  await core.ensure(pool);await alias.ensure(pool);const id=await alias.importProfile(pool,{profileId:'one',name:'One',expectedMemberName:'One'});
  await core.acquireSession(pool,id,'owner');let a=await core.readRuntimeAccount(pool,id);
  const probe={origin:'https://browserscan.net',userAgent:'Chrome/155',platform:'Win32',screen:{width:1920,height:1080},timezone:'UTC',locale:'en-GB'};
  const fingerprint=p.fingerprint(probe,{profileId:a.aliasmode_profile_id,engine:a.engine,mode:a.launch_mode,proxyId:a.proxy_id,revision:Number(a.session_revision)});
  await store.updateOwned(pool,a,'owner',{fingerprint,command:'approve-identity'});a=await core.readRuntimeAccount(pool,id);
  const guard=createSessionGuard({pool,owner:'owner',core,checks:{identityProbe:async()=>({...probe,locale:'fr-FR'})}});
  assert.equal((await guard.command(a,{})).held,true);a=await core.readRuntimeAccount(pool,id);
  assert.match(a.attention_reason,/Browser identity changed/);assert.equal(a.session_evidence.fingerprint.hash,fingerprint.hash);assert.notEqual(a.session_evidence.drift.after,fingerprint.hash);assert.equal(a.session_evidence.command,undefined);
  await alias.requestClose(pool,id);a=await core.readRuntimeAccount(pool,id);assert.equal(a.session_evidence.command,undefined);assert.match(a.attention_reason,/Browser identity changed/);
  await assert.rejects(store.request(pool,id,'diagnostics'),/manual review/);
 }finally{await db.close();}
});
