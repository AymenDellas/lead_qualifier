'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {Pool}=require('pg'),core=require('../../src/lib/linkedin-workers.cjs');
require('@next/env').loadEnvConfig(require('node:path').resolve(__dirname,'../..'));

test('page budgets, schedules, concurrent reservations and partial-capture recovery use an isolated database schema',async()=>{
 const raw=new Pool({connectionString:process.env.DATABASE_URL,max:5,connectionTimeoutMillis:10000,ssl:{rejectUnauthorized:false}});
 const schema='compel_page_test_'+randomUUID().replaceAll('-','');
 assert.match(schema,/^compel_page_test_[a-f0-9]{32}$/);
 const qualify=sql=>sql.replace(/\b(compel_worker_events|compel_worker_config|compel_linkedin_accounts|compel_worker_usage|compel_worker_profile_usage|compel_worker_sessions|compel_worker_jobs|compel_research_budget|compel_prospect_runs)\b/g,`"${schema}".$1`);
 const pool={query:(sql,v)=>raw.query(qualify(sql),v),connect:async()=>{const c=await raw.connect();return{query:(sql,v)=>c.query(qualify(sql),v),release:()=>c.release()};}};
 try {
  await raw.query(`CREATE SCHEMA "${schema}"`);
  let settings=await core.settings(pool);
  settings=await core.saveSettings(pool,{...settings,activeCount:1,accounts:[{label:'Fixture only',email:'fixture@example.test',enabled:true,dailyLimit:25,dailyRequestLimit:10,activityLimits:{profile:{hourly:1,daily:2}}}]});
  const id=settings.accounts[0].id;
  await core.acquireSession(pool,id,'manual');await core.confirmManualSignIn(pool,id,'manual',{name:'Fixture Viewer',profileUrl:'https://www.linkedin.com/in/fixture-viewer/'});await core.releaseSession(pool,id,'manual',{status:'offline'});
  await core.startProcessing(pool,id);await core.acquireSession(pool,id,'worker');
  const reservations=await Promise.all(Array.from({length:6},()=>core.reserveLinkedInCheck(pool,id,'worker','profile_page')));
  assert.equal(reservations.filter(r=>r.request_count===1).length,1);assert.equal(reservations.filter(r=>r.waitMs>0).length,5);
  await pool.query('UPDATE compel_linkedin_accounts SET next_check_at=NULL WHERE id=$1',[id]);
  const waiting=await core.reserveLinkedInCheck(pool,id,'worker','profile');
  assert.ok(waiting.waitMs>3500000);assert.match(waiting.reason,/profile activity budget/);
  assert.equal((await core.reserveLinkedInCheck(pool,id,'worker','contact')).request_count,2,'Different activity types can proceed within shared budgets');
  settings=await core.settings(pool);assert.equal(settings.accounts[0].activityUsage.daily,2);
  const day=(new Date().getUTCDay()+2)%7;
  settings=await core.saveSettings(pool,{...settings,accounts:settings.accounts.map(a=>({...a,workingHours:{timezone:'UTC',days:[day],start:'09:00',end:'17:00'}}))});
  assert.equal((await core.reserveLinkedInCheck(pool,id,'worker','activity_page')).waitMs,60000);
  assert.equal((await core.settings(pool)).accounts[0].dailyRequests,2,'A closed schedule does not consume a reservation');
  await core.pauseProcessing(pool,id);await core.releaseSession(pool,id,'worker',{status:'offline'});
  await assert.rejects(core.startProcessing(pool,id),/working hours/);
  settings=await core.settings(pool);settings=await core.saveSettings(pool,{...settings,accounts:settings.accounts.map(a=>({...a,workingHours:null}))});
  await core.startProcessing(pool,id);await core.acquireSession(pool,id,'worker');
  const url='https://www.linkedin.com/in/partial-fixture/';await core.enqueue(pool,[url]);
  const claimed=await core.claim(pool,id,'worker');
  const saved={url,profileIdentityConfirmed:true,firstName:'Fixture',emails:['fixture@example.test'],linkedinAccountId:id,linkedinCapture:{version:2,stage:'contact',complete:false,checkedAt:new Date().toISOString()},status:'PENDING'};
  await core.checkpoint(pool,claimed.job.jobId,'worker',saved);
  await core.defer(pool,claimed.job.jobId,'worker',{status:'ERROR',failure:{stage:'linkedin',code:'LINKEDIN_AUTH',reason:'Fixture security check',retryable:false}},new Date().toISOString());
  const resumed=await core.claim(pool,id,'worker');assert.equal(resumed.job.resumeCapture,true);assert.deepEqual(resumed.job.resumeResult.emails,saved.emails);
  assert.equal(resumed.dailyCount,1,'Resuming a captured profile does not reserve a second distinct-profile slot');
  await pool.query("INSERT INTO compel_worker_events(account_id,kind,message,data,created_at) SELECT $1,'read','fixture prior activity','{\"kind\":\"discovery\"}',NOW()-interval '2 hours' FROM generate_series(1,8)",[id]);
  await pool.query('UPDATE compel_linkedin_accounts SET next_check_at=NULL WHERE id=$1',[id]);
  assert.equal((await core.reserveLinkedInCheck(pool,id,'worker','contact')).stopped,true,'Rolling 24-hour history counts even when the today counter is lower');
  await core.pauseProcessing(pool,id);await core.releaseSession(pool,id,'worker',{status:'offline'});
  await assert.rejects(core.startProcessing(pool,id),/rolling 24-hour/,'Budget exhaustion is checked before browser launch');
  await pool.query('ALTER TABLE compel_linkedin_accounts DROP COLUMN working_hours');await core.ensure({...pool});
  settings=await core.settings(pool);assert.equal(settings.accounts[0].activityUsage.daily,10);assert.equal(settings.accounts[0].activityLimits.profile.daily,2,'Migration preserves limits and history');
 } finally {await raw.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await raw.end();}
});
