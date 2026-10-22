'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const core=require('../../src/lib/linkedin-workers.cjs');
const source=fs.readFileSync(require.resolve('../../worker.cjs'),'utf8');
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

function readFixture(statuses){
 const counted=[],calls=[];
 const context=vm.createContext({isShuttingDown:false,MANUAL_LOGIN_MODE:false,CHECK_LOGIN_MODE:false,prospectingContext:false,prospectingFailure:null,linkedinStop:null,checkDay:'',linkedinChecks:{},sessionChecks:{},ACCOUNT_ID:'one',
  dbWorker:{pool:{},owner:'owner',core:{reserveLinkedInCheck:async(_pool,id,owner,kind)=>{assert.equal(id,'one');assert.equal(owner,'owner');counted.push(kind);return {};}}}});
 const start=source.indexOf('async function recordLinkedInCheck('),end=source.indexOf('async function scrapeProfile(',start);
 const guard=vm.runInContext(source.slice(start,end)+';({reserve:recordLinkedInCheck,inspect:checkLinkedInAccess})',context);
 return {counted,calls,read:async kind=>{await guard.reserve(kind);calls.push(kind);guard.inspect(statuses.shift(),'https://www.linkedin.com/in/fixture/');}};
}

test('explicit page interactions are reserved and counted even when the resulting page is unavailable',async()=>{
 const f=readFixture([404,200,200,503]);
 for(const kind of ['contact','contact','profile_page','activity_page'])await f.read(kind);
 assert.deepEqual(f.counted,['contact','contact','profile_page','activity_page']);assert.equal(f.calls.length,4);
});

test('ordinary qualification stops after a restriction and cannot reserve the next page interaction',async()=>{
 for(const status of [401,403,429,999]){
  const f=readFixture([status,200]);
  await assert.rejects(f.read('contact'),error=>error.failure.retryable===false);
  await assert.rejects(f.read('profile_page'),error=>error.failure.retryable===false);
  assert.deepEqual(f.counted,['contact']);assert.equal(f.calls.length,1);
 }
});
