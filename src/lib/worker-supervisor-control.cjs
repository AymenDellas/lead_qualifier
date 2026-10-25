'use strict';
const fsDefault=require('node:fs');
const path=require('node:path');
const {spawn:spawnDefault}=require('node:child_process');
const {randomUUID}=require('node:crypto');

/** The fixed compatibility entry point starts one agent; no account children. */
function createWorkerSupervisorController(options) {
 const root=options.root||process.cwd(),fs=options.fs||fsDefault,proc=options.process||process;
 const spawn=options.spawn||spawnDefault,now=options.now||Date.now;
 const isProcessOwner=options.isProcessOwner||require('./worker-process-identity.cjs').isProcessOwner;
 const script=path.join(root,'scripts','linkedin-worker-supervisor.cjs');
 const data=path.join(root,'data'),pidFile=path.join(data,'worker-supervisor.pid');
 const startFile=path.join(data,'worker-supervisor-start.json'),logFile=path.join(data,'worker-supervisor-console.log');
 let inFlight=null;
 const alive=pid=>{if(!Number.isInteger(pid)||pid<=0)return false;try{proc.kill(pid,0);return true;}catch{return false;}};
 const read=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}};
 const available=()=>!proc.env.VERCEL&&proc.env.WORKER_LAUNCH_DISABLED!=='1'&&fs.existsSync(script);
 const result=(state,canStart,message)=>({state,canStart,message});
 const online=()=>result('online',false,'Agent online. Saved processing intent resumes; review holds and explicit pauses remain in force.');
 function diagnostic(){const launch=read(startFile);return launch?.stage==='FAILED'?{...result('failed',!alive(launch.pid),launch.reason||'Agent startup failed.'),stage:launch.stage,failedStage:launch.failedStage||'AGENT_ACK',action:launch.action||'Check the local worker log and retry.'}:null;}
 async function localState() {
  const saved=read(pidFile),launch=read(startFile);
  if(alive(saved?.pid)&&await isProcessOwner(saved.pid,script)!==false) {
   let startedAt=0;try{startedAt=fs.statSync(pidFile).mtimeMs;}catch{}
   return {startedAt};
  }
  if(alive(launch?.pid)&&(now()-launch.startedAt<5000||await isProcessOwner(launch.pid,script)!==false))return {startedAt:launch.startedAt};
  return null;
 }
 async function status() {
  if(!available())return result('unavailable',false,'Open the local app on the worker computer to start workers.');
  try{if(await options.isOnline())return online();}catch(error){const failed=diagnostic();if(failed)return failed;throw error;}
  const failed=diagnostic();if(failed)return failed;
  const local=await localState();
  if(local)return now()-local.startedAt>90000
   ?result('unresponsive',false,'The worker process is running but has not connected. Check the worker log on this computer.')
   :{...result('starting',false,'Agent is starting. Saved pauses and review holds remain in force.'),stage:read(startFile)?.stage||'REQUEST_RECEIVED',message:read(startFile)?.reason||'Agent is starting.'};
  const launch=read(startFile);
  if(launch)return result('offline',true,'Workers stopped. Start them again or check the worker log on this computer.');
  return result('offline',true,'Workers offline. Start them here before signing in.');
 }
 function start() {
  if(inFlight)return inFlight;
  inFlight=(async()=>{
   const current=await status();
   if(!current.canStart)return current;
   fs.mkdirSync(data,{recursive:true});
   const token=randomUUID();let claimed=false,fd;
   const release=()=>{if(read(startFile)?.token===token)try{fs.unlinkSync(startFile);}catch{}};
   try {
    // This marker also serializes launches across hot reloads and server processes.
    for(let attempt=0;attempt<2&&!claimed;attempt++) {
     try {fs.writeFileSync(startFile,JSON.stringify({pid:proc.pid,startedAt:now(),token,stage:'REQUEST_RECEIVED'}),{flag:'wx'});claimed=true;}
     catch(error) {
      if(error.code!=='EEXIST')throw error;
      const existing=read(startFile);
      if(alive(existing?.pid)&&now()-existing.startedAt<5000)return status();
      if(alive(existing?.pid)&&await isProcessOwner(existing.pid,script)!==false)return status();
      // A writer can be between creating and filling the file. Never remove a
      // fresh, incomplete marker from another request.
      if(!existing&&now()-fs.statSync(startFile).mtimeMs<5000)return result('starting',false,'A worker start is already in progress.');
      if(JSON.stringify(read(startFile))!==JSON.stringify(existing))return result('starting',false,'A worker start is already in progress.');
      try{fs.unlinkSync(startFile);}catch(error){if(error.code!=='ENOENT')throw error;}
     }
    }
    if(!claimed)throw new Error('A worker start is already in progress.');
    // A supervisor on another computer may have appeared while acquiring the marker.
    if(await options.isOnline()){release();return online();}
    const previous=read(pidFile);
    if(alive(previous?.pid)){
     if(await isProcessOwner(previous.pid,script)!==false){release();return status();}
     if(JSON.stringify(read(pidFile))===JSON.stringify(previous))fs.unlinkSync(pidFile);
    }
    fd=fs.openSync(logFile,'a');
    const child=spawn(proc.execPath,[script],{cwd:root,detached:true,windowsHide:true,
     stdio:['ignore',fd,fd],env:{...proc.env}});
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
    fs.writeFileSync(startFile,JSON.stringify({pid:child.pid,startedAt:now(),token,stage:'REQUEST_RECEIVED'}));
    child.unref();
    return result('starting',false,'Workers are starting. Account processing remains paused.');
   } catch(error) {
    release();
    throw new Error(error.code==='EACCES'||error.code==='EPERM'
     ?'This app does not have permission to start the local workers.'
     :'Could not start workers. Check the local worker log and try again.');
   } finally {if(fd!==undefined)fs.closeSync(fd);}
  })().finally(()=>{inFlight=null;});
  return inFlight;
 }
 return {status,start};
}
module.exports={createWorkerSupervisorController};
