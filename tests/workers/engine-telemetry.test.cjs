'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const telemetry=require('../../src/lib/engine-telemetry.cjs');
test('stage wall shares do not double count nested or concurrent HTTP spans',()=>{
 const trace={pickedAt:new Date(0).toISOString(),decidedAt:new Date(1000).toISOString(),spans:[
  {name:'website.crawl',start:200,ms:600},{name:'website.page_http',start:200,ms:500},
  {name:'website.page_http',start:300,ms:500},{name:'db.query',start:850,ms:100},
  {name:'linkedin.profile',start:0,ms:200},{name:'throttle.wait',start:50,ms:100},
 ]};
 const times=telemetry.attributedTime(trace);
 assert.equal(Object.values(times).reduce((sum,ms)=>sum+ms,0),1000);
 assert.equal(times['website research'],600);assert.equal(times['throttle wait'],100);
 assert.equal(times['LinkedIn profile'],100);assert.equal(times['other database'],100);
 assert.equal(times['lane queue / retry / other'],100);
});
test('telemetry is isolated between leads and resumes pickup across the durable lane handoff',async()=>{
 let saved;
 await Promise.all([
  telemetry.withLead({jobId:'one',enginePickedAt:new Date(1000).toISOString()},async()=>{
   await telemetry.span('linkedin.profile',async()=>{});saved=telemetry.attach({profileIdentityConfirmed:true});
  }),
  telemetry.withLead({jobId:'two'},async()=>{await telemetry.span('website.crawl',async()=>{});assert.equal(telemetry.current().totals['linkedin.profile'],undefined);}),
 ]);
 assert.equal(telemetry.current(),null);
 await telemetry.withLead({jobId:'one',resumeResult:saved,retryCount:1},async()=>{
  const trace=telemetry.current();assert.equal(trace.pickedAt,new Date(1000).toISOString());
  assert.equal(trace.attempts,2);assert.equal(trace.retries,1);assert.equal(trace.totals['linkedin.profile'].count,1);
 });
});
test('span storage stays bounded and exceptions preserve caller behavior',async()=>{
 await telemetry.withLead({jobId:'bounded'},async()=>{
  for(let i=0;i<telemetry.MAX_SPANS+5;i++)telemetry.spanSync('qualification',()=>1);
  await assert.rejects(telemetry.span('website.crawl',()=>Promise.reject(Error('fixture'))),/fixture/);
  assert.equal(telemetry.current().spans.length,telemetry.MAX_SPANS);
  assert.equal(telemetry.current().droppedSpans,6);assert.equal(telemetry.current().totals['website.crawl'].errors,1);
 });
});
test('pg pool delegation counts once and separates active lead queries from idle',async()=>{
 const client={query:async()=>({rows:[{ok:true}]})},pool=new EventEmitter();
 pool.query=(...args)=>client.query(...args);
 const stats=telemetry.observePool(pool,{now:()=>1000});pool.emit('connect',client);
 await pool.query('idle');
 await telemetry.withLead({jobId:'query'},async()=>{await pool.query('active');await client.query('transaction');});
 assert.equal(stats.total,3);assert.equal(stats.idle,1);assert.equal(stats.active,2);
 assert.equal(telemetry.queryRates(stats,61000).idleQueriesPerMinute,0);
});
test('empty summaries show unavailable latency rather than invented zero performance',()=>{
 const summary=telemetry.summarize([]);assert.equal(summary.medianMs,null);assert.equal(summary.p90Ms,null);assert.equal(summary.leadsPerHour,null);assert.equal(summary.errorRate,null);
});
test('throughput uses batch elapsed time, not sum of parallel lead durations',()=>{
 const traces=[0,100].map((start,index)=>({pickedAt:new Date(start).toISOString(),decidedAt:new Date(start+1000).toISOString(),outcome:'REJECTED',spans:[],totals:{},retries:index}));
 const summary=telemetry.summarize(traces);
 assert.equal(summary.medianMs,1000);assert.equal(summary.p90Ms,1000);assert.equal(summary.leadsPerHour,2*3600000/1100);assert.equal(summary.retryCount,1);
});
