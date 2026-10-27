'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{fixture}=require('./aliasmode-fixture.cjs'),reader=require('../../src/lib/linkedin-voyager-reader.cjs');
test('the old stealth/launch driver cannot be activated',()=>{assert.throws(()=>require('../../src/lib/account-browser-driver.cjs').createAccountDriver(),/AliasMode/);});
test('a real restored browser reads two leads by API on one feed document, without profile/activity/contact navigation',async()=>{
 const f=await fixture(),owner=f.create('one');
 const person='https://www.linkedin.com/in/voyager-fixture/',urn='urn:li:fsd_profile:ACoFixture',now=new Date().toISOString();
 try{
  const {page}=await owner.open({headless:true}),navigation=[],reads=[];
  await page.setRequestInterception(true);page.on('request',request=>{
   const url=new URL(request.url());if(request.isNavigationRequest())navigation.push(url.pathname);
   let data;
   if(url.origin!=='https://www.linkedin.com'){request.abort().catch(()=>{});return;}
   if(url.pathname==='/feed/'){request.respond({status:200,contentType:'text/html',body:'<!doctype html><main>Local owner-session fixture</main>'}).catch(()=>{});return;}
   if(!url.pathname.startsWith('/voyager/api/')){request.respond({status:204,body:''}).catch(()=>{});return;}
   reads.push(url.pathname);
   assert.equal(request.headers()['csrf-token'],'fixture-csrf-value');
   if(url.pathname.endsWith('/profileView'))data={data:{profile:{publicIdentifier:'voyager-fixture',entityUrn:urn,firstName:'Ava',lastName:'Morgan',locationName:'Toronto, Canada',followerCount:2345}}};
   else if(url.pathname.endsWith('/profileUpdatesV2'))data={data:{elements:[{actor:{profileUrn:urn},createdAt:Date.now()-86400000,commentary:{text:'Own recent fixture post'}}]}};
   else if(url.pathname.endsWith('/profileContactInfo'))data={data:{emailAddress:'ava@practice.test',websites:[]}};
   else {request.abort().catch(()=>{});return;}
   request.respond({status:200,contentType:'application/json',body:JSON.stringify(data)}).catch(()=>{});
  });
  await page.goto('https://www.linkedin.com/feed/',{waitUntil:'domcontentloaded'});
  await page.setCookie({name:'JSESSIONID',value:'"fixture-csrf-value"',domain:'.linkedin.com',secure:true});
  for(let n=0;n<2;n++){
   const checkpoints=[],result=await reader.captureProfile(page,person,{accountId:'fixture',now,requireTargetLocation:true,beforeCheck:async()=>{},onCheckpoint:async value=>checkpoints.push(value)});
   assert.equal(result.followers.count,2345);assert.equal(result.activityStatus,'Active');assert.equal(result.primaryEmail,'ava@practice.test');assert.equal(result.linkedinCapture.complete,true);
   assert.ok(!JSON.stringify({result,checkpoints}).includes('fixture-csrf-value'));
  }
  assert.deepEqual(navigation,['/feed/']);assert.equal(reads.length,6);assert.equal((await owner.open()).page,page);
 }finally{
  await f.close();
 }
});

// RETIRED LOCAL CHROME TESTS â€” retained as comments; AliasMode contracts replace these cases.
// 'use strict';
// const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
// const {createAccountBrowser}=require('../../src/lib/account-browser.cjs'),{createAccountDriver}=require('../../src/lib/account-browser-driver.cjs');
// const reader=require('../../src/lib/linkedin-voyager-reader.cjs');
// test('account drivers retain pinned Puppeteer and use isolated instances of the restored plugin',()=>{
//  const one=createAccountDriver(),two=createAccountDriver();
//  assert.equal(one.browserVersion,require('puppeteer').default.browserVersion);assert.equal(one.configuration.cacheDirectory,require('puppeteer').default.configuration.cacheDirectory);
//  assert.ok(one.plugins.some(p=>p.name==='stealth'));assert.notEqual(one.plugins.find(p=>p.name==='stealth'),two.plugins.find(p=>p.name==='stealth'));
// });
//
// test('plugin launch preserves the original AbortSignal so a cancelled startup remains cancelled',async()=>{
//  const controller=new AbortController();controller.abort();let observed;
//  const driver=createAccountDriver({defaultArgs:()=>[],executablePath:()=> 'fixture',launch:async options=>{observed=options.signal;options.signal.throwIfAborted();}});
//  await assert.rejects(driver.launch({signal:controller.signal,headless:true}),e=>e.name==='AbortError');
//  assert.equal(observed,controller.signal);
// });
// test('a real restored browser reads two leads by API on one feed document, without profile/activity/contact navigation',async()=>{
//  const root=fs.mkdtempSync(path.join(os.tmpdir(),'compel-voyager-browser-')),owner=createAccountBrowser({root,account:{profile_key:'fixture'},closeTimeoutMs:5000});
//  const person='https://www.linkedin.com/in/voyager-fixture/',urn='urn:li:fsd_profile:ACoFixture',now=new Date().toISOString();
//  try{
//   const {page}=await owner.open({headless:true}),navigation=[],reads=[];
//   await page.setRequestInterception(true);page.on('request',request=>{
//    const url=new URL(request.url());if(request.isNavigationRequest())navigation.push(url.pathname);
//    let data;
//    if(url.origin!=='https://www.linkedin.com'){request.abort().catch(()=>{});return;}
//    if(url.pathname==='/feed/'){request.respond({status:200,contentType:'text/html',body:'<!doctype html><main>Local owner-session fixture</main>'}).catch(()=>{});return;}
//    if(!url.pathname.startsWith('/voyager/api/')){request.respond({status:204,body:''}).catch(()=>{});return;}
//    reads.push(url.pathname);
//    assert.equal(request.headers()['csrf-token'],'fixture-csrf-value');
//    if(url.pathname.endsWith('/profileView'))data={data:{profile:{publicIdentifier:'voyager-fixture',entityUrn:urn,firstName:'Ava',lastName:'Morgan',locationName:'Toronto, Canada',followerCount:2345}}};
//    else if(url.pathname.endsWith('/profileUpdatesV2'))data={data:{elements:[{actor:{profileUrn:urn},createdAt:Date.now()-86400000,commentary:{text:'Own recent fixture post'}}]}};
//    else if(url.pathname.endsWith('/profileContactInfo'))data={data:{emailAddress:'ava@practice.test',websites:[]}};
//    else {request.abort().catch(()=>{});return;}
//    request.respond({status:200,contentType:'application/json',body:JSON.stringify(data)}).catch(()=>{});
//   });
//   await page.goto('https://www.linkedin.com/feed/',{waitUntil:'domcontentloaded'});
//   await page.setCookie({name:'JSESSIONID',value:'"fixture-csrf-value"',domain:'.linkedin.com',secure:true});
//   for(let n=0;n<2;n++){
//    const checkpoints=[],result=await reader.captureProfile(page,person,{accountId:'fixture',now,requireTargetLocation:true,beforeCheck:async()=>{},onCheckpoint:async value=>checkpoints.push(value)});
//    assert.equal(result.followers.count,2345);assert.equal(result.activityStatus,'Active');assert.equal(result.primaryEmail,'ava@practice.test');assert.equal(result.linkedinCapture.complete,true);
//    assert.ok(!JSON.stringify({result,checkpoints}).includes('fixture-csrf-value'));
//   }
//   assert.deepEqual(navigation,['/feed/']);assert.equal(reads.length,6);assert.equal((await(await owner.open()).browser.pages()).length,1);
//  }finally{
//   await owner.close();const target=path.resolve(root),parent=path.resolve(os.tmpdir());
//   if(path.dirname(target)!==parent||!path.basename(target).startsWith('compel-voyager-browser-'))throw Error('Unsafe fixture cleanup');
//   fs.rmSync(target,{recursive:true,force:true});
//  }
// });
//
