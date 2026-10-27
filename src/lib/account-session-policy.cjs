'use strict';
const {createHash,randomInt}=require('node:crypto');
const DAY=86400000;
const DEFAULTS=Object.freeze({warmupDays:4,warmupProfilesPerDay:10,rampStepDays:7,recoveryDays:7,minIntervalSeconds:60,maxIntervalSeconds:150,staggerSeconds:120,renderEvery:10});
const integer=(value,name,min,max)=>{if(!Number.isInteger(value)||value<min||value>max)throw Error(`${name} must be ${min}–${max}.`);return value;};
function config(input={}){
 const result={...DEFAULTS,...input};
 for(const key of Object.keys(result))if(!(key in DEFAULTS))throw Error('Unknown session policy setting: '+key);
 for(const key of ['warmupDays','rampStepDays','recoveryDays'])integer(result[key],key,1,90);
 integer(result.warmupProfilesPerDay,'warmupProfilesPerDay',1,20);
 integer(result.minIntervalSeconds,'minIntervalSeconds',60,3600);integer(result.maxIntervalSeconds,'maxIntervalSeconds',result.minIntervalSeconds,3600);
 integer(result.staggerSeconds,'staggerSeconds',0,120);integer(result.renderEvery,'renderEvery',1,100);
 return result;
}
function fingerprint(probe,metadata={}){
 if(!probe||!['userAgent','platform','timezone','locale'].every(k=>typeof probe[k]==='string'&&probe[k])||!Number.isInteger(probe.screen?.width)||!Number.isInteger(probe.screen?.height))throw Error('Browser identity probe is incomplete.');
 const fields={profileId:metadata.profileId,engine:metadata.engine,mode:metadata.mode,proxyId:metadata.proxyId,revision:metadata.revision,
  userAgent:probe.userAgent,platform:probe.platform,screen:{width:probe.screen.width,height:probe.screen.height},timezone:probe.timezone,locale:probe.locale,
  hardwareConcurrency:probe.hardwareConcurrency??null,deviceMemory:probe.deviceMemory??null,webglVendor:probe.webglVendor??null,webglRenderer:probe.webglRenderer??null};
 return {hash:createHash('sha256').update(JSON.stringify(fields)).digest('hex'),fields};
}
function evidenceKey(account){return createHash('sha256').update(JSON.stringify([account.aliasmode_profile_id,Number(account.binding_revision||0),Number(account.session_revision||0),account.engine,account.launch_mode,account.proxy_id])).digest('hex');}
function localDay(now,timezone='UTC'){return new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));}
function dayNumber(day){return Math.floor(Date.parse(day+'T00:00:00Z')/DAY);}
function lifecycle(account,{now=Date.now(),day=localDay(now,account.proxy_timezone||'UTC')}={}){
 const p=config(account.session_policy),e=account.session_evidence||{},key=evidenceKey(account);
 if(account.attention_reason)return {state:'HOLD',reason:account.attention_reason};
 if(!account.proxy_id||!account.proxy_host||!account.proxy_port||!account.proxy_country||!account.proxy_timezone)return {state:'PROVISION',reason:'Configure a dedicated proxy in AliasMode and save its binding in CompelOS.'};
 if(e.network?.verdict!=='PASS'||e.network.key!==key)return {state:'PROVISION',reason:'Run the bound profile’s network preflight; proxy identity and geography are not verified.'};
 if(e.drift)return {state:'HOLD',reason:'Browser identity changed. Review the stored baseline and current observations.'};
 if(!e.fingerprint?.hash)return {state:'PROVISION',reason:'Capture and explicitly approve this profile’s browser identity baseline.'};
 if(e.gate?.verdict!=='PASS'||e.gate.key!==key||e.gate.fingerprintHash!==e.fingerprint.hash)return {state:'PROVISION',reason:'The diagnostic gate is missing, stale, failed or incomplete. Open its evidence report.'};
 const recovery=Date.parse(e.recoveryUntil);
 if(Number.isFinite(recovery)&&recovery>now)return {state:'RECOVERY',reason:'Human review was completed; the recovery period has not elapsed.',resumeAt:new Date(recovery).toISOString()};
 const warmupDays=[...new Set(e.warmupDays||[])],first=warmupDays[0];
 if(!first||warmupDays.length<p.warmupDays||dayNumber(day)-dayNumber(first)<p.warmupDays)return {state:'WARMUP',reason:'Rendered-only warmup; qualification jobs remain queued.',done:warmupDays.length,required:p.warmupDays,limit:Math.min(account.daily_limit,p.warmupProfilesPerDay)};
 const start=e.rampStartedAt||e.recoveryUntil||new Date(now).toISOString();
 const step=Math.max(0,Math.floor((now-Date.parse(start))/(p.rampStepDays*DAY))),cap=[15,30,60,100][Math.min(step,3)];
 return {state:step<4?'RAMP':'PROCESSING',reason:'Session prerequisites satisfied.',limit:Math.min(account.daily_limit,cap),rampStartedAt:start};
}
function interval(policy={},random=randomInt){const p=config(policy);return random(p.minIntervalSeconds,p.maxIntervalSeconds+1)*1000;}
function networkVerdict(observed,account){
 const country=String(observed?.country||'').toUpperCase(),timezone=observed?.timezone;
 if(!observed?.ip||!require('node:net').isIP(observed.ip)||!country||!timezone)return {verdict:'UNKNOWN',reason:'Network response lacks an IP, country or timezone.'};
 if(!account.proxy_id||!account.proxy_host||!account.proxy_port)return {verdict:'FAIL',reason:'No dedicated AliasMode proxy is bound.'};
 if(observed.datacenter===true||observed.rotating===true)return {verdict:'FAIL',reason:'Preflight reported a datacenter or rotating connection.'};
 if(country!==account.proxy_country||timezone!==account.proxy_timezone)return {verdict:'FAIL',reason:'Observed network country/timezone differs from the bound proxy.'};
 if(!account.session_evidence?.expectedExitIp)return {verdict:'UNKNOWN',reason:'Save the dedicated proxy’s expected exit IP from your provider.'};
 if(observed.ip!==account.session_evidence.expectedExitIp)return {verdict:'FAIL',reason:'Observed exit IP differs from the dedicated proxy binding.'};
 return {verdict:'PASS',ip:observed.ip,country,timezone,key:evidenceKey(account)};
}
module.exports={DEFAULTS,config,fingerprint,evidenceKey,lifecycle,localDay,interval,networkVerdict};
