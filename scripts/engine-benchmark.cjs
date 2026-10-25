'use strict';
// Explicit, bounded live measurement. Never clears holds, signs in, or bypasses
// queue ownership and existing limits. The batch manifest lives in PostgreSQL.
const fs=require('node:fs'),path=require('node:path');
const core=require('../src/lib/linkedin-workers.cjs'),telemetry=require('../src/lib/engine-telemetry.cjs');
const {createSampler}=require('../src/lib/engine-process-metrics.cjs');
const BATCH_SCHEMA=`CREATE TABLE IF NOT EXISTS compel_engine_batches (
 id TEXT PRIMARY KEY,account_id TEXT NOT NULL,profiles TEXT[] NOT NULL,job_ids TEXT[] NOT NULL DEFAULT '{}',
 state TEXT NOT NULL DEFAULT 'PREPARED',requested_count INTEGER NOT NULL DEFAULT 30,
 started_at TIMESTAMPTZ,finished_at TIMESTAMPTZ,report JSONB);`;
const AFTER_SCHEMA='ALTER TABLE compel_engine_batches ADD COLUMN IF NOT EXISTS source_batch TEXT';
async function prepareAfter(pool,id,source='baseline-unthrottled'){
 await pool.query(BATCH_SCHEMA);await pool.query(AFTER_SCHEMA);
 const previous=(await pool.query('SELECT * FROM compel_engine_batches WHERE id=$1',[source])).rows[0];
 if(previous?.state!=='COMPLETE'||previous.profiles.length!==30)throw Error('A completed 30-profile baseline is required.');
 return (await pool.query(`INSERT INTO compel_engine_batches(id,account_id,profiles,source_batch) VALUES($1,$2,$3,$4)
  ON CONFLICT(id) DO UPDATE SET id=EXCLUDED.id RETURNING *`,[id,previous.account_id,previous.profiles,source])).rows[0];
}
function poolForRoot(root){
 require('@next/env').loadEnvConfig(root);const {Pool}=require('pg');
 return new Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:10000,query_timeout:45000,
  ssl:process.env.DATABASE_CA_CERT?{ca:process.env.DATABASE_CA_CERT.replace(/\\n/g,'\n'),rejectUnauthorized:true}:{rejectUnauthorized:false}});
}
async function prepare(pool,id){
 await core.ensure(pool);await telemetry.ensure(pool);await pool.query(BATCH_SCHEMA);
 const existing=(await pool.query('SELECT * FROM compel_engine_batches WHERE id=$1',[id])).rows[0];if(existing)return existing;
 const account=(await pool.query(`SELECT id FROM compel_linkedin_accounts WHERE enabled AND NOT archived AND attention_reason=''
  AND connected_at IS NOT NULL AND signed_out_at IS NULL ORDER BY position,id LIMIT 1`)).rows[0];
 if(!account)throw Error('No enabled, connected account without a review hold. Complete manual sign-in first.');
 const candidates=(await core.queueCandidates(pool)).slice(0,30);if(candidates.length!==30)throw Error('Need 30 eligible CRM Inbox profiles; found '+candidates.length+'.');
 return (await pool.query('INSERT INTO compel_engine_batches(id,account_id,profiles) VALUES($1,$2,$3) RETURNING *',
  [id,account.id,candidates.map(row=>row.linkedin_url)])).rows[0];
}
async function report(pool,batch,samples=[],stopReason=null){
 const jobs=(await pool.query(`SELECT id,status,lane,retry_count,result->>'status' AS outcome,
  result->'failure' AS failure FROM compel_worker_jobs WHERE id=ANY($1::text[]) ORDER BY queue_order`,[batch.job_ids])).rows;
 const metrics=await telemetry.readMetrics(pool,{batchId:batch.id});
 return {batchId:batch.id,requested:30,prepared:batch.profiles.length,jobCount:jobs.length,jobs,metrics,stopReason,
  resources:{samples,peakTreeRssMB:samples.length?Math.max(...samples.map(s=>s.treeRssMB)):null,
   peakCpuPercent:samples.some(s=>s.cpuPercent!=null)?Math.max(...samples.map(s=>s.cpuPercent||0)):null,
   sampleOverheadMs:samples.reduce((sum,s)=>sum+s.sampleMs,0)},
  comparable:jobs.length===30&&jobs.every(job=>job.status==='done')&&metrics.decided===30,
  generatedAt:new Date().toISOString()};
}
async function run(pool,batch,root){
 if(batch.state==='COMPLETE'||batch.state==='BLOCKED')throw Error('This run is already recorded; use report or a new batch identifier.');
 const unrelated=(await pool.query(`SELECT count(*)::int AS n FROM compel_worker_jobs WHERE status IN ('pending','processing')
  AND payload->>'engineBatchId' IS DISTINCT FROM $1`,[batch.id])).rows[0].n;
 if(unrelated)throw Error('There are '+unrelated+' unrelated active jobs. Finish them before the isolated 30-lead baseline.');
 if(!batch.job_ids.length){
  await core.enqueue(pool,batch.profiles,{engineBatchId:batch.id,explicitRetry:!!batch.source_batch});
  batch.job_ids=(await pool.query("SELECT id FROM compel_worker_jobs WHERE payload->>'engineBatchId'=$1 ORDER BY queue_order",[batch.id])).rows.map(row=>row.id);
  await pool.query("UPDATE compel_engine_batches SET job_ids=$2,state='RUNNING',started_at=NOW() WHERE id=$1",[batch.id,batch.job_ids]);
 }
 let stopReason=null,samples=[],sample,lastSample=0,lastState='',stopping=false;
 try{const pid=JSON.parse(fs.readFileSync(path.join(root,'data/worker-supervisor.pid'),'utf8')).pid;sample=createSampler({pid});}catch{/* Report missing measurements, never substitute Node RSS. */}
 try{await core.startProcessing(pool,batch.account_id);}catch(error){stopReason={stage:'START_REQUEST',reason:error.message};}
 const stop=()=>{stopping=true;};process.once('SIGINT',stop);process.once('SIGTERM',stop);
 const deadline=Date.now()+20*60000;
 try{
  while(!stopReason&&!stopping&&Date.now()<deadline){
   const counts=(await pool.query("SELECT status,count(*)::int AS n FROM compel_worker_jobs WHERE id=ANY($1::text[]) GROUP BY status",[batch.job_ids])).rows;
   const account=await core.readRuntimeAccount(pool,batch.account_id);
   const session=(await pool.query('SELECT status,lease_until>NOW() AS online FROM compel_worker_sessions WHERE account_id=$1',[batch.account_id])).rows[0];
   const state=JSON.stringify({counts,status:session?.status?.status,reason:session?.status?.reason});
   if(state!==lastState){console.log(state);lastState=state;}
   if(sample&&Date.now()-lastSample>=15000){lastSample=Date.now();try{samples.push({...await sample(),at:new Date().toISOString()});}catch(error){console.log('Process-tree measurement unavailable: '+error.message);}}
   if(counts.reduce((sum,row)=>sum+(row.status==='done'?row.n:0),0)===30)break;
   if(account?.attention_reason)stopReason={stage:'ACCOUNT_REVIEW',reason:account.attention_reason};
   else if(!account?.authorized)stopReason={stage:session?.status?.reasonCode||'PROCESSING_STOPPED',reason:session?.status?.reason||'Account processing stopped.'};
   if(!stopReason)await new Promise(resolve=>setTimeout(resolve,5000));
  }
  if(!stopReason&&(stopping||Date.now()>=deadline))stopReason={stage:'MEASUREMENT_BOUND',reason:stopping?'Measurement interrupted; saved jobs retained.':'20-minute measurement bound reached; saved jobs retained.'};
 }finally{
  process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
  await core.pauseProcessing(pool,batch.account_id,'Bounded baseline capture stopped; saved research can finish.');
 }
 const output=await report(pool,batch,samples,stopReason);
 await pool.query('UPDATE compel_engine_batches SET state=$2,finished_at=NOW(),report=$3::jsonb WHERE id=$1',
  [batch.id,output.comparable?'COMPLETE':'BLOCKED',core.json(output)]);
 const directory=path.join(root,'data/engine-v2');fs.mkdirSync(directory,{recursive:true});
 fs.writeFileSync(path.join(directory,batch.id+'-report.json'),JSON.stringify(output,null,2));
 return output;
}
async function main(){
 const [command='report',id='baseline']=process.argv.slice(2);if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id))throw Error('Invalid batch identifier.');
 const root=path.resolve(__dirname,'..'),pool=poolForRoot(root);
 try{const batch=command==='prepare-after'?await prepareAfter(pool,id):command==='prepare'||command==='run'?await prepare(pool,id):(await pool.query('SELECT * FROM compel_engine_batches WHERE id=$1',[id])).rows[0];
  if(!batch)throw Error('Prepare this batch first.');
  const result=command.startsWith('prepare')?{batchId:batch.id,accountId:batch.account_id,profiles:batch.profiles.length,state:batch.state}
   :command==='run'?await run(pool,batch,root):batch.report||await report(pool,batch);
  console.log(JSON.stringify(result,null,2));
 }finally{await pool.end();}
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={BATCH_SCHEMA,prepare,report,poolForRoot};
