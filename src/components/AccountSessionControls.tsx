'use client';
import {useState} from 'react';
import type {WorkerAccount} from '@/lib/linkedin-workers.cjs';
type Props={account:WorkerAccount;disabled:boolean;online:boolean;onAction:(body:unknown)=>Promise<unknown>};
export default function AccountSessionControls({account:a,disabled,online,onAction}:Props){
 const s=a.session;
 const [engine,setEngine]=useState(s?.engine||'aliasmode-chromium'),[mode,setMode]=useState(s?.launchMode||'headful');
 const [proxy,setProxy]=useState(s?.proxyId||''),[host,setHost]=useState(s?.proxyHost||''),[port,setPort]=useState(s?.proxyPort?.toString()||'');
 const [country,setCountry]=useState(s?.proxyCountry||''),[zone,setZone]=useState(s?.proxyTimezone||''),[ip,setIp]=useState(s?.expectedExitIp||'');
 const [policy,setPolicy]=useState(s?.policy||{});
 const [reviewed,setReviewed]=useState(false);
 if(!s)return null;
 const busy=disabled||a.processingEnabled||a.online||a.closePending,checkDisabled=disabled||!online||a.processingEnabled||!!a.attentionReason||a.closePending||a.loginPending||a.status==='awaiting_login'||!!s.diagnosticRequested;
 const settings=[['warmupDays','Warmup days'],['warmupProfilesPerDay','Warmup profiles/day'],['rampStepDays','Days per ramp step'],['recoveryDays','Recovery days'],['minIntervalSeconds','Minimum spacing (seconds)'],['maxIntervalSeconds','Maximum spacing (seconds)'],['staggerSeconds','Startup stagger (seconds)'],['renderEvery','Render every Nth profile']];
 return <details className="border-t border-[var(--line)] pt-3">
  <summary className="cursor-pointer text-xs">Session setup · {s.lifecycle.state}</summary>
  <div className="space-y-4 pt-3">
   <p className="text-xs text-[var(--text-dim)]" role="status">{s.lifecycle.reason}{s.lifecycle.resumeAt?` Available after ${new Date(s.lifecycle.resumeAt).toLocaleString()}.`:''}</p>
   <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
    <dt className="text-[var(--text-faint)]">Network</dt><dd>{String(s.network?.verdict||'Not checked')}</dd>
    <dt className="text-[var(--text-faint)]">Detector gate</dt><dd>{s.gate?.verdict||'Not checked'}</dd>
    <dt className="text-[var(--text-faint)]">Browser identity</dt><dd className="break-all">{s.drift?'Changed — review required':s.fingerprint?.hash||'Not captured'}</dd>
    {s.lifecycle.required&&<><dt className="text-[var(--text-faint)]">Warmup</dt><dd>{s.lifecycle.done||0}/{s.lifecycle.required} observed days</dd></>}
    {s.lifecycle.limit&&<><dt className="text-[var(--text-faint)]">Effective daily limit</dt><dd>{s.lifecycle.limit} / ceiling {a.dailyLimit}</dd></>}
   </dl>
   <div className="flex flex-wrap gap-2">
    <button type="button" className="btn btn-outline !text-xs" disabled={checkDisabled||!s.proxyId} onClick={()=>void onAction({action:'session-check',accountId:a.id,command:'preflight'})}>Check network</button>
    <button type="button" className="btn btn-outline !text-xs" disabled={checkDisabled} onClick={()=>void onAction({action:'session-check',accountId:a.id,command:'approve-identity'})}>{s.drift?'Approve reviewed browser identity':'Capture browser identity'}</button>
    <button type="button" className="btn btn-outline !text-xs" disabled={checkDisabled||s.network?.verdict!=='PASS'||!s.fingerprint} onClick={()=>void onAction({action:'session-check',accountId:a.id,command:'diagnostics'})}>Run detector checks</button>
   </div>
   {a.attentionReason&&<p className="field-hint">Complete the saved LinkedIn review first. Session checks cannot clear that hold.</p>}
   {s.diagnosticRequested&&<p className="field-hint">{s.diagnosticRequested} requested. The local agent runs the check in this account’s configured browser.</p>}
   <a className="inline-block text-xs underline" href={`/api/aliasmode?evidence=${encodeURIComponent(a.id)}`} target="_blank" rel="noopener noreferrer">Saved session evidence</a>
   {s.gate?.verdict==='UNKNOWN'&&<div className="space-y-2"><label className="flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5" checked={reviewed} disabled={checkDisabled} onChange={e=>setReviewed(e.target.checked)}/>I reviewed this saved report and accept its unclear checks.</label><button type="button" className="btn btn-outline !text-xs" disabled={checkDisabled||!reviewed||!s.gate.reportId} onClick={()=>void onAction({action:'approve-unclear',accountId:a.id,revision:s.revision,reportId:s.gate?.reportId})}>Approve unclear results</button><p className="field-hint">Approval applies only to this report and browser setup. It does not clear LinkedIn holds or start processing.</p></div>}
   {s.gate&&<details><summary className="cursor-pointer text-xs">Detector evidence</summary><p className="field-hint">{s.gate.reason}</p><ul className="space-y-2 py-2">{s.gate.sites?.map(site=><li key={site.url} className="text-xs break-words"><a href={site.url} target="_blank" rel="noopener noreferrer" className="underline">{new URL(site.url).hostname}</a> · {site.verdict}<p className="text-[var(--text-dim)]">{site.reason}</p></li>)}</ul><p className="field-hint">Incomplete or unavailable tests remain UNKNOWN unless you explicitly approve the saved report. Confirmed failures cannot be overridden.</p></details>}
   {s.fingerprint&&<details><summary className="cursor-pointer text-xs">Stored browser identity</summary><pre className="max-h-52 overflow-auto whitespace-pre-wrap break-all text-[11px]">{JSON.stringify(s.fingerprint.fields,null,2)}</pre>{s.drift&&<pre className="max-h-52 overflow-auto whitespace-pre-wrap break-all text-[11px]">{JSON.stringify(s.drift,null,2)}</pre>}</details>}
   <form className="space-y-3" onSubmit={event=>{event.preventDefault();void onAction({action:'session-policy',accountId:a.id,revision:s.revision,engine,launchMode:mode,proxyId:proxy,proxyHost:host,proxyPort:port?Number(port):null,proxyCountry:country,proxyTimezone:zone,expectedExitIp:ip,policy});}}>
    <p className="field-hint">Configure the engine and dedicated proxy in AliasMode first. Save its reference here for verification. Passwords and browser cookies stay in AliasMode; no purchase is made.</p>
    <div className="grid gap-3 sm:grid-cols-2">
     <label className="space-y-1"><span className="field-label">AliasMode profile engine</span><select className="field w-full" value={engine} disabled={busy} onChange={e=>setEngine(e.target.value as typeof engine)}><option value="aliasmode-chromium">AliasMode Chromium</option><option value="cloakbrowser">CloakBrowser</option></select></label>
     <label className="space-y-1"><span className="field-label">Processing mode</span><select className="field w-full" value={mode} disabled={busy} onChange={e=>setMode(e.target.value as typeof mode)}><option value="headful">Visible · default</option><option value="headless">Headless</option></select></label>
     {[['Proxy reference',proxy,setProxy],['Proxy host',host,setHost],['Proxy port',port,setPort],['Country code',country,setCountry],['IANA timezone',zone,setZone],['Fixed exit IP',ip,setIp]].map(([label,value,set])=><label key={label as string} className="space-y-1"><span className="field-label">{label as string}</span><input className="field w-full" value={value as string} disabled={busy} onChange={e=>(set as (v:string)=>void)(e.target.value)} required={!!proxy} maxLength={label==='Country code'?2:253}/></label>)}
    </div>
    <details><summary className="cursor-pointer text-xs">Warmup, spacing and recovery settings</summary><div className="grid gap-3 pt-3 sm:grid-cols-2">{settings.map(([key,label])=><label key={key} className="space-y-1"><span className="field-label">{label}</span><input className="field w-full" type="number" min={key.includes('Interval')?60:key==='staggerSeconds'?0:key==='recoveryDays'?7:1} max={key.includes('Interval')?3600:key==='warmupProfilesPerDay'?20:key==='staggerSeconds'?120:key==='renderEvery'?100:90} value={policy[key]??''} disabled={busy} onChange={e=>setPolicy({...policy,[key]:Number(e.target.value)})}/></label>)}</div></details>
    <button className="btn btn-outline !text-xs" type="submit" disabled={busy}>Save session setup</button>
    {busy&&!disabled&&<p className="field-hint">Pause processing and close this account session before changing its setup.</p>}
   </form>
  </div>
 </details>;
}
