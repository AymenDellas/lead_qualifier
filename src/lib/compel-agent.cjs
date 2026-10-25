'use strict';
const path=require('node:path'),os=require('node:os');
const defaultCore=require('./linkedin-workers.cjs'),registry=require('./agent-registry.cjs');
const {createAccountRuntime}=require('./account-runtime.cjs'),{createAccountBrowser}=require('./account-browser.cjs');
const {createBrowserCoordinator}=require('./browser-coordinator.cjs');
const {createResearchRunner}=require('./worker-research-runner.cjs'),researchQueue=require('./worker-research-queue.cjs');
const READ_CONTROL=`SELECT c.active_count,c.agent_stop_requested,
 COALESCE((SELECT jsonb_agg(row_to_json(a)) FROM (SELECT id,label,profile_key,enabled,processing_enabled AS authorized,attention_reason,
 login_requested_at::text AS login_token,logout_requested_at::text AS logout_token,changed_at::text AS control_version
 FROM compel_linkedin_accounts WHERE NOT archived ORDER BY position,id) a),'[]'::jsonb) AS accounts FROM compel_worker_config c WHERE c.id=1`;
function integer(value,fallback,min=1,max=Infinity){const n=value==null||value===''?fallback:Number(value);if(!Number.isInteger(n)||n<min||n>max)throw Error('Invalid agent resource configuration.');return n;}
function createAgent(options){
 const {root,pool,owner}=options,core=options.core||defaultCore,now=options.now||Date.now,log=options.log||console.log;
 const maxBrowsers=integer(options.maxBrowsers??process.env.MAX_ACTIVE_BROWSERS,1,1,10),maxJobs=integer(options.recycleJobs??process.env.CHROME_RECYCLE_JOBS,10),
  memoryLimit=integer(options.recycleMB??process.env.CHROME_RECYCLE_RSS_MB,1536),idleMs=integer(options.idleMs??process.env.LINKEDIN_BROWSER_IDLE_MS,30000,0);
 const entries=new Map(),stages={},failures=new Map(),coordinator=createBrowserCoordinator({max:maxBrowsers,owner,log});
 const makeRuntime=options.createRuntime||createAccountRuntime,makeBrowser=options.createBrowser||createAccountBrowser;
 const runner=options.runner||createResearchRunner({pool,owner:owner+'/research',log});
 const readControl=options.readControl||(async()=> (await pool.query(READ_CONTROL)).rows[0]);
 const acquire=options.acquireAccount||(async(id,accountOwner)=>{await registry.accountAvailable(pool,id,accountOwner);return core.acquireSession(pool,id,accountOwner);});
 let stopped=false,failure=null,controlDue=0,controlBackoff=2000,resource=null,waker=null,heartbeatTask=null,heartbeatTimer=null,control=null;
 const research=[{task:null,due:0,backoff:2000},{task:null,due:0,backoff:2000}],publicFailures=new Map();
 const localState=process.env.LOCALAPPDATA||process.env.XDG_STATE_HOME||path.join(os.homedir(),'.local','state');
 const notify=()=>{waker?.();};
 function wake(){controlDue=0;controlBackoff=2000;for(const e of entries.values())e.due=0;for(const lane of research)lane.due=0;notify();}
 function wakeResearch(){for(const lane of research)lane.due=0;notify();}
 function memory(entry){return resource?.chromeRoots?.find(row=>row.pid===entry.browser.pid())?.rssMB||0;}
 function stage(id,value){
  const before=stages[id];stages[id]={...value,at:new Date(now()).toISOString()};
  if(value.startupStage&&before?.startupStage!==value.startupStage){
   const task=options.onStage?options.onStage(id,stages[id]):pool.query(`INSERT INTO compel_worker_events(account_id,kind,message,data)
    VALUES($1,'startup',$2,$3::jsonb)`,[id,value.startupStage+': '+(value.reason||''),JSON.stringify({stage:value.startupStage,failedStage:value.failedStage,action:value.action})]);
   Promise.resolve(task).catch(error=>log('Startup history: '+error.message));
  }
 }
 async function add(account){
  const accountOwner=owner+'/'+account.id;
  if(!await acquire(account.id,accountOwner))throw Error('Account lease was not acquired. Stop its old owner or wait for its verified release.');
  const entry={account,owner:accountOwner,browser:null,runtime:null,task:null,closing:null,due:0,backoff:2000,lastWorkAt:now(),jobs:0,lastJobs:0};
  const inner=makeBrowser({root,account,profileRoot:process.env.WORKER_PROFILE_ROOT||path.join(localState,'Compel','worker-profiles'),onDisconnect:error=>{entry.runtime?.disconnected(error);entry.due=0;notify();}});
  entry.browser=coordinator.wrap(account.id,inner);
  entry.runtime=makeRuntime({pool,accountId:account.id,owner:accountOwner,core,browserOwner:entry.browser,log,wakeResearch,
   onStatus:value=>stage(account.id,{...value,controlVersion:value.controlVersion||account.control_version}),
  });
  entries.set(account.id,entry);stage(account.id,{startupStage:'AGENT_ACK',reason:'Agent acknowledged the request.',controlVersion:account.control_version});return entry;
 }
 async function retire(entry){
  if(entry.closing)return entry.closing;
  entry.closing=(async()=>{
   entry.runtime.requestStop?.();await entry.browser.close().catch(error=>log(error.message));await entry.task?.catch(()=>{});
   await entry.runtime.close({preserveIntent:true});await core.releaseSession(pool,entry.account.id,entry.owner,{...entry.runtime.snapshot(),agentPid:process.pid,agentHost:registry.hostId,agentOwner:owner});
   entries.delete(entry.account.id);
  })();return entry.closing;
 }
 async function reconcile(){
  control=await readControl();if(control?.agent_stop_requested){stopped=true;return;}
  const rows=control?.accounts||[],byId=new Map(rows.map(a=>[a.id,a]));
  for(const entry of [...entries.values()]){
   const account=byId.get(entry.account.id);
   if(!account||!account.enabled&&!account.login_token&&!account.logout_token){void retire(entry).catch(error=>log('Account shutdown: '+error.message));continue;}
   entry.account=account;
  }
  for(const account of rows){
   if(entries.has(account.id))continue;
   if(!account.login_token&&!account.logout_token&&(!account.authorized||!account.enabled||account.attention_reason))continue;
   if(failures.get(account.id)===account.control_version)continue;
   try{await add(account);}catch(error){
    failures.set(account.id,account.control_version);stage(account.id,{startupStage:'FAILED',failedStage:'AGENT_ACK',reason:error.message,action:'Stop the previous owner, check its heartbeat, then request Start or Open session again.',controlVersion:account.control_version});
   }
  }
  const active=[...entries.values()].some(e=>e.account.authorized||e.account.login_token||['awaiting_login','recovering'].includes(e.runtime.snapshot().status));
  controlBackoff=active?2000:Math.min(30000,controlBackoff*2);controlDue=now()+controlBackoff;
 }
 async function finish(entry,before){
  const state=entry.runtime.snapshot(),worked=(state.jobsStarted||0)>before;
  if(state.saveError){
   entry.saveFailures=(entry.saveFailures||0)+1;
   if(entry.saveFailures<=2)await entry.runtime.recoverSaves();
   else {await core.pauseProcessing(pool,entry.account.id,'PostgreSQL save retries exhausted: '+state.saveError,false,entry.owner,entry.account.control_version);entry.due=now()+30000;return;}
  }else if(worked)entry.saveFailures=0;
  if(worked){entry.lastWorkAt=now();entry.jobs+=(state.jobsStarted||0)-before;}
  const manual=['awaiting_login','SESSION_REVIEW'].includes(state.status)||state.startupStage==='SESSION_REVIEW'||state.manualResumeRequired;
  const needsManual=[...entries.values()].some(other=>other!==entry&&(other.account.login_token||other.account.logout_token));
  if(entry.browser.isOpen()&&!manual&&(entry.jobs>=maxJobs||memory(entry)>memoryLimit||needsManual||!worked&&now()-entry.lastWorkAt>=idleMs)){
   await entry.runtime.recycle(entry.jobs>=maxJobs?'automatic job-count recycle':memory(entry)>memoryLimit?'Chrome process-tree memory threshold':needsManual?'another account requested manual review':'idle timeout');
   entries.delete(entry.account.id);entries.set(entry.account.id,entry);
   entry.jobs=0;for(const other of entries.values())if(other.runtime.snapshot().status==='waiting_browser')other.due=0;
  }else if(!entry.browser.isOpen()&&coordinator.reserved.has(entry.account.id))await entry.browser.close();
  entry.backoff=worked||state.status==='recovering'?2000:Math.min(30000,entry.backoff*2);
  entry.due=worked||state.status==='recovering'?now():now()+entry.backoff;
 }
 function runAccount(entry){
  const before=entry.runtime.snapshot().jobsStarted||0;
  entry.task=Promise.resolve().then(()=>entry.runtime.tick()).then(()=>finish(entry,before)).catch(error=>{
   stage(entry.account.id,{startupStage:'FAILED',failedStage:'PROCESSING',reason:error.message,action:'Check PostgreSQL and the local worker log, then Start again.',controlVersion:entry.account.control_version});
   entry.due=now()+30000;log('Account: '+error.message);
  }).finally(()=>{entry.task=null;notify();});
 }
 async function step(){
  if(stopped)return;if(now()>=controlDue)await reconcile();if(stopped)return;
  const scheduled=[...entries.values()].sort((a,b)=>Number(!!(b.account.login_token||b.account.logout_token))-Number(!!(a.account.login_token||a.account.logout_token)));
  for(const entry of scheduled){
   if(entry.closing||entry.task||now()<entry.due)continue;
   if((entry.account.login_token||entry.account.logout_token)&&!coordinator.reserved.has(entry.account.id)&&coordinator.reserved.size>=maxBrowsers){
    entry.runtime.waitForBrowser?.('Waiting for the available LinkedIn browser. Another account owns it.');entry.due=now()+entry.backoff;entry.backoff=Math.min(30000,entry.backoff*2);continue;
   }
   runAccount(entry);
  }
  for(const lane of research)if(!lane.task&&now()>=lane.due){
   lane.task=runner.runOnce().then(result=>{if(result?.jobId)publicFailures.delete(result.jobId);lane.backoff=result?2000:Math.min(30000,lane.backoff*2);lane.due=result?now():now()+lane.backoff;})
    .catch(async error=>{log('Public research: '+error.message);lane.due=now()+30000;
     if(error.engineJobId)try{
      const attempts=(publicFailures.get(error.engineJobId)||0)+1;publicFailures.set(error.engineJobId,attempts);
      if(attempts>2)throw Error('Public result save failed repeatedly for '+error.engineJobId+': '+error.message+'. Check PostgreSQL, then restart; checkpoints are retained.');
      await researchQueue.releaseJob(pool,error.engineJobId,owner+'/research',error.resumeResult);lane.due=now();
     }catch(cause){failure=cause;stopped=true;notify();}
    }).finally(()=>{lane.task=null;notify();});
  }
 }
 async function heartbeat(){
  if(heartbeatTask)return heartbeatTask;
  heartbeatTask=(async()=>{
   const state={stage:'AGENT_ACK',accounts:stages,resources:resource};
   if(options.onHeartbeat)await options.onHeartbeat(state);else if(await registry.heartbeat(pool,owner,state))stopped=true;
   for(const entry of [...entries.values()])if(!entry.closing){
    entry.browser.heartbeat?.();await entry.runtime.flush?.();
    await core.heartbeat(pool,entry.account.id,entry.owner,{...entry.runtime.snapshot(),memoryMB:memory(entry),agentPid:process.pid,agentHost:registry.hostId,agentOwner:owner});
   }
   await researchQueue.heartbeat(pool,owner+'/research');
  })().finally(()=>{heartbeatTask=null;notify();});return heartbeatTask;
 }
 function start(){heartbeatTimer=setInterval(()=>void heartbeat().catch(error=>{failure=error;log('Agent heartbeat failed: '+error.message);stopped=true;notify();}),10000);heartbeatTimer.unref();}
 function wait(){
  if(stopped)return Promise.resolve();const due=[controlDue,...[...entries.values()].filter(e=>!e.task&&!e.closing).map(e=>e.due),...research.filter(l=>!l.task).map(l=>l.due)];
  return new Promise(resolve=>{const timer=setTimeout(()=>{waker=null;resolve();},Math.max(1,Math.min(30000,Math.min(...due)-now())));waker=()=>{clearTimeout(timer);waker=null;resolve();};});
 }
 async function close(){
  stopped=true;clearInterval(heartbeatTimer);notify();
  for(const entry of entries.values())entry.runtime.requestStop?.();
  await Promise.allSettled([...entries.values()].map(retire));await Promise.allSettled(research.map(l=>l.task).filter(Boolean));
  await runner.close();await researchQueue.release(pool,owner+'/research');await heartbeatTask?.catch(()=>{});
 }
 return {step,start,heartbeat,wait,wake,close,stop:()=>{stopped=true;notify();},setResources:value=>{resource=value;},entries,stages,coordinator,get stopped(){return stopped;},get failure(){return failure;}};
}
module.exports={createAgent,READ_CONTROL,integer};
