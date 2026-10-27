'use strict';
const {baseUrl,profileId,providerError}=require('./aliasmode-client.cjs');
const ready=new WeakMap();
const SCHEMA=`ALTER TABLE compel_linkedin_accounts ADD COLUMN IF NOT EXISTS aliasmode_profile_id TEXT;
 ALTER TABLE compel_linkedin_accounts ADD COLUMN IF NOT EXISTS aliasmode_profile_name TEXT NOT NULL DEFAULT '';
 ALTER TABLE compel_linkedin_accounts ADD COLUMN IF NOT EXISTS binding_revision BIGINT NOT NULL DEFAULT 0;
 ALTER TABLE compel_linkedin_accounts ADD COLUMN IF NOT EXISTS expected_member_name TEXT NOT NULL DEFAULT '';
 ALTER TABLE compel_linkedin_accounts ADD COLUMN IF NOT EXISTS close_requested_at TIMESTAMPTZ;
 CREATE UNIQUE INDEX IF NOT EXISTS compel_aliasmode_binding ON compel_linkedin_accounts(aliasmode_profile_id) WHERE aliasmode_profile_id IS NOT NULL AND NOT archived;
 CREATE TABLE IF NOT EXISTS compel_aliasmode_config(id INTEGER PRIMARY KEY CHECK(id=1),base_url TEXT NOT NULL DEFAULT 'http://127.0.0.1:50400',revision INTEGER NOT NULL DEFAULT 0,
  status JSONB NOT NULL DEFAULT '{}',profiles JSONB NOT NULL DEFAULT '[]',refresh_requested_at TIMESTAMPTZ,last_refreshed_at TIMESTAMPTZ);
 INSERT INTO compel_aliasmode_config(id) VALUES(1) ON CONFLICT DO NOTHING;
 CREATE TABLE IF NOT EXISTS compel_aliasmode_sessions(profile_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,owner TEXT NOT NULL,managed BOOLEAN NOT NULL DEFAULT FALSE,headless BOOLEAN,pid INTEGER,target_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),closed_at TIMESTAMPTZ);`;
async function ensure(pool){if(!ready.has(pool))ready.set(pool,(async()=>{const exists=(await pool.query("SELECT to_regclass('compel_aliasmode_config') IS NOT NULL AND to_regclass('compel_aliasmode_sessions') IS NOT NULL AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('compel_linkedin_accounts') AND attname='expected_member_name' AND NOT attisdropped) AS ready")).rows[0]?.ready;if(exists)return;const c=await pool.connect();try{await c.query('BEGIN');await c.query("SELECT pg_advisory_xact_lock(hashtext('compel/aliasmode/v1'))");await c.query(SCHEMA);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}})().catch(e=>{ready.delete(pool);throw e;}));return ready.get(pool);}
async function publicSettings(pool){await ensure(pool);const row=(await pool.query("SELECT base_url,revision,status,profiles,last_refreshed_at FROM compel_aliasmode_config WHERE id=1")).rows[0];return {baseUrl:row.base_url,revision:row.revision,status:row.status,profiles:row.profiles,lastRefreshedAt:row.last_refreshed_at};}
async function privateConfig(pool){await ensure(pool);const row=(await pool.query('SELECT base_url,revision FROM compel_aliasmode_config WHERE id=1')).rows[0];return {baseUrl:baseUrl(row.base_url),revision:row.revision};}
async function saveConfig(pool,input){
 await ensure(pool);const address=baseUrl(input.baseUrl);if(!Number.isInteger(input.revision)||Object.keys(input).some(key=>!['baseUrl','revision'].includes(key)))throw Error('Invalid AliasMode API settings.');
 const c=await pool.connect();try{await c.query('BEGIN');const previous=(await c.query('SELECT * FROM compel_aliasmode_config WHERE id=1 FOR UPDATE')).rows[0];if(previous.revision!==input.revision)throw Error('AliasMode settings changed. Reload before saving.');
  if((await c.query("SELECT 1 FROM compel_linkedin_accounts WHERE NOT archived AND (processing_enabled OR login_requested_at IS NOT NULL OR close_requested_at IS NOT NULL) LIMIT 1")).rowCount)throw Error('Pause accounts and finish profile operations before changing AliasMode settings.');
  if(address!==previous.base_url&&(await c.query('SELECT 1 FROM compel_worker_sessions WHERE lease_until>NOW() LIMIT 1')).rowCount)throw Error('Stop account sessions before changing the AliasMode API address.');
  if(address!==previous.base_url&&(await c.query('SELECT 1 FROM compel_aliasmode_sessions WHERE closed_at IS NULL LIMIT 1')).rowCount)throw Error('Close managed profiles before changing the AliasMode API address.');
  await c.query("UPDATE compel_aliasmode_config SET base_url=$1,revision=revision+1,refresh_requested_at=clock_timestamp(),status='{}',profiles='[]' WHERE id=1",[address]);
  await c.query("SELECT pg_notify('compel_engine_wake','')");await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}return publicSettings(pool);
}
async function requestRefresh(pool){await ensure(pool);await pool.query('UPDATE compel_aliasmode_config SET refresh_requested_at=clock_timestamp() WHERE id=1');await pool.query("SELECT pg_notify('compel_engine_wake','')");}
async function allowProcessing(pool,enabled){if(typeof enabled!=='boolean')throw Error('Choose whether processing is allowed.');await pool.query('UPDATE compel_worker_config SET active_count=CASE WHEN $1 THEN GREATEST(1,(SELECT count(*) FROM compel_linkedin_accounts WHERE NOT archived AND enabled AND aliasmode_profile_id IS NOT NULL)) ELSE 0 END,revision=revision+1 WHERE id=1',[enabled]);if(!enabled)await pool.query('UPDATE compel_linkedin_accounts SET processing_enabled=FALSE,processing_until=NULL WHERE processing_enabled');await pool.query("SELECT pg_notify('compel_engine_wake','')");}
async function importProfile(pool,{profileId:id,name,expectedMemberName,dailyLimit=300}){
 await ensure(pool);profileId(id);if(typeof name!=='string'||!name.trim()||name.length>80||typeof expectedMemberName!=='string'||!expectedMemberName.trim()||expectedMemberName.length>200||!Number.isInteger(dailyLimit)||dailyLimit<1||dailyLimit>400)throw Error('Enter the profile name, expected LinkedIn member and daily limit.');
 const c=await pool.connect();try{await c.query('BEGIN');await c.query('SELECT id FROM compel_worker_config WHERE id=1 FOR UPDATE');
  if((await c.query('SELECT 1 FROM compel_linkedin_accounts WHERE NOT archived AND aliasmode_profile_id=$1',[id])).rowCount)throw Error('This AliasMode profile is already linked.');
  const count=Number((await c.query('SELECT count(*)::int AS n FROM compel_linkedin_accounts WHERE NOT archived')).rows[0].n);if(count>=10)throw Error('CompelOS supports up to ten saved accounts.');
  const accountId=require('node:crypto').randomUUID();
  // This is an explicit internal handle in the legacy NOT NULL email column,
  // not an invented email address or a LinkedIn login credential.
  await c.query(`INSERT INTO compel_linkedin_accounts(id,label,email,profile_key,enabled,daily_limit,position,aliasmode_profile_id,aliasmode_profile_name,expected_member_name)
   VALUES($1,$2,$3,$1,TRUE,$4,COALESCE((SELECT max(position)+1 FROM compel_linkedin_accounts),0),$5,$2,$6)`,[accountId,name.trim(),'aliasmode:'+id,dailyLimit,id,expectedMemberName.trim()]);
  await c.query('UPDATE compel_worker_config SET revision=revision+1 WHERE id=1');await c.query("SELECT pg_notify('compel_engine_wake','')");await c.query('COMMIT');return accountId;
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
async function bind(pool,{accountId,profileId:id,name='',bindingRevision}){
 await ensure(pool);if(id!==null)profileId(id);if(typeof accountId!=='string'||!Number.isInteger(bindingRevision)||typeof name!=='string'||name.length>120)throw Error('Invalid AliasMode binding.');
 const c=await pool.connect();try{await c.query('BEGIN');await c.query('SELECT id FROM compel_worker_config WHERE id=1 FOR UPDATE');const a=(await c.query('SELECT * FROM compel_linkedin_accounts WHERE id=$1 AND NOT archived FOR UPDATE',[accountId])).rows[0];if(!a||Number(a.binding_revision)!==bindingRevision)throw Error('Profile binding changed. Reload before saving.');
  if(a.processing_enabled||a.login_requested_at||a.close_requested_at)throw Error('Pause and close this account session before changing its binding.');
  if((await c.query('SELECT 1 FROM compel_worker_sessions WHERE account_id=$1 AND lease_until>NOW()',[accountId])).rowCount)throw Error('Close this account session before changing its binding.');
  if((await c.query('SELECT 1 FROM compel_aliasmode_sessions WHERE account_id=$1 AND closed_at IS NULL',[accountId])).rowCount)throw Error('Close this account session before changing its binding.');
  await c.query('UPDATE compel_linkedin_accounts SET aliasmode_profile_id=$2,aliasmode_profile_name=$3,binding_revision=binding_revision+1,changed_at=clock_timestamp() WHERE id=$1',[accountId,id,name.trim()]);
  await c.query("SELECT pg_notify('compel_engine_wake','')");await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK');if(e.code==='23505')throw Error('This AliasMode profile is already linked to another account.');throw e;}finally{c.release();}
}
async function updateAccount(pool,{accountId,label,dailyLimit,enabled,expectedMemberName}){
 await ensure(pool);if(typeof label!=='string'||!label.trim()||label.length>80||!Number.isInteger(dailyLimit)||dailyLimit<1||dailyLimit>400||typeof enabled!=='boolean')throw Error('Enter an account label, enabled state and daily limit between 1 and 400.');
 if(expectedMemberName!==undefined&&(typeof expectedMemberName!=='string'||!expectedMemberName.trim()||expectedMemberName.length>200))throw Error('Enter the expected LinkedIn member name.');
 const result=await pool.query(`UPDATE compel_linkedin_accounts SET label=$2,daily_limit=$3,enabled=$4,processing_enabled=CASE WHEN $4 THEN processing_enabled ELSE FALSE END,
 expected_member_name=CASE WHEN connected_at IS NULL AND $5::text IS NOT NULL THEN $5 ELSE expected_member_name END,
 changed_at=CASE WHEN enabled IS DISTINCT FROM $4 OR connected_at IS NULL AND $5::text IS NOT NULL AND expected_member_name IS DISTINCT FROM $5 THEN clock_timestamp() ELSE changed_at END
 WHERE id=$1 AND NOT archived RETURNING id`,[accountId,label.trim(),dailyLimit,enabled,expectedMemberName?.trim()??null]);if(!result.rowCount)throw Error('Account not found.');await pool.query("SELECT pg_notify('compel_engine_wake','')");
}
async function requestClose(pool,id){await ensure(pool);const row=await pool.query('UPDATE compel_linkedin_accounts SET processing_enabled=FALSE,processing_until=NULL,login_requested_at=NULL,close_requested_at=clock_timestamp(),changed_at=clock_timestamp() WHERE id=$1 AND NOT archived AND aliasmode_profile_id IS NOT NULL RETURNING id',[id]);if(!row.rowCount)throw Error('Link an AliasMode profile before closing it.');await pool.query("SELECT pg_notify('compel_engine_wake','')");}
async function finishClose(pool,id,token){return (await pool.query('UPDATE compel_linkedin_accounts SET close_requested_at=NULL WHERE id=$1 AND close_requested_at=$2::timestamptz RETURNING id',[id,token])).rowCount===1;}
async function assertOwner(pool,account,owner,lock=false){const result=await pool.query(`SELECT 1 FROM compel_linkedin_accounts a JOIN compel_worker_sessions s ON s.account_id=a.id
 WHERE a.id=$1 AND a.aliasmode_profile_id=$2 AND a.binding_revision=$3 AND NOT a.archived AND s.owner=$4 AND s.lease_until>NOW()`+(lock?' FOR SHARE OF a,s':''),[account.id,account.aliasmode_profile_id,account.binding_revision||0,owner]);if(!result.rowCount)throw providerError('ALIASMODE_OWNERSHIP_CHANGED','AliasMode binding or account session ownership changed. Processing is paused.');}
async function session(pool,id){return (await pool.query('SELECT * FROM compel_aliasmode_sessions WHERE profile_id=$1',[id])).rows[0]||null;}
async function sessionTransaction(pool,account,owner,action){const c=await pool.connect();try{await c.query('BEGIN');await assertOwner(c,account,owner,true);await action(c);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
async function saveSession(pool,account,owner,value){await sessionTransaction(pool,account,owner,c=>c.query(`INSERT INTO compel_aliasmode_sessions(profile_id,account_id,owner,managed,headless,pid,target_id)
 VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(profile_id) DO UPDATE SET account_id=$2,owner=$3,managed=$4,headless=$5,pid=$6,target_id=$7,updated_at=NOW(),closed_at=NULL`,[account.aliasmode_profile_id,account.id,owner,value.managed,value.headless,value.pid,value.targetId]));}
async function finishSession(pool,account,owner){await sessionTransaction(pool,account,owner,c=>c.query('UPDATE compel_aliasmode_sessions SET closed_at=NOW(),updated_at=NOW() WHERE profile_id=$1 AND account_id=$2',[account.aliasmode_profile_id,account.id]));}
module.exports={SCHEMA,ensure,publicSettings,privateConfig,saveConfig,requestRefresh,allowProcessing,importProfile,bind,updateAccount,requestClose,finishClose,assertOwner,session,saveSession,finishSession};
