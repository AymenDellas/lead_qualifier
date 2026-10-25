'use strict';

const researchModule=require('./prospect-research.cjs');
const qualification=require('./prospect-qualification.cjs');
const defaultCore=require('./linkedin-workers.cjs');
const defaultQueue=require('./worker-research-queue.cjs');
const telemetry=require('./engine-telemetry.cjs');
const publicHttpLane=require('./bounded-work.cjs').createLimiter(3,96);
async function within(task,ms){let timer;try{return await Promise.race([task,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Website rendering deadline reached.')),Math.max(1,ms));})]);}finally{clearTimeout(timer);}}

function researchUrl(value){
 const url=researchModule.publicUrl(value);
 if(/(^|\.)(?:linkedin\.com|licdn\.com)$/i.test(url.hostname))throw new Error('Public research cannot request LinkedIn.');
 return url;
}
// Keep DNS pinning and response bounds from the existing HTTP reader, while
// checking each redirect before it can reach LinkedIn or a private address.
function createPublicFetcher(fetchResource=researchModule.fetchPublicPage){
 return async function fetchPage(value,options={}){
  let url=researchUrl(value),response;
  const signal=options.signal||AbortSignal.timeout(Math.min(options.timeoutMs||10000,12000));
  for(let hop=0;hop<=4;hop++){
   response=await fetchResource(url.href,{...options,signal,resource:true,followRedirects:false});
   if(options.resource)return response;
   if(![301,302,303,307,308].includes(response.status))break;
   if(hop===4)throw new Error('Too many website redirects.');
   const location=response.headers?.location;
   if(!location)throw new Error('Invalid website redirect.');
   url=researchUrl(new URL(location,url).href);
  }
  if(response.status>=400)throw Object.assign(new Error('Website returned HTTP '+response.status+'.'),{httpStatus:response.status});
  if(!/text\/html|application\/xhtml\+xml/i.test(response.headers?.['content-type']||''))throw Object.assign(new Error('The website did not return HTML.'),{code:'NON_HTML'});
  return {url:response.url||url.href,html:response.body.toString('utf8')};
 };
}
function prioritizeEmails(emails,firstName,websiteDomain){
 const fn=(firstName||'').toLowerCase(),wd=(websiteDomain||'').toLowerCase();
 return [...new Set(emails)].map(email=>{
  const [local,domain]=email.toLowerCase().split('@');let rank=50;
  if(wd&&domain===wd&&fn&&local.includes(fn))rank=10;
  else if(wd&&domain===wd&&['hello','hi','hey'].includes(local))rank=20;
  else if(wd&&domain===wd&&!['info','support','admin','billing','help','sales','team','office','noreply','no-reply'].includes(local))rank=60;
  else if(wd&&domain===wd&&['info','contact'].includes(local))rank=22;
  else if(['gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com','protonmail.com'].includes(domain))rank=40;
  else if(['support','admin','billing','help','sales','team','office'].includes(local))rank=80;
  return {email,rank};
 }).sort((a,b)=>a.rank-b.rank).map(item=>item.email);
}
function createResearchRunner(options){
 const {pool,owner}=options;
 if(!pool||!owner)throw new Error('Public research needs a database pool and job owner.');
 const core=options.core||defaultCore,queue=options.queue||defaultQueue;
 const researchProspect=options.researchProspect||researchModule.researchProspect;
 const assessProspect=options.assessProspect||qualification.assessProspect;
 const pipelineForAssessment=options.pipelineForAssessment||qualification.pipelineForAssessment;
 const saveWorkerResearch=options.saveWorkerResearch||require('./worker-research-store.cjs').saveWorkerResearch;
 const finishProspecting=options.finishProspecting||require('./coach-prospecting-worker.cjs').finish;
 const createPageRenderer=options.createPageRenderer||require('./public-page-browser.cjs').createPageRenderer;
 const httpLane=options.httpLane||publicHttpLane;
 const publicFetcher=createPublicFetcher((value,settings)=>httpLane(()=>{
  settings.signal?.throwIfAborted();return (options.fetchResource||researchModule.fetchPublicPage)(value,settings);
 }));
 const fetchPage=require('./website-cache.cjs').createWebsiteCache(pool,publicFetcher);
 const launch=options.launch||((settings)=>require('puppeteer').launch(settings));
 const now=options.now||Date.now,log=options.log||(()=>{});
 let browserTask=null,closed=false,idleTimer=null,closingBrowser=null,renderUsers=0;
 const idleMs=options.publicBrowserIdleMs??Math.max(0,Number(process.env.PUBLIC_BROWSER_IDLE_MS)||15000);
 async function browser(timeoutMs=10000){
  if(closed)throw new Error('Public research is stopping.');
  if(closingBrowser)await closingBrowser;
  if(browserTask){const current=await browserTask;if(current.isConnected?.()===false)browserTask=null;}
  if(!browserTask)browserTask=Promise.resolve().then(async()=>{
   const timeout=Math.max(1,Math.floor(Math.min(10000,timeoutMs))),controller=new AbortController();
   const timer=setTimeout(()=>controller.abort(),timeout);
   try{return await launch({headless:true,timeout,protocolTimeout:10000,signal:controller.signal,
    handleSIGINT:false,handleSIGTERM:false,handleSIGHUP:false,
    args:process.platform==='linux'&&process.getuid?.()===0?['--no-sandbox','--disable-setuid-sandbox']:[],
   });}finally{clearTimeout(timer);}
  }).catch(error=>{browserTask=null;throw error;});
  return browserTask;
 }
 function armIdleClose(){
  clearTimeout(idleTimer);if(!closed&&!renderUsers&&browserTask){idleTimer=setTimeout(()=>{if(!renderUsers)void closeBrowser();},idleMs);idleTimer.unref?.();}
 }
 function renderer(){
  let render,driver;const values=new Map();
  return async(value,settings)=>{
   researchUrl(value);
   if(values.has(value))return values.get(value);
   if(values.size>=3)throw Error('Public browser fallback budget reached.');
   const task=(async()=>{
    const deadline=Date.now()+Math.min(10000,settings?.timeoutMs||10000);renderUsers++;clearTimeout(idleTimer);
    try{
     const b=await within(browser(deadline-Date.now()),deadline-Date.now());const remaining=deadline-Date.now();if(remaining<=0)throw Error('Website rendering exhausted the site deadline.');
     if(driver!==b){driver=b;render=createPageRenderer(b,{fetchResource:publicFetcher,maxPages:3});}
     return await within(render(value,{...settings,timeoutMs:remaining}),remaining);
    }finally{renderUsers--;armIdleClose();}
   })();values.set(value,task);return task;
  };
 }
 async function nativeSave(job,result){
  const research=result.prospectQualification?.research;
  if(!job.nativePostProcess||!research)return;
  const unresolved=result.status==='ERROR',reviewRequired=result.status==='REVIEW';
  if(unresolved){
   if(!research.profileIdentityConfirmed)return;
   const slug=result.url?.match(/\/in\/([^/?#]+)/i)?.[1]?.toLowerCase();
   const existing=await pool.query("SELECT id FROM leads WHERE lower(substring(linkedin_url from '/in/([^/?#]+)'))=$1 AND pipeline_status='QUALIFIED' LIMIT 1",[slug]);
   if(!existing.rowCount)return;
  }
  const saved=await saveWorkerResearch(pool,{linkedinUrl:result.url,firstName:result.firstName,lastName:result.lastName,
   email:result.primaryEmail||'',emailSource:result.emailSource||'',websiteSource:result.websiteSource||'',
   research,jobId:job.jobId,owner,reviewRequired:result.status==='REVIEW'});
  result.crmSaved=true;result.crmLeadId=saved.id;result.prospectQualification=saved.assessment;
  result.primaryEmail=saved.assessment.contact.email;
  if(result.primaryEmail&&!result.emails.includes(result.primaryEmail))result.emails.unshift(result.primaryEmail);
  result.status=unresolved?'ERROR':reviewRequired?'REVIEW':saved.pipelineStatus==='QUALIFIED'?'QUALIFIED':saved.pipelineStatus==='REVIEW'?'REVIEW':'REJECTED';
 }
 function processJob(job){return telemetry.withLead(job,()=>processJobInner(job));}
 async function processJobInner(job){
  if(!queue.fullCapture(job.resumeResult))throw new Error('Public research requires a complete captured profile.');
  if(job.websiteContinuation&&job.resumeResult.status==='QUALIFIED'){
   const result={...job.resumeResult,status:'SKIPPED',previousDecision:'QUALIFIED',logs:[...(job.resumeResult.logs||[]),'Qualification was already decided; redundant remaining crawl skipped.']};
   await core.complete(pool,job.jobId,owner,result);return {jobId:job.jobId,result,deferred:false};
  }
  if(job.prospecting&&!await (options.discoveryStore||require('./coach-prospecting-store.cjs')).runIsActive(pool,job.prospecting.runId)) {
   const result={...job.resumeResult,status:'CANCELLED',logs:[...(job.resumeResult.logs||[]),'Prospecting was stopped; no website research was started.']};
   await core.complete(pool,job.jobId,owner,result);return {jobId:job.jobId,result,deferred:false};
  }
  let result=structuredClone(job.resumeResult);
  result.url=defaultCore.profileUrl(result.url||result.linkedinUrl);
  const previousFailure=result.failure,retryCount=job.retryCount||0;
  result.logs=[...(result.logs||[]),'Public website research resumed from saved profile evidence.'];
  result.status='PENDING';delete result.failure;
  let stage='research';
  try{
   const previousResearch=result.prospectQualification?.baseResearch||result.prospectQualification?.research;
   let knownWebsite='';
   if(!job.prospecting&&!result.decisionStage){
    try{
     const slug=result.url?.match(/\/in\/([^/?#]+)/i)?.[1]?.toLowerCase();
     knownWebsite=(await pool.query("SELECT website FROM leads WHERE lower(substring(linkedin_url from '/in/([^/?#]+)'))=$1 AND NULLIF(website,'') IS NOT NULL ORDER BY created_at LIMIT 1",[slug])).rows[0]?.website||'';
    }catch{result.logs.push('Saved website lookup unavailable; published profile links are retained.');}
   }
   const research=previousFailure?.stage==='crm'&&previousResearch?previousResearch:await researchProspect({
    ...result,linkedinUrl:result.url,knownWebsite,email:result.primaryEmail||result.emails?.[0]||'',
   },{ai:false,previousResearch,fetchPage,renderPage:renderer(),qualificationFirst:!job.prospecting,
    ...(job.prospecting?{maxPages:8,maxTimeMs:30000}:{}),
   });
   if(retryCount>=3&&research.crawl&&!research.crawl.complete&&research.crawl.retryable!==false){
    research.crawl.retryable=false;research.crawl.stoppedReason='Automatic website retries exhausted; saved routes remain for manual review. '+(research.crawl.stoppedReason||'');
   }
   if(job.prospecting){
    result.prospectQualification={...result.prospectQualification,research};
    stage='crm';
    // finishProfile owns prospecting's CRM write. Do not also call nativeSave.
    result=await finishProspecting(pool,owner,job,result);
   }else{
    result.website=research.website||'';
    result.emails=prioritizeEmails((research.contacts||[]).filter(c=>['PUBLISHED','DOMAIN_MATCH'].includes(c.ownership)).map(c=>c.address),result.firstName,qualification.hostOf(research.website));
    result.emails.sort((a,b)=>Number(research.contacts.find(c=>c.address===b)?.source==='linkedin')-Number(research.contacts.find(c=>c.address===a)?.source==='linkedin'));
    result.primaryEmail=result.emails[0]||'';
    const chosen=research.contacts.find(c=>c.address===result.primaryEmail);
    result.emailSource=chosen?.source==='website'?'website_scraped':chosen?.source||'';
    result.prospectQualification=telemetry.spanSync('qualification',()=>assessProspect(research,{email:result.primaryEmail}));
    const q=result.prospectQualification.qualification;
    const pipeline=pipelineForAssessment(result.prospectQualification);
    result.status=q.followers==='REJECTED'?'REJECTED':pipeline==='QUALIFIED'?'QUALIFIED':pipeline==='REVIEW'||q.activity==='UNKNOWN'||!research.profileIdentityConfirmed||q.needsAttention?'REVIEW':q.needsRetry?'ERROR':'REJECTED';
    if(result.status==='REVIEW')result.failure={stage:'qualification',code:q.followersReason||(!research.profileIdentityConfirmed?'PROFILE_IDENTITY':q.activity==='UNKNOWN'?'ACTIVITY_UNCONFIRMED':'CRAWL_INCOMPLETE'),reason:result.prospectQualification.nextAction,retryable:false};
    if(result.status==='ERROR'){
     result.failure=q.activity==='UNKNOWN'||!research.profileIdentityConfirmed
      ?{stage:'linkedin',code:research.profileIdentityConfirmed?'ACTIVITY_UNCONFIRMED':'PROFILE_IDENTITY',reason:research.activityEvidence?.reason||result.prospectQualification.blockers?.[0]||'Captured profile evidence needs manual review.',retryable:false}
      :{stage:'research',code:'CRAWL_INCOMPLETE',reason:research.crawl?.stoppedReason||'Website research is incomplete.',retryable:research.crawl?.retryable!==false};
    }
    if(result.status==='ERROR'&&result.failure?.retryable===false)result.status='REVIEW';
    stage='crm';await telemetry.span('crm.save',()=>nativeSave(job,result));
   }
  }catch(error){
   result.status='ERROR';
   if(stage==='crm')result.crmSaved=false;
   result.failure={stage,code:stage==='crm'?'CRM_SAVE':'RESEARCH_FAILED',reason:stage==='crm'?'CRM save failed; captured profile and research retained.':'Website research could not complete; captured profile retained.',retryable:true};
   result.logs=[...(result.logs||[]),result.failure.reason+' '+error.message];
  }
  // The public worker never schedules LinkedIn retries, even if old snapshots
  // carry a transient account failure. Only website and CRM work can retry.
  const failure=result.failure;
  if(result.status==='ERROR'&&failure?.retryable&&['research','crm'].includes(failure.stage)&&retryCount<3){
   failure.retryAt=new Date(now()).toISOString();
   await core.checkpoint(pool,job.jobId,owner,result);
   await core.defer(pool,job.jobId,owner,result,failure.retryAt);
   log('Public research deferred for '+job.jobId+': '+failure.reason);
   return {jobId:job.jobId,result,deferred:true};
  }
  if(failure){
   failure.retryable=false;delete failure.retryAt;
   if(retryCount>=3&&['research','crm'].includes(failure.stage))failure.reason='Automatic retries exhausted. '+failure.reason;
  }
  if(result.status==='ERROR'&&failure?.retryable===false)result.status='REVIEW';
  try{await core.complete(pool,job.jobId,owner,result);}catch(error){
   error.engineJobId=job.jobId;error.resumeResult=telemetry.attach({...result,status:'PENDING',failure:{stage:'crm',code:'RESULT_SAVE_PENDING',reason:'Final database acknowledgement failed; completed research retained.',retryable:true}});throw error;
  }
  if(options.onComplete)await options.onComplete(job,result);
  return {jobId:job.jobId,result,deferred:false};
 }
 async function runOnce(){
  if(closed)return null;
  const claimed=await queue.claim(pool,owner);
  if(!claimed)return null;
  try{return await processJob(claimed.job);}catch(error){error.engineJobId=claimed.job.jobId;error.resumeResult||=claimed.job.resumeResult;throw error;}
 }
 function closeBrowser(){
  if(closingBrowser)return closingBrowser;
  const pending=browserTask;browserTask=null;
  closingBrowser=(async()=>{
   const b=await pending?.catch(()=>null);
   if(b){
    let timer;
    try{await Promise.race([Promise.resolve().then(()=>b.close()).catch(()=>{}),new Promise(resolve=>{timer=setTimeout(resolve,2500);})]);}
    finally{clearTimeout(timer);}
    const owned=b.process?.();
    if(Number.isInteger(owned?.pid)&&owned.pid>0&&owned.exitCode==null){
     try{
      if(process.platform==='win32')require('node:child_process').execFileSync('taskkill',['/PID',String(owned.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',timeout:5000});
      else owned.kill('SIGKILL');
     }catch{/* only this public browser's process can be targeted */}
    }
   }
  })().finally(()=>{closingBrowser=null;});return closingBrowser;
 }
 async function close(){closed=true;clearTimeout(idleTimer);await closeBrowser();}
 return {runOnce,process:processJob,close};
}
module.exports={createResearchRunner,createPublicFetcher,prioritizeEmails,researchUrl};
