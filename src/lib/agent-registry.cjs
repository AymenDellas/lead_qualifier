'use strict';
const path=require('node:path'),os=require('node:os'),{createHash}=require('node:crypto');
const {isProcessOwner}=require('./worker-process-identity.cjs');
const hostId=createHash('sha256').update(os.hostname()+'\0'+os.platform()).digest('hex').slice(0,24);
const SCHEMA=`ALTER TABLE compel_worker_config ADD COLUMN IF NOT EXISTS agent_status JSONB NOT NULL DEFAULT '{}';
 ALTER TABLE compel_worker_config ADD COLUMN IF NOT EXISTS agent_stop_requested BOOLEAN NOT NULL DEFAULT FALSE;
 CREATE TABLE IF NOT EXISTS compel_engine_agents(owner TEXT PRIMARY KEY,host_id TEXT NOT NULL,pid INTEGER NOT NULL,script TEXT NOT NULL,
 seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),stopped_at TIMESTAMPTZ,recovered_at TIMESTAMPTZ);`;
const error=(code,message)=>Object.assign(Error(message),{code});
async function claim(pool,owner,{processOwner=isProcessOwner,now=Date.now,script=path.resolve(process.argv[1])}={}){
 const c=await pool.connect();try{
  await c.query('BEGIN');const config=(await c.query('SELECT * FROM compel_worker_config WHERE id=1 FOR UPDATE')).rows[0],old=config.agent_status;
  if(old?.owner&&old.owner!==owner&&old.stage!=='OFFLINE'){
   const row=(await c.query('SELECT * FROM compel_engine_agents WHERE owner=$1',[old.owner])).rows[0];
   if(!row||row.host_id!==hostId)throw error('REMOTE_OWNER_UNVERIFIED','Another or unverified agent owns this database. Stop that agent on its computer before starting here.');
   const state=await processOwner(row.pid,row.script);if(state!==false)throw error('AGENT_ALREADY_RUNNING','The previous agent process is still alive or its ownership cannot be verified. Check its local process and log.');
   const remaining=30000-(now()-new Date(row.seen_at).getTime());if(!row.stopped_at&&remaining>0){await c.query('ROLLBACK');return {waitMs:remaining,reason:'Waiting for the confirmed-dead agent heartbeat to expire.'};}
  }else if(!old?.owner&&config.supervisor_seen_at&&now()-new Date(config.supervisor_seen_at).getTime()<45000){throw error('LEGACY_SERVICE_ACTIVE','The previous supervisor is still reporting. Stop it before starting the single agent.');}
  await c.query(`INSERT INTO compel_engine_agents(owner,host_id,pid,script) VALUES($1,$2,$3,$4)`,[owner,hostId,process.pid,script]);
  await c.query(`UPDATE compel_worker_config SET supervisor_seen_at=NOW(),agent_stop_requested=FALSE,agent_status=$1::jsonb WHERE id=1`,[JSON.stringify({owner,hostId,pid:process.pid,stage:'AGENT_ACK'})]);
  await c.query('COMMIT');return {owner,hostId};
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
async function heartbeat(pool,owner,status){
 const result=await pool.query(`UPDATE compel_worker_config SET supervisor_seen_at=NOW(),agent_status=$2::jsonb
  WHERE id=1 AND agent_status->>'owner'=$1 RETURNING agent_stop_requested`,[owner,JSON.stringify({...status,owner,hostId,pid:process.pid})]);
 if(!result.rowCount)throw error('AGENT_LEASE_LOST','Agent ownership changed. Stop this agent before further browser work.');
 await pool.query('UPDATE compel_engine_agents SET seen_at=NOW() WHERE owner=$1',[owner]);return result.rows[0].agent_stop_requested;
}
async function recover(pool,currentOwner,{processOwner=isProcessOwner}={}){
 const rows=(await pool.query(`SELECT * FROM compel_engine_agents WHERE owner<>$1 AND host_id=$2 AND recovered_at IS NULL
  AND (stopped_at IS NOT NULL OR seen_at<NOW()-interval '30 seconds')`,[currentOwner,hostId])).rows;
 for(const row of rows){
  if(await processOwner(row.pid,row.script)!==false)continue;
  const c=await pool.connect();try{await c.query('BEGIN');
   await c.query(`UPDATE compel_worker_jobs SET status='pending',owner=NULL,account_id=NULL,lease_until=NULL WHERE status='processing' AND owner LIKE $1`,[row.owner+'/%']);
   await c.query(`UPDATE compel_worker_sessions SET lease_until=NOW(),status=status || '{"status":"offline","reason":"Recovered confirmed-dead agent; checkpoints retained."}'::jsonb WHERE owner LIKE $1`,[row.owner+'/%']);
   await c.query("UPDATE compel_prospect_runs SET status='PENDING',owner=NULL,lease_until=NULL WHERE status='RUNNING' AND owner LIKE $1",[row.owner+'/%']);
   await c.query('UPDATE compel_engine_agents SET recovered_at=NOW() WHERE owner=$1',[row.owner]);await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }
}
async function accountAvailable(pool,id,owner){
 const row=(await pool.query('SELECT owner,status,lease_until>NOW() AS live FROM compel_worker_sessions WHERE account_id=$1',[id])).rows[0];
 if(!row||row.owner===owner||!row.live&&['offline','signed_out'].includes(row.status?.status))return true;
 throw error('ACCOUNT_OWNER_UNVERIFIED',row.live?'Another session still owns this account. Wait for its lease release or stop its agent.':'The old account owner has no verified release. Stop the old worker and review its ownership before recovering.');
}
async function release(pool,owner,status={stage:'OFFLINE'}){
 await pool.query(`UPDATE compel_worker_config SET supervisor_seen_at=NULL,agent_status=agent_status || $2::jsonb WHERE id=1 AND agent_status->>'owner'=$1`,[owner,JSON.stringify(status)]);
 await pool.query('UPDATE compel_engine_agents SET stopped_at=NOW() WHERE owner=$1',[owner]);
}
module.exports={SCHEMA,hostId,claim,heartbeat,recover,accountAvailable,release};
