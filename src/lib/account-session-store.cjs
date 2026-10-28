'use strict';
const policy=require('./account-session-policy.cjs'),ready=new WeakMap();
const SCHEMA=`ALTER TABLE compel_linkedin_accounts ADD COLUMN IF NOT EXISTS engine TEXT NOT NULL DEFAULT 'aliasmode-chromium';
 ALTER TABLE compel_linkedin_accounts ADD COLUMN IF NOT EXISTS launch_mode TEXT NOT NULL DEFAULT 'headful';
 ALTER TABLE compel_linkedin_accounts ADD COLUMN IF NOT EXISTS proxy_id TEXT;
 ALTER TABLE compel_linkedin_accounts ADD COLUMN IF NOT EXISTS proxy_host TEXT;
 ALTER TABLE compel_linkedin_accounts ADD COLUMN IF NOT EXISTS proxy_port INTEGER;
 ALTER TABLE compel_linkedin_accounts ADD COLUMN IF NOT EXISTS proxy_user TEXT;
 ALTER TABLE compel_linkedin_accounts ADD COLUMN IF NOT EXISTS proxy_secret_ref TEXT;
 ALTER TABLE compel_linkedin_accounts ADD COLUMN IF NOT EXISTS proxy_country TEXT;
 ALTER TABLE compel_linkedin_accounts ADD COLUMN IF NOT EXISTS proxy_timezone TEXT;
 ALTER TABLE compel_linkedin_accounts ADD COLUMN IF NOT EXISTS session_policy JSONB NOT NULL DEFAULT '{}';
 ALTER TABLE compel_linkedin_accounts ADD COLUMN IF NOT EXISTS session_evidence JSONB NOT NULL DEFAULT '{}';
 ALTER TABLE compel_linkedin_accounts ADD COLUMN IF NOT EXISTS session_revision BIGINT NOT NULL DEFAULT 0;
 CREATE UNIQUE INDEX IF NOT EXISTS compel_session_proxy_binding ON compel_linkedin_accounts(proxy_id) WHERE proxy_id IS NOT NULL AND NOT archived;
 CREATE UNIQUE INDEX IF NOT EXISTS compel_session_proxy_egress ON compel_linkedin_accounts((session_evidence->'network'->>'ip')) WHERE NOT archived AND session_evidence->'network'->>'verdict'='PASS';`;
async function ensure(pool){if(!ready.has(pool))ready.set(pool,(async()=>{
 const exists=(await pool.query("SELECT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('compel_linkedin_accounts') AND attname='session_revision' AND NOT attisdropped) AS ready")).rows[0]?.ready;if(exists)return;
 const c=await pool.connect();try{await c.query('BEGIN');await c.query("SELECT pg_advisory_xact_lock(hashtext('compel/session-policy/v1'))");await c.query(SCHEMA);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
})().catch(e=>{ready.delete(pool);throw e;}));return ready.get(pool);}
function publicState(a){const e=a.session_evidence||{},g=e.gate;const gate=g?{verdict:g.verdict,reason:g.reason,checkedAt:g.checkedAt,reportId:g.reportId,approvedAt:g.approvedAt,sites:(Array.isArray(g.sites)?g.sites:[]).slice(0,8).map(s=>({url:s.url,verdict:s.verdict,reason:s.reason}))}:null;return {revision:Number(a.session_revision||0),engine:a.engine,launchMode:a.launch_mode,proxyId:a.proxy_id||'',proxyHost:a.proxy_host||'',proxyPort:a.proxy_port||null,proxyCountry:a.proxy_country||'',proxyTimezone:a.proxy_timezone||'',expectedExitIp:e.expectedExitIp||'',policy:policy.config(a.session_policy),lifecycle:policy.lifecycle(a,a.daily_day?{day:a.daily_day}:{}),network:e.network||null,gate,fingerprint:e.fingerprint?{hash:e.fingerprint.hash,fields:e.fingerprint.fields,checkedAt:e.fingerprint.checkedAt}:null,drift:e.drift||null,diagnosticRequested:e.command||null};}
async function configure(pool,input){
 await ensure(pool);const allowed=['accountId','revision','engine','launchMode','proxyId','proxyHost','proxyPort','proxyCountry','proxyTimezone','expectedExitIp','policy'];
 if(!input||Object.keys(input).some(k=>!allowed.includes(k))||typeof input.accountId!=='string'||!Number.isInteger(input.revision))throw Error('Invalid session settings; proxy passwords belong in AliasMode.');
 if(!['aliasmode-chromium','cloakbrowser'].includes(input.engine)||!['headful','headless'].includes(input.launchMode))throw Error('Choose a supported engine and launch mode.');
 const text=(value,max)=>{if(typeof value!=='string'||value.length>max||/[\u0000-\u001f]/.test(value))throw Error('Invalid proxy binding.');return value.trim();};
 const id=text(input.proxyId||'',120),host=text(input.proxyHost||'',253),country=text(input.proxyCountry||'',2).toUpperCase(),zone=text(input.proxyTimezone||'',100),ip=text(input.expectedExitIp||'',64);
 if(id){if(!/^[a-zA-Z0-9_.:-]+$/.test(id)||!host||!(/^[a-zA-Z0-9.-]+$/.test(host)||require('node:net').isIP(host))||!Number.isInteger(input.proxyPort)||input.proxyPort<1||input.proxyPort>65535||!/^[A-Z]{2}$/.test(country)||!require('node:net').isIP(ip))throw Error('Enter the proxy reference, plain hostname, port, country, timezone and fixed exit IP; credentials belong in AliasMode.');try{new Intl.DateTimeFormat('en',{timeZone:zone}).format();}catch{throw Error('Enter the proxy’s IANA timezone.');}}
 const settings=policy.config(input.policy),c=await pool.connect();try{
  await c.query('BEGIN');const a=(await c.query('SELECT * FROM compel_linkedin_accounts WHERE id=$1 AND NOT archived FOR UPDATE',[input.accountId])).rows[0];
  if(!a||Number(a.session_revision)!==input.revision)throw Error('Session settings changed. Reload before saving.');
  if(a.processing_enabled||a.login_requested_at||a.close_requested_at||(await c.query('SELECT 1 FROM compel_worker_sessions WHERE account_id=$1 AND lease_until>NOW() UNION ALL SELECT 1 FROM compel_aliasmode_sessions WHERE account_id=$1 AND closed_at IS NULL LIMIT 1',[a.id])).rowCount)throw Error('Pause and close this account session before changing its configuration.');
  await c.query(`UPDATE compel_linkedin_accounts SET engine=$2,launch_mode=$3,proxy_id=$4,proxy_host=$5,proxy_port=$6,proxy_country=$7,proxy_timezone=$8,
   proxy_secret_ref=CASE WHEN $4::text IS NULL THEN NULL ELSE 'aliasmode:'||aliasmode_profile_id END,session_policy=$9::jsonb,
   session_evidence=jsonb_build_object('expectedExitIp',$10::text)||jsonb_strip_nulls(jsonb_build_object('recoveryUntil',session_evidence->'recoveryUntil','reviewedAt',session_evidence->'reviewedAt','hold',session_evidence->'hold')),session_revision=session_revision+1,changed_at=clock_timestamp() WHERE id=$1`,[a.id,input.engine,input.launchMode,id||null,host||null,id?input.proxyPort:null,country||null,zone||null,JSON.stringify(settings),ip]);
  await c.query("SELECT pg_notify('compel_engine_wake','')");await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK');if(e.code==='23505')throw Error('This dedicated proxy is already bound to another account.');throw e;}finally{c.release();}
}
async function updateOwned(pool,a,owner,patch){
 if(typeof a.control_version!=='string')throw Error('The exact account control version is required for session evidence.');
 const result=await pool.query(`UPDATE compel_linkedin_accounts a SET session_evidence=session_evidence||$4::jsonb WHERE id=$1 AND session_revision=$3
  AND a.changed_at=$5::timestamptz AND EXISTS(SELECT 1 FROM compel_worker_sessions s WHERE s.account_id=a.id AND s.owner=$2 AND s.lease_until>NOW()) RETURNING a.*`,[a.id,owner,a.session_revision,JSON.stringify(patch),a.control_version]);
 if(!result.rowCount)throw Error('Session evidence ownership or configuration changed.');return result.rows[0];
}
async function request(pool,id,command){
 await ensure(pool);if(!['preflight','diagnostics','approve-identity'].includes(command))throw Error('Unknown session operation.');
 const r=await pool.query(`UPDATE compel_linkedin_accounts SET session_evidence=session_evidence||jsonb_build_object('command',$2::text,'requestedAt',clock_timestamp()),changed_at=clock_timestamp()
  WHERE id=$1 AND NOT archived AND NOT processing_enabled AND attention_reason='' AND aliasmode_profile_id IS NOT NULL
   AND login_requested_at IS NULL AND close_requested_at IS NULL AND logout_requested_at IS NULL
   AND NOT EXISTS(SELECT 1 FROM compel_worker_sessions s WHERE s.account_id=compel_linkedin_accounts.id AND s.lease_until>NOW() AND s.status->>'status'='awaiting_login') RETURNING id`,[id,command]);
 if(!r.rowCount)throw Error('Pause processing and resolve the account’s manual review hold before session diagnostics.');await pool.query("SELECT pg_notify('compel_engine_wake','')");
}
module.exports={SCHEMA,ensure,configure,publicState,updateOwned,request};
module.exports.evidence=async(pool,id)=>{if(typeof id!=='string'||!id||id.length>200)throw Error('Choose an account.');return (await pool.query('SELECT session_evidence FROM compel_linkedin_accounts WHERE id=$1 AND NOT archived',[id])).rows[0]?.session_evidence||{};};
module.exports.approveUnknown=async(pool,{accountId,revision,reportId})=>{
 await ensure(pool);if(typeof accountId!=='string'||!Number.isInteger(revision)||typeof reportId!=='string'||!reportId)throw Error('Choose the exact saved detector report.');
 const c=await pool.connect();try{
  await c.query('BEGIN');const a=(await c.query('SELECT * FROM compel_linkedin_accounts WHERE id=$1 AND NOT archived FOR UPDATE',[accountId])).rows[0],e=a?.session_evidence||{},g=e.gate;
  if(!a||Number(a.session_revision)!==revision||g?.reportId!==reportId)throw Error('The report or configuration changed. Review the current report before approving.');
  if(a.attention_reason||a.processing_enabled||e.drift||e.command)throw Error('Pause processing, resolve the account hold and finish current checks before reviewing the report.');
  if(g.verdict!=='UNKNOWN'||!Array.isArray(g.sites)||g.sites.some(s=>s.verdict==='FAIL'||s.external?.verdict==='FAIL'||s.checks?.some(c=>c.verdict==='FAIL')||require('./stealth-self-test.cjs').assessProbe(s.probe).some(c=>c.verdict==='FAIL')))throw Error('Only unclear results can be approved. Confirmed failures must be resolved.');
  if(g.key!==policy.evidenceKey(a)||!e.fingerprint?.hash||g.fingerprintHash!==e.fingerprint.hash||e.network?.verdict!=='PASS'||e.network.key!==g.key)throw Error('Browser identity or network evidence is stale. Run the checks again.');
  const gate={...g,verdict:'HUMAN_APPROVED',originalVerdict:'UNKNOWN',approvedBy:'local-admin',approvedAt:new Date().toISOString(),reason:'The local administrator reviewed this report and explicitly accepted its unclear checks. This is not an automated detector pass.'};
  await c.query("UPDATE compel_linkedin_accounts SET session_evidence=jsonb_set(session_evidence,'{gate}',$2::jsonb),changed_at=clock_timestamp() WHERE id=$1",[a.id,JSON.stringify(gate)]);
  await c.query("INSERT INTO compel_worker_events(account_id,kind,message,data) VALUES($1,'diagnostics_reviewed','Unclear detector report explicitly reviewed; processing remains paused.',$2::jsonb)",[a.id,JSON.stringify({reportId})]);
  await c.query("SELECT pg_notify('compel_engine_wake','')");await c.query('COMMIT');
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
};
