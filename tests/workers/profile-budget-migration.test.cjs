'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {Pool}=require('pg'),core=require('../../src/lib/linkedin-workers.cjs');
require('@next/env').loadEnvConfig(require('node:path').resolve(__dirname,'../..'));

test('migration recovers unique visits and preserves cached work without repeating the counter repair',async()=>{
 const raw=new Pool({connectionString:process.env.DATABASE_URL,max:4,connectionTimeoutMillis:10000,ssl:{rejectUnauthorized:false}});
 const schema='compel_budget_test_'+randomUUID().replaceAll('-','');
 const qualify=sql=>sql.replace(/\b(compel_worker_events|compel_worker_config|compel_linkedin_accounts|compel_worker_usage|compel_worker_profile_usage|compel_worker_account_profiles|compel_worker_day|compel_worker_sessions|compel_worker_jobs|compel_research_budget|compel_prospect_runs)\b/g,`"${schema}".$1`);
 const pool={query:(sql,values)=>raw.query(qualify(sql),values),connect:async()=>{
  const client=await raw.connect();return{query:(sql,values)=>client.query(qualify(sql),values),release:()=>client.release()};
 }};
 try{
  await raw.query(`CREATE SCHEMA "${schema}"`);await pool.query(core.SCHEMA);
  await pool.query(`INSERT INTO compel_linkedin_accounts(id,label,email,profile_key,position) VALUES
   ('fixture-one','One','one@example.test','one',0),('fixture-two','Two','two@example.test','two',1)`);
  await pool.query(`INSERT INTO compel_worker_usage(account_id,day,count) VALUES
   ('fixture-one',(NOW() AT TIME ZONE 'UTC')::date,400),('fixture-two',(NOW() AT TIME ZONE 'UTC')::date,400)`);
  const today=new Date().toISOString(),yesterday=new Date(Date.now()-86400000).toISOString();
  const fresh={activityEvidence:{checkedAt:today},logs:['Fetching contact info via Voyager API...']};
  const cached={activityEvidence:{checkedAt:today},logs:['Resuming saved LinkedIn profile; no new LinkedIn scrape or daily slot used.']};
  const previousDay={activityEvidence:{checkedAt:yesterday},logs:cached.logs};
  for(const [id,slug,account,result,status,checkpoint,retries] of [
   ['fresh','same-profile','fixture-one',fresh,'done',null,3],
   ['continuation','same-profile','fixture-two',cached,'done',cached,2],
   ['failed','profile-error','fixture-two',{logs:fresh.logs},'done',null,3],
   ['previous-day','previous-day','fixture-two',previousDay,'done',previousDay,1],
   ['pending','pending-research','fixture-one',null,'pending',fresh,0],
   ['never-visited','never-visited',null,null,'pending',null,0],
  ])await pool.query(`INSERT INTO compel_worker_jobs(id,profile_key,payload,account_id,status,result,checkpoint,retry_count,completed_at)
   VALUES($1,$2,'{}',$3,$4,$5::jsonb,$6::jsonb,$7,CASE WHEN $4='done' THEN NOW() ELSE NULL END)`,
   [id,`https://www.linkedin.com/in/${slug}/`,account,status,JSON.stringify(result),JSON.stringify(checkpoint),retries]);
  await pool.query('DROP TABLE compel_worker_profile_usage');
  await core.ensure(pool);
  assert.deepEqual((await pool.query('SELECT account_id,count FROM compel_worker_usage ORDER BY account_id')).rows,
   [{account_id:'fixture-one',count:2},{account_id:'fixture-two',count:1}]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM compel_worker_profile_usage')).rows[0].n,3);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM compel_worker_jobs WHERE status='pending'")).rows[0].n,2,'migration retains all queued work');
  await pool.query("UPDATE compel_worker_usage SET count=count+1 WHERE account_id='fixture-one'");
  await core.ensure({...pool});
  assert.equal((await pool.query("SELECT count FROM compel_worker_usage WHERE account_id='fixture-one'")).rows[0].count,3,'a later process does not replay the repair');
 }finally{await raw.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await raw.end();}
});
