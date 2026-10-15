'use strict';
// Uses isolated tables in a new test schema, never real leads or account data.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {Pool}=require('pg'),core=require('../../src/lib/linkedin-workers.cjs');
test('accounts, concurrent leases, recovery, hosted queue and email placement work against PostgreSQL',async()=>{
 for(const line of fs.readFileSync(path.resolve(__dirname,'../../.env.local'),'utf8').split('\n')){
  const match=line.replace(/\r/g,'').match(/^([^#=]+)=(.+)$/);
  if(match)process.env[match[1].trim()]=match[2].trim().replace(/^(['"])([\s\S]*)\1$/,'$2');
 }
 const raw=new Pool({connectionString:process.env.DATABASE_URL,max:6,connectionTimeoutMillis:10000,ssl:{rejectUnauthorized:false}});
 const schema='compel_worker_test_'+randomUUID().replaceAll('-','');
 assert.match(schema,/^compel_worker_test_[a-f0-9]{32}$/);
 const qualify=sql=>sql.replace(/\b(compel_worker_config|compel_linkedin_accounts|compel_worker_usage|compel_worker_profile_usage|compel_worker_sessions|compel_worker_jobs|compel_research_budget|leads)\b/g,`"${schema}".$1`);
 const pool={query:(sql,values)=>raw.query(qualify(sql),values),connect:async()=>{
  const client=await raw.connect();return{query:(sql,values)=>client.query(qualify(sql),values),release:()=>client.release()};
 }};
 try{
  await raw.query(`CREATE SCHEMA "${schema}"`);
  await core.importAccounts(pool,[{email:'first@example.test',password:'private'},{email:'second@example.test',password:'private2'}],{date:new Date().toISOString().slice(0,10),count:2});
  let config=await core.settings(pool);
  assert.equal(config.accounts.length,2);assert.equal(config.accounts[0].dailyCount,2);
  assert.ok(!JSON.stringify(config).includes('private'));assert.equal(config.activeCount,1);
  const originalProfile=(await pool.query('SELECT profile_key FROM compel_linkedin_accounts WHERE id=$1',['legacy-0'])).rows[0].profile_key;
  config=await core.saveSettings(pool,{...config,activeCount:2,accounts:config.accounts.map(a=>({...a,password:''}))});
  assert.equal((await core.selectedAccounts(pool)).length,2);
  assert.equal((await pool.query('SELECT profile_key FROM compel_linkedin_accounts WHERE id=$1',['legacy-0'])).rows[0].profile_key,originalProfile);
  assert.equal(core.decrypt((await pool.query('SELECT secret FROM compel_linkedin_accounts WHERE id=$1',['legacy-0'])).rows[0].secret),'private');
  await core.ensure({query:pool.query});
  assert.equal((await raw.query(`SELECT count(*)::integer AS n FROM information_schema.sequences WHERE sequence_schema=$1`,[schema])).rows[0].n,1);
  await assert.rejects(core.saveSettings(pool,{...config,revision:0}));
  await assert.rejects(core.saveSettings(pool,{...config,accounts:config.accounts.map((a,i)=>({...a,email:i===0?'replacement@example.test':a.email}))}));
  const duplicate=await Promise.all([core.enqueue(pool,['https://www.linkedin.com/in/first/']),core.enqueue(pool,['https://uk.linkedin.com/in/FIRST/?trk=fixture'])]);
  assert.equal(duplicate.reduce((sum,r)=>sum+r.jobs.length,0),1);
  await core.enqueue(pool,['https://www.linkedin.com/in/second/','https://www.linkedin.com/in/third/']);
  assert.equal(await core.acquireSession(pool,'legacy-0','one'),true);
  assert.equal(await core.acquireSession(pool,'legacy-0','impostor'),false);
  assert.equal(await core.acquireSession(pool,'legacy-1','two'),true);
  const [first,second]=await Promise.all([core.claim(pool,'legacy-0','one'),core.claim(pool,'legacy-1','two')]);
  assert.notEqual(first.job.jobId,second.job.jobId);
  assert.equal(first.dailyCount,3);assert.equal(second.dailyCount,1);
  await core.heartbeat(pool,'legacy-0','one',{status:'processing',signedIn:{name:'Fixture First',profileUrl:'https://www.linkedin.com/in/first/',memberUrn:'urn:li:fs_miniProfile:fixtureFirst',checkedAt:new Date().toISOString()}});
  assert.equal((await core.settings(pool)).accounts[0].signedIn.name,'Fixture First');
  await assert.rejects(core.heartbeat(pool,'legacy-0','impostor',{}));
  await pool.query(`UPDATE compel_worker_jobs SET lease_until=NOW()-interval '1 minute' WHERE id=$1`,[first.job.jobId]);
  const recovered=await core.claim(pool,'legacy-1','two');assert.equal(recovered.job.jobId,first.job.jobId);
  assert.equal(recovered.dailyCount,second.dailyCount,'expired leases and account changes do not charge the profile twice');
  await assert.rejects(core.complete(pool,first.job.jobId,'one',{status:'QUALIFIED'}));
  await core.complete(pool,recovered.job.jobId,'two',{status:'REJECTED',primaryEmail:''});
  assert.equal((await core.jobStatus(pool,recovered.job.jobId)).status,'done');
  const completedAgain=await core.enqueue(pool,[recovered.job.linkedinUrl]);
  assert.equal(completedAgain.queuedCount,0,'completed profiles cannot consume another allowance on a repeated batch');
  assert.match(completedAgain.skipped[0].reason,/completed today/);
  await core.clearQueue(pool);assert.equal((await core.jobStatus(pool,second.job.jobId)).status,'processing');
  await core.releaseSession(pool,'legacy-1','two',{status:'offline'});
  assert.equal((await core.jobStatus(pool,second.job.jobId)).status,'queued');
  await core.clearQueue(pool);
  const ordered=await core.enqueue(pool,Array.from({length:1000},(_,n)=>`https://www.linkedin.com/in/bulk-${n}/`));
  assert.equal(ordered.jobs.length,1000);
  assert.equal((await core.claim(pool,'legacy-0','one')).job.linkedinUrl,'https://www.linkedin.com/in/bulk-0/');
  await core.releaseSession(pool,'legacy-0','one',{status:'offline'});await core.clearQueue(pool);
  await core.enqueue(pool,['https://www.linkedin.com/in/remaining/']);await core.acquireSession(pool,'legacy-0','one');
  config=await core.settings(pool);config=await core.saveSettings(pool,{...config,activeCount:0});
  assert.equal((await core.claim(pool,'legacy-0','one')).disabled,true);
  config=await core.saveSettings(pool,{...config,activeCount:1,accounts:config.accounts.map(a=>({...a,dailyLimit:1}))});
  assert.equal((await core.claim(pool,'legacy-0','one')).limited,true);
  await core.requestLogin(pool,'legacy-1');assert.equal((await core.settings(pool)).accounts[1].loginPending,true);
  await pool.query("UPDATE compel_linkedin_accounts SET login_requested_at='2026-10-09 00:11:49.280123+00' WHERE id='legacy-1'");
  const request=(await pool.query("SELECT login_requested_at,login_requested_at::text AS token FROM compel_linkedin_accounts WHERE id='legacy-1'")).rows[0];
  assert.equal(await core.consumeLoginRequest(pool,'legacy-1',request.login_requested_at),false,'a hydrated Date loses the PostgreSQL microseconds');
  assert.equal(await core.consumeLoginRequest(pool,'legacy-1',request.token),true);
  assert.equal((await core.settings(pool)).accounts[1].loginPending,false);
  await core.requestLogin(pool,'legacy-1');
  assert.equal(await core.consumeLoginRequest(pool,'legacy-1',request.token),false,'a newer sign-in request must survive an old browser');
  assert.equal((await core.settings(pool)).accounts[1].loginPending,true);
  await core.requestLogout(pool,'legacy-1');
  config=await core.settings(pool);
  assert.equal(config.accounts[1].enabled,false);
  assert.equal(config.accounts[1].logoutPending,true);
  assert.equal(config.accounts[1].loginPending,false);
  assert.equal(config.accounts[0].enabled,true);
  await assert.rejects(core.requestLogin(pool,'legacy-1'),/sign-out is still pending/);
  const logoutToken=(await pool.query("SELECT logout_requested_at::text AS token FROM compel_linkedin_accounts WHERE id='legacy-1'")).rows[0].token;
  assert.equal(await core.finishLogout(pool,'legacy-1','2020-01-01T00:00:00Z'),false);
  assert.equal(await core.finishLogout(pool,'legacy-1',logoutToken),true);
  config=await core.settings(pool);assert.equal(config.accounts[1].signedOut,true);assert.equal(config.accounts[1].signedIn,null);
  config=await core.saveSettings(pool,{...config,activeCount:2,accounts:config.accounts.map(a=>({...a,enabled:true}))});
  assert.equal((await core.selectedAccounts(pool)).length,1,'saved credentials cannot auto-login a signed-out account');
  await core.requestLogin(pool,'legacy-1');
  config=await core.settings(pool);assert.equal(config.accounts[1].signedOut,false);assert.equal(config.accounts[1].loginPending,true);
  const beforeRemove=config.accounts[0].dailyCount;
  config=await core.saveSettings(pool,{...config,activeCount:1,accounts:config.accounts.filter(a=>a.id!=='legacy-0')});
  config=await core.saveSettings(pool,{...config,activeCount:2,accounts:[...config.accounts,{label:'Restored',email:'first@example.test',password:'private',enabled:true,dailyLimit:400}]});
  assert.equal(config.accounts.find(a=>a.email==='first@example.test').id,'legacy-0');
  assert.equal(config.accounts.find(a=>a.id==='legacy-0').dailyCount,beforeRemove);
  const status=await core.queueStatus(pool);assert.equal(status.queueSize,1);assert.equal(status.recentResults.length,1);
  // Failed interpretation resumes the saved profile even when the scrape allowance is exhausted.
  const savedProfile={url:'https://www.linkedin.com/in/recover/',profileIdentityConfirmed:true,firstName:'Saved',status:'PENDING',logs:[]};
  await core.clearQueue(pool);
  const recoveredBatch=await core.enqueue(pool,[savedProfile.url]);
  await pool.query(`UPDATE compel_worker_jobs SET status='done',result=$2::jsonb,completed_at=NOW() WHERE id=$1`,[recoveredBatch.jobs[0],JSON.stringify({...savedProfile,status:'ERROR',logs:['Automated interpretation rate limit (HTTP 429).']})]);
  const newerBatch=await core.enqueue(pool,['https://www.linkedin.com/in/newer-success/']);
  await pool.query("UPDATE compel_worker_jobs SET created_at=NOW()+interval '2 minutes',status='done',result='{\"status\":\"REJECTED\"}'::jsonb,completed_at=NOW() WHERE id=$1",[newerBatch.jobs[0]]);
  const retries=await core.retryFailed(pool);
  assert.equal(retries.researchOnly,1,'a newer unrelated batch must not hide older failed profiles');assert.equal(retries.scrapeCount,0);
  await pool.query('UPDATE compel_linkedin_accounts SET daily_limit=1 WHERE id=$1',['legacy-0']);
  const beforeRetry=(await core.settings(pool)).accounts.find(a=>a.id==='legacy-0').dailyCount;
  await core.releaseSession(pool,'legacy-0','one',{status:'offline'});
  assert.equal(await core.acquireSession(pool,'legacy-0','recovery'),true);
  const resume=await core.claim(pool,'legacy-0','recovery');
  assert.equal(resume.job.resumeResult.firstName,'Saved');assert.equal(resume.dailyCount,beforeRetry);
  await core.checkpoint(pool,resume.job.jobId,'recovery',savedProfile);
  await assert.rejects(core.defer(pool,resume.job.jobId,'impostor',{status:'ERROR'},new Date().toISOString()));
  await core.defer(pool,resume.job.jobId,'recovery',{status:'ERROR',failure:{stage:'research',code:'AI_RATE_LIMIT',reason:'Waiting for quota',retryable:true}},new Date(Date.now()+60000).toISOString());
  assert.equal((await core.queueStatus(pool)).waitingCount,1);
  assert.equal((await core.claim(pool,'legacy-0','recovery')).limited,true,'a future retry cannot be claimed early');
  await pool.query('UPDATE compel_worker_jobs SET retry_at=NOW() WHERE id=$1',[resume.job.jobId]);
  const model=process.env.PROSPECT_RESEARCH_MODEL?.trim()||'openai/gpt-oss-120b';
  assert.equal((await core.reserveResearch(pool,model,4000)).ready,true);
  assert.equal((await core.claim(pool,'legacy-0','recovery',{requiresAI:true})).limited,true,'AI-dependent jobs must still respect the shared provider cooldown');
  assert.equal((await core.queueStatus(pool)).waitingCount,0,'email/activity workers do not wait on an unused AI budget');
  const secondResume=await core.claim(pool,'legacy-0','recovery');assert.equal(secondResume.job.retryCount,1);assert.equal(secondResume.dailyCount,beforeRetry);
  await core.complete(pool,secondResume.job.jobId,'recovery',{...savedProfile,status:'REJECTED'});
  // An activity failure needs a new LinkedIn check, not the same undated
  // checkpoint. It respects the account limit and survives same-day dedupe.
  const activityBatch=await core.enqueue(pool,['https://www.linkedin.com/in/undated-recovery/']);
  const failed={...savedProfile,url:'https://www.linkedin.com/in/undated-recovery/',status:'ERROR',failure:{stage:'linkedin',code:'ACTIVITY_UNCONFIRMED',reason:'Activity has no date',retryable:false}};
  await pool.query("UPDATE compel_worker_jobs SET status='done',result=$2::jsonb,checkpoint=$3::jsonb,completed_at=NOW() WHERE id=$1",[activityBatch.jobs[0],JSON.stringify(failed),JSON.stringify(savedProfile)]);
  await core.importResult(pool,'job_older_undated',{completedAt:new Date().toISOString(),result:failed});
  // Make the original latest again, leaving an older same-day completed row.
  await pool.query('UPDATE compel_worker_jobs SET queue_order=queue_order+100000 WHERE id=$1',[activityBatch.jobs[0]]);
  const fresh=await core.retryFailed(pool);assert.equal(fresh.scrapeCount,1);assert.equal(fresh.researchOnly,0);
  assert.equal((await core.claim(pool,'legacy-0','recovery')).limited,true);
  const retryRow=(await pool.query('SELECT * FROM compel_worker_jobs WHERE id=$1',[activityBatch.jobs[0]])).rows[0];
  assert.equal(retryRow.status,'pending');assert.equal(retryRow.checkpoint,null);assert.equal(retryRow.payload.explicitRetry,true);
  await pool.query('UPDATE compel_linkedin_accounts SET daily_limit=400 WHERE id=$1',['legacy-0']);
  const refreshed=await core.claim(pool,'legacy-0','recovery');assert.equal(refreshed.job.resumeResult,undefined);assert.equal(refreshed.dailyCount,beforeRetry+1);
  await core.complete(pool,refreshed.job.jobId,'recovery',{...failed,status:'REJECTED'});
  await pool.query('UPDATE compel_linkedin_accounts SET daily_limit=1 WHERE id=$1',['legacy-0']);
  const reservations=await Promise.all([core.reserveResearch(pool,'fixture-model',4000),core.reserveResearch(pool,'fixture-model',4000)]);
  assert.equal(reservations.filter(r=>r.ready).length,1,'all accounts share one provider budget');
  await core.coolResearch(pool,'fixture-model',new Date(Date.now()+3600000).toISOString());
  assert.ok(Date.parse((await core.reserveResearch(pool,'fixture-model',1000)).retryAt)>Date.now()+3500000);
  await core.importResult(pool,'job_old_text',{completedAt:new Date().toISOString(),result:{url:'https://www.linkedin.com/in/old/',status:'REJECTED',logs:['😀\ud83d broken\u0000']}});
  assert.equal((await core.jobStatus(pool,'job_old_text')).result.logs[0],'😀� broken');
  await pool.query(`CREATE TABLE leads(id TEXT PRIMARY KEY,linkedin_url TEXT,first_name TEXT,last_name TEXT,website TEXT,website_source TEXT,location TEXT,email TEXT,all_emails TEXT,email_status TEXT,
   pipeline_status TEXT,do_not_contact BOOLEAN,contacted BOOLEAN,contacted_source TEXT,created_at TIMESTAMPTZ DEFAULT NOW(),email_verification_method TEXT,email_verification_reason TEXT,email_verification_score INTEGER,email_verified_at TIMESTAMPTZ,email_verification_expires_at TIMESTAMPTZ)`);
  const {research}=require('../prospects/fixtures.cjs'),{saveWorkerResearch}=require('../../src/lib/worker-research-store.cjs');
  const r=research({researchedAt:new Date().toISOString()});
  let saved=await saveWorkerResearch(pool,{linkedinUrl:r.linkedinUrl,research:{...r,contacts:[]},email:''});
  assert.equal(saved.pipelineStatus,'NOT_QUALIFIED');assert.equal(saved.tier,'A');
  saved=await saveWorkerResearch(pool,{linkedinUrl:r.linkedinUrl,research:r,email:'ava@avamorgan.test'});
  assert.equal(saved.pipelineStatus,'QUALIFIED');
  let lead=(await pool.query('SELECT * FROM leads WHERE id=$1',[saved.id])).rows[0];
  assert.equal(lead.email_status,'UNVERIFIED');assert.equal(lead.email_verification_method,null);
  await pool.query(`UPDATE leads SET email_status='VALID',email_verification_method='SMTP_DIRECT',email_verification_score=99,do_not_contact=TRUE,contacted=TRUE,contacted_source='PLATFORM' WHERE id=$1`,[saved.id]);
  const replacement={...r,contacts:[{...r.contacts[0],address:'other@avamorgan.test'}]};
  await saveWorkerResearch(pool,{linkedinUrl:r.linkedinUrl,research:replacement,email:'other@avamorgan.test'});
  lead=(await pool.query('SELECT * FROM leads WHERE id=$1',[saved.id])).rows[0];
  assert.equal(lead.email_verification_method,null);assert.equal(lead.email_verification_score,null);assert.equal(lead.do_not_contact,true);assert.equal(lead.contacted_source,'PLATFORM');
  // Qualification can land immediately while a large website continues from
  // its saved graph. Continuations neither block new leads nor consume quota.
  const continuationResearch={...r,crawl:{version:1,complete:false,pending:['https://avamorgan.test/real-route'],failed:[],stoppedReason:'Time budget reached'}};
  const partial={...savedProfile,status:'QUALIFIED',primaryEmail:'ava@avamorgan.test',prospectQualification:{research:continuationResearch}};
  const continuationBatch=await core.enqueue(pool,['https://www.linkedin.com/in/continuation-fixture/']);
  await pool.query('UPDATE compel_worker_jobs SET checkpoint=$2::jsonb WHERE id=$1',[continuationBatch.jobs[0],JSON.stringify(partial)]);
  const parent=await core.claim(pool,'legacy-0','recovery');
  await core.complete(pool,parent.job.jobId,'recovery',partial);
  assert.equal((await core.jobStatus(pool,parent.job.jobId)).status,'done');
  const continuation=(await pool.query("SELECT * FROM compel_worker_jobs WHERE status='pending' AND payload->>'websiteContinuation'='true'")).rows[0];
  assert.ok(continuation);assert.equal(continuation.checkpoint.primaryEmail,'ava@avamorgan.test');
  const freshBehindLimit=await core.enqueue(pool,['https://www.linkedin.com/in/fresh-at-cap/']);
  await pool.query('UPDATE compel_worker_jobs SET retry_at=NOW() WHERE id=$1',[continuation.id]);
  const resumed=await core.claim(pool,'legacy-0','recovery');
  assert.equal(resumed.job.websiteContinuation,true);assert.equal(resumed.dailyCount,beforeRetry+1);
  assert.equal(resumed.job.retryCount,1);
  await core.complete(pool,resumed.job.jobId,'recovery',partial);
  for(const retryCount of [2,3]){
   const next=(await pool.query("SELECT id FROM compel_worker_jobs WHERE status='pending' AND checkpoint IS NOT NULL")).rows[0];
   assert.ok(next);await pool.query('UPDATE compel_worker_jobs SET retry_at=NOW() WHERE id=$1',[next.id]);
   const claimed=await core.claim(pool,'legacy-0','recovery');
   assert.equal(claimed.job.retryCount,retryCount,'pending routes cannot reset the continuation counter');
   await core.complete(pool,claimed.job.jobId,'recovery',partial);
  }
  assert.equal((await core.jobStatus(pool,freshBehindLimit.jobs[0])).status,'queued','fresh work is retained at the cap while cached continuations finish');
  await core.clearQueue(pool);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM compel_worker_jobs WHERE status='pending'")).rows[0].count,0);
  const blockedBatch=await core.enqueue(pool,['https://www.linkedin.com/in/blocked-fixture/']);
  await pool.query('UPDATE compel_worker_jobs SET checkpoint=$2::jsonb WHERE id=$1',[blockedBatch.jobs[0],JSON.stringify(partial)]);
  const blockedParent=await core.claim(pool,'legacy-0','recovery');
  await core.complete(pool,blockedParent.job.jobId,'recovery',{...partial,prospectQualification:{research:{...continuationResearch,crawl:{...continuationResearch.crawl,version:2,retryable:false}}}});
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM compel_worker_jobs WHERE status='pending'")).rows[0].count,0,'terminal site failures cannot create a continuation');
  // Legacy Inbox copies, active jobs and previously assessed copies are all
  // excluded before a region's next batch is limited.
  await pool.query('ALTER TABLE leads ADD COLUMN fit_score INTEGER');
  await pool.query(`INSERT INTO leads(id,linkedin_url,location,fit_score,pipeline_status) VALUES
   ('candidate-low','https://www.linkedin.com/in/new-candidate/','Canada',10,'INBOX'),
   ('candidate-high','https://ca.linkedin.com/in/NEW-CANDIDATE/?trk=duplicate','Canada',90,'INBOX'),
   ('qualified-copy','https://www.linkedin.com/in/ava/','Canada',100,'QUALIFIED'),
   ('inbox-copy','https://www.linkedin.com/in/ava/','Canada',100,'INBOX'),
   ('completed-copy',$1,'Canada',100,'INBOX'),
   ('active-copy','https://www.linkedin.com/in/active-candidate/','Canada',100,'INBOX')`,[recovered.job.linkedinUrl]);
  await core.enqueue(pool,['https://www.linkedin.com/in/active-candidate/']);
  const candidates=await core.queueCandidates(pool);
  assert.deepEqual(candidates.map(c=>c.id),['candidate-high']);
  const obsolete='job_obsolete_duplicate';
  await pool.query(`INSERT INTO compel_worker_jobs(id,profile_key,payload) VALUES($1,$2,$3::jsonb)`,[obsolete,recovered.job.linkedinUrl,JSON.stringify({jobId:obsolete,linkedinUrl:recovered.job.linkedinUrl})]);
  assert.equal(await core.skipCompletedDuplicates(pool),1);
  assert.equal((await core.jobStatus(pool,obsolete)).status,'cancelled');
  const newStatus=await core.queueStatus(pool);
  assert.equal(newStatus.workerStatus.status,'paused');
  assert.equal(newStatus.workerStatus.pauseReason,'DAILY_LIMIT');
  assert.equal(newStatus.workerStatus.dailyRemaining,0);
  assert.ok(Date.parse(newStatus.workerStatus.nextDailyResetAt)>Date.now());
  // The allowance counts profiles globally, across automatic/manual retries,
  // account changes and restarts. Fresh profiles still obey each account cap.
  await core.clearQueue(pool);
  const usageBefore=(await core.settings(pool)).accounts.find(a=>a.id==='legacy-0').dailyCount;
  await pool.query('UPDATE compel_linkedin_accounts SET daily_limit=$1 WHERE id=$2',[usageBefore+1,'legacy-0']);
  const unique=await core.enqueue(pool,['https://ca.linkedin.com/in/UNIQUE-QUOTA/?trk=fixture']);
  let attempt=await core.claim(pool,'legacy-0','recovery');assert.equal(attempt.job.jobId,unique.jobs[0]);
  assert.equal(attempt.dailyCount,usageBefore+1);
  await core.enqueue(pool,['https://www.linkedin.com/in/new-profile-at-limit/']);
  const temporary={status:'ERROR',failure:{stage:'linkedin',code:'BROWSER_TIMEOUT',reason:'Temporary failure',retryable:true}};
  for(let retry=1;retry<=3;retry++){
   await core.defer(pool,attempt.job.jobId,'recovery',temporary,new Date().toISOString());
   attempt=await core.claim(pool,'legacy-0','recovery');
   assert.equal(attempt.job.retryCount,retry);assert.equal(attempt.dailyCount,usageBefore+1,'a retry at the cap uses no extra slot');
  }
  const otherUsage=(await core.settings(pool)).accounts.find(a=>a.id==='legacy-1').dailyCount;
  await pool.query('UPDATE compel_linkedin_accounts SET daily_limit=$1 WHERE id=$2',[otherUsage,'legacy-1']);
  await core.releaseSession(pool,'legacy-1','two',{status:'offline'});await core.acquireSession(pool,'legacy-1','restarted');
  await pool.query("UPDATE compel_worker_jobs SET lease_until=NOW()-interval '1 minute' WHERE id=$1",[attempt.job.jobId]);
  const switched=await core.claim(pool,'legacy-1','restarted');
  assert.equal(switched.job.jobId,attempt.job.jobId);assert.equal(switched.dailyCount,otherUsage,'another account at its cap can finish the same profile');
  await core.complete(pool,switched.job.jobId,'restarted',temporary);
  await core.retryFailed(pool);
  const manual=await core.claim(pool,'legacy-0','recovery');assert.equal(manual.job.jobId,unique.jobs[0]);assert.equal(manual.dailyCount,usageBefore+1);
  await core.complete(pool,manual.job.jobId,'recovery',{status:'REJECTED'});
  assert.equal((await core.claim(pool,'legacy-0','recovery')).limited,true);
  const ledger=(await pool.query("SELECT * FROM compel_worker_profile_usage WHERE profile_key='https://www.linkedin.com/in/unique-quota/'")).rows;
  assert.equal(ledger.length,1);assert.equal(ledger[0].account_id,'legacy-0');assert.equal(ledger[0].attempts,6);
  await pool.query(`INSERT INTO compel_worker_profile_usage(day,profile_key,account_id,job_id)
   VALUES((NOW() AT TIME ZONE 'UTC')::date-1,'https://www.linkedin.com/in/new-profile-at-limit/','legacy-0','previous-day')`);
  await pool.query('UPDATE compel_linkedin_accounts SET daily_limit=$1 WHERE id=$2',[usageBefore+2,'legacy-0']);
  const nextDay=await core.claim(pool,'legacy-0','recovery');assert.equal(nextDay.dailyCount,usageBefore+2,'a previous-day visit does not waive today\'s first reservation');
  await core.complete(pool,nextDay.job.jobId,'recovery',{status:'ERROR'});
  const totals=await core.queueStatus(pool);
  assert.ok(totals.workerStatus.dailyErrors>0);
  assert.equal(totals.workerStatus.dailyCompleted,totals.workerStatus.dailyQualified+totals.workerStatus.dailyRejected+totals.workerStatus.dailyErrors);
 }finally{
  await raw.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await raw.end();
 }
});
