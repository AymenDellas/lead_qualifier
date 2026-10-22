'use client';
import { useEffect, useRef, useState } from 'react';
import { Loader2, Plus, Settings2, Users, X } from 'lucide-react';
import type { WorkerAccount, WorkerSettings, WorkerAccountEvent, ActivityLimits, WorkingHours } from '@/lib/linkedin-workers.cjs';
type Draft = Omit<WorkerAccount, 'id'> & {id?:string;password?:string};
async function readSettings(): Promise<WorkerSettings> {
 const response = await fetch('/api/linkedin-accounts',{cache:'no-store'});
 if (!response.ok) throw new Error('Could not load LinkedIn accounts.');
 return response.json();
}
function statusLabel(a:WorkerAccount) {
 if(a.logoutPending)return a.status==='paused'?'Sign-out needs attention':'Signing out';
 if(a.signedOut)return 'Signed out';
 if(a.online&&a.status==='awaiting_login')return 'Waiting for login';
 if(a.loginPending)return 'Sign-in requested';
 if(a.attentionReason)return 'Needs review';
 if(!a.processingEnabled)return a.connectedAt?'Connected · Idle':'Sign-in needed';
 if (a.online) return a.status==='processing'?'Processing':a.status==='sleeping'?'Resting':a.status==='paused'?/^Daily limit/.test(a.reason)?'Daily limit reached':'Needs attention':a.status==='starting'?'Starting':'Ready';
 return a.status==='paused'?'Needs attention':'Offline';
}
function SessionIdentity({account,accounts}:{account:WorkerAccount;accounts:WorkerAccount[]}) {
 if(account.signedOut)return <p className="field-hint">LinkedIn signed out. Sign in on the worker computer to reconnect.</p>;
 const identity=account.signedIn;
 if(!identity)return <p className="field-hint">Signed-in LinkedIn profile not confirmed yet.</p>;
 const duplicates=accounts.filter(other=>other.id!==account.id&&other.signedIn&&(
  !!identity.profileUrl&&other.signedIn.profileUrl===identity.profileUrl||!!identity.memberUrn&&other.signedIn.memberUrn===identity.memberUrn));
 return <div className="space-y-1 text-xs">
  <p className="text-[var(--text-dim)]">{account.online&&account.processingEnabled&&['ready','processing'].includes(account.status)?'Signed in as':'Last confirmed LinkedIn member'}: {identity.profileUrl?<a href={identity.profileUrl} target="_blank" rel="noopener noreferrer" className="text-[var(--text)] underline underline-offset-2">{identity.name} ↗</a>:<span className="text-[var(--text)]">{identity.name}</span>}</p>
  {identity.profileUrl&&<p className="text-[var(--text-dim)] break-all">{new URL(identity.profileUrl).pathname}</p>}
  {duplicates.length>0&&<p className="text-[var(--bad)]">Same LinkedIn profile as {duplicates.map(other=>other.label).join(', ')}.</p>}
 </div>;
}
export default function LinkedInAccounts() {
 const [config,setConfig]=useState<WorkerSettings|null>(null),[error,setError]=useState(''),[editing,setEditing]=useState(false);
 useEffect(()=>{
  let active=true;
  const refresh=()=>readSettings().then(value=>{if(active){setConfig(value);setError('');}}).catch(e=>{if(active)setError(e.message);});
  refresh();const timer=setInterval(refresh,10000);
  return()=>{active=false;clearInterval(timer);};
 },[]);
 return <>
  <section className="panel">
   <div className="panel-head"><Users className="w-3.5 h-3.5"/> LinkedIn accounts
    <button className="btn btn-ghost !p-1.5 ml-auto" aria-label="Manage LinkedIn accounts" onClick={()=>setEditing(true)} disabled={!config}><Settings2 className="w-4 h-4"/></button>
   </div>
   <div className="panel-body space-y-3">
    {error?<p role="alert" className="text-sm text-[var(--bad)]">{error}</p>:!config?<p className="text-sm text-[var(--text-dim)]">Loading accounts…</p>:<>
     <p className="text-sm text-[var(--text-dim)]"><span className="num text-[var(--text)]">{config.activeCount}</span> processing slots · <span className="num">{config.accounts.length}</span> saved</p>
     {config.accounts.length===0?<p className="field-hint">Add your LinkedIn accounts to start qualification.</p>:config.accounts.map(a=><div key={a.id} className="space-y-1"><div className="flex justify-between gap-3 text-xs">
      <span className="truncate" title={a.email}>{a.label}</span><span className="text-[var(--text-dim)] shrink-0">{a.enabled||a.signedOut||a.logoutPending?statusLabel(a):'Disabled'} · <span className="num">{a.dailyCount}/{a.dailyLimit}</span></span>
     </div><p className="field-hint flex flex-wrap gap-x-3 gap-y-1"><span><span className="num">{(a.dailyRequests||0).toLocaleString()}</span> page interactions today</span><span><span className="num">{(a.dailyCachedProfiles||0).toLocaleString()}</span> saved profiles reused</span></p><SessionIdentity account={a} accounts={config.accounts}/></div>)}
     <button className="btn btn-outline w-full justify-center" onClick={()=>setEditing(true)}>Manage accounts</button>
    </>}
   </div>
   <p className="panel-note">{config&&!config.supervisorOnline?'Worker supervisor is offline. Start Start_Compel_Lead_Qualifier.bat on the worker computer; sign-in requests wait until it is running.':'Each account has its own browser session. Only leads with an attributable email enter Qualified.'}</p>
  </section>
  {editing&&config&&<AccountEditor initial={config} liveAccounts={config.accounts} onClose={()=>setEditing(false)} onUpdated={setConfig} onSaved={value=>{setConfig(value);setEditing(false);}}/>}
 </>;
}
function AccountEditor({initial,liveAccounts,onClose,onSaved,onUpdated}:{initial:WorkerSettings;liveAccounts:WorkerAccount[];onClose:()=>void;onSaved:(value:WorkerSettings)=>void;onUpdated:(value:WorkerSettings)=>void}) {
 const dialog=useRef<HTMLDialogElement>(null);
 const [accounts,setAccounts]=useState<Draft[]>(initial.accounts.map(a=>({...a}))),[activeCount,setActiveCount]=useState(initial.activeCount);
 const [revision,setRevision]=useState(initial.revision);
 const [saving,setSaving]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 useEffect(()=>{dialog.current?.showModal();},[]);
 const enabled=accounts.filter(a=>a.enabled).length;
 const update=(index:number,patch:Partial<Draft>)=>setAccounts(current=>current.map((a,i)=>i===index?{...a,...patch}:a));
 async function save(event:React.FormEvent) {
  event.preventDefault();setSaving(true);setError('');
  try{
   const response=await fetch('/api/linkedin-accounts',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision,activeCount,accounts})});
   const value=await response.json();if(!response.ok)throw new Error(value.error||'Could not save accounts.');
   onSaved(value);
  }catch(e){setError(e instanceof Error?e.message:'Could not save accounts.');}finally{setSaving(false);}
 }
 const savedFields=(values:Draft[])=>values.map(a=>[a.id,a.label,a.email,a.enabled,a.dailyLimit,a.dailyRequestLimit??100,a.requestIntervalSeconds??15,a.activityLimits,a.workingHours]);
 const dirty=JSON.stringify(savedFields(accounts))!==JSON.stringify(savedFields(initial.accounts))||activeCount!==initial.activeCount;
 async function accountAction(id:string,action:'login'|'logout'|'start'|'pause') {
  setSaving(true);setError('');setNotice('');
  try{
   const response=await fetch('/api/linkedin-accounts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,action,minutes:60})});
   const value=await response.json();if(!response.ok)throw new Error(value.error||'Could not update account.');
   setRevision(value.revision);
   setAccounts(current=>action==='pause'?current.map(a=>({...value.accounts.find((server:WorkerAccount)=>server.id===a.id),...a,...(a.id===id?{processingEnabled:false,processingUntil:null}:{})})):value.accounts);
   setActiveCount(value.activeCount);onUpdated(value);
   setNotice(action==='login'?'Manual sign-in requested. Enter your credentials only in the worker browser. Signing in leaves processing paused.':action==='start'?'Processing authorized for one hour. Checks stop at your budgets or the first account warning.':action==='pause'?'Processing paused. Pending work is retained.':'Sign-out requested.');
  }catch(e){setError(e instanceof Error?e.message:'Could not update account.');}finally{setSaving(false);}
 }
 return <dialog ref={dialog} onCancel={onClose} onClose={onClose} className="m-auto p-0 overflow-hidden w-[min(720px,calc(100vw-24px))] max-h-[90dvh] rounded-lg border border-[var(--line)] bg-[var(--surface-1)] text-[var(--text)] backdrop:bg-black/70">
  <form onSubmit={save} className="flex flex-col max-h-[90dvh]">
   <div className="panel-head shrink-0 !px-5 !py-4"><Users className="w-4 h-4"/> LinkedIn accounts<button type="button" className="btn btn-ghost ml-auto !p-1.5" aria-label="Close account settings" onClick={onClose} disabled={saving}><X className="w-4 h-4"/></button></div>
   <div className="p-5 min-h-0 overflow-y-auto space-y-5">
    <div className="flex flex-wrap items-center gap-3">
     <label htmlFor="active-accounts" className="field-label">Maximum accounts processing at once</label>
     <select id="active-accounts" className="field !w-auto min-w-20" value={Math.min(activeCount,enabled)} onChange={e=>setActiveCount(Number(e.target.value))} disabled={saving}>
      {Array.from({length:enabled+1},(_,n)=><option key={n} value={n}>{n===0?'0 — Pause all':n}</option>)}
     </select>
    </div>
    <p className="field-hint">Saving accounts never starts them. Sign in first, then explicitly start a one-hour processing session. Pausing retains pending work.</p>
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
       <label className="space-y-1"><span className="field-label">Page interactions per 24 hours</span><input className="field w-full" type="number" required min={10} max={2000} value={a.dailyRequestLimit??100} onChange={e=>update(index,{dailyRequestLimit:Number(e.target.value)})}/></label>
       <label className="space-y-1"><span className="field-label">Seconds between checks</span><input className="field w-full" type="number" required min={10} max={300} value={a.requestIntervalSeconds??15} onChange={e=>update(index,{requestIntervalSeconds:Number(e.target.value)})}/></label>
      </div>
      <ActivitySettings account={{...a,activityUsage:liveAccounts.find(other=>other.id===a.id)?.activityUsage||a.activityUsage}} onChange={patch=>update(index,patch)}/>
      {(liveAccounts.find(other=>other.id===a.id)?.reason||a.reason)&&<p className="field-hint break-words">{liveAccounts.find(other=>other.id===a.id)?.reason||a.reason}</p>}
      {a.id&&<AccountActions account={liveAccounts.find(other=>other.id===a.id)||a as WorkerAccount} disabled={saving||dirty} busy={saving} onAction={action=>accountAction(a.id!,action)}/>}
      {a.id&&<AccountHistory id={a.id} updatedAt={(liveAccounts.find(other=>other.id===a.id)||a).updatedAt}/>}
     </fieldset>)}
    </div>
    <button type="button" className="btn btn-outline" disabled={saving||accounts.length>=10} onClick={()=>{setAccounts(current=>[...current,{label:`Account ${current.length+1}`,email:'',enabled:true,dailyLimit:25,dailyRequestLimit:100,requestIntervalSeconds:15,hasPassword:false,dailyCount:0,status:'offline',reason:'',online:false,loginPending:false,updatedAt:null}]);if(!accounts.length)setActiveCount(1);}}><Plus className="w-3.5 h-3.5"/> Add account</button>
    <p className="field-hint">Credentials are entered only in the worker browser. These are application budgets, not LinkedIn-approved limits. A second cap allows at most 30 explicit checks per rolling hour. Sessions end after one hour; supervisor restarts leave accounts idle. The interaction budget uses the last 24 hours, shared across qualification and Prospecting. The “today” counters and distinct-profile allowance use midnight UTC.</p>
    {dirty&&<p className="field-hint">Save your account changes before signing in or starting processing.</p>}
    {notice&&<p role="status" className="text-sm text-[var(--signal)]">{notice}</p>}
    {error&&<p role="alert" className="text-sm text-[var(--bad)]">{error}</p>}
   </div>
   <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-[var(--line)] shrink-0"><button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>Cancel</button><button className="btn btn-primary" disabled={saving}>{saving&&<Loader2 className="w-3.5 h-3.5 animate-spin"/>} Save accounts</button></div>
  </form>
 </dialog>;
}

const defaultActivityLimits:ActivityLimits={profile:{hourly:15,daily:25},contact:{hourly:20,daily:50},activity:{hourly:15,daily:25},discovery:{hourly:15,daily:40},identity:{hourly:5,daily:10}};
function ActivitySettings({account:a,onChange}:{account:Draft;onChange:(patch:Partial<Draft>)=>void}) {
 const limits=a.activityLimits||defaultActivityLimits;
 const labels:Record<keyof ActivityLimits,string>={profile:'Profile pages',contact:'Contact panels',activity:'Activity pages',discovery:'Search and network lists',identity:'Account confirmation'};
 const hours=a.workingHours;
 const setHours=(patch:Partial<WorkingHours>)=>onChange({workingHours:{timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,days:[1,2,3,4,5],start:'09:00',end:'17:00',...hours,...patch}});
 return <details className="rounded-md border border-[var(--line)] p-3 text-xs">
  <summary className="cursor-pointer">Activity budgets & working hours</summary>
  <div className="space-y-4 pt-4">
   <p className="field-hint">All runs share these limits. Opening a panel, loading another search page, or scrolling for more results also uses an interaction. The total cap of 30 interactions per rolling hour still applies.</p>
   {a.activityUsage&&<p>{a.activityUsage.daily} / {a.dailyRequestLimit??100} interactions in the last 24 hours · {a.activityUsage.hourly} / 30 in the last hour</p>}
   <div className="grid grid-cols-[minmax(0,1fr)_76px_76px] gap-2 items-center">
    <span>Activity</span><span>Per hour</span><span>Per 24h</span>
    {(Object.keys(labels) as (keyof ActivityLimits)[]).map(key=><div key={key} className="contents"><span>{labels[key]}{a.activityUsage&&<span className="block text-[var(--text-dim)]">{a.activityUsage.actions[key].daily} used / 24h</span>}</span>{(['hourly','daily'] as const).map(window=><input key={window} aria-label={`${labels[key]} ${window==='hourly'?'per hour':'per 24 hours'}`} className="field w-full" type="number" min={1} max={window==='hourly'?30:2000} required value={limits[key][window]} onChange={e=>onChange({activityLimits:{...limits,[key]:{...limits[key],[window]:Number(e.target.value)}}})}/>)}</div>)}
   </div>
   <label className="flex items-center gap-2"><input type="checkbox" checked={!!hours} onChange={e=>e.target.checked?setHours({}):onChange({workingHours:null})}/> Restrict processing to working hours</label>
   {hours&&<div className="space-y-3">
    <label className="block space-y-1"><span>Time zone</span><input className="field w-full" aria-label="Working hours time zone" required value={hours.timezone} placeholder="Africa/Casablanca" onChange={e=>setHours({timezone:e.target.value})}/></label>
    <div className="flex flex-wrap gap-3">{['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((day,n)=><label key={day} className="flex items-center gap-1"><input type="checkbox" checked={hours.days.includes(n)} onChange={e=>setHours({days:e.target.checked?[...hours.days,n]:hours.days.filter(d=>d!==n)})}/>{day}</label>)}</div>
    <div className="grid grid-cols-2 gap-3"><label className="space-y-1"><span>From</span><input aria-label="Working hours start" type="time" className="field w-full" required value={hours.start} onChange={e=>setHours({start:e.target.value})}/></label><label className="space-y-1"><span>Until</span><input aria-label="Working hours end" type="time" className="field w-full" required value={hours.end} onChange={e=>setHours({end:e.target.value})}/></label></div>
    <p className="field-hint">Overnight hours finish the following day. A schedule limits an explicitly started session; it never starts a worker automatically.</p>
   </div>}
  </div>
 </details>;
}
function AccountActions({account:a,disabled,busy,onAction}:{account:WorkerAccount;disabled:boolean;busy:boolean;onAction:(action:'login'|'logout'|'start'|'pause')=>void}) {
 return <div className="space-y-2">
  {a.attentionReason&&<p role="status" className="text-sm text-[var(--bad)]">{a.attentionReason}</p>}
  <div className="flex flex-wrap gap-2">
   <button type="button" className="btn btn-outline !text-xs" disabled={disabled||a.loginPending||a.logoutPending||a.online&&a.status==='awaiting_login'} onClick={()=>onAction('login')}>Sign in on worker computer</button>
   {a.processingEnabled?<button type="button" className="btn btn-outline !text-xs" disabled={busy} onClick={()=>onAction('pause')}>Pause processing</button>:<button type="button" className="btn btn-primary !text-xs" disabled={disabled||!a.enabled||!a.connectedAt||!!a.attentionReason||a.loginPending||a.logoutPending||a.online} onClick={()=>onAction('start')}>Start processing · 1 hour</button>}
   <button type="button" className="btn btn-ghost !text-xs" disabled={disabled||a.signedOut||a.logoutPending} onClick={()=>onAction('logout')}>Sign out LinkedIn</button>
  </div>
  {a.processingEnabled&&a.processingUntil&&<p className="field-hint">Session ends {new Date(a.processingUntil).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}. Pending work stays saved.</p>}
  {a.processingEnabled&&<p className="field-hint">Pause processing before using this LinkedIn account in another browser or tool.</p>}
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
