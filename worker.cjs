'use strict';
// Single local agent; PostgreSQL owns every job, checkpoint and account command.
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const core=require('./src/lib/linkedin-workers.cjs'),registry=require('./src/lib/agent-registry.cjs');
const telemetry=require('./src/lib/engine-telemetry.cjs');
const {acquireProcessLock}=require('./src/lib/worker-process-lock.cjs');
const {clearUnownedProcessLock}=require('./src/lib/worker-process-identity.cjs');
function safeMessage(error){return String(error?.message||error).replace(/postgres(?:ql)?:\/\/\S+/gi,'[database connection]').slice(0,1200);}
async function main(){
 if(process.env.VERCEL)throw Error('The agent runs only on the local worker computer.');
 const root=__dirname;require('@next/env').loadEnvConfig(root);
 const {Pool}=require('pg'),pool=new Pool({connectionString:process.env.DATABASE_URL,max:5,connectionTimeoutMillis:10000,query_timeout:15000,
  ssl:process.env.DATABASE_CA_CERT?{ca:process.env.DATABASE_CA_CERT.replace(/\\n/g,'\n'),rejectUnauthorized:true}:{rejectUnauthorized:false}});
 if(process.argv.includes('--stop')){try{await pool.query('UPDATE compel_worker_config SET agent_stop_requested=TRUE WHERE id=1');await pool.query("SELECT pg_notify('compel_engine_wake','')");console.log('[Agent] Stop requested. Intent and checkpoints retained.');}finally{await pool.end();}return;}
 if(process.argv.length>2){await pool.end();throw Error('Use npm run worker; accounts are controlled through PostgreSQL and the dashboard.');}
 const data=path.join(root,'data'),lock=path.join(data,'worker-supervisor.pid'),launch=path.join(data,'worker-supervisor-start.json');
 fs.mkdirSync(data,{recursive:true});const owner=randomUUID();let unlock=null,agent=null,stopMetrics=null,listener=null,leased=false,stopping=false,failed=null;
 const log=message=>console.log('[Agent] '+new Date().toISOString()+' '+message);
 function stage(value,reason='',action=''){
  log(value+(reason?': '+reason:''));let marker={};try{marker=JSON.parse(fs.readFileSync(launch,'utf8'));}catch{}
  let other=null;try{other=JSON.parse(fs.readFileSync(lock,'utf8'));}catch{}
  if(other?.pid&&other.pid!==process.pid){try{process.kill(other.pid,0);return;}catch{}}
  fs.writeFileSync(launch,JSON.stringify({...marker,pid:process.pid,stage:value,reason,action,updatedAt:Date.now(),startedAt:marker.startedAt||Date.now()}));
 }
 const stop=()=>{stopping=true;agent?.stop();};process.once('SIGINT',stop);process.once('SIGTERM',stop);
 const queryStats=telemetry.observePool(pool);
 pool.on('error',error=>{failed=error;stage('FAILED',safeMessage(error),'Check PostgreSQL, then restart the agent.');stop();});
 try{
  const scripts=[__filename,path.join(root,'scripts/linkedin-worker-supervisor.cjs')];
  for(;;){
   const recovery=await clearUnownedProcessLock(lock,scripts,{staleMs:15000});
   if(recovery?.waitMs){stage('AGENT_ACK','Confirmed stale owner; waiting for its heartbeat to expire.');await new Promise(resolve=>setTimeout(resolve,Math.min(recovery.waitMs,1000)));if(stopping)return;continue;}
   try{unlock=acquireProcessLock(lock,{heartbeat:true,staleMs:15000});break;}
   catch(error){if(error.code!=='OWNER_HEARTBEAT_PENDING')throw error;stage('AGENT_ACK',error.message,'Waiting for the dead owner heartbeat.');await new Promise(resolve=>setTimeout(resolve,1000));if(stopping)return;}
  }
  process.once('exit',unlock);stage('AGENT_ACK','Process acknowledged; connecting to PostgreSQL.');
  require('./src/lib/follower-policy.cjs').minFollowers();
  await core.ensure(pool);await pool.query(registry.SCHEMA);await telemetry.ensure(pool);
  await require('./src/lib/engine-daily-policy.cjs').configure(pool);
  await require('./src/lib/worker-research-store.cjs').ensure(pool);
  for(;;){const result=await registry.claim(pool,owner);if(!result.waitMs){leased=true;break;}stage('AGENT_ACK',result.reason,'Waiting for the dead database owner heartbeat.');await new Promise(resolve=>setTimeout(resolve,Math.min(result.waitMs,2000)));if(stopping)return;}
  await registry.recover(pool,owner);await require('./src/lib/worker-research-queue.cjs').ensure(pool);
  agent=require('./src/lib/compel-agent.cjs').createAgent({root,pool,owner,log});
  await agent.heartbeat();agent.start();
  stopMetrics=require('./src/lib/engine-process-metrics.cjs').startResourceMonitor({pool,owner,queryStats,log,onSample:sample=>agent.setResources(sample)});
  try{listener=await pool.connect();listener.on('notification',()=>agent.wake());listener.on('error',error=>log('Notifications unavailable; idle backoff active: '+safeMessage(error)));await listener.query('LISTEN compel_engine_wake');}
  catch(error){listener?.release(true);listener=null;log('Using 2–30 second idle backoff: '+safeMessage(error));}
  stage('AGENT_ACK','Ready. Saved intent resumes; explicit pauses and account review holds remain in force.');
  while(!stopping&&!agent.stopped){await agent.step();await agent.wait();}
  if(agent.failure)throw agent.failure;
 }catch(error){failed=error;stage('FAILED',safeMessage(error),'Check PostgreSQL and Chrome/profile ownership, then Start again.');throw error;}
 finally{
  stopping=true;await agent?.close().catch(error=>log('Shutdown: '+safeMessage(error)));
  await stopMetrics?.();listener?.release(true);
  if(leased)await registry.release(pool,owner,{stage:failed?'FAILED':'OFFLINE',reason:failed?safeMessage(failed):'Agent stopped. Intent and checkpoints retained.'}).catch(()=>{});
  if(!failed)stage('OFFLINE','Stopped. Intent and checkpoints retained.');
  await pool.end();unlock?.();process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
 }
}
if(require.main===module)main().catch(error=>{console.error('[Agent]',safeMessage(error));process.exitCode=1;});
module.exports={main,safeMessage};
