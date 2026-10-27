'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{fixture}=require('./aliasmode-fixture.cjs');
test('three independently attached profile sessions coexist and recycling one preserves its siblings',async()=>{const f=await fixture(),owners=['one','two','three'].map(id=>f.create(id));try{const surfaces=await Promise.all(owners.map(o=>o.open()));for(let i=0;i<3;i++)await surfaces[i].page.setCookie({name:'fixture-session',value:String(i),domain:'example.test',secure:true});assert.equal(new Set(owners.map(o=>o.pid())).size,3);await owners[0].adopt();await owners[0].recycle();assert.ok(owners.slice(1).every(o=>o.isOpen()));const reopened=await owners[0].open();assert.equal((await reopened.page.cookies('https://example.test')).find(c=>c.name==='fixture-session')?.value,'0');for(let i=1;i<3;i++)assert.equal((await surfaces[i].page.cookies('https://example.test')).find(c=>c.name==='fixture-session')?.value,String(i));}finally{await f.close();}});
// RETIRED LOCAL CHROME TESTS â€” retained as comments; AliasMode contracts replace these cases.
// 'use strict';
// const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
// const {createAccountBrowser}=require('../../src/lib/account-browser.cjs');
// const {createBrowserCoordinator}=require('../../src/lib/browser-coordinator.cjs');
// const {createSampler}=require('../../src/lib/engine-process-metrics.cjs');
// test('three real headless account browsers coexist with isolated persistent cookies and one tab each',async()=>{
//  const root=fs.mkdtempSync(path.join(os.tmpdir(),'compel-parallel-browsers-')),manager=createBrowserCoordinator({owner:'fixture'});
//  const browsers=[1,2,3].map(n=>manager.wrap('account-'+n,createAccountBrowser({root,account:{profile_key:'fixture-'+n},closeTimeoutMs:5000})));
//  const sample=createSampler();
//  try{
//   const surfaces=await Promise.all(browsers.map(browser=>browser.open({headless:true})));
//   assert.equal(manager.reserved.size,3);assert.equal(new Set(browsers.map(b=>b.pid())).size,3);
//   let allLoaded;const loaded=new Promise(resolve=>{allLoaded=resolve;}),requests=[];
//   await Promise.all(surfaces.map(async(surface,i)=>{
//    assert.equal(browsers[i].isHeadless(),true);
//    await surface.page.setRequestInterception(true);
//    surface.page.on('request',async request=>{
//     if(!request.isNavigationRequest()){await request.respond({status:204,body:''}).catch(()=>{});return;}
//     requests.push(i);if(requests.length===3)allLoaded();await loaded;
//     await request.respond({status:200,contentType:'text/html',body:'<main>Account '+(i+1)+'</main>'}).catch(()=>{});
//    });
//    await surface.page.goto('https://example.test/',{waitUntil:'domcontentloaded',timeout:15000});
//    await surface.page.setCookie({name:'account-fixture',value:String(i+1),domain:'example.test',secure:true,httpOnly:true});
//   }));
//   assert.equal(requests.length,3,'all three page requests complete before any account releases its browser');
//   for(const [i,surface]of surfaces.entries()){
//    assert.equal((await surface.page.cookies('https://example.test/')).find(c=>c.name==='account-fixture')?.value,String(i+1));
//    assert.equal((await surface.browser.pages()).length,1);
//   }
//   const resources=await sample();assert.equal(resources.chromeRoots.length,3);
//   await browsers[0].close();assert.equal(manager.reserved.size,2);assert.ok(browsers.slice(1).every(b=>b.isOpen()),'recycling one account leaves the other two open');
//   const reopened=await browsers[0].open({headless:true});
//   assert.equal((await reopened.page.cookies('https://example.test/')).find(c=>c.name==='account-fixture')?.value,'1');
//   const directory=path.resolve(__dirname,'../../data/engine-v2/parallel-accounts');fs.mkdirSync(directory,{recursive:true});
//   fs.writeFileSync(path.join(directory,'browser-fixture-resources.json'),JSON.stringify({at:new Date().toISOString(),fixtureOnly:true,resources},null,2));
//  }finally{
//   const results=await Promise.allSettled(browsers.map(b=>b.close()));
//   if(results.some(r=>r.status==='rejected'))throw Error('An owned fixture browser did not close; its profile has been preserved.');
//   const target=path.resolve(root),parent=path.resolve(os.tmpdir());
//   if(path.dirname(target)!==parent||!path.basename(target).startsWith('compel-parallel-browsers-'))throw Error('Unsafe fixture cleanup path');
//   fs.rmSync(target,{recursive:true,force:true});
//  }
// });
// 
