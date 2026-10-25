'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {Pool}=require('pg'),core=require('../../src/lib/linkedin-workers.cjs');
test('persistent idle sessions start without releasing ownership, preserve holds and fence replaced commands',async()=>{
 require('@next/env').loadEnvConfig(process.cwd());
 const raw=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:10000});
 const schema='compel_session_test_'+randomUUID().replaceAll('-','');assert.match(schema,/^compel_session_test_[a-f0-9]{32}$/);
 const names='compel_worker_events|compel_worker_config|compel_linkedin_accounts|compel_worker_usage|compel_worker_profile_usage|compel_worker_account_profiles|compel_worker_day|compel_worker_sessions|compel_worker_jobs|compel_research_budget|compel_prospect_runs';
 const qualify=sql=>sql.replace(new RegExp('\\b('+names+')\\b','g'),`"${schema}".$1`);
 const pool={query:(sql,v)=>raw.query(qualify(sql),v),connect:async()=>{const c=await raw.connect();return{query:(sql,v)=>c.query(qualify(sql),v),release:()=>c.release()};}};
 const identity={name:'Fixture Owner',profileUrl:'https://www.linkedin.com/in/fixture-owner/'};
 try {
  await raw.query(`CREATE SCHEMA "${schema}"`);await core.importAccounts(pool,[{email:'owner@fixture.test',password:'fixture-only'}]);
  const id='legacy-0',owner='runtime-owner';assert.equal(await core.acquireSession(pool,id,owner),true);
  await core.confirmManualSignIn(pool,id,owner,identity);
  const status={runtimeVersion:'SESSION_V2',browserOpen:true,sessionReady:true,status:'idle'};
  await core.heartbeat(pool,id,owner,status);await core.startProcessing(pool,id,60);
  const started=await core.readRuntimeAccount(pool,id);assert.equal(started.authorized,true);
  assert.equal(await core.processingAllowed(pool,id,owner,started.control_version),true);
  await core.pauseProcessing(pool,id,'Paused',false,owner,started.control_version);
  assert.equal((await core.settings(pool)).accounts[0].online,true,'Pause keeps the idle session lease');
  await core.startProcessing(pool,id,60);const restarted=await core.readRuntimeAccount(pool,id);
  await core.pauseProcessing(pool,id,'Old request',false,owner,started.control_version);
  assert.equal((await core.readRuntimeAccount(pool,id)).authorized,true);
  assert.equal(await core.processingAllowed(pool,id,owner,started.control_version),false);
  assert.equal(await core.processingAllowed(pool,id,owner,restarted.control_version),true);
  await core.pauseProcessing(pool,id,'LinkedIn requires review',true,owner);
  await assert.rejects(core.startProcessing(pool,id,60),/needs review/);
  assert.equal((await core.readRuntimeAccount(pool,id)).attention_reason,'LinkedIn requires review');
  await core.requestLogin(pool,id);const review=await core.readRuntimeAccount(pool,id);assert.ok(review.login_token);
  await core.consumeLoginRequest(pool,id,review.login_token);await core.heartbeat(pool,id,owner,{...status,status:'awaiting_login'});
  await core.confirmManualSignIn(pool,id,owner,identity);
  await assert.rejects(core.startProcessing(pool,id,60),/Finish connecting/);
  await core.heartbeat(pool,id,owner,status);await core.startProcessing(pool,id,60);
  assert.equal((await core.readRuntimeAccount(pool,id)).attention_reason,'');
  await assert.rejects(core.confirmManualSignIn(pool,id,owner,{...identity,profileUrl:'https://www.linkedin.com/in/different-member/'}),/different LinkedIn member/);
 }finally{await raw.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await raw.end();}
});
