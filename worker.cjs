'use strict';

// Thin account-session host. Website research has its own process and never
// borrows this browser, cookies, lease or LinkedIn processing authorization.
const path=require('node:path'),fs=require('node:fs'),{randomUUID}=require('node:crypto');
const {Pool}=require('pg');
const core=require('./src/lib/linkedin-workers.cjs');
const {createAccountRuntime}=require('./src/lib/account-runtime.cjs');
const {createAccountBrowser}=require('./src/lib/account-browser.cjs');
const {acquireProcessLock}=require('./src/lib/worker-process-lock.cjs');

async function main() {
 const root=__dirname;
 require('@next/env').loadEnvConfig(root);
 const index=process.argv.indexOf('--account'),id=index>=0?process.argv[index+1]:null;
 if(!/^(?:legacy-\d+|[a-f0-9-]{36})$/.test(id||''))throw Error('Use npm run worker, then Connect and Start batch in Engine.');
 const data=path.join(root,'data'),owner=randomUUID();
 const lock=path.join(data,`worker-${id}.pid`);
 await require('./src/lib/worker-process-identity.cjs').clearUnownedProcessLock(lock,__filename);
 const unlock=acquireProcessLock(lock);
 const pool=new Pool({connectionString:process.env.DATABASE_URL,max:3,connectionTimeoutMillis:10000,query_timeout:15000,
  ssl:process.env.DATABASE_CA_CERT?{ca:process.env.DATABASE_CA_CERT.replace(/\\n/g,'\n'),rejectUnauthorized:true}:{rejectUnauthorized:false}});
 let runtime,browserOwner,timer,stopping=false,active=null,wake=null,leased=false;
 const log=message=>console.log(`[Account ${id.slice(0,8)}] ${new Date().toISOString()} ${message}`);
 const stop=()=>{stopping=true;wake?.();void runtime?.close().catch(error=>log('Session close: '+error.message));};
 process.once('SIGINT',stop);process.once('SIGTERM',stop);
 const onMessage=message=>{if(message?.type==='stop')stop();};process.on('message',onMessage);
 process.once('exit',unlock);
 try {
  await core.ensure(pool);
  const account=await core.readRuntimeAccount(pool,id);
  if(!account)throw Error('This saved account no longer exists.');
  if(!await core.acquireSession(pool,id,owner))throw Error('Another worker already owns this account.');
  leased=true;
  const localState=process.env.LOCALAPPDATA||process.env.XDG_STATE_HOME||path.join(require('node:os').homedir(),'.local','state');
  browserOwner=createAccountBrowser({root,account,profileRoot:process.env.WORKER_PROFILE_ROOT||path.join(localState,'Compel','worker-profiles'),
   onDisconnect:error=>runtime?.disconnected(error)});
  runtime=createAccountRuntime({pool,accountId:id,owner,browserOwner,log,onStatus:status=>{
   try{fs.writeFileSync(path.join(root,'queue-results',`worker-status-${id}.json`),core.json(status));}catch{/* Database heartbeat is authoritative. */}
  }});
  let beating=false;
  timer=setInterval(async()=>{
   if(beating||stopping)return;beating=true;
   try{await core.heartbeat(pool,id,owner,runtime.snapshot());}
   catch(error){log('Lease lost; stopping this session: '+error.message);stop();}
   finally{beating=false;}
  },10000);
  await core.heartbeat(pool,id,owner,runtime.snapshot());
  log('Session host ready. Browsers open only for explicit account actions.');
  while(!stopping) {
   try{active=runtime.tick();await active;await core.heartbeat(pool,id,owner,runtime.snapshot());}
   catch(error){log('Session action stopped: '+error.message);await core.pauseProcessing(pool,id,'Session action stopped: '+error.message,false,owner).catch(()=>{});}
   finally{active=null;}
   if(!stopping)await new Promise(resolve=>{
    const timeout=setTimeout(()=>{wake=null;resolve();},1500);
    wake=()=>{clearTimeout(timeout);wake=null;resolve();};
   });
  }
 } finally {
  stopping=true;clearInterval(timer);wake?.();
  if(runtime)await runtime.close().catch(error=>log('Browser close requires review: '+error.message));
  else if(browserOwner)await browserOwner.close().catch(()=>{});
  if(active)await active.catch(()=>{});
  if(leased)await core.releaseSession(pool,id,owner,runtime?.snapshot()||{status:'offline',runtimeVersion:'SESSION_V2'}).catch(()=>{});
  await pool.end();unlock();
  process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
  process.removeListener('message',onMessage);if(process.connected)process.disconnect();
 }
}
if(require.main===module)main().catch(error=>{console.error('[Account session]',error.message);process.exitCode=1;});
module.exports={main};
