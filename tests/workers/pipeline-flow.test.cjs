'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createAccountRuntime}=require('../../src/lib/account-runtime.cjs');
test('bounded saves overlap the next capture without preclaiming its lock during the profile interval',async()=>{
 let unblock;const gate=new Promise(resolve=>{unblock=resolve;}),writes=[],captures=[],claims=[];
 const viewer={name:'Owner',profileUrl:'https://www.linkedin.com/in/owner/'},account={enabled:true,authorized:true,confirmed_identity:viewer,control_version:'start'};
 const jobs=[1,2].map(n=>({jobId:'job-'+n,linkedinUrl:'https://www.linkedin.com/in/coach-'+n+'/'}));let open=false;
 const runtime=createAccountRuntime({pool:{},accountId:'account',owner:'owner',saveQueueCapacity:2,
  browserOwner:{isOpen:()=>open,open:async()=>{open=true;return {page:{goto:async()=>{}},browser:{}};},close:async()=>{open=false;}},
  core:{readRuntimeAccount:async()=>account,processingAllowed:async()=>true,reserveLinkedInCheck:async()=>({}),
   claim:async()=>{const job=jobs.shift();claims.push(job?.jobId||null);return job?{job}:null;},
   checkpoint:async(_pool,id)=>{await gate;writes.push('checkpoint '+id);},pauseProcessing:async()=>{},releaseClaim:async()=>{}},
  reader:{inspected:async()=>({url:'https://www.linkedin.com/feed/'}),readSignedInIdentity:async()=>viewer,
   captureProfile:async(_page,url,options)=>{await options.beforeCheck('profile_page');const value={url,profileIdentityConfirmed:true,linkedinCapture:{version:2,complete:true},emails:[]};await options.onCheckpoint(value);captures.push(url);return value;}},
  researchQueue:{fullCapture:()=>false,handoff:async(_pool,id)=>writes.push('handoff '+id)},discoveryStore:{claimSource:async()=>null},
 });
 try{
  await runtime.tick();assert.equal(captures.length,1);assert.deepEqual(claims,['job-1']);assert.equal(writes.length,0);assert.equal(runtime.snapshot().pendingSaves,2);
  const second=runtime.tick();await new Promise(resolve=>setImmediate(resolve));assert.equal(captures.length,1,'The second checkpoint must wait for capacity');
  unblock();await second;await runtime.drain();
  assert.equal(captures.length,2);assert.deepEqual(writes,['checkpoint job-1','handoff job-1','checkpoint job-2','handoff job-2']);
 }finally{unblock();await runtime.close();}
});
