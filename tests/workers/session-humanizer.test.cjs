'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const human=require('../../src/lib/session-humanizer.cjs');
function fixture(){
 let clock=0,scrolls=0,moves=0;
 const page=new EventEmitter();Object.assign(page,{url:()=> 'https://www.linkedin.com/in/dwell-fixture/',mouse:{move:async()=>moves++},evaluate:async(fn,arg)=>arg===undefined?{width:1200,height:800}:scrolls++});
 return {page,now:()=>clock,sleep:async ms=>{clock+=ms;},counts:()=>({scrolls,moves})};
}
test('bounded log-normal profile intervals retain a 90s median and long tail',()=>{
 let seed=11235813;
 const random=(min,max)=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return min+Math.floor(seed/4294967296*(max-min));};
 const samples=Array.from({length:20000},()=>human.profileIntervalMs({random})).sort((a,b)=>a-b);
 assert.ok(samples.every(x=>Number.isInteger(x)&&x>=60000&&x<=400000));
 assert.ok(samples[10000]>87000&&samples[10000]<93000);
 assert.ok(samples[18000]>195000&&samples[18000]<220000);
 assert.ok(samples[19800]>360000,'The upper percentile extends well past the old 150s cap');
 assert.equal(samples.at(-1),400000);
 // Interior log quantiles are symmetric about log(median), as the requested
 // distribution requires. A uniform interval cannot satisfy these quantiles.
 assert.ok(Math.abs(Math.log(samples[15000]/samples[10000])-Math.log(samples[10000]/samples[5000]))<.08);
});
for(const upper of [false,true])test('profile dwell observes '+(upper?'upper':'lower')+' duration and scroll bounds without fixed uninterruptible sleep',async()=>{
 const f=fixture(),random=(min,max)=>upper?max-1:min;
 const result=await human.dwell(f.page,{...f,random});
 assert.equal(result.dwellMs,upper?90000:30000);assert.equal(result.scrollCount,upper?4:2);
 assert.deepEqual(f.counts(),{scrolls:result.scrollCount,moves:result.scrollCount});
});
test('feed dwell uses the existing scroll humanizer and 20–60s bounds',async()=>{
 const f=fixture(),result=await human.dwell(f.page,{...f,minMs:20000,maxMs:60000,minScrolls:1,maxScrolls:2,random:min=>min});
 assert.equal(result.dwellMs,20000);assert.equal(result.scrollCount,1);
});
test('a hold interrupts dwell before any later scroll',async()=>{
 const f=fixture();let calls=0;
 await assert.rejects(human.dwell(f.page,{...f,assertActive:async()=>{if(++calls===4)throw Error('Exact hold');},random:min=>min}),/Exact hold/);
 assert.deepEqual(f.counts(),{scrolls:0,moves:0});
});
test('settle waits for complete readiness and native tracking completion plus quiet',async()=>{
 const page=new EventEmitter(),request={url:()=> 'https://www.linkedin.com/li/track'},f=fixture();
 let state='interactive',started=false,finished=false;
 page.evaluate=async()=>state;
 const result=await human.settle(page,{now:f.now,sleep:async ms=>{await f.sleep(ms);if(f.now()>=200&&!started){started=true;page.emit('request',request);}if(f.now()>=500){state='complete';if(!finished){finished=true;page.emit('requestfinished',request);}}}});
 assert.equal(result.readyState,'complete');assert.equal(result.settled,true);assert.equal(result.pendingRequests,0);assert.equal(result.observedRequests,1);
 assert.ok(result.elapsedMs>=1250);assert.equal(result.telemetryFlushConfirmed,false,'Browser quiet cannot prove server ingestion');
});
test('settle deadline reports unfinished telemetry honestly and remains cancellable',async()=>{
 const page=new EventEmitter(),f=fixture();let started=false;
 page.evaluate=async()=> 'complete';
 const result=await human.settle(page,{now:f.now,timeoutMs:1200,sleep:async ms=>{await f.sleep(ms);if(!started){started=true;page.emit('request',{url:()=> 'https://www.linkedin.com/realtime/realtimeFrontendClientConnectivityTracking'});}}});
 assert.equal(result.settled,false);assert.equal(result.reason,'bounded-settle-deadline');assert.equal(result.pendingRequests,1);assert.equal(result.elapsedMs,1200);
 await assert.rejects(human.settle(page,{assertActive:async()=>{throw Error('Paused');}}),/Paused/);
});
