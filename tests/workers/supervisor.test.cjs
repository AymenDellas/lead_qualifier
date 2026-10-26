'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os');
const {createAgent}=require('../../src/lib/compel-agent.cjs');
function fixture(options={}){
 let time=100000,reads=0,acquires=0;
 const accounts=[{id:'one',enabled:true,authorized:false,attention_reason:'',control_version:'1'}],runtimes=[];
 const agent=createAgent({root:process.cwd(),pool:{query:async()=>({})},owner:'test-agent',now:()=>time,
  readControl:async()=>{reads++;return {active_count:1,accounts};},acquireAccount:async()=>{acquires++;return true;},
  core:{releaseSession:async()=>{}},onStage:()=>{},onHeartbeat:()=>{},
  runner:{runOnce:async()=>null,close:async()=>{}},
  createBrowser:()=>({profileDirectory:path.join(os.tmpdir(),'compel-agent-fixture-unused'),isOpen:()=>false,close:async()=>{}}),
  createRuntime:()=>{const state={jobsStarted:0,status:'ready'},runtime={state,ticks:0,recycles:[],stopped:false,tick:async()=>{runtime.ticks++;if(options.work)state.jobsStarted++;},snapshot:()=>state,requestStop:()=>{runtime.stopped=true;},close:async()=>{},recycle:async reason=>runtime.recycles.push(reason)};runtimes.push(runtime);return runtime;},
  ...options,
 });
 const settle=()=>new Promise(resolve=>setImmediate(resolve));
 return {agent,accounts,runtimes,settle,get reads(){return reads;},get acquires(){return acquires;},advance:ms=>{time+=ms;}};
}
test('one persistent agent creates account runtimes only for authorized work or explicit connection',async()=>{
 const f=fixture();await f.agent.step();await f.settle();assert.equal(f.acquires,0);
 f.accounts[0].authorized=true;f.agent.wake();await f.agent.step();await f.settle();assert.equal(f.acquires,1);assert.equal(f.runtimes[0].ticks,1);
 f.accounts[0].authorized=false;f.agent.wake();await f.agent.step();await f.settle();assert.equal(f.acquires,1,'pause keeps the runtime in this process');
 await f.agent.close();assert.equal(f.runtimes[0].stopped,true);
});
test('review holds survive startup; explicit manual review can acquire its runtime',async()=>{
 const f=fixture();f.accounts[0].authorized=true;f.accounts[0].attention_reason='Security warning';
 await f.agent.step();assert.equal(f.acquires,0);
 f.accounts[0].login_token='manual-review';f.agent.wake();await f.agent.step();await f.settle();assert.equal(f.acquires,1);assert.equal(f.accounts[0].attention_reason,'Security warning');await f.agent.close();
});
test('unverified lease failure shows its stage and exact action and waits for an explicit new command',async()=>{
 let tries=0;const f=fixture({acquireAccount:async()=>{tries++;throw Error('Old owner cannot be verified');}});f.accounts[0].authorized=true;
 await f.agent.step();assert.equal(f.agent.stages.one.startupStage,'FAILED');assert.match(f.agent.stages.one.reason,/cannot be verified/);assert.ok(f.agent.stages.one.action);
 f.agent.wake();await f.agent.step();assert.equal(tries,1);f.accounts[0].control_version='2';f.agent.wake();await f.agent.step();assert.equal(tries,2);await f.agent.close();
});
test('idle database reads back off and notifications wake the same process',async()=>{
 const f=fixture();await f.agent.step();await f.settle();const reads=f.reads;f.advance(2000);await f.agent.step();assert.equal(f.reads,reads);
 f.agent.wake();await f.agent.step();assert.equal(f.reads,reads+1);await f.agent.close();
});
test('more than 50 jobs continue without a manual restart or new account process',async()=>{
 const f=fixture({work:true});f.accounts[0].authorized=true;
 for(let i=0;i<65;i++){f.agent.wake();await f.agent.step();await f.settle();}
 assert.equal(f.acquires,1);assert.equal(f.runtimes[0].state.jobsStarted,65);await f.agent.close();
});
test('profile interval waits keep the saved browser alive and do not spin or hold the public lane',async()=>{
 const state={jobsStarted:0,status:'sleeping',reasonCode:'PROFILE_INTERVAL',nextEligibleAt:new Date(160000).toISOString()};
 let ticks=0,recycles=0,publicTicks=0;
 const f=fixture({createBrowser:()=>({profileDirectory:path.join(os.tmpdir(),'compel-gap-fixture-unused'),isOpen:()=>true,isHeadless:()=>true,close:async()=>{}}),
  createRuntime:()=>({tick:async()=>{ticks++;},snapshot:()=>state,recycle:async()=>{recycles++;},requestStop:()=>{},close:async()=>{}}),
  runner:{runOnce:async()=>{publicTicks++;return null;},close:async()=>{}}});
 f.accounts[0].authorized=true;await f.agent.step();await f.settle();assert.equal(ticks,1);
 f.advance(40000);await f.agent.step();await f.settle();assert.equal(ticks,1,'no repeated capture claims before next_profile_at');assert.ok(publicTicks>=4,'public lanes continue during the interval');
 f.agent.wake();await f.agent.step();await f.settle();assert.equal(recycles,0,'the 30-second idle threshold must not relaunch Chrome between every profile');
 await f.agent.close();
});
test('all eligible accounts capture simultaneously while slow work, pauses and review holds remain account-scoped',async()=>{
 let release;const gate=new Promise(resolve=>{release=resolve;}),started=[],completed=[];
 const f=fixture({createBrowser:({account})=>{let open=false;return {profileDirectory:path.join(os.tmpdir(),'compel-parallel-'+account.id),isOpen:()=>open,
  open:async()=>{open=true;return {browser:{process:()=>null}};},close:async()=>{open=false;}};},
  createRuntime:({accountId,browserOwner})=>{const state={status:'ready',jobsStarted:0};return {snapshot:()=>state,requestStop:()=>{},close:()=>browserOwner.close(),recycle:()=>browserOwner.close(),tick:async()=>{
   await browserOwner.open();started.push(accountId);await gate;state.jobsStarted++;completed.push(accountId);
  }};}});
 f.accounts.splice(0,1,...['one','two','three'].map(id=>({id,enabled:true,authorized:true,attention_reason:'',control_version:'1'})),
  {id:'held',enabled:true,authorized:true,attention_reason:'Security review',control_version:'1'},
  {id:'paused',enabled:true,authorized:false,attention_reason:'',control_version:'1'});
 try{
  await f.agent.step();await f.settle();assert.deepEqual(started.sort(),['one','three','two']);
  assert.equal(f.agent.coordinator.reserved.size,3);assert.equal(completed.length,0,'no account must wait for another profile to finish');
  assert.equal(f.agent.entries.has('held'),false);assert.equal(f.agent.entries.has('paused'),false);
  release();await f.settle();assert.equal(completed.length,3);
 }finally{release();await f.agent.close();}
});
test('a manual request does not recycle other account browsers when there is free capacity',async()=>{
 const recycles=[];
 const f=fixture({createBrowser:({account})=>{let open=false;return {profileDirectory:path.join(os.tmpdir(),'compel-free-slot-'+account.id),isOpen:()=>open,
  open:async()=>{open=true;return {browser:{process:()=>null}};},close:async()=>{open=false;}};},
  createRuntime:({accountId,browserOwner})=>({snapshot:()=>({status:'ready',jobsStarted:0}),requestStop:()=>{},close:()=>browserOwner.close(),
   tick:()=>browserOwner.open(),recycle:async reason=>{recycles.push({accountId,reason});await browserOwner.close();}})});
 f.accounts[0].authorized=true;f.accounts.push({id:'two',enabled:true,authorized:false,attention_reason:'',login_token:'manual',control_version:'1'});
 try{await f.agent.step();await f.settle();assert.equal(f.agent.coordinator.reserved.size,2);assert.deepEqual(recycles,[]);}finally{await f.agent.close();}
});
test('a slow account statistics flush cannot postpone other accounts lease heartbeats',async()=>{
 let release;const gate=new Promise(resolve=>{release=resolve;}),heartbeats=[];
 const f=fixture({core:{releaseSession:async()=>{},heartbeat:async(_pool,id)=>heartbeats.push(id)},
  createRuntime:({accountId})=>({tick:async()=>{},snapshot:()=>({status:'ready'}),flush:()=>accountId==='one'?gate:Promise.resolve(),requestStop:()=>{},close:async()=>{}})});
 f.accounts[0].authorized=true;f.accounts.push({id:'two',enabled:true,authorized:true,attention_reason:'',control_version:'1'});
 try{
  await f.agent.step();await f.settle();const pending=f.agent.heartbeat();await f.settle();
  assert.deepEqual(heartbeats.sort(),['one','two']);release();await pending;
 }finally{release();await f.agent.close();}
});
