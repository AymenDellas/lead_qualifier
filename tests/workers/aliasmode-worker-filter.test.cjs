'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {createAliasModeBrowser}=require('../../src/lib/aliasmode-browser.cjs'),comparison=require('../../scripts/engine-worker-target-comparison.cjs');
test('the installed lockfile version supports the connect targetFilter option',()=>{
 const support=comparison.verifySupport();assert.equal(support.puppeteer,'24.38.0');assert.equal(support.puppeteerCore,'24.38.0');assert.equal(support.targetFilter,true);
});
test('the production connect filter leaves dedicated workers running without tracking them and retains page execution contexts',async()=>{
 const puppeteer=require('puppeteer'),root=fs.mkdtempSync(path.join(os.tmpdir(),'compel-worker-filter-'));
 const server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':req.url==='/worker.js'?'application/javascript':'text/html'});res.end(req.url==='/worker.js'?'self.postMessage("worker-completed");':'<!doctype html><title>Fixture</title><main>Local worker fixture</main>');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let launcher,adapter,endpoint,connected=false;
 const account={id:'worker-filter-fixture',aliasmode_profile_id:'worker-filter-fixture',launch_mode:'headless'},owner='fixture-owner';
 const store={assertOwner:async()=>{},session:async()=>null,saveSession:async()=>{},finishSession:async()=>{}};
 const api={active:async()=>connected?{active:true,headless:true,endpoint}:{active:false},start:async()=>{launcher=await puppeteer.launch({headless:true,userDataDir:root,defaultViewport:null});endpoint=launcher.wsEndpoint();await launcher.disconnect();connected=true;return {active:true,headless:true,endpoint};},stop:async()=>{const child=launcher.process(),exited=child.exitCode!==null?Promise.resolve():new Promise(resolve=>child.once('exit',resolve));const b=await puppeteer.connect({browserWSEndpoint:endpoint,targetFilter:t=>!['worker','service_worker','shared_worker'].includes(t._getTargetInfo?.()?.type||t.type())});await b.close();await exited;connected=false;}};
 try{
  adapter=createAliasModeBrowser({account,owner,pool:{},provider:{client:api,store}});const {browser,page}=await adapter.open();let workerEvents=0;page.on('workercreated',()=>workerEvents++);
  const url='http://127.0.0.1:'+server.address().port+'/';await page.goto(url,{waitUntil:'load'});
  const result=await page.evaluate(()=>new Promise((resolve,reject)=>{const worker=new Worker('/worker.js');window.fixtureWorker=worker;const timeout=setTimeout(()=>reject(Error('Fixture worker timeout')),4000);worker.onmessage=e=>{clearTimeout(timeout);resolve(e.data);};}));
  assert.equal(result,'worker-completed');assert.equal(workerEvents,0);assert.equal(page.workers().length,0);
  const session=await browser.target().createCDPSession();try{const {targetInfos}=await session.send('Target.getTargets');assert.ok(targetInfos.some(t=>t.type==='worker'),'The worker exists independently of Puppeteer tracking');}finally{await session.detach();}
  assert.equal(await page.evaluate(()=>document.readyState),'complete');await page.goto(url+'?second-context',{waitUntil:'load'});assert.equal(await page.evaluate(()=>location.search),'?second-context');
 }finally{await adapter?.stop();await adapter?.close();await new Promise(resolve=>server.close(resolve));const target=path.resolve(root);if(path.dirname(target)!==path.resolve(os.tmpdir())||!path.basename(target).startsWith('compel-worker-filter-'))throw Error('Unsafe fixture cleanup');await fs.promises.rm(target,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
test('comparison preserves all other flags and never manufactures a missing/positive worker result into proof',()=>{
 const run=flag=>({sites:Array.from({length:7},(_,i)=>({url:'https://fixture.test/'+i,kind:i===0?'device':'fixture',status:200,finalUrl:'https://fixture.test/'+i,verdict:'FAIL',checks:require('../../src/lib/stealth-self-test.cjs').assessProbe({webdriver:false,userAgent:'Chrome/155',chrome:'object',plugins:5,webglVendor:'Fixture',webglRenderer:'Fixture renderer',cdpDetected:false}),probe:{webdriver:false},external:i===0?{verdict:'FAIL',flags:{isBot:true,isAutomatedWithCDP:true,isAutomatedWithCDPInWebWorker:flag}}:null}))});
 assert.equal(comparison.compare(run(true),run(false)).acceptance,true);assert.equal(comparison.compare(run(true),run(true)).acceptance,false);
 assert.equal(comparison.compare(run(true),run(false)).deviceOtherFlagsUnchanged,true);
 assert.equal(comparison.compare(run(true),run(false)).deviceDirectChecksUnchanged,true);
 const changed=run(false);changed.sites[0].external.flags.isAutomatedWithCDP=false;assert.equal(comparison.compare(run(true),changed).acceptance,false);assert.equal(comparison.compare(run(true),changed).deviceOtherFlagsUnchanged,false);
 const changedCheck=run(false);changedCheck.sites[0].checks[0].value=true;assert.equal(comparison.compare(run(true),changedCheck).deviceDirectChecksUnchanged,false);
 const incompleteChecks=run(false);incompleteChecks.sites[0].checks.pop();assert.equal(comparison.compare(run(true),incompleteChecks).deviceDirectChecksUnchanged,false);
 const missing=run(false);delete missing.sites[0].external.flags.isAutomatedWithCDPInWebWorker;assert.equal(comparison.compare(run(true),missing).acceptance,false);
});
