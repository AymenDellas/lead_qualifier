'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {Pool}=require('pg'),core=require('../../src/lib/linkedin-workers.cjs'),daily=require('../../src/lib/engine-daily-policy.cjs');
require('@next/env').loadEnvConfig(require('node:path').resolve(__dirname,'../..'));
test('daily cap is atomic per account and unique profile; claims, cached evidence, retries and statistics are free',async()=>{
 const raw=new Pool({connectionString:process.env.DATABASE_URL,max:5,connectionTimeoutMillis:10000,query_timeout:20000,ssl:{rejectUnauthorized:false}}),schema='compel_daily_test_'+randomUUID().replaceAll('-','');
 const names='compel_worker_events|compel_worker_config|compel_linkedin_accounts|compel_worker_usage|compel_worker_profile_usage|compel_worker_account_profiles|compel_worker_day|compel_worker_sessions|compel_worker_jobs|compel_research_budget|compel_prospect_runs|leads';
 const qualify=sql=>sql.replace(new RegExp('\\b('+names+')\\b','g'),`"${schema}".$1`);
 const pool={query:(sql,args)=>raw.query(qualify(sql),args),connect:async()=>{const c=await raw.connect();return {query:(sql,args)=>c.query(qualify(sql),args),release:()=>c.release()};}};
 try{
  await raw.query(`CREATE SCHEMA "${schema}"`);let config=await core.settings(pool);
  config=await core.saveSettings(pool,{...config,activeCount:2,accounts:[1,2].map(n=>({label:'Fixture '+n,email:`daily-${n}@example.test`,enabled:true,dailyLimit:2}))});
  const [one,two]=config.accounts.map(a=>a.id);await pool.query("UPDATE compel_linkedin_accounts SET processing_enabled=TRUE,connected_at=NOW(),confirmed_identity='{}'");
  await core.acquireSession(pool,one,'one');await core.acquireSession(pool,two,'two');
  await daily.configure(pool,{DAILY_LIMIT_TIMEZONE:'Africa/Casablanca'});
  const urls=[1,2,3].map(n=>`https://www.linkedin.com/in/daily-${n}/`);await core.enqueue(pool,urls);
  const claims=await Promise.all([core.claim(pool,one,'one'),core.claim(pool,one,'one'),core.claim(pool,one,'one')]);
  assert.equal(new Set(claims.map(c=>c.job.jobId)).size,3);assert.ok(claims.every(c=>c.dailyCount===0));
  const results=await Promise.all(claims.map(c=>daily.reserve(pool,{accountId:one,owner:'one',profileUrl:c.job.linkedinUrl,jobId:c.job.jobId})));
  assert.equal(results.filter(r=>r.charged).length,2);assert.equal(results.filter(r=>r.limited).length,1);assert.equal((await daily.usage(pool,one)).used,2);
  const seen=claims[results.findIndex(r=>r.charged)].job;
  assert.equal((await daily.reserve(pool,{accountId:one,owner:'one',profileUrl:seen.linkedinUrl,jobId:seen.jobId})).charged,false);
  assert.equal((await daily.reserve(pool,{accountId:two,owner:'two',profileUrl:seen.linkedinUrl,jobId:seen.jobId})).charged,true,'same profile counts independently for another account');
  await core.recordLinkedInChecks(pool,one,'one',{identity:5000,activity_page:6000});assert.equal((await daily.usage(pool,one)).used,2);
  const usage=await daily.usage(pool,one);assert.equal(usage.timezone,'Africa/Casablanca');assert.ok(new Date(usage.resume_at)>new Date());
  const dst=(await pool.query("SELECT ('2026-11-02'::timestamp AT TIME ZONE 'America/New_York')-('2026-11-01'::timestamp AT TIME ZONE 'America/New_York') AS duration")).rows[0].duration;assert.equal((dst.days||0)*24+(dst.hours||0),25);
  await core.complete(pool,seen.jobId,'one',{url:seen.linkedinUrl,status:'REJECTED'});
  await pool.query('CREATE TABLE leads(id TEXT PRIMARY KEY,linkedin_url TEXT,pipeline_status TEXT)');
  await pool.query("INSERT INTO leads VALUES('legacy', $1, 'QUALIFIED')",[seen.linkedinUrl]);
  const recheck=await require('../../src/lib/follower-recheck.cjs').recheckFollowers(pool,['legacy']);assert.equal(recheck.queuedCount,1);
  const fresh=(await pool.query('SELECT checkpoint,payload FROM compel_worker_jobs WHERE id=$1',[recheck.jobs[0]])).rows[0];assert.equal(fresh.checkpoint,null);assert.equal(fresh.payload.explicitRetry,true);
  assert.equal((await require('../../src/lib/follower-recheck.cjs').recheckFollowers(pool,['legacy'])).queuedCount,0);
  assert.equal((await pool.query("SELECT pipeline_status FROM leads WHERE id='legacy'")).rows[0].pipeline_status,'QUALIFIED');
  await core.pauseProcessing(pool,one);assert.equal((await daily.reserve(pool,{accountId:one,owner:'one',profileUrl:seen.linkedinUrl,jobId:seen.jobId})).stopped,true);
 }finally{await raw.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await raw.end();}
});
test('daily defaults and time zones validate without adding an interaction throttle',()=>{
 assert.equal(daily.defaultLimit({DEFAULT_DAILY_SCRAPE_LIMIT:'25'}),25);assert.throws(()=>daily.timezone({DAILY_LIMIT_TIMEZONE:'bad/zone'}),/IANA/);assert.throws(()=>daily.defaultLimit({DEFAULT_DAILY_SCRAPE_LIMIT:'0'}),/1–400/);
});
