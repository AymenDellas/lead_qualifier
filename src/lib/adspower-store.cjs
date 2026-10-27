'use strict';
const {baseUrl,profileId,providerError}=require('./adspower-client.cjs');
const ready=new WeakMap();
const SCHEMA=`ALTER TABLE compel_linkedin_accounts ADD COLUMN IF NOT EXISTS adspower_profile_id TEXT;
 ALTER TABLE compel_linkedin_accounts ADD COLUMN IF NOT EXISTS adspower_profile_name TEXT NOT NULL DEFAULT '';
 ALTER TABLE compel_linkedin_accounts ADD COLUMN IF NOT EXISTS binding_revision BIGINT NOT NULL DEFAULT 0;
 ALTER TABLE compel_linkedin_accounts ADD COLUMN IF NOT EXISTS expected_member_name TEXT NOT NULL DEFAULT '';
 ALTER TABLE compel_linkedin_accounts ADD COLUMN IF NOT EXISTS close_requested_at TIMESTAMPTZ;
 CREATE UNIQUE INDEX IF NOT EXISTS compel_adspower_binding ON compel_linkedin_accounts(adspower_profile_id) WHERE adspower_profile_id IS NOT NULL AND NOT archived;
 CREATE TABLE IF NOT EXISTS compel_adspower_config(id INTEGER PRIMARY KEY CHECK(id=1),base_url TEXT NOT NULL DEFAULT 'http://127.0.0.1:50325',api_key_secret TEXT NOT NULL DEFAULT '',revision INTEGER NOT NULL DEFAULT 0,
  status JSONB NOT NULL DEFAULT '{}',profiles JSONB NOT NULL DEFAULT '[]',refresh_requested_at TIMESTAMPTZ,last_refreshed_at TIMESTAMPTZ);
 INSERT INTO compel_adspower_config(id) VALUES(1) ON CONFLICT DO NOTHING;
 CREATE TABLE IF NOT EXISTS compel_adspower_sessions(profile_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,owner TEXT NOT NULL,managed BOOLEAN NOT NULL DEFAULT FALSE,headless BOOLEAN,pid INTEGER,target_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),closed_at TIMESTAMPTZ);`;
async function ensure(pool){if(!ready.has(pool))ready.set(pool,(async()=>{const c=await pool.connect();try{await c.query('BEGIN');await c.query("SELECT pg_advisory_xact_lock(hashtext('compel/adspower/v1'))");await c.query(SCHEMA);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}})().catch(e=>{ready.delete(pool);throw e;}));return ready.get(pool);}
async function publicSettings(pool){await ensure(pool);const row=(await pool.query("SELECT base_url,api_key_secret<>' ' AND api_key_secret<>'' AS key_set,revision,status,profiles,last_refreshed_at FROM compel_adspower_config WHERE id=1")).rows[0];return {baseUrl:row.base_url,apiKeyConfigured:row.key_set,revision:row.revision,status:row.status,profiles:row.profiles,lastRefreshedAt:row.last_refreshed_at};}
async function privateConfig(pool){await ensure(pool);const row=(await pool.query('SELECT base_url,api_key_secret,revision FROM compel_adspower_config WHERE id=1')).rows[0];return {baseUrl:baseUrl(row.base_url),apiKey:require('./linkedin-workers.cjs').decrypt(row.api_key_secret),revision:row.revision};}
async function saveConfig(pool,input){
 await ensure(pool);const address=baseUrl(input.baseUrl);if(!Number.isInteger(input.revision)||input.apiKey!==undefined&&(typeof input.apiKey!=='string'||input.apiKey.length>4096||/[\r\n]/.test(input.apiKey)))throw Error('Invalid AdsPower API settings.');
 const c=await pool.connect();try{await c.query('BEGIN');const previous=(await c.query('SELECT * FROM compel_adspower_config WHERE id=1 FOR UPDATE')).rows[0];if(previous.revision!==input.revision)throw Error('AdsPower settings changed. Reload before saving.');
  if((await c.query("SELECT 1 FROM compel_linkedin_accounts WHERE NOT archived AND (processing_enabled OR login_requested_at IS NOT NULL OR close_requested_at IS NOT NULL) LIMIT 1")).rowCount)throw Error('Pause accounts and finish profile operations before changing AdsPower settings.');
  if(address!==previous.base_url&&(await c.query('SELECT 1 FROM compel_adspower_sessions WHERE closed_at IS NULL LIMIT 1')).rowCount)throw Error('Close managed profiles before changing the AdsPower API address.');
  const secret=input.clearApiKey?'':input.apiKey?require('./linkedin-workers.cjs').encrypt(input.apiKey):previous.api_key_secret;
  await c.query("UPDATE compel_adspower_config SET base_url=$1,api_key_secret=$2,revision=revision+1,refresh_requested_at=clock_timestamp(),status='{}',profiles='[]' WHERE id=1",[address,secret]);
  await c.query("SELECT pg_notify('compel_engine_wake','')");await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}return publicSettings(pool);
}
async function requestRefresh(pool){await ensure(pool);await pool.query('UPDATE compel_adspower_config SET refresh_requested_at=clock_timestamp() WHERE id=1');await pool.query("SELECT pg_notify('compel_engine_wake','')");}
async function importProfile(pool,{profileId:id,name,expectedMemberName,dailyLimit=300}){
 await ensure(pool);profileId(id);if(typeof name!=='string'||!name.trim()||name.length>80||typeof expectedMemberName!=='string'||!expectedMemberName.trim()||expectedMemberName.length>200||!Number.isInteger(dailyLimit)||dailyLimit<1||dailyLimit>400)throw Error('Enter the profile name, expected LinkedIn member and daily limit.');
 const c=await pool.connect();try{await c.query('BEGIN');await c.query('SELECT id FROM compel_worker_config WHERE id=1 FOR UPDATE');
  if((await c.query('SELECT 1 FROM compel_linkedin_accounts WHERE NOT archived AND adspower_profile_id=$1',[id])).rowCount)throw Error('This AdsPower profile is already linked.');
  const count=Number((await c.query('SELECT count(*)::int AS n FROM compel_linkedin_accounts WHERE NOT archived')).rows[0].n);if(count>=10)throw Error('CompelOS supports up to ten saved accounts.');
  const accountId=require('node:crypto').randomUUID();
  // This is an explicit internal handle in the legacy NOT NULL email column,
  // not an invented email address or a LinkedIn login credential.
  await c.query(`INSERT INTO compel_linkedin_accounts(id,label,email,profile_key,enabled,daily_limit,position,adspower_profile_id,adspower_profile_name,expected_member_name)
   VALUES($1,$2,$3,$1,TRUE,$4,COALESCE((SELECT max(position)+1 FROM compel_linkedin_accounts),0),$5,$2,$6)`,[accountId,name.trim(),'adspower:'+id,dailyLimit,id,expectedMemberName.trim()]);
  await c.query('UPDATE compel_worker_config SET revision=revision+1 WHERE id=1');await c.query("SELECT pg_notify('compel_engine_wake','')");await c.query('COMMIT');return accountId;
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
async function bind(pool,{accountId,profileId:id,name='',bindingRevision}){
 await ensure(pool);if(id!==null)profileId(id);if(typeof accountId!=='string'||!Number.isInteger(bindingRevision)||typeof name!=='string'||name.length>120)throw Error('Invalid AdsPower binding.');
 const c=await pool.connect();try{await c.query('BEGIN');await c.query('SELECT id FROM compel_worker_config WHERE id=1 FOR UPDATE');const a=(await c.query('SELECT * FROM compel_linkedin_accounts WHERE id=$1 AND NOT archived FOR UPDATE',[accountId])).rows[0];if(!a||Number(a.binding_revision)!==bindingRevision)throw Error('Profile binding changed. Reload before saving.');
  if(a.processing_enabled||a.login_requested_at||a.close_requested_at)throw Error('Pause and close this account session before changing its binding.');
  if((await c.query('SELECT 1 FROM compel_worker_sessions WHERE account_id=$1 AND lease_until>NOW()',[accountId])).rowCount)throw Error('Close this account session before changing its binding.');
  if((await c.query('SELECT 1 FROM compel_adspower_sessions WHERE account_id=$1 AND closed_at IS NULL',[accountId])).rowCount)throw Error('Close this account session before changing its binding.');
  await c.query('UPDATE compel_linkedin_accounts SET adspower_profile_id=$2,adspower_profile_name=$3,binding_revision=binding_revision+1,changed_at=clock_timestamp() WHERE id=$1',[accountId,id,name.trim()]);
  await c.query("SELECT pg_notify('compel_engine_wake','')");await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK');if(e.code==='23505')throw Error('This AdsPower profile is already linked to another account.');throw e;}finally{c.release();}
}
async function assertOwner(pool,account,owner){const result=await pool.query(`SELECT 1 FROM compel_linkedin_accounts a JOIN compel_worker_sessions s ON s.account_id=a.id
 WHERE a.id=$1 AND a.adspower_profile_id=$2 AND a.binding_revision=$3 AND NOT a.archived AND s.owner=$4 AND s.lease_until>NOW()`,[account.id,account.adspower_profile_id,account.binding_revision||0,owner]);if(!result.rowCount)throw providerError('ADSPOWER_OWNERSHIP_CHANGED','AdsPower binding or account session ownership changed. Processing is paused.');}
async function session(pool,id){return (await pool.query('SELECT * FROM compel_adspower_sessions WHERE profile_id=$1',[id])).rows[0]||null;}
async function saveSession(pool,account,owner,value){await assertOwner(pool,account,owner);await pool.query(`INSERT INTO compel_adspower_sessions(profile_id,account_id,owner,managed,headless,pid,target_id)
 VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(profile_id) DO UPDATE SET account_id=$2,owner=$3,managed=$4,headless=$5,pid=$6,target_id=$7,updated_at=NOW(),closed_at=NULL`,[account.adspower_profile_id,account.id,owner,value.managed,value.headless,value.pid,value.targetId]);}
async function finishSession(pool,account,owner){await pool.query('UPDATE compel_adspower_sessions SET closed_at=NOW(),updated_at=NOW() WHERE profile_id=$1 AND account_id=$2 AND owner=$3',[account.adspower_profile_id,account.id,owner]);}
module.exports={SCHEMA,ensure,publicSettings,privateConfig,saveConfig,requestRefresh,importProfile,bind,assertOwner,session,saveSession,finishSession};
