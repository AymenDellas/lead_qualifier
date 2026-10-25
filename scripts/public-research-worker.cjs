'use strict';

const fs=require('node:fs'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const {Pool}=require('pg');
const core=require('../src/lib/linkedin-workers.cjs');
const queue=require('../src/lib/worker-research-queue.cjs');
const {createResearchRunner}=require('../src/lib/worker-research-runner.cjs');

async function main(){
 const root=path.resolve(__dirname,'..');
 require('@next/env').loadEnvConfig(root);
 const data=path.join(root,'data'),lock=path.join(data,'public-research-worker.pid');
 const owner=randomUUID();
 fs.mkdirSync(data,{recursive:true});
 const alive=pid=>{if(!Number.isInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch{return false;}};
 const readLock=()=>{try{return JSON.parse(fs.readFileSync(lock,'utf8'));}catch{return null;}};
 let locked=false,pool,runner,timer,stopping=false,active=null,wake=null;
 const unlock=()=>{if(locked&&readLock()?.owner===owner)try{fs.unlinkSync(lock);}catch{}};
 process.once('exit',unlock);
 try{
  for(let attempt=0;attempt<2&&!locked;attempt++){
   try{fs.writeFileSync(lock,JSON.stringify({pid:process.pid,owner}),{flag:'wx'});locked=true;}
   catch(error){
    if(error.code!=='EEXIST')throw error;
    const existing=readLock();
    if(alive(existing?.pid)||!existing&&Date.now()-fs.statSync(lock).mtimeMs<5000)throw new Error('Public research is already running or starting.');
    fs.unlinkSync(lock);
   }
  }
  if(!locked)throw new Error('Could not acquire the public research worker lock.');
  pool=new Pool({connectionString:process.env.DATABASE_URL,max:3,connectionTimeoutMillis:10000,query_timeout:15000,
   ssl:process.env.DATABASE_CA_CERT?{ca:process.env.DATABASE_CA_CERT.replace(/\\n/g,'\n'),rejectUnauthorized:true}:{rejectUnauthorized:false}});
  await core.ensure(pool);await queue.ensure(pool);
  runner=createResearchRunner({pool,owner,log:message=>console.log('[Public research]',message)});
  const runtime=status=>pool.query(`INSERT INTO compel_research_runtime(owner,pid,status,seen_at,lease_until)
   VALUES($1,$2,$3,NOW(),NOW()+interval '45 seconds') ON CONFLICT(owner) DO UPDATE
   SET status=$3,seen_at=NOW(),lease_until=NOW()+interval '45 seconds'`,[owner,process.pid,status]);
  const stop=()=>{stopping=true;wake?.();};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  const onMessage=message=>{if(message?.type==='stop')stop();};process.on('message',onMessage);
  let beating=false;
  timer=setInterval(async()=>{
   if(beating)return;beating=true;
   try{await queue.heartbeat(pool,owner);await runtime(active?'processing':'idle');}
   catch(error){console.error('[Public research] Heartbeat failed:',error.message);stop();}
   finally{beating=false;}
  },10000);
  await runtime('idle');
  console.log('[Public research] Reading saved profiles and public websites independently of account processing.');
  while(!stopping){
   let outcome;
   try{
    active=runner.runOnce();outcome=await active;
   }catch(error){console.error('[Public research] Job retained:',error.message);await queue.release(pool,owner).catch(()=>{});}
   finally{active=null;}
   if(!outcome&&!stopping)await new Promise(resolve=>{
    const delay=setTimeout(()=>{wake=null;resolve();},2000);
    wake=()=>{clearTimeout(delay);wake=null;resolve();};
   });
  }
  process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
  process.removeListener('message',onMessage);
 }finally{
  stopping=true;clearInterval(timer);
  if(active)await active.catch(()=>{});
  if(runner)await runner.close().catch(error=>console.error('[Public research] Browser cleanup:',error.message));
  if(pool){
   await queue.release(pool,owner).catch(()=>{});
   await pool.query("UPDATE compel_research_runtime SET status='offline',lease_until=NOW(),seen_at=NOW() WHERE owner=$1",[owner]).catch(()=>{});
   await pool.end();
  }
  unlock();
  if(process.connected)process.disconnect();
 }
}
if(require.main===module)main().catch(error=>{console.error('[Public research]',error.message);process.exitCode=1;});
module.exports={main};
