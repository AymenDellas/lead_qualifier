'use strict';
// Explicit anonymous measurement. No mapped profile or LinkedIn navigation.
const fs=require('node:fs'),path=require('node:path'),{randomUUID,createHash}=require('node:crypto'),{promisify}=require('node:util'),execFile=promisify(require('node:child_process').execFile);
const WORKER_FLAG='isAutomatedWithCDPInWebWorker';
function verifySupport(){
 const lock=require('../package-lock.json'),version=require('puppeteer/package.json').version,core=require('puppeteer-core/package.json').version;
 const root=path.dirname(require.resolve('puppeteer-core/package.json'));
 if(version!==lock.packages['node_modules/puppeteer'].version||core!==lock.packages['node_modules/puppeteer-core'].version||!fs.readFileSync(path.join(root,'lib/types.d.ts'),'utf8').includes('targetFilter?: TargetFilterCallback;'))throw Error('The installed/pinned Puppeteer does not confirm targetFilter support; stop without creating a profile.');
 return {puppeteer:version,puppeteerCore:core,targetFilter:true};
}
function stableObservation(site){
 const fields=['webdriver','userAgent','platform','chrome','plugins','screen','timezone','locale','hardwareConcurrency','deviceMemory','webglVendor','webglRenderer','cdpDetected'];
 const flags=site.external?.flags?Object.fromEntries(Object.entries(site.external.flags).filter(([k])=>k!==WORKER_FLAG).sort(([a],[b])=>a.localeCompare(b))):null;
 return {status:site.status,finalUrl:site.finalUrl,verdict:site.verdict,checks:site.checks,probe:Object.fromEntries(fields.filter(k=>k in (site.probe||{})).map(k=>[k,site.probe[k]])),external:site.external?{...site.external,...(flags?{flags}:{})}:null,
  ...(site.tls?{tls:Object.fromEntries(['user_agent','ja4','ja4_r','ja4_o','ja4_ro'].filter(k=>k in site.tls).map(k=>[k,site.tls[k]]))}:{})};
}
function compare(before,after){
 const flag=run=>run?.sites?.find(s=>s.kind==='device')?.external?.flags?.[WORKER_FLAG];
 const worker={before:flag(before)??null,after:flag(after)??null};
 const devices=[before,after].map(run=>run?.sites?.find(s=>s.kind==='device'));
 const otherFlags=devices.map(site=>site?.external?.flags?Object.fromEntries(Object.entries(site.external.flags).filter(([key])=>key!==WORKER_FLAG).sort(([a],[b])=>a.localeCompare(b))):null);
 const deviceOtherFlagsUnchanged=otherFlags.every(flags=>flags&&Object.keys(flags).length>0)&&JSON.stringify(otherFlags[0])===JSON.stringify(otherFlags[1]);
 const deviceDirectChecksUnchanged=devices.every(site=>site?.checks?.length===7)&&JSON.stringify(devices[0].checks)===JSON.stringify(devices[1].checks);
 const differences=[];
 for(const site of before?.sites||[]){
  const next=after?.sites?.find(s=>s.url===site.url);
  const left=stableObservation(site),right=next?stableObservation(next):null;
  // TLS check values include JA3 hashes; retain their variation separately.
  const withoutJA3=value=>value?{...value,checks:value.checks?.map(c=>c.name==='ja3'?{...c,value:'[per-request JA3 retained in raw report]'}:c)}:value;
  if(JSON.stringify(withoutJA3(left))!==JSON.stringify(withoutJA3(right)))differences.push({url:site.url,before:left,after:right});
 }
 const missing=(after?.sites||[]).filter(s=>!before?.sites?.some(b=>b.url===s.url));
 for(const site of missing)differences.push({url:site.url,before:null,after:stableObservation(site)});
 const completed=before?.sites?.length===7&&after?.sites?.length===7&&!before.error&&!after.error;
 return {worker,completed,workerFlagRemoved:worker.before===true&&worker.after===false,deviceOtherFlagsUnchanged,deviceOtherFlagCount:otherFlags[0]?Object.keys(otherFlags[0]).length:0,deviceDirectChecksUnchanged,otherStableObservationsUnchanged:completed&&differences.length===0,otherDifferences:differences,
  ja3Observations:[before,after].map(r=>r?.sites?.find(s=>s.kind==='tls')?.tls||null),
  acceptance:completed&&worker.before===true&&worker.after===false&&differences.length===0};
}
async function main(){
 if(process.env.VERCEL||process.argv.slice(2).join(' ')!=='--run')throw Error('Run locally with --run for one NEW BLANK profile only.');
 const support=verifySupport();require('./test-env.cjs');
 const {Pool}=require('pg'),production=new Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:10000,ssl:{rejectUnauthorized:false}});
 const core=require('../src/lib/linkedin-workers.cjs'),store=require('../src/lib/aliasmode-store.cjs'),checks=require('../src/lib/stealth-self-test.cjs'),helper=require('../src/lib/aliasmode-cli.cjs');
 const dir=path.resolve(__dirname,'../data/engine-v2/worker-target-filter');fs.mkdirSync(dir,{recursive:true});
 const file=path.join(dir,'comparison-'+randomUUID()+'.json'),report={at:new Date().toISOString(),version:checks.VERSION,support,scope:'One new blank AliasMode Chromium profile; same headful mode; production adapter; unfiltered baseline followed by worker-filtered connection; no LinkedIn navigation/authentication',runs:[],cleanup:[]};
 const save=()=>{fs.writeFileSync(file,JSON.stringify(report,null,2));fs.writeFileSync(path.join(dir,'comparison-latest.json'),JSON.stringify(report,null,2));};
 const accounts=async()=>createHash('sha256').update(JSON.stringify((await production.query('SELECT id,processing_enabled,attention_reason,login_requested_at,logout_requested_at,close_requested_at,session_evidence FROM compel_linkedin_accounts WHERE NOT archived ORDER BY id')).rows)).digest('hex');
 let api,db,created,accountId,owner,browser,heartbeat,heartbeatError,beforeProfiles,beforeAccounts;
 try{
  beforeAccounts=await accounts();const config=(await production.query('SELECT base_url FROM compel_aliasmode_config WHERE id=1')).rows[0];
  api=require('../src/lib/aliasmode-client.cjs').createAliasModeClient({config:{baseUrl:config.base_url}});await api.health();beforeProfiles=(await api.list()).profiles.map(p=>p.id).sort();
  db=await require('../tests/workers/db-fixture.cjs').database();await core.ensure(db.pool);await store.ensure(db.pool);
  created=await api.createProfile({name:'CompelOS blank worker-target diagnostic '+randomUUID().slice(0,8),engine:'aliasmode-chromium'});
  if(beforeProfiles.includes(created.id))throw Error('Create returned an existing profile; refusing to open or delete it.');
  report.temporaryProfile={id:created.id,engine:'aliasmode-chromium'};save();
  accountId=await store.importProfile(db.pool,{profileId:created.id,name:'Blank worker diagnostic',expectedMemberName:'Blank worker diagnostic'});owner='worker-diagnostic/'+randomUUID();
  await core.acquireSession(db.pool,accountId,owner);const account=await core.readRuntimeAccount(db.pool,accountId);
  heartbeat=setInterval(()=>void core.heartbeat(db.pool,accountId,owner,{status:'diagnostics',runtimeVersion:'SESSION_V2'}).catch(e=>{heartbeatError=e;}),10000);heartbeat.unref();
  let forbiddenNavigation=false;
  const assertActive=async()=>{if(forbiddenNavigation)throw Error('Unexpected LinkedIn navigation blocked.');if(heartbeatError)throw heartbeatError;if(!await core.sessionOwned(db.pool,accountId,owner))throw Error('Diagnostic lease lost.');};
  for(const filtered of [false,true]){
   // The control strips only the requested option; every other adapter option,
   // engine, mode, profile and unchanged detector assessment stays identical.
   const puppeteer=filtered?require('puppeteer'):{connect:options=>{const {targetFilter:ignored,...rest}=options;void ignored;return require('puppeteer').connect(rest);}};
   browser=require('../src/lib/aliasmode-browser.cjs').createAliasModeBrowser({account,owner,pool:db.pool,provider:{client:api,store},puppeteer});
   let value={filtered,mode:'headful'};
   try{
    await assertActive();const surface=await browser.open({headless:false});let requests=0,linkedinBlocked=0;
    await surface.page.setRequestInterception(true);surface.page.on('request',r=>{requests++;let hostname='';try{hostname=new URL(r.url()).hostname;}catch{}
     if(/(^|\.)(?:linkedin\.com|licdn\.com)$/.test(hostname)){linkedinBlocked++;forbiddenNavigation||=r.isNavigationRequest()&&r.frame()===surface.page.mainFrame();void r.abort().catch(()=>{});}else void r.continue().catch(()=>{});
    });
    value={...value,browserVersion:await surface.browser.version(),...await checks.run(surface.page,{assertActive}),requests,linkedinBlocked};
   }catch(error){value={...value,error:error.code||error.name,message:error.failure?.reason||'Diagnostic failed; inspect bounded local evidence.'};}
   finally{await browser.recycle();await browser.close();browser=null;}
   report.runs.push(value);save();console.log(JSON.stringify({filtered,verdict:value.verdict,counts:value.counts,workerFlag:value.sites?.find(s=>s.kind==='device')?.external?.flags?.[WORKER_FLAG],error:value.error}));
   if(value.error)break;
  }
 }finally{
  clearInterval(heartbeat);
  try{
   if(browser){await browser.recycle();await browser.close();}
   if(created&&beforeProfiles&&!beforeProfiles.includes(created.id)){
    if((await api.active(created.id)).active)throw Error('Temporary profile closure unconfirmed; retaining it for review.');
    if((await production.query('SELECT 1 FROM compel_linkedin_accounts WHERE aliasmode_profile_id=$1',[created.id])).rowCount)throw Error('Temporary profile became mapped; refusing deletion.');
    const {stdout}=await execFile(helper.helperPath(),['profiles','delete','--profile',created.id,'--json'],{windowsHide:true,shell:false,timeout:20000,maxBuffer:256*1024,env:helper.environment(process.env)});
    const receipt=JSON.parse(stdout);if(receipt.ok!==true||receipt.result?.deleted!==true)throw Error('Temporary profile deletion unconfirmed.');report.cleanup.push({id:created.id,closed:true,deleted:true});
   }
   if(accountId&&owner)await core.releaseSession(db.pool,accountId,owner,{status:'offline',runtimeVersion:'SESSION_V2'});
   if(beforeAccounts)report.accountsUnchanged=beforeAccounts===await accounts();
   if(beforeProfiles)report.originalRosterRestored=JSON.stringify(beforeProfiles)===JSON.stringify((await api.list()).profiles.map(p=>p.id).sort());
   report.comparison=compare(...report.runs);save();
   if(report.runs.length===2&&!report.runs.some(r=>r.error)&&report.accountsUnchanged&&report.originalRosterRestored){
    report.databaseReportId='worker-target-filter-'+randomUUID();await production.query(require('./engine-benchmark.cjs').BATCH_SCHEMA);
    await production.query("INSERT INTO compel_engine_batches(id,account_id,profiles,state,requested_count,started_at,finished_at,report) VALUES($1,'ANONYMOUS_DIAGNOSTIC',$2,'DIAGNOSTIC_COMPLETE',2,$3,NOW(),$4::jsonb)",[report.databaseReportId,checks.URLS,report.at,JSON.stringify({manifest:{kind:'worker-target-comparison',runs:2,leadJobs:0},...report})]);save();
   }
  }finally{save();await api?.idle();await db?.close();await production.end();}
 }
 console.log(JSON.stringify({report:file,accountsUnchanged:report.accountsUnchanged,originalRosterRestored:report.originalRosterRestored,...report.comparison,otherDifferences:report.comparison?.otherDifferences?.map(d=>d.url),ja3Observations:undefined}));
 if(!report.comparison?.acceptance||!report.accountsUnchanged||!report.originalRosterRestored)throw Error('Measurement did not prove every acceptance condition; preserve and disclose the saved differences.');
}
if(require.main===module)main().catch(error=>{console.error(error.code||error.name,error.failure?.reason||error.message);process.exitCode=1;});
module.exports={main,verifySupport,stableObservation,compare};
