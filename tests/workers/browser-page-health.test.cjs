'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const health=require('../../src/lib/linkedin-page-health.cjs'),reader=require('../../src/lib/linkedin-browser-page.cjs'),human=require('../../src/lib/session-humanizer.cjs');
const person='https://www.linkedin.com/in/fixture-person/';

test('generic server failures and 200-status fallback pages are availability failures, with no account-security verdict',()=>{
 for(const [url,status] of [[person,500],[person,503],['https://www.linkedin.com/error_pages/500.html?lang=ar',200]]){
  const error=health.unavailable({url,status});assert.equal(error.failure.stage,'page');assert.equal(error.failure.code,'LINKEDIN_PAGE_UNAVAILABLE');assert.equal(error.failure.retryable,false);
 }
 assert.equal(health.unavailable({url:person,status:200}),null);assert.equal(health.unavailable({url:'https://example.test/error_pages/500.html',status:500}),null);
 assert.equal(health.unavailable({url:'bad URL',status:500}),null);
});
test('unavailable pages avoid profile interpretation, while security responses and rendered warnings retain precedence',async()=>{
 const page={url:()=>person,evaluate:async fn=>{assert.ok(!fn.toString().includes('cloneNode'),'Do not interpret unavailable profile content');return{url:person,title:'Fixture',notice:''};}};
 await assert.rejects(reader.inspected(page,{}, {status:()=>500}),e=>e.failure.stage==='page'&&e.failure.code==='LINKEDIN_PAGE_UNAVAILABLE');
 for(const status of [401,403,429,999])await assert.rejects(reader.inspected(page,{}, {status:()=>status}),e=>e.failure.stage==='linkedin');
 await assert.rejects(reader.inspected({...page,url:()=> 'https://www.linkedin.com/checkpoint/challenge/'},{},{status:()=>500}),e=>e.failure.stage==='linkedin');
 await assert.rejects(reader.inspected({...page,url:()=> 'https://www.linkedin.com/error_pages/500.html'}),e=>e.failure.stage==='page');
 await assert.rejects(reader.inspected({...page,evaluate:async()=>({url:person,title:'LinkedIn',notice:'Verify your identity'})},{},{status:()=>500}),e=>e.failure.stage==='linkedin'&&e.failure.code==='LINKEDIN_AUTH');
});
test('a successful rendered snapshot is unchanged, and a fallback reached during inspection is still rejected',async()=>{
 const state={url:person,title:'Fixture',notice:'',html:'<main>Fixture</main>'};
 assert.equal(await reader.inspected({url:()=>person,evaluate:async()=>state}),state);
 await assert.rejects(reader.inspected({url:()=>person,evaluate:async()=>({...state,url:'https://www.linkedin.com/error_pages/500.html'})}),e=>e.failure.code==='LINKEDIN_PAGE_UNAVAILABLE');
});
test('a warmup destination must be the selected canonical member, not another member or fallback',()=>{
 health.assertProfile(person,person);health.assertProfile(person.slice(0,-1),person);
 assert.throws(()=>health.assertProfile('https://www.linkedin.com/in/other/',person),e=>e.failure.code==='WARMUP_REDIRECT');
 assert.throws(()=>health.assertProfile('https://www.linkedin.com/error_pages/500.html',person),e=>e.failure.code==='LINKEDIN_PAGE_UNAVAILABLE');
});
test('scrolling does not wait for an animation frame that the page never schedules',async()=>{
 const calls=[],page={url:()=>person,mouse:{move:async()=>calls.push('pointer')},evaluate:async(fn,arg)=>vm.runInNewContext('('+fn.toString()+')(arg)',{arg,innerWidth:1200,innerHeight:800,scrollBy:()=>calls.push('scroll'),requestAnimationFrame:()=>assert.fail('A suspended frame must not hang the browser command')})};
 await human.interact(page,{random:a=>a});assert.deepEqual(calls,['pointer','scroll']);
});
test('rendered visit retains its navigation response for the caller to classify',async()=>{
 const response={status:()=>503};let active=0;assert.equal(await human.visit({$$:async()=>[],waitForNavigation:async options=>{assert.equal(options.waitUntil,'load');return response;},evaluate:async()=>{},waitForFunction:async()=>{},goto:()=>assert.fail('Profile navigation cannot use goto')},person,{assertActive:async()=>active++}),response);assert.ok(active>=2);
});
test('ordinary warmup cannot save an observed day for a failed page',async()=>{
 const guard=require('../../src/lib/account-session-guard.cjs').createSessionGuard({pool:{query:()=>assert.fail('No evidence write for an unavailable page')},owner:'fixture',core:{reserveProfile:async()=>({nextProfileAt:new Date().toISOString()})}});
 const response={status:()=>500},page={$$:async()=>[],waitForNavigation:async()=>response,evaluate:async()=>{},waitForFunction:async()=>{},url:()=>person};
 await assert.rejects(guard.warmup({id:'one',session_evidence:{},session_policy:{}},{linkedinUrl:person,jobId:'job'},page,async()=>{},async r=>assert.equal(r,response)),e=>e.failure.stage==='page');
});
