'use strict';

// Public research owns jobs, never account sessions or browser profiles.
const {json,profileUrl}=require('./linkedin-workers.cjs');
const ready=new WeakMap();
const SCHEMA=`
ALTER TABLE compel_worker_jobs ADD COLUMN IF NOT EXISTS lane TEXT NOT NULL DEFAULT 'capture';
CREATE INDEX IF NOT EXISTS compel_worker_research_queue ON compel_worker_jobs(lane,status,retry_at,created_at);
CREATE TABLE IF NOT EXISTS compel_research_runtime (
 owner TEXT PRIMARY KEY,pid INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'idle',
 seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),lease_until TIMESTAMPTZ NOT NULL DEFAULT NOW());
`;
function fullCapture(value){
 return !!value&&value.profileIdentityConfirmed===true&&value.linkedinCapture?.complete!==false&&!!profileUrl(value.url||value.linkedinUrl);
}
const completeSql=value=>`(${value}->'profileIdentityConfirmed'='true'::jsonb AND ${value}#>>'{linkedinCapture,complete}' IS DISTINCT FROM 'false'
 AND COALESCE(${value}->>'url',${value}->>'linkedinUrl','') ~* '^https://([a-z]{2,3}\\.)?(www\\.)?linkedin\\.com/in/[^/?#]+/?$')`;
async function migrate(pool){
 // Only recover waiting/expired work. An active capture and completed history
 // retain their lane, owner, checkpoint and result exactly as they were.
 await pool.query(`WITH recoverable AS (
  SELECT id,COALESCE(checkpoint,result) AS capture
  FROM compel_worker_jobs WHERE lane='capture' AND
   (status='pending' OR status='processing' AND lease_until<NOW())
   AND ${completeSql('(COALESCE(checkpoint,result))')} FOR UPDATE SKIP LOCKED
 ) UPDATE compel_worker_jobs j SET lane='research',status='pending',checkpoint=r.capture,
  owner=NULL,account_id=NULL,lease_until=NULL FROM recoverable r WHERE j.id=r.id`);
}
async function ensure(pool){
 if(!ready.has(pool))ready.set(pool,(async()=>{await pool.query(SCHEMA);await migrate(pool);})().catch(error=>{ready.delete(pool);throw error;}));
 await ready.get(pool);
}
async function handoff(pool,id,owner,capture){
 if(!fullCapture(capture))throw new Error('Only a complete, identity-confirmed profile can enter public research.');
 await ensure(pool);
 const update=await pool.query(`UPDATE compel_worker_jobs SET lane='research',status='pending',checkpoint=$3::jsonb,
  owner=NULL,account_id=NULL,lease_until=NULL,retry_at=NULL WHERE id=$1 AND owner=$2 AND lane='capture'
  AND status='processing' AND lease_until>NOW() AND profile_key=$4 RETURNING id`,[id,owner,json(capture),profileUrl(capture.url||capture.linkedinUrl)]);
 if(!update.rowCount)throw new Error('Job lease lost before public research handoff.');
}
async function claim(pool,owner){
 await ensure(pool);await migrate(pool);
 const rows=await pool.query(`WITH next AS (
  SELECT id FROM compel_worker_jobs WHERE lane='research' AND
   (status='pending' AND (retry_at IS NULL OR retry_at<=NOW()) OR status='processing' AND lease_until<NOW())
   AND ${completeSql('checkpoint')}
   ORDER BY created_at,queue_order FOR UPDATE SKIP LOCKED LIMIT 1
 ) UPDATE compel_worker_jobs j SET status='processing',owner=$1,account_id=NULL,lease_until=NOW()+interval '15 minutes'
  FROM next WHERE j.id=next.id RETURNING j.*`,[owner]);
 const row=rows.rows[0];
 return row?{job:{...row.payload,jobId:row.id,resumeResult:row.checkpoint,retryCount:row.retry_count||0}}:null;
}
async function heartbeat(pool,owner){
 return pool.query(`UPDATE compel_worker_jobs SET lease_until=NOW()+interval '15 minutes'
  WHERE owner=$1 AND lane='research' AND status='processing' AND lease_until>NOW() RETURNING id`,[owner]);
}
async function release(pool,owner){
 return pool.query(`UPDATE compel_worker_jobs SET status='pending',owner=NULL,account_id=NULL,lease_until=NULL
  WHERE owner=$1 AND lane='research' AND status='processing'`,[owner]);
}
module.exports={SCHEMA,ensure,handoff,claim,heartbeat,release,fullCapture};
