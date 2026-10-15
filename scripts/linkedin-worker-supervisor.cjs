'use strict';
const fs=require('node:fs'),path=require('node:path'),{fork,execFileSync}=require('node:child_process');
const {Pool}=require('pg');
const core=require('../src/lib/linkedin-workers.cjs');
const root=path.resolve(__dirname,'..');
for (const line of fs.readFileSync(path.join(root,'.env.local'),'utf8').split('\n')) {
 const match=line.replace(/\r/g,'').match(/^([^#=]+)=(.+)$/);
 if(match)process.env[match[1].trim()]=match[2].trim().replace(/^(['"])([\s\S]*)\1$/,'$2');
}
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:3,connectionTimeoutMillis:10000,
 ssl:process.env.DATABASE_CA_CERT?{ca:process.env.DATABASE_CA_CERT.replace(/\\n/g,'\n'),rejectUnauthorized:true}:{rejectUnauthorized:false}});
const data=path.join(root,'data');fs.mkdirSync(data,{recursive:true});
const lock=path.join(data,'worker-supervisor.pid');
let stopping=false,timer=null,busy=false;
const children=new Map();
function alive(pid){try{process.kill(pid,0);return true;}catch{return false;}}
function acquireLock(){
 for(let attempt=0;attempt<2;attempt++){
  try{fs.writeFileSync(lock,JSON.stringify({pid:process.pid}),{flag:'wx'});return;}
  catch(error){
   if(error.code!=='EEXIST')throw error;
   let pid;try{pid=JSON.parse(fs.readFileSync(lock,'utf8')).pid;}catch{}
   if(!Number.isInteger(pid)||alive(pid))throw new Error('An account supervisor is already running.');
   fs.unlinkSync(lock);
  }
 }
 throw new Error('Could not acquire the supervisor lock.');
}
function unlock(){try{if(JSON.parse(fs.readFileSync(lock,'utf8')).pid===process.pid)fs.unlinkSync(lock);}catch{}}
async function stop(entry){
 if(!entry?.child)return;
 const child=entry.child;
 if(!child.connected)return;
 child.send({type:'stop'});
 await new Promise(resolve=>{
  const timeout=setTimeout(()=>{try{if(process.platform==='win32')execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else child.kill('SIGKILL');}catch{}resolve();},120000);
  child.once('exit',()=>{clearTimeout(timeout);resolve();});
 });
}
async function shutdown(){
 if(stopping)return;stopping=true;clearInterval(timer);
 await Promise.allSettled([...children.values()].map(stop));
 await pool.end();unlock();process.exit(0);
}
async function importLegacyQueue(){
 const dir=path.join(root,'queue');if(!fs.existsSync(dir))return;
 for(const file of fs.readdirSync(dir).filter(name=>name.endsWith('.json'))){
  let job;try{job=JSON.parse(fs.readFileSync(path.join(dir,file),'utf8'));}catch{continue;}
  if(!/^job_[a-zA-Z0-9_-]+$/.test(job.jobId||''))continue;
  const queued=await core.enqueue(pool,[job.linkedinUrl],{...job,jobId:job.jobId});
  // Retain a recovery copy; rename only after a durable insert/deduplication.
  if(queued.jobs.length||queued.skipped[0]?.reason==='Already queued')fs.renameSync(path.join(dir,file),path.join(dir,`${file}.migrated`));
 }
}
async function importLegacyResults(){
 const dir=path.join(root,'queue-results');if(!fs.existsSync(dir))return;
 const existing=new Set((await pool.query("SELECT id FROM compel_worker_jobs WHERE status='done'")).rows.map(row=>row.id));
 for(const file of fs.readdirSync(dir).filter(name=>/^job_[a-zA-Z0-9_-]+\.json$/.test(name))){
  if(existing.has(file.slice(0,-5)))continue;
  let wrapper;try{wrapper=JSON.parse(fs.readFileSync(path.join(dir,file),'utf8'));}catch{continue;}
  if(Date.parse(wrapper.completedAt)<Date.now()-7*86400000)continue;
  try { await core.importResult(pool,file.slice(0,-5),wrapper); }
  catch(error) { console.error(`[Accounts] History import failed for ${file}: ${error.message}. Original history is retained.`); }
 }
}
async function tick(){
 if(stopping||busy)return;busy=true;
 try{
  if(fs.existsSync(path.join(data,'worker-supervisor.stop'))){fs.unlinkSync(path.join(data,'worker-supervisor.stop'));await shutdown();return;}
  await pool.query('UPDATE compel_worker_config SET supervisor_seen_at=NOW() WHERE id=1');
  await importLegacyQueue();
  const selected=await core.selectedAccounts(pool);
  // Once consumed, a sign-in request is no longer in the database. Let an
  // already running manual browser finish even when its account isn't selected.
  const manualIds=[...children].filter(([,entry])=>entry.child&&entry.manual).map(([id])=>id);
  const requested=(await pool.query('SELECT * FROM compel_linkedin_accounts WHERE (login_requested_at IS NOT NULL OR logout_requested_at IS NOT NULL OR id=ANY($1::text[])) AND archived IS FALSE ORDER BY position',[manualIds])).rows;
  const desired=new Map(selected.map(a=>[a.id,a]));
  for(const a of requested)desired.set(a.id,a);
  for(const [id,entry]of children){
   const account=desired.get(id);
   if(entry.child&&(!account||entry.version!==String(account.changed_at)||account.logout_requested_at&&!entry.logout||account.login_requested_at&&!entry.manual))await stop(entry);
  }
  for(const account of desired.values()){
   if(stopping)return;
   const version=String(account.changed_at),logout=!!account.logout_requested_at,manual=!logout&&!!account.login_requested_at;
   const entry=children.get(account.id)||{child:null,blocked:false,lastStart:0,version};
   if(entry.child)continue;
   if(!manual&&entry.blocked&&entry.version===version)continue;
   if(!manual&&Date.now()-entry.lastStart<60000&&(!logout||entry.logout&&entry.version===version))continue;
   const child=fork(path.join(root,'worker.cjs'),['--account',account.id,...(logout?['--logout']:manual?['--login','--check-login']:[])],{cwd:root,windowsHide:true,stdio:['ignore','inherit','inherit','ipc']});
   Object.assign(entry,{child,version,manual,logout,lastStart:Date.now(),blocked:false});children.set(account.id,entry);
   console.log(`[Accounts] Started ${account.label}${logout?' for sign-out':manual?' for sign-in':''}.`);
   child.once('exit',async code=>{
    entry.child=null;
    // Successful sign-in should proceed to normal work on the next settings
    // check; the crash backoff is for failures, not completed login checks.
    if(entry.manual&&code===0)entry.lastStart=0;
    if(stopping)return;
    try{
     const row=(await pool.query('SELECT status FROM compel_worker_sessions WHERE account_id=$1',[account.id])).rows[0];
     entry.blocked=row?.status?.status==='paused';
    }catch{ /* retry a disconnected database after backoff */ }
   });
  }
 }catch(error){console.error('[Accounts] Could not reconcile workers:',error.message);}finally{busy=false;}
}
async function main(){
 acquireLock();
 // Never race the legacy worker for account-0's cookie directory.
 const oldLock=path.join(data,'worker.pid');
 if(fs.existsSync(oldLock)){
  const pid=JSON.parse(fs.readFileSync(oldLock,'utf8')).pid;
  if(Number.isInteger(pid)&&alive(pid))throw new Error('Stop the legacy worker before starting account workers. Pending jobs are retained.');
 }
 let usage;try{usage=JSON.parse(fs.readFileSync(path.join(data,'worker-limits.json'),'utf8'));}catch{}
 let accounts=[];try{accounts=JSON.parse(process.env.LINKEDIN_ACCOUNTS||'[]');}catch{throw new Error('Invalid LINKEDIN_ACCOUNTS configuration.');}
 await core.importAccounts(pool,accounts,usage);
 await tick();timer=setInterval(tick,10000);
 importLegacyResults().catch(error=>console.error('[Accounts] History remains on disk:',error.message));
 console.log('[Accounts] Watching dashboard account settings. Queue and results are shared with the hosted dashboard.');
}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
process.on('message',message=>{if(message?.type==='stop')shutdown();});
process.on('exit',unlock);
main().catch(async error=>{console.error('[Accounts]',error.message);await pool.end();unlock();process.exitCode=1;});
