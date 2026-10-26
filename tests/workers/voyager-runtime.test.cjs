'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createAccountRuntime}=require('../../src/lib/account-runtime.cjs'),reader=require('../../src/lib/linkedin-voyager-reader.cjs');
const url='https://www.linkedin.com/in/runtime-fixture/',urn='urn:li:fsd_profile:Fixture';
function fixture(failures){
 const viewer={name:'Owner',profileUrl:'https://www.linkedin.com/in/owner/'},account={enabled:true,authorized:true,confirmed_identity:viewer,control_version:'start'};
 let pending={jobId:'job',linkedinUrl:url,nativePostProcess:true,retryCount:0},open=false,closes=0,remaining=failures;
 const calls=[],writes=[],completed=[],handed=[];
 const runtime=createAccountRuntime({pool:{},accountId:'account',owner:'owner',
  browserOwner:{isOpen:()=>open,open:async()=>{open=true;return {page:{goto:async()=>{},url:()=> 'https://www.linkedin.com/feed/'},browser:{}};},close:async()=>{closes++;open=false;}},
  core:{readRuntimeAccount:async()=>account,processingAllowed:async()=>account.authorized,reserveLinkedInCheck:async()=>({}),
   claim:async()=>pending?{job:structuredClone(pending)}:null,releaseClaim:async()=>{},
   checkpoint:async(_pool,id,value)=>writes.push({type:'checkpoint',value:structuredClone(value)}),
   defer:async(_pool,id,owner,value)=>{writes.push({type:'defer',value:structuredClone(value)});pending={...pending,retryCount:pending.retryCount+1,resumeResult:structuredClone(value)};},
   complete:async(_pool,id,owner,value)=>{completed.push(structuredClone(value));pending=null;},
   saveCaptureReview:async(_pool,{capture})=>{writes.push({type:'review',value:structuredClone(capture)});return {id:'lead'};},
   pauseProcessing:async(_pool,id,reason,hold)=>{if(hold){account.authorized=false;account.attention_reason=reason;}},
  },
  reader:{...reader,inspected:async()=>({url:'https://www.linkedin.com/feed/'}),readSignedInIdentity:async()=>viewer,
   captureProfile:(page,person,options)=>reader.captureProfile(page,person,{...options,request:async(_page,kind)=>{
    calls.push(kind);
    if(kind==='profile')return {status:200,data:{data:{profile:{publicIdentifier:'runtime-fixture',entityUrn:urn,firstName:'Ava',lastName:'Morgan',locationName:'Canada',followerCount:2000}}}};
    if(kind==='activity'){
     if(remaining>0){remaining--;throw Object.assign(Error('Temporary transport failure'),{failure:{stage:'linkedin',code:'VOYAGER_TRANSPORT',reason:'Temporary transport failure',retryable:true}});}
     if(remaining===-1)throw Object.assign(Error('LinkedIn access restriction'),{failure:{stage:'linkedin',code:'LINKEDIN_AUTH',reason:'LinkedIn access restriction',retryable:false}});
     return {status:200,data:{data:{elements:[{actor:{profileUrn:urn},createdAt:Date.now()-1000}]}}};
    }
    return {status:200,data:{data:{emailAddress:'ava@practice.test',websites:[]}}};
   }}),
  },
  researchQueue:{fullCapture:()=>false,handoff:async(_pool,id,owner,capture)=>{handed.push(capture);pending=null;}},
  discoveryStore:{claimSource:async()=>null,pauseAccount:async()=>{}},
 });
 return {runtime,calls,writes,completed,handed,account,get closes(){return closes;},step:async()=>{await runtime.tick();await runtime.drain();}};
}
test('transient API failure resumes the persisted profile in the same browser and hands it off once',async()=>{
 const f=fixture(1);
 try{
  await f.step();assert.deepEqual(f.calls,['profile','activity']);assert.equal(f.closes,0);
  assert.deepEqual(f.writes.map(w=>w.type),['checkpoint','defer']);assert.equal(f.writes[1].value.linkedinCapture.stage,'profile');
  await f.step();assert.deepEqual(f.calls,['profile','activity','activity','contact']);assert.equal(f.handed.length,1);assert.equal(f.closes,0);
  assert.equal(f.handed[0].linkedinCapture.complete,true);assert.equal(f.completed.length,0);
 }finally{await f.runtime.close({preserveIntent:true});}
});
test('API transport retries exhaust after two retries and save terminal CRM REVIEW with the checkpoint',async()=>{
 const f=fixture(10);
 try{
  for(let n=0;n<4;n++)await f.step();
  assert.deepEqual(f.calls,['profile','activity','activity','activity']);assert.equal(f.closes,0);assert.equal(f.handed.length,0);
  assert.equal(f.writes.filter(w=>w.type==='defer').length,2);assert.equal(f.writes.filter(w=>w.type==='review').length,1);
  assert.equal(f.completed.length,1);assert.equal(f.completed[0].status,'REVIEW');assert.equal(f.completed[0].failure.retryable,false);assert.equal(f.completed[0].crmSaved,true);
  assert.equal(f.completed[0].followers.count,2000);assert.equal(f.completed[0].linkedinCapture.stage,'profile');
 }finally{await f.runtime.close({preserveIntent:true});}
});
test('an account restriction retains the exact hold and prevents the next API attempt',async()=>{
 const f=fixture(-1);
 try{
  await f.step();await f.step();await f.step();
  assert.deepEqual(f.calls,['profile','activity']);assert.equal(f.account.attention_reason,'LinkedIn access restriction');
  assert.equal(f.runtime.snapshot().manualResumeRequired,true);assert.equal(f.completed.length,0);assert.equal(f.handed.length,0);
 }finally{await f.runtime.close({preserveIntent:true});}
});
