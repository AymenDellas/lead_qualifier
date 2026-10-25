'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const core=require('../../src/lib/linkedin-workers.cjs'),daily=require('../../src/lib/engine-daily-policy.cjs');
const {database}=require('./db-fixture.cjs');
test('one-minute starts are atomic per account, survive a new process, and leave waiting jobs unlocked',async()=>{
 const db=await database(),pool=db.pool;
 try{
  let settings=await core.settings(pool);
  settings=await core.saveSettings(pool,{...settings,activeCount:2,accounts:[1,2].map(n=>({label:'Pace '+n,email:`pace-${n}@example.test`,enabled:true,dailyLimit:300}))});
  const [one,two]=settings.accounts.map(a=>a.id);
  await pool.query("UPDATE compel_linkedin_accounts SET processing_enabled=TRUE,connected_at=NOW(),confirmed_identity='{}'");
  await core.acquireSession(pool,one,'one');await core.acquireSession(pool,two,'two');
  const urls=[1,2].map(n=>`https://www.linkedin.com/in/pace-${n}/`),before=Date.now();
  const results=await Promise.all(urls.map((profileUrl,i)=>daily.reserve(pool,{accountId:one,owner:'one',profileUrl,jobId:'fixture-'+i})));
  assert.equal(results.filter(r=>r.charged).length,1);assert.equal(results.filter(r=>r.paced).length,1);
  const resume=results.find(r=>r.paced).resumeAt;assert.ok(Date.parse(resume)>=before+59000);
  assert.equal((await daily.usage(pool,one)).used,1,'waiting does not consume a daily slot');
  assert.equal((await daily.reserve({...pool},{accountId:one,owner:'one',profileUrl:urls[0],jobId:'restart'})).paced,true,'a fresh module/pool owner still sees the durable timestamp');
  assert.equal((await daily.reserve(pool,{accountId:two,owner:'two',profileUrl:urls[0],jobId:'other-account'})).charged,true,'accounts have independent intervals');
  await core.enqueue(pool,urls,{explicitRetry:true});
  const pending=await core.claim(pool,one,'one');assert.equal(pending.paced,true);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM compel_worker_jobs WHERE status='processing'")).rows[0].n,0);
  await pool.query('UPDATE compel_worker_jobs SET checkpoint=$1 WHERE profile_key=$2',[JSON.stringify({url:urls[0],profileIdentityConfirmed:true,linkedinCapture:{complete:true}}),urls[0]]);
  const cached=await core.claim(pool,one,'one');assert.equal(cached.job.resumeResult.url,urls[0],'captured work can proceed during the interval');
  await core.complete(pool,cached.job.jobId,'one',{url:urls[0],status:'REJECTED'});
  await core.pauseProcessing(pool,one);assert.equal((await core.claim(pool,one,'one')).disabled,true,'Pause wins over a pending interval');
  assert.equal((await daily.reserve(pool,{accountId:one,owner:'one',profileUrl:urls[1],jobId:'paused'})).stopped,true);
  await pool.query("UPDATE compel_linkedin_accounts SET processing_enabled=TRUE,next_profile_at=clock_timestamp()-interval '1 second' WHERE id=$1",[one]);
  const seenUrl=urls[results.findIndex(r=>r.charged)];
  assert.equal((await daily.reserve(pool,{accountId:one,owner:'one',profileUrl:seenUrl,jobId:'same-day-retry'})).charged,false);
  assert.equal((await daily.usage(pool,one)).used,1,'a retry after the interval still does not consume another unique-profile slot');
 }finally{await db.close();}
});
