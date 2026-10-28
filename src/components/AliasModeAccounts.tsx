'use client';
import {useCallback,useEffect,useState} from 'react';
import {ExternalLink,Loader2,Pause,Play,Power,RefreshCw,Settings2,Users} from 'lucide-react';
import type {WorkerAccount,WorkerSettings} from '@/lib/linkedin-workers.cjs';
import type {AliasModeSettings} from '@/lib/aliasmode-store.cjs';
import type {SupervisorStatus} from '@/lib/worker-supervisor-control.cjs';
import AccountSessionControls from './AccountSessionControls';

async function api<T>(url:string,body?:unknown,method='POST'):Promise<T>{
 const response=await fetch(url,body===undefined?{cache:'no-store'}:{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const value=await response.json();if(!response.ok)throw Error(value.error||'The local worker request failed.');return value;
}
const message=(error:unknown)=>error instanceof Error?error.message:'The request failed.';
function state(account:WorkerAccount){
 if(account.session?.diagnosticRequested==='warmup-experiment')return 'Authorized warmup experiment';
 if(account.attentionReason)return 'LinkedIn review required';
 if(account.closePending)return 'Closing profile';
 if(account.loginPending||account.status==='awaiting_login')return 'Verify in AliasMode';
 if(account.startupStage==='FAILED'||account.status==='provider_unavailable')return 'Connection needs attention';
 if(!account.aliasmodeProfileId)return 'Not linked';
 if(!account.enabled)return 'Disabled';
 if(account.status==='DAILY_LIMIT_REACHED')return 'Daily limit reached';
 if(account.session?.lifecycle.state==='PROVISION')return 'Session setup required';
 if(account.session?.lifecycle.state==='RECOVERY')return 'Recovery period';
 if(account.session?.lifecycle.state==='HOLD')return 'Browser identity review required';
 if(account.session?.lifecycle.state==='WARMUP')return `Warmup · ${account.session.lifecycle.done||0}/${account.session.lifecycle.required} days`;
 if(account.processingEnabled)return account.status==='processing'?'Processing':account.status==='sleeping'?'Waiting for next profile':'Processing requested';
 return account.connectedAt?'Paused':'Session not verified';
}
type ActionResult={provider:AliasModeSettings;accounts:WorkerSettings};
export default function AliasModeAccounts(){
 const [accounts,setAccounts]=useState<WorkerSettings|null>(null),[provider,setProvider]=useState<AliasModeSettings|null>(null),[agent,setAgent]=useState<SupervisorStatus|null>(null);
 const [error,setError]=useState(''),[notice,setNotice]=useState(''),[pending,setPending]=useState(''),[manage,setManage]=useState(false);
 const load=useCallback(async()=>{const [a,p,s]=await Promise.all([api<WorkerSettings>('/api/linkedin-accounts'),api<AliasModeSettings>('/api/aliasmode'),api<SupervisorStatus>('/api/worker-supervisor')]);setAccounts(a);setProvider(p);setAgent(s);},[]);
 useEffect(()=>{let current=true;const refresh=()=>{if(current)void load().catch(e=>{if(current)setError(message(e));});};refresh();const timer=setInterval(refresh,5000);return()=>{current=false;clearInterval(timer);};},[load]);
 async function run(key:string,task:()=>Promise<unknown>,success:string){setPending(key);setError('');setNotice('');try{await task();await load();setNotice(success);return true;}catch(e){setError(message(e));return false;}finally{setPending('');}}
 const change=async(body:unknown)=>{const result=await api<ActionResult>('/api/aliasmode',body);setAccounts(result.accounts);setProvider(result.provider);};
 const online=agent?.state==='online',connected=provider?.status.state==='connected',linked=accounts?.accounts.filter(a=>a.aliasmodeProfileId)||[],unlinked=accounts?.accounts.filter(a=>!a.aliasmodeProfileId)||[];
 return <section className="panel" aria-label="AliasMode LinkedIn profiles">
  <div className="panel-head"><Users className="w-3.5 h-3.5"/> LinkedIn profiles <button type="button" className="btn btn-ghost !p-1.5 ml-auto" aria-label="Manage AliasMode profiles" onClick={()=>setManage(!manage)}><Settings2 className="w-4 h-4"/></button></div>
  <div className="panel-body space-y-4">
   <div className="flex flex-wrap items-center gap-3 text-xs">
    <span role="status">Agent {online?'online':agent?.state==='starting'?'starting':'offline'}</span>
    <span className="text-[var(--text-dim)]">AliasMode {connected?'connected':provider?.status.state==='unavailable'?'unavailable':'not checked'}</span>
    {!online&&<button className="btn btn-outline !text-xs" type="button" disabled={!!pending||agent?.state==='starting'||!agent?.canStart} onClick={()=>void run('agent',async()=>{setAgent(await api('/api/worker-supervisor',{action:'start'}));},'Agent start requested.')}><Power className="w-3.5 h-3.5"/>Start agent</button>}
   </div>
   {provider?.status.reason&&!connected&&<p role="status" className="text-xs text-[var(--text-dim)]">{provider.status.reason}</p>}
   {error&&<p role="alert" className="text-xs text-[var(--bad)] break-words">{error}</p>}
   {notice&&<p role="status" className="text-xs text-[var(--signal)]">{notice}</p>}
   {!accounts||!provider?<p className="text-sm text-[var(--text-dim)]">Loading profile settings…</p>:<>
    {(manage||!linked.length)&&<ConnectionForm provider={provider} disabled={!!pending} onSave={body=>run('connection',async()=>{setProvider(await api('/api/aliasmode',body,'PUT'));},'Connection saved. Start the agent or refresh profiles to check access.')}/>}
    {manage&&<div className="flex flex-wrap gap-2"><button type="button" className="btn btn-outline !text-xs" disabled={!!pending||!online} onClick={()=>void run('refresh',()=>change({action:'refresh'}),'Profile refresh requested. The agent will update the list.')}><RefreshCw className="w-3.5 h-3.5"/>Refresh profiles</button><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={accounts.activeCount>0} disabled={!!pending} onChange={e=>void run('allow',()=>change({action:'allow',enabled:e.target.checked}),'Processing availability updated.')}/>Allow account processing</label></div>}
    {!linked.length&&<p className="text-sm text-[var(--text-dim)]">Link your AliasMode profiles, verify the signed-in members, then start processing.</p>}
    <div className="divide-y divide-[var(--line)]">{linked.map(a=><div key={a.id} className="space-y-2 py-4 first:pt-0" role="group" aria-label={a.label}>
     <div className="flex flex-wrap justify-between gap-2 text-xs"><strong className="font-medium break-words">{a.label}</strong><span className="text-[var(--text-dim)]">{state(a)}</span></div>
     <p className="text-xs text-[var(--text-faint)] break-all">AliasMode {a.aliasmodeProfileId}{a.aliasmodeProfileName&&a.aliasmodeProfileName!==a.label?` · ${a.aliasmodeProfileName}`:''} · {a.browserOpen?'Automation attached':'Automation detached'}{a.browserOpen&&a.browserMode?` · ${a.browserMode==='headless'?'Headless':a.browserMode==='visible'?'Visible session':'Mode unconfirmed'}`:''}</p>
     <p className="text-xs text-[var(--text-dim)]">{a.signedIn?.profileUrl?<><span>Last verified: </span><a href={a.signedIn.profileUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">{a.signedIn.name}</a></>:<>Expected member: {a.expectedMemberName||'Verify in AliasMode'}</>}</p>
     {[...new Set([a.attentionReason,a.startupReason,a.reason].filter(Boolean))].map(reason=><p key={reason} className={`text-xs break-words ${a.attentionReason?'text-[var(--bad)]':'text-[var(--text-dim)]'}`}>{reason}</p>)}
     {a.startupStage&&<p className="text-xs text-[var(--text-faint)]">{a.startupStage}{a.failedStage?` · ${a.failedStage}`:''}</p>}
     <div className="flex flex-wrap gap-2">
      <button type="button" className="btn btn-outline !text-xs" disabled={!!pending||!online||a.closePending||a.processingEnabled} onClick={()=>void run(a.id,()=>api('/api/linkedin-accounts',{id:a.id,action:'login'}),'Review requested. Confirm the expected member in AliasMode; processing stays paused.')}><ExternalLink className="w-3.5 h-3.5"/>{a.attentionReason?'Open for review':'Verify session'}</button>
      {(a.processingEnabled||a.session?.diagnosticRequested==='warmup-experiment')?<button type="button" className="btn btn-outline !text-xs" onClick={()=>void run(a.id,()=>api('/api/linkedin-accounts',{id:a.id,action:'pause'}),'Processing paused; checkpoints retained.')}><Pause className="w-3.5 h-3.5"/>{a.session?.diagnosticRequested==='warmup-experiment'?'Stop test':'Pause'}</button>:<button type="button" className="btn btn-primary !text-xs" disabled={!!pending||!online||!connected||accounts.activeCount===0||!a.enabled||!a.connectedAt||!!a.attentionReason||a.closePending||a.loginPending||(!!a.session&&['PROVISION','HOLD','RECOVERY'].includes(a.session.lifecycle.state))||a.status==='awaiting_login'} onClick={()=>void run(a.id,()=>api('/api/linkedin-accounts',{id:a.id,action:'start'}),'Processing requested for this profile.')}><Play className="w-3.5 h-3.5"/>{a.session?.lifecycle.state==='WARMUP'?'Start warmup':'Start batch'}</button>}
      <button type="button" className="btn btn-ghost !text-xs" disabled={!!pending||!online||a.closePending} onClick={()=>void run(a.id,()=>change({action:'close',accountId:a.id}),'Profile closure requested. Your LinkedIn sign-in is preserved.')}>Close profile</button>
     </div>
     <p className="text-xs text-[var(--text-faint)]"><span className="num">{a.dailyCount}/{a.dailyLimit}</span> unique profiles today{a.nextEligibleAt?` · Next eligible ${new Date(a.nextEligibleAt).toLocaleTimeString()}`:''}</p>
     <AccountSessionControls key={`${a.id}-session-${a.session?.revision}-${a.session?.gate?.reportId||''}`} account={a} disabled={!!pending} online={!!online&&!!connected} onAction={body=>run(a.id,()=>change(body),'Session request saved. Review its evidence and status before processing.')}/>
     {manage&&<AccountForm key={`${a.id}-${a.enabled}-${a.dailyLimit}-${a.label}`} account={a} profiles={provider.profiles} disabled={!!pending} onUpdate={body=>run(a.id,()=>change(body),'Account settings saved.')} onBind={body=>run(a.id,()=>change(body),'Profile binding saved. Verify the member before processing.')}/>}
    </div>)}</div>
    {(manage||!linked.length)&&<ImportForm profiles={provider.profiles.filter(p=>!linked.some(a=>a.aliasmodeProfileId===p.id))} disabled={!!pending||!connected} defaultLimit={accounts.defaultDailyLimit||300} onSave={body=>run('import',()=>change(body),'Profile linked. Verify the signed-in member before starting.')}/>}
    {unlinked.length>0&&<details><summary className="cursor-pointer text-xs text-[var(--text-dim)]">Saved accounts without an AliasMode binding ({unlinked.length})</summary><p className="field-hint mt-2">History and review holds are retained. These accounts cannot launch local Chrome or process until linked.</p>{unlinked.map(a=><div key={a.id} className="space-y-2 border-t border-[var(--line)] py-3 mt-2"><p className="text-xs">{a.label} · {a.signedIn?.name||'Member not verified'}</p>{a.attentionReason&&<p className="text-xs text-[var(--bad)]">{a.attentionReason}</p>}<AccountForm account={a} profiles={provider.profiles} disabled={!!pending} onUpdate={body=>run(a.id,()=>change(body),'Account settings saved.')} onBind={body=>run(a.id,()=>change(body),'Profile linked. Existing identity and review hold are retained.')}/></div>)}</details>}
   </>}
   {pending&&<p role="status" className="flex items-center gap-2 text-xs text-[var(--text-faint)]"><Loader2 className="h-3.5 w-3.5 animate-spin"/>Saving request…</p>}
  </div>
  <p className="panel-note">Visible processing by default · Each account keeps its own profile, verified session prerequisites and daily ceiling. Warmup uses rendered visits; later profile starts are spaced 60–150 seconds apart. Start authorizes processing.</p>
 </section>;
}
function ConnectionForm({provider,disabled,onSave}:{provider:AliasModeSettings;disabled:boolean;onSave:(body:unknown)=>Promise<boolean>}){
 const [address,setAddress]=useState(provider.baseUrl);
 return <form className="space-y-3 border-y border-[var(--line)] py-4" onSubmit={e=>{e.preventDefault();void onSave({baseUrl:address,revision:provider.revision});}}>
  <p className="text-xs font-medium">AliasMode connection</p><label className="block space-y-1"><span className="field-label">Local API address</span><input className="field w-full" type="url" required value={address} onChange={e=>setAddress(e.target.value)} disabled={disabled}/></label>
  <p className="field-hint">Keep AliasMode open. Its supported launcher confirms the account’s configured mode. Visible processing is the default; manual sign-in stays visible. No API key is needed.</p><button className="btn btn-outline !text-xs" disabled={disabled}>Save connection</button>
 </form>;
}
type FormProps={profiles:AliasModeSettings['profiles'];disabled:boolean};
function ImportForm({profiles,disabled,defaultLimit,onSave}:FormProps&{defaultLimit:number;onSave:(body:unknown)=>Promise<boolean>}){
 const [id,setId]=useState(''),[member,setMember]=useState('');
 return <form className="space-y-3 border-t border-[var(--line)] pt-4" onSubmit={e=>{e.preventDefault();void onSave({action:'import',profileId:id,name:member.trim(),expectedMemberName:member.trim(),dailyLimit:defaultLimit}).then(ok=>{if(ok){setId('');setMember('');}});}}>
  <p className="text-xs font-medium">Link an AliasMode profile</p><label className="block space-y-1"><span className="field-label">AliasMode profile</span><select className="field w-full" required value={id} onChange={e=>setId(e.target.value)} disabled={disabled}><option value="">Choose a profile</option>{profiles.map(p=><option key={p.id} value={p.id}>{p.number?`#${p.number} · `:''}{p.name} · {p.id}</option>)}</select></label>
  <label className="block space-y-1"><span className="field-label">Expected LinkedIn member name</span><input className="field w-full" required maxLength={80} value={member} onChange={e=>setMember(e.target.value)} disabled={disabled} placeholder="Name shown on the signed-in LinkedIn account"/></label>
  <button className="btn btn-outline !text-xs" disabled={disabled||!id}>Link profile</button><p className="field-hint">Creates a paused processing account. Browser credentials and cookies stay in AliasMode.</p>
 </form>;
}
function AccountForm({account:a,profiles,disabled,onUpdate,onBind}:FormProps&{account:WorkerAccount;onUpdate:(body:unknown)=>Promise<unknown>;onBind:(body:unknown)=>Promise<unknown>}){
 const [label,setLabel]=useState(a.label),[limit,setLimit]=useState(a.dailyLimit),[enabled,setEnabled]=useState(a.enabled),[expected,setExpected]=useState(a.expectedMemberName||a.signedIn?.name||''),[binding,setBinding]=useState(a.aliasmodeProfileId||'');
 return <div className="space-y-3">
  <form className="space-y-2" onSubmit={e=>{e.preventDefault();void onUpdate({action:'update',accountId:a.id,label,dailyLimit:limit,enabled,...(!a.connectedAt&&expected?{expectedMemberName:expected}:{})});}}><div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1"><span className="field-label">Label</span><input className="field w-full" required value={label} maxLength={80} onChange={e=>setLabel(e.target.value)} disabled={disabled}/></label><label className="space-y-1"><span className="field-label">Profiles per day</span><input className="field w-full" required type="number" min={1} max={400} value={limit} onChange={e=>setLimit(Number(e.target.value))} disabled={disabled}/></label></div>
   {!a.connectedAt&&<label className="block space-y-1"><span className="field-label">Expected member name</span><input className="field w-full" value={expected} onChange={e=>setExpected(e.target.value)} disabled={disabled}/></label>}<label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)} disabled={disabled}/>Enabled for processing</label><button className="btn btn-ghost !text-xs" disabled={disabled}>Save account</button></form>
  <form className="flex flex-wrap gap-2" onSubmit={e=>{e.preventDefault();void onBind({action:'bind',accountId:a.id,profileId:binding||null,name:profiles.find(p=>p.id===binding)?.name||'',bindingRevision:a.bindingRevision||0});}}><label className="sr-only" htmlFor={`binding-${a.id}`}>AliasMode binding for {a.label}</label><select id={`binding-${a.id}`} className="field min-w-0 flex-1" value={binding} onChange={e=>setBinding(e.target.value)} disabled={disabled||a.processingEnabled||a.online}><option value="">No profile linked</option>{a.aliasmodeProfileId&&!profiles.some(p=>p.id===a.aliasmodeProfileId)&&<option value={a.aliasmodeProfileId}>{a.aliasmodeProfileId}</option>}{profiles.map(p=><option key={p.id} value={p.id}>{p.number?`#${p.number} · `:''}{p.name} · {p.id}</option>)}</select><button className="btn btn-ghost !text-xs" disabled={disabled||a.processingEnabled||a.online||binding===(a.aliasmodeProfileId||'')}>Save binding</button></form>
  {a.online&&<p className="field-hint">Close the profile before changing its binding.</p>}
 </div>;
}
