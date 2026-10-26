'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const core=require('../../src/lib/linkedin-workers.cjs');
const {createAccountRuntime}=require('../../src/lib/account-runtime.cjs');
const {pageSignal,failure:sessionFailure}=require('../../src/lib/linkedin-session-policy.cjs');
const person='https://www.linkedin.com/in/fixture-coach/';
const now=Date.parse('2026-10-20T10:00:00.000Z');
function capture(extra={}){return {url:person,profileIdentityConfirmed:true,linkedinCapturedAt:new Date(now-3600000).toISOString(),linkedinAccountId:'one',firstName:'Fixture',status:'PENDING',emails:[],linkedinContact:{accountId:'one',connection:'CONNECTED'},...extra};}

test('reuse is based on capture age, identity and source account; recently completed stale research is not fresh',()=>{
 const row={account_id:'one',checkpoint:capture(),completed_at:new Date(now).toISOString()};
 const saved=core.reusableLinkedInProfile(row,person,'one',now);
 assert.equal(saved.firstName,'Fixture');assert.equal(saved.linkedinContact.accountId,'one');
 saved.emails.push('changed@example.test');assert.equal(row.checkpoint.emails.length,0);
 for(const extra of [{linkedinCapturedAt:new Date(now-86400000).toISOString()},{linkedinCapturedAt:new Date(now+1).toISOString()},{url:'https://www.linkedin.com/in/someone-else/'},{profileIdentityConfirmed:false},{status:'ERROR'},{linkedinCapture:{version:2,stage:'contact',complete:false}}]){
  assert.equal(core.reusableLinkedInProfile({...row,checkpoint:capture(extra)},person,'one',now),null);
 }
 assert.equal(core.reusableLinkedInProfile(row,'invalid','one',now),null);
 const other=core.reusableLinkedInProfile(row,person,'two',now);
 assert.equal(other.firstName,'Fixture');assert.equal(other.linkedinContact,undefined,'another account must verify its own messaging route');
 const noTime=capture({linkedinCapturedAt:undefined});
 assert.equal(core.reusableLinkedInProfile({checkpoint:noTime},person,'one',now),null);
});

test('old follower-only cache stops cannot prevent newly eligible profiles from continuing',()=>{
 const row={account_id:'one',result:capture({decisionStage:'followers',followers:{count:700,rawText:'700 followers',threshold:1000}})};
 assert.equal(core.reusableLinkedInProfile(row,person,'one',now),null);
 row.result.followers={count:null,rawText:'\u200f1,119\u200f من المتابعين',threshold:1000};
 assert.equal(core.reusableLinkedInProfile(row,person,'one',now),null);
 row.result.followers={count:200,rawText:'200 followers',threshold:1000};
 assert.equal(core.reusableLinkedInProfile(row,person,'one',now).followers.count,200);
 delete row.result.decisionStage;row.result.followers.count=700;
 assert.equal(core.reusableLinkedInProfile(row,person,'one',now).followers.count,700,'complete website captures remain reusable');
});
function readFixture(statuses,allowance={}){
 const counted=[],calls=[],holds=[],sleeps=[];
 const runtime=createAccountRuntime({pool:{},accountId:'one',owner:'owner',now:()=>now,
  browserOwner:{isOpen:()=>false},reader:{},prospecting:{},researchQueue:{},
  discoveryStore:{pauseAccount:async()=>{}},sleep:async ms=>{sleeps.push(ms);},
  core:{processingAllowed:async()=>true,
   reserveLinkedInCheck:async(_pool,id,owner,kind,options)=>{assert.equal(id,'one');assert.equal(owner,'owner');counted.push({kind,...options});return allowance;},
   pauseProcessing:async(_pool,id,reason,attention,owner)=>{assert.equal(id,'one');assert.equal(owner,'owner');holds.push({reason,attention});},
  },
 });
 return {counted,calls,holds,sleeps,runtime,read:async kind=>{
  await runtime.permit(kind);calls.push(kind);
  const found=pageSignal({status:statuses.shift(),url:person});
  if(found){const failure=sessionFailure(found);await runtime.handleSignal(failure);throw Object.assign(Error(failure.reason),{failure});}
 }};
}

test('explicit page interactions are reserved and counted even when the resulting page is unavailable',async()=>{
 const f=readFixture([404,200,200,503]);
 for(const kind of ['contact','contact','profile_page','activity_page'])await f.read(kind);
 assert.deepEqual(f.counted.map(value=>value.kind),['contact','contact','profile_page','activity_page']);assert.equal(f.calls.length,4);
 assert.ok(f.counted.every(value=>value.manual===false));assert.deepEqual(f.holds,[]);
});

test('ordinary qualification stops after a restriction and cannot reserve the next page interaction',async()=>{
 for(const status of [401,403,429,999]){
  const f=readFixture([status,200]);
  await assert.rejects(f.read('contact'),error=>error.failure.retryable===false);
  await assert.rejects(f.read('profile_page'),error=>error.failure.retryable===false);
  assert.deepEqual(f.counted.map(value=>value.kind),['contact']);assert.equal(f.calls.length,1);
  assert.equal(f.holds.length,1);assert.equal(f.holds[0].attention,true);
 }
});

test('a manual menu check can decline a rest without sleeping or blocking later passive confirmation',async()=>{
 for(const permit of [{waitMs:60000},{stopped:true,reason:'Daily LinkedIn check budget reached.'}]) {
  const f=readFixture([],permit);
  if(permit.stopped)await assert.rejects(f.runtime.permit('identity',{manual:true}),error=>error.failure.code==='WORKER_PAUSED');else await f.runtime.permit('identity',{manual:true});
  assert.deepEqual(f.holds,[],'an unavailable menu interaction must not create an account restriction');
  assert.deepEqual(f.counted,[{kind:'identity',manual:true}]);assert.deepEqual(f.calls,[]);assert.deepEqual(f.sleeps,[]);
 }
});
