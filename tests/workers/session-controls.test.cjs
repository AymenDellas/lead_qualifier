'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),checks=require('../../src/lib/stealth-self-test.cjs'),humanizer=require('../../src/lib/session-humanizer.cjs');
test('diagnostic landing pages, missing TLS/CDP evidence and transport failures never pass',()=>{
 const base={url:checks.URLS[0],status:200,probe:{webdriver:false,userAgent:'Chrome/155'}};
 assert.equal(checks.assessSite({...base,text:'100% authentic; cdpDetected:false'}).verdict,'UNKNOWN');
 assert.equal(checks.assessSite({...base,result:{webdriverDetected:false,headlessDetected:false}}).verdict,'UNKNOWN');
 assert.equal(checks.assessSite({...base,status:502,result:{}}).verdict,'UNKNOWN');
 assert.equal(checks.assessSite({...base,status:502,probe:{webdriver:true,userAgent:'Chrome/155'}}).verdict,'FAIL');
 const result={webdriverDetected:false,headlessDetected:false,cdpDetected:false,tlsMismatch:false};
 assert.equal(checks.assessSite({...base,result}).verdict,'PASS');assert.equal(checks.assessSite({...base,result:{...result,cdpDetected:true}}).verdict,'FAIL');
});
test('restriction classification preserves the actual profile-volume notice',()=>{
 const {pageSignal}=require('../../src/lib/linkedin-session-policy.cjs'),notice='We restricted your account because we detected that over time, it has accessed an unusually high volume of LinkedIn profile data.';
 const signal=pageSignal({url:'https://www.linkedin.com/checkpoint/',text:notice});assert.equal(signal.code,'LINKEDIN_AUTH');assert.ok(signal.reason.includes(notice));
 assert.equal(pageSignal({url:'https://example.test/',text:notice}),null);
});
test('bounded pointer/scroll actions never click, submit or navigate, and a pause prevents subsequent work',async()=>{
 const calls=[];const page={url:()=> 'https://www.linkedin.com/feed/',mouse:{move:async()=>calls.push('move'),click:()=>assert.fail('No incidental clicks')},goto:()=>assert.fail('No incidental navigation'),evaluate:async(fn,arg)=>{if(arg===undefined)return{width:1200,height:800};calls.push('scroll');}};
 let active=true;const assertActive=async()=>{if(!active)throw Error('Paused');};
 await humanizer.interact(page,{assertActive,random:a=>a});assert.deepEqual(calls,['move','scroll']);
 page.mouse.move=async()=>{active=false;};await assert.rejects(humanizer.interact(page,{assertActive,random:a=>a}),/Paused/);assert.equal(calls.length,2);
 await assert.rejects(humanizer.visit(page,'https://attacker.test/in/person/'),/canonical/);
});
test('warmup releases the claim without Voyager, research handoff or a qualification decision',async()=>{
 const {createAccountRuntime}=require('../../src/lib/account-runtime.cjs');let released=0,visited=0,open=false;
 const identity={name:'Owner',profileUrl:'https://www.linkedin.com/in/owner/'},a={id:'one',enabled:true,authorized:true,control_version:'one',confirmed_identity:identity,launch_mode:'headful',session_policy:{},session_evidence:{}};
 const runtime=createAccountRuntime({pool:{},accountId:'one',owner:'owner',browserOwner:{isOpen:()=>open,isHeadless:()=>false,open:async()=>{open=true;return{page:{goto:async()=>{}},browser:{}};},close:async()=>{open=false;},adopt:async()=>{}},
  core:{readRuntimeAccount:async()=>a,processingAllowed:async()=>true,reserveLinkedInCheck:async()=>({}),claim:async()=>({job:{jobId:'job',linkedinUrl:'https://www.linkedin.com/in/target/'}}),releaseClaim:async()=>released++,pauseProcessing:async()=>{}},
  sessionGuard:{state:()=>({state:'WARMUP'}),verify:async()=>true,warmup:async()=>{visited++;return{visited:true};}},
  reader:{inspected:async()=>({url:'https://www.linkedin.com/feed/'}),readSignedInIdentity:async()=>identity,captureProfile:()=>assert.fail('Warmup cannot call Voyager')},
  discoveryStore:{claimSource:()=>assert.fail('No discovery during warmup')},researchQueue:{fullCapture:()=>false,handoff:()=>assert.fail('No qualification during warmup')},
 });try{await runtime.tick();assert.equal(visited,1);assert.equal(released,1);assert.equal(runtime.snapshot().status,'WARMUP');assert.equal(runtime.snapshot().jobsStarted,0);}finally{await runtime.close({preserveIntent:true});}
});
test('unverified session releases its lock without opening the browser or discarding its job',async()=>{
 const {createAccountRuntime}=require('../../src/lib/account-runtime.cjs');let released=0;
 const a={enabled:true,authorized:true,control_version:'one',session_evidence:{}};
 const runtime=createAccountRuntime({pool:{},accountId:'one',owner:'owner',browserOwner:{isOpen:()=>false,open:()=>assert.fail('No unverified browser launch'),close:async()=>{}},
  core:{readRuntimeAccount:async()=>a,processingAllowed:async()=>true,claim:async()=>({job:{jobId:'job',linkedinUrl:'https://www.linkedin.com/in/target/'}}),releaseClaim:async()=>released++,pauseProcessing:async()=>{}},
  sessionGuard:{state:()=>({state:'PROVISION',reason:'Proxy required'})},reader:{},discoveryStore:{claimSource:()=>assert.fail('No discovery before admission')},researchQueue:{fullCapture:()=>false},
 });try{await runtime.tick();assert.equal(released,1);assert.equal(runtime.snapshot().reason,'Proxy required');}finally{await runtime.close({preserveIntent:true});}
});
test('a failed diagnostic launch is recorded once and requires an explicit new request',async()=>{
 const {createAccountRuntime}=require('../../src/lib/account-runtime.cjs');let attempts=0,recorded=0;
 const a={enabled:true,authorized:false,control_version:'one',session_evidence:{command:'diagnostics'}};
 const runtime=createAccountRuntime({pool:{},accountId:'one',owner:'owner',browserOwner:{isOpen:()=>false,open:async()=>{attempts++;throw Error('Fixture launch failure');},close:async()=>{}},
  core:{readRuntimeAccount:async()=>a},sessionGuard:{failCommand:async(_a,error)=>{assert.match(error.message,/launch failure/);recorded++;a.session_evidence.command=null;}},
 });try{await runtime.tick();assert.equal(runtime.snapshot().reasonCode,'SESSION_DIAGNOSTICS_FAILED');await runtime.tick();assert.equal(attempts,1);assert.equal(recorded,1);}finally{await runtime.close({preserveIntent:true});}
});
