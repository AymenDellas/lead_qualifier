'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const core=require('../../src/lib/linkedin-workers.cjs'),daily=require('../../src/lib/engine-daily-policy.cjs');
const {database}=require('./db-fixture.cjs');
test('three accounts claim distinct shared jobs concurrently with independent daily/interval reservations and holds',async()=>{
 const db=await database(),{pool}=db;
 try{
  let config=await core.settings(pool);
  config=await core.saveSettings(pool,{...config,activeCount:1,accounts:[1,2,3].map(n=>({label:'Parallel '+n,email:`parallel-${n}@example.test`,enabled:true,dailyLimit:300}))});
  assert.equal(config.activeCount,3);
  await pool.query('UPDATE compel_worker_config SET active_count=1');
  assert.equal((await core.settings(pool)).activeCount,3,'legacy value 1 is an enable switch, not a one-account slice');
  await pool.query("UPDATE compel_linkedin_accounts SET processing_enabled=TRUE,connected_at=NOW(),confirmed_identity='{}'");
  const ids=config.accounts.map(a=>a.id),owners=ids.map((_,i)=>'parallel-owner-'+i);
  await Promise.all(ids.map((id,i)=>core.acquireSession(pool,id,owners[i])));
  const urls=[1,2,3,4,5,6].map(n=>`https://www.linkedin.com/in/parallel-job-${n}/`);
  const queued=await core.enqueue(pool,[...urls,...urls]);assert.equal(queued.queuedCount,6);
  const claims=await Promise.all(ids.map((id,i)=>core.claim(pool,id,owners[i])));
  assert.equal(new Set(claims.map(c=>c.job.jobId)).size,3);assert.equal(new Set(claims.map(c=>c.job.linkedinUrl)).size,3);
  const starts=await Promise.all(ids.map((id,i)=>daily.reserve(pool,{accountId:id,owner:owners[i],profileUrl:claims[i].job.linkedinUrl,jobId:claims[i].job.jobId})));
  assert.ok(starts.every(start=>start.charged));
  const waiting=await Promise.all(ids.map((id,i)=>core.claim(pool,id,owners[i])));assert.ok(waiting.every(c=>c.paced));
  assert.equal((await pool.query("SELECT count(*)::int n FROM compel_worker_jobs WHERE status='processing'")).rows[0].n,3,'interval waits do not preclaim more locks');
  await core.pauseProcessing(pool,ids[2],'Security review fixture',true,owners[2]);
  assert.equal((await core.claim(pool,ids[2],owners[2])).disabled,true);
  await pool.query("UPDATE compel_linkedin_accounts SET next_profile_at=NOW()-interval '1 second' WHERE id=ANY($1::text[])",[ids.slice(0,2)]);
  const next=await Promise.all(ids.slice(0,2).map((id,i)=>core.claim(pool,id,owners[i])));assert.ok(next.every(c=>c.job));
  assert.ok(next.every(c=>!claims.some(old=>old.job.jobId===c.job.jobId)),'another account cannot steal an existing profile lock');
  const status=await core.queueStatus(pool,{includeHistory:false});assert.equal(status.workerStatus.configuredAccounts,3);
  const held=(await core.settings(pool)).accounts[2];assert.equal(held.attentionReason,'Security review fixture');assert.equal(held.processingEnabled,false);
 }finally{await db.close();}
});
