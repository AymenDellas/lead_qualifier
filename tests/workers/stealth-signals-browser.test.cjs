'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),checks=require('../../src/lib/stealth-self-test.cjs'),{fixture}=require('./aliasmode-fixture.cjs');
function body(url,ua){
 if(url===checks.URLS.at(-1)){const text='771,4865-4866-4867,0-10-11-13,29-23,0';return JSON.stringify({user_agent:ua,ja3_hash:crypto.createHash('md5').update(text).digest('hex'),ja3_text:text,ja4:'t13d1516h2_8daaf6152771_02713d6af862',secretFixtureValue:'must-not-be-retained'});}
 return '<!doctype html><title>Intercepted detector fixture</title><pre id="jsonResult">{"isBot":false,"details":{"isAutomatedWithCDP":false,"isAutomatedWithCDPInWebWorker":false}}</pre><div data-test-property-name="bot">Not detected</div><pre id="new-tests">{"webdriverPresent":"OK","puppeteerEvaluationScript":"OK","inconsistentUserAgent":"OK","inconsistentLanguages":"OK"}</pre><table>'+['user-agent-result','webdriver-result','advanced-webdriver-result','chrome-result','plugins-length-result','plugins-type-result'].map(id=>'<tr><td id="'+id+'" class="passed">'+(id==='plugins-length-result'?'5':'Fixture OK')+'</td></tr>').join('')+'</table>';
}
test('visible/headless browser fixtures read real JS signals, actual result elements and intercepted TLS JSON',async()=>{
 const f=await fixture();try{
  for(const headless of [false,true]){
   const owner=f.create('signals-'+headless),{page}=await owner.open({headless}),requests=[];
   await page.setRequestInterception(true);page.on('request',r=>{requests.push(r.url());void r.respond({status:200,contentType:r.url()===checks.URLS.at(-1)?'application/json':'text/html',body:body(r.url(),r.headers()['user-agent'])});});
   const report=await checks.run(page,{resultTimeoutMs:1000});assert.equal(report.verdict,'FAIL','Unmodified fixture Chrome exposes automation; never manufacture a PASS');assert.equal(report.sites.length,7);
   assert.equal(report.sites[2].external.source,'#jsonResult');assert.equal(report.sites[3].external.verdict,'PASS');assert.equal(report.sites[5].external.verdict,'PASS');assert.equal(report.sites.at(-1).verdict,'PASS');
   assert.equal(report.sites.at(-1).tls.secretFixtureValue,undefined);assert.equal(typeof report.sites[0].probe.cdpDetected,'boolean');assert.equal(typeof report.sites[0].probe.plugins,'number');
   assert.ok(report.sites[0].probe.webglRenderer);assert.equal(report.sites[0].probe.webdriver,true);assert.ok(requests.every(u=>checks.URLS.includes(u)||u.endsWith('/favicon.ico')));
   // Test-only positive control: emulate a console serializer accessing stack.
   await page.evaluate(()=>{window.fixtureDebug=console.debug;console.debug=e=>{void e.stack;};});
   assert.equal((await checks.probe(page,{checkCDP:true})).cdpDetected,true);
   await page.evaluate(()=>{console.debug=window.fixtureDebug;delete window.fixtureDebug;});
   await page.goto(checks.URLS[2]);await page.evaluate(()=>{document.querySelector('#jsonResult').textContent=JSON.stringify({isBot:false,details:{isAutomatedWithCDP:true}});});
   const nested=await page.evaluate(checks.siteResult,'device');assert.equal(nested.verdict,'FAIL');assert.equal(nested.flags.isAutomatedWithCDP,true);
   await owner.recycle();await owner.close();
  }
 }finally{await f.close();}
});
