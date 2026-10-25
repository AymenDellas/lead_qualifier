'use client';
import { useEffect, useRef, useState } from 'react';
import { Loader2, Plus, Settings2, Users, X, Power, Play, Pause, ExternalLink } from 'lucide-react';
import type { WorkerAccount, WorkerSettings, WorkerAccountEvent } from '@/lib/linkedin-workers.cjs';
import type { SupervisorStatus } from '@/lib/worker-supervisor-control.cjs';
type Draft = Omit<WorkerAccount, 'id'> & {id?:string;password?:string};
type AccountAction = 'login'|'logout'|'start'|'pause';
async function readSettings(): Promise<WorkerSettings> {
 const response = await fetch('/api/linkedin-accounts',{cache:'no-store'});
 if (!response.ok) throw new Error('Could not load LinkedIn accounts.');
 return response.json();
}
function statusLabel(a:WorkerAccount) {
 if(a.startupStage==='FAILED')return 'Start failed';
 if(a.status==='DAILY_LIMIT_REACHED')return 'Daily limit reached';
 if(a.status==='recovering')return 'Recovering';
 if(a.status==='waiting_browser')return 'Waiting for browser';
 if(a.logoutPending)return a.status==='paused'?'Sign-out needs attention':'Signing out';
 if(a.signedOut)return 'Signed out';
 if(a.online&&a.status==='awaiting_login')return 'Complete sign-in in Chrome';
 if(a.loginPending||a.online&&a.status==='starting'&&!a.processingEnabled)return 'Opening session';
 if(a.attentionReason)return 'Needs review';
 if(!a.enabled)return 'Disabled';
 if(!a.processingEnabled)return a.connectedAt?(a.browserOpen===false?'Session saved · Browser closed':'Connected · Idle'):'Not connected';
 if (a.online) return a.status==='processing'?'Processing':a.status==='sleeping'?'Resting':a.status==='paused'?/^Daily limit/.test(a.reason)?'Daily limit reached':'Needs attention':a.status==='starting'?'Starting':'Ready';
 return a.status==='paused'?'Needs attention':'Offline';
}
async function updateAccount(id:string,action:AccountAction):Promise<WorkerSettings> {
 const response=await fetch('/api/linkedin-accounts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,action})});
 const value=await response.json();if(!response.ok)throw new Error(value.error||'Could not update account.');
 return value;
}
function actionNotice(action:AccountAction) {
 return action==='login'?'Session requested. Complete any sign-in or review in Chrome on the worker computer.':action==='start'?'Batch requested.':action==='pause'?'Processing paused. Your Chrome session and queued work are saved.':'Sign-out requested.';
}
function AccountReason({account:a}:{account:WorkerAccount}) {
 const reasons=[...new Set([a.attentionReason,a.startupReason,a.reason].filter(Boolean))];
 return <>{a.startupStage&&<p className="text-xs text-[var(--text-faint)]">{a.startupStage}{a.failedStage?` · Failed at ${a.failedStage}`:''}</p>}{a.startupAction&&<p className="text-xs text-[var(--bad)]">{a.startupAction}</p>}{reasons.map(reason=><p key={reason} className={`text-xs leading-relaxed break-words ${a.attentionReason?'text-[var(--bad)]':'text-[var(--text-dim)]'}`}>{reason}</p>)}
  {a.nextEligibleAt&&<p className="text-xs text-[var(--text-dim)]">Next eligible {new Date(a.nextEligibleAt).toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}.</p>}
 </>;
}
function SessionIdentity({account,accounts}:{account:WorkerAccount;accounts:WorkerAccount[]}) {
 if(account.signedOut)return <p className="field-hint">LinkedIn signed out. Sign in on the worker computer to reconnect.</p>;
 const identity=account.signedIn;
 if(!identity)return <p className="field-hint">Signed-in LinkedIn profile not confirmed yet.</p>;
 const duplicates=accounts.filter(other=>other.id!==account.id&&other.signedIn&&(
  !!identity.profileUrl&&other.signedIn.profileUrl===identity.profileUrl||!!identity.memberUrn&&other.signedIn.memberUrn===identity.memberUrn));
 return <div className="space-y-1 text-xs">
  <p className="text-[var(--text-dim)]">{account.online&&(account.sessionReady||account.processingEnabled&&['ready','processing'].includes(account.status))?'Signed in as':'Last confirmed LinkedIn member'}: {identity.profileUrl?<a href={identity.profileUrl} target="_blank" rel="noopener noreferrer" className="text-[var(--text)] underline underline-offset-2">{identity.name} ↗</a>:<span className="text-[var(--text)]">{identity.name}</span>}</p>
  {identity.profileUrl&&<p className="text-[var(--text-dim)] break-all">{new URL(identity.profileUrl).pathname}</p>}
  {duplicates.length>0&&<p className="text-[var(--bad)]">Same LinkedIn profile as {duplicates.map(other=>other.label).join(', ')}.</p>}
 </div>;
}
export default function LinkedInAccounts() {
 const [config,setConfig]=useState<WorkerSettings|null>(null),[error,setError]=useState(''),[editing,setEditing]=useState(false);
 const [supervisor,setSupervisor]=useState<SupervisorStatus|null>(null),[workerError,setWorkerError]=useState(''),[startingWorkers,setStartingWorkers]=useState(false);
 const [pendingAction,setPendingAction]=useState<{id:string;action:AccountAction}|null>(null),[actionResult,setActionResult]=useState<{id:string;message:string;error:boolean}|null>(null);
 const signInActive=!!config?.accounts.some(a=>a.loginPending||a.online&&['starting','awaiting_login'].includes(a.status)&&!a.processingEnabled);
 useEffect(()=>{
  let active=true,refreshing=false;
  const refresh=async()=>{
   if(refreshing)return;refreshing=true;
   try{const value=await readSettings();if(active){setConfig(value);setError('');}}
   catch(e){if(active)setError(e instanceof Error?e.message:'Could not load accounts.');}
   finally{refreshing=false;}
  };
  const refreshSupervisor=()=>fetch('/api/worker-supervisor',{cache:'no-store'}).then(async response=>{
   const value=await response.json();if(!response.ok)throw new Error(value.error||'Could not check workers.');return value;
  }).then(value=>{if(active){setSupervisor(value);setWorkerError('');}}).catch(e=>{if(active)setWorkerError(e.message);});
  refresh();refreshSupervisor();const timer=setInterval(refresh,signInActive?2000:10000),supervisorTimer=setInterval(refreshSupervisor,10000);
  return()=>{active=false;clearInterval(timer);clearInterval(supervisorTimer);};
 },[signInActive]);
 useEffect(()=>{
  if(supervisor?.state!=='starting')return;
  let active=true;
  const timer=setInterval(async()=>{
   try {
    const response=await fetch('/api/worker-supervisor',{cache:'no-store'}),value=await response.json();
    if(!response.ok)throw new Error(value.error||'Could not check workers.');
    if(active){setSupervisor(value);setWorkerError('');if(value.state==='online')setConfig(await readSettings());}
   }catch(e){if(active)setWorkerError(e instanceof Error?e.message:'Could not check workers.');}
  },2000);
  return()=>{active=false;clearInterval(timer);};
 },[supervisor?.state]);
 async function startWorkers() {
  if(startingWorkers)return;
  setStartingWorkers(true);setWorkerError('');
  try {
   const response=await fetch('/api/worker-supervisor',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'start'})});
   const value=await response.json();if(!response.ok)throw new Error(value.error||'Could not start workers.');
   setSupervisor(value);if(value.state==='online')setConfig(await readSettings());
  }catch(e){setWorkerError(e instanceof Error?e.message:'Could not start workers.');}finally{setStartingWorkers(false);}
 }
 async function accountAction(id:string,action:AccountAction) {
  if(pendingAction)return;
  setPendingAction({id,action});setActionResult(null);
  try{setConfig(await updateAccount(id,action));setActionResult({id,message:actionNotice(action),error:false});}
  catch(e){setActionResult({id,message:e instanceof Error?e.message:'Could not update account.',error:true});}
  finally{setPendingAction(null);}
 }
 const workerOnline=supervisor?.state==='online';
 const workerControls=<SupervisorControls status={supervisor} error={workerError} busy={startingWorkers} onStart={startWorkers}/>;
 return <>
  <section className="panel">
   <div className="panel-head"><Users className="w-3.5 h-3.5"/> LinkedIn accounts
    <button className="btn btn-ghost !p-1.5 ml-auto" aria-label="Manage LinkedIn accounts" onClick={()=>setEditing(true)} disabled={!config||!!pendingAction}><Settings2 className="w-4 h-4"/></button>
   </div>
   <div className="panel-body space-y-3">
    {error&&<p role="alert" className="text-sm text-[var(--bad)]">{error}</p>}
    {!config?(!error&&<p className="text-sm text-[var(--text-dim)]">Loading accounts…</p>):<>
     {workerControls}
     {config.accounts.length===0?<><p className="text-sm text-[var(--text-dim)]">Add a LinkedIn account, connect it in Chrome, then start a batch.</p><button className="btn btn-outline w-full" onClick={()=>setEditing(true)}><Plus className="w-3.5 h-3.5"/> Add account</button></>:<>
      <div className="divide-y divide-[var(--line)]">
       {config.accounts.map(a=><div key={a.id} role="group" aria-label={a.label} className="space-y-3 py-4 first:pt-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs"><span className="font-medium text-[var(--text)] break-all" title={a.email}>{a.label}</span><span className="text-[var(--text-dim)]">{statusLabel(a)}</span></div>
        <SessionIdentity account={a} accounts={config.accounts}/>
        <AccountReason account={a}/>
        <AccountActions account={a} disabled={!!pendingAction} busy={pendingAction?.id===a.id} pendingAction={pendingAction?.id===a.id?pendingAction.action:undefined} workerOnline={workerOnline} hasCapacity={config.activeCount>0} onAction={action=>accountAction(a.id,action)}/>
        {actionResult?.id===a.id&&<p role={actionResult.error?'alert':'status'} className={`text-xs leading-relaxed ${actionResult.error?'text-[var(--bad)]':'text-[var(--text-dim)]'}`}>{actionResult.message}</p>}
        <p className="text-xs leading-relaxed text-[var(--text-faint)]"><span className="num">{a.dailyCount}/{a.dailyLimit}</span> profiles today · <span className="num">{(a.dailyRequests||0).toLocaleString()}</span> interactions · <span className="num">{(a.dailyCachedProfiles||0).toLocaleString()}</span> reused</p>
       </div>)}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--line)] pt-3"><span className="text-xs text-[var(--text-faint)]">{config.activeCount} processing {config.activeCount===1?'slot':'slots'}</span><button className="btn btn-ghost !text-xs" disabled={!!pendingAction} onClick={()=>setEditing(true)}>Manage accounts</button></div>
     </>}
    </>}
   </div>
   <p className="panel-note">{!workerOnline?'Start workers, connect your account, then start a batch.':'Connect once. Start a batch when ready; Pause keeps your Chrome session and queued work.'}</p>
  </section>
  {editing&&config&&<AccountEditor initial={config} liveAccounts={config.accounts} workerControls={workerControls} workerOnline={workerOnline} onClose={()=>setEditing(false)} onUpdated={setConfig} onSaved={value=>{setConfig(value);setEditing(false);}}/>}
 </>;
}
function SupervisorControls({status,error,busy,onStart}:{status:SupervisorStatus|null;error:string;busy:boolean;onStart:()=>void}) {
 const starting=busy||status?.state==='starting';
 return <div className="space-y-2" aria-label="Worker service controls">
  <div className="flex flex-wrap items-center gap-3">
   <span role="status" className="text-xs text-[var(--text-dim)]">{starting?'Starting workers…':status?.state==='online'?'Workers online':status?.state==='unresponsive'?'Workers need attention':status?.state==='unavailable'?'Local worker controls unavailable':status?'Workers offline':'Checking workers…'}</span>
   {status?.state!=='online'&&<button type="button" className="btn btn-outline !text-xs" disabled={starting||!status?.canStart} onClick={onStart}>
    {starting?<Loader2 className="w-3.5 h-3.5 animate-spin"/>:<Power className="w-3.5 h-3.5"/>}{starting?'Starting…':'Start workers'}
   </button>}
  </div>
  {status?.message&&status.state!=='online'&&<p className="field-hint">{status.stage&&`${status.stage} · `}{status.message} {status.action}</p>}
  {error&&<p role="alert" className="text-sm text-[var(--bad)]">{error}</p>}
 </div>;
}
function AccountEditor({initial,liveAccounts,workerControls,workerOnline,onClose,onSaved,onUpdated}:{initial:WorkerSettings;liveAccounts:WorkerAccount[];workerControls:React.ReactNode;workerOnline:boolean;onClose:()=>void;onSaved:(value:WorkerSettings)=>void;onUpdated:(value:WorkerSettings)=>void}) {
 const dialog=useRef<HTMLDialogElement>(null);
 const [accounts,setAccounts]=useState<Draft[]>(initial.accounts.map(a=>({...a}))),[activeCount,setActiveCount]=useState(initial.activeCount);
 const [revision,setRevision]=useState(initial.revision);
 const [saving,setSaving]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [actionAccount,setActionAccount]=useState<string|null>(null);
 useEffect(()=>{dialog.current?.showModal();},[]);
 const enabled=accounts.filter(a=>a.enabled).length;
 const update=(index:number,patch:Partial<Draft>)=>setAccounts(current=>current.map((a,i)=>i===index?{...a,...patch}:a));
 async function save(event:React.FormEvent) {
  event.preventDefault();setSaving(true);setError('');setNotice('');setActionAccount(null);
  try{
   const response=await fetch('/api/linkedin-accounts',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision,activeCount,accounts})});
   const value=await response.json();if(!response.ok)throw new Error(value.error||'Could not save accounts.');
   onSaved(value);
  }catch(e){setError(e instanceof Error?e.message:'Could not save accounts.');}finally{setSaving(false);}
 }
 const savedFields=(values:Draft[])=>values.map(a=>[a.id,a.label,a.email,a.enabled,a.dailyLimit]);
 const dirty=JSON.stringify(savedFields(accounts))!==JSON.stringify(savedFields(initial.accounts))||activeCount!==initial.activeCount;
 async function accountAction(id:string,action:AccountAction) {
  setSaving(true);setError('');setNotice(action==='login'?'Opening session…':'Updating account…');setActionAccount(id);
  try{
   const value=await updateAccount(id,action);
   setRevision(value.revision);
   setAccounts(current=>action==='pause'?current.map(a=>({...value.accounts.find((server:WorkerAccount)=>server.id===a.id),...a,...(a.id===id?{processingEnabled:false,processingUntil:null}:{})})):value.accounts);
   setActiveCount(value.activeCount);onUpdated(value);
   setNotice(actionNotice(action));
  }catch(e){setNotice('');setError(e instanceof Error?e.message:'Could not update account.');}finally{setSaving(false);}
 }
 return <dialog ref={dialog} onCancel={onClose} onClose={onClose} className="m-auto p-0 overflow-hidden w-[min(720px,calc(100vw-24px))] max-h-[90dvh] rounded-lg border border-[var(--line)] bg-[var(--surface-1)] text-[var(--text)] backdrop:bg-black/70">
  <form onSubmit={save} className="flex flex-col max-h-[90dvh]">
   <div className="panel-head shrink-0 !px-5 !py-4"><Users className="w-4 h-4"/> LinkedIn accounts<button type="button" className="btn btn-ghost ml-auto !p-1.5" aria-label="Close account settings" onClick={onClose} disabled={saving}><X className="w-4 h-4"/></button></div>
   <div className="p-5 min-h-0 overflow-y-auto space-y-5">
    {workerControls}
    <div className="flex flex-wrap items-center gap-3">
     <label htmlFor="active-accounts" className="field-label">Maximum accounts processing at once</label>
     <select id="active-accounts" className="field !w-auto min-w-20" value={Math.min(activeCount,enabled)} onChange={e=>setActiveCount(Number(e.target.value))} disabled={saving}>
      {Array.from({length:enabled+1},(_,n)=><option key={n} value={n}>{n===0?'0 — Pause all':n}</option>)}
     </select>
    </div>
    <p className="field-hint">Connect and Start batch are also available in the main panel. Changing settings does not start processing.</p>
    <div className="space-y-5">
     {accounts.map((a,index)=><fieldset key={a.id||`new-${index}`} className="border-t border-[var(--line)] pt-4 space-y-3" disabled={saving}>
      <legend className="sr-only">LinkedIn account {index+1}</legend>
      <div className="flex items-center justify-between gap-3">
       <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={a.enabled} onChange={e=>{update(index,{enabled:e.target.checked});if(!e.target.checked)setActiveCount(n=>Math.min(n,enabled-1));}} className="accent-[var(--signal)]"/> Available to start · Account {index+1}</label>
       <div className="flex items-center gap-2"><span className="text-xs text-[var(--text-dim)]">{a.id?statusLabel(liveAccounts.find(other=>other.id===a.id)||a as WorkerAccount):'New account'}</span><button type="button" className="btn btn-ghost !text-[var(--bad)] !text-xs" onClick={()=>{setAccounts(current=>current.filter((_,i)=>i!==index));setActiveCount(n=>Math.min(n,enabled-(a.enabled?1:0)));}}>Remove</button></div>
      </div>
      {a.id&&<SessionIdentity account={liveAccounts.find(other=>other.id===a.id)||a as WorkerAccount} accounts={liveAccounts}/>}
      <div className="grid sm:grid-cols-2 gap-3">
       <label className="space-y-1"><span className="field-label">Account name</span><input className="field w-full" required maxLength={80} value={a.label} onChange={e=>update(index,{label:e.target.value})} placeholder="e.g. Main account"/></label>
       <label className="space-y-1"><span className="field-label">LinkedIn email</span><input className="field w-full" type="email" required readOnly={!!a.id} value={a.email} onChange={e=>update(index,{email:e.target.value})} autoComplete="off" placeholder="you@example.com"/></label>
       <label className="space-y-1"><span className="field-label">Profiles per day</span><input className="field w-full" type="number" required min={1} max={400} value={a.dailyLimit} onChange={e=>update(index,{dailyLimit:Number(e.target.value)})}/></label>
      </div>
      {a.id&&<AccountReason account={liveAccounts.find(other=>other.id===a.id)||a as WorkerAccount}/>}
      {a.id&&<AccountActions account={liveAccounts.find(other=>other.id===a.id)||a as WorkerAccount} disabled={saving||dirty} pauseDisabled={saving} busy={saving} workerOnline={workerOnline} hasCapacity={activeCount>0} advanced onAction={action=>accountAction(a.id!,action)}/>}
      {actionAccount===a.id&&notice&&<p role="status" className="text-sm text-[var(--signal)]">{notice}</p>}
      {actionAccount===a.id&&error&&<p role="alert" className="text-sm text-[var(--bad)]">{error}</p>}
      {a.id&&<AccountHistory id={a.id} updatedAt={(liveAccounts.find(other=>other.id===a.id)||a).updatedAt}/>}
     </fieldset>)}
    </div>
    <button type="button" className="btn btn-outline" disabled={saving||accounts.length>=10} onClick={()=>{setAccounts(current=>[...current,{label:`Account ${current.length+1}`,email:'',enabled:true,dailyLimit:400,hasPassword:false,dailyCount:0,status:'offline',reason:'',online:false,loginPending:false,updatedAt:null}]);if(!accounts.length)setActiveCount(1);}}><Plus className="w-3.5 h-3.5"/> Add account</button>
    <p className="field-hint">Sign in manually in Chrome on the worker computer. The only usage limit is unique profiles per account per day. Interaction counts are statistics. LinkedIn security notices stop the account until you review it.</p>
    {dirty&&<p className="field-hint">Save your account changes before signing in or starting processing.</p>}
    {!actionAccount&&notice&&<p role="status" className="text-sm text-[var(--signal)]">{notice}</p>}
    {!actionAccount&&error&&<p role="alert" className="text-sm text-[var(--bad)]">{error}</p>}
   </div>
   <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-[var(--line)] shrink-0"><button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>Cancel</button><button className="btn btn-primary" disabled={saving}>{saving&&<Loader2 className="w-3.5 h-3.5 animate-spin"/>} Save accounts</button></div>
  </form>
 </dialog>;
}

function AccountActions({account:a,disabled,pauseDisabled=disabled,busy,pendingAction,workerOnline,hasCapacity,advanced=false,onAction}:{account:WorkerAccount;disabled:boolean;pauseDisabled?:boolean;busy:boolean;pendingAction?:AccountAction;workerOnline:boolean;hasCapacity:boolean;advanced?:boolean;onAction:(action:AccountAction)=>void}) {
 const needsSignIn=!!a.attentionReason||!a.connectedAt||a.signedOut;
 const signingIn=a.online&&a.status==='awaiting_login';
 const openingSignIn=a.startupStage!=='FAILED'&&(a.loginPending||a.online&&a.status==='starting'&&!a.processingEnabled);
 const canStartProcessing=!disabled&&workerOnline&&hasCapacity&&a.enabled&&!!a.connectedAt&&!a.signedOut&&!a.attentionReason&&!openingSignIn&&!signingIn&&!a.logoutPending&&(!a.online||a.sessionReady||a.browserOpen===false);
 return <div className="space-y-2">
  <div className="flex flex-wrap gap-2">
   <button type="button" className={`btn ${needsSignIn&&!a.processingEnabled?'btn-primary':'btn-outline'} !text-xs`} disabled={disabled||!workerOnline||openingSignIn||a.logoutPending||signingIn||a.processingEnabled} onClick={()=>onAction('login')}>{openingSignIn||pendingAction==='login'?<><Loader2 className="w-3.5 h-3.5 animate-spin"/>Opening session…</>:signingIn?'Chrome open':<><ExternalLink className="w-3.5 h-3.5"/>{a.attentionReason?'Review on LinkedIn':needsSignIn?'Connect':'Open session'}</>}</button>
   {a.processingEnabled?<button type="button" className="btn btn-outline !text-xs" disabled={pauseDisabled||busy} onClick={()=>onAction('pause')}><Pause className="w-3.5 h-3.5"/>{pendingAction==='pause'?'Pausing…':'Pause'}</button>:<button type="button" className={`btn ${canStartProcessing?'btn-primary':'btn-outline'} !text-xs`} disabled={!canStartProcessing} onClick={()=>onAction('start')}>{pendingAction==='start'?<Loader2 className="w-3.5 h-3.5 animate-spin"/>:<Play className="w-3.5 h-3.5"/>}{pendingAction==='start'?'Starting…':'Start batch'}</button>}
   {advanced&&<button type="button" className="btn btn-ghost !text-xs" disabled={disabled||a.signedOut||a.logoutPending} onClick={()=>onAction('logout')}>Sign out LinkedIn</button>}
  </div>
  {openingSignIn&&<p role="status" className="text-xs leading-relaxed text-[var(--text-dim)]">Opening Chrome on the worker computer…</p>}
  {signingIn&&<p role="status" className="text-xs leading-relaxed text-[var(--text-dim)]">Complete sign-in in Chrome on the worker computer, then start a batch here.</p>}
  {workerOnline&&!hasCapacity&&!a.processingEnabled&&<p className="text-xs text-[var(--text-dim)]">Set a processing slot in Manage accounts to start a batch.</p>}
  {workerOnline&&!a.enabled&&<p className="text-xs text-[var(--text-dim)]">Enable this account in Manage accounts to start a batch.</p>}
  {!needsSignIn&&!a.processingEnabled&&a.browserOpen===false&&<p className="text-xs leading-relaxed text-[var(--text-dim)]">Start batch reopens your saved Chrome session.</p>}
  <p className="text-xs text-[var(--text-faint)]">Processing continues until paused, the daily cap, or an account review.</p>
 </div>;
}
function AccountHistory({id,updatedAt}:{id:string;updatedAt:string|null}) {
 const [open,setOpen]=useState(false),[events,setEvents]=useState<WorkerAccountEvent[]|null>(null),[error,setError]=useState('');
 useEffect(()=>{
  if(!open)return;let active=true;setError('');
  fetch('/api/linkedin-accounts?events='+encodeURIComponent(id),{cache:'no-store'}).then(async response=>{if(!response.ok)throw new Error('Could not load account history.');return response.json();}).then(value=>{if(active)setEvents(value);}).catch(e=>{if(active)setError(e.message);});
  return()=>{active=false;};
 },[open,id,updatedAt]);
 return <details onToggle={event=>setOpen(event.currentTarget.open)} className="text-xs">
  <summary className="cursor-pointer py-2 text-[var(--text-dim)]">Account activity history</summary>
  {error?<p role="alert">{error}</p>:events===null?<p className="field-hint">Loading history…</p>:events.length===0?<p className="field-hint">No account events recorded yet.</p>:<ol className="space-y-3 py-2">{events.map(event=><li key={event.id}><p>{event.message}</p><time dateTime={event.createdAt} className="text-[var(--text-dim)]">{new Date(event.createdAt).toLocaleString()}</time></li>)}</ol>}
 </details>;
}
