'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),checks=require('../../src/lib/stealth-self-test.cjs');
const normal=()=>({webdriver:false,userAgent:'Mozilla/5.0 Chrome/155.0.0.0 Safari/537.36',chrome:'object',plugins:5,webglVendor:'Fixture GPU',webglRenderer:'Fixture renderer',cdpDetected:false});
function tls(){const text='771,4865-4866-4867,0-10-11-13,29-23,0';return {user_agent:normal().userAgent,ja3_text:text,ja3_hash:crypto.createHash('md5').update(text).digest('hex'),ja4:'t13d1516h2_8daaf6152771_02713d6af862'};}
test('battery uses actual test paths and browser-routed TLS JSON, with no broken Vastel URL',()=>{
 assert.ok(checks.URLS.includes('https://deviceandbrowserinfo.com/are_you_a_bot'));assert.ok(checks.URLS.includes('https://demo.fingerprint.com/playground'));
 assert.ok(checks.URLS.includes('https://www.browserscan.net/bot-detection'));assert.ok(checks.URLS.includes('https://tls.browserleaks.com/json'));assert.ok(checks.URLS.includes('https://bot.sannysoft.com/'));
 assert.equal(checks.URLS.some(u=>u.includes('antoinevastel')),false);
});
test('direct signal verdicts distinguish normal readings, positive flags and unreadable values',()=>{
 const p=normal();assert.ok(checks.assessProbe(p).every(c=>c.verdict==='PASS'));
 for(const change of [{webdriver:true},{userAgent:'HeadlessChrome/155'},{chrome:'undefined'},{plugins:0},{cdpDetected:true}])assert.ok(checks.assessProbe({...p,...change}).some(c=>c.verdict==='FAIL'));
 for(const key of Object.keys(p)){const missing={...p};delete missing[key];assert.ok(checks.assessProbe(missing).some(c=>c.verdict==='UNKNOWN'),key);}
 assert.equal(checks.assessSite({url:checks.URLS[0],status:200,probe:p}).verdict,'PASS');
 assert.equal(checks.assessSite({url:checks.URLS[0],finalUrl:'https://www.browserscan.net/',status:200,probe:p}).verdict,'UNKNOWN');
 assert.equal(checks.assessSite({url:checks.URLS[0],status:200,probe:p,external:{verdict:'FAIL'}}).verdict,'FAIL');
});
test('TLS validates JA3 integrity, reads JA4 and checks HTTP/browser UA without claiming Chrome equivalence',()=>{
 const data=tls();const r=checks.assessTLS(data,normal());assert.equal(r.verdict,'PASS');assert.equal(r.referenceVerdict,'NOT_EVALUATED');
 assert.equal(checks.assessTLS({...data,ja3_hash:'0'.repeat(32)},normal()).verdict,'FAIL');
 assert.equal(checks.assessTLS({...data,user_agent:'Another browser'},normal()).verdict,'FAIL');
 for(const key of ['ja3_hash','ja3_text','ja4','user_agent']){const d={...data};delete d[key];assert.equal(checks.assessTLS(d,normal()).verdict,'UNKNOWN',key);}
 assert.equal(checks.assessTLS(null,normal()).verdict,'UNKNOWN');
});
function pageFixture({p=normal(),tlsData=tls(),ui=null}={}){
 const calls=[];let url='about:blank';return {calls,url:()=>url,goto:async u=>{url=u;calls.push(u);return{status:()=>200};},
  waitForFunction:async()=>{if(!ui)throw Error('Fixture unavailable UI');return{jsonValue:async()=>ui,dispose:async()=>{}};},
  evaluate:async(_fn,arg)=>typeof arg==='boolean'?p:url===checks.URLS.at(-1)?tlsData:{title:'Fixture test',text:'Example marketing JSON: {"cdpDetected":false}'},
 };
}
test('complete direct/TLS signals produce PASS even without vendor UI; positives always produce FAIL',async()=>{
 const page=pageFixture(),report=await checks.run(page,{resultTimeoutMs:1});assert.equal(report.verdict,'PASS');assert.equal(report.version,checks.VERSION);assert.equal(report.controlTransport,'CDP');assert.equal(report.sites.length,7);assert.equal(report.sites.at(-1).tls.ja4,tls().ja4);assert.deepEqual(page.calls,checks.URLS);
 assert.equal((await checks.run(pageFixture({p:{...normal(),cdpDetected:true}}),{resultTimeoutMs:1})).verdict,'FAIL');
 assert.equal((await checks.run(pageFixture({ui:{verdict:'FAIL'}}),{resultTimeoutMs:1})).verdict,'FAIL');
 assert.equal((await checks.run(pageFixture({p:{...normal(),webglVendor:null}}),{resultTimeoutMs:1})).verdict,'UNKNOWN');
 assert.equal((await checks.run(pageFixture({tlsData:null}),{resultTimeoutMs:1})).verdict,'UNKNOWN');
 const badProbe=pageFixture({ui:{verdict:'FAIL'}}),evaluate=badProbe.evaluate;badProbe.evaluate=async(fn,arg)=>{if(typeof arg==='boolean')throw Error('Fixture probe unreadable');return evaluate(fn,arg);};
 const retained=await checks.run(badProbe,{resultTimeoutMs:1});assert.equal(retained.verdict,'FAIL');assert.equal(retained.sites[1].verdict,'FAIL');assert.equal(retained.sites[0].failureStage,'direct-probe');assert.match(retained.sites[0].reason,/Fixture probe unreadable/);
 const noText=pageFixture(),read=noText.evaluate;noText.evaluate=async(fn,arg)=>{if(arg===undefined&&noText.url()!==checks.URLS.at(-1))throw Error('Optional text unavailable');return read(fn,arg);};
 assert.equal((await checks.run(noText,{resultTimeoutMs:1})).verdict,'PASS');
});
test('dashboard summary includes TLS as the seventh bounded detector entry',()=>{
 const state=require('../../src/lib/account-session-store.cjs').publicState({daily_limit:300,session_evidence:{gate:{verdict:'UNKNOWN',sites:checks.URLS.map(url=>({url,verdict:'UNKNOWN'}))}}});
 assert.equal(state.gate.sites.length,7);assert.equal(state.gate.sites.at(-1).url,'https://tls.browserleaks.com/json');
});
test('a hold or lost owner cancels the battery before another navigation; arbitrary endpoint injection is rejected',async()=>{
 const page=pageFixture();let active=0;await assert.rejects(checks.run(page,{assertActive:async()=>{if(++active>=3)throw Error('Account hold');},resultTimeoutMs:1}),/Account hold/);assert.equal(page.calls.length,1);
 await assert.rejects(checks.run(page,{urls:['https://example.test/']}),/configured diagnostic battery/);
});
