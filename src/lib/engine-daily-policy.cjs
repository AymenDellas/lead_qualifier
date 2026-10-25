'use strict';
// Only actual unique profile navigations consume the account's daily limit.
const ready=new WeakMap();
const PROFILE_INTERVAL_MS=60000;
const SCHEMA=`ALTER TABLE compel_worker_config ADD COLUMN IF NOT EXISTS daily_timezone TEXT NOT NULL DEFAULT 'UTC';
 ALTER TABLE compel_linkedin_accounts ADD COLUMN IF NOT EXISTS next_profile_at TIMESTAMPTZ;
 ALTER TABLE compel_linkedin_accounts ALTER COLUMN daily_limit SET DEFAULT 300;
 CREATE TABLE IF NOT EXISTS compel_worker_account_profiles (
 account_id TEXT NOT NULL,day DATE NOT NULL,profile_key TEXT NOT NULL,job_id TEXT NOT NULL,
 first_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),attempts INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY(account_id,day,profile_key));
 CREATE OR REPLACE FUNCTION compel_worker_day() RETURNS date LANGUAGE sql STABLE AS $$
 SELECT (NOW() AT TIME ZONE COALESCE((SELECT daily_timezone FROM compel_worker_config WHERE id=1),'UTC'))::date $$;`;
function defaultLimit(env=process.env){const n=Number(env.DEFAULT_DAILY_SCRAPE_LIMIT||300);if(!Number.isInteger(n)||n<1||n>400)throw Error('DEFAULT_DAILY_SCRAPE_LIMIT must be 1–400, matching the existing database field.');return n;}
function timezone(env=process.env){const zone=env.DAILY_LIMIT_TIMEZONE||Intl.DateTimeFormat().resolvedOptions().timeZone;try{new Intl.DateTimeFormat('en',{timeZone:zone}).format();}catch{throw Error('DAILY_LIMIT_TIMEZONE must be a valid IANA time zone.');}return zone;}
async function ensure(pool){
 if(!ready.has(pool))ready.set(pool,(async()=>{
  const exists=(await pool.query("SELECT to_regclass('compel_worker_account_profiles') IS NOT NULL AND to_regprocedure('compel_worker_day()') IS NOT NULL AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('compel_linkedin_accounts') AND attname='next_profile_at' AND NOT attisdropped) AS ready")).rows[0]?.ready;if(exists)return;
  const client=await pool.connect();try{await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock(hashtext('compel/daily-profile-policy/v1'))");await client.query(SCHEMA);await client.query('COMMIT');}
  catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 })().catch(error=>{ready.delete(pool);throw error;}));return ready.get(pool);
}
async function configure(pool,env=process.env){
 await ensure(pool);const zone=timezone(env);defaultLimit(env);
 await pool.query('UPDATE compel_worker_config SET daily_timezone=$1 WHERE id=1 AND daily_timezone IS DISTINCT FROM $1',[zone]);
 // Keep legacy rows. Reconstruct visits from timestamps, excluding source lists.
 await pool.query(`INSERT INTO compel_worker_account_profiles(account_id,day,profile_key,job_id,first_read_at,last_read_at,attempts)
  SELECT account_id,(first_claimed_at AT TIME ZONE $1)::date,profile_key,job_id,first_claimed_at,last_claimed_at,attempts
  FROM compel_worker_profile_usage WHERE profile_key ~ '^https://www\\.linkedin\\.com/in/[^/]+/$' ON CONFLICT DO NOTHING`,[zone]);return zone;
}
async function usage(pool,id){
 await ensure(pool);return (await pool.query(`SELECT a.daily_limit AS limit,count(p.profile_key)::int AS used,c.daily_timezone AS timezone,
  compel_worker_day()::text AS day,((compel_worker_day()+1)::timestamp AT TIME ZONE c.daily_timezone) AS resume_at
  FROM compel_linkedin_accounts a CROSS JOIN compel_worker_config c LEFT JOIN compel_worker_account_profiles p ON p.account_id=a.id AND p.day=compel_worker_day()
  WHERE a.id=$1 AND c.id=1 GROUP BY a.id,c.daily_timezone`,[id])).rows[0]||null;
}
async function reserve(pool,{accountId,owner,profileUrl,jobId,version=null,intervalMs=PROFILE_INTERVAL_MS}){
 if(!Number.isInteger(intervalMs)||intervalMs<0)throw Error('Invalid profile interval.');
 if(!/^https:\/\/www\.linkedin\.com\/in\/[^/]+\/$/.test(profileUrl||''))throw Error('A canonical LinkedIn profile is required.');
 await ensure(pool);const client=await pool.connect();try{
  await client.query('BEGIN');
  const a=(await client.query(`SELECT a.daily_limit,c.daily_timezone AS timezone,compel_worker_day()::text AS day,
   ((compel_worker_day()+1)::timestamp AT TIME ZONE c.daily_timezone) AS resume_at
   FROM compel_linkedin_accounts a JOIN compel_worker_sessions s ON s.account_id=a.id CROSS JOIN compel_worker_config c
   WHERE a.id=$1 AND s.owner=$2 AND s.lease_until>NOW() AND a.enabled AND NOT a.archived AND a.processing_enabled
    AND a.attention_reason='' AND a.connected_at IS NOT NULL AND a.login_requested_at IS NULL AND a.logout_requested_at IS NULL AND a.signed_out_at IS NULL
    AND ($3::timestamptz IS NULL OR a.changed_at=$3) AND c.id=1 AND c.active_count>0 FOR UPDATE OF a`,[accountId,owner,version])).rows[0];
  if(!a){await client.query('COMMIT');return {stopped:true,reason:'Processing paused, account needs review, or ownership changed.'};}
  const used=Number((await client.query('SELECT count(*)::int AS n FROM compel_worker_account_profiles WHERE account_id=$1 AND day=$2',[accountId,a.day])).rows[0].n);
  const seen=(await client.query('SELECT 1 FROM compel_worker_account_profiles WHERE account_id=$1 AND day=$2 AND profile_key=$3',[accountId,a.day,profileUrl])).rowCount>0;
  if(!seen&&used>=a.daily_limit){await client.query('COMMIT');return {limited:true,used,limit:a.daily_limit,resumeAt:a.resume_at,timezone:a.timezone};}
  const slot=await client.query(`UPDATE compel_linkedin_accounts SET next_profile_at=clock_timestamp()+($2*interval '1 millisecond')
   WHERE id=$1 AND (next_profile_at IS NULL OR next_profile_at<=clock_timestamp()) RETURNING next_profile_at`,[accountId,intervalMs]);
  if(!slot.rowCount){const next=(await client.query('SELECT next_profile_at FROM compel_linkedin_accounts WHERE id=$1',[accountId])).rows[0].next_profile_at;await client.query('COMMIT');return {paced:true,resumeAt:next,intervalMs};}
  await client.query(`INSERT INTO compel_worker_account_profiles(account_id,day,profile_key,job_id) VALUES($1,$2,$3,$4)
   ON CONFLICT(account_id,day,profile_key) DO UPDATE SET last_read_at=NOW(),attempts=compel_worker_account_profiles.attempts+1`,[accountId,a.day,profileUrl,jobId]);
  const count=used+(seen?0:1);await client.query(`INSERT INTO compel_worker_usage(account_id,day,count) VALUES($1,$2,$3)
   ON CONFLICT(account_id,day) DO UPDATE SET count=EXCLUDED.count`,[accountId,a.day,count]);
  await client.query('COMMIT');return {used:count,limit:a.daily_limit,charged:!seen,resumeAt:a.resume_at,timezone:a.timezone};
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
module.exports={SCHEMA,ensure,configure,usage,reserve,defaultLimit,timezone,PROFILE_INTERVAL_MS};
