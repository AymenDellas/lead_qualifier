'use strict';
const assert=require('node:assert/strict'),{test}=require('node:test'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),ts=require('typescript');
const core=require('../../src/lib/linkedin-workers.cjs');
function load(relative,dependencies){
 const module={exports:{}};
 const source=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../..',relative),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText;
 vm.runInNewContext(source,{module,exports:module.exports,Date,console,require:name=>dependencies[name]||require(name)});
 return module.exports;
}
function statusRoute(heartbeat,failDatabase=false,routeName='process-lead',cachedLead){
 const fakePool={query:async sql=>{
  if(failDatabase)throw new Error('Database unavailable');
  if(sql.includes('FROM pg_attribute'))return{rows:[{migrated:true}]};
  if(sql.startsWith('\nCREATE TABLE'))return{rows:[]};
  if(sql.includes('SELECT * FROM compel_worker_config'))return{rows:[{active_count:1,revision:0}]};
  if(sql.includes('FROM compel_linkedin_accounts a'))return{rows:[{id:'legacy-0',label:'First',email:'fixture@example.test',enabled:true,daily_limit:400,has_password:true,daily_count:276,status:heartbeat,lease_until:heartbeat?.status==='offline'?'2024-01-01':new Date(Date.now()+120000).toISOString()}]};
  if(sql.includes('AS pending'))return{rows:[{pending:1}]};
  if(sql.includes('AS total'))return{rows:[{total:276}]};
  if(sql.includes('SELECT id,result'))return{rows:cachedLead?[{id:'job_saved',result:cachedLead,completed_at:new Date()}]:[]};
  if(sql.includes('FROM leads'))return{rows:[{qualified:9,rejected:258}]};
  if(sql.includes('AS qualified'))return{rows:[{qualified:0,rejected:0}]};
  throw new Error('Unexpected fixture query');
 }};
 const route=load(`src/app/api/${routeName}/route.ts`,{
  'next/server':{NextResponse:{json:value=>value}},
  '@/lib/pg_setup':{pool:fakePool},'@/lib/worker-admin':{requireWorkerAdmin:async()=>{}},
  '@/lib/linkedin-workers.cjs':core
 });
 return()=>route.GET({nextUrl:new URL('http://localhost/api/process-lead')});
}
test('saved CRM qualification counts and account usage survive offline heartbeats',async()=>{
 for(const routeName of ['process-lead','queue-status'])for(const heartbeat of [null,{status:'offline'},{status:'ready',dailyQualified:0}]){
  const result=await statusRoute(heartbeat,false,routeName)();
  const worker=result.worker||result.workerStatus;
  assert.equal(worker.dailyQualified,9);assert.equal(worker.dailyRejected,258);
  assert.equal(worker.dailyCount,276);assert.equal(worker.dailyLimit,400);
  assert.equal(result.queueSize,1);
 }
});
test('a database failure is surfaced instead of replacing saved counts with false zeroes',async()=>{
 for(const routeName of ['process-lead','queue-status'])await assert.rejects(statusRoute({status:'ready'},true,routeName)(),/Database unavailable/);
});
test('cached engine history cannot qualify a coach without an email, and is not mutated',async()=>{
 const {research}=require('./fixtures.cjs'),q=require('../../src/lib/prospect-qualification.cjs');
 const cached={status:'QUALIFIED',emails:[],prospectQualification:q.assessProspect(research())};
 const result=await statusRoute(null,false,'queue-status',cached)();
 assert.equal(result.recentResults[0].result.status,'REJECTED');assert.equal(cached.status,'QUALIFIED');
 cached.primaryEmail='ava@avamorgan.test';
 assert.equal((await statusRoute(null,false,'queue-status',cached)()).recentResults[0].result.status,'QUALIFIED');
});
test('the existing daily CRM counter still caches bounded requests',async()=>{
 let queries=0;
 const counts=load('src/lib/worker-daily-counts.ts',{'./pg_setup':{pool:{query:async()=>{queries++;return{rows:[{qualified:9,rejected:258}]};}}}});
 assert.equal((await counts.savedDailyWorkerCounts()).dailyQualified,9);
 assert.equal((await counts.savedDailyWorkerCounts()).dailyRejected,258);assert.equal(queries,1);
});
