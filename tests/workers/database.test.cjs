'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),core=require('../../src/lib/linkedin-workers.cjs'),{database}=require('./db-fixture.cjs');
test('concurrent claims, ownership fences, explicit release, duplicate protection and checkpoints use isolated PostgreSQL state',async()=>{
 const db=await database(),{pool}=db;
 try{
  await core.importAccounts(pool,[{email:'fixture@example.test',password:'fixture-only'}]);
  await pool.query("UPDATE compel_linkedin_accounts SET processing_enabled=TRUE,connected_at=NOW()");await core.acquireSession(pool,'legacy-0','owned');
  assert.equal(await core.acquireSession(pool,'legacy-0','impostor'),false);
  const urls=[1,2,3].map(n=>`https://www.linkedin.com/in/lock-${n}/`);const queued=await core.enqueue(pool,urls);assert.equal(queued.queuedCount,3);assert.equal((await core.enqueue(pool,urls)).queuedCount,0);
  const [one,two]=await Promise.all([core.claim(pool,'legacy-0','owned'),core.claim(pool,'legacy-0','owned')]);assert.notEqual(one.job.jobId,two.job.jobId);assert.equal(one.dailyCount,0);
  const checkpoint={url:one.job.linkedinUrl,profileIdentityConfirmed:true,firstName:'Saved',linkedinCapture:{version:2,stage:'activity',complete:false}};
  await core.checkpoint(pool,one.job.jobId,'owned',checkpoint);await assert.rejects(core.checkpoint(pool,one.job.jobId,'impostor',{}),/lease lost/);
  await pool.query("UPDATE compel_worker_jobs SET lease_until=NOW()-interval '1 second' WHERE id=$1",[one.job.jobId]);
  const third=await core.claim(pool,'legacy-0','owned');assert.notEqual(third.job.jobId,one.job.jobId,'expiry alone never steals a job');await assert.rejects(core.complete(pool,one.job.jobId,'owned',{}),/lease lost/);
  await core.releaseSession(pool,'legacy-0','owned',{status:'offline'});await core.acquireSession(pool,'legacy-0','next');
  const resumed=await core.claim(pool,'legacy-0','next');assert.equal(resumed.job.jobId,one.job.jobId);assert.equal(resumed.job.resumeResult.firstName,'Saved');assert.equal(resumed.job.resumeCapture,true);
  await core.complete(pool,resumed.job.jobId,'next',{...checkpoint,status:'REVIEW',failure:{stage:'qualification',reason:'Review saved evidence',retryable:false}});
  assert.equal((await core.enqueue(pool,[resumed.job.linkedinUrl])).queuedCount,0);assert.equal((await core.retryFailed(pool)).queuedCount,0,'terminal REVIEW never re-enters Retry failed');
  await core.clearQueue(pool);assert.equal((await core.jobStatus(pool,resumed.job.jobId)).status,'done');
  await core.importResult(pool,'job_unicode',{completedAt:new Date().toISOString(),result:{url:urls[0],status:'REJECTED',logs:['😀\ud83d broken\u0000']}});assert.equal((await core.jobStatus(pool,'job_unicode')).result.logs[0],'😀� broken');
 }finally{await db.close();}
});
test('CRM research preserves contact history, resets verification on changed email, and records nonretryable capture reviews',async()=>{
 const db=await database(),{pool}=db;
 try{
  await core.ensure(pool);await pool.query(`CREATE TABLE leads(id TEXT PRIMARY KEY,linkedin_url TEXT,first_name TEXT,last_name TEXT,website TEXT,website_source TEXT,location TEXT,email TEXT,all_emails TEXT,email_status TEXT,
   pipeline_status TEXT,do_not_contact BOOLEAN,contacted BOOLEAN,contacted_source TEXT,created_at TIMESTAMPTZ DEFAULT NOW(),email_verification_method TEXT,email_verification_reason TEXT,email_verification_score INTEGER,email_verified_at TIMESTAMPTZ,email_verification_expires_at TIMESTAMPTZ)`);
  const store=require('../../src/lib/worker-research-store.cjs'),{research}=require('../prospects/fixtures.cjs'),r=research({researchedAt:new Date().toISOString(),lastActivityAt:new Date().toISOString()});
  const saved=await store.saveWorkerResearch(pool,{linkedinUrl:r.linkedinUrl,research:r,email:'ava@avamorgan.test'});assert.equal(saved.pipelineStatus,'QUALIFIED');
  await pool.query("UPDATE leads SET do_not_contact=TRUE,contacted=TRUE,contacted_source='PLATFORM',email_status='VALID',email_verification_method='SMTP_DIRECT' WHERE id=$1",[saved.id]);
  await store.saveWorkerResearch(pool,{linkedinUrl:r.linkedinUrl,research:{...r,contacts:[{...r.contacts[0],address:'other@avamorgan.test'}]},email:'other@avamorgan.test'});
  let lead=(await pool.query('SELECT * FROM leads WHERE id=$1',[saved.id])).rows[0];assert.equal(lead.do_not_contact,true);assert.equal(lead.contacted_source,'PLATFORM');assert.equal(lead.email_status,'UNVERIFIED');assert.equal(lead.email_verification_method,null);
  await store.saveCaptureReview(pool,{job:{linkedinUrl:r.linkedinUrl},owner:'fixture',capture:{profileIdentityConfirmed:false},failure:{code:'PROFILE_REDIRECT',reason:'Different member URL'}});
  lead=(await pool.query('SELECT * FROM leads WHERE id=$1',[saved.id])).rows[0];assert.equal(lead.pipeline_status,'REVIEW');assert.equal(lead.email,'other@avamorgan.test');assert.equal(lead.do_not_contact,true);assert.match(lead.prospect_assessment.research.limitations[0],/PROFILE_REDIRECT/);
 }finally{await db.close();}
});
