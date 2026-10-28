'use strict';
const providerError=(code,message)=>Object.assign(new Error(message),{code,failure:{stage:'provider',code,reason:message,retryable:true}});
function baseUrl(value='http://127.0.0.1:50400'){
 let url;try{url=new URL(value);}catch{throw providerError('ALIASMODE_ADDRESS','Enter the local AliasMode API address.');}
 if(!['http:','https:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw providerError('ALIASMODE_ADDRESS','AliasMode must use a loopback HTTP(S) address without credentials or a path.');
 return url.origin;
}
function profileId(value){if(typeof value!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(value))throw providerError('ALIASMODE_PROFILE_ID','Enter the immutable AliasMode profile ID.');return value;}
function websocket(value){
 let url;try{url=new URL(value);}catch{throw providerError('ALIASMODE_CDP_ENDPOINT','AliasMode did not return a valid browser connection.');}
 if(!['ws:','wss:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!url.port||url.username||url.password||url.search||url.hash||!/^\/devtools\/browser\/[a-zA-Z0-9_-]+$/.test(url.pathname))throw providerError('ALIASMODE_CDP_ENDPOINT','AliasMode returned a non-local or unsupported browser connection.');
 return url.href;
}
function publicProfile(value){
 const id=value?.user_id||value?.profile_id;try{profileId(id);}catch{return null;}
 // The vendor's list response can include passwords/proxy credentials. Never
 // persist, log or forward the raw response; select only public identifiers.
 return {id,name:String(value.name||id).replace(/[\u0000-\u001f]/g,'').slice(0,120),group:String(value.group_name||'').slice(0,120),number:String(value.serial_number||value.profile_no||'').slice(0,32)};
}
function createAliasModeClient({config={},fetch:fetcher=globalThis.fetch,timeoutMs=10000,cli}={}){
 // Bound local control work without delaying LinkedIn requests.
 const queue=require('./bounded-work.cjs').createBoundedQueue({capacity:16,concurrency:2});
 const helper=cli||require('./aliasmode-cli.cjs').createAliasModeCli();
 async function requestNow(path,{timeout=timeoutMs,method='GET',body}={}){
  const settings=typeof config==='function'?await config():config,origin=baseUrl(settings.baseUrl);
  let response,data;try{
   response=await fetcher(origin+path,{method,redirect:'error',signal:AbortSignal.timeout(timeout),headers:{accept:'application/json',...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
   if([401,403].includes(response.status))throw providerError('ALIASMODE_API_AUTH','AliasMode rejected local access. Check its loopback API settings.');
   if(response.status===429)throw providerError('ALIASMODE_API_BUSY','AliasMode Local API is busy. The agent will retry without reading LinkedIn.');
   if(!response.ok)throw providerError('ALIASMODE_API_HTTP','AliasMode Local API returned HTTP '+response.status+'. Check the local client.');
   const reader=response.body?.getReader();if(reader){const parts=[];let size=0;for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>1024*1024){await reader.cancel();throw providerError('ALIASMODE_API_RESPONSE','AliasMode response exceeded the bounded size.');}parts.push(Buffer.from(value));}data=JSON.parse(Buffer.concat(parts).toString('utf8'));}else data=await response.json();
  }catch(error){if(error.failure?.stage==='provider')throw error;throw providerError('ALIASMODE_UNAVAILABLE','Cannot reach the AliasMode Local API. Open AliasMode, enable Local API, and check its address and permissions.');}
  if(data?.code!==0){
   const message=String(data?.msg||'');
   const code=/teardown unconfirmed/i.test(message)?'ALIASMODE_STOP_PENDING':/unsafe launch_args|mode_conflict/i.test(message)?'ALIASMODE_MODE_UNSUPPORTED':/no such profile|unknown profile/i.test(message)?'ALIASMODE_PROFILE_MISSING':'ALIASMODE_API_REJECTED';
   const reason=code==='ALIASMODE_STOP_PENDING'?'AliasMode has not confirmed profile closure. Check that profile before reopening.':code==='ALIASMODE_MODE_UNSUPPORTED'?'AliasMode rejected the browser launch mode. Use its configured browser mode.':code==='ALIASMODE_PROFILE_MISSING'?'The linked AliasMode profile no longer exists. Refresh profiles and review the binding.':'AliasMode rejected the local request. Check the profile and Local API in AliasMode.';
   throw providerError(code,reason);
  }
  return data.data||{};
 }
 async function request(path,options){return (await queue.submit(()=>requestNow(path,options))).done;}
 async function active(id){
  const data=await request('/api/v1/browser/active?user_id='+encodeURIComponent(profileId(id)));
  if(['starting','stopping','uncertain'].includes(data.lifecycle))throw providerError('ALIASMODE_LIFECYCLE_'+data.lifecycle.toUpperCase(),'AliasMode reports this profile as '+data.lifecycle+'. Confirm its lifecycle in AliasMode; no replacement browser will be started.');
  if(!['Active','Inactive'].includes(data.status)||data.lifecycle&&data.lifecycle!=='running')throw providerError('ALIASMODE_API_RESPONSE','AliasMode returned an unknown profile state.');
  if(data.lifecycle==='running'&&data.status!=='Active')throw providerError('ALIASMODE_API_RESPONSE','AliasMode returned conflicting profile lifecycle evidence.');
  return {active:data.status==='Active',...(data.status==='Active'?{endpoint:websocket(data.ws?.puppeteer)}:{})};
 }
 async function inspect(id){
  const state=await active(id);if(!state.active)return state;
  const mode=await helper.status(id),again=await active(id);
  if(!mode.running||mode.state!=='running'||!again.active||again.endpoint!==state.endpoint||Number(new URL(state.endpoint).port)!==mode.port)throw providerError('ALIASMODE_INSTANCE_CHANGED','AliasMode CLI and Local API did not confirm the same running browser. Check the API address and profile before retrying.');
  return {...state,headless:mode.headless};
 }
 async function start(id,{headless=true}={}){
  if((await active(id)).active)throw providerError('ALIASMODE_PROFILE_BUSY','The profile is already open. Reconcile its mode before starting.');
  const opened=await helper.open(id,{headless});
  try{
   const state=await inspect(id);
   if(!state.active||state.headless!==headless||Number(new URL(state.endpoint).port)!==opened.port)throw providerError('ALIASMODE_MODE_UNVERIFIED','AliasMode did not confirm the requested browser mode. Check its runtime before retrying.');
   return state;
  }catch(error){error.startedProfilePort=opened.port;throw error;}
 }
 async function list(){let profiles=[],truncated=false;for(let page=1;page<=2;page++){const data=await request('/api/v1/user/list?'+new URLSearchParams({page:String(page),page_size:'100'}));if(!Array.isArray(data.list))throw providerError('ALIASMODE_API_RESPONSE','AliasMode did not return a supported profile list.');profiles.push(...data.list.map(publicProfile).filter(Boolean));if(data.list.length<100)break;if(page===2)truncated=true;}return {profiles:[...new Map(profiles.map(p=>[p.id,p])).values()],truncated};}
 async function createProfile({name,engine='aliasmode-chromium'}){
  if(typeof name!=='string'||!name.trim()||name.length>80||!['aliasmode-chromium','cloakbrowser'].includes(engine))throw providerError('ALIASMODE_PROFILE_CONFIG','Enter a profile name and supported Chromium engine.');
  const result=await request('/api/v1/user/create',{method:'POST',body:{name:name.trim(),engine:'chromium',chromium_runtime:engine==='aliasmode-chromium'?'aliasmode':'cloakbrowser',fingerprint_config:{screen_resolution:'1920_1080'}}});
  return {id:profileId(result.id),name:name.trim(),engine};
 }
 return {health:()=>request('/status'),capabilities:async()=>({helperVersion:await helper.version(),headless:true}),createProfile,list,active,inspect,start,stop:async id=>{await request('/api/v1/browser/stop?user_id='+encodeURIComponent(profileId(id)),{timeout:90000});},idle:async()=>{await helper.idle();await queue.idle();},request};
}
module.exports={createAliasModeClient,baseUrl,profileId,websocket,publicProfile,providerError};
