'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{createAccountRuntime}=require('../../src/lib/account-runtime.cjs');
test('AliasMode disconnection releases the job with checkpoints and does not create a lead REVIEW or spend a retry',async()=>{
 const account={enabled:true,authorized:true,control_version:'one',confirmed_identity:{name:'Owner',profileUrl:'https://www.linkedin.com/in/owner/'}};let open=false,checkpoint=null,released=0,deferred=0,completed=0;
 const runtime=createAccountRuntime({pool:{},accountId:'one',owner:'owner',browserOwner:{provider:'ALIASMODE',isOpen:()=>open,open:async()=>{open=true;return {page:{goto:async()=>{}},browser:{}};},close:async()=>{open=false;},adopt:async()=>{}},
 core:{readRuntimeAccount:async()=>account,processingAllowed:async()=>true,reserveLinkedInCheck:async()=>({}),claim:async()=>({job:{jobId:'job',linkedinUrl:'https://www.linkedin.com/in/person/',retryCount:0}}),checkpoint:async(_p,_id,_o,value)=>{checkpoint=value;},releaseClaim:async()=>released++,defer:async()=>deferred++,complete:async()=>completed++,pauseProcessing:async()=>{}},
 reader:{inspected:async()=>({url:'https://www.linkedin.com/feed/'}),readSignedInIdentity:async()=>account.confirmed_identity,captureProfile:async(_p,_u,o)=>{await o.onCheckpoint({profileIdentityConfirmed:true,linkedinCapture:{complete:false,stage:'profile'}});open=false;throw Error('Target closed');}},
 researchQueue:{fullCapture:()=>false},discoveryStore:{claimSource:async()=>null},
 });try{await runtime.tick();await runtime.drain();assert.equal(released,1);assert.equal(deferred,0);assert.equal(completed,0);assert.equal(checkpoint.linkedinCapture.stage,'profile');assert.equal(runtime.snapshot().status,'provider_unavailable');assert.equal(account.authorized,true);}finally{await runtime.close({preserveIntent:true});}
});
test('explicit profile closure preserves sign-in, the security hold and pending queue',async()=>{
 const account={enabled:false,authorized:false,attention_reason:'LinkedIn security review',close_token:'request',control_version:'close'},calls=[];
 const runtime=createAccountRuntime({pool:{},accountId:'one',owner:'owner',browserOwner:{isOpen:()=>false,stop:async()=>calls.push('provider.stop'),close:async()=>calls.push('disconnect')},core:{readRuntimeAccount:async()=>account,pauseProcessing:async()=>{}},reader:{},finishProfileClose:async()=>{calls.push('ack');return true;}});
 try{await runtime.tick();assert.deepEqual(calls,['provider.stop','ack']);assert.equal(runtime.snapshot().profileClosed,true);assert.equal(account.attention_reason,'LinkedIn security review');assert.equal(account.authorized,false);}finally{await runtime.close({preserveIntent:true});}
});

test('a LinkedIn restriction still persists its hold when CDP disconnects at the same time',async()=>{
 const account={enabled:true,authorized:true,control_version:'one',confirmed_identity:{name:'Owner',profileUrl:'https://www.linkedin.com/in/owner/'}};
 let open=false,held=false,deferred=0;const reason='LinkedIn returned HTTP 429.';
 const runtime=createAccountRuntime({pool:{},accountId:'one',owner:'owner',browserOwner:{provider:'ALIASMODE',isOpen:()=>open,open:async()=>{open=true;return {page:{goto:async()=>{}},browser:{}};},close:async()=>{open=false;}},
  core:{readRuntimeAccount:async()=>account,processingAllowed:async()=>true,reserveLinkedInCheck:async()=>({}),claim:async()=>({job:{jobId:'job',linkedinUrl:'https://www.linkedin.com/in/person/',retryCount:0}}),defer:async()=>deferred++,pauseProcessing:async(_p,_id,why,hold)=>{if(hold){held=true;assert.equal(why,reason);}}},
  reader:{inspected:async()=>({url:'https://www.linkedin.com/feed/'}),readSignedInIdentity:async()=>account.confirmed_identity,captureProfile:async()=>{open=false;throw Object.assign(Error(reason),{failure:{stage:'linkedin',code:'LINKEDIN_RATE_LIMIT',reason,retryable:false}});}},
  researchQueue:{fullCapture:()=>false},discoveryStore:{claimSource:async()=>null}});
 try{await runtime.tick();await runtime.drain();assert.equal(held,true);assert.equal(deferred,1);assert.equal(runtime.snapshot().manualResumeRequired,true);assert.notEqual(runtime.snapshot().status,'provider_unavailable');}
 finally{await runtime.close({preserveIntent:true});}
});
