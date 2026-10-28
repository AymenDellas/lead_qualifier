'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),core=require('../../src/lib/linkedin-workers.cjs'),alias=require('../../src/lib/aliasmode-store.cjs'),exp=require('../../src/lib/worker-warmup-experiment.cjs'),rendered=require('../../src/lib/linkedin-browser-page.cjs'),{createAccountRuntime}=require('../../src/lib/account-runtime.cjs'),{database}=require('./db-fixture.cjs'),{fixture}=require('./aliasmode-fixture.cjs');
function timing(){let clock=Date.now();return {now:()=>clock,sleep:async ms=>{clock+=ms;},random:(_min,max)=>Math.floor(max/2)};}
test('the real runtime only renders warmup pages and stops on a fresh 403; all fixture traffic is intercepted',async()=>{
 const db=await database(),f=await fixture(),pool=db.pool;let runtime,heartbeat;
 try{
  await core.ensure(pool);await alias.ensure(pool);const id=await alias.importProfile(pool,{profileId:exp.PROFILE,name:'John fixture',expectedMemberName:'John Dilah'}),identity={name:'John Dilah',profileUrl:'https://www.linkedin.com/in/owner-john-fixture/'},urls=Array.from({length:20},(_,i)=>`https://www.linkedin.com/in/runtime-warmup-${i}/`);
  await pool.query('UPDATE compel_linkedin_accounts SET connected_at=NOW(),confirmed_identity=$2::jsonb,attention_reason=$3 WHERE id=$1',[id,JSON.stringify(identity),'Saved 403 hold reviewed by user']);
  await exp.prepare(pool,urls);await exp.start(pool);await pool.query("UPDATE compel_engine_batches SET report=report||jsonb_build_object('notBefore',clock_timestamp()-interval '1 second') WHERE id=$1",[exp.ID]);await core.acquireSession(pool,id,'owner');
  heartbeat=setInterval(()=>void core.heartbeat(pool,id,'owner',{status:'fixture'}).catch(()=>{}),10000);heartbeat.unref();
  const browser=f.create(exp.PROFILE),surface=await browser.open({headless:false}),page=surface.page,requests=[];
  await page.setRequestInterception(true);page.on('request',r=>{requests.push(r.url());void r.respond({status:r.url()===urls[1]?403:200,contentType:r.url().includes('/voyager/api/')?'application/json':'text/html',body:r.url().includes('/voyager/api/')?'{}':'<!doctype html><title>Intercepted fixture</title><main style="height:2000px"><h1>Fixture page</h1></main><script>fetch("/voyager/api/fixture-background")</script>'}).catch(()=>{});});
  const runner=exp.create({pool,accountId:id,owner:'owner',core,...timing(),rendered:{readSignedInIdentity:async()=>identity}});
  runtime=createAccountRuntime({pool,accountId:id,owner:'owner',core,browserOwner:browser,warmupExperiment:runner,reader:{inspected:rendered.inspected,captureProfile:()=>assert.fail('No qualification API reads')},researchQueue:{handoff:()=>assert.fail('No public research')},discoveryStore:{claimSource:()=>assert.fail('No discovery')}});
  await runtime.tick();assert.equal((await exp.load(pool)).report.visits.length,1);assert.equal(runtime.snapshot().reasonCode,'PROFILE_INTERVAL');assert.equal(runtime.snapshot().sessionReady,true);assert.equal((await core.readRuntimeAccount(pool,id)).processing_enabled,false);
  await pool.query('UPDATE compel_linkedin_accounts SET next_profile_at=NULL WHERE id=$1',[id]);await runtime.tick();await runtime.tick();
  const report=await exp.load(pool);assert.equal(report.state,'WARMUP_STOPPED');assert.equal(report.report.visits.length,1);assert.equal(report.report.attempts.length,2);assert.match((await core.readRuntimeAccount(pool,id)).attention_reason,/HTTP 403/);assert.equal(report.report.scriptedQualificationRequests,0);assert.ok(report.report.traffic.nativeVoyager>=1);
  const visit=report.report.visits[0];assert.equal(visit.navigationMethod,'location.assign');assert.equal(visit.secFetchSite,null,'an intercepted response cannot manufacture browser-generated request headers');assert.ok(visit.referer);assert.ok(visit.dwellMs>=30000&&visit.dwellMs<=90000);assert.ok(visit.scrollCount>=2&&visit.scrollCount<=4);assert.ok(visit.intervalMs>=60000&&visit.intervalMs<=400000);
  assert.equal(requests[0],'https://www.linkedin.com/feed/');assert.equal(report.report.finalPage.path,'/in/runtime-warmup-1/','a fresh hold must stop without a final feed navigation');
  assert.equal(requests.filter(u=>urls.includes(u)).length,2);assert.ok(requests.every(u=>u==='https://www.linkedin.com/feed/'||urls.includes(u)||u.includes('/voyager/api/fixture-background')||u.endsWith('/favicon.ico')));
 }finally{clearInterval(heartbeat);await runtime?.close({preserveIntent:true});await f.close();await db.close();}
});
for(const scenario of ['http500','fallback200','other-member'])test('warmup '+scenario+' retains bounded response diagnostics and never counts an error/redirect as a completed visit',async()=>{
 const db=await database(),f=await fixture(),pool=db.pool;let runtime,heartbeat;
 try{
  await core.ensure(pool);await alias.ensure(pool);const id=await alias.importProfile(pool,{profileId:exp.PROFILE,name:'John fixture',expectedMemberName:'John Dilah'}),identity={name:'John Dilah',profileUrl:'https://www.linkedin.com/in/owner-john-fixture/'},urls=Array.from({length:20},(_,i)=>`https://www.linkedin.com/in/health-warmup-${i}/`);
  await pool.query("UPDATE compel_linkedin_accounts SET connected_at=NOW(),confirmed_identity=$2::jsonb,launch_mode='headless' WHERE id=$1",[id,JSON.stringify(identity)]);
  await exp.prepare(pool,urls);await exp.start(pool);await pool.query("UPDATE compel_engine_batches SET report=report||jsonb_build_object('notBefore',clock_timestamp()-interval '1 second') WHERE id=$1",[exp.ID]);await core.acquireSession(pool,id,'owner');
  heartbeat=setInterval(()=>void core.heartbeat(pool,id,'owner',{status:'fixture'}).catch(()=>{}),10000);heartbeat.unref();
  const browser=f.create(exp.PROFILE),surface=await browser.open({headless:true}),page=surface.page,requests=[];
  await page.setRequestInterception(true);page.on('request',r=>{requests.push(r.url());let response={status:200,contentType:'text/html',body:'<!doctype html><title>Intercepted fixture</title><main>Fixture page</main>'};
   if(r.url()===urls[0])response=scenario==='http500'?{...response,status:500}:{status:302,headers:{location:scenario==='fallback200'?'/error_pages/500.html?token=fixture-do-not-save':'/in/other-member/?token=fixture-do-not-save'},body:''};
   void r.respond(response).catch(()=>{});
  });
  const runner=exp.create({pool,accountId:id,owner:'owner',core,...timing(),rendered:{readSignedInIdentity:async()=>identity}});
  runtime=createAccountRuntime({pool,accountId:id,owner:'owner',core,browserOwner:browser,warmupExperiment:runner,reader:{inspected:rendered.inspected,captureProfile:()=>assert.fail('No qualification reads')},researchQueue:{handoff:()=>assert.fail('No public research')},discoveryStore:{claimSource:()=>assert.fail('No discovery')}});
  await runtime.tick();const report=await exp.load(pool);assert.equal(report.state,'WARMUP_STOPPED');assert.equal(report.report.attempts.length,1,report.report.reason);assert.equal(report.report.visits.length,0);assert.equal(report.report.lastAction,'profile_inspection');assert.equal((await core.readRuntimeAccount(pool,id)).attention_reason,'');
  assert.ok(report.report.traffic.pages.length>=2);assert.ok(report.report.traffic.pages.length<=20);assert.equal(report.report.scriptedQualificationRequests,0);assert.ok(!JSON.stringify(report.report).includes('fixture-do-not-save'));
  if(scenario==='http500'){assert.equal(report.report.lastNavigation.status,500);assert.equal(report.report.traffic.serverErrors[0].status,500);assert.match(report.report.reason,/HTTP 500/);}
  else{assert.ok(report.report.lastNavigation.redirectedFrom.some(p=>p.path==='/in/health-warmup-0/'));assert.equal(report.report.finalPage.path,scenario==='fallback200'?'/error_pages/500.html':'/in/other-member/');}
  assert.ok(requests.every(u=>u.startsWith('https://www.linkedin.com/')),'All observed fixture requests stay on intercepted origins');
 }finally{clearInterval(heartbeat);await runtime?.close({preserveIntent:true});await f.close();await db.close();}
});
