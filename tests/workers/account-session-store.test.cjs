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
