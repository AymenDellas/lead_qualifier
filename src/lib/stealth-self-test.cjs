'use strict';
// Read-only measurements. Never patch navigator, export cookies or make Node TLS requests.
const VERSION='DIRECT_SIGNALS_V2',IDENTITY_URL='https://browserscan.net/';
const BATTERY=Object.freeze([
 {url:'https://www.browserscan.net/bot-detection',kind:'browserscan'},
 {url:'https://bot.incolumitas.com/',kind:'incolumitas'},
 {url:'https://deviceandbrowserinfo.com/are_you_a_bot',kind:'device'},
 {url:'https://demo.fingerprint.com/playground',kind:'fingerprint'},
 {url:'https://abrahamjuliot.github.io/creepjs/',kind:'creepjs'},
 {url:'https://bot.sannysoft.com/',kind:'sannysoft'},
 {url:'https://tls.browserleaks.com/json',kind:'tls'},
].map(Object.freeze));
const URLS=Object.freeze(BATTERY.map(s=>s.url));
async function probe(page,{checkCDP=false}={}){
 return page.evaluate(async check=>{
  const errors={},read=(key,fn)=>{try{return fn()??null;}catch{errors[key]='unavailable';return null;}};
  let gl,debug;try{gl=document.createElement('canvas').getContext('webgl');debug=gl?.getExtension('WEBGL_debug_renderer_info');}catch{errors.webgl='unavailable';}
  const p={origin:location.origin,secureContext:isSecureContext,
   webdriver:read('webdriver',()=>navigator.webdriver),userAgent:read('userAgent',()=>navigator.userAgent),platform:read('platform',()=>navigator.platform),
   chrome:read('chrome',()=>window.chrome===null?'null':typeof window.chrome),plugins:read('plugins',()=>navigator.plugins.length),
   screen:read('screen',()=>({width:screen.width,height:screen.height})),timezone:read('timezone',()=>Intl.DateTimeFormat().resolvedOptions().timeZone),locale:read('locale',()=>navigator.language),
   hardwareConcurrency:read('hardwareConcurrency',()=>navigator.hardwareConcurrency),deviceMemory:read('deviceMemory',()=>navigator.deviceMemory),
   webglVendor:read('webglVendor',()=>debug?gl.getParameter(debug.UNMASKED_VENDOR_WEBGL):null),webglRenderer:read('webglRenderer',()=>debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):null),
   cdpDetected:null,cdpMethod:'Error.stack console serialization heuristic',errors};
  if(check){try{
   let detected=false;const diagnostic=new Error('CompelOS diagnostic');
   Object.defineProperty(diagnostic,'stack',{get(){detected=true;return 'CompelOS diagnostic';}});
   // Logging this local object is the challenge. Reading its stack ourselves
   // would trigger the getter and manufacture a positive, so never do that.
   console.debug(diagnostic);
   await new Promise(resolve=>{const c=new MessageChannel();c.port1.onmessage=()=>{c.port1.close();c.port2.close();resolve();};c.port2.postMessage(null);});
   p.cdpDetected=detected;
  }catch{errors.cdpDetected='unavailable';}}
  return p;
 },checkCDP);
}
async function identityProbe(page,{assertActive=async()=>{}}={}){
 await assertActive();
 // Preserve the old secure origin/hash fields: battery updates must not create drift.
 if(page.url()!==IDENTITY_URL)await page.goto(IDENTITY_URL,{waitUntil:'domcontentloaded',timeout:15000});
 await assertActive();const p=await probe(page);
 if(!p.secureContext||new URL(p.origin).hostname.replace(/^www\./,'')!=='browserscan.net')throw Error('A consistent secure diagnostic context could not be established.');
 return p;
}
const result=(name,read,ok,value)=>({name,verdict:!read?'UNKNOWN':ok?'PASS':'FAIL',value:value??null});
const verdict=checks=>checks.some(c=>c.verdict==='FAIL')?'FAIL':checks.some(c=>c.verdict==='UNKNOWN')?'UNKNOWN':'PASS';
function assessProbe(p={}){
 p??={};
 const text=v=>typeof v==='string'&&v.trim().length>0;
 return [
  result('webdriver',typeof p.webdriver==='boolean',p.webdriver===false,p.webdriver),
  result('userAgent',text(p.userAgent),!/HeadlessChrome|PhantomJS|Selenium|Playwright/i.test(p.userAgent||''),p.userAgent),
  result('chrome',text(p.chrome),p.chrome==='object'||p.chrome==='function',p.chrome),
  result('plugins',Number.isInteger(p.plugins),p.plugins>0,p.plugins),
  result('webglVendor',text(p.webglVendor),true,p.webglVendor),
  result('webglRenderer',text(p.webglRenderer),true,p.webglRenderer),
  result('cdpSerialization',typeof p.cdpDetected==='boolean',p.cdpDetected===false,p.cdpDetected),
 ];
}
function endpointMatches(actual,expected){try{const a=new URL(actual),b=new URL(expected);return a.origin===b.origin&&a.pathname.replace(/\/$/,'')===b.pathname.replace(/\/$/,'')&&!a.search;}catch{return false;}}
function assessSite({url,status,finalUrl=url,probe:identity,external=null,error=''}){
 const checks=assessProbe(identity),measured=verdict(checks);
 if(measured==='FAIL'||external?.verdict==='FAIL'){
  const flagged=[...Object.entries(external?.flags||{}).filter(([k,v])=>v===true&&k!=='isBot').map(([k])=>k),...Object.entries(external?.checks||{}).filter(([,v])=>v==='FAIL').map(([k])=>k),...(external?.cells||[]).filter(c=>c.failed).map(c=>c.id)].join(', ').slice(0,400);
  return {url,checks,verdict:'FAIL',reason:external?.verdict==='FAIL'?'The test site reported failure'+(flagged?': '+flagged:external.value?': '+external.value:'')+'.':'Direct checks failed: '+checks.filter(c=>c.verdict==='FAIL').map(c=>c.name).join(', ')+'.'};
 }
 if(!URLS.includes(url)||!endpointMatches(finalUrl,url)||error||status!==200)return {url,checks,verdict:'UNKNOWN',reason:error||'The actual test endpoint was unavailable or redirected (HTTP '+status+').'};
 if(measured==='UNKNOWN')return {url,checks,verdict:'UNKNOWN',reason:'Cannot read direct signals: '+checks.filter(c=>c.verdict==='UNKNOWN').map(c=>c.name).join(', ')+'.'};
 return {url,checks,verdict:'PASS',reason:'All seven direct browser checks passed.'+(external?.verdict==='PASS'?' The site also reported a pass.':' The site-specific verdict is unavailable; direct measurements are separate.')};
}
// Runs in the page: real result elements, never examples or private app state.
function siteResult(kind){
 try{
  if(kind==='device'){
   const data=JSON.parse((document.querySelector('#jsonResult')?.textContent||'').slice(0,32768));if(typeof data.isBot!=='boolean')return null;
   const flags=Object.fromEntries(Object.entries({...data.details,...data.checks,...data}).filter(([k,v])=>/^(?:is|has)/.test(k)&&typeof v==='boolean').slice(0,40));
   const failed=data.isBot||['hasBotUserAgent','hasWebdriverTrue','isHeadlessChrome','isAutomatedWithCDP','isAutomatedWithCDPInWebWorker'].some(k=>flags[k]===true);
   return {verdict:failed?'FAIL':'PASS',source:'#jsonResult',flags};
  }
  if(kind==='fingerprint'){
   const value=document.querySelector('[data-test-property-name="bot"]')?.textContent?.replace(/\s+/g,' ').trim();
   if(value==='Not detected')return {verdict:'PASS',source:'[data-test-property-name="bot"]',value};
   if(/^You are a (?:bad |good )?bot\b/i.test(value||''))return {verdict:'FAIL',source:'[data-test-property-name="bot"]',value:value.slice(0,200)};
  }
  if(kind==='sannysoft'){
   if(!document.querySelector('#user-agent-result')?.textContent?.trim()||!/^\d+/.test(document.querySelector('#plugins-length-result')?.textContent?.trim()||''))return null;
   const ids=['user-agent-result','webdriver-result','advanced-webdriver-result','chrome-result','plugins-length-result','plugins-type-result'];
   const cells=ids.map(id=>{const e=document.getElementById(id);return e?.textContent?.trim()?{id,value:e.textContent.trim().slice(0,400),failed:e.classList.contains('failed')}:null;});
   if(cells.some(c=>!c))return null;
   return {verdict:cells.some(c=>c.failed)?'FAIL':'PASS',source:'Completed result table',cells};
  }
  if(kind==='incolumitas'){
   const data=JSON.parse((document.querySelector('#new-tests')?.textContent||'').slice(0,32768));
   if(!['webdriverPresent','puppeteerEvaluationScript','inconsistentUserAgent','inconsistentLanguages'].every(k=>['OK','FAIL'].includes(data[k])))return null;
   const checks=Object.fromEntries(Object.entries(data).filter(([,v])=>v==='OK'||v==='FAIL').slice(0,40));
   return {verdict:Object.values(checks).includes('FAIL')?'FAIL':'PASS',source:'#new-tests',checks};
  }
 }catch{/* Missing/incomplete vendor UI; direct probes are independent. */}
 return null;
}
function assessTLS(data,p={}){
 p??={};
 const md5=s=>require('node:crypto').createHash('md5').update(s).digest('hex');
 const hasJA3=typeof data?.ja3_hash==='string'&&/^[a-f0-9]{32}$/i.test(data.ja3_hash)&&typeof data.ja3_text==='string'&&/^\d+,[\d-]+,[\d-]*,[\d-]*,[\d-]*$/.test(data.ja3_text);
 const hasJA4=typeof data?.ja4==='string'&&/^[tq](?:1[0-3]|00)[di]\d{4}[a-z0-9]{2}_[a-f0-9]{12}_[a-f0-9]{12}$/i.test(data.ja4);
 const hasUA=typeof data?.user_agent==='string'&&data.user_agent.length>0&&typeof p.userAgent==='string'&&p.userAgent.length>0;
 const checks=[result('ja3',hasJA3,hasJA3&&md5(data.ja3_text)===data.ja3_hash?.toLowerCase(),data?.ja3_hash),result('ja4',hasJA4,true,data?.ja4),result('httpUserAgent',hasUA,hasUA&&data.user_agent===p.userAgent,data?.user_agent)];
 return {verdict:verdict(checks),checks,referenceVerdict:'NOT_EVALUATED',reason:'Checks cover fingerprint availability/integrity and HTTP/browser UA agreement. No reference Chrome TLS fingerprint was supplied.'};
}
async function run(page,{assertActive=async()=>{},now=Date.now,urls=URLS,resultTimeoutMs=8000}={}){
 if(urls.length!==URLS.length||urls.some((u,i)=>u!==URLS[i]))throw Error('Use only the configured diagnostic battery.');
 if(!Number.isInteger(resultTimeoutMs)||resultTimeoutMs<1||resultTimeoutMs>10000)throw Error('Invalid detector result deadline.');
 const sites=[],start=now();
 for(const {url,kind}of BATTERY){
  await assertActive();const at=now();let e={url,kind},stage='navigation';
  try{
   const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:15000});await assertActive();
   const status=response?.status(),finalUrl=page.url();e={...e,status,finalUrl};
   if(kind==='tls'){
    stage='tls-json';
    const data=await page.evaluate(()=>{const t=document.body?.innerText||'';if(t.length>65536)return null;try{const d=JSON.parse(t);return Object.fromEntries(['user_agent','ja4','ja4_r','ja4_o','ja4_ro','ja3_hash','ja3_text','ja3n_hash','ja3n_text','akamai_hash'].filter(k=>typeof d[k]==='string'&&d[k].length<=4096).map(k=>[k,d[k]]));}catch{return null;}});
    e.tls=data;stage='tls-browser-ua';const identity=await probe(page),assessment=assessTLS(data,identity);e={...e,probe:identity,...assessment};
    if(status!==200||!endpointMatches(finalUrl,url))e={...e,verdict:'UNKNOWN',reason:'The browser-routed TLS JSON endpoint was unavailable (HTTP '+status+').'};
   }else{
    let external=null;stage='site-result';
    if(status===200&&endpointMatches(finalUrl,url)&&['device','fingerprint','sannysoft','incolumitas'].includes(kind)){
     // Event-driven DOM observation, not a fixed rendering/throttle sleep.
     try{const h=await page.waitForFunction(siteResult,{timeout:resultTimeoutMs,polling:'mutation'},kind);try{external=await h.jsonValue();}finally{await h.dispose();}}catch{/* Direct measurements remain available if the site UI is unsupported/slow. */}
    }
    e.external=external||{verdict:'UNKNOWN',reason:'No completed supported site result; direct checks are independent.'};
    await assertActive();stage='direct-probe';e.probe=await probe(page,{checkCDP:true});e={...e,...assessSite(e)};
    // Raw page text is supporting evidence, not a required detector signal.
    // Failure to capture it cannot erase a completed PASS or confirmed FAIL.
    try{Object.assign(e,await page.evaluate(()=>({title:document.title,text:(document.body?.innerText||'').slice(0,8000)})));}catch{e.rawCaptureError='Optional page text unavailable; direct/site results retained.';}
   }
  }catch(error){
   const known=kind==='tls'?assessTLS(e.tls,e.probe):assessSite(e),message=String(error.message||error.name||'Detector error').replace(/wss?:\/\/\S+/gi,'[CDP endpoint]').slice(0,600);
   e={...e,...known,verdict:known.verdict==='FAIL'?'FAIL':'UNKNOWN',reason:known.verdict==='FAIL'?known.reason:'Cannot read '+stage+': '+message,error:String(error.name||'Detector error'),failureStage:stage};
  }
  // Pause/hold/lease loss aborts, never permits subsequent navigation as UNKNOWN.
  await assertActive();sites.push({...e,durationMs:now()-at});
 }
 const overall=verdict(sites),counts={PASS:0,FAIL:0,UNKNOWN:0};for(const s of sites)counts[s.verdict]++;
 return {version:VERSION,verdict:overall,reason:overall==='PASS'?'All required direct browser and TLS capture/coherence checks passed; no available site result reported failure.':overall==='FAIL'?'Measured browser signals or a completed site test reported failure.':'One or more required browser/TLS signals could not be read.',scope:'Browser signal heuristics and browser-routed TLS capture/coherence; not proof of an undetectable browser.',controlTransport:'CDP',checkedAt:new Date(now()).toISOString(),durationMs:now()-start,counts,sites};
}
async function network(page,{assertActive=async()=>{}}={}){
 const readings=[];
 for(let i=0;i<3;i++){
  await assertActive();const response=await page.goto('https://api.ipapi.is/',{waitUntil:'domcontentloaded',timeout:15000});
  if(response?.status()!==200)throw Error('Free network lookup unavailable (HTTP '+response?.status()+'); no automatic retry.');
  const data=await page.evaluate(()=>{try{return JSON.parse(document.body.innerText.slice(0,65536));}catch{return null;}});
  if(!data||data.error)throw Error('Free network lookup returned no usable evidence.');
  readings.push({ip:data.ip,country:data.location?.country_code||data.country,countryName:data.location?.country,timezone:data.location?.timezone||data.timezone,datacenter:data.is_datacenter});
 }
 await assertActive();return {...readings[0],rotating:new Set(readings.map(v=>v.ip)).size!==1,readings};
}
module.exports={VERSION,BATTERY,URLS,probe,identityProbe,assessProbe,assessSite,siteResult,assessTLS,run,network};
