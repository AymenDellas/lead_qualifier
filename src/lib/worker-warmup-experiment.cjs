'use strict';
// One explicitly authorized experiment, not a general processing-policy bypass.
const {randomUUID,randomInt}=require('node:crypto');
const ID='john-rendered-warmup-20261028-20',PROFILE='k1ierfk4',COUNT=20,COMMAND='warmup-experiment';
const terminal=state=>!['WARMUP_PREPARED','WARMUP_AUTHORIZED','WARMUP_RUNNING'].includes(state);
const problem=(reason,code='WARMUP_STOPPED')=>Object.assign(Error(reason),{code});
async function load(pool){return (await pool.query('SELECT * FROM compel_engine_batches WHERE id=$1',[ID])).rows[0]||null;}
async function prepare(pool,profiles,source={}){
 const core=require('./linkedin-workers.cjs');await core.ensure(pool);await pool.query(require('../../scripts/engine-benchmark.cjs').BATCH_SCHEMA);
 if(!Array.isArray(profiles)||profiles.length!==COUNT||new Set(profiles).size!==COUNT||profiles.some(u=>core.profileUrl(u)!==u))throw Error('This authorization requires exactly 20 distinct canonical profiles.');
 const existing=await load(pool);if(existing)return existing;
 const a=(await pool.query('SELECT * FROM compel_linkedin_accounts WHERE aliasmode_profile_id=$1 AND NOT archived',[PROFILE])).rows[0];
 if(!a||!a.enabled||a.processing_enabled||a.login_requested_at||a.logout_requested_at||a.close_requested_at||a.session_evidence?.command)throw Error('John must be enabled, paused, and free of other pending commands.');
 const report={kind:COMMAND,authorizationId:ID,profileId:PROFILE,accountId:a.id,maxProfiles:COUNT,bindingRevision:Number(a.binding_revision),sessionRevision:Number(a.session_revision),mode:a.launch_mode,initialHold:a.attention_reason,humanHealthyReview:true,
  waivers:['proxy','detector','recovery','ten-profile-warmup-ceiling'],visits:[],attempts:[],scriptedQualificationRequests:0,traffic:{total:0,nativeVoyager:0,security:[]},source};
 await pool.query("INSERT INTO compel_engine_batches(id,account_id,profiles,state,requested_count,report) VALUES($1,$2,$3,'WARMUP_PREPARED',20,$4::jsonb) ON CONFLICT DO NOTHING",[ID,a.id,profiles,JSON.stringify(report)]);return load(pool);
}
async function start(pool){
 const c=await pool.connect();try{await c.query('BEGIN');
  const b=await load(c);if(!b||b.state!=='WARMUP_PREPARED')throw Error('This one-time experiment is already active or finished. It cannot be re-armed.');
  const a=(await c.query('SELECT * FROM compel_linkedin_accounts WHERE id=$1 FOR UPDATE',[b.account_id])).rows[0];
  if(a.aliasmode_profile_id!==PROFILE||a.processing_enabled||a.attention_reason!==b.report.initialHold||a.login_requested_at||a.close_requested_at||a.session_evidence?.command)throw Error('Account controls/hold changed after preparation.');
  const p=require('./account-session-policy.cjs').config(a.session_policy),stagger=randomInt(0,p.staggerSeconds+1);
  const row=(await c.query(`UPDATE compel_linkedin_accounts SET session_evidence=session_evidence||jsonb_build_object('command',$2::text,'warmupExperimentId',$3::text),changed_at=clock_timestamp() WHERE id=$1 RETURNING changed_at::text AS version`,[a.id,COMMAND,ID])).rows[0];
  await c.query(`UPDATE compel_engine_batches SET state='WARMUP_AUTHORIZED',started_at=clock_timestamp(),report=report||jsonb_build_object('controlVersion',$2::text,'expiresAt',clock_timestamp()+interval '90 minutes','notBefore',clock_timestamp()+($3*interval '1 second')) WHERE id=$1`,[ID,row.version,stagger]);
  await c.query("INSERT INTO compel_worker_events(account_id,kind,message,data) VALUES($1,'warmup_authorized','User authorized one rendered-only, 20-profile warmup exception; normal qualification remains paused.',$2::jsonb)",[a.id,JSON.stringify({experimentId:ID,waivers:b.report.waivers})]);
  await c.query("SELECT pg_notify('compel_engine_wake','')");await c.query('COMMIT');return await load(c);
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
async function authority(client,{accountId,owner,version,profileUrl,jobId,initial=false,lock=false}){
 const b=(await client.query(`SELECT b.*,a.aliasmode_profile_id,a.binding_revision,a.session_revision,a.launch_mode,a.changed_at::text AS control_version,a.attention_reason,a.processing_enabled,a.enabled,a.archived,a.login_requested_at,a.logout_requested_at,a.close_requested_at,a.session_evidence,c.active_count,clock_timestamp() AS db_now
  FROM compel_linkedin_accounts a JOIN compel_worker_sessions s ON s.account_id=a.id JOIN compel_engine_batches b ON b.account_id=a.id CROSS JOIN compel_worker_config c
  WHERE a.id=$1 AND b.id=$2 AND s.owner=$3 AND s.lease_until>NOW() AND c.id=1`+(lock?' FOR UPDATE OF b':''),[accountId,ID,owner])).rows[0];
 const r=b?.report;
 if(!b||terminal(b.state)||r.authorizationId!==ID||r.profileId!==PROFILE||b.aliasmode_profile_id!==PROFILE||r.maxProfiles!==COUNT||b.profiles.length!==COUNT||Number(b.binding_revision)!==r.bindingRevision||Number(b.session_revision)!==r.sessionRevision||b.launch_mode!==r.mode)throw problem('Warmup authorization, binding or ownership changed.');
 if(typeof version!=='string'||version!==r.controlVersion||b.control_version!==version||b.session_evidence?.command!==COMMAND||b.session_evidence?.warmupExperimentId!==ID||b.processing_enabled||!b.enabled||b.archived||b.login_requested_at||b.logout_requested_at||b.close_requested_at||b.active_count<=0)throw problem('Warmup paused or its account controls changed.');
 if(new Date(b.db_now)>=new Date(r.expiresAt))throw problem('The 90-minute warmup authorization expired.');
 if(b.attention_reason&&!(initial&&!r.identity&&r.humanHealthyReview&&b.attention_reason===r.initialHold))throw problem(b.attention_reason,'ACCOUNT_REVIEW');
 if(r.owner&&r.owner!==owner)throw problem('The experiment was interrupted by an agent restart; no profile is reread automatically.');
 if(profileUrl&&(!r.identity||r.attempts.length>=COUNT||!b.profiles.includes(profileUrl)||r.attempts.some(x=>x.url===profileUrl)||r.inFlight?.url!==profileUrl||r.inFlight?.jobId!==jobId))throw problem('This profile is outside the remaining warmup authorization.');
 return b;
}
async function reserved(client,b,{profileUrl,jobId}){
 const at=(await client.query('SELECT clock_timestamp() AS at')).rows[0].at;
 const locked=await client.query(`UPDATE compel_worker_jobs SET checkpoint=checkpoint||$4::jsonb WHERE id=$1 AND owner=$2 AND status='processing' AND lease_until>NOW() AND payload->>'warmupExperimentId'=$3 RETURNING id`,[jobId,b.report.owner,ID,JSON.stringify({stage:'NAVIGATING',reservedAt:at})]);
 if(!locked.rowCount)throw problem('The canonical warmup job lock changed before reservation.');
 await client.query(`UPDATE compel_engine_batches SET report=report||$2::jsonb WHERE id=$1`,[ID,JSON.stringify({attempts:[...b.report.attempts,{url:profileUrl,jobId,startedAt:at}],inFlight:{url:profileUrl,jobId,stage:'NAVIGATING'}})]);
}
async function cancel(pool,reason='The operator stopped the warmup experiment.'){
 const b=await load(pool);if(!b||terminal(b.state))return b;
 await pool.query("UPDATE compel_linkedin_accounts SET session_evidence=session_evidence-'command',changed_at=clock_timestamp() WHERE id=$1 AND session_evidence->>'command'=$2 AND session_evidence->>'warmupExperimentId'=$3",[b.account_id,COMMAND,ID]);
 await pool.query("SELECT pg_notify('compel_engine_wake','')");return {...b,cancelReason:reason};
}
function create({pool,accountId,owner,core,guard,now=Date.now,rendered=require('./linkedin-browser-page.cjs'),human=require('./session-humanizer.cjs'),probe=require('./stealth-self-test.cjs').probe}){
 const policy=require('./account-session-policy.cjs'),session=require('./linkedin-session-policy.cjs');
 let verifiedPage=null,claimed=null,traffic={total:0,nativeVoyager:0,security:[],pages:[],serverErrors:[],requestFailures:[]},watched=null,identity=null,lastAction='admission',lastNavigation=null;
 const route=value=>{try{const u=new URL(value);return /(^|\.)(linkedin\.com|licdn\.com)$/.test(u.hostname)?{host:u.hostname,path:u.pathname.slice(0,240)}:null;}catch{return null;}};
 const bounded=(items,value,limit=20)=>{items.push(value);if(items.length>limit)items.shift();};
 const currentRoute=()=>{try{return route(watched?.url?.());}catch{return null;}};
 const cleanError=e=>String(e?.failure?.reason||e?.message||e).replace(/(?:wss?|postgres(?:ql)?):\/\/\S+/gi,'[local connection]').replace(/https?:\/\/[^\s]+/gi,raw=>{try{const u=new URL(raw);return u.origin+u.pathname;}catch{return '[page URL]';}}).slice(0,1200);
 async function active(a,initial=false){return authority(pool,{accountId,owner,version:a.control_version,initial});}
 async function write(patch){const r=await pool.query(`UPDATE compel_engine_batches b SET report=report||$2::jsonb WHERE id=$1 AND report->>'owner'=$3 AND state IN ('WARMUP_AUTHORIZED','WARMUP_RUNNING') AND EXISTS(SELECT 1 FROM compel_worker_sessions s WHERE s.account_id=b.account_id AND s.owner=$3 AND s.lease_until>NOW())`,[ID,JSON.stringify(patch),owner]);if(!r.rowCount)throw problem('Warmup evidence ownership changed.');return r;}
 async function releaseJob(){if(claimed){await pool.query(`UPDATE compel_worker_jobs j SET status='cancelled',completed_at=NOW(),owner=NULL,account_id=NULL,lease_until=NULL,result=$4::jsonb WHERE id=$1 AND owner=$2 AND payload->>'warmupExperimentId'=$3 AND EXISTS(SELECT 1 FROM compel_worker_sessions s WHERE s.account_id=j.account_id AND s.owner=$2 AND s.lease_until>NOW())`,[claimed.jobId,owner,ID,JSON.stringify({status:'WARMUP_ONLY',url:claimed.url,reason:'Qualification was not requested; only the warmup lock is released.'})]);claimed=null;}}
 async function stop(reason,state='WARMUP_STOPPED'){
  const old=await load(pool);if(!old||terminal(old.state))return {done:true,reason:old?.report?.reason||reason,state:old?.state||state};
  await releaseJob();
  await pool.query(`UPDATE compel_worker_jobs SET status='cancelled',completed_at=NOW(),result=jsonb_build_object('status','WARMUP_ONLY','reason',$3::text) WHERE status='pending' AND payload->>'warmupExperimentId'=$1 AND EXISTS(SELECT 1 FROM compel_worker_sessions s WHERE s.account_id=$4 AND s.owner=$2 AND s.lease_until>NOW())`,[ID,owner,reason,accountId]);
  await pool.query(`UPDATE compel_engine_batches b SET state=$2,finished_at=NOW(),report=report||$4::jsonb WHERE id=$1 AND state IN ('WARMUP_AUTHORIZED','WARMUP_RUNNING') AND EXISTS(SELECT 1 FROM compel_worker_sessions s WHERE s.account_id=b.account_id AND s.owner=$3 AND s.lease_until>NOW())`,[ID,state,owner,JSON.stringify({traffic,reason,lastAction,finalPage:currentRoute(),lastNavigation,endedAt:new Date(now()).toISOString()})]);
  await pool.query(`UPDATE compel_linkedin_accounts a SET session_evidence=session_evidence-'command' WHERE id=$1 AND session_evidence->>'command'=$2 AND session_evidence->>'warmupExperimentId'=$3 AND EXISTS(SELECT 1 FROM compel_worker_sessions s WHERE s.account_id=a.id AND s.owner=$4 AND s.lease_until>NOW())`,[accountId,COMMAND,ID,owner]);
  await pool.query("SELECT pg_notify('compel_engine_wake','')");return {done:true,reason,state};
 }
 function observe(page){
  if(watched===page)return;watched=page;lastNavigation=null;
  page.on?.('request',r=>{if(watched!==page)return;try{const u=new URL(r.url());if(route(u.href)){traffic.total++;if(u.pathname.startsWith('/voyager/api/'))traffic.nativeVoyager++;}}catch{}});
  page.on?.('response',r=>{
   if(watched!==page)return;
   try{
    const target=route(r.url());if(!target)return;
    const request=r.request(),entry={status:r.status(),...target,type:request.resourceType()};
    if([401,403,429,999].includes(entry.status))bounded(traffic.security,entry);
    if(entry.status>=500&&entry.status<=599)bounded(traffic.serverErrors,entry);
    if(request.isNavigationRequest?.()&&r.frame?.()===page.mainFrame?.()){
     lastNavigation={...entry,redirectedFrom:(request.redirectChain?.()||[]).slice(-8).map(q=>route(q.url())).filter(Boolean)};
     bounded(traffic.pages,lastNavigation);
    }
   }catch{/* A closing/replaced target cannot invalidate earlier evidence. */}
  });
  page.on?.('requestfailed',r=>{if(watched!==page)return;try{const target=route(r.url());if(!target)return;const text=String(r.failure?.()?.errorText||'');bounded(traffic.requestFailures,{...target,error:/^(?:net::)?ERR_[A-Z_]+$/.test(text)?text:'REQUEST_FAILED'},10);}catch{}});
 }
 function confirmDestination(page,url){
  require('./linkedin-page-health.cjs').assertProfile(page.url(),url,lastNavigation?.status||0);
 }
 async function step(a,{open,assertSignal,onSignal,inspect,adopt=async()=>{}}){
  try{
   lastAction='admission';
   let b=await active(a,true);if(new Date(b.report.notBefore)>new Date(b.db_now))return {wait:true,at:b.report.notBefore,code:'LANE_STAGGER',reason:'Authorized warmup start is staggered.'};
   if(!b.report.owner){await pool.query("UPDATE compel_engine_batches SET state='WARMUP_RUNNING',report=report||$2::jsonb WHERE id=$1 AND state='WARMUP_AUTHORIZED'",[ID,JSON.stringify({owner})]);b=await active(a,true);}
   if(b.report.inFlight)throw problem('A previous navigation was interrupted. Its checkpoint is retained; no profile is reread.');
   const assertActive=async(initial=false)=>{await assertSignal();return active(a,initial);};
   await assertActive(true);lastAction='browser_open';const surface=await open(a.launch_mode==='headless'),page=surface.page;observe(page);
   if(verifiedPage!==page){
    await assertActive(true);lastAction='feed_navigation';const response=await page.goto('https://www.linkedin.com/feed/',{waitUntil:'domcontentloaded',timeout:30000});await assertActive(true);lastAction='feed_inspection';await inspect(response);
    lastAction='identity_verification';
    const found=await rendered.readSignedInIdentity(page,{leaveMenuOpen:true,beforeCheck:()=>assertActive(true)});
    await assertActive(true);await inspect();if(!session.isFeed(page.url())||!found||!a.confirmed_identity||!session.sameMember(a.confirmed_identity,found))throw Object.assign(problem('The rendered feed did not confirm John’s saved identity.','ACCOUNT_MISMATCH'),{failure:{stage:'linkedin',code:'ACCOUNT_MISMATCH',reason:'The rendered feed did not confirm John’s saved identity.',retryable:false}});
    await core.confirmManualSignIn(pool,accountId,owner,found);
    try{await assertSignal();}catch(e){if(e.failure?.stage==='linkedin')await core.pauseProcessing(pool,accountId,e.failure.reason,true,owner);throw e;}
    await assertActive();identity=found;await adopt();
    const current=await core.readRuntimeAccount(pool,accountId);if(current.session_evidence?.fingerprint&&guard&&!await guard.verify(current,page))throw problem('Browser identity drift requires review.','ACCOUNT_REVIEW');
    if(page.url()!=='https://www.linkedin.com/feed/'){await page.goto('https://www.linkedin.com/feed/',{waitUntil:'domcontentloaded',timeout:30000});await assertActive();await inspect();}
    lastAction='identity_baseline';const fingerprint=policy.fingerprint(await probe(page),{profileId:a.aliasmode_profile_id,engine:a.engine,mode:a.launch_mode,proxyId:a.proxy_id,revision:Number(a.session_revision)});
    if(b.report.fingerprint&&b.report.fingerprint.hash!==fingerprint.hash)throw Object.assign(problem('Browser fingerprint changed during the experiment.','FINGERPRINT_DRIFT'),{failure:{stage:'linkedin',code:'FINGERPRINT_DRIFT',reason:'Browser fingerprint changed during the experiment.',retryable:false}});
    await write({identity:found,fingerprint,traffic});verifiedPage=page;
   }
   lastAction='profile_claim';b=await assertActive();if(b.report.attempts.length>=COUNT)return stop('Twenty authorized rendered profile starts completed.','WARMUP_COMPLETE');
   const url=b.profiles[b.report.attempts.length],jobId='warmup_'+randomUUID(),c=await pool.connect();
   try{await c.query('BEGIN');await c.query('SELECT id FROM compel_linkedin_accounts WHERE id=$1 FOR UPDATE',[accountId]);b=await authority(c,{accountId,owner,version:a.control_version,lock:true});
    const inserted=await c.query(`INSERT INTO compel_worker_jobs(id,profile_key,payload,status,account_id,owner,lease_until,checkpoint) VALUES($1,$2,$3::jsonb,'processing',$4,$5,NOW()+interval '15 minutes',$6::jsonb) ON CONFLICT DO NOTHING RETURNING id`,[jobId,url,JSON.stringify({jobId,linkedinUrl:url,warmupExperimentId:ID,nativePostProcess:false}),accountId,owner,JSON.stringify({warmupExperimentId:ID,url,stage:'RESERVING'})]);
    if(!inserted.rowCount)throw problem('Another job owns the selected canonical profile; duplicate protection stopped the test.');
    await c.query('UPDATE compel_engine_batches SET job_ids=array_append(job_ids,$2),report=report||$3::jsonb WHERE id=$1',[ID,jobId,JSON.stringify({inFlight:{url,jobId,stage:'RESERVING'}})]);await c.query('COMMIT');claimed={url,jobId};
   }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
   lastAction='profile_reservation';const reservation=await core.reserveProfile(pool,{accountId,owner,profileUrl:url,jobId,version:a.control_version,warmupExperimentId:ID});
   if(reservation.paced){await releaseJob();await write({inFlight:null});return {wait:true,at:reservation.resumeAt,code:'PROFILE_INTERVAL',reason:'Waiting for the account’s normal profile interval.'};}
   if(reservation.limited||reservation.stopped)throw problem(reservation.reason||'The normal daily profile ceiling stopped the experiment.');
   await assertActive();lastAction='profile_navigation';const response=await human.visit(page,url,{assertActive:()=>assertActive()});
   lastAction='profile_inspection';await inspect(response);await assertActive();confirmDestination(page,url);
   lastAction='profile_interaction';await human.interact(page,{assertActive:()=>assertActive()});
   lastAction='profile_final_inspection';await inspect();await assertActive();confirmDestination(page,url);
   b=await active(a);const visits=[...b.report.visits,{url,jobId,at:new Date(now()).toISOString()}];
   lastAction='visit_save';await write({visits,inFlight:null,traffic,lastVisited:url,lastAction,finalPage:currentRoute(),lastNavigation});await releaseJob();await core.recordLinkedInChecks(pool,accountId,owner,{profile_page:1});
   if(visits.length===COUNT)return stop('Twenty authorized rendered visits completed; normal qualification remains paused.','WARMUP_COMPLETE');
   return {wait:true,at:reservation.nextProfileAt,code:'PROFILE_INTERVAL',visits:visits.length,identity,reason:`Rendered warmup ${visits.length}/${COUNT}; no qualification API reads or CRM decisions.`};
  }catch(error){
   // A freshly observed signal is never reconciled as the saved pre-test hold.
   if(error.failure?.stage==='linkedin')await onSignal(error.failure);
   const result=await stop(cleanError(error));const current=await core.readRuntimeAccount(pool,accountId);return {...result,held:!!current?.attention_reason};
  }
 }
 return {step,stop};
}
module.exports={ID,PROFILE,COUNT,COMMAND,prepare,start,load,authority,reserved,cancel,create};
