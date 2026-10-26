'use strict';

const {pageSignal,failure:sessionFailure,isFeed,sameMember}=require('./linkedin-session-policy.cjs');
const telemetry=require('./engine-telemetry.cjs');
const runtimeVersion='SESSION_V2';
const controlError=reason=>Object.assign(new Error(reason),{failure:{stage:'control',code:'WORKER_PAUSED',reason,retryable:false}});
const transient=error=>/detached|execution context|context was destroyed|cannot find context|navigat/i.test(error?.message||'');

// A runtime owns one account tab. Runner intent, browser existence and queued
// work are separate. Pause changes intent; the agent manages idle/recovery recycling.
function createAccountRuntime(options) {
 const {pool,accountId,owner,browserOwner}=options;
 const core=options.core||require('./linkedin-workers.cjs');
 const reader=options.reader||require('./linkedin-browser-page.cjs');
 const discoveryStore=options.discoveryStore||require('./coach-prospecting-store.cjs');
 const prospecting=options.prospecting||require('./coach-prospecting-worker.cjs');
 const researchQueue=options.researchQueue||require('./worker-research-queue.cjs');
 const now=options.now||Date.now;
 const log=options.log||(()=>{}),onStatus=options.onStatus||(()=>{});
 let stopped=false,identity=null,manual=null,signal=null,surface=null,watched=null,closing=null,browserAttempted=false;
 let status={status:'idle',startupStage:'AGENT_ACK',reason:'Agent acknowledged this account. Waiting for work or manual connection.',runtimeVersion,sessionReady:false,browserOpen:false,accountId};
 let startupFailures=0,recoveringJob=false;
 let handledStart=null,handledLogin=null,handledLogout=null,handlingSignal=null,activeVersion=null,signalGeneration=0,pageGeneration=0,jobsStarted=0,pendingKinds={};
 const saves=(options.createSaveQueue||require('./bounded-work.cjs').createBoundedQueue)({capacity:options.saveQueueCapacity||6,onError:(error,metadata)=>{
  const reason='PostgreSQL save failed: '+error.message;
  publish('paused',{reason,reasonCode:'DB_SAVE_FAILED',startupStage:'FAILED',failedStage:'DB_SAVE',jobId:metadata?.jobId});
  log(reason);options.onSaveError?.(error);
 }});
 async function save(task,jobId){
  const trace=telemetry.current(),version=activeVersion;
  return saves.submit(()=>trace?telemetry.withTrace(trace,task):task(),{jobId,version});
 }
 async function flushStatistics(jobId){
  if(!Object.keys(pendingKinds).length)return;const batch=pendingKinds;pendingKinds={};
  await save(()=>core.recordLinkedInChecks(pool,accountId,owner,batch),jobId);
 }
 async function releasePendingClaims(){
  if(saves.error){await saves.idle();await core.releaseCaptureClaims?.(pool,accountId,owner);}
 }
 function publish(state,extra={}) {
  status={...status,status:state,reason:'',reasonCode:null,manualResumeRequired:false,url:'',jobId:null,phase:null,runId:null,nextEligibleAt:null,...extra,runtimeVersion,
   ...(state==='processing'?{startupStage:'PROCESSING'}:{}),
   ...(state==='idle'?{startupStage:identity?'SESSION_VERIFIED':'AGENT_ACK'}:{}),
   ...(state==='offline'?{startupStage:'OFFLINE'}:{}),
   browserOpen:browserOwner.isOpen(),sessionReady:!!identity&&browserOwner.isOpen(),signedIn:identity,updatedAt:new Date(now()).toISOString()};
  status.controlVersion=activeVersion;
  onStatus({...status});return status;
 }
 async function account(){return core.readRuntimeAccount(pool,accountId);}
 async function setWindowVisibility(visible) {
  try{if(visible)await browserOwner.reveal?.();else if(browserOwner.background)await browserOwner.background();else await browserOwner.minimize?.();}
  catch(error){log('Could not change the account window visibility: '+error.message);}
 }
 async function handleSignal(value) {
  if(stopped)return;
  // A LinkedIn restriction response or rendered security notice stops all
  // automated work for this account until manual review confirms its identity.
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
   if(watched!==page)return;
   const found=pageSignal({url,status:code,manual:!!manual});
   if(found)void handleSignal(sessionFailure(found)).catch(error=>log('Could not save account hold: '+error.message));
  };
  page.on?.('framenavigated',frame=>{if(watched===page&&frame===page.mainFrame()){
   pageGeneration++;
   if(identity&&!manual&&['idle','paused'].includes(status.status)) {
    identity=null;
    publish('paused',{reason:'The account page changed while paused. Use Open session to confirm the signed-in member.',reasonCode:'ACCOUNT_RECHECK'});
   }
   check(frame.url());
  }});
  page.on?.('response',response=>{
   try{if([401,403,429,999].includes(response.status())||response.request().isNavigationRequest()&&response.frame()===page.mainFrame())check(response.url(),response.status());}catch{/* Target replaced during navigation. */}
  });
  page.on?.('close',()=>{if(watched===page)disconnected(new Error('The account tab was closed. Use Open session to reopen it.'));});
 }
 async function open(headless=true) {
  if(browserOwner.isOpen()&&typeof browserOwner.isHeadless==='function'&&browserOwner.isHeadless()!==headless){
   await saves.idle();await releasePendingClaims();watched=null;identity=null;surface=null;handledStart=null;
   await browserOwner.close();
  }
  publish('starting',{startupStage:'BROWSER_STARTING',reason:'Opening this account’s persistent Chrome profile.'});
  browserAttempted=true;
  surface=await browserOwner.open({headless});watch(surface.page);return surface;
 }
 async function assertActive() {
  if(stopped)throw controlError('Worker is stopping. Pending work is retained.');
  if(saves.error)throw controlError('PostgreSQL save failed: '+saves.error.message);
  if(signal)throw Object.assign(new Error(signal.reason),{failure:signal});
  if(!await core.processingAllowed(pool,accountId,owner,activeVersion))throw controlError('Processing paused or the batch request changed. Queued profiles and captured evidence are retained.');
 }
 async function permit(kind,{manual:manualCheck=false}={}) {
  if(stopped)throw controlError('Worker is stopping.');
  if(!manualCheck)await assertActive();
  if(manualCheck&&kind!=='identity')throw controlError('Manual sign-in can only confirm identity.');
  if(core.recordLinkedInChecks){
   if(manualCheck&&!await core.sessionOwned(pool,accountId,owner))throw controlError('Account session ownership changed.');
   pendingKinds[kind]=(pendingKinds[kind]||0)+1;if(manualCheck)await flushStatistics(status.jobId);
  }
  else if(core.recordLinkedInCheck)await save(()=>core.recordLinkedInCheck(pool,accountId,owner,kind),status.jobId);
  else {
   const action=await (core.recordLinkedInAction||core.reserveLinkedInCheck)(pool,accountId,owner,kind,manualCheck?{manual:true}:{manual:false,version:activeVersion});
   if(action?.stopped)throw controlError(action.reason||'Processing is paused.');
   if(!manualCheck)await assertActive();
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
  activeVersion=a.control_version||null;
  const consumed=await core.consumeLoginRequest(pool,accountId,a.login_token);
  if(!consumed)return;
  manual={menuAttempted:false};signal=null;identity=null;
  publish('starting',{reason:'Opening this account’s saved browser. Processing stays paused.'});
  const wasOpen=browserOwner.isOpen();
  if(!wasOpen&&browserAttempted)await browserOwner.close();
  await open(false);
  await setWindowVisibility(true);
  if(wasOpen) {
   await surface.page.bringToFront?.();
   if(surface.page.url?.()==='about:blank')await surface.page.goto('https://www.linkedin.com/feed/',{waitUntil:'domcontentloaded',timeout:30000});
  } else {
   // The human explicitly requested connection. Do not submit any credentials,
   // retry navigation, or clear the account's saved cookies/profile.
   try{await surface.page.goto('https://www.linkedin.com/feed/',{waitUntil:'domcontentloaded',timeout:30000});}
   catch(error){if(!browserOwner.isOpen())throw error;log('Connection page is available for manual review: '+error.message);}
  }
  publish('awaiting_login',{startupStage:'SESSION_REVIEW',reason:'Complete sign-in or review in the open account browser. Then return here; processing remains paused.'});
 }
 async function observeManual(a) {
  if(!browserOwner.isOpen()) {
   manual=null;identity=null;
   publish('paused',{reason:'The account browser was closed. Connect again when you are ready.',reasonCode:'BROWSER_CLOSED'});return;
  }
  try {
   // Manual review can clear a hold only after the human returns to a confirmed
   // matching feed identity. A security page remains open, without automation.
   const state=await inspect(true);
   if(!isFeed(state.url))return;
   if(manual.menuGeneration!==pageGeneration){manual.menuAttempted=false;manual.menuGeneration=pageGeneration;}
   const observedSignal=signalGeneration,observedPage=pageGeneration;
   let found=await reader.readSignedInIdentity(surface.page,{manual:true,passive:true});
   if(!found&&!manual.menuAttempted) {
    manual.menuAttempted=true;
    const request=manual;
    try{found=await reader.readSignedInIdentity(surface.page,{manual:true,leaveMenuOpen:true,onMenuAttempt:opened=>{if(manual===request)request.menuAttempted=opened;},beforeCheck:kind=>permit(kind,{manual:true})});}
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
   publish('idle',{startupStage:'SESSION_VERIFIED',reason:'Connected. Start the batch when you are ready.'});log('Account connected; the same browser remains open and idle.');
  }catch(error){
   if(error.failure?.stage==='linkedin'){await handleSignal(error.failure);return;}
   if(!transient(error))publish('awaiting_login',{reason:'Account identity is not confirmed yet. Check the open browser; no batch has started.'});
  }
 }
 async function prepareProcessing(a) {
  if(identity&&browserOwner.isOpen()&&browserOwner.isHeadless?.()!==false){publish('ready',{startupStage:'SESSION_VERIFIED',reason:'Verified session reused.'});return true;}
  const startToken=a.processing_token||a.control_version||String(a.processing_until);
  if(handledStart===startToken)return false;
  signal=null;
  publish('starting',{reason:'Opening the saved session and checking the signed-in member.'});
  if(!browserOwner.isOpen()&&browserAttempted)await browserOwner.close(); // release a disconnected handle before an owned relaunch
  await open();
  await permit('identity');
  await assertActive();
  await surface.page.goto('https://www.linkedin.com/feed/',{waitUntil:'domcontentloaded',timeout:30000});
  await inspect();
  const found=await reader.readSignedInIdentity(surface.page,{leaveMenuOpen:true,beforeCheck:permit});
  if(!found)throw controlError('The saved session could not confirm its member. Use Open session to review the account; queued profiles are retained.');
  if(!a.confirmed_identity||!sameMember(a.confirmed_identity,found)) {
   await handleSignal(sessionFailure({code:'ACCOUNT_MISMATCH',reason:'The saved session does not match the connected account. Review it before processing.'}));return false;
  }
  await assertActive();identity=found;handledStart=startToken;startupFailures=0;publish('ready',{startupStage:'SESSION_VERIFIED',reason:'Signed-in member verified. Processing queued work.'});return true;
 }
 async function recoverJob(job,error,capture) {
  if(stopped){await core.releaseClaim?.(pool,job.jobId,owner);return;}
  if(error.dailyLimit){await core.releaseClaim(pool,job.jobId,owner);dailyStatus(error.dailyLimit);return;}
  if(error.profilePace){await core.releaseClaim(pool,job.jobId,owner);paceStatus(error.profilePace);return;}
  const crashed=!error.failure&&/target closed|session closed|page crashed|connection closed|protocol error|navigation timeout|browser.*(?:closed|disconnect)/i.test(error.message);
  const failure=error.failure||(crashed?{stage:'linkedin',code:'BROWSER_CRASH',reason:'Chrome failed during profile reading; saved checkpoint retained.',retryable:true}:{stage:'linkedin',code:'PAGE_CHANGED',reason:'The LinkedIn page could not be read. Review the saved evidence.',retryable:false});
  const result={...(capture||job.resumeResult||{}),url:job.linkedinUrl,status:failure.retryable===false?'REVIEW':'ERROR',failure,
   logs:[...(capture?.logs||[]),'Profile reading stopped: '+error.message]};
  if(crashed&&(job.retryCount||0)<2){
   await core.defer(pool,job.jobId,owner,result,new Date(now()).toISOString());
   await browserOwner.close();identity=null;surface=null;handledStart=null;
   publish('recovering',{startupStage:'BROWSER_STARTING',reason:'Chrome will reopen and resume this profile from its checkpoint (bounded attempt '+((job.retryCount||0)+1)+'/2).'});return;
  }
  if(crashed){result.status='REVIEW';result.failure.retryable=false;result.failure.reason='Chrome retry attempts exhausted. Review the saved evidence.';}
  if(result.status==='REVIEW'&&failure.stage!=='control'&&!['LINKEDIN_AUTH','LINKEDIN_RATE_LIMIT','ACCOUNT_MISMATCH'].includes(failure.code)&&!job.prospecting&&job.nativePostProcess&&core.saveCaptureReview){
   const saved=await core.saveCaptureReview(pool,{job,owner,capture:result,failure:result.failure});result.crmSaved=true;result.crmLeadId=saved.id;
  }
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
   publish('ready',{reason:'Saved for review: '+failure.reason,reasonCode:failure.code});
  }
 }
 function processJob(job) {
  return telemetry.withLead({...job,accountId},()=>processJobInner(job));
 }
 async function processJobInner(job) {
  jobsStarted++;
  let captured=job.resumeResult;
  publish('processing',{jobId:job.jobId,url:job.linkedinUrl,reason:'Reading the queued profile.'});
  try {
   // A cached complete capture belongs to public research, not another browser
   // visit. Partial captures always resume the matching account page first.
   if(!researchQueue.fullCapture(captured)) {
    captured=await reader.captureProfile(telemetry.pageActions(surface.page),job.linkedinUrl,{
     accountId,requireRecentActivity:!job.prospecting,requireTargetLocation:!job.prospecting,beforeCheck:async kind=>{
      if(job.prospecting&&!await discoveryStore.runIsActive(pool,job.prospecting.runId))throw controlError('The prospecting run was stopped. Captured evidence is retained.');
      await permit(kind);
      if(kind==='profile_page'&&core.reserveProfile){
       const limit=await core.reserveProfile(pool,{accountId,owner,profileUrl:job.linkedinUrl,jobId:job.jobId,version:activeVersion});
       if(limit.stopped)throw controlError(limit.reason);
       if(limit.limited)throw Object.assign(Error('Daily profile limit reached.'),{dailyLimit:limit});
       if(limit.paced)throw Object.assign(Error('Waiting for the next profile start.'),{profilePace:limit});
       await assertActive();
      }
      if(job.prospecting&&!await discoveryStore.runIsActive(pool,job.prospecting.runId))throw controlError('The prospecting run was stopped. Captured evidence is retained.');
     },resume:captured,
     checkResponse:(code,url)=>{const found=pageSignal({url,status:code});if(found)throw Object.assign(Error(found.reason),{failure:sessionFailure(found)});},
     onCheckpoint:async value=>{const checkpoint=structuredClone(value);captured=checkpoint;await save(()=>core.checkpoint(pool,job.jobId,owner,checkpoint),job.jobId);},
    });
   }
   const completeCapture=structuredClone({...captured,linkedinAccountId:accountId});
   await flushStatistics(job.jobId);
   await save(async()=>{await researchQueue.handoff(pool,job.jobId,owner,completeCapture);options.wakeResearch?.();log('Captured profile handed to public research: '+job.jobId);},job.jobId);
   publish('ready',{reason:'Profile captured. Saving and public research continue separately.'});
  }catch(error){const checkpoint=captured;recoveringJob=true;await flushStatistics(job.jobId);await save(async()=>{try{await recoverJob(job,error,checkpoint);}finally{recoveringJob=false;}},job.jobId);}
 }
 async function tick() {
  if(stopped)return;
  if(recoveringJob)await saves.idle();
  const a=await account();
  if(!a){await close();return;}
  if(a.logout_token) {
   if(a.logout_token===handledLogout)return;
   handledLogout=a.logout_token;
   await core.pauseProcessing(pool,accountId,'Signing out.',false,owner);
   manual=null;identity=null;
   await open(false);publish('signing_out',{reason:'Signing out this saved account only.'});
   await (options.signOut||require('./linkedin-signout.cjs').signOut)(surface.browser,log);
   if(!await core.finishLogout(pool,accountId,a.logout_token))throw Error('Account sign-out request changed.');
   await browserOwner.close();publish('signed_out',{reason:'Signed out. The profile and queued work are retained.'});return;
  }
  if(a.login_token&&a.login_token!==handledLogin){await connect(a);return;}
  if(manual){await observeManual(a);return;}
  if(!a.enabled){await close();return;}
  if(a.attention_reason) {
   await releasePendingClaims();
   publish('paused',{reason:a.attention_reason,manualResumeRequired:true,reasonCode:'ACCOUNT_REVIEW'});return;
  }
  if(!a.authorized) {
   await releasePendingClaims();
   if(status.status==='paused'&&status.reasonCode)return; // retain actionable failures until an explicit recovery
   publish('idle',{reason:browserOwner.isOpen()?'Connected. The batch is paused; your browser stays open.':'The saved session is closed. Start the batch to reopen it, or use Open session.'});return;
  }
  let claimedJob=null,claimedRun=null;
  try {
   if(a.control_version!==activeVersion&&saves.error){await saves.idle();saves.clearError();}
   activeVersion=a.control_version||null;
   await assertActive();
   const run=await discoveryStore.claimSource?.(pool,accountId,owner);
   if(run) {
    claimedRun=run;if(!await prepareProcessing(a)){await discoveryStore.releaseSource?.(pool,run.id,owner);return;}await setWindowVisibility(false);
    publish('processing',{phase:'PROSPECT_DISCOVERY',runId:run.id,reason:'Collecting the requested prospect list.'});
    const result=await prospecting.discover(surface.page,run,{pool,owner,log,beforeCheck:async kind=>{
     if(!await discoveryStore.runIsActive(pool,run.id))throw controlError('The prospecting run was stopped.');
     await permit(kind);
     if(!await discoveryStore.runIsActive(pool,run.id))throw controlError('The prospecting run was stopped.');
    }});
    if(result?.paused)await handleSignal(sessionFailure({code:'LINKEDIN_AUTH',reason:result.paused}));
    await flushStatistics(null);
    return;
   }
   const reservation=await core.claim(pool,accountId,owner);
   if(reservation?.disabled)return;
   if(reservation?.limited) {dailyStatus(reservation);return;}
   if(reservation?.paced) {paceStatus(reservation);return;}
   if(reservation?.job){
    claimedJob=reservation.job;
    if(!researchQueue.fullCapture(reservation.job.resumeResult)){if(!await prepareProcessing(a)){await core.releaseClaim?.(pool,reservation.job.jobId,owner);return;}await setWindowVisibility(false);}
    await processJob(reservation.job);
   }
   else publish('ready',{reason:'No profiles waiting for LinkedIn capture. Website research may still be running.'});
  }catch(error){
   if(claimedJob)await core.releaseClaim?.(pool,claimedJob.jobId,owner);
   if(claimedRun)await discoveryStore.releaseSource?.(pool,claimedRun.id,owner);
   if(stopped)return;
   if(error.failure?.stage==='linkedin')await handleSignal(error.failure);
   else if(error.code==='BROWSER_CAPACITY'){handledStart=null;publish('waiting_browser',{startupStage:'BROWSER_STARTING',reason:error.message,reasonCode:error.code});}
   else if(saves.error){publish('recovering',{startupStage:'FAILED',failedStage:'DB_SAVE',reason:saves.error.message,reasonCode:'DB_SAVE_FAILED'});}
   else if(!error.failure&&++startupFailures<3){
    handledStart=null;identity=null;surface=null;await browserOwner.close().catch(()=>{});
    publish('recovering',{startupStage:'FAILED',failedStage:'BROWSER_STARTING',reason:error.message,reasonCode:error.code||'BROWSER_START_FAILED',action:'Retrying automatically, attempt '+startupFailures+'/3. Check Chrome/profile ownership if it persists.'});
   }
   else {
    const reason=error.failure?.reason||'The account session stopped: '+error.message;
    await core.pauseProcessing(pool,accountId,reason,false,owner,activeVersion);
    publish('paused',{startupStage:error.failure?.stage==='control'?'AGENT_ACK':'FAILED',failedStage:'BROWSER_STARTING',reason,reasonCode:error.failure?.code||error.code||'SESSION_ERROR',action:'Review the local Chrome profile and worker log, then Start again.'});
    if(error.failure?.stage!=='control')await setWindowVisibility(true);
   }
  }
 }
 function dailyStatus(limit){publish('DAILY_LIMIT_REACHED',{startupStage:'DAILY_LIMIT_REACHED',reason:`Daily unique profiles: ${limit.used??limit.dailyCount}/${limit.limit??limit.dailyLimit}. Website research continues. Resumes at ${new Date(limit.resumeAt).toLocaleString()} (${limit.timezone}).`,reasonCode:'DAILY_LIMIT_REACHED',nextEligibleAt:limit.resumeAt});}
 function paceStatus(value){publish('sleeping',{reasonCode:'PROFILE_INTERVAL',reason:'One-minute profile interval. Website research continues; the next profile starts at '+new Date(value.resumeAt).toLocaleTimeString()+'.',nextEligibleAt:new Date(value.resumeAt).toISOString()});}
 function close({preserveIntent=false}={}) {
  if(closing)return closing;stopped=true;
  closing=(async()=>{
   await flushStatistics(status.jobId);await saves.close();await releasePendingClaims();
   if(!preserveIntent)await core.pauseProcessing(pool,accountId,'The local account session stopped. Queued work is retained.',false,owner).catch(()=>{});
   watched=null;await browserOwner.close();identity=null;
   publish('offline',{reason:'Local session stopped. Queued work and saved sign-in are retained.'});
  })();
  return closing;
 }
 function disconnected(error) {
  identity=null;surface=null;
  handledStart=null;
  publish(manual||signal?'paused':'recovering',{startupStage:manual||signal?'SESSION_REVIEW':'BROWSER_STARTING',reason:error?.message||'Chrome disconnected. The current job can resume from its checkpoint.',reasonCode:'BROWSER_CLOSED'});
 }
 async function recycle(reason){const hold=status.manualResumeRequired?{reason:status.reason,reasonCode:status.reasonCode,manualResumeRequired:true,startupStage:'SESSION_REVIEW'}:null;const limit=status.status==='DAILY_LIMIT_REACHED'?{reason:status.reason,nextEligibleAt:status.nextEligibleAt,startupStage:'DAILY_LIMIT_REACHED'}:null;await saves.idle();watched=null;await browserOwner.close();identity=null;surface=null;handledStart=null;publish(hold?'paused':limit?'DAILY_LIMIT_REACHED':'ready',hold||limit||{reason:'Chrome closed: '+reason+'. Saved sign-in is retained.'});}
 async function recoverSaves(){await saves.idle();await releasePendingClaims();await core.releaseCaptureClaims?.(pool,accountId,owner);saves.clearError();recoveringJob=false;publish('ready',{reason:'Save queue recovered. Pending profiles resume from PostgreSQL checkpoints.'});}
 return {tick,permit,handleSignal,close,disconnected,recycle,recoverSaves,waitForBrowser:reason=>publish('waiting_browser',{startupStage:'BROWSER_STARTING',reason}),requestStop:()=>{stopped=true;},flush:()=>flushStatistics(status.jobId),drain:()=>saves.idle(),snapshot:()=>({...status,jobsStarted,pendingSaves:saves.size,controlVersion:activeVersion,saveError:saves.error?.message||null,prospectingVersion:'COACH_EVIDENCE_V1'})};
}

module.exports={createAccountRuntime,runtimeVersion};
