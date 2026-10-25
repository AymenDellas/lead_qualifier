'use client';
import {useEffect,useState} from 'react';
import type {EngineMetrics} from '@/lib/engine-telemetry.cjs';
const duration=(ms:number|null|undefined)=>ms==null?'—':ms>=60000?`${(ms/60000).toFixed(1)} min`:`${(ms/1000).toFixed(1)} s`;
export default function EngineMetricsPanel(){
 const [data,setData]=useState<EngineMetrics|null>(null),[error,setError]=useState('');
 useEffect(()=>{
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
  async function refresh(){
   try{const response=await fetch('/api/engine-metrics',{signal:controller.signal,cache:'no-store'});
    if(!response.ok)throw Error('Measurements could not refresh. Check the local worker and database.');
    const next:EngineMetrics=await response.json();if(!controller.signal.aborted){setData(next);setError('');}
   }catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:'Measurements unavailable.');}
   finally{if(!controller.signal.aborted)timer=setTimeout(refresh,15000);}
  }
  void refresh();return ()=>{controller.abort();clearTimeout(timer);};
 },[]);
 const resources=data?.resources||[],memory=resources.reduce((sum,row)=>sum+row.treeRssMB,0),
  cpu=resources.some(row=>row.cpuPercent!=null)?resources.reduce((sum,row)=>sum+(row.cpuPercent||0),0):null,
  idle=resources.reduce((sum,row)=>sum+row.idleQueriesPerMinute,0);
 return <section className="panel" aria-label="Qualification performance">
  <div className="panel-head">Qualification performance<span className="hint">Last 24 hours · up to 200 leads</span></div>
  {error&&<p role="status" className="panel-note">{error}{data?' Last successful measurements remain below.':''}</p>}
  {!data?<p className="panel-note" role="status">{error?'Waiting for measurements.':'Loading measurements…'}</p>
   :!data.available?<p className="panel-note">{data.reason}</p>
   :<div className="panel-body space-y-4">
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
     {[
      ['Median decision',duration(data.medianMs)],['90th percentile',duration(data.p90Ms)],
      ['Decided per hour',data.leadsPerHour==null?'—':data.leadsPerHour.toFixed(1)],['Measured decisions',String(data.decided||0)],
      ['Median queue wait',duration(data.medianQueueWaitMs)],['Retries / rework',`${data.retryCount||0} / ${data.reworkCount||0}`],
      ['ERROR rate',data.errorRate==null?'—':`${(data.errorRate*100).toFixed(1)}%`],['Worker trees RAM',resources.length?`${memory.toLocaleString()} MB`:'—'],
      ['Worker trees CPU',cpu==null?'—':`${cpu.toFixed(0)}%`],['Idle worker queries / min',resources.length?idle.toFixed(1):'—'],
     ].map(([label,value])=><div key={label}><dt className="label-micro">{label}</dt><dd className="num text-[15px] mt-0.5">{value}</dd></div>)}
    </dl>
    {!!data.stages?.length&&<div className="overflow-x-auto"><table className="w-full text-[12px]">
     <caption className="text-left label-micro mb-2">Decision time by stage</caption>
     <thead><tr className="text-[var(--text-dim)]"><th scope="col" className="text-left font-normal py-1">Stage</th><th scope="col" className="text-right font-normal">Wall time</th><th scope="col" className="text-right font-normal">Share</th></tr></thead>
     <tbody>{data.stages.map(row=><tr key={row.name} className="border-t border-[var(--line)]"><th scope="row" className="text-left font-normal py-2 pr-3">{row.name}</th><td className="text-right num whitespace-nowrap pr-3">{duration(row.ms)}</td><td className="text-right num">{(row.share*100).toFixed(1)}%</td></tr>)}</tbody>
    </table></div>}
    {!data.decided&&<p className="text-[12px] text-[var(--text-dim)]">No instrumented decisions yet. Timings appear as the local worker saves captured profiles and final results.</p>}
    <details className="text-[12px]"><summary className="cursor-pointer">Stage counts and failure reasons</summary>
     <dl className="mt-2 space-y-1">{Object.entries(data.funnel||{}).map(([name,count])=><div key={name} className="flex justify-between gap-3"><dt className="break-all">{name}</dt><dd className="num">{count} leads</dd></div>)}</dl>
     <dl className="mt-3 space-y-1">{Object.entries(data.errors||{}).map(([name,count])=><div key={name} className="flex justify-between gap-3"><dt className="break-all">{name}</dt><dd className="num">{count}</dd></div>)}</dl>
    </details>
    <p className="text-[11px] text-[var(--text-dim)]">Pickup to saved decision includes lane waits and retries. Overlapping stages count once. CPU uses 100% per core; short-lived processes may be missed. Resource samples refresh every 15 seconds.</p>
    {data.incompleteSpans&&<p role="status" className="text-[12px]">Some detailed spans reached the storage bound. Stage shares are incomplete for those leads.</p>}
   </div>}
 </section>;
}
