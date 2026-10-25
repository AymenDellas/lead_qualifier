'use strict';

const {pageSignal,failure:sessionFailure,isFeed,sameMember}=require('./linkedin-session-policy.cjs');
const runtimeVersion='SESSION_V2';
const controlError=reason=>Object.assign(new Error(reason),{failure:{stage:'control',code:'WORKER_PAUSED',reason,retryable:false}});
const transient=error=>/detached|execution context|context was destroyed|cannot find context|navigat/i.test(error?.message||'');

// A runtime owns one account tab. Runner intent, browser existence and queued
// work are separate: pause changes intent; it never closes/recreates Chrome.
function createAccountRuntime(options) {
 const {pool,accountId,owner,browserOwner}=options;
 const core=options.core||require('./linkedin-workers.cjs');
 const reader=options.reader||require('./linkedin-browser-page.cjs');
 const discoveryStore=options.discoveryStore||require('./coach-prospecting-store.cjs');
 const prospecting=options.prospecting||require('./coach-prospecting-worker.cjs');
 const researchQueue=options.researchQueue||require('./worker-research-queue.cjs');
 const now=options.now||Date.now,sleep=options.sleep||(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
 const log=options.log||(()=>{}),onStatus=options.onStatus||(()=>{});
 let stopped=false,identity=null,manual=null,signal=null,surface=null,watched=null,closing=null,browserAttempted=false;
 let status={status:'idle',reason:'Connect this account to open its saved browser.',runtimeVersion,sessionReady:false,browserOpen:false,accountId};
 let handledStart=null,handledLogin=null,handledLogout=null,handlingSignal=null,activeVersion=null,signalGeneration=0,pageGeneration=0;
 function publish(state,extra={}) {
  status={...status,status:state,reason:'',reasonCode:null,manualResumeRequired:false,url:'',jobId:null,phase:null,runId:null,nextEligibleAt:null,...extra,runtimeVersion,
   browserOpen:browserOwner.isOpen(),sessionReady:!!identity&&browserOwner.isOpen(),signedIn:identity,updatedAt:new Date(now()).toISOString()};
  onStatus({...status});return status;
 }
 async function account(){return core.readRuntimeAccount(pool,accountId);}
 async function setWindowVisibility(visible) {
  try{if(visible)await browserOwner.reveal?.();else if(browserOwner.background)await browserOwner.background();else await browserOwner.minimize?.();}
  catch(error){log('Could not change the account window visibility: '+error.message);}
 }
 async function handleSignal(value) {
  if(stopped)return;
  // A late asset/API response is never enough to declare an account restricted.
  // Only the main page URL/status and its explicit visible account notice enter here.
  signal=value?.failure||value;signalGeneration++;identity=null;
  publish('paused',{reason:signal.reason,manualResumeRequired:true,reasonCode:signal.code});
  if(handlingSignal)return handlingSignal;
  handlingSignal=(async()=>{
   try {
    await core.pauseProcessing(pool,accountId,signal.reason,true,owner);
    await discoveryStore.pauseAccount?.(pool,accountId,signal.reason);
   }finally{await setWindowVisibility(true);}
  })().finally(()=>{handlingSignal=null;});
  return handlingSignal;
 }
 function watch(page) {
  if(watched===page)return;
  watched=page;
  const check=(url,code=0)=>{
   const found=pageSignal({url,status:code,manual:!!manual});
   if(found)void handleSignal(sessionFailure(found)).catch(error=>log('Could not save account hold: '+error.message));
  };
  page.on?.('framenavigated',frame=>{if(frame===page.mainFrame()){
   pageGeneration++;
   if(identity&&!manual&&['idle','paused'].includes(status.status)) {
    identity=null;
    publish('paused',{reason:'The account page changed while paused. Use Open session to confirm the signed-in member.',reasonCode:'ACCOUNT_RECHECK'});
   }
   check(frame.url());
  }});
  page.on?.('response',response=>{
   try{if(response.request().isNavigationRequest()&&response.frame()===page.mainFrame())check(response.url(),response.status());}catch{/* Target replaced during navigation. */}
  });
  page.on?.('close',()=>disconnected(new Error('The account tab was closed. Use Open session to reopen it.')));
 }
 async function open() {
  browserAttempted=true;
  surface=await browserOwner.open();watch(surface.page);return surface;
 }
 async function assertActive() {
  if(stopped)throw controlError('Worker is stopping. Pending work is retained.');
  if(signal)throw Object.assign(new Error(signal.reason),{failure:signal});
  if(!await core.processingAllowed(pool,accountId,owner,activeVersion))throw controlError('Processing paused or the batch request changed. Queued profiles and captured evidence are retained.');
 }
 async function permit(kind,{manual:manualCheck=false}={}) {
  const currentTask={status:status.status,reason:status.reason,jobId:status.jobId,url:status.url,phase:status.phase,runId:status.runId};
  for(;;) {
   if(stopped)throw controlError('Worker is stopping.');
   if(!manualCheck)await assertActive();
   const allowance=await core.reserveLinkedInCheck(pool,accountId,owner,kind,manualCheck?{manual:true}:{manual:false,version:activeVersion});
   if(allowance.stopped)throw controlError(allowance.reason||'Processing is paused.');
   if(!allowance.waitMs){if(status.status==='sleeping')publish(currentTask.status,currentTask);return;}
   const reason=allowance.reason||'Waiting for the next scheduled page interaction.';
   publish('sleeping',{jobId:currentTask.jobId,url:currentTask.url,phase:currentTask.phase,runId:currentTask.runId,reason,reasonCode:'ACTIVITY_WAIT',nextEligibleAt:new Date(now()+allowance.waitMs).toISOString()});
   // Manual connection observes the user's page without waiting on this permit.
   // It never repeatedly opens account controls while a budget is resting.
   if(manualCheck)throw controlError(reason);
   await sleep(Math.min(allowance.waitMs,1000));
  }
 }
 async function inspect(manualMode=false) {
  return reader.inspected(surface.page,{manual:manualMode,checkResponse:(code,url)=>{
   const found=pageSignal({url,status:code,manual:manualMode});
   if(found)throw Object.assign(new Error(found.reason),{failure:sessionFailure(found)});
  }});
 }
 async function connect(a) {
  if(a.login_token===handledLogin)return;
  handledLogin=a.login_token;
  const consumed=await core.consumeLoginRequest(pool,accountId,a.login_token);
  if(!consumed)return;
  manual={deadline:now()+600000,menuAttempted:false};signal=null;identity=null;
  publish('starting',{reason:'Opening this account’s saved browser. Processing stays paused.'});
  const wasOpen=browserOwner.isOpen();
  if(!wasOpen&&browserAttempted)await browserOwner.close();
  await open();
  await setWindowVisibility(true);
  if(wasOpen) {
   await surface.page.bringToFront?.();
  } else {
   // The human explicitly requested connection. Do not submit any credentials,
   // retry navigation, or clear the account's saved cookies/profile.
   try{await surface.page.goto('https://www.linkedin.com/feed/',{waitUntil:'domcontentloaded',timeout:30000});}
   catch(error){if(!browserOwner.isOpen())throw error;log('Connection page is available for manual review: '+error.message);}
  }
  publish('awaiting_login',{reason:'Complete sign-in or review in the open account browser. Then return here; processing remains paused.'});
 }
 async function observeManual(a) {
  if(!browserOwner.isOpen()) {
   manual=null;identity=null;
   publish('paused',{reason:'The account browser was closed. Connect again when you are ready.',reasonCode:'BROWSER_CLOSED'});return;
  }
  if(now()>manual.deadline) {
   manual=null;
   publish('paused',{reason:'Connection needs your review. The browser stays open; use Open session to check it again.',reasonCode:'CONNECTION_REVIEW'});return;
  }
  try {
   // Manual review can clear a hold only after the human returns to a confirmed
   // matching feed identity. A security page remains open, without automation.
   const state=await inspect(true);
   if(!isFeed(state.url))return;
   const observedSignal=signalGeneration,observedPage=pageGeneration;
   let found=await reader.readSignedInIdentity(surface.page,{manual:true,passive:true});
   if(!found&&!manual.menuAttempted) {
    manual.menuAttempted=true;
    try{found=await reader.readSignedInIdentity(surface.page,{manual:true,leaveMenuOpen:true,beforeCheck:kind=>permit(kind,{manual:true})});}
    catch(error){if(error.failure?.code!=='WORKER_PAUSED'&&!transient(error))throw error;}
   }
   if(!found)return;
   if(observedSignal!==signalGeneration||observedPage!==pageGeneration)return;
   if(a.confirmed_identity&&!sameMember(a.confirmed_identity,found)) {
    await handleSignal(sessionFailure({code:'ACCOUNT_MISMATCH',reason:'This browser shows a different LinkedIn member. Use the intended account before processing.'}));return;
   }
   const current=await inspect(true);
   if(!isFeed(current.url)||observedSignal!==signalGeneration||observedPage!==pageGeneration)return;
   await core.confirmManualSignIn(pool,accountId,owner,found);
   if(observedSignal!==signalGeneration||observedPage!==pageGeneration) {
    const reason=signal?.reason||'The account page changed during confirmation. Review it before starting.';
    await core.pauseProcessing(pool,accountId,reason,true,owner);
    publish('paused',{reason,manualResumeRequired:true,reasonCode:signal?.code||'ACCOUNT_REVIEW'});return;
   }
   identity=found;manual=null;signal=null;
   publish('idle',{reason:'Connected. Start the batch when you are ready.'});log('Account connected; the same browser remains open and idle.');
  }catch(error){
   if(error.failure?.stage==='linkedin'){await handleSignal(error.failure);return;}
   if(!transient(error))publish('awaiting_login',{reason:'Account identity is not confirmed yet. Check the open browser; no batch has started.'});
  }
 }
 async function prepareProcessing(a) {
  if(identity&&browserOwner.isOpen())return true;
  const startToken=a.processing_token||a.control_version||String(a.processing_until);
  if(handledStart===startToken)return false;
  handledStart=startToken;signal=null;
  publish('starting',{reason:'Opening the saved session and checking the signed-in member.'});
  await permit('identity');
  if(!browserOwner.isOpen()&&browserAttempted)await browserOwner.close(); // explicit Start permits reopening, never an automatic retry
  await open();
  await assertActive();
  await surface.page.goto('https://www.linkedin.com/feed/',{waitUntil:'domcontentloaded',timeout:30000});
  await inspect();
  const found=await reader.readSignedInIdentity(surface.page,{leaveMenuOpen:true,beforeCheck:permit});
  if(!found)throw controlError('The saved session could not confirm its member. Use Open session to review the account; queued profiles are retained.');
  if(!a.confirmed_identity||!sameMember(a.confirmed_identity,found)) {
   await handleSignal(sessionFailure({code:'ACCOUNT_MISMATCH',reason:'The saved session does not match the connected account. Review it before processing.'}));return false;
  }
  await assertActive();identity=found;publish('ready',{reason:'Connected. Looking for queued work.'});return true;
 }
 async function recoverJob(job,error,capture) {
  const failure=error.failure||{stage:'linkedin',code:'PAGE_CHANGED',reason:'The LinkedIn page could not be read. Review the open browser before resuming.',retryable:false};
  const result={...(capture||job.resumeResult||{}),url:job.linkedinUrl,status:'ERROR',failure,
   logs:[...(capture?.logs||[]),'Profile reading stopped: '+error.message]};
  if(['PROFILE_REDIRECT','PROFILE_UNAVAILABLE'].includes(failure.code)) {
   await core.complete(pool,job.jobId,owner,result);
   publish('ready',{reason:'Skipped an unavailable or redirected profile URL. Continuing with the saved queue.'});
   log('Skipped unavailable or redirected profile: '+job.jobId);return;
  }
  if(failure.stage==='control'&&job.prospecting&&!await discoveryStore.runIsActive(pool,job.prospecting.runId)) {
   await core.complete(pool,job.jobId,owner,{...result,status:'CANCELLED',failure:undefined});
   publish('ready',{reason:'The prospecting run was stopped. Its captured evidence is retained.'});return;
  }
  if(failure.stage==='control'||['LINKEDIN_AUTH','LINKEDIN_RATE_LIMIT','ACCOUNT_MISMATCH'].includes(failure.code)) {
   await core.defer(pool,job.jobId,owner,result,new Date(now()).toISOString());
   if(failure.stage==='linkedin')await handleSignal(failure);
   else publish('idle',{reason:failure.reason});
  } else {
   await core.complete(pool,job.jobId,owner,result);
   await core.pauseProcessing(pool,accountId,failure.reason,false,owner,activeVersion);
   publish('paused',{reason:failure.reason,reasonCode:failure.code});
   await setWindowVisibility(true);
  }
 }
 async function processJob(job) {
  let captured=job.resumeResult;
  publish('processing',{jobId:job.jobId,url:job.linkedinUrl,reason:'Reading the queued profile.'});
  try {
   // A cached complete capture belongs to public research, not another browser
   // visit. Partial captures always resume the matching account page first.
   if(!researchQueue.fullCapture(captured)) {
    captured=await reader.captureProfile(surface.page,job.linkedinUrl,{
     accountId,beforeCheck:async kind=>{
      if(job.prospecting&&!await discoveryStore.runIsActive(pool,job.prospecting.runId))throw controlError('The prospecting run was stopped. Captured evidence is retained.');
      await permit(kind);
      if(job.prospecting&&!await discoveryStore.runIsActive(pool,job.prospecting.runId))throw controlError('The prospecting run was stopped. Captured evidence is retained.');
     },resume:captured,
     checkResponse:(code,url)=>{const found=pageSignal({url,status:code});if(found)throw Object.assign(Error(found.reason),{failure:sessionFailure(found)});},
     onCheckpoint:async value=>{captured=value;await core.checkpoint(pool,job.jobId,owner,value);},
    });
   }
   await researchQueue.handoff(pool,job.jobId,owner,{...captured,linkedinAccountId:accountId});
   publish('ready',{reason:'Profile saved. Public website research continues separately.'});
   log('Captured profile handed to public research: '+job.jobId);
  }catch(error){await recoverJob(job,error,captured);}
 }
 async function tick() {
  if(stopped)return;
  const a=await account();
  if(!a){await close();return;}
  if(a.logout_token) {
   if(a.logout_token===handledLogout)return;
   handledLogout=a.logout_token;
   await core.pauseProcessing(pool,accountId,'Signing out.',false,owner);
   manual=null;identity=null;
   await open();publish('signing_out',{reason:'Signing out this saved account only.'});
   await (options.signOut||require('./linkedin-signout.cjs').signOut)(surface.browser,log);
   if(!await core.finishLogout(pool,accountId,a.logout_token))throw Error('Account sign-out request changed.');
   await browserOwner.close();publish('signed_out',{reason:'Signed out. The profile and queued work are retained.'});return;
  }
  if(a.login_token&&a.login_token!==handledLogin){await connect(a);return;}
  if(manual){await observeManual(a);return;}
  if(!a.enabled){await close();return;}
  if(a.attention_reason) {
   publish('paused',{reason:a.attention_reason,manualResumeRequired:true,reasonCode:'ACCOUNT_REVIEW'});return;
  }
  if(!a.authorized) {
   if(status.status==='paused'&&status.reasonCode)return; // retain actionable failures until an explicit recovery
   publish('idle',{reason:browserOwner.isOpen()?'Connected. The batch is paused; your browser stays open.':'The saved session is closed. Start the batch to reopen it, or use Open session.'});return;
  }
  try {
   activeVersion=a.control_version||null;
   if(!await prepareProcessing(a))return;
   await assertActive();
   await setWindowVisibility(false);
   await assertActive();
   const run=await discoveryStore.claimSource?.(pool,accountId,owner);
   if(run) {
    publish('processing',{phase:'PROSPECT_DISCOVERY',runId:run.id,reason:'Collecting the requested prospect list.'});
    const result=await prospecting.discover(surface.page,run,{pool,owner,log,beforeCheck:async kind=>{
     if(!await discoveryStore.runIsActive(pool,run.id))throw controlError('The prospecting run was stopped.');
     await permit(kind);
     if(!await discoveryStore.runIsActive(pool,run.id))throw controlError('The prospecting run was stopped.');
    }});
    if(result?.paused)await handleSignal(sessionFailure({code:'LINKEDIN_AUTH',reason:result.paused}));
    return;
   }
   const reservation=await core.claim(pool,accountId,owner);
   if(reservation?.disabled)return;
   if(reservation?.limited) {
    const reason='The configured profile budget is reached. Queued profiles are retained.';
    await core.pauseProcessing(pool,accountId,reason,false,owner,activeVersion);publish('paused',{reason,reasonCode:'PROFILE_BUDGET'});return;
   }
   if(reservation?.job)await processJob(reservation.job);
   else publish('ready',{reason:'No profiles waiting for LinkedIn capture. Website research may still be running.'});
  }catch(error){
   if(error.failure?.stage==='linkedin')await handleSignal(error.failure);
   else {
    const reason=error.failure?.reason||'The account session stopped: '+error.message;
    await core.pauseProcessing(pool,accountId,reason,false,owner,activeVersion);
    publish('paused',{reason,reasonCode:error.failure?.code||'SESSION_ERROR'});
    if(error.failure?.stage!=='control')await setWindowVisibility(true);
   }
  }
 }
 function close() {
  if(closing)return closing;stopped=true;
  closing=(async()=>{
   await core.pauseProcessing(pool,accountId,'The local account session stopped. Queued work is retained.',false,owner).catch(()=>{});
   await browserOwner.close();identity=null;
   publish('offline',{reason:'Local session stopped. Queued work and saved sign-in are retained.'});
  })();
  return closing;
 }
 function disconnected(error) {
  identity=null;surface=null;
  publish('paused',{reason:error?.message||'The account browser closed. Reopen it explicitly to continue.',reasonCode:'BROWSER_CLOSED'});
  void core.pauseProcessing(pool,accountId,status.reason,false,owner).catch(e=>log('Could not save browser stop: '+e.message));
 }
 return {tick,permit,handleSignal,close,disconnected,snapshot:()=>({...status})};
}

module.exports={createAccountRuntime,runtimeVersion};
