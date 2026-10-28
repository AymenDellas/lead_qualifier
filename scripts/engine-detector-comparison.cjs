'use strict';
// Explicit, anonymous diagnostics only. Never open a mapped/account profile.
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto'),{promisify}=require('node:util'),execFile=promisify(require('node:child_process').execFile);
async function persistReport(pool,report){
 if(report.runs?.length!==4||report.runs.some(r=>r.error)||!report.accountsUnchanged||!report.originalRosterRestored)throw Error('Only a completed, isolated comparison may be recorded as a diagnostic benchmark.');
 const id='detector-v3-'+randomUUID();
 await pool.query(require('./engine-benchmark.cjs').BATCH_SCHEMA);
 await pool.query(`INSERT INTO compel_engine_batches(id,account_id,profiles,state,requested_count,started_at,finished_at,report)
  VALUES($1,'ANONYMOUS_DIAGNOSTIC',$2,'DIAGNOSTIC_COMPLETE',4,$3,NOW(),$4::jsonb)`,[id,require('../src/lib/stealth-self-test.cjs').URLS,report.at,JSON.stringify({manifest:{kind:'browser-diagnostics',version:report.version,runs:4,leadJobs:0},...report})]);
 return id;
}
async function main(){
 if(process.env.VERCEL||process.argv.slice(2).join(' ')!=='--run')throw Error('Run locally with --run to compare NEW BLANK profiles. Existing LinkedIn profiles are never used.');
 require('./test-env.cjs');
 const {Pool}=require('pg'),production=new Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:10000,ssl:{rejectUnauthorized:false}});
 const core=require('../src/lib/linkedin-workers.cjs'),store=require('../src/lib/aliasmode-store.cjs'),checks=require('../src/lib/stealth-self-test.cjs'),helper=require('../src/lib/aliasmode-cli.cjs');
 const dir=path.resolve(__dirname,'../data/engine-v2/detector-v3');fs.mkdirSync(dir,{recursive:true});
 const file=path.join(dir,'browser-comparison-'+randomUUID()+'.json'),report={at:new Date().toISOString(),version:checks.VERSION,scope:'New blank profiles; production browser adapter; isolated PostgreSQL leases; no LinkedIn authentication/navigation; no configured proxy',runs:[],temporaryProfiles:[],cleanup:[]};
 const save=()=>{fs.writeFileSync(file,JSON.stringify(report,null,2));fs.writeFileSync(path.join(dir,'browser-comparison-latest.json'),JSON.stringify(report,null,2));};
 let db,api,beforeAccounts,beforeProfiles;
 const accounts=async()=> (await production.query('SELECT id,processing_enabled,attention_reason,login_requested_at,close_requested_at,session_evidence FROM compel_linkedin_accounts WHERE NOT archived ORDER BY id')).rows;
 try{
  beforeAccounts=await accounts();const config=(await production.query('SELECT base_url FROM compel_aliasmode_config WHERE id=1')).rows[0];
  api=require('../src/lib/aliasmode-client.cjs').createAliasModeClient({config:{baseUrl:config.base_url}});await api.health();beforeProfiles=(await api.list()).profiles.map(p=>p.id).sort();
  db=await require('../tests/workers/db-fixture.cjs').database();await core.ensure(db.pool);await store.ensure(db.pool);
  for(const engine of ['aliasmode-chromium','cloakbrowser']){
   let created,accountId,owner,browser,heartbeat,heartbeatError;
   try{
    created=await api.createProfile({name:'CompelOS anonymous detector '+engine+' '+randomUUID().slice(0,8),engine});
    if(beforeProfiles.includes(created.id))throw Error('Create returned a pre-existing profile; refusing to open or delete it.');
    report.temporaryProfiles.push({id:created.id,engine});save();
    accountId=await store.importProfile(db.pool,{profileId:created.id,name:'Anonymous detector fixture',expectedMemberName:'Anonymous detector fixture'});owner='diagnostic/'+randomUUID();
    await core.acquireSession(db.pool,accountId,owner);const account=await core.readRuntimeAccount(db.pool,accountId);
    heartbeat=setInterval(()=>void core.heartbeat(db.pool,accountId,owner,{status:'diagnostics',runtimeVersion:'SESSION_V2'}).catch(e=>{heartbeatError=e;}),10000);heartbeat.unref();
    let forbiddenNavigation=false;
    const assertActive=async()=>{if(forbiddenNavigation)throw Error('An unexpected LinkedIn navigation was blocked; stop the comparison.');if(heartbeatError)throw heartbeatError;if(!await core.sessionOwned(db.pool,accountId,owner))throw Error('Diagnostic lease lost; stop navigating.');};
    browser=require('../src/lib/aliasmode-browser.cjs').createAliasModeBrowser({account,owner,pool:db.pool,provider:{client:api,store}});
    for(const mode of ['headful','headless']){
     const started=Date.now();let value={engine,mode};
     try{
      await assertActive();const surface=await browser.open({headless:mode==='headless'}),startupMs=Date.now()-started;let requests=0,linkedinBlocked=0;const blockedRequests=[];
      await surface.page.setRequestInterception(true);surface.page.on('request',r=>{requests++;let hostname='';try{hostname=new URL(r.url()).hostname;}catch{}if(/(^|\.)(?:linkedin\.com|licdn\.com)$/.test(hostname)){linkedinBlocked++;const mainNavigation=r.isNavigationRequest()&&r.frame()===surface.page.mainFrame();forbiddenNavigation||=mainNavigation;if(blockedRequests.length<20)blockedRequests.push({hostname,resourceType:r.resourceType(),mainNavigation});void r.abort().catch(()=>{});}else void r.continue().catch(()=>{});});
      value={...value,startupMs,browserVersion:await surface.browser.version(),...await checks.run(surface.page,{assertActive}),requests,linkedinBlocked,blockedRequests};
     }catch(error){value={...value,error:error.code||error.name,message:error.failure?.reason||'Diagnostic comparison failed; inspect the local runtime.'};}
     finally{await browser.recycle();await browser.close();}
     report.runs.push(value);save();console.log(JSON.stringify({engine,mode,verdict:value.verdict,counts:value.counts,error:value.error}));
    }
   }finally{
    clearInterval(heartbeat);if(browser){await browser.recycle();await browser.close();}
    if(created&&!beforeProfiles.includes(created.id)){
     if((await api.active(created.id)).active)throw Error('Temporary browser closure unconfirmed; retaining its profile for review.');
     if((await production.query('SELECT 1 FROM compel_linkedin_accounts WHERE aliasmode_profile_id=$1',[created.id])).rowCount)throw Error('Temporary profile is now mapped to a real account; refusing deletion.');
     const {stdout}=await execFile(helper.helperPath(),['profiles','delete','--profile',created.id,'--json'],{windowsHide:true,shell:false,timeout:20000,maxBuffer:256*1024,env:helper.environment(process.env)});
     const receipt=JSON.parse(stdout);if(receipt.ok!==true||receipt.result?.deleted!==true)throw Error('Temporary profile deletion unconfirmed.');report.cleanup.push({id:created.id,closed:true,deleted:true});save();
    }
    if(accountId&&owner)await core.releaseSession(db.pool,accountId,owner,{status:'offline',runtimeVersion:'SESSION_V2'});
   }
  }
  report.accountsUnchanged=JSON.stringify(beforeAccounts)===JSON.stringify(await accounts());
  report.originalRosterRestored=JSON.stringify(beforeProfiles)===JSON.stringify((await api.list()).profiles.map(p=>p.id).sort());save();
  if(!report.accountsUnchanged||!report.originalRosterRestored||report.runs.length!==4||report.runs.some(r=>r.error))throw Error('Comparison incomplete or account/roster state changed; review saved evidence.');
  report.databaseReportId=await persistReport(production,report);save();
  console.log(JSON.stringify({report:file,runs:report.runs.length,accountsUnchanged:true,originalRosterRestored:true}));
 }finally{await api?.idle();await db?.close();await production.end();}
}
if(require.main===module)main().catch(error=>{console.error(error.code||error.name,error.failure?.reason||error.message);process.exitCode=1;});
module.exports={main,persistReport};
