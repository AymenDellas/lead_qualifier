'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {Pool}=require('pg'),core=require('../../src/lib/linkedin-workers.cjs');
require('@next/env').loadEnvConfig(require('node:path').resolve(__dirname,'../..'));

test('persistent check counters, cache reuse at the profile cap, expiry and explicit refresh use isolated tables',async()=>{
 const raw=new Pool({connectionString:process.env.DATABASE_URL,max:5,connectionTimeoutMillis:10000,ssl:{rejectUnauthorized:false}});
 const schema='compel_efficiency_test_'+randomUUID().replaceAll('-','');
 assert.match(schema,/^compel_efficiency_test_[a-f0-9]{32}$/);
 const qualify=sql=>sql.replace(/\b(compel_worker_events|compel_worker_config|compel_linkedin_accounts|compel_worker_usage|compel_worker_profile_usage|compel_worker_account_profiles|compel_worker_day|compel_worker_sessions|compel_worker_jobs|compel_research_budget|compel_prospect_runs)\b/g,`"${schema}".$1`);
 const pool={query:(sql,values)=>raw.query(qualify(sql),values),connect:async()=>{
  const client=await raw.connect();return {query:(sql,values)=>client.query(qualify(sql),values),release:()=>client.release()};
 }};
 try{
  await raw.query(`CREATE SCHEMA "${schema}"`);
  await core.importAccounts(pool,[{email:'one@example.test',password:'fixture'},{email:'two@example.test',password:'fixture'}]);
  const config=await core.settings(pool);await core.saveSettings(pool,{...config,activeCount:2});
  await pool.query("UPDATE compel_linkedin_accounts SET processing_enabled=TRUE,processing_until=NOW()+interval '2 hours',connected_at=NOW()");
  await core.acquireSession(pool,'legacy-0','one');await core.acquireSession(pool,'legacy-1','two');
  await Promise.all(['contact','contact','profile','cache'].map(kind=>core.recordLinkedInCheck(pool,'legacy-0','one',kind)));
  let account=(await core.settings(pool)).accounts[0];
  assert.equal(account.dailyRequests,3);assert.equal(account.dailyCachedProfiles,1);assert.equal(account.dailyCount,0);
  assert.equal(account.requestKinds.contact,2);assert.equal(account.requestKinds.profile,1);
  await assert.rejects(core.recordLinkedInCheck(pool,'legacy-0','wrong-owner','contact'),/lease lost/);
  assert.equal((await core.settings(pool)).accounts[0].dailyRequests,3);
  await pool.query(`INSERT INTO compel_worker_usage(account_id,day,request_count) VALUES('legacy-0',(NOW() AT TIME ZONE 'UTC')::date-1,99)`);
  assert.equal((await core.settings(pool)).accounts[0].dailyRequests,3,'yesterday is excluded');

  const at=new Date(new Date().setUTCHours(0,0,0,0)-1000).toISOString();
  const url='https://www.linkedin.com/in/reused-fixture/';
  const saved={url,firstName:'Saved',profileIdentityConfirmed:true,linkedinCapturedAt:at,linkedinAccountId:'legacy-0',status:'PENDING',emails:[],linkedinContact:{accountId:'legacy-0',connection:'CONNECTED'}};
  await pool.query(`INSERT INTO compel_worker_jobs(id,profile_key,payload,status,account_id,checkpoint,result,completed_at)
   VALUES('previous',$1,'{}','done','legacy-0',$2::jsonb,$2::jsonb,$3)`,[url,JSON.stringify(saved),at]);
  const other=await core.cachedLinkedInProfile(pool,url,'legacy-1');assert.equal(other.firstName,'Saved');assert.equal(other.linkedinContact,undefined);
  await pool.query("UPDATE compel_linkedin_accounts SET daily_limit=1 WHERE id='legacy-0'");
  await pool.query("INSERT INTO compel_worker_account_profiles(account_id,day,profile_key,job_id) VALUES('legacy-0',compel_worker_day(),'https://www.linkedin.com/in/quota-used/','fixture')");
  const batch=await core.enqueue(pool,[url]);assert.equal(batch.queuedCount,1);
  const reused=await core.claim(pool,'legacy-0','one');assert.equal(reused.job.resumeResult.firstName,'Saved');assert.equal(reused.dailyCount,1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM compel_worker_profile_usage')).rows[0].n,0,'reuse makes no fresh profile reservation');
  await core.complete(pool,reused.job.jobId,'one',{...saved,status:'REJECTED'});
  assert.equal((await core.enqueue(pool,[url])).queuedCount,0,'same-day duplicate protection remains');

  const staleUrl='https://www.linkedin.com/in/stale-fixture/';
  const stale={...saved,url:staleUrl,linkedinCapturedAt:new Date(Date.now()-25*3600000).toISOString()};
  await pool.query(`INSERT INTO compel_worker_jobs(id,profile_key,payload,status,account_id,checkpoint,result,completed_at)
   VALUES('stale',$1,'{}','done','legacy-0',$2::jsonb,$2::jsonb,NOW())`,[staleUrl,JSON.stringify(stale)]);
  assert.equal(await core.cachedLinkedInProfile(pool,staleUrl,'legacy-0'),null,'recent completion cannot refresh old evidence');
  await pool.query(`INSERT INTO compel_worker_jobs(id,profile_key,payload) VALUES('refresh',$1,$2::jsonb)`,[url,JSON.stringify({jobId:'refresh',linkedinUrl:url,explicitRetry:true})]);
  assert.equal((await core.claim(pool,'legacy-0','one')).limited,true,'explicit refresh respects the profile cap');
  await pool.query("UPDATE compel_linkedin_accounts SET daily_limit=2 WHERE id='legacy-0'");
  const refreshed=await core.claim(pool,'legacy-0','one');assert.equal(refreshed.job.resumeResult,undefined);assert.equal(refreshed.dailyCount,1);await core.reserveProfile(pool,{accountId:'legacy-0',owner:'one',profileUrl:url,jobId:refreshed.job.jobId});

  await pool.query('ALTER TABLE compel_worker_usage DROP COLUMN cached_profiles');
  await core.ensure({...pool});
  account=(await core.settings(pool)).accounts[0];assert.equal(account.dailyCount,2);assert.equal(account.dailyRequests,3,'migration preserves existing counters');
 }finally{await raw.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await raw.end();}
});
