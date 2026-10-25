'use strict';
const fs=require('node:fs'),path=require('node:path'),{fork}=require('node:child_process');
const {Pool}=require('pg');
const core=require('../src/lib/linkedin-workers.cjs');
const {createAccountSupervisor}=require('../src/lib/account-supervisor.cjs');
const {acquireProcessLock}=require('../src/lib/worker-process-lock.cjs');

async function stopChild(child) {
 if(child.exitCode!==null||child.signalCode!==null)return;
 await new Promise(resolve=>{
  let done=false;
  const finish=()=>{if(done)return;done=true;clearTimeout(timer);child.removeListener('exit',finish);resolve();};
  const timer=setTimeout(()=>{try{child.kill('SIGKILL');}catch{}finish();},20000);
  child.once('exit',finish);
  if(child.connected)child.send({type:'stop'},error=>{if(error)try{child.kill('SIGTERM');}catch{}});
  else try{child.kill('SIGTERM');}catch{finish();}
 });
}
async function main() {
 const root=path.resolve(__dirname,'..');require('@next/env').loadEnvConfig(root);
 const data=path.join(root,'data'),lock=path.join(data,'worker-supervisor.pid');
 await require('../src/lib/worker-process-identity.cjs').clearUnownedProcessLock(lock,__filename);
 const unlock=acquireProcessLock(lock);
 const pool=new Pool({connectionString:process.env.DATABASE_URL,max:3,connectionTimeoutMillis:10000,query_timeout:15000,
  ssl:process.env.DATABASE_CA_CERT?{ca:process.env.DATABASE_CA_CERT.replace(/\\n/g,'\n'),rejectUnauthorized:true}:{rejectUnauthorized:false}});
 let stopping=false,research=null,supervisor=null,wake=null;
 const stop=()=>{stopping=true;wake?.();};
 process.once('SIGINT',stop);process.once('SIGTERM',stop);process.once('exit',unlock);
 const onMessage=message=>{if(message?.type==='stop')stop();};process.on('message',onMessage);
 try {
  const legacy=path.join(data,'worker.pid');
  // An old PID marker can now belong to an unrelated Windows process. Verify
  // the fixed worker script before treating it as a running legacy worker.
  await require('../src/lib/worker-process-identity.cjs').clearUnownedProcessLock(legacy,path.join(root,'worker.cjs'));
  if(fs.existsSync(legacy)) {
   const previous=JSON.parse(fs.readFileSync(legacy,'utf8')).pid;
   if(Number.isInteger(previous)){let alive=false;try{process.kill(previous,0);alive=true;}catch{}if(alive)throw Error('Stop the older single worker first. Pending work is retained.');}
  }
  let usage;try{usage=JSON.parse(fs.readFileSync(path.join(data,'worker-limits.json'),'utf8'));}catch{}
  await core.importAccounts(pool,JSON.parse(process.env.LINKEDIN_ACCOUNTS||'[]'),usage);
  await core.resetProcessing(pool);
  await require('../src/lib/worker-legacy-import.cjs').importLegacyFiles(pool,root,{core,log:message=>console.log('[Workers]',message)});
  supervisor=createAccountSupervisor({root,pool,core,fork,stopChild,log:message=>console.log('[Workers]',message)});
  if(process.env.WORKER_DISABLE_RESEARCH!=='1') {
   research=fork(path.join(root,'scripts/public-research-worker.cjs'),[],{cwd:root,windowsHide:true,stdio:['ignore','inherit','inherit','ipc']});
   research.once('error',error=>console.error('[Public research]',error.message));
   research.once('exit',()=>console.log('[Public research] Stopped. Restart the local worker service to recover.'));
  }
  console.log('[Workers] Ready. Connect once; Start and Pause reuse the same account browser.');
  while(!stopping) {
   if(fs.existsSync(path.join(data,'worker-supervisor.stop'))){fs.unlinkSync(path.join(data,'worker-supervisor.stop'));break;}
   try{await supervisor.tick();}catch(error){console.error('[Workers] Status update failed:',error.message);}
   if(!stopping)await new Promise(resolve=>{const timer=setTimeout(()=>{wake=null;resolve();},2000);wake=()=>{clearTimeout(timer);wake=null;resolve();};});
  }
 }finally{
  stopping=true;wake?.();
  await supervisor?.close();if(research)await stopChild(research);
  await pool.query('UPDATE compel_worker_config SET supervisor_seen_at=NULL WHERE id=1').catch(()=>{});
  await pool.end();unlock();process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
  process.removeListener('message',onMessage);if(process.connected)process.disconnect();
 }
}
if(require.main===module)main().catch(error=>{console.error('[Workers]',error.message);process.exitCode=1;});
module.exports={main,stopChild};
