'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),core=require('../../src/lib/linkedin-workers.cjs'),{database}=require('./db-fixture.cjs');
test('manual controls preserve security holds and queued work; processing persists until explicit pause',async()=>{
 const db=await database(),{pool}=db,identity=n=>({name:'Fixture '+n,profileUrl:`https://www.linkedin.com/in/control-${n}/`});
 try{
  let config=await core.settings(pool);config=await core.saveSettings(pool,{...config,activeCount:2,accounts:[1,2].map(n=>({label:'Fixture '+n,email:`control-${n}@example.test`,enabled:true,dailyLimit:25,password:'ignored-by-manual-login'}))});
  const [one,two]=config.accounts.map(a=>a.id);assert.ok(config.accounts.every(a=>!a.hasPassword));await assert.rejects(core.startProcessing(pool,one),/manual sign-in/);
  await core.requestLogin(pool,one);const command=(await core.readRuntimeAccount(pool,one)).login_token;await core.acquireSession(pool,one,'one');assert.equal(await core.consumeLoginRequest(pool,one,command),true);
  await core.confirmManualSignIn(pool,one,'one',identity(1));assert.equal((await core.readRuntimeAccount(pool,one)).authorized,false);
  await core.heartbeat(pool,one,'one',{runtimeVersion:'SESSION_V2',status:'idle',browserOpen:true,sessionReady:true});await core.startProcessing(pool,one);
  const before=await core.readRuntimeAccount(pool,one);await core.startProcessing(pool,one);const next=await core.readRuntimeAccount(pool,one);assert.notEqual(next.control_version,before.control_version);
  await pool.query("UPDATE compel_linkedin_accounts SET processing_until=NOW()-interval '1 day' WHERE id=$1",[one]);assert.equal((await core.readRuntimeAccount(pool,one)).authorized,true,'the removed hour window cannot stop saved intent');
  await core.pauseProcessing(pool,one,'Old command',false,'one',before.control_version);assert.equal((await core.readRuntimeAccount(pool,one)).authorized,true);
  const queued=await core.enqueue(pool,['https://www.linkedin.com/in/control-queued/']);
  await core.pauseProcessing(pool,one,'Security warning',true,'one');await assert.rejects(core.startProcessing(pool,one),/needs review/);assert.equal((await core.claim(pool,one,'one')).disabled,true);
  config=await core.settings(pool);await core.saveSettings(pool,{...config,accounts:config.accounts.map(a=>({...a,attentionReason:'',processingEnabled:true}))});await assert.rejects(core.startProcessing(pool,one),/needs review/);
  await core.releaseSession(pool,one,'one',{status:'offline'});await core.acquireSession(pool,one,'review');await core.requestLogin(pool,one);
  const review=await core.readRuntimeAccount(pool,one);await core.consumeLoginRequest(pool,one,review.login_token);await core.confirmManualSignIn(pool,one,'review',identity(1));assert.equal((await core.readRuntimeAccount(pool,one)).authorized,false);
  await core.acquireSession(pool,two,'two');await assert.rejects(core.confirmManualSignIn(pool,two,'two',identity(1)),/another saved account/);await core.confirmManualSignIn(pool,two,'two',identity(2));
  await core.releaseSession(pool,one,'review',{status:'offline'});await core.startProcessing(pool,one);await core.acquireSession(pool,one,'work');
  await Promise.all(Array.from({length:10},()=>core.recordLinkedInAction(pool,one,'work','profile_page')));assert.equal((await core.settings(pool)).accounts[0].dailyRequests,10);assert.equal((await core.settings(pool)).accounts[0].dailyCount,0);
  assert.equal((await core.recordLinkedInAction(pool,one,'impostor','contact')).stopped,true);await assert.rejects(core.recordLinkedInAction(pool,one,'work','contact',{manual:true}),/only verify/);
  await core.pauseProcessing(pool,one);assert.equal((await core.recordLinkedInAction(pool,one,'work','profile_page')).stopped,true);assert.equal((await core.jobStatus(pool,queued.jobs[0])).status,'queued');
 }finally{await db.close();}
});
