'use strict';
const providerError=(code,message)=>Object.assign(new Error(message),{code,failure:{stage:'provider',code,reason:message,retryable:true}});
function baseUrl(value='http://127.0.0.1:50325'){
 let url;try{url=new URL(value);}catch{throw providerError('ADSPOWER_ADDRESS','Enter the local AdsPower API address.');}
 if(!['http:','https:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw providerError('ADSPOWER_ADDRESS','AdsPower must use a loopback HTTP(S) address without credentials or a path.');
 return url.origin;
}
function profileId(value){if(typeof value!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(value))throw providerError('ADSPOWER_PROFILE_ID','Enter the immutable AdsPower profile ID.');return value;}
function websocket(value){
 let url;try{url=new URL(value);}catch{throw providerError('ADSPOWER_CDP_ENDPOINT','AdsPower did not return a valid browser connection.');}
 if(!['ws:','wss:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!url.port||url.username||url.password||url.search||url.hash||!/^\/devtools\/browser\/[a-zA-Z0-9_-]+$/.test(url.pathname))throw providerError('ADSPOWER_CDP_ENDPOINT','AdsPower returned a non-local or unsupported browser connection.');
 return url.href;
}
function publicProfile(value){
 const id=value?.user_id||value?.profile_id;try{profileId(id);}catch{return null;}
 // The vendor's list response can include passwords/proxy credentials. Never
 // persist, log or forward the raw response; select only public identifiers.
 return {id,name:String(value.name||id).replace(/[\u0000-\u001f]/g,'').slice(0,120),group:String(value.group_name||'').slice(0,120),number:String(value.serial_number||value.profile_no||'').slice(0,32)};
}
function createAdsPowerClient({config={},fetch:fetcher=globalThis.fetch,timeoutMs=10000,controlIntervalMs=500,now=Date.now}={}){
 // AdsPower documents two Local API calls/second for small installations. This
 // queue applies only to vendor control calls, never to LinkedIn page requests.
 const queue=require('./bounded-work.cjs').createBoundedQueue({capacity:16});let nextControlAt=0;
 async function requestNow(path,{method='GET',body}={}){
  const wait=nextControlAt-now();if(wait>0)await new Promise(resolve=>setTimeout(resolve,wait));nextControlAt=now()+controlIntervalMs;
  const settings=typeof config==='function'?await config():config,origin=baseUrl(settings.baseUrl);
  let response,data;try{
   response=await fetcher(origin+path,{method,redirect:'error',signal:AbortSignal.timeout(timeoutMs),headers:{accept:'application/json',...(body?{'content-type':'application/json'}:{}),...(settings.apiKey?{Authorization:'Bearer '+settings.apiKey}:{})},...(body?{body:JSON.stringify(body)}:{})});
   if([401,403].includes(response.status))throw providerError('ADSPOWER_API_AUTH','AdsPower API authentication failed. Update the API key in local profile settings.');
   if(response.status===429)throw providerError('ADSPOWER_API_BUSY','AdsPower Local API is busy. The agent will retry without reading LinkedIn.');
   if(!response.ok)throw providerError('ADSPOWER_API_HTTP','AdsPower Local API returned HTTP '+response.status+'. Check the local client.');
   const reader=response.body?.getReader();if(reader){const parts=[];let size=0;for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>1024*1024){await reader.cancel();throw providerError('ADSPOWER_API_RESPONSE','AdsPower response exceeded the bounded size.');}parts.push(Buffer.from(value));}data=JSON.parse(Buffer.concat(parts).toString('utf8'));}else data=await response.json();
  }catch(error){if(error.failure?.stage==='provider')throw error;throw providerError('ADSPOWER_UNAVAILABLE','Cannot reach the AdsPower Local API. Open AdsPower, enable Local API, and check its address and permissions.');}
  if(data?.code!==0){const auth=/api.?key|token|auth|permission|access denied/i.test(String(data?.msg||''));throw providerError(auth?'ADSPOWER_API_AUTH':'ADSPOWER_API_REJECTED',auth?'AdsPower rejected API access. Check Local API permissions and the API key.':'AdsPower rejected the request (code '+(Number.isFinite(data?.code)?data.code:'unknown')+'). Check the profile ID, API permissions and AdsPower client.');}
  return data.data||{};
 }
 async function request(path,options){return (await queue.submit(()=>requestNow(path,options))).done;}
 async function active(id){const data=await request('/api/v1/browser/active?user_id='+encodeURIComponent(profileId(id)));if(!['Active','Inactive'].includes(data.status))throw providerError('ADSPOWER_API_RESPONSE','AdsPower returned an unknown profile state.');return {active:data.status==='Active',...(data.status==='Active'?{endpoint:websocket(data.ws?.puppeteer)}:{})};}
 async function start(id,{headless=true}={}){
  const data=await request('/api/v2/browser-profile/start',{method:'POST',body:{profile_id:profileId(id),headless:headless?'1':'0',last_opened_tabs:'1',password_filling:'0',password_saving:'0',delete_cache:'0'}});
  return {active:true,endpoint:websocket(data.ws?.puppeteer)};
 }
 async function list(){let profiles=[],truncated=false;for(let page=1;page<=2;page++){const data=await request('/api/v1/user/list?'+new URLSearchParams({page:String(page),page_size:'100'}));if(!Array.isArray(data.list))throw providerError('ADSPOWER_API_RESPONSE','AdsPower did not return a supported profile list.');profiles.push(...data.list.map(publicProfile).filter(Boolean));if(data.list.length<100)break;if(page===2)truncated=true;}return {profiles:[...new Map(profiles.map(p=>[p.id,p])).values()],truncated};}
 return {health:()=>request('/status'),list,active,start,stop:async id=>{await request('/api/v2/browser-profile/stop',{method:'POST',body:{profile_id:profileId(id)}});},request};
}
module.exports={createAdsPowerClient,baseUrl,profileId,websocket,publicProfile,providerError};
