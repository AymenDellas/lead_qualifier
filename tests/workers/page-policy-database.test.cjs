'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),core=require('../../src/lib/linkedin-workers.cjs'),{database}=require('./db-fixture.cjs');
test('old page budgets and schedules are inert; concurrent counters and partial captures retain ownership',async()=>{
 const db=await database(),{pool}=db;
 try{
  let settings=await core.settings(pool);settings=await core.saveSettings(pool,{...settings,activeCount:1,accounts:[{label:'Fixture',email:'page@example.test',enabled:true,dailyLimit:25,dailyRequestLimit:1,activityLimits:{profile:{hourly:1,daily:1}},workingHours:{timezone:'UTC',days:[],start:'01:00',end:'01:01'}}]});
  const id=settings.accounts[0].id;await core.acquireSession(pool,id,'owner');await core.confirmManualSignIn(pool,id,'owner',{name:'Fixture',profileUrl:'https://www.linkedin.com/in/page-owner/'});await core.heartbeat(pool,id,'owner',{runtimeVersion:'SESSION_V2',status:'idle',sessionReady:true,browserOpen:true});await core.startProcessing(pool,id);
  await pool.query("UPDATE compel_linkedin_accounts SET next_check_at=NOW()+interval '1 year',daily_request_limit=1,activity_limits='{\"profile\":{\"daily\":1,\"hourly\":1}}' WHERE id=$1",[id]);
  const counts=await Promise.all(Array.from({length:6},()=>core.recordLinkedInAction(pool,id,'owner','profile_page')));assert.equal(counts.length,6);assert.ok(counts.every(r=>!r.waitMs&&!r.stopped));assert.equal((await core.settings(pool)).accounts[0].dailyRequests,6);
  const url='https://www.linkedin.com/in/partial-fixture/';await core.enqueue(pool,[url]);const claimed=await core.claim(pool,id,'owner');
  const saved={url,profileIdentityConfirmed:true,firstName:'Fixture',emails:['fixture@example.test'],linkedinAccountId:id,linkedinCapture:{version:2,stage:'contact',complete:false},status:'PENDING'};
  await core.reserveProfile(pool,{intervalMs:0,accountId:id,owner:'owner',profileUrl:url,jobId:claimed.job.jobId});await core.checkpoint(pool,claimed.job.jobId,'owner',saved);
  // The queue compares retry_at with PostgreSQL time. Use that same clock for
  // an immediate fixture retry; PC/server skew must not make this test race.
  const retryAt=(await pool.query('SELECT clock_timestamp() AS retry_at')).rows[0].retry_at;
  await core.defer(pool,claimed.job.jobId,'owner',{...saved,status:'ERROR',failure:{stage:'linkedin',code:'BROWSER_CRASH',reason:'Fixture crash',retryable:true}},retryAt.toISOString());
  const resumed=await core.claim(pool,id,'owner');assert.equal(resumed.job.resumeCapture,true);assert.deepEqual(resumed.job.resumeResult.emails,saved.emails);assert.equal(resumed.dailyCount,1);
  assert.equal((await core.reserveProfile(pool,{intervalMs:0,accountId:id,owner:'owner',profileUrl:url,jobId:resumed.job.jobId})).charged,false);
  await core.pauseProcessing(pool,id,'Security review',true,'owner');assert.equal(await core.processingAllowed(pool,id,'owner'),false);await assert.rejects(core.startProcessing(pool,id),/needs review/);
 }finally{await db.close();}
});
