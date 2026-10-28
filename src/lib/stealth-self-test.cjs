'use strict';
// Read-only diagnostics. Never patch browser properties or mistake a landing
// page, example JSON, transport failure or unavailable verdict for a pass.
const URLS=Object.freeze(['https://browserscan.net/','https://bot.incolumitas.com/','https://deviceandbrowserinfo.com/','https://demo.fingerprint.com/','https://abrahamjuliot.github.io/creepjs/','https://arh.antoinevastel.com/bots/areyouheadless']);
async function probe(page){return page.evaluate(()=>{
 const gl=document.createElement('canvas').getContext('webgl'),debug=gl?.getExtension('WEBGL_debug_renderer_info');
 return {origin:location.origin,secureContext:isSecureContext,webdriver:navigator.webdriver,userAgent:navigator.userAgent,platform:navigator.platform,chrome:typeof window.chrome,plugins:navigator.plugins.length,
  screen:{width:screen.width,height:screen.height},timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,locale:navigator.language,
  hardwareConcurrency:navigator.hardwareConcurrency??null,deviceMemory:navigator.deviceMemory??null,
  webglVendor:debug?gl.getParameter(debug.UNMASKED_VENDOR_WEBGL):null,webglRenderer:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):null};
});}
async function identityProbe(page,{assertActive=async()=>{}}={}){
 await assertActive();
 // Secure-context APIs differ on about:blank and fingerprints can be scoped by
 // origin. Compare every baseline/session on the same public diagnostic origin.
 if(page.url()!==URLS[0])await page.goto(URLS[0],{waitUntil:'domcontentloaded',timeout:15000});
 await assertActive();const observed=await probe(page);
 if(!observed.secureContext||new URL(observed.origin).hostname.replace(/^www\./,'')!=='browserscan.net')throw Error('A consistent secure diagnostic context could not be established.');
 return observed;
}
function assessSite({url,status,probe:identity,result=null,error=''}){
 if(identity?.webdriver===true||/HeadlessChrome/.test(identity?.userAgent||''))return {url,verdict:'FAIL',reason:'Browser exposes an explicit webdriver/headless signal.'};
 if(error||status!==200)return {url,verdict:'UNKNOWN',reason:error||'Detector returned HTTP '+status+'.'};
 // Only a detector's declared result element is accepted. Never search a whole
 // page for an example containing "false" or a marketing authenticity score.
 if(!result||typeof result!=='object'||Array.isArray(result))return {url,verdict:'UNKNOWN',reason:'No supported machine-readable detector verdict; inspect the captured evidence.'};
 const checks=['webdriverDetected','headlessDetected','cdpDetected','tlsMismatch'];
 if(checks.some(key=>result[key]===true))return {url,verdict:'FAIL',reason:'Detector reported '+checks.filter(key=>result[key]===true).join(', ')+'.'};
 if(!checks.every(key=>result[key]===false))return {url,verdict:'UNKNOWN',reason:'Detector did not establish all webdriver, headless, CDP and TLS results.'};
 return {url,verdict:'PASS',reason:'All declared detector checks passed.'};
}
async function run(page,{assertActive=async()=>{},now=Date.now,urls=URLS}={}){
 if(urls.length!==URLS.length||urls.some((u,i)=>u!==URLS[i]))throw Error('Use only the configured diagnostic battery.');
 const sites=[],start=now();
 for(const url of urls){
  await assertActive();const at=now();let evidence={url};
  try{
   const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:15000});await assertActive();
   // Event-based wait for the result element, bounded by a deadline. These
   // sites may change or require explicit human interaction; UNKNOWN is useful.
   await page.waitForSelector?.('#detection-results,[data-testid="bot-detection-results"]',{timeout:1500}).catch(()=>{});
   const captured=await page.evaluate(()=>{
    const element=document.querySelector('#detection-results,[data-testid="bot-detection-results"]');let result=null;
    if(element)try{result=JSON.parse(element.textContent);}catch{}
    return {result,title:document.title,text:(document.body?.innerText||'').slice(0,8000)};
   });
   evidence={...evidence,status:response?.status(),probe:await probe(page),...captured};
  }catch(error){evidence.error=String(error.name||'Detector error');}
  sites.push({...evidence,...assessSite(evidence),durationMs:now()-at});
 }
 await assertActive();const verdict=sites.some(s=>s.verdict==='FAIL')?'FAIL':sites.every(s=>s.verdict==='PASS')?'PASS':'UNKNOWN';
 return {verdict,reason:verdict==='PASS'?'Diagnostic battery complete.':verdict==='FAIL'?'One or more detectors reported automation signals.':'One or more detector verdicts are unavailable or unsupported. No pass was inferred.',checkedAt:new Date(now()).toISOString(),durationMs:now()-start,sites};
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
module.exports={URLS,probe,identityProbe,assessSite,run,network};
