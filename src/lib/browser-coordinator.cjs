'use strict';
function createBrowserCoordinator({max=10}={}){
 if(!Number.isInteger(max)||max<1||max>10)throw Error('MAX_ACTIVE_BROWSERS must be 1–10.');
 const reserved=new Set(),entries=new Map();
 function wrap(id,inner){
  async function close(){await inner.close();reserved.delete(id);}
  async function open(options){if(!reserved.has(id)&&reserved.size>=max)throw Object.assign(Error('All configured AliasMode browser slots are in use.'),{code:'BROWSER_CAPACITY'});reserved.add(id);try{return await inner.open(options);}catch(e){reserved.delete(id);throw e;}}
  async function stop(){await inner.stop();reserved.delete(id);}
  async function recycle(){await inner.recycle();reserved.delete(id);}
  const value={...inner,open,close,pid:()=>inner.pid?.()||null,heartbeat:()=>inner.heartbeat?.(),...(inner.stop?{stop}:{}),...(inner.recycle?{recycle}:{})};entries.set(id,value);return value;
 }
 return {wrap,reserved,entries};
}
module.exports={createBrowserCoordinator};
// LEGACY CHROME REFERENCE — inactive; retained at the user’s request.
// 'use strict';
// const fs=require('node:fs'),path=require('node:path');
// const {isProcessOwner}=require('./worker-process-identity.cjs');
// const problem=(code,message)=>Object.assign(Error(message),{code});
// async function recoverSingletons(directory,{now=Date.now,processOwner=isProcessOwner}={}){
//  const names=['SingletonLock','SingletonCookie','SingletonSocket'],locks=names.filter(name=>{try{fs.lstatSync(path.join(directory,name));return true;}catch{return false;}});
//  if(!locks.length)return;
//  let old;try{old=JSON.parse(fs.readFileSync(path.join(directory,'compel-browser-owner.json'),'utf8'));}catch{}
//  if(!Number.isInteger(old?.chromePid)||old.chromePid<=0||!Number.isInteger(old?.agentPid)||old.agentPid<=0||!old.agentScript)throw problem('BROWSER_OWNER_UNVERIFIED','Chrome profile locks have no verifiable owner. Close Chrome using this saved profile, then review the local lock ownership before retrying.');
//  const browserDead=await processOwner(old.chromePid,directory)===false,agentDead=await processOwner(old.agentPid,old.agentScript)===false;
//  if(!browserDead||!old.closedAt&&(!agentDead||now()-Number(old.heartbeatAt)<30000))throw problem('BROWSER_PROFILE_IN_USE','Chrome profile is owned by a live or unverified process. Close its owned window or wait for the dead owner heartbeat to expire; saved sign-in is retained.');
//  for(const name of locks){const file=path.resolve(directory,name);if(path.dirname(file)!==path.resolve(directory))throw Error('Invalid Chrome lock path.');fs.unlinkSync(file);}
// }
// function createBrowserCoordinator({max=10,owner,log=()=>{}}){
//  if(!Number.isInteger(max)||max<1||max>10)throw Error('MAX_ACTIVE_BROWSERS must be 1–10.');
//  const reserved=new Set(),entries=new Map();
//  function wrap(id,inner){
//   let surface=null,metadata=null;
//   const file=path.join(inner.profileDirectory,'compel-browser-owner.json');
//   function write(closed=false){
//    if(!metadata)return;metadata={...metadata,heartbeatAt:Date.now(),...(closed?{closedAt:Date.now()}:{})};
//    fs.writeFileSync(file,JSON.stringify(metadata));
//   }
//   async function close(){
//    await inner.close();surface=null;reserved.delete(id);try{write(true);}catch(error){log('Browser owner record: '+error.message);}
//   }
//   async function open(options){
//    if(inner.isOpen())return inner.open(options);
//    if(!reserved.has(id)&&reserved.size>=max)throw problem('BROWSER_CAPACITY','Another account owns the available LinkedIn browser. Waiting for that account to become idle; you can also pause it.');
//    reserved.add(id);
//    try{
//     await recoverSingletons(inner.profileDirectory);surface=await inner.open(options);
//     const chromePid=surface.browser.process?.()?.pid;
//     if(Number.isInteger(chromePid)){metadata={chromePid,agentPid:process.pid,agentOwner:owner,agentScript:path.resolve(process.argv[1]),heartbeatAt:Date.now()};write();}
//     return surface;
//    }catch(error){try{await close();}catch(cleanup){throw problem('BROWSER_CLOSE_FAILED',error.message+' Cleanup: '+cleanup.message);}throw error;}
//   }
//   const result={...inner,open,close,heartbeat:()=>{if(inner.isOpen())try{write();}catch(error){log('Browser owner heartbeat: '+error.message);}},pid:()=>surface?.browser.process?.()?.pid||null};
//   entries.set(id,result);return result;
//  }
//  return {wrap,reserved,entries};
// }
// module.exports={createBrowserCoordinator,recoverSingletons};
//
