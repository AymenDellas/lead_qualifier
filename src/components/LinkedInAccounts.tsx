'use client';
import { useEffect, useRef, useState } from 'react';
import { Loader2, Plus, Settings2, Users, X } from 'lucide-react';
import type { WorkerAccount, WorkerSettings } from '@/lib/linkedin-workers.cjs';
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
 if (a.online) return a.status==='processing'?'Processing':a.status==='paused'?'Daily limit reached':a.status==='starting'?'Starting':'Ready';
 return a.status==='paused'?'Needs attention':'Offline';
}
function SessionIdentity({account,accounts}:{account:WorkerAccount;accounts:WorkerAccount[]}) {
 if(account.signedOut)return <p className="field-hint">LinkedIn signed out. Sign in on the worker computer to reconnect.</p>;
 const identity=account.signedIn;
 if(!identity)return <p className="field-hint">Signed-in LinkedIn profile not confirmed yet.</p>;
 const duplicates=accounts.filter(other=>other.id!==account.id&&other.signedIn&&(
  !!identity.profileUrl&&other.signedIn.profileUrl===identity.profileUrl||!!identity.memberUrn&&other.signedIn.memberUrn===identity.memberUrn));
 return <div className="space-y-1 text-xs">
  <p className="text-[var(--text-dim)]">{account.online?'Signed in as':'Last signed in as'}: {identity.profileUrl?<a href={identity.profileUrl} target="_blank" rel="noopener noreferrer" className="text-[var(--text)] underline underline-offset-2">{identity.name} ↗</a>:<span className="text-[var(--text)]">{identity.name}</span>}</p>
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
     <p className="text-sm text-[var(--text-dim)]"><span className="num text-[var(--text)]">{config.activeCount}</span> selected to run · <span className="num">{config.accounts.length}</span> saved</p>
     {config.accounts.length===0?<p className="field-hint">Add your LinkedIn accounts to start qualification.</p>:config.accounts.map(a=><div key={a.id} className="space-y-1"><div className="flex justify-between gap-3 text-xs">
      <span className="truncate" title={a.email}>{a.label}</span><span className="text-[var(--text-dim)] shrink-0">{a.enabled||a.signedOut||a.logoutPending?statusLabel(a):'Disabled'} · <span className="num">{a.dailyCount}/{a.dailyLimit}</span></span>
     </div><SessionIdentity account={a} accounts={config.accounts}/></div>)}
     <button className="btn btn-outline w-full justify-center" onClick={()=>setEditing(true)}>Manage accounts</button>
    </>}
   </div>
   <p className="panel-note">{config&&!config.supervisorOnline?'Worker supervisor is offline. Start Start_Compel_Lead_Qualifier.bat on the worker computer; sign-in requests wait until it is running.':'Each account has its own browser session. Only leads with an attributable email enter Qualified.'}</p>
  </section>
  {editing&&config&&<AccountEditor initial={config} liveAccounts={config.accounts} onClose={()=>setEditing(false)} onSaved={value=>{setConfig(value);setEditing(false);}}/>}
 </>;
}
function AccountEditor({initial,liveAccounts,onClose,onSaved}:{initial:WorkerSettings;liveAccounts:WorkerAccount[];onClose:()=>void;onSaved:(value:WorkerSettings)=>void}) {
 const dialog=useRef<HTMLDialogElement>(null);
 const [accounts,setAccounts]=useState<Draft[]>(initial.accounts.map(a=>({...a,password:''}))),[activeCount,setActiveCount]=useState(initial.activeCount);
 const [saving,setSaving]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 useEffect(()=>{dialog.current?.showModal();},[]);
 const enabled=accounts.filter(a=>a.enabled).length;
 const update=(index:number,patch:Partial<Draft>)=>setAccounts(current=>current.map((a,i)=>i===index?{...a,...patch}:a));
 async function save(event:React.FormEvent) {
  event.preventDefault();setSaving(true);setError('');
  try{
   const response=await fetch('/api/linkedin-accounts',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:initial.revision,activeCount,accounts})});
   const value=await response.json();if(!response.ok)throw new Error(value.error||'Could not save accounts.');
   onSaved(value);
  }catch(e){setError(e instanceof Error?e.message:'Could not save accounts.');}finally{setSaving(false);}
 }
 async function signIn(id:string) {
  setError('');setNotice('');
  try{
   const response=await fetch('/api/linkedin-accounts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})});
   const value=await response.json();if(!response.ok)throw new Error(value.error);
   setNotice(initial.supervisorOnline?'Sign-in requested. A visible browser opens on the worker computer within 10 seconds. Enter your LinkedIn login there.':'Sign-in queued, but the worker supervisor is offline. Start Start_Compel_Lead_Qualifier.bat on the worker computer to open the login browser.');
  }catch(e){setError(e instanceof Error?e.message:'Could not request sign-in.');}
 }
 async function signOut(id:string) {
  setSaving(true);setError('');setNotice('');
  try {
   const response=await fetch('/api/linkedin-accounts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,action:'logout'})});
   const value=await response.json();if(!response.ok)throw new Error(value.error||'Could not request sign-out.');
   onSaved(value);
  }catch(e){setError(e instanceof Error?e.message:'Could not request sign-out.');}finally{setSaving(false);}
 }
 return <dialog ref={dialog} onCancel={onClose} onClose={onClose} className="m-auto p-0 overflow-hidden w-[min(720px,calc(100vw-24px))] max-h-[90dvh] rounded-lg border border-[var(--line)] bg-[var(--surface-1)] text-[var(--text)] backdrop:bg-black/70">
  <form onSubmit={save} className="flex flex-col max-h-[90dvh]">
   <div className="panel-head shrink-0 !px-5 !py-4"><Users className="w-4 h-4"/> LinkedIn accounts<button type="button" className="btn btn-ghost ml-auto !p-1.5" aria-label="Close account settings" onClick={onClose} disabled={saving}><X className="w-4 h-4"/></button></div>
   <div className="p-5 min-h-0 overflow-y-auto space-y-5">
    <div className="flex flex-wrap items-center gap-3">
     <label htmlFor="active-accounts" className="field-label">Accounts running at once</label>
     <select id="active-accounts" className="field !w-auto min-w-20" value={Math.min(activeCount,enabled)} onChange={e=>setActiveCount(Number(e.target.value))} disabled={saving}>
      {Array.from({length:enabled+1},(_,n)=><option key={n} value={n}>{n===0?'0 — Pause all':n}</option>)}
     </select>
    </div>
    <p className="field-hint">Runs the first {Math.min(activeCount,enabled)} enabled accounts below. Changes are picked up every 10 seconds; running leads finish saving first.</p>
    <div className="space-y-5">
     {accounts.map((a,index)=><fieldset key={a.id||`new-${index}`} className="border-t border-[var(--line)] pt-4 space-y-3" disabled={saving}>
      <legend className="sr-only">LinkedIn account {index+1}</legend>
      <div className="flex items-center justify-between gap-3">
       <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={a.enabled} onChange={e=>{update(index,{enabled:e.target.checked});if(!e.target.checked)setActiveCount(n=>Math.min(n,enabled-1));}} className="accent-[var(--signal)]"/> Account {index+1}</label>
       <div className="flex items-center gap-2"><span className="text-xs text-[var(--text-dim)]">{a.id?statusLabel(liveAccounts.find(other=>other.id===a.id)||a as WorkerAccount):'New account'}</span><button type="button" className="btn btn-ghost !text-[var(--bad)] !text-xs" onClick={()=>{setAccounts(current=>current.filter((_,i)=>i!==index));setActiveCount(n=>Math.min(n,enabled-(a.enabled?1:0)));}}>Remove</button></div>
      </div>
      {a.id&&<SessionIdentity account={liveAccounts.find(other=>other.id===a.id)||a as WorkerAccount} accounts={liveAccounts}/>}
      <div className="grid sm:grid-cols-2 gap-3">
       <label className="space-y-1"><span className="field-label">Account name</span><input className="field w-full" required maxLength={80} value={a.label} onChange={e=>update(index,{label:e.target.value})} placeholder="e.g. Main account"/></label>
       <label className="space-y-1"><span className="field-label">LinkedIn email</span><input className="field w-full" type="email" required readOnly={!!a.id} value={a.email} onChange={e=>update(index,{email:e.target.value})} autoComplete="off" placeholder="you@example.com"/></label>
       <label className="space-y-1"><span className="field-label">Password</span><input className="field w-full" type="password" required={!a.id} maxLength={256} value={a.password||''} onChange={e=>update(index,{password:e.target.value})} autoComplete="new-password" placeholder={a.id?'Leave blank to keep saved password':'LinkedIn password'}/></label>
       <label className="space-y-1"><span className="field-label">Profiles per day</span><input className="field w-full" type="number" required min={1} max={400} value={a.dailyLimit} onChange={e=>update(index,{dailyLimit:Number(e.target.value)})}/></label>
      </div>
      {(liveAccounts.find(other=>other.id===a.id)?.reason||a.reason)&&<p className="field-hint break-words">{liveAccounts.find(other=>other.id===a.id)?.reason||a.reason}</p>}
      {a.id&&<div className="flex flex-wrap gap-2">
       <button type="button" className="btn btn-outline !text-xs" disabled={liveAccounts.find(other=>other.id===a.id)?.logoutPending} onClick={()=>signIn(a.id!)}>Sign in on worker computer</button>
       <button type="button" className="btn btn-outline !text-xs" aria-label={`Sign out LinkedIn account ${a.email}`} disabled={liveAccounts.find(other=>other.id===a.id)?.signedOut||liveAccounts.find(other=>other.id===a.id)?.logoutPending&&liveAccounts.find(other=>other.id===a.id)?.status!=='paused'} onClick={()=>signOut(a.id!)}>Sign out LinkedIn</button>
      </div>}
     </fieldset>)}
    </div>
    <button type="button" className="btn btn-outline" disabled={saving||accounts.length>=10} onClick={()=>{setAccounts(current=>[...current,{label:`Account ${current.length+1}`,email:'',password:'',enabled:true,dailyLimit:400,hasPassword:false,dailyCount:0,status:'offline',reason:'',online:false,loginPending:false,updatedAt:null}]);if(!accounts.length)setActiveCount(1);}}><Plus className="w-3.5 h-3.5"/> Add account</button>
    <p className="field-hint">Passwords are encrypted and never shown again. Sign out clears that worker's LinkedIn session and disables it until you reconnect. Security checks open on the worker computer. Daily counters reset at midnight UTC. The worker computer or server must stay running.</p>
    {notice&&<p role="status" className="text-sm text-[var(--signal)]">{notice}</p>}
    {error&&<p role="alert" className="text-sm text-[var(--bad)]">{error}</p>}
   </div>
   <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-[var(--line)] shrink-0"><button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>Cancel</button><button className="btn btn-primary" disabled={saving}>{saving&&<Loader2 className="w-3.5 h-3.5 animate-spin"/>} Save accounts</button></div>
  </form>
 </dialog>;
}
