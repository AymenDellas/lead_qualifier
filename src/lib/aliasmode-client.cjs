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
function createAliasModeClient({config={},fetch:fetcher=globalThis.fetch,timeoutMs=10000}={}){
 // Bound local control work without delaying LinkedIn requests.
 const queue=require('./bounded-work.cjs').createBoundedQueue({capacity:16,concurrency:2});
 async function requestNow(path,{timeout=timeoutMs}={}){
  const settings=typeof config==='function'?await config():config,origin=baseUrl(settings.baseUrl);
  let response,data;try{
   response=await fetcher(origin+path,{method:'GET',redirect:'error',signal:AbortSignal.timeout(timeout),headers:{accept:'application/json'}});
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
 async function start(id){
  // AliasMode owns launch mode. Its current API does not expose a per-profile
  // headless switch; passing --headless through launch_args is unsupported.
  const data=await request('/api/v1/browser/start?'+new URLSearchParams({user_id:profileId(id)}),{timeout:120000});
  return {active:true,headless:null,endpoint:websocket(data.ws?.puppeteer)};
 }
 async function list(){let profiles=[],truncated=false;for(let page=1;page<=2;page++){const data=await request('/api/v1/user/list?'+new URLSearchParams({page:String(page),page_size:'100'}));if(!Array.isArray(data.list))throw providerError('ALIASMODE_API_RESPONSE','AliasMode did not return a supported profile list.');profiles.push(...data.list.map(publicProfile).filter(Boolean));if(data.list.length<100)break;if(page===2)truncated=true;}return {profiles:[...new Map(profiles.map(p=>[p.id,p])).values()],truncated};}
 return {health:()=>request('/status'),list,active,start,stop:async id=>{await request('/api/v1/browser/stop?user_id='+encodeURIComponent(profileId(id)),{timeout:90000});},idle:queue.idle,request};
}
module.exports={createAliasModeClient,baseUrl,profileId,websocket,publicProfile,providerError};
