'use strict';
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
function acquireProcessLock(file,options={}) {
 const io=options.fs||fs,pid=options.pid||process.pid,now=options.now||Date.now;
 const alive=options.alive||(id=>{try{process.kill(id,0);return true;}catch(error){return error.code!=='ESRCH';}});
 const token=randomUUID(),read=()=>{try{return JSON.parse(io.readFileSync(file,'utf8'));}catch{return null;}};
 io.mkdirSync(path.dirname(file),{recursive:true});
 for(let attempt=0;attempt<2;attempt++) {
  try {
   const startedAt=now();io.writeFileSync(file,JSON.stringify({pid,token,startedAt,heartbeatAt:now()}),{flag:'wx'});
   const timer=options.heartbeat?setInterval(()=>{if(read()?.token===token)try{io.writeFileSync(file,JSON.stringify({pid,token,startedAt,heartbeatAt:now()}));}catch{}},5000):null;timer?.unref();
   return ()=>{clearInterval(timer);if(read()?.token===token)try{io.unlinkSync(file);}catch{}};
  }catch(error){
   if(error.code!=='EEXIST')throw error;
   const current=read();
   if(!current||!Number.isInteger(current.pid)||current.pid<=0){
    if(!current&&now()-io.statSync(file).mtimeMs<5000)throw Error('This worker is already running or starting.');
    throw Object.assign(Error('Process lock has no verifiable owner. Review the local process and its lock before retrying.'),{code:'LOCK_OWNER_UNVERIFIED'});
   }
   if(current&&!alive(current.pid)&&now()-Number(current.heartbeatAt||current.startedAt||io.statSync(file).mtimeMs)<(options.staleMs||0))throw Object.assign(Error('Previous worker is dead; waiting for its heartbeat to expire.'),{code:'OWNER_HEARTBEAT_PENDING'});
   if(current&&Number.isInteger(current.pid)&&alive(current.pid)||!current&&now()-io.statSync(file).mtimeMs<5000)
    throw new Error('This worker is already running or starting.');
   io.unlinkSync(file);
  }
 }
 throw new Error('Could not own the local worker process.');
}
module.exports={acquireProcessLock};
