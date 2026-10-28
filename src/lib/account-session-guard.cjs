'use strict';
const policy=require('./account-session-policy.cjs'),store=require('./account-session-store.cjs'),diagnostics=require('./stealth-self-test.cjs');
function createSessionGuard({pool,owner,core,now=Date.now,checks=diagnostics}={}){
 const metadata=a=>({profileId:a.aliasmode_profile_id,engine:a.engine,mode:a.launch_mode,proxyId:a.proxy_id,revision:Number(a.session_revision)});
 const observedFingerprint=async(a,page)=>policy.fingerprint(await checks.identityProbe(page,{assertActive:()=>active(a)}),metadata(a));
 async function active(a){if(!await core.sessionOwned(pool,a.id,owner))throw Error('Session ownership changed during diagnostics.');const current=await core.readRuntimeAccount(pool,a.id);if(!current||current.control_version!==a.control_version||Number(current.session_revision)!==Number(a.session_revision)||current.attention_reason)throw Error('Account paused, held or configuration changed during session work.');return current;}
 async function verify(a,page){
  await active(a);const observed=await observedFingerprint(a,page),baseline=a.session_evidence?.fingerprint;
  if(!baseline||observed.hash!==baseline.hash){
   const drift={before:baseline?.hash||null,after:observed.hash,fields:observed.fields,checkedAt:new Date(now()).toISOString()};
   await store.updateOwned(pool,a,owner,{drift});await core.pauseProcessing(pool,a.id,'Browser identity changed. Review and explicitly approve its new baseline before processing.',true,owner,a.control_version);return false;
  }
  return true;
 }
 async function command(a,page){
  const action=a.session_evidence?.command;await active(a);let patch={command:null,commandError:null};
  try{
   if(action==='preflight'){
    if(!a.proxy_id)throw Error('Configure the dedicated proxy in AliasMode and save its expected exit IP first.');
    const observed=await checks.network(page,{assertActive:()=>active(a)}),region=new Intl.DisplayNames('en',{type:'region'}).of(a.proxy_country);
    if(observed.country===region||observed.countryName===region)observed.country=a.proxy_country;
    const probe=await checks.probe(page);let verdict=policy.networkVerdict(observed,a);
    if(probe.timezone!==a.proxy_timezone)verdict={verdict:'FAIL',reason:'The browser timezone does not match the bound proxy timezone.'};
    patch.network={...verdict,observed,checkedAt:new Date(now()).toISOString()};patch.gate=null;patch.previousGate=a.session_evidence?.gate||null;
    if(verdict.verdict==='PASS'&&a.connected_at&&!a.session_evidence?.fingerprint){const fingerprint=await observedFingerprint(a,page);patch.fingerprint={...fingerprint,checkedAt:new Date(now()).toISOString()};}
   }else if(action==='approve-identity'){
    const fingerprint=await observedFingerprint(a,page);
    const baseline=a.session_evidence?.fingerprint,drift=a.session_evidence?.drift;
    if(baseline&&fingerprint.hash!==baseline.hash&&(!drift||drift.after!==fingerprint.hash)){
     await store.updateOwned(pool,a,owner,{command:null,drift:{before:baseline.hash,after:fingerprint.hash,fields:fingerprint.fields,checkedAt:new Date(now()).toISOString()}});
     await core.pauseProcessing(pool,a.id,'Browser identity changed. Inspect its stored previous/current values and complete manual review before explicitly approving a replacement baseline.',true,owner,a.control_version);return {held:true};
    }
    patch={...patch,fingerprint:{...fingerprint,checkedAt:new Date(now()).toISOString()},previousFingerprint:baseline||null,drift:null,...(!baseline||fingerprint.hash!==baseline.hash?{gate:null}:{})};
   }else if(action==='diagnostics'){
    if(a.session_evidence?.network?.verdict!=='PASS'||a.session_evidence.network.key!==policy.evidenceKey(a))throw Error('Complete network preflight before the detector battery.');
    if(!await verify(a,page))return {held:true};
    const gate=await checks.run(page,{assertActive:()=>active(a),now});
    patch.gate={...gate,reportId:require('node:crypto').randomUUID(),key:policy.evidenceKey(a),fingerprintHash:a.session_evidence.fingerprint.hash};
   }else throw Error('Unsupported diagnostic request.');
  }catch(error){patch.commandError=String(error.message).slice(0,600);}
  await active(a);return store.updateOwned(pool,a,owner,patch);
 }
 async function warmup(a,job,page,assertActive,inspect=async()=>{}){
  const day=a.daily_day||policy.localDay(now(),a.proxy_timezone),e=a.session_evidence||{},visits=e.warmupVisits||{},today=visits[day]||[];
  if(today.length>=policy.config(a.session_policy).warmupProfilesPerDay)return {done:true};
  if(today.includes(job.linkedinUrl))return {done:true};
  const reservation=await core.reserveProfile(pool,{accountId:a.id,owner,profileUrl:job.linkedinUrl,jobId:job.jobId,version:a.control_version});
  if(reservation.stopped||reservation.limited||reservation.paced)return {reservation};
  const response=await require('./session-humanizer.cjs').visit(page,job.linkedinUrl,{assertActive});await inspect(response);await assertActive();
  require('./linkedin-page-health.cjs').assertProfile(page.url(),job.linkedinUrl,response?.status?.()||0);
  await require('./session-humanizer.cjs').interact(page,{assertActive});await inspect();await assertActive();
  require('./linkedin-page-health.cjs').assertProfile(page.url(),job.linkedinUrl);
  const days=[...new Set([...(e.warmupDays||[]),day])].sort().slice(-90);
  await store.updateOwned(pool,a,owner,{warmupDays:days,warmupVisits:{...Object.fromEntries(Object.entries(visits).filter(([key])=>days.includes(key))),[day]:[...today,job.linkedinUrl]},warmupObservedAt:new Date(now()).toISOString()});
  return {visited:true,nextProfileAt:reservation.nextProfileAt};
 }
 return {state:a=>policy.lifecycle(a,{now:now(),...(a.daily_day?{day:a.daily_day}:{})}),command,verify,warmup,failCommand:async(a,error)=>{await active(a);return store.updateOwned(pool,a,owner,{command:null,commandError:String(error.message).slice(0,600)});},activateRamp:async a=>{
  const state=policy.lifecycle(a,{now:now(),...(a.daily_day?{day:a.daily_day}:{})});if(['RAMP','PROCESSING'].includes(state.state)&&!a.session_evidence.rampStartedAt)await store.updateOwned(pool,a,owner,{rampStartedAt:state.rampStartedAt});
 }};
}
module.exports={createSessionGuard};
