'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {createAccountRuntime}=require('../../src/lib/account-runtime.cjs');
const {createResearchRunner}=require('../../src/lib/worker-research-runner.cjs');
const {fullCapture}=require('../../src/lib/worker-research-queue.cjs');

const viewer={name:'Fixture Member',profileUrl:'https://www.linkedin.com/in/session-race-member/'};
const person='https://www.linkedin.com/in/session-race-prospect/';
const feed='https://www.linkedin.com/feed/';
const restriction={stage:'linkedin',code:'LINKEDIN_AUTH',reason:'A new account restriction arrived during confirmation.',retryable:false};
function fixture(){
 let open=false,disconnectedEntry=false,version=1,runActive=true,url=feed,queuedJob=null,source=null;
 const hooks={open:async()=>{},identity:async()=>viewer,confirm:async()=>{},complete:async()=>{},sleep:async()=>{},
  capture:async(_page,target,settings)=>{await settings.beforeCheck('profile_page');return {url:target,profileIdentityConfirmed:true,linkedinCapture:{complete:true},emails:[],logs:[]};},
  allowance:async()=>({}),discover:async()=>({}),
 };
 const account={id:'fixture-account',enabled:true,authorized:false,login_token:'connect-1',logout_token:null,
  confirmed_identity:viewer,attention_reason:'',processing_until:null,
  control_version:'2026-10-24T10:00:01.000Z',changed_at:'2026-10-24T10:00:01.000Z'};
 const calls={order:[],navigations:[],holds:[],pauses:[],confirmations:[],handoffs:[],deferred:[],completed:[],
  interactions:[],permits:[],claims:0,identities:0,consumed:[]};
 const page=new EventEmitter();
 Object.assign(page,{mainFrame:()=>page,url:()=>url,isClosed:()=>!open,
  goto:async target=>{calls.navigations.push(target);url=target;},bringToFront:async()=>{},
 });
 const browser={isConnected:()=>open};
 const browserOwner={isOpen:()=>open,open:async()=>{
  calls.order.push('open');
  if(disconnectedEntry)throw Object.assign(Error('Disconnected profile owner must close before reopening.'),{code:'BROWSER_DISCONNECTED'});
  await hooks.open();open=true;return {browser,page};
 },close:async()=>{calls.order.push('close');open=false;disconnectedEntry=false;}};
 const matches=expectedVersion=>expectedVersion==null||String(expectedVersion)===account.control_version;
 const core={
  readRuntimeAccount:async()=>({...account}),
  consumeLoginRequest:async(_pool,_id,token)=>{calls.consumed.push(token);if(token!==account.login_token)return false;account.login_token=null;return true;},
  processingAllowed:async(_pool,_id,_owner,expectedVersion)=>account.authorized&&!account.attention_reason&&!account.login_token&&!account.logout_token&&matches(expectedVersion),
  reserveLinkedInCheck:async(_pool,_id,_owner,kind,settings={})=>{
   calls.permits.push(kind);
   if(!settings.manual&&!matches(settings.controlVersion??settings.control_version))return {stopped:true,reason:'The processing session was replaced.'};
   return hooks.allowance(kind,settings);
  },
  pauseProcessing:async(_pool,_id,reason,attention,_owner,expectedVersion)=>{
   const applied=expectedVersion==null||String(expectedVersion)===account.control_version;
   calls.pauses.push({reason,attention,expectedVersion,applied});
   if(!applied)return;
   account.authorized=false;account.processing_until=null;
   if(attention){account.attention_reason=reason;calls.holds.push(reason);}
  },
  confirmManualSignIn:async(_pool,_id,_owner,identity)=>{
   calls.confirmations.push(identity);await hooks.confirm();
   // Model the real transaction committing after a concurrent restriction:
   // its unconditional UPDATE can clear that restriction last.
   account.attention_reason='';account.authorized=false;account.processing_until=null;
  },
  claim:async()=>{calls.claims++;const job=queuedJob;queuedJob=null;return job?{job}:null;},
  checkpoint:async()=>{},
  complete:async(_pool,jobId,_owner,result)=>{calls.completed.push({jobId,result});await hooks.complete();},
  defer:async(_pool,jobId,_owner,result)=>{calls.deferred.push({jobId,result});},
 };
 const runtime=createAccountRuntime({pool:{},accountId:account.id,owner:'fixture-owner',core,browserOwner,
  reader:{
   inspected:async(_page,settings)=>{settings.checkResponse?.(200,url);return {url};},
   readSignedInIdentity:async(...args)=>{calls.identities++;return hooks.identity(...args);},
   captureProfile:(...args)=>hooks.capture(...args),
  },
  discoveryStore:{claimSource:async()=>source,pauseAccount:async()=>{},runIsActive:async()=>runActive},
  prospecting:{discover:(...args)=>hooks.discover(...args)},
  researchQueue:{fullCapture,handoff:async(_pool,jobId,_owner,value)=>calls.handoffs.push({jobId,value})},
  sleep:ms=>hooks.sleep(ms),now:()=>Date.parse('2026-10-24T10:00:00Z'),
 });
 const nextVersion=()=>{account.control_version=`2026-10-24T10:00:${String(++version).padStart(2,'0')}.000Z`;account.changed_at=account.control_version;};
 return {runtime,account,hooks,calls,page,browserOwner,
  connect:async()=>{await runtime.tick();await runtime.tick();assert.equal(runtime.snapshot().sessionReady,true);},
  start:()=>{nextVersion();account.authorized=true;account.processing_until=`2026-10-24T11:00:${String(version).padStart(2,'0')}.000Z`;return account.processing_until;},
  pause:()=>{account.authorized=false;account.processing_until=null;},
  requestManual:()=>{nextVersion();account.authorized=false;account.processing_until=null;account.login_token='connect-'+version;},
  disconnect:()=>{open=false;disconnectedEntry=true;runtime.disconnected(Error('Account browser disconnected.'));},
  set job(value){queuedJob=value;},set runActive(value){runActive=value;},set source(value){source=value;},
 };
}

test('Connect after a disconnected owner explicitly closes the old owner before opening its profile again',async()=>{
 const f=fixture();await f.connect();f.disconnect();f.requestManual();
 const start=f.calls.order.length;
 await f.runtime.tick();
 assert.deepEqual(f.calls.order.slice(start),['close','open']);
 assert.equal(f.runtime.snapshot().browserOpen,true);assert.equal(f.runtime.snapshot().status,'awaiting_login');
 assert.equal(f.calls.claims,0);assert.equal(f.calls.consumed.length,2);
});
test('manual navigation in an idle browser invalidates cached member readiness without starting a batch',async()=>{
 const f=fixture();await f.connect();
 f.page.emit('framenavigated',{url:()=>feed});
 assert.equal(f.runtime.snapshot().sessionReady,true,'subframes do not change account readiness');
 f.page.emit('framenavigated',f.page);
 assert.equal(f.runtime.snapshot().sessionReady,false);assert.equal(f.calls.claims,0);assert.equal(f.calls.handoffs.length,0);
 assert.equal(f.account.authorized,false);assert.equal(f.account.attention_reason,'');
});

test('Pause while an explicit Start is opening Chrome prevents the later feed navigation',async()=>{
 const f=fixture();f.account.login_token=null;f.start();
 f.job={jobId:'paused-opening',linkedinUrl:person};f.hooks.open=async()=>f.pause();
 await f.runtime.tick();
 assert.deepEqual(f.calls.navigations,[]);assert.equal(f.calls.claims,1);
 assert.equal(f.runtime.snapshot().sessionReady,false);assert.equal(f.account.authorized,false);
});
test('an explicit retry within the same displayed second remains a distinct Start command',async()=>{
 const f=fixture();f.account.login_token=null;f.start();
 f.account.processing_until=new Date('2026-10-24T11:00:00.000Z');f.account.processing_token='2026-10-24 11:00:00.000001+00';
 f.job={jobId:'failed-opening',linkedinUrl:person};f.hooks.open=async()=>{throw Error('Initial launch failed.');};await f.runtime.tick();assert.equal(f.account.authorized,true);assert.equal(f.runtime.snapshot().status,'recovering');
 f.start();f.job={jobId:'retry-opening',linkedinUrl:person};f.account.processing_until=new Date('2026-10-24T11:00:00.000Z');f.account.processing_token='2026-10-24 11:00:00.000002+00';f.hooks.open=async()=>{};
 await f.runtime.tick();assert.equal(f.calls.order.filter(value=>value==='open').length,2);assert.equal(f.calls.navigations.length,1);
 assert.equal(f.runtime.snapshot().sessionReady,true);
});

test('a new manual request during a permit wait prevents contact work and reuses the existing browser',async()=>{
 const f=fixture();await f.connect();f.start();
 f.job={jobId:'manual-interruption',linkedinUrl:person};
 f.hooks.capture=async(_page,_target,settings)=>{
  await settings.beforeCheck('profile_page');f.calls.interactions.push('profile_page');
  await settings.onCheckpoint({url:person,profileIdentityConfirmed:true,linkedinCapture:{complete:false,stage:'contact'},emails:[],logs:[]});
  await settings.beforeCheck('contact');f.calls.interactions.push('contact');
 };
 f.hooks.allowance=async kind=>{if(kind==='contact')f.requestManual();return {};};
 await f.runtime.tick();await f.runtime.drain();
 assert.deepEqual(f.calls.interactions,['profile_page']);assert.equal(f.calls.handoffs.length,0);assert.equal(f.calls.deferred.length,1);
 const before=f.calls.order.length,navigations=f.calls.navigations.length;
 await f.runtime.tick();
 assert.equal(f.calls.order.slice(before).filter(value=>value==='close').length,0);
 assert.equal(f.calls.navigations.length,navigations);assert.equal(f.runtime.snapshot().status,'awaiting_login');
});

test('old capture cleanup cannot pause a newer explicit Start on the same persistent owner',async()=>{
 const f=fixture();await f.connect();f.start();const oldVersion=f.account.control_version;
 f.job={jobId:'old-action',linkedinUrl:person};
 f.hooks.capture=async()=>{throw Error('The old page layout failed.');};
 let newToken;
 f.hooks.complete=async()=>{newToken=f.start();};
 await f.runtime.tick();
 assert.equal(f.calls.completed.length,1);assert.notEqual(f.account.control_version,oldVersion);
 assert.equal(f.account.authorized,true,'late cleanup must not withdraw the newer authorization');
 assert.equal(f.account.processing_until,newToken);assert.equal(f.account.attention_reason,'');
 assert.ok(!f.calls.pauses.some(value=>value.applied&&!value.attention));
});

test('stopping a prospecting run prevents later contact and activity controls while its account stays authorized',async()=>{
 const f=fixture();await f.connect();f.start();
 f.job={jobId:'stopped-prospect',linkedinUrl:person,prospecting:{runId:'run-fixture'}};
 f.hooks.capture=async(_page,_target,settings)=>{
  await settings.beforeCheck('profile_page');f.calls.interactions.push('profile_page');f.runActive=false;
  await settings.beforeCheck('contact');f.calls.interactions.push('contact');
  await settings.beforeCheck('activity_page');f.calls.interactions.push('activity_page');
  return {url:person,profileIdentityConfirmed:true,linkedinCapture:{complete:true},emails:[],logs:[]};
 };
 await f.runtime.tick();
 assert.deepEqual(f.calls.interactions,['profile_page']);assert.equal(f.calls.handoffs.length,0);
 assert.equal(f.account.authorized,true,'stopping one prospecting run does not revoke independent account authorization');
 assert.equal(f.account.attention_reason,'');
});

test('stopping discovery during a permit wait prevents the next discovery action',async()=>{
 const f=fixture();await f.connect();f.start();f.source={id:'run-fixture',account_id:f.account.id};
 let waiting=true;
 f.hooks.allowance=async kind=>{if(kind==='discovery'&&waiting){waiting=false;f.runActive=false;}return {};};
 f.hooks.discover=async(_page,_run,settings)=>{
  await settings.beforeCheck('discovery');f.calls.interactions.push('discovery');return {done:true};
 };
 await f.runtime.tick();
 assert.deepEqual(f.calls.interactions,[]);assert.equal(f.account.attention_reason,'');
});

test('a new restriction during identity reading cannot be cleared by its stale matching identity',async()=>{
 const f=fixture();await f.runtime.tick();
 f.hooks.identity=async()=>{await f.runtime.handleSignal(restriction);return viewer;};
 await f.runtime.tick();
 assert.equal(f.account.attention_reason,restriction.reason);assert.equal(f.calls.confirmations.length,0);
 assert.equal(f.runtime.snapshot().sessionReady,false);assert.equal(f.runtime.snapshot().manualResumeRequired,true);
 assert.notEqual(f.runtime.snapshot().status,'idle');
});

test('a restriction arriving during the confirmation transaction is restored after a stale commit',async()=>{
 const f=fixture();await f.runtime.tick();
 f.hooks.confirm=async()=>{await f.runtime.handleSignal(restriction);};
 await f.runtime.tick();
 assert.equal(f.calls.confirmations.length,1);assert.equal(f.account.attention_reason,restriction.reason);
 assert.equal(f.runtime.snapshot().sessionReady,false);assert.equal(f.runtime.snapshot().manualResumeRequired,true);
 assert.equal(f.account.authorized,false);assert.notEqual(f.runtime.snapshot().status,'idle');
});

test('a stopped prospecting run skips public website research and CRM persistence before finish integration',async()=>{
 const completed=[],attempts={research:0,finish:0,save:0,launch:0,lookup:0};
 const runner=createResearchRunner({pool:{query:async()=>{attempts.lookup++;return {rows:[]};}},owner:'public-owner',
  discoveryStore:{runIsActive:async()=>false},
  core:{complete:async(_pool,jobId,_owner,result)=>completed.push({jobId,result})},
  researchProspect:async()=>{attempts.research++;return {website:'',contacts:[],crawl:{complete:true}};},
  finishProspecting:async()=>{attempts.finish++;return {status:'CANCELLED'};},
  saveWorkerResearch:async()=>{attempts.save++;throw Error('Unexpected CRM write');},
  launch:async()=>{attempts.launch++;throw Error('Unexpected public browser launch');},
 });
 const outcome=await runner.process({jobId:'cancelled-research',prospecting:{runId:'stopped-run'},resumeResult:{url:person,profileIdentityConfirmed:true,linkedinCapture:{complete:true},emails:[],logs:[]}});
 assert.equal(outcome.deferred,false);assert.equal(outcome.result.status,'CANCELLED');assert.equal(completed.length,1);
 assert.deepEqual(attempts,{research:0,finish:0,save:0,launch:0,lookup:0});
 await runner.close();
});
