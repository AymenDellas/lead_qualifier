'use strict';

// Shared by Next.js and the persistent worker. Vercel never stores queue files
// or launches browsers: the database carries settings, leases and results.
const { randomUUID, randomBytes, createCipheriv, createDecipheriv, createHash } = require('node:crypto');
const {cleanIdentity}=require('./linkedin-session-identity.cjs');
const {sameMember}=require('./linkedin-session-policy.cjs');
const {failureOf}=require('./worker-failure.cjs');
const {normalizeEngineResult}=require('./engine-result.cjs');
const telemetry=require('./engine-telemetry.cjs');
const ready = new WeakMap();
// Browser text can contain lone UTF-16 surrogates or NULs. PostgreSQL JSONB
// rejects those even though JSON.stringify accepts them. Keep normal emoji.
function json(value) { return JSON.stringify(value, (_key,item)=>typeof item==='string'?item.toWellFormed().replace(/\u0000/g,''):item); }
const SCHEMA = `
CREATE TABLE IF NOT EXISTS compel_worker_config (id INTEGER PRIMARY KEY CHECK(id=1), active_count INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 0);
INSERT INTO compel_worker_config(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS compel_linkedin_accounts (
 id TEXT PRIMARY KEY, label TEXT NOT NULL, email TEXT NOT NULL, secret TEXT NOT NULL DEFAULT '',
 profile_key TEXT UNIQUE NOT NULL, enabled BOOLEAN NOT NULL DEFAULT TRUE, archived BOOLEAN NOT NULL DEFAULT FALSE,
 daily_limit INTEGER NOT NULL DEFAULT 400 CHECK(daily_limit BETWEEN 1 AND 400), position INTEGER NOT NULL,
 login_requested_at TIMESTAMPTZ, changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE UNIQUE INDEX IF NOT EXISTS compel_linkedin_active_email ON compel_linkedin_accounts(lower(email)) WHERE archived IS FALSE;
ALTER TABLE compel_linkedin_accounts ADD COLUMN IF NOT EXISTS logout_requested_at TIMESTAMPTZ;
ALTER TABLE compel_linkedin_accounts ADD COLUMN IF NOT EXISTS signed_out_at TIMESTAMPTZ;
ALTER TABLE compel_linkedin_accounts ADD COLUMN IF NOT EXISTS processing_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE compel_linkedin_accounts ADD COLUMN IF NOT EXISTS processing_until TIMESTAMPTZ;
ALTER TABLE compel_linkedin_accounts ADD COLUMN IF NOT EXISTS connected_at TIMESTAMPTZ;
ALTER TABLE compel_linkedin_accounts ADD COLUMN IF NOT EXISTS confirmed_identity JSONB;
ALTER TABLE compel_linkedin_accounts ADD COLUMN IF NOT EXISTS attention_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE compel_linkedin_accounts ADD COLUMN IF NOT EXISTS daily_request_limit INTEGER NOT NULL DEFAULT 100;
ALTER TABLE compel_linkedin_accounts ADD COLUMN IF NOT EXISTS request_interval_seconds INTEGER NOT NULL DEFAULT 15;
ALTER TABLE compel_linkedin_accounts ADD COLUMN IF NOT EXISTS next_check_at TIMESTAMPTZ;
ALTER TABLE compel_linkedin_accounts ADD COLUMN IF NOT EXISTS activity_limits JSONB NOT NULL DEFAULT '{}';
ALTER TABLE compel_linkedin_accounts ADD COLUMN IF NOT EXISTS working_hours JSONB;
CREATE TABLE IF NOT EXISTS compel_worker_events (
 id BIGSERIAL PRIMARY KEY,account_id TEXT NOT NULL,kind TEXT NOT NULL,message TEXT NOT NULL,
 data JSONB NOT NULL DEFAULT '{}',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE INDEX IF NOT EXISTS compel_worker_events_account ON compel_worker_events(account_id,created_at DESC);
CREATE TABLE IF NOT EXISTS compel_worker_usage (account_id TEXT NOT NULL, day DATE NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(account_id,day));
ALTER TABLE compel_worker_usage ADD COLUMN IF NOT EXISTS request_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE compel_worker_usage ADD COLUMN IF NOT EXISTS cached_profiles INTEGER NOT NULL DEFAULT 0;
ALTER TABLE compel_worker_usage ADD COLUMN IF NOT EXISTS request_kinds JSONB NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS compel_worker_profile_usage (
 day DATE NOT NULL, profile_key TEXT NOT NULL, account_id TEXT NOT NULL, job_id TEXT NOT NULL,
 first_claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 attempts INTEGER NOT NULL DEFAULT 1, source TEXT NOT NULL DEFAULT 'claim', PRIMARY KEY(day,profile_key));
CREATE INDEX IF NOT EXISTS compel_worker_profile_usage_account ON compel_worker_profile_usage(account_id,day);
CREATE TABLE IF NOT EXISTS compel_worker_sessions (account_id TEXT PRIMARY KEY, owner TEXT NOT NULL, lease_until TIMESTAMPTZ NOT NULL, status JSONB NOT NULL DEFAULT '{}', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS compel_worker_jobs (
 id TEXT PRIMARY KEY, profile_key TEXT NOT NULL, payload JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
 account_id TEXT, owner TEXT, lease_until TIMESTAMPTZ, result JSONB,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ);
ALTER TABLE compel_worker_jobs ADD COLUMN IF NOT EXISTS queue_order BIGSERIAL;
ALTER TABLE compel_worker_jobs ADD COLUMN IF NOT EXISTS checkpoint JSONB;
ALTER TABLE compel_worker_jobs ADD COLUMN IF NOT EXISTS retry_at TIMESTAMPTZ;
ALTER TABLE compel_worker_jobs ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE compel_worker_jobs ADD COLUMN IF NOT EXISTS lane TEXT NOT NULL DEFAULT 'capture';
CREATE TABLE IF NOT EXISTS compel_research_budget (id TEXT PRIMARY KEY,next_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
ALTER TABLE compel_worker_config ADD COLUMN IF NOT EXISTS supervisor_seen_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS compel_worker_pending_profile ON compel_worker_jobs(profile_key) WHERE status IN ('pending','processing');
CREATE INDEX IF NOT EXISTS compel_worker_job_queue ON compel_worker_jobs(created_at) WHERE status IN ('pending','processing');
CREATE TABLE IF NOT EXISTS compel_prospect_runs (
 id UUID PRIMARY KEY,account_id TEXT NOT NULL,source TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'PENDING',
 data JSONB NOT NULL,owner TEXT,lease_until TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE INDEX IF NOT EXISTS compel_prospect_run_queue ON compel_prospect_runs(account_id,status);
`;
async function ensure(pool) {
 if (!ready.has(pool)) ready.set(pool, (async()=>{
  // Existing deployments must not take schema locks while other workers save
  // jobs. Only run migrations when the current columns are actually missing.
  const migrated=await pool.query(`SELECT to_regclass('compel_research_budget') IS NOT NULL
   AND to_regclass('compel_worker_profile_usage') IS NOT NULL
   AND to_regclass('compel_prospect_runs') IS NOT NULL
   AND to_regclass('compel_worker_events') IS NOT NULL
   AND (SELECT count(*)=11 FROM pg_attribute WHERE attrelid=to_regclass('compel_linkedin_accounts') AND attname IN ('processing_enabled','processing_until','connected_at','confirmed_identity','attention_reason','daily_request_limit','request_interval_seconds','next_check_at','signed_out_at','activity_limits','working_hours') AND NOT attisdropped)
   AND (SELECT count(*)=3 FROM pg_attribute WHERE attrelid=to_regclass('compel_worker_usage') AND attname IN ('request_count','cached_profiles','request_kinds') AND NOT attisdropped)
   AND (SELECT count(*)=4 FROM pg_attribute WHERE attrelid=to_regclass('compel_worker_jobs') AND attname IN ('checkpoint','retry_at','retry_count','lane') AND NOT attisdropped)
   AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('compel_worker_config') AND attname='supervisor_seen_at' AND NOT attisdropped) AS migrated`);
  if(migrated.rows[0]?.migrated)return;
  // All schema changes share one transaction lock across worker processes.
  const client=await pool.connect();
  try{
   await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock(hashtext('compel/worker-schema/v7'))");
   // Recheck after acquiring the lock: only the first migrating process may
   // reconstruct today's allowance. Other workers must retain new reservations.
   const hadProfileUsage=(await client.query("SELECT to_regclass('compel_worker_profile_usage') IS NOT NULL AS present")).rows[0].present;
   await client.query(SCHEMA);
   if(!hadProfileUsage)await backfillProfileUsage(client);
   await client.query('COMMIT');
  }
  catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 })().catch(error => { ready.delete(pool); throw error; }));
 return ready.get(pool);
}
async function backfillProfileUsage(client) {
 // The old counter recorded attempts. Recover distinct visits from saved
 // activity timestamps, including profiles whose website research is pending.
 // Fresh LinkedIn failure logs cover requests that never reached activity.
 const day=(await client.query("SELECT (NOW() AT TIME ZONE 'UTC')::date::text AS day")).rows[0].day;
 const accounts=(await client.query('SELECT id FROM compel_linkedin_accounts ORDER BY archived,position,id')).rows;
 if(!accounts.length)return;
 const jobs=(await client.query(`SELECT id,profile_key,account_id,result->>'accountId' AS result_account,
  COALESCE(result->'activityEvidence'->>'checkedAt',checkpoint->'activityEvidence'->>'checkedAt') AS checked_at,
  result->'logs' AS logs,completed_at FROM compel_worker_jobs
  WHERE completed_at>=((NOW() AT TIME ZONE 'UTC')::date AT TIME ZONE 'UTC')
   OR COALESCE(result->'activityEvidence'->>'checkedAt',checkpoint->'activityEvidence'->>'checkedAt') LIKE $1`,[day+'%'])).rows;
 const knownAccounts=new Set(accounts.map(a=>a.id)), profiles=new Map();
 for(const job of jobs) {
  const checked=Date.parse(job.checked_at), completed=job.completed_at?new Date(job.completed_at):null;
  const dated=Number.isFinite(checked)&&new Date(checked).toISOString().slice(0,10)===day;
  const freshFailure=completed?.toISOString().slice(0,10)===day&&Array.isArray(job.logs)
   &&job.logs.some(line=>/Fetching contact info via Voyager API/.test(line))
   &&!job.logs.some(line=>/Resuming saved LinkedIn profile/.test(line));
  if(!dated&&!freshFailure)continue;
  const url=profileUrl(job.profile_key);if(!url)continue;
  const at=dated?new Date(checked).toISOString():completed.toISOString();
  const account=[job.account_id,job.result_account,profiles.get(url)?.account_id].find(id=>knownAccounts.has(id))||accounts[0].id;
  const entry={day,profile_key:url,account_id:account,job_id:job.id,at,source:dated?'migration_activity_evidence':'migration_job_log'};
  if(!profiles.has(url)||profiles.get(url).at>at)profiles.set(url,entry);
 }
 // No recorded visits means the imported legacy allowance cannot safely be
 // reconstructed. Keep it; fresh reservations still deduplicate from now on.
 if(!profiles.size)return;
 await client.query(`INSERT INTO compel_worker_profile_usage(day,profile_key,account_id,job_id,first_claimed_at,last_claimed_at,source)
  SELECT day::date,profile_key,account_id,job_id,at::timestamptz,at::timestamptz,source
  FROM jsonb_to_recordset($1::jsonb) AS entry(day TEXT,profile_key TEXT,account_id TEXT,job_id TEXT,at TEXT,source TEXT)
  ORDER BY profile_key ON CONFLICT DO NOTHING`,[json([...profiles.values()])]);
 await client.query(`INSERT INTO compel_worker_usage(account_id,day,count)
  SELECT a.id,$1::date,count(p.profile_key)::int FROM compel_linkedin_accounts a
  LEFT JOIN compel_worker_profile_usage p ON p.account_id=a.id AND p.day=$1::date
  GROUP BY a.id ON CONFLICT(account_id,day) DO UPDATE SET count=EXCLUDED.count`,[day]);
}
function encryptionKey(env = process.env, legacy = false) {
 let material = env.LINKEDIN_CREDENTIAL_KEY || env.DATABASE_URL;
 if (!material || material.length < 32) throw new Error('Account credential storage is not configured.');
 // Supabase uses distinct ports for persistent and transaction-pooled clients.
 // Credentials entered on Vercel must decrypt on the persistent worker too.
 if (!legacy && !env.LINKEDIN_CREDENTIAL_KEY) {
  const database = new URL(material); database.port = ''; material = database.toString();
 }
 return createHash('sha256').update('compel/linkedin-credentials/v1\0').update(material).digest();
}
function encrypt(password, env) {
 const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey(env), iv);
 const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
 return 'v2.' + [iv,cipher.getAuthTag(),encrypted].map(value=>value.toString('base64url')).join('.');
}
function decrypt(secret, env) {
 if (!secret) return '';
 const version2 = secret.startsWith('v2.');
 const [iv, tag, encrypted] = (version2 ? secret.slice(3) : secret).split('.').map(value => Buffer.from(value, 'base64url'));
 const cipher = createDecipheriv('aes-256-gcm', encryptionKey(env,!version2), iv); cipher.setAuthTag(tag);
 return Buffer.concat([cipher.update(encrypted), cipher.final()]).toString('utf8');
}
function profileUrl(value) {
 try {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !/^(?:[a-z]{2,3}\.)?(?:www\.)?linkedin\.com$/.test(url.hostname) || url.username || url.password) return null;
  const match = url.pathname.match(/^\/in\/([^/]+)\/?$/);
  return match ? `https://www.linkedin.com/in/${match[1].toLowerCase()}/` : null;
 } catch { return null; }
}
function validateSettings(body) {
 if (!body || !Array.isArray(body.accounts) || body.accounts.length > 10 || !Number.isInteger(body.revision) || body.revision < 0) throw new Error('Invalid account settings.');
 const ids = new Set(), emails = new Set();
 const accounts = body.accounts.map((a, position) => {
  if (!a || typeof a.email !== 'string' || typeof a.label !== 'string' || typeof a.enabled !== 'boolean') throw new Error('Each account needs a name, email and enabled setting.');
  const email = a.email.trim().toLowerCase(), label = a.label.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 255 || !label || label.length > 80) throw new Error('Enter a valid LinkedIn email and a name of up to 80 characters.');
  if (emails.has(email)) throw new Error('This LinkedIn account is listed twice.'); emails.add(email);
  if (!Number.isInteger(a.dailyLimit) || a.dailyLimit < 1 || a.dailyLimit > 400) throw new Error('Daily limits must be between 1 and 400 profiles per account.');
  if (a.id && (typeof a.id !== 'string' || !/^(?:legacy-\d+|[a-f0-9-]{36})$/.test(a.id) || ids.has(a.id))) throw new Error('Invalid or repeated account ID.');
  if (a.id) ids.add(a.id);
  if (a.password !== undefined && (typeof a.password !== 'string' || a.password.length > 256)) throw new Error('Invalid password.');
  return { id: a.id || randomUUID(), email, label, enabled: a.enabled, dailyLimit: a.dailyLimit,position };
 });
 const enabled = accounts.filter(a => a.enabled).length;
 if (!Number.isInteger(body.activeCount) || body.activeCount < 0 || body.activeCount > enabled) throw new Error('Choose a number of running accounts between 0 and the number enabled.');
 return { accounts, activeCount: body.activeCount, revision: body.revision };
}
async function settings(pool) {
 await ensure(pool);
 const config = (await pool.query('SELECT * FROM compel_worker_config WHERE id=1')).rows[0];
 const rows = (await pool.query(`SELECT a.id,a.label,a.email,a.enabled,a.daily_limit,a.position,(a.secret<>'') AS has_password,
  a.login_requested_at,a.logout_requested_at,a.signed_out_at,a.processing_enabled,a.processing_until,a.changed_at::text AS control_version,a.connected_at,a.confirmed_identity,a.attention_reason,s.status,s.updated_at,s.lease_until,COALESCE(u.count,0) AS daily_count,
  COALESCE(u.request_count,0) AS request_count,COALESCE(u.cached_profiles,0) AS cached_profiles,COALESCE(u.request_kinds,'{}') AS request_kinds
  FROM compel_linkedin_accounts a LEFT JOIN compel_worker_sessions s ON s.account_id=a.id
  LEFT JOIN compel_worker_usage u ON u.account_id=a.id AND u.day=(NOW() AT TIME ZONE 'UTC')::date
  WHERE a.archived IS FALSE ORDER BY a.position,a.id`)).rows;
 return { revision: config.revision, supervisorOnline:!!config.supervisor_seen_at&&Date.now()-new Date(config.supervisor_seen_at).getTime()<45000, activeCount: Math.min(config.active_count, rows.filter(a => a.enabled).length), accounts: rows.map(a => ({
  id:a.id,label:a.label,email:a.email,enabled:a.enabled,dailyLimit:a.daily_limit,hasPassword:a.has_password,
  dailyCount:a.daily_count,status:a.status?.status || 'offline',reason:a.status?.reason || '',
  runtimeVersion:a.status?.runtimeVersion||'',sessionReady:!!a.status?.sessionReady,browserOpen:!!a.status?.browserOpen,nextEligibleAt:a.status?.nextEligibleAt||null,
  dailyRequests:a.request_count||0,dailyCachedProfiles:a.cached_profiles||0,requestKinds:a.request_kinds||{},
  processingEnabled:!!a.processing_enabled,processingUntil:null,
  connectedAt:a.connected_at||null,attentionReason:a.attention_reason||'',
  prospectingReady:a.status?.prospectingVersion==='COACH_EVIDENCE_V1',
  online:!!a.lease_until && new Date(a.lease_until).getTime() > Date.now(),
  loginPending:!!a.login_requested_at, logoutPending:!!a.logout_requested_at, signedOut:!!a.signed_out_at, updatedAt:a.updated_at || null,
  memoryMB:a.status?.memoryMB || 0,avgJobDurationMs:a.status?.avgJobDurationMs || 0,url:a.status?.url || '',
  signedIn:a.signed_out_at?null:cleanIdentity(a.confirmed_identity||a.status?.signedIn),
  ...startupForAccount(config,a),
 })) };
}
function startupForAccount(config,a){
 const live=config.agent_status?.accounts?.[a.id],saved=a.status;
 const state=live?.controlVersion===a.control_version?live:saved?.controlVersion===a.control_version?saved:null;
 if(state?.startupStage)return {startupStage:state.startupStage,failedStage:state.failedStage||null,startupReason:state.reason||'',startupAction:state.action||''};
 if(a.login_requested_at||a.processing_enabled)return {startupStage:'REQUEST_RECEIVED',startupReason:'Request saved. Waiting for the local agent to acknowledge it.'};
 return {startupStage:null};
}
async function saveSettings(pool, body) {
 const value = validateSettings(body); await ensure(pool);
 const client = await pool.connect();
 try {
  await client.query('BEGIN');
  const config = (await client.query('SELECT * FROM compel_worker_config WHERE id=1 FOR UPDATE')).rows[0];
  if (config.revision !== value.revision) throw new Error('Account settings changed in another window. Reload before saving.');
  const existing = (await client.query('SELECT * FROM compel_linkedin_accounts')).rows;
  for (const a of value.accounts) {
   let before = existing.find(row => row.id === a.id && !row.archived);
   if (!before && body.accounts.some(row => row.id === a.id)) throw new Error('This account no longer exists. Reload before saving.');
   // Re-adding the same identity restores its profile and daily usage; removing
   // and adding an account cannot silently reset its daily budget.
   if (!before) { before=existing.find(row=>row.email.toLowerCase()===a.email); if(before)a.id=before.id; }
   // A login identity cannot inherit a different identity's cookie directory.
   if (before && before.email.toLowerCase() !== a.email) throw new Error('Add a new account to change its LinkedIn email.');
   // Manual authentication happens only in the worker's browser. Saved legacy
   // passwords are retained for compatibility but are never used by workers.
   const secret = before?.secret||'';
   await client.query(`INSERT INTO compel_linkedin_accounts(id,label,email,secret,profile_key,enabled,daily_limit,position)
    VALUES($1,$2,$3,$4,$1,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET label=$2,secret=$4,enabled=$5,daily_limit=$6,position=$7,archived=FALSE,
    changed_at=CASE WHEN compel_linkedin_accounts.secret IS DISTINCT FROM $4 THEN NOW() ELSE compel_linkedin_accounts.changed_at END`,
    [a.id,a.label,a.email,secret,a.enabled,a.dailyLimit,a.position]);
  }
  for(const a of value.accounts)await client.query(`UPDATE compel_linkedin_accounts SET
   processing_enabled=CASE WHEN $2 THEN processing_enabled ELSE FALSE END WHERE id=$1`,[a.id,a.enabled]);
  await client.query('UPDATE compel_linkedin_accounts SET archived=TRUE,enabled=FALSE,processing_enabled=FALSE,processing_until=NULL WHERE archived IS FALSE AND NOT(id=ANY($1::text[]))', [value.accounts.map(a => a.id)]);
  await client.query('UPDATE compel_worker_config SET active_count=$1,revision=revision+1 WHERE id=1', [value.activeCount]);
  if(value.activeCount===0)await client.query('UPDATE compel_linkedin_accounts SET processing_enabled=FALSE,processing_until=NULL WHERE processing_enabled');
  await client.query("SELECT pg_notify('compel_engine_wake','')");
  await client.query('COMMIT');
 } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
 return settings(pool);
}
async function importAccounts(pool, accounts, legacyUsage) {
 await ensure(pool);
 // One transaction makes startup import safe against a dashboard edit or a
 // second supervisor. Environment credentials are never a source of overwrites.
 const client = await pool.connect();
 try {
  await client.query('BEGIN'); await client.query('SELECT id FROM compel_worker_config WHERE id=1 FOR UPDATE');
  const count = (await client.query('SELECT count(*)::integer AS n FROM compel_linkedin_accounts')).rows[0].n;
  if (!count) {
   for (const [index, a] of accounts.slice(0,10).entries()) {
    if (!a.email || !a.password) continue;
    await client.query(`INSERT INTO compel_linkedin_accounts(id,label,email,secret,profile_key,position) VALUES($1,$2,$3,$4,$5,$6)`,
     [`legacy-${index}`,`Account ${index+1}`,a.email.trim().toLowerCase(),encrypt(a.password),index===0?'account-0':`legacy-${index}`,index]);
   }
   if (accounts.length && legacyUsage?.date && Number.isInteger(legacyUsage.count))
    await client.query('INSERT INTO compel_worker_usage(account_id,day,count) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', ['legacy-0',legacyUsage.date,legacyUsage.count]);
  }
  await client.query('COMMIT');
 } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
async function selectedAccounts(pool) {
 await ensure(pool);
 return (await pool.query(`SELECT a.*,a.changed_at::text AS control_version FROM compel_linkedin_accounts a WHERE a.enabled IS TRUE AND a.archived IS FALSE AND a.logout_requested_at IS NULL AND a.signed_out_at IS NULL
  AND a.processing_enabled IS TRUE AND a.connected_at IS NOT NULL AND a.attention_reason=''
  AND (SELECT active_count FROM compel_worker_config WHERE id=1)>0 ORDER BY a.position,a.id`)).rows;
}
async function readRuntimeAccount(pool,id) {
 return (await pool.query(`SELECT a.*,a.changed_at::text AS control_version,a.changed_at::text AS processing_token,a.login_requested_at::text AS login_token,a.logout_requested_at::text AS logout_token,
  (a.processing_enabled AND (SELECT active_count FROM compel_worker_config WHERE id=1)>0) AS authorized
  FROM compel_linkedin_accounts a WHERE a.id=$1 AND a.archived IS FALSE`,[id])).rows[0]||null;
}
async function acquireSession(pool, id, owner) {
 await ensure(pool);
 return (await pool.query(`INSERT INTO compel_worker_sessions(account_id,owner,lease_until,status) VALUES($1,$2,NOW()+interval '120 seconds','{"status":"starting"}')
  ON CONFLICT(account_id) DO UPDATE SET owner=$2,lease_until=NOW()+interval '120 seconds',status='{"status":"starting"}',updated_at=NOW()
  WHERE compel_worker_sessions.lease_until<NOW() OR compel_worker_sessions.owner=$2 RETURNING account_id`,[id,owner])).rowCount === 1;
}
async function heartbeat(pool, id, owner, status) {
 const update = await pool.query(`UPDATE compel_worker_sessions SET lease_until=NOW()+interval '120 seconds',status=$3::jsonb,updated_at=NOW() WHERE account_id=$1 AND owner=$2 AND lease_until>NOW()`,[id,owner,json(status)]);
 if (!update.rowCount) throw new Error('Account session lease lost; stopping this browser.');
 await pool.query(`UPDATE compel_worker_jobs SET lease_until=NOW()+interval '15 minutes' WHERE account_id=$1 AND owner=$2 AND status='processing'`,[id,owner]);
}
async function releaseSession(pool,id,owner,status) {
 await pool.query('UPDATE compel_worker_sessions SET lease_until=NOW(),status=$3::jsonb,updated_at=NOW() WHERE account_id=$1 AND owner=$2',[id,owner,json(status)]);
 await pool.query(`UPDATE compel_worker_jobs SET status='pending',owner=NULL,account_id=NULL,lease_until=NULL WHERE account_id=$1 AND owner=$2 AND status='processing'`,[id,owner]);
}
async function requestLogin(pool,id) {
 return accountTransaction(pool,async client=>{
  const a=(await client.query('SELECT * FROM compel_linkedin_accounts WHERE id=$1 AND archived IS FALSE FOR UPDATE',[id])).rows[0];
  if(!a||a.logout_requested_at)throw new Error('Account not found or sign-out is still pending.');
  const session=(await client.query('SELECT status,lease_until>NOW() AS online FROM compel_worker_sessions WHERE account_id=$1',[id])).rows[0];
  if(session?.online&&session.status?.status==='awaiting_login')return;
  await client.query('UPDATE compel_linkedin_accounts SET processing_enabled=FALSE,processing_until=NULL,login_requested_at=NOW(),signed_out_at=NULL,changed_at=NOW() WHERE id=$1',[id]);
  await accountEvent(client,id,'sign_in_requested','Manual sign-in requested. Processing stays paused.');
 });
}
async function requestLogout(pool,id) {
 await ensure(pool);
 const client=await pool.connect();
 try {
  await client.query('BEGIN');
  await client.query('SELECT id FROM compel_worker_config WHERE id=1 FOR UPDATE');
  const result=await client.query('UPDATE compel_linkedin_accounts SET enabled=FALSE,processing_enabled=FALSE,processing_until=NULL,connected_at=NULL,login_requested_at=NULL,logout_requested_at=NOW(),changed_at=NOW() WHERE id=$1 AND archived IS FALSE RETURNING id',[id]);
  if(!result.rowCount)throw new Error('Account not found.');
  await client.query('UPDATE compel_worker_config SET active_count=LEAST(active_count,(SELECT count(*) FROM compel_linkedin_accounts WHERE enabled IS TRUE AND archived IS FALSE)),revision=revision+1 WHERE id=1');
  await accountEvent(client,id,'signed_out','Sign-out requested. Processing stopped.');
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
async function finishLogout(pool,id,token) {
 if(!token)return false;
 const result=await pool.query('UPDATE compel_linkedin_accounts SET logout_requested_at=NULL,signed_out_at=NOW() WHERE id=$1 AND logout_requested_at=$2::timestamptz',[id,token]);
 return result.rowCount===1;
}
async function consumeLoginRequest(pool,id,token) {
 // Use PostgreSQL's exact text timestamp. A JavaScript Date discards the
 // microseconds, so comparing it to the original timestamp never clears it.
 if (!token) return false;
 const result=await pool.query('UPDATE compel_linkedin_accounts SET login_requested_at=NULL WHERE id=$1 AND login_requested_at=$2::timestamptz',[id,token]);
 return result.rowCount===1;
}
async function accountTransaction(pool,fn) {
 await ensure(pool);const client=await pool.connect();
 try{await client.query('BEGIN');const result=await fn(client);await client.query('COMMIT');return result;}
 catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
async function accountEvent(client,id,kind,message,data={}) {
 await client.query('INSERT INTO compel_worker_events(account_id,kind,message,data) VALUES($1,$2,$3,$4::jsonb)',[id,kind,message,json(data)]);
 await client.query("SELECT pg_notify('compel_engine_wake','')");
}
async function accountEvents(pool,id) {
 await ensure(pool);
 return (await pool.query("SELECT id,kind,message,created_at AS \"createdAt\" FROM compel_worker_events WHERE account_id=$1 AND kind<>'read' ORDER BY created_at DESC,id DESC LIMIT 30",[id])).rows;
}
async function confirmManualSignIn(pool,id,owner,identity) {
 const clean=cleanIdentity(identity);if(!clean)throw new Error('LinkedIn identity was not confirmed.');
 return accountTransaction(pool,async client=>{
  // Serialize identity checks across accounts; two simultaneous sign-ins may
  // not attach the same LinkedIn member to different worker profiles.
  await client.query('SELECT id FROM compel_worker_config WHERE id=1 FOR UPDATE');
  const a=(await client.query('SELECT * FROM compel_linkedin_accounts WHERE id=$1 AND archived IS FALSE FOR UPDATE',[id])).rows[0];
  const lease=await client.query('SELECT 1 FROM compel_worker_sessions WHERE account_id=$1 AND owner=$2 AND lease_until>NOW()',[id,owner]);
  if(!a||!lease.rowCount||a.logout_requested_at||a.login_requested_at)throw new Error('Account request changed; sign-in was not confirmed.');
  if(a.confirmed_identity&&!sameMember(a.confirmed_identity,clean))throw new Error('This browser is signed into a different LinkedIn member. Sign out and use the intended account.');
  if((await client.query("SELECT 1 FROM compel_linkedin_accounts WHERE id<>$1 AND archived IS FALSE AND connected_at IS NOT NULL AND (($2<>'' AND confirmed_identity->>'memberUrn'=$2) OR ($3<>'' AND confirmed_identity->>'profileUrl'=$3)) LIMIT 1",[id,clean.memberUrn,clean.profileUrl])).rowCount)
   throw new Error('This LinkedIn member is already connected to another saved account. Use that account instead.');
  await client.query("UPDATE compel_linkedin_accounts SET connected_at=NOW(),confirmed_identity=$2::jsonb,attention_reason='',processing_enabled=FALSE,processing_until=NULL WHERE id=$1",[id,json(clean)]);
  await accountEvent(client,id,'connected','Sign-in confirmed. Account is idle; processing requires an explicit start.');
 });
}
async function startProcessing(pool,id) {
 return accountTransaction(pool,async client=>{
  const config=(await client.query('SELECT * FROM compel_worker_config WHERE id=1 FOR UPDATE')).rows[0];
  const a=(await client.query('SELECT * FROM compel_linkedin_accounts WHERE id=$1 AND archived IS FALSE FOR UPDATE',[id])).rows[0];
  if(!a||!a.enabled)throw new Error('Enable this account in settings before starting.');
  if(a.attention_reason)throw new Error('This account needs review. Resolve LinkedIn’s check and complete manual sign-in before starting.');
  if(!a.connected_at||a.signed_out_at||a.login_requested_at||a.logout_requested_at)throw new Error('Complete manual sign-in before starting processing.');
  const existing=(await client.query('SELECT status,lease_until>NOW() AS online FROM compel_worker_sessions WHERE account_id=$1',[id])).rows[0];
  if(existing?.online&&existing.status?.runtimeVersion!=='SESSION_V2')throw new Error('The previous account window is still closing. Wait for it to finish.');
  if(existing?.online&&existing.status?.runtimeVersion==='SESSION_V2'&&(['awaiting_login','signing_out'].includes(existing.status?.status)||existing.status?.browserOpen&&!existing.status?.sessionReady))
   throw new Error('Finish connecting this account in its open browser before starting the batch.');
  if(config.active_count===0)throw new Error('Enable a processing slot in account settings before starting.');
  await client.query("UPDATE compel_linkedin_accounts SET processing_enabled=TRUE,processing_until=NULL,changed_at=clock_timestamp() WHERE id=$1",[id]);
  await accountEvent(client,id,'processing_started','Processing requested. Authorization persists until Pause, disable or account review.');
 });
}
async function pauseProcessing(pool,id,message='Processing paused from account settings.',attention=false,owner=null,version=null) {
 return accountTransaction(pool,async client=>{
  const result=await client.query(`UPDATE compel_linkedin_accounts a SET processing_enabled=FALSE,processing_until=NULL,
   attention_reason=CASE WHEN $3 THEN $2 ELSE attention_reason END
   WHERE id=$1 AND (processing_enabled IS TRUE OR $3 AND attention_reason IS DISTINCT FROM $2)
    AND ($4::text IS NULL OR EXISTS(SELECT 1 FROM compel_worker_sessions WHERE account_id=a.id AND owner=$4))
    AND ($5::timestamptz IS NULL OR a.changed_at=$5::timestamptz) RETURNING id`,[id,message,attention,owner,version]);
  if(result.rowCount)await accountEvent(client,id,attention?'needs_attention':'processing_paused',message);
 });
}
async function processingAllowed(pool,id,owner,version=null) {
 const result=await pool.query(`SELECT 1 FROM compel_linkedin_accounts a JOIN compel_worker_sessions s ON s.account_id=a.id
  WHERE a.id=$1 AND s.owner=$2 AND s.lease_until>NOW() AND a.enabled IS TRUE AND a.archived IS FALSE
   AND a.processing_enabled IS TRUE AND a.attention_reason='' AND a.connected_at IS NOT NULL
   AND a.login_requested_at IS NULL AND a.logout_requested_at IS NULL AND a.signed_out_at IS NULL
   AND (SELECT active_count FROM compel_worker_config WHERE id=1)>0
   AND ($3::timestamptz IS NULL OR a.changed_at=$3::timestamptz)`,[id,owner,version]);
 return result.rowCount===1;
}
async function recordLinkedInAction(pool,id,owner,kind,{manual=false,version=null}={}) {
 if(!['contact','profile','featured','activity','identity','discovery','profile_page','activity_page','other'].includes(kind))throw new Error('Unknown LinkedIn check.');
 if(manual&&kind!=='identity')throw new Error('Manual sign-in may only verify the account identity.');
 if(!manual&&!await processingAllowed(pool,id,owner,version))return {stopped:true,reason:'Processing is paused or the session request has changed.'};
 // Counts are dashboard statistics. No hourly, rolling, per-kind, schedule,
 // check budget, next-check time, permit or sleep can deny an owned action.
 return recordLinkedInCheck(pool,id,owner,kind);
}
const reserveLinkedInCheck=recordLinkedInAction; // compatibility for older local callers; no allowance is reserved
async function enqueue(pool, urls, options = {}) {
 await ensure(pool); const entries=[], skipped=[];
 if (!Array.isArray(urls) || urls.length > 5000) throw new Error('Submit up to 5,000 LinkedIn profiles.');
 if(options.jobId && urls.length!==1)throw new Error('A recovered job must contain one profile.');
 for (const value of urls) {
  const url = typeof value === 'string' ? profileUrl(value) : null;
  if (!url) { skipped.push({url:value,reason:'Invalid LinkedIn person profile'}); continue; }
  const id = options.jobId || `job_${randomUUID()}`;
  const payload={jobId:id,linkedinUrl:url,nativePostProcess:options.nativePostProcess!==false,targetRegion:options.targetRegion||'na',createdAt:new Date().toISOString(),...(options.engineBatchId?{engineBatchId:options.engineBatchId}:{})};
  entries.push({id,profile_key:url,payload,position:entries.length});
 }
 if(!entries.length)return{jobs:[],queuedCount:0,skipped,queued:[]};
 const completed=new Set((await pool.query(`SELECT DISTINCT profile_key FROM compel_worker_jobs
  WHERE profile_key=ANY($1::text[]) AND status='done'
   AND completed_at>=((NOW() AT TIME ZONE 'UTC')::date AT TIME ZONE 'UTC')`,[entries.map(entry=>entry.profile_key)])).rows.map(row=>row.profile_key));
 const eligible=entries.filter(entry=>!completed.has(entry.profile_key));
 for(const entry of entries)if(completed.has(entry.profile_key))skipped.push({url:entry.profile_key,reason:'Already completed today; use Retry failed for failed profiles'});
 const result=await pool.query(`INSERT INTO compel_worker_jobs(id,profile_key,payload)
  SELECT entry.id,entry.profile_key,entry.payload FROM jsonb_to_recordset($1::jsonb) AS entry(id TEXT,profile_key TEXT,payload JSONB,position INTEGER)
  WHERE NOT EXISTS(SELECT 1 FROM compel_worker_jobs done WHERE done.profile_key=entry.profile_key AND done.status='done'
   AND done.completed_at>=((NOW() AT TIME ZONE 'UTC')::date AT TIME ZONE 'UTC'))
  ORDER BY entry.position ON CONFLICT DO NOTHING RETURNING id`,[json(eligible)]);
 const inserted=new Set(result.rows.map(row=>row.id));
 const queued=entries.filter(entry=>inserted.has(entry.id)).map(entry=>({id:entry.id,url:entry.profile_key}));
 for(const entry of eligible)if(!inserted.has(entry.id))skipped.push({url:entry.profile_key,reason:'Already queued or completed today'});
 const jobs=queued.map(entry=>entry.id);
 return {jobs,queuedCount:jobs.length,skipped,queued};
}
// A duplicate Inbox row must not bring an assessed/contacted profile back into
// discovery. Return one candidate per person, before the caller filters region.
async function queueCandidates(pool) {
 await ensure(pool);
 return (await pool.query(`WITH people AS (
  SELECT id,linkedin_url,location,fit_score,created_at,pipeline_status,do_not_contact,contacted,contacted_source,
   lower(substring(linkedin_url from '/in/([^/?#]+)')) AS slug FROM leads
 ), eligible AS (
  SELECT DISTINCT ON (p.slug) p.id,p.linkedin_url,p.location,p.fit_score,p.created_at
  FROM people p WHERE p.pipeline_status='INBOX' AND p.slug IS NOT NULL
   AND NOT EXISTS(SELECT 1 FROM people other WHERE other.slug=p.slug AND
    (other.pipeline_status IS DISTINCT FROM 'INBOX' OR other.do_not_contact IS TRUE OR (other.contacted IS TRUE AND other.contacted_source IS NOT NULL)))
   AND NOT EXISTS(SELECT 1 FROM compel_worker_jobs j WHERE j.profile_key='https://www.linkedin.com/in/'||p.slug||'/' AND
    (j.status IN ('pending','processing') OR j.status='done' AND j.completed_at>=((NOW() AT TIME ZONE 'UTC')::date AT TIME ZONE 'UTC')))
  ORDER BY p.slug,p.fit_score DESC NULLS LAST,p.created_at,p.id
 ) SELECT * FROM eligible ORDER BY fit_score DESC NULLS LAST,created_at,id`)).rows;
}
// Also protect jobs queued before the enqueue fix, and the small race where a
// prior job finishes during enqueue. Keep history; only redundant fresh jobs
// are skipped. Saved research and website continuations remain runnable.
async function skipCompletedDuplicates(pool) {
 return (await pool.query(`UPDATE compel_worker_jobs j SET status='cancelled',completed_at=NOW(),
  result=jsonb_build_object('status','SKIPPED','url',j.profile_key,'reason','Profile already completed today; previous result retained')
  WHERE j.status='pending' AND j.checkpoint IS NULL AND j.payload->>'websiteContinuation' IS DISTINCT FROM 'true' AND j.payload->>'explicitRetry' IS DISTINCT FROM 'true'
   AND j.payload->'prospecting' IS NULL
   AND EXISTS(SELECT 1 FROM compel_worker_jobs d WHERE d.profile_key=j.profile_key AND d.status='done'
    AND d.completed_at>=((NOW() AT TIME ZONE 'UTC')::date AT TIME ZONE 'UTC'))`)).rowCount;
}
// Reuse captured facts, but never another account's messaging permission.
// Use capture time, not completion time: website retries are not a refresh.
function reusableLinkedInProfile(row,url,accountId,now=Date.now()) {
 const expected=profileUrl(url);if(!expected)return null;
 for(const value of [row?.checkpoint,row?.result]) {
  if(!value?.profileIdentityConfirmed||value.status==='ERROR'||value.linkedinCapture?.complete===false||profileUrl(value.url)!==expected)continue;
  const sourceAccount=value.linkedinAccountId||value.accountId||row.account_id;
  if(!sourceAccount)continue;
  const at=Date.parse(value.linkedinCapturedAt||value.activityEvidence?.checkedAt||value.linkedinContact?.checkedAt);
  if(!Number.isFinite(at)||at>now||now-at>=24*60*60*1000)continue;
  const saved=structuredClone(value);saved.status='PENDING';
  if(sourceAccount!==accountId||saved.linkedinContact?.accountId!==accountId)delete saved.linkedinContact;
  for(const key of ['failure','crmSaved','crmLeadId','linkedinChecks','linkedinCacheHit'])delete saved[key];
  return saved;
 }
 return null;
}
async function cachedLinkedInProfile(pool,url,accountId) {
 const rows=(await pool.query(`SELECT checkpoint,result,account_id FROM compel_worker_jobs
  WHERE profile_key=$1 AND status='done' AND completed_at>NOW()-interval '24 hours'
  ORDER BY (account_id=$2) DESC,completed_at DESC,queue_order DESC LIMIT 10`,[url,accountId])).rows;
 for(const row of rows){const saved=reusableLinkedInProfile(row,url,accountId);if(saved)return saved;}
 return null;
}
// Count explicit data reads, including failures and fallback calls. Asset loads
// and LinkedIn's own background traffic are deliberately not called "requests" here.
async function recordLinkedInCheck(pool,id,owner,kind) {
 if(!['contact','profile','featured','activity','identity','discovery','profile_page','activity_page','other','cache'].includes(kind))throw new Error('Unknown LinkedIn check.');
 const cached=kind==='cache';
 const result=await pool.query(`INSERT INTO compel_worker_usage(account_id,day,request_count,cached_profiles,request_kinds)
  SELECT $1,(NOW() AT TIME ZONE 'UTC')::date,$4,$5,jsonb_build_object($3::text,$4::int)
  FROM compel_worker_sessions WHERE account_id=$1 AND owner=$2 AND lease_until>NOW()
  ON CONFLICT(account_id,day) DO UPDATE SET request_count=compel_worker_usage.request_count+$4,
   cached_profiles=compel_worker_usage.cached_profiles+$5,
   request_kinds=CASE WHEN $4=0 THEN compel_worker_usage.request_kinds ELSE jsonb_set(compel_worker_usage.request_kinds,
    ARRAY[$3::text],to_jsonb(COALESCE((compel_worker_usage.request_kinds->>$3)::int,0)+1)) END
  RETURNING request_count,cached_profiles`,[id,owner,kind,cached?0:1,cached?1:0]);
 if(!result.rowCount)throw new Error('Account session lease lost before LinkedIn access.');
 return result.rows[0];
}
async function recordLinkedInChecks(pool,id,owner,kinds){
 const count=Object.values(kinds).reduce((sum,n)=>sum+n,0);if(!count)return;
 const result=await pool.query(`INSERT INTO compel_worker_usage(account_id,day,request_count,request_kinds)
  SELECT $1,(NOW() AT TIME ZONE 'UTC')::date,$4,$3::jsonb FROM compel_worker_sessions WHERE account_id=$1 AND owner=$2 AND lease_until>NOW()
  ON CONFLICT(account_id,day) DO UPDATE SET request_count=compel_worker_usage.request_count+$4,
  request_kinds=compel_worker_usage.request_kinds || (SELECT jsonb_object_agg(key,to_jsonb(COALESCE((compel_worker_usage.request_kinds->>key)::int,0)+value::int)) FROM jsonb_each_text($3::jsonb))
  RETURNING account_id`,[id,owner,json(kinds),count]);
 if(!result.rowCount)throw Error('Account session lease lost while saving action statistics.');
}
async function sessionOwned(pool,id,owner){return (await pool.query('SELECT 1 FROM compel_worker_sessions WHERE account_id=$1 AND owner=$2 AND lease_until>NOW()',[id,owner])).rowCount===1;}
async function claim(pool,id,owner,options={}) {
 await ensure(pool);
 const client=await pool.connect();
 try {
  await client.query('BEGIN');
  const account=(await client.query(`SELECT a.* FROM compel_linkedin_accounts a WHERE a.id=$1 AND a.enabled IS TRUE AND a.archived IS FALSE AND a.logout_requested_at IS NULL AND a.signed_out_at IS NULL
   AND a.processing_enabled IS TRUE AND a.connected_at IS NOT NULL AND a.attention_reason=''
   AND (SELECT active_count FROM compel_worker_config WHERE id=1)>0 FOR SHARE`,[id])).rows[0];
  if (!account) { await client.query('COMMIT'); return {disabled:true}; }
  const session=(await client.query('SELECT account_id FROM compel_worker_sessions WHERE account_id=$1 AND owner=$2 AND lease_until>NOW() FOR UPDATE',[id,owner])).rows[0];
  if (!session) throw new Error('Account session lease lost.');
  await client.query(`INSERT INTO compel_worker_usage(account_id,day) VALUES($1,(NOW() AT TIME ZONE 'UTC')::date) ON CONFLICT DO NOTHING`,[id]);
  const usage=(await client.query(`SELECT count FROM compel_worker_usage WHERE account_id=$1 AND day=(NOW() AT TIME ZONE 'UTC')::date FOR UPDATE`,[id])).rows[0];
  await skipCompletedDuplicates(client);
  const job=(await client.query(`SELECT * FROM compel_worker_jobs WHERE lane='capture' AND (status='pending' AND (retry_at IS NULL OR retry_at<=NOW()))
   AND ($3 IS FALSE OR checkpoint IS NOT NULL OR EXISTS(
    SELECT 1 FROM compel_worker_profile_usage p WHERE p.profile_key=compel_worker_jobs.profile_key AND p.day=(NOW() AT TIME ZONE 'UTC')::date)
    OR (payload->>'explicitRetry' IS DISTINCT FROM 'true' AND EXISTS(SELECT 1 FROM compel_worker_jobs saved
     WHERE saved.profile_key=compel_worker_jobs.profile_key AND saved.status='done'
      AND saved.checkpoint->>'profileIdentityConfirmed'='true'
      AND saved.checkpoint->>'linkedinCapturedAt'>$5 AND saved.checkpoint->>'linkedinCapturedAt'<=$6)))
   AND ($2 IS FALSE OR result->'failure'->>'code' IS DISTINCT FROM 'AI_RATE_LIMIT' OR NOT EXISTS(SELECT 1 FROM compel_research_budget WHERE id=$1 AND next_at>NOW()))
   AND (payload->'prospecting' IS NULL OR (payload->'prospecting'->>'accountId'=$4 AND EXISTS(
    SELECT 1 FROM compel_prospect_runs r WHERE r.id::text=payload->'prospecting'->>'runId' AND r.status IN ('PENDING','RUNNING','QUEUED'))))
   ORDER BY (COALESCE(payload->>'websiteContinuation','false')<>'true') DESC,(checkpoint IS NOT NULL) DESC,created_at,queue_order FOR UPDATE SKIP LOCKED LIMIT 1`,['groq/research/'+(process.env.PROSPECT_RESEARCH_MODEL?.trim()||'openai/gpt-oss-120b'),options.requiresAI===true,usage.count>=account.daily_limit,id,new Date(Date.now()-86400000).toISOString(),new Date().toISOString()])).rows[0];
  if (!job) { await client.query('COMMIT'); return usage.count>=account.daily_limit?{limited:true,dailyCount:usage.count,dailyLimit:account.daily_limit}:null; }
  const enginePickedAt=new Date().toISOString();
  if(!job.checkpoint&&job.payload.explicitRetry!==true)job.checkpoint=await cachedLinkedInProfile(client,job.profile_key,id);
  if(!job.checkpoint&&usage.count>=account.daily_limit&&!(await client.query(`SELECT 1 FROM compel_worker_profile_usage WHERE day=(NOW() AT TIME ZONE 'UTC')::date AND profile_key=$1`,[job.profile_key])).rowCount){
   await client.query('COMMIT');return {limited:true,dailyCount:usage.count,dailyLimit:account.daily_limit};
  }
  let charged=false;
  if(!job.checkpoint) {
   // Global day/profile uniqueness also covers a retry claimed by a different
   // account, an expired job lease, or an explicit manual retry of the batch.
   const reserved=await client.query(`INSERT INTO compel_worker_profile_usage(day,profile_key,account_id,job_id)
    VALUES((NOW() AT TIME ZONE 'UTC')::date,$1,$2,$3) ON CONFLICT DO NOTHING RETURNING profile_key`,[job.profile_key,id,job.id]);
   charged=reserved.rowCount===1;
   if(charged)await client.query(`UPDATE compel_worker_usage SET count=count+1 WHERE account_id=$1 AND day=(NOW() AT TIME ZONE 'UTC')::date`,[id]);
   else await client.query(`UPDATE compel_worker_profile_usage SET attempts=attempts+1,last_claimed_at=NOW()
    WHERE day=(NOW() AT TIME ZONE 'UTC')::date AND profile_key=$1`,[job.profile_key]);
  }
  await client.query(`UPDATE compel_worker_jobs SET status='processing',account_id=$2,owner=$3,lease_until=NOW()+interval '15 minutes',checkpoint=$4::jsonb WHERE id=$1`,[job.id,id,owner,job.checkpoint?json(job.checkpoint):null]);
  await client.query('COMMIT'); return {job:{...job.payload,engineCreatedAt:job.created_at,enginePickedAt,...(job.checkpoint?{resumeResult:{...job.checkpoint,...(job.result?.failure?{failure:job.result.failure}:{})},resumeCapture:job.checkpoint.linkedinCapture?.version===2&&job.checkpoint.linkedinCapture.complete===false}:{}),retryCount:job.retry_count},dailyCount:usage.count+(charged?1:0),dailyLimit:account.daily_limit};
 } catch(error) { await client.query('ROLLBACK'); throw error; } finally {client.release();}
}
async function complete(pool,id,owner,result) {
 result=telemetry.attach(result);
 const update=await telemetry.span('db.final_save',()=>pool.query(`UPDATE compel_worker_jobs SET status='done',result=$3::jsonb,completed_at=NOW(),lease_until=NULL
  WHERE id=$1 AND owner=$2 AND status='processing' AND lease_until>NOW() RETURNING id`,[id,owner,json(result)]));
 if(!update.rowCount)throw new Error('Job lease lost; result was not overwritten.');
 await telemetry.persist(pool,result,{final:true}).catch(error=>console.warn('[Engine metrics]',error.message));
}
async function checkpoint(pool,id,owner,result) {
 result=telemetry.attach(result);
 const update=await pool.query(`UPDATE compel_worker_jobs SET checkpoint=$3::jsonb WHERE id=$1 AND owner=$2 AND status='processing' AND lease_until>NOW()`,[id,owner,json(result)]);
 if(!update.rowCount)throw new Error('Job lease lost before saving the scraped profile.');
}
async function releaseClaim(pool,id,owner){
 const update=await pool.query(`UPDATE compel_worker_jobs SET status='pending',owner=NULL,account_id=NULL,lease_until=NULL
  WHERE id=$1 AND owner=$2 AND status='processing' AND lease_until>NOW() RETURNING id`,[id,owner]);
 return update.rowCount===1;
}
async function releaseCaptureClaims(pool,id,owner){
 await pool.query(`UPDATE compel_worker_jobs SET status='pending',owner=NULL,account_id=NULL,lease_until=NULL
  WHERE account_id=$1 AND owner=$2 AND lane='capture' AND status='processing'`,[id,owner]);
}
async function defer(pool,id,owner,result,retryAt) {
 result=telemetry.attach(result);
 const update=await pool.query(`UPDATE compel_worker_jobs SET status='pending',owner=NULL,account_id=NULL,lease_until=NULL,result=$3::jsonb,retry_at=$4,retry_count=retry_count+1,
  checkpoint=CASE WHEN $3::jsonb->'failure'->>'stage'='linkedin' AND checkpoint->'linkedinCapture'->>'version' IS DISTINCT FROM '2' THEN NULL ELSE checkpoint END
  WHERE id=$1 AND owner=$2 AND status='processing' AND lease_until>NOW()`,[id,owner,json(result),retryAt]);
 if(!update.rowCount)throw new Error('Job lease lost before scheduling recovery.');
 await telemetry.persist(pool,result).catch(error=>console.warn('[Engine metrics]',error.message));
}
async function retryFailed(pool) {
 await ensure(pool);const client=await pool.connect();let count=0,researchOnly=0;
 try {
  await client.query('BEGIN');
  const jobs=(await client.query(`SELECT j.* FROM compel_worker_jobs j WHERE j.status='done' AND j.result->>'status'='ERROR'
   AND NOT EXISTS(SELECT 1 FROM compel_worker_jobs newer WHERE newer.profile_key=j.profile_key AND newer.queue_order>j.queue_order)
   ORDER BY j.created_at FOR UPDATE OF j`)).rows;
  for(const job of jobs) {
   if((await client.query(`SELECT id FROM compel_worker_jobs WHERE profile_key=$1 AND status IN ('pending','processing')`,[job.profile_key])).rowCount)continue;
   const saved=failureOf(job.result).stage==='linkedin'?(job.checkpoint?.linkedinCapture?.version===2?job.checkpoint:null):job.result.profileIdentityConfirmed?job.result:job.checkpoint;
   const resume=saved?structuredClone(saved):null;
   // An explicit manual retry rechecks observed roots/contact routes while
   // retaining profile/activity evidence and previously published contacts.
   if(resume)for(const research of [resume.prospectQualification?.research,resume.prospectQualification?.baseResearch])if(research?.crawl)research.crawl.version=1;
   await client.query(`UPDATE compel_worker_jobs SET status='pending',checkpoint=$2::jsonb,payload=payload || '{"explicitRetry":true}'::jsonb,retry_at=NULL,retry_count=0,owner=NULL,account_id=NULL,lease_until=NULL WHERE id=$1`,[job.id,resume?json(resume):null]);
   count++;if(resume&&resume.linkedinCapture?.complete!==false)researchOnly++;
  }
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 return {queuedCount:count,researchOnly,scrapeCount:count-researchOnly};
}
async function reserveResearch(pool,model,tokens) {
 const client=await pool.connect();
 try {
  await client.query('BEGIN');const id='groq/research/'+model;
  await client.query('INSERT INTO compel_research_budget(id) VALUES($1) ON CONFLICT DO NOTHING',[id]);
  const row=(await client.query('SELECT next_at,GREATEST(0,EXTRACT(EPOCH FROM(next_at-NOW()))*1000)::int AS wait_ms FROM compel_research_budget WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(row.wait_ms>0){await client.query('COMMIT');return {ready:false,retryAt:new Date(row.next_at).toISOString()};}
  // Share the token budget across every account worker, even with several API keys.
  const spacing=Math.ceil(60000*Math.max(1000,tokens)/8000);
  await client.query("UPDATE compel_research_budget SET next_at=NOW()+($2*interval '1 millisecond') WHERE id=$1",[id,spacing]);
  await client.query('COMMIT');return {ready:true};
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
async function coolResearch(pool,model,retryAt) {
 await pool.query('UPDATE compel_research_budget SET next_at=GREATEST(next_at,$2::timestamptz) WHERE id=$1',['groq/research/'+model,retryAt]);
}
async function jobStatus(pool,id) {
 await ensure(pool);
 const job=(await pool.query('SELECT status,result FROM compel_worker_jobs WHERE id=$1',[id])).rows[0];
 return !job ? {jobId:id,status:'not_found'} : {jobId:id,status:job.status==='pending'?'queued':job.status,result:job.result};
}
async function clearQueue(pool) {
 await ensure(pool);
 // In-flight work keeps its lease and can finish saving.
 return (await pool.query(`UPDATE compel_worker_jobs SET status='cancelled',completed_at=NOW() WHERE status='pending'`)).rowCount;
}
function normalizeResult(result) {
 if(['SKIPPED','CANCELLED'].includes(result?.status))return result;
 if (result?.status==='PROSPECTED') return result;
 if (result?.status==='ERROR' && /saved profile and crawl will be resumed/i.test(result.failure?.reason || ''))return {...result,failure:{...result.failure,retryable:false,reason:'Website could not be fully read; the saved profile is retained for manual retry.'}};
 if (!result?.prospectQualification?.research || result.status==='ERROR') return result;
 try {
  const q=require('./prospect-qualification.cjs');
  const email=result.primaryEmail || result.emails?.[0] || '';
  const research=result.prospectQualification.baseResearch || result.prospectQualification.research;
  const assessment=q.assessProspect(research,{email,legacyFollowersUnchecked:result.prospectQualification.version<2&&!research.followers});
  return {...result,prospectQualification:assessment,status:q.pipelineForAssessment(assessment)==='QUALIFIED'?'QUALIFIED':q.pipelineForAssessment(assessment)==='REVIEW'?'REVIEW':result.status==='REVIEW'?'REVIEW':'REJECTED'};
 }catch{return {...result,status:'REJECTED'};}
}
async function importResult(pool,id,wrapper) {
 if (!/^job_[a-zA-Z0-9_-]+$/.test(id) || !wrapper?.result || !wrapper.completedAt || !Number.isFinite(Date.parse(wrapper.completedAt))) return;
 const url=profileUrl(wrapper.result.url);if(!url)return;
 const result=normalizeResult(wrapper.result);
 await pool.query(`INSERT INTO compel_worker_jobs(id,profile_key,payload,status,result,completed_at,created_at)
  VALUES($1,$2,$3::jsonb,'done',$4::jsonb,$5,$5) ON CONFLICT(id) DO NOTHING`,[id,url,json({jobId:id,linkedinUrl:url}),json(result),wrapper.completedAt]);
}
function historyPreview(value,fallbackUrl='') {
 const result=normalizeEngineResult(normalizeResult(value),fallbackUrl);if(!result)return result;
 const {about,latestPostText,prospectQualification,...preview}=result;
 if(!prospectQualification)return preview;
 const {research,baseResearch,...assessment}=prospectQualification;
 return {...preview,prospectQualification:{...assessment,...(research?{research:{profileIdentityConfirmed:research.profileIdentityConfirmed,lastActivityAt:research.lastActivityAt,
  ...(research.crawl?{crawl:{inspected:research.crawl.inspected,complete:research.crawl.complete,retryable:research.crawl.retryable,stoppedReason:research.crawl.stoppedReason}}:{})}}:{})}};
}
async function queueStatus(pool,{includeHistory=true}={}) {
 const config=await settings(pool);
 const rows=(await pool.query(`WITH jobs AS (
  SELECT *, retry_at AS ready_at FROM compel_worker_jobs)
  SELECT count(*) FILTER(WHERE status IN ('pending','processing'))::integer AS pending,
   count(*) FILTER(WHERE lane='research' AND status='pending')::integer AS research_pending,
   count(*) FILTER(WHERE lane='research' AND status='processing' AND lease_until>NOW())::integer AS research_processing,
   count(*) FILTER(WHERE status='pending' AND ready_at>NOW())::integer AS waiting,
   min(ready_at) FILTER(WHERE status='pending' AND ready_at>NOW()) AS next_retry FROM jobs`)).rows[0];
 // Choose IDs before loading JSON. Polling needs a result preview, not every
 // saved HTML page and crawl candidate in 100 complete research documents.
 // Retain the facts, contacts and crawl state used by normalizeResult's gates.
 const recent=includeHistory?(await pool.query(`WITH latest AS MATERIALIZED (
  SELECT DISTINCT ON (profile_key) id,completed_at,queue_order FROM compel_worker_jobs
  WHERE status='done' ORDER BY profile_key,completed_at DESC,queue_order DESC
 ), history AS MATERIALIZED (
  SELECT id,completed_at FROM latest ORDER BY completed_at DESC,queue_order DESC LIMIT 100
 ) SELECT id,profile_key,result,completed_at FROM (
  SELECT j.id,j.profile_key,h.completed_at,
   (j.result - ARRAY['logs','html','rawHtml','about','latestPostText','activityEvidence','prospectQualification']) ||
   CASE WHEN jsonb_typeof(j.result->'prospectQualification')='object' THEN jsonb_build_object('prospectQualification',
    ((j.result->'prospectQualification') - ARRAY['baseResearch','research']) ||
    CASE WHEN jsonb_typeof(r.value)='object' THEN jsonb_build_object('research',
     (r.value - ARRAY['pages','about','latestPostText','activityEvidence','description','crawl']) ||
     CASE WHEN jsonb_typeof(r.value->'crawl')='object' THEN jsonb_build_object('crawl',
      ((r.value->'crawl') - ARRAY['candidates','attempted','visited','pending','failed']) || jsonb_build_object(
       'pending',CASE WHEN jsonb_typeof(r.value#>'{crawl,pending}')='array' AND jsonb_array_length(r.value#>'{crawl,pending}')>0 THEN jsonb_build_array(r.value#>'{crawl,pending,0}') ELSE '[]'::jsonb END,
       'failed',CASE WHEN jsonb_typeof(r.value#>'{crawl,failed}')='array' AND jsonb_array_length(r.value#>'{crawl,failed}')>0 THEN jsonb_build_array(r.value#>'{crawl,failed,0}') ELSE '[]'::jsonb END)) ELSE '{}'::jsonb END
    ) ELSE '{}'::jsonb END
   ) ELSE '{}'::jsonb END AS result
  FROM history h JOIN compel_worker_jobs j ON j.id=h.id
  CROSS JOIN LATERAL (SELECT COALESCE(NULLIF(j.result#>'{prospectQualification,baseResearch}','null'::jsonb),j.result#>'{prospectQualification,research}') AS value) r
 ) previews ORDER BY completed_at DESC`)).rows:[];
 const selected=config.accounts.filter(a=>a.enabled&&!a.signedOut&&!a.logoutPending).slice(0,config.activeCount);
 const live=selected.filter(a=>a.online), busy=live.find(a=>a.status==='processing'), sleeping=live.find(a=>a.status==='sleeping');
 const dailyCount=Number((await pool.query("SELECT COALESCE(sum(count),0)::integer AS total FROM compel_worker_usage WHERE day=(NOW() AT TIME ZONE 'UTC')::date")).rows[0].total);
 const dailyLimit=selected.reduce((sum,a)=>sum+a.dailyLimit,0);
 const latestToday=`SELECT DISTINCT ON(profile_key) profile_key,result FROM compel_worker_jobs
  WHERE status='done' AND completed_at>=((NOW() AT TIME ZONE 'UTC')::date AT TIME ZONE 'UTC')
  ORDER BY profile_key,completed_at DESC,queue_order DESC`;
 let today=(await pool.query(`WITH latest AS (${latestToday}) SELECT
  count(*) FILTER(WHERE result->>'status'='QUALIFIED')::integer AS qualified,
  count(*) FILTER(WHERE result->>'status'='REJECTED')::integer AS rejected,
  count(*) FILTER(WHERE result->>'status'='ERROR')::integer AS errors FROM latest`)).rows[0];
 // CRM outcomes include results saved before the database queue was installed.
 try {today=(await pool.query(`WITH latest AS (${latestToday}), legacy AS (
   SELECT DISTINCT ON(lower(substring(linkedin_url from '/in/([^/?#]+)'))) pipeline_status,email
   FROM leads WHERE prospect_researched_at>=((NOW() AT TIME ZONE 'UTC')::date AT TIME ZONE 'UTC')
    AND NOT EXISTS(SELECT 1 FROM latest WHERE lower(substring(latest.profile_key from '/in/([^/?#]+)'))=lower(substring(leads.linkedin_url from '/in/([^/?#]+)')))
   ORDER BY lower(substring(linkedin_url from '/in/([^/?#]+)')),prospect_researched_at DESC
  ), outcomes AS (
   SELECT result->>'status' AS outcome FROM latest UNION ALL
   SELECT CASE WHEN pipeline_status='QUALIFIED' AND NULLIF(trim(email),'') IS NOT NULL THEN 'QUALIFIED'
    WHEN pipeline_status='NOT_QUALIFIED' THEN 'REJECTED' END FROM legacy
  ) SELECT count(*) FILTER(WHERE outcome='QUALIFIED')::int AS qualified,
   count(*) FILTER(WHERE outcome='REJECTED')::int AS rejected,count(*) FILTER(WHERE outcome='ERROR')::int AS errors FROM outcomes`)).rows[0];} catch { /* an older database has not received research columns yet */ }
 const ratePerHour=live.reduce((sum,a)=>sum+(a.avgJobDurationMs?Math.round(3600000/a.avgJobDurationMs):0),0);
 const dailyRemaining=selected.reduce((sum,a)=>sum+Math.max(0,a.dailyLimit-a.dailyCount),0);
 const limitReached=live.length>0&&live.every(a=>a.dailyCount>=a.dailyLimit);
 const authorized=selected.filter(a=>a.processingEnabled);
 const connectedIdle=selected.some(a=>a.connectedAt&&!a.attentionReason);
 const paused=live.length>0&&live.every(a=>a.status==='paused')||selected.length>0&&!authorized.length&&connectedIdle;
 const nextDailyResetAt=new Date(new Date().setUTCHours(24,0,0,0)).toISOString();
 return {status:'ok',available:true,queueSize:rows.pending,waitingCount:rows.waiting,nextRetryAt:rows.next_retry,accounts:config.accounts,activeCount:config.activeCount,
  workerStatus:{status:busy?'processing':sleeping?'sleeping':paused||limitReached?'paused':live.length?'ready':connectedIdle?'idle':'offline',stale:!live.length&&!config.supervisorOnline,
   nextEligibleAt:sleeping?.nextEligibleAt||null,
   researchPending:rows.research_pending||0,researchProcessing:rows.research_processing||0,
   reason:busy?.reason||live.find(a=>a.reason)?.reason||(!authorized.length?selected.find(a=>a.reason||a.attentionReason)?.reason||selected.find(a=>a.attentionReason)?.attentionReason:'')||'',
   processingAuthorized:authorized.length>0,supervisorOnline:!!config.supervisorOnline,
   pauseReason:limitReached?'DAILY_LIMIT':paused?'ACCOUNT_PAUSED':null,nextDailyResetAt,
   dailyCount,dailyLimit,dailyRequests:config.accounts.reduce((sum,a)=>sum+a.dailyRequests,0),dailyCachedProfiles:config.accounts.reduce((sum,a)=>sum+a.dailyCachedProfiles,0),dailyQualified:today.qualified,dailyRejected:today.rejected,dailyErrors:today.errors,
   dailyCompleted:today.qualified+today.rejected+today.errors,activeAccounts:live.length,configuredAccounts:selected.length,
   memoryMB:live.reduce((sum,a)=>sum+a.memoryMB,0),ratePerHour:ratePerHour||null,url:busy?.url||sleeping?.url||'',waitingCount:rows.waiting,nextRetryAt:rows.next_retry,
   dailyBudgetCount:selected.reduce((sum,a)=>sum+a.dailyCount,0),dailyRemaining},
  dailyStats:{date:new Date().toISOString().slice(0,10),count:dailyCount,limit:dailyLimit},
  ...(includeHistory?{recentResults:recent.map(row=>({jobId:row.id,result:historyPreview(row.result,row.profile_key),completedAt:row.completed_at}))}:{})};
}
module.exports={sessionOwned,recordLinkedInChecks,releaseCaptureClaims,releaseClaim,SCHEMA,ensure,readRuntimeAccount,accountEvents,confirmManualSignIn,startProcessing,pauseProcessing,processingAllowed,recordLinkedInAction,reserveLinkedInCheck,encrypt,decrypt,profileUrl,validateSettings,settings,saveSettings,importAccounts,selectedAccounts,acquireSession,heartbeat,releaseSession,requestLogin,consumeLoginRequest,requestLogout,finishLogout,enqueue,queueCandidates,skipCompletedDuplicates,reusableLinkedInProfile,cachedLinkedInProfile,recordLinkedInCheck,claim,complete,checkpoint,defer,retryFailed,reserveResearch,coolResearch,jobStatus,clearQueue,queueStatus,importResult,json};
