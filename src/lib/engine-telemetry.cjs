'use strict';

// Observability only: never makes a qualification, retry, ownership or pacing decision.
const {AsyncLocalStorage}=require('node:async_hooks');
const {performance}=require('node:perf_hooks');
const context=new AsyncLocalStorage(),ready=new WeakMap();
const MAX_SPANS=512;
const SCHEMA=`CREATE TABLE IF NOT EXISTS compel_engine_traces (
 job_id TEXT PRIMARY KEY,account_id TEXT,batch_id TEXT,picked_at TIMESTAMPTZ NOT NULL,
 decided_at TIMESTAMPTZ,outcome TEXT,trace JSONB NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
 CREATE INDEX IF NOT EXISTS compel_engine_traces_recent ON compel_engine_traces(picked_at DESC);
 CREATE INDEX IF NOT EXISTS compel_engine_traces_batch ON compel_engine_traces(batch_id,picked_at);
 CREATE TABLE IF NOT EXISTS compel_engine_resources (
 owner TEXT PRIMARY KEY,pid INTEGER NOT NULL,data JSONB NOT NULL,seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`;
async function ensure(pool){
 if(!ready.has(pool))ready.set(pool,pool.query(SCHEMA).catch(error=>{ready.delete(pool);throw error;}));
 return ready.get(pool);
}
const iso=value=>new Date(value).toISOString();
function createTrace(job={},now=Date.now()){
 const previous=job.resumeResult?.engineMetrics||job.engineMetrics;
 const trace=previous?.version===1?structuredClone(previous):{
  version:1,jobId:job.jobId,accountId:job.accountId||null,batchId:job.engineBatchId||null,
  pickedAt:job.enginePickedAt||iso(now),createdAt:job.engineCreatedAt||job.createdAt||iso(now),
  spans:[],totals:{},requests:{linkedin:0,website:0},attempts:0,retries:0,droppedSpans:0,
 };
 trace.jobId=job.jobId||trace.jobId;trace.accountId=job.accountId||trace.accountId;
 trace.attempts++;trace.retries=Math.max(trace.retries||0,job.retryCount||0);
 trace.queueWaitMs=Math.max(0,Date.parse(trace.pickedAt)-Date.parse(trace.createdAt));
 return trace;
}
function current(){return context.getStore()?.trace||null;}
function record(name,started,durationMs,detail={}){
 const trace=current();if(!trace)return;
 const total=trace.totals[name]||(trace.totals[name]={count:0,ms:0,errors:0});
 total.count++;total.ms+=durationMs;if(detail.error)total.errors++;
 if(trace.spans.length<MAX_SPANS)trace.spans.push({name,start:started,ms:durationMs,...detail});else trace.droppedSpans++;
}
async function span(name,fn,detail={}){
 if(!current())return fn();
 const started=Date.now(),clock=performance.now();
 try{return await fn();}catch(error){detail={...detail,error:true};throw error;}
 finally{record(name,started,performance.now()-clock,detail);}
}
function spanSync(name,fn){
 if(!current())return fn();const started=Date.now(),clock=performance.now();let error=false;
 try{return fn();}catch(e){error=true;throw e;}finally{record(name,started,performance.now()-clock,{error});}
}
function withLead(job,fn){
 if(current()?.jobId===job.jobId)return fn(current());
 const trace=createTrace(job);return context.run({trace},()=>fn(trace));
}
function attach(value){const trace=current();return trace?{...value,engineMetrics:structuredClone(trace)}:value;}
function countRequest(kind){const trace=current();if(trace)trace.requests[kind]=(trace.requests[kind]||0)+1;}
async function persist(pool,result,{final=false}={}){
 const trace=current();if(!trace)return;
 if(final){trace.decidedAt=iso(Date.now());trace.outcome=result.status;trace.errorCode=result.failure?.code||null;}
 await ensure(pool);
 await pool.query(`INSERT INTO compel_engine_traces(job_id,account_id,batch_id,picked_at,decided_at,outcome,trace)
  VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(job_id) DO UPDATE SET
  account_id=COALESCE(EXCLUDED.account_id,compel_engine_traces.account_id),decided_at=EXCLUDED.decided_at,
  outcome=EXCLUDED.outcome,trace=EXCLUDED.trace,updated_at=NOW()`,
 [trace.jobId,trace.accountId,trace.batchId,trace.pickedAt,trace.decidedAt||null,trace.outcome||null,JSON.stringify(trace)]);
}
// Observe actual browser calls, without intercepting requests, reading cookies or
// touching response bodies. The caller's real page remains the security watcher.
function pageActions(page){
 if(!current())return page;
 const trace=current(),proxies=new Map();
 const action=(target,key,prefix)=>{
  const value=target[key];if(typeof value!=='function')return value;
  return (...args)=>span(prefix+'.'+key,()=>value.apply(target,args));
 };
 const mouse=new Proxy(page.mouse,{get:(target,key)=>action(target,key,'linkedin.pointer')});
 return new Proxy(page,{get(target,key){
  if(key==='mouse')return mouse;
  if(['goto','waitForFunction','waitForSelector','evaluate','content'].includes(key)){
   if(!proxies.has(key))proxies.set(key,action(target,key,'linkedin.page'));
   return proxies.get(key);
  }
  const value=target[key];return typeof value==='function'?value.bind(target):value;
 }});
}
function observePage(page,kind='linkedin'){
 const trace=current();if(!trace||!page.on)return ()=>{};
 const listener=()=>{trace.requests[kind]=(trace.requests[kind]||0)+1;};
 page.on('request',listener);return ()=>page.off('request',listener);
}
// pg Pool.query delegates to Client.query; the context guard counts it once.
function observePool(pool,{now=Date.now}={}){
 if(pool.__engineQueryStats)return pool.__engineQueryStats;
 const stats={total:0,idle:0,active:0,ms:0,recent:[],started:now()};
 const wrapped=new WeakSet();
 const wrap=target=>{
  if(wrapped.has(target))return;wrapped.add(target);const original=target.query;
  target.query=function(...args){
   const state=context.getStore()||{};if(state.db)return original.apply(this,args);
   const started=performance.now(),at=now(),idle=!state.trace;
   stats.total++;stats[idle?'idle':'active']++;stats.recent.push({at,idle});
   stats.recent=stats.recent.filter(x=>x.at>at-60000).slice(-10000);
   const done=()=>{const ms=performance.now()-started;stats.ms+=ms;record('db.query',at,ms);};
   return context.run({...state,db:true},()=>{
    const callback=typeof args.at(-1)==='function'?args.at(-1):null;
    if(callback)args[args.length-1]=function(...values){done();return callback.apply(this,values);};
    let value;try{value=original.apply(this,args);}catch(error){done();throw error;}
    if(!callback&&value?.then)return value.then(result=>{done();return result;},error=>{done();throw error;});
    return value;
   });
  };
 };
 wrap(pool);pool.on?.('connect',wrap);
 Object.defineProperty(pool,'__engineQueryStats',{value:stats});return stats;
}
function queryRates(stats,now=Date.now()){
 const elapsed=Math.max(1,Math.min(60000,now-stats.started));
 const recent=stats.recent.filter(row=>row.at>now-60000);
 return {queries:stats.total,idleQueries:stats.idle,activeQueries:stats.active,
  idleQueriesPerMinute:recent.filter(row=>row.idle).length*60000/elapsed,
  queryMs:stats.ms,observationMs:now-stats.started};
}
function category(name){
 if(name==='throttle.wait')return 'throttle wait';
 if(name==='crm.save'||name==='db.final_save')return 'CRM / result save';
 if(name.startsWith('website.'))return 'website research';
 if(name==='linkedin.activity')return 'LinkedIn activity';
 if(name==='linkedin.contact')return 'LinkedIn contact';
 if(name==='linkedin.profile')return 'LinkedIn profile';
 if(name==='qualification')return 'qualification';
 if(name==='db.query')return 'other database';
 return 'other LinkedIn actions';
}
// Split overlapping spans into disjoint wall-clock intervals. Parallel HTTP
// durations cannot be summed and called a percentage of elapsed decision time.
function attributedTime(trace){
 const start=Date.parse(trace.pickedAt),end=Date.parse(trace.decidedAt);
 if(!Number.isFinite(start)||!Number.isFinite(end)||end<start)return {};
 const spans=trace.spans.filter(s=>s.ms>=0).map(s=>({...s,end:Math.min(end,s.start+s.ms),start:Math.max(start,s.start)})).filter(s=>s.end>s.start);
 const points=[...new Set([start,end,...spans.flatMap(s=>[s.start,s.end])])].sort((a,b)=>a-b),totals={};
 const priority=name=>name==='throttle.wait'?0:['crm.save','db.final_save'].includes(name)?1:name==='linkedin.activity'?2:name==='linkedin.contact'?3:name==='linkedin.profile'?4:name.startsWith('website.')?5:name==='qualification'?6:name==='db.query'?7:8;
 for(let i=1;i<points.length;i++){
  const left=points[i-1],right=points[i],active=spans.filter(s=>s.start<=left&&s.end>=right).sort((a,b)=>priority(a.name)-priority(b.name));
  const key=active.length?category(active[0].name):'lane queue / retry / other';totals[key]=(totals[key]||0)+right-left;
 }
 return totals;
}
function percentile(values,p){
 if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b),at=(sorted.length-1)*p,low=Math.floor(at);
 return sorted[low]+(sorted[Math.ceil(at)]-sorted[low])*(at-low);
}
function summarize(traces){
 const decided=traces.filter(t=>t.decidedAt&&['QUALIFIED','REJECTED','REVIEW','ERROR'].includes(t.outcome));
 const durations=decided.map(t=>Date.parse(t.decidedAt)-Date.parse(t.pickedAt));
 const stageTotals={},errors={},funnel={},outcomes={};
 for(const trace of traces){
  if(trace.outcome)outcomes[trace.outcome]=(outcomes[trace.outcome]||0)+1;
  if(trace.errorCode)errors[trace.errorCode]=(errors[trace.errorCode]||0)+1;
  for(const key of Object.keys(trace.totals||{}))funnel[key]=(funnel[key]||0)+1;
  if(trace.decidedAt)for(const [key,ms]of Object.entries(attributedTime(trace)))stageTotals[key]=(stageTotals[key]||0)+ms;
 }
 const totalMs=durations.reduce((sum,n)=>sum+n,0),first=decided.length?Math.min(...decided.map(t=>Date.parse(t.pickedAt))):null,
  last=decided.length?Math.max(...decided.map(t=>Date.parse(t.decidedAt))):null;
 const elapsed=first===null?null:last-first;
 return {sampleSize:traces.length,decided:decided.length,medianMs:percentile(durations,.5),p90Ms:percentile(durations,.9),
  leadsPerHour:elapsed>0?decided.length*3600000/elapsed:null,batchElapsedMs:elapsed,
  medianQueueWaitMs:percentile(traces.map(t=>t.queueWaitMs||0),.5),
  retryCount:traces.reduce((sum,t)=>sum+(t.retries||0),0),
  reworkCount:traces.reduce((sum,t)=>sum+Math.max(0,(t.totals?.['linkedin.profile']?.count||0)-1)+Math.max(0,(t.totals?.['website.crawl']?.count||0)-1),0),
  errorRate:decided.length?(outcomes.ERROR||0)/decided.length:null,errors,funnel,outcomes,
  stages:Object.entries(stageTotals).map(([name,ms])=>({name,ms,share:totalMs?ms/totalMs:0})).sort((a,b)=>b.ms-a.ms),
  incompleteSpans:traces.some(t=>t.droppedSpans>0),
 };
}
async function readMetrics(pool,{batchId=null}={}){
 let rows,resources;
 try{
  rows=await pool.query(`SELECT trace FROM compel_engine_traces WHERE ($1::text IS NULL AND picked_at>NOW()-interval '24 hours' OR batch_id=$1)
   ORDER BY picked_at DESC LIMIT 200`,[batchId]);
  resources=await pool.query("SELECT data,seen_at FROM compel_engine_resources WHERE seen_at>NOW()-interval '90 seconds'");
 }catch(error){if(error.code==='42P01')return {available:false,reason:'Start an instrumented local worker to collect measurements.'};throw error;}
 return {available:true,...summarize(rows.rows.map(row=>row.trace)),resources:resources.rows.map(row=>({...row.data,seenAt:row.seen_at})),sampleLimit:200};
}
module.exports={SCHEMA,ensure,createTrace,current,withLead,span,spanSync,attach,persist,pageActions,observePage,countRequest,
 observePool,queryRates,attributedTime,percentile,summarize,readMetrics,MAX_SPANS};
