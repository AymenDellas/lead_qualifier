'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {Pool}=require('pg');
const core=require('../../src/lib/linkedin-workers.cjs');
const queue=require('../../src/lib/worker-research-queue.cjs');

// Opt in explicitly. Every table query is rewritten into a generated schema;
// no account session, queue item or CRM row outside that schema is changed.
test('research migration, account-independent leases, stale owners and website continuations use isolated tables',{
 skip:false,
},async()=>{
 require('@next/env').loadEnvConfig(require('node:path').resolve(__dirname,'../..'));
 const raw=new Pool({connectionString:process.env.DATABASE_URL,max:4,connectionTimeoutMillis:10000,query_timeout:15000,
  ssl:process.env.DATABASE_CA_CERT?{ca:process.env.DATABASE_CA_CERT.replace(/\\n/g,'\n'),rejectUnauthorized:true}:{rejectUnauthorized:false}});
 const schema='compel_public_research_test_'+randomUUID().replaceAll('-','');
 assert.match(schema,/^compel_public_research_test_[a-f0-9]{32}$/);
 const tables=['compel_worker_events','compel_worker_config','compel_linkedin_accounts','compel_worker_usage','compel_worker_profile_usage','compel_worker_account_profiles','compel_worker_day','compel_worker_sessions','compel_worker_jobs','compel_research_budget','compel_prospect_runs','compel_research_runtime'];
 const pattern=new RegExp('\\b('+tables.join('|')+')\\b','g');
 const qualify=sql=>sql.replace(pattern,`"${schema}".$1`);
 const pool={query:(sql,values)=>raw.query(qualify(sql),values)};
 const capture=(id,extra={})=>({url:`https://www.linkedin.com/in/${id}/`,firstName:'Fixture',profileIdentityConfirmed:true,linkedinAccountId:'paused-account',linkedinCapturedAt:new Date().toISOString(),linkedinCapture:{version:2,complete:true},emails:[],status:'PENDING',...extra});
 async function insert(id,{checkpoint=null,result=null,status='pending',owner=null,lease=null,payload={}}={}){
  await pool.query(`INSERT INTO compel_worker_jobs(id,profile_key,payload,status,owner,lease_until,checkpoint,result)
   VALUES($1,$2,$3::jsonb,$4,$5,$6,$7::jsonb,$8::jsonb)`,[id,capture(id).url,JSON.stringify({jobId:id,linkedinUrl:capture(id).url,...payload}),status,owner,lease,checkpoint&&JSON.stringify(checkpoint),result&&JSON.stringify(result)]);
 }
 try{
  await raw.query(`CREATE SCHEMA "${schema}"`);
  await pool.query(core.SCHEMA);
  await insert('pending-capture');
  await insert('partial',{checkpoint:capture('partial',{linkedinCapture:{version:2,complete:false,stage:'contact'}})});
  await insert('partial-with-result',{checkpoint:capture('partial-with-result',{linkedinCapture:{complete:false}}),result:capture('partial-with-result')});
  await insert('legacy-full',{checkpoint:capture('legacy-full',{linkedinCapture:undefined})});
  await insert('active',{checkpoint:capture('active'),status:'processing',owner:'capture-owner',lease:new Date(Date.now()+60000)});
  await insert('expired',{checkpoint:capture('expired'),status:'processing',owner:'expired-capture',lease:new Date(Date.now()-60000)});
  await insert('history',{checkpoint:capture('history'),result:{...capture('history'),status:'REJECTED'},status:'done'});
  await queue.ensure(pool);
  const rows=Object.fromEntries((await pool.query('SELECT * FROM compel_worker_jobs')).rows.map(r=>[r.id,r]));
  assert.equal(rows['pending-capture'].lane,'capture');assert.equal(rows.partial.lane,'capture');
  assert.equal(rows['partial-with-result'].lane,'capture');assert.equal(rows['partial-with-result'].checkpoint.linkedinCapture.complete,false,'migration never replaces an existing partial checkpoint');
  assert.equal(rows['legacy-full'].lane,'research');assert.equal(rows.expired.lane,'capture','lease expiry alone never recovers an unverified owner');
  assert.equal(rows.active.lane,'capture');assert.equal(rows.active.owner,'capture-owner');
  assert.equal(rows.history.status,'done');assert.equal(rows.history.lane,'capture');assert.equal(rows.history.result.status,'REJECTED');
  await assert.rejects(queue.handoff(pool,'active','wrong-owner',capture('active')),/lease lost/);
  await queue.handoff(pool,'active','capture-owner',capture('active'));
  assert.equal((await pool.query("SELECT lane FROM compel_worker_jobs WHERE id='active'")).rows[0].lane,'research');

  // There are deliberately no enabled accounts, authorized sessions or account
  // leases in this schema. Concurrent research claims must still succeed.
  const [one,two]=await Promise.all([queue.claim(pool,'research-one'),queue.claim(pool,'research-two')]);
  assert.ok(one&&two);assert.notEqual(one.job.jobId,two.job.jobId);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM compel_worker_sessions')).rows[0].n,0);
  await queue.heartbeat(pool,'research-one');
  assert.equal((await pool.query('SELECT owner FROM compel_worker_jobs WHERE id=$1',[one.job.jobId])).rows[0].owner,'research-one');
  await pool.query("UPDATE compel_worker_jobs SET lease_until=NOW()-interval '1 second' WHERE id=$1",[one.job.jobId]);
  // Remove the other waiting full snapshot so expiry recovery is deterministic.
  await pool.query("UPDATE compel_worker_jobs SET retry_at=NOW()+interval '1 hour' WHERE lane='research' AND status='pending'");
  assert.equal(await queue.claim(pool,'research-new'),null);await queue.release(pool,'research-one');const recovered=await queue.claim(pool,'research-new');assert.equal(recovered.job.jobId,one.job.jobId);
  await assert.rejects(core.complete(pool,one.job.jobId,'research-one',{...one.job.resumeResult,status:'REJECTED'}),/lease lost/);
  await queue.release(pool,'research-one');
  assert.equal((await pool.query('SELECT owner FROM compel_worker_jobs WHERE id=$1',[recovered.job.jobId])).rows[0].owner,'research-new','an old owner cannot release new work');
  await core.complete(pool,two.job.jobId,'research-two',{...two.job.resumeResult,status:'REJECTED'});
  await core.complete(pool,recovered.job.jobId,'research-new',{...recovered.job.resumeResult,status:'QUALIFIED',prospectQualification:{research:{crawl:{complete:false,retryable:true,pending:['https://fixture.example.test/contact']}}}});
  const continuation=(await pool.query("SELECT * FROM compel_worker_jobs WHERE payload->>'websiteContinuation'='true'")).rows[0];
  assert.equal(continuation,undefined,'A decided lead never schedules remaining website routes');
  await insert('owned-one',{checkpoint:capture('owned-one')});await insert('owned-two',{checkpoint:capture('owned-two')});
  const a=await queue.claim(pool,'shared-owner'),b=await queue.claim(pool,'shared-owner');assert.ok(a&&b);
  await queue.releaseJob(pool,a.job.jobId,'shared-owner',{...a.job.resumeResult,retainedResearch:true});
  const first=(await pool.query('SELECT * FROM compel_worker_jobs WHERE id=$1',[a.job.jobId])).rows[0],second=(await pool.query('SELECT * FROM compel_worker_jobs WHERE id=$1',[b.job.jobId])).rows[0];
  assert.equal(first.status,'pending');assert.equal(first.checkpoint.retainedResearch,true);assert.equal(first.retry_count,1);assert.equal(second.status,'processing','recovering one failed save never releases another in-flight public job');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM compel_worker_profile_usage')).rows[0].n,0,'research consumes no LinkedIn profile budget');
 }finally{
  await raw.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await raw.end();
 }
});
