'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{fixture}=require('./aliasmode-fixture.cjs');
test('real CDP switches headless to visible to headless, preserving the same profile cookie',async()=>{
 const f=await fixture(),owner=f.create('one');try{
  let surface=await owner.open();assert.equal(surface.browser.process(),null);assert.equal(owner.pid(),f.browsers.get('one').process().pid);assert.equal(owner.isHeadless(),true);
  await surface.page.setCookie({name:'fixture-session',value:'retained',domain:'example.test',secure:true,httpOnly:true});
  await owner.close();surface=await owner.open({headless:false});assert.equal(owner.isHeadless(),false);assert.equal((await surface.page.cookies('https://example.test')).find(c=>c.name==='fixture-session')?.value,'retained');
  await owner.close();surface=await owner.open();assert.equal(owner.isHeadless(),true);assert.equal((await surface.page.cookies('https://example.test')).find(c=>c.name==='fixture-session')?.value,'retained');
 }finally{await f.close();}
});
// RETIRED LOCAL CHROME TESTS â€” retained as comments; AliasMode contracts replace these cases.
// 'use strict';
// const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
// const {createAccountBrowser}=require('../../src/lib/account-browser.cjs');
// test('Chrome for Testing switches headless/manual/headless with one saved profile and cookies; no network requests',async()=>{
//  const root=fs.mkdtempSync(path.join(os.tmpdir(),'compel-mode-test-')),owner=createAccountBrowser({root,account:{profile_key:'fixture'},closeTimeoutMs:5000});
//  try{
//   const first=await owner.open();assert.equal(owner.isHeadless(),true);assert.equal(await owner.reveal(),false);
//   assert.ok(first.browser.process().spawnargs.some(a=>a.startsWith('--headless')));
//   await first.page.setRequestInterception(true);let requests=0;
//   first.page.on('request',r=>{if(r.isNavigationRequest())requests++;r.respond({status:200,contentType:'text/html',body:'<main>Local rendered fixture</main>'}).catch(()=>{});});
//   await first.page.goto('https://example.test/');assert.equal(await first.page.$eval('main',e=>e.textContent),'Local rendered fixture');assert.equal(requests,1);
//   await first.page.setCookie({name:'fixture-session',value:'retained',domain:'example.test',secure:true,httpOnly:true});
//   const directory=owner.profileDirectory;await owner.close();const manual=await owner.open({headless:false});
//   assert.equal(owner.isHeadless(),false);assert.equal(owner.profileDirectory,directory);assert.ok(!manual.browser.process().spawnargs.some(a=>a.startsWith('--headless')));
//   assert.equal((await manual.page.cookies('https://example.test/')).find(c=>c.name==='fixture-session')?.value,'retained');
//   await owner.close();const resumed=await owner.open();assert.equal(owner.isHeadless(),true);
//   assert.equal((await resumed.page.cookies('https://example.test/')).find(c=>c.name==='fixture-session')?.value,'retained');
//  }finally{
//   await owner.close();const target=path.resolve(root),parent=path.resolve(os.tmpdir());
//   if(path.dirname(target)!==parent||!path.basename(target).startsWith('compel-mode-test-'))throw Error('Unsafe fixture cleanup path');
//   fs.rmSync(target,{recursive:true,force:true});
//  }
// });
//
