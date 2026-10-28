'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./aliasmode-fixture.cjs'),checks=require('../../src/lib/stealth-self-test.cjs'),policy=require('../../src/lib/account-session-policy.cjs'),humanizer=require('../../src/lib/session-humanizer.cjs');
test('visible CDP fixtures retain one tab/mode and detect observed fingerprint drift; every request is intercepted',async()=>{
 const f=await fixture();try{
  const owner=f.create('session-controls'),surface=await owner.open({headless:false}),page=surface.page,requests=[];
  await page.setRequestInterception(true);page.on('request',r=>{requests.push(r.url());void r.respond({status:200,contentType:'text/html',body:'<!doctype html><title>Local session fixture</title><body style="height:2400px"><main>Intercepted fixture. No live LinkedIn request.</main></body>'});});
  const first=await checks.identityProbe(page),baseline=policy.fingerprint(first,{profileId:'fixture',mode:'headful'});assert.equal(first.secureContext,true);assert.equal(new URL(first.origin).hostname,'browserscan.net');
  assert.equal((await owner.open({headless:false})).page,page);assert.equal(owner.isHeadless(),false);
  await page.evaluate(()=>Object.defineProperty(navigator,'language',{configurable:true,get:()=> 'xx-fixture-drift'}));
  assert.notEqual(policy.fingerprint(await checks.probe(page),{profileId:'fixture',mode:'headful'}).hash,baseline.hash);
  await page.goto('https://www.linkedin.com/feed/',{waitUntil:'domcontentloaded'});await humanizer.interact(page,{random:a=>a});assert.ok(await page.evaluate(()=>scrollY)>0);
  await humanizer.visit(page,'https://www.linkedin.com/in/fixture-only/');assert.ok(requests.every(url=>/^https:\/\/www\.linkedin\.com\/(?:feed|in\/fixture-only)/.test(url)||url.startsWith('https://browserscan.net/')||url.endsWith('/favicon.ico')));
 }finally{await f.close();}
});
