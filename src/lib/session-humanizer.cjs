'use strict';
const {randomInt}=require('node:crypto');
const {profileUrl}=require('./linkedin-workers.cjs');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const telemetryObservers=new WeakMap();
function observeTelemetry(page){
 let state=telemetryObservers.get(page);if(state)return state;
 state={pending:new Set(),observedRequests:0,navigationStartRequests:0,sequence:0};telemetryObservers.set(page,state);
 const matches=request=>{try{const u=new URL(request.url());return /(^|\.)linkedin\.com$/.test(u.hostname)&&/(?:\/li\/track|tracking|telemetry|page[-_]?view)/i.test(u.pathname);}catch{return false;}};
 page.on?.('request',request=>{if(matches(request)){state.observedRequests++;state.sequence++;state.pending.add(request);}});
 const done=request=>{if(state.pending.delete(request))state.sequence++;};
 page.on?.('requestfinished',done);page.on?.('requestfailed',done);return state;
}
function profileIntervalMs({random=randomInt}={}){
 // Censored log-normal: median 90s, sigma .65, existing 60s floor and 400s
 // tail ceiling. Censoring is deliberate: never redraw away the long tail.
 const u=random(1,1000000000)/1000000000,v=random(1,1000000000)/1000000000;
 const normal=Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);
 return Math.round(Math.max(60000,Math.min(400000,90000*Math.exp(.65*normal))));
}
async function interact(page,{assertActive=async()=>{},random=randomInt}={}){
 await assertActive();
 if(!/^https:\/\/www\.linkedin\.com\/(?:feed|in\/)/.test(page.url()))return;
 // Only scrolling and pointer movement. Never target links/buttons, submit a
 // form, react, follow, connect, or send a message as incidental "humanization".
 const point=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
 const x=random(40,Math.max(41,Math.min(point.width-40,1100))),y=random(80,Math.max(81,Math.min(point.height-40,700)));
 await assertActive();await page.mouse?.move(x,y,{steps:random(3,9)});
 await assertActive();const distance=random(120,421);
 // A background/occluded page need not schedule an animation frame. Scrolling
 // is synchronous here; subsequent page inspection observes the rendered DOM.
 await page.evaluate(dy=>{scrollBy({top:dy,behavior:'instant'});},distance);
 await assertActive();
}
async function feed(page,{assertActive=async()=>{}}={}){
 await assertActive();const state=observeTelemetry(page);state.navigationStartRequests=state.observedRequests;
 const response=await page.goto('https://www.linkedin.com/feed/',{waitUntil:'load',timeout:30000});await assertActive();return response;
}
async function visit(page,url,{assertActive=async()=>{},onNavigationEvidence}={}){
 const canonical=profileUrl(url);if(!canonical)throw Error('Rendered session visit requires a canonical person profile.');
 const state=observeTelemetry(page);state.navigationStartRequests=state.observedRequests;
 return require('./linkedin-browser-page.cjs').navigateProfile(page,canonical,{assertActive,onNavigationEvidence,timeout:20000});
}
async function settle(page,{assertActive=async()=>{},timeoutMs=8000,quietMs=750,now=Date.now,sleep:pause=sleep}={}){
 const state=observeTelemetry(page),started=now();
 let readyState='loading',sequence=state.sequence,lastActivity=started;
 do{
  await assertActive();readyState=await page.evaluate(()=>document.readyState);await assertActive();
  if(sequence!==state.sequence){sequence=state.sequence;lastActivity=now();}
  if(readyState==='complete'&&!state.pending.size&&now()-lastActivity>=quietMs)return {readyState,settled:true,reason:'observed-network-quiet',observedRequests:state.observedRequests-state.navigationStartRequests,pendingRequests:0,elapsedMs:now()-started,telemetryFlushConfirmed:false};
  await pause(Math.min(100,Math.max(1,timeoutMs-(now()-started))));
 }while(now()-started<timeoutMs);
 return {readyState,settled:false,reason:'bounded-settle-deadline',observedRequests:state.observedRequests-state.navigationStartRequests,pendingRequests:state.pending.size,elapsedMs:now()-started,telemetryFlushConfirmed:false};
}
async function dwell(page,{assertActive=async()=>{},minMs=30000,maxMs=90000,minScrolls=2,maxScrolls=4,now=Date.now,sleep:pause=sleep,random=randomInt}={}){
 for(const value of [minMs,maxMs,minScrolls,maxScrolls])if(!Number.isInteger(value)||value<0)throw Error('Dwell bounds must be nonnegative integers.');
 if(maxMs<minMs||maxScrolls<minScrolls||maxScrolls>4)throw Error('Invalid dwell bounds.');
 const targetDwellMs=random(minMs,maxMs+1),plannedScrolls=random(minScrolls,maxScrolls+1),started=now();let scrollCount=0;
 for(let i=0;i<=plannedScrolls;i++){
  const due=started+targetDwellMs*(i+1)/(plannedScrolls+1);
  while(now()<due){await assertActive();await pause(Math.min(500,Math.max(1,due-now())));}
  await assertActive();
  if(i<plannedScrolls){await interact(page,{assertActive,random});scrollCount++;}
 }
 await assertActive();return {dwellMs:now()-started,scrollCount,targetDwellMs};
}
module.exports={interact,visit,feed,dwell,settle,profileIntervalMs};
