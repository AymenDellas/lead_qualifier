'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),https=require('node:https'),crypto=require('node:crypto');
const human=require('../../src/lib/session-humanizer.cjs');

function fixtureTLS(){
 // A fresh, disposable test key/certificate stays in memory. No certificate
 // store, existing profile, credentials, or external certificate service is used.
 const {privateKey,publicKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
 const der=(tag,payload)=>{
  const bytes=Buffer.isBuffer(payload)?payload:Buffer.concat(payload),size=bytes.length;
  const length=size<128?[size]:size<256?[0x81,size]:[0x82,size>>8,size&255];
  return Buffer.concat([Buffer.from([tag,...length]),bytes]);
 };
 const sequence=(...values)=>der(0x30,values),oid=hex=>der(6,Buffer.from(hex,'hex'));
 const algorithm=sequence(oid('2a864886f70d01010b'),der(5,Buffer.alloc(0)));
 const name=sequence(der(0x31,sequence(oid('550403'),der(12,Buffer.from('www.linkedin.com')))));
 const time=value=>der(23,Buffer.from(value.toISOString().replace(/\D/g,'').slice(2,14)+'Z'));
 const body=sequence(der(2,Buffer.from([1])),algorithm,name,
  sequence(time(new Date(Date.now()-86400000)),time(new Date(Date.now()+86400000))),name,publicKey.export({type:'spki',format:'der'}));
 const certificate=sequence(body,algorithm,der(3,Buffer.concat([Buffer.from([0]),crypto.sign('sha256',body,privateKey)])));
 const cert='-----BEGIN CERTIFICATE-----\n'+certificate.toString('base64').match(/.{1,64}/g).join('\n')+'\n-----END CERTIFICATE-----';
 return {key:privateKey.export({type:'pkcs8',format:'pem'}),cert};
}

async function fixture(){
 const requests=[],server=https.createServer(fixtureTLS(),(request,response)=>{
  requests.push({path:request.url,headers:request.headers});
  if(request.url==='/slow-resource.svg')return void setTimeout(()=>{response.writeHead(200,{'content-type':'image/svg+xml'});response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');},30);
  if(request.url==='/li/track')return void setTimeout(()=>{response.writeHead(204);response.end();},60);
  response.writeHead(200,{'content-type':'text/html; charset=utf-8'});
  const link=request.url==='/feed/'?'<a href="/in/rendered-fixture/">Rendered member</a>':request.url==='/in/assigned-fixture/'?'<a id="spa" href="/in/spa-fixture/">SPA member</a>':'';
  response.end('<!doctype html><title>Local fixture</title><main style="height:3500px">'+link+'</main><img src="/slow-resource.svg" onload="window.fixtureLoaded=true"><script>window.fixtureScrollCount=0;const originalScroll=window.scrollBy.bind(window);window.scrollBy=(...args)=>{window.fixtureScrollCount++;return originalScroll(...args)};fetch("/li/track",{method:"POST",body:"fixture-page-view"}).then(()=>window.fixtureTelemetryFinished=true);document.querySelector("#spa")?.addEventListener("click",event=>{event.preventDefault();history.pushState({},"","/in/spa-fixture/")});</script>');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 let browser;
 try{
  // Chromium resolves the original HTTPS origin directly to the local server.
  // Request interception or URL rewriting would omit/change Fetch Metadata;
  // no headers are injected. Every other hostname is unresolvable and aborted.
  browser=await require('puppeteer').launch({headless:true,acceptInsecureCerts:true,args:[
   '--no-proxy-server','--host-resolver-rules=MAP www.linkedin.com 127.0.0.1:'+server.address().port+', MAP * ~NOTFOUND',
  ]});
  const page=await browser.newPage();await page.setRequestInterception(true);
  page.on('request',request=>{
   let permitted=false;try{permitted=new URL(request.url()).origin==='https://www.linkedin.com';}catch{}
   void (permitted?request.continue():request.abort()).catch(()=>{});
  });
  return {page,requests,close:async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
 }catch(error){await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));throw error;}
}

function clock(){let at=0;return {now:()=>at,sleep:async duration=>{at+=duration;}};}

test('offline HTTPS session opens the feed, observes native same-origin link/assign headers, dwells and ends on the feed',async()=>{
 const f=await fixture(),{page}=f,evidence=[];
 try{
  const response=await human.feed(page);assert.equal(response.status(),200);
  assert.equal(f.requests[0].path,'/feed/');assert.equal(await page.evaluate(()=>document.readyState),'complete');assert.equal(await page.evaluate(()=>window.fixtureLoaded),true,'feed waits for load, including its local image');
  const feedDwell=await human.dwell(page,{...clock(),minMs:20000,maxMs:60000,minScrolls:1,maxScrolls:2,random:min=>min});
  assert.ok(feedDwell.dwellMs>=20000&&feedDwell.dwellMs<=60000);assert.ok(feedDwell.scrollCount>=1&&feedDwell.scrollCount<=2);
  assert.equal(await page.evaluate(()=>window.fixtureScrollCount),feedDwell.scrollCount);
  // A profile must never use goto: feed remains the only permitted use here.
  const goto=page.goto.bind(page);page.goto=()=>assert.fail('Profile navigation must use a rendered link or location.assign');
  for(const [index,url] of ['https://www.linkedin.com/in/rendered-fixture/','https://www.linkedin.com/in/assigned-fixture/'].entries()){
   await human.visit(page,url,{onNavigationEvidence:value=>evidence.push(value)});
   assert.equal(page.url(),url);assert.equal(await page.evaluate(()=>document.readyState),'complete');assert.equal(await page.evaluate(()=>window.fixtureLoaded),true);
   const settle=await human.settle(page,{quietMs:25,timeoutMs:2000});assert.equal(settle.settled,true);assert.equal(settle.pendingRequests,0);assert.equal(settle.telemetryFlushConfirmed,false);
   assert.equal(await page.evaluate(()=>window.fixtureTelemetryFinished),true,'the observed fixture telemetry request completed before dwell');
   const dwell=await human.dwell(page,{...clock(),random:index===0?min=>min:(_min,max)=>max-1});
   assert.ok(dwell.dwellMs>=30000&&dwell.dwellMs<=90000);assert.ok(dwell.scrollCount>=2&&dwell.scrollCount<=4);
   assert.equal(await page.evaluate(()=>window.fixtureScrollCount),dwell.scrollCount);
  }
  assert.deepEqual(evidence.map(value=>value.method),['rendered-link','location.assign']);
  for(const [index,value] of evidence.entries()){
   const path=index===0?'/in/rendered-fixture/':'/in/assigned-fixture/',observed=f.requests.find(request=>request.path===path);
   assert.equal(value.httpNavigation,true);assert.equal(value.headerSource,'Network.requestWillBeSentExtraInfo');
   assert.equal(value.secFetchSite,'same-origin');assert.equal(value.referer,observed.headers.referer);
   assert.equal(observed.headers['sec-fetch-site'],'same-origin');assert.ok(observed.headers.referer,'the local HTTPS server received the native Referer');
  }
  page.goto=goto;await human.feed(page);assert.equal(page.url(),'https://www.linkedin.com/feed/');
  assert.equal(f.requests.filter(request=>request.path==='/feed/'||request.path.startsWith('/in/')).at(-1).path,'/feed/');
 }finally{await f.close();}
});

test('rendered SPA navigation records no fabricated document headers',async()=>{
 const f=await fixture(),evidence=[];
 try{
  await human.feed(f.page);await human.visit(f.page,'https://www.linkedin.com/in/assigned-fixture/');
  const documents=f.requests.filter(request=>request.path.startsWith('/in/')).length;
  await human.visit(f.page,'https://www.linkedin.com/in/spa-fixture/',{onNavigationEvidence:value=>evidence.push(value)});
  assert.equal(evidence[0].method,'rendered-link');assert.equal(evidence[0].httpNavigation,false);
  assert.equal(evidence[0].referer,null);assert.equal(evidence[0].secFetchSite,null);assert.equal(evidence[0].headerSource,null);
  assert.equal(f.requests.filter(request=>request.path.startsWith('/in/')).length,documents,'same-document routing made no HTTP profile navigation');
 }finally{await f.close();}
});
