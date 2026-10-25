'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {researchProspect}=require('../../src/lib/prospect-research.cjs');
const url='https://www.linkedin.com/in/ava-coach/';
const input=()=>({linkedinUrl:url,firstName:'Ava',lastName:'Coach',headline:'Executive coach',about:'Ava Coach is an independent executive coach.',profileIdentityConfirmed:true,
 followers:{count:2500,rawText:'2,500 followers',checkedAt:new Date().toISOString()},lastActivityAt:new Date().toISOString(),activityStatus:'Active',website:'https://ava.test/',websiteSource:'contact_modal'});
const html=(email='')=>'<h1>Ava Coach executive coaching</h1><p>'+('Ava Coach runs this coaching practice and helps executive clients. '.repeat(4))+'</p>'+email+['/contact','/about','/services','/blog','/more'].map(path=>'<a href="'+path+'">'+path+'</a>').join('');
test('attributable email stops a site as soon as qualification evidence is sufficient',async()=>{
 const requests=[];
 const r=await researchProspect(input(),{ai:false,fetchPage:async value=>{requests.push(value);return {url:value,html:html('<a href="mailto:ava@ava.test">Contact Ava Coach</a>')};}});
 assert.equal(requests.length,1);assert.equal(r.crawl.evidenceSufficient,true);assert.equal(r.crawl.retryable,false);assert.ok(r.contacts.some(c=>c.address==='ava@ava.test'));
});
test('total page/attempt budget retains pending routes as terminal review evidence',async()=>{
 const requests=[];
 const r=await researchProspect(input(),{ai:false,maxPages:2,fetchPage:async value=>{requests.push(value);return {url:value,html:html()};}});
 assert.equal(requests.length,2);assert.equal(r.crawl.complete,false);assert.equal(r.crawl.retryable,false);assert.equal(r.crawl.budgetExhausted,true);assert.ok(r.crawl.pending.length>0);
 const second=await researchProspect(input(),{ai:false,maxPages:2,previousResearch:r,fetchPage:async()=>assert.fail('No further routes beyond the persistent budget')});
 assert.equal(second.crawl.retryable,false);
});
test('non-retryable website failure never falls through to a browser or another fetch',async()=>{
 let reads=0;
 const r=await researchProspect(input(),{ai:false,fetchPage:async()=>{reads++;throw Object.assign(Error('HTTP 403'),{httpStatus:403});},renderPage:async()=>assert.fail('Forbidden retry through browser')});
 assert.equal(reads,1);assert.equal(r.crawl.retryable,false);assert.equal(r.crawl.complete,false);
});
test('a final activity or follower decision never starts website research',async()=>{
 for(const stage of ['followers','activity']){
  const r=await researchProspect({...input(),decisionStage:stage},{ai:false,fetchPage:async()=>assert.fail('Final decision cannot crawl')});assert.equal(r.pages.length,0);
 }
});
