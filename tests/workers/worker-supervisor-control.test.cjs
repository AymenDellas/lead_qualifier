'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const path=require('node:path'),{EventEmitter}=require('node:events');
const {createWorkerSupervisorController}=require('../../src/lib/worker-supervisor-control.cjs');
function fixture(){
 const root=path.resolve('isolated-worker-fixture'),files=new Map(),live=new Set([1]),launches=[],closed=[];
 let online=false,time=100000,error=null;
 const file=name=>path.join(root,'data',name),script=path.join(root,'scripts','linkedin-worker-supervisor.cjs');
 files.set(script,'fixture');
 const fs={existsSync:p=>files.has(p),mkdirSync(){},readFileSync:p=>{if(!files.has(p))throw Object.assign(Error('Missing'),{code:'ENOENT'});return files.get(p);},
  statSync:()=>({mtimeMs:time}),writeFileSync:(p,text,options)=>{if(options?.flag==='wx'&&files.has(p))throw Object.assign(Error('Exists'),{code:'EEXIST'});files.set(p,text);},
  unlinkSync:p=>{if(!files.delete(p))throw Object.assign(Error('Missing'),{code:'ENOENT'});},openSync:()=>7,closeSync:fd=>closed.push(fd)};
 const proc={pid:1,execPath:path.resolve('node.exe'),env:{DATABASE_URL:'fixture-only'},kill(pid,signal){assert.equal(signal,0);if(!live.has(pid))throw Error('Missing process');}};
 const spawn=(command,args,options)=>{
  const child=new EventEmitter();child.pid=100+launches.length;child.unref=()=>{child.unreferenced=true;};
  launches.push({command,args,options,child});
  queueMicrotask(()=>{if(error)child.emit('error',error);else{live.add(child.pid);child.emit('spawn');}});return child;
 };
 const options={root,fs,process:proc,spawn,now:()=>time,isOnline:async()=>online,isProcessOwner:async()=>true};
 return {root,files,live,launches,closed,proc,file,script,options,controller:createWorkerSupervisorController(options),
  set online(value){online=value;},set error(value){error=value;},set time(value){time=value;}};
}
test('launches only the fixed Node supervisor in the background and does not start account processing',async()=>{
 const f=fixture();assert.equal((await f.controller.status()).state,'offline');
 assert.equal((await f.controller.start()).state,'starting');
 const launch=f.launches[0];assert.equal(launch.command,f.proc.execPath);
 assert.deepEqual(launch.args,[f.script]);assert.equal(launch.options.cwd,f.root);
 assert.equal(launch.options.windowsHide,true);assert.equal(launch.options.detached,true);
 assert.equal(launch.options.shell,undefined);assert.deepEqual(launch.options.stdio,['ignore',7,7]);
 assert.equal(launch.child.unreferenced,true);assert.deepEqual(f.closed,[7]);
 f.online=true;assert.equal((await f.controller.status()).state,'online');
});
test('a reused PID in an old marker does not block startup or terminate the unrelated process',async()=>{
 const f=fixture();f.files.set(f.file('worker-supervisor-start.json'),JSON.stringify({pid:2,startedAt:1,token:'old'}));f.live.add(2);
 const controller=createWorkerSupervisorController({...f.options,isProcessOwner:async pid=>pid!==2});
 assert.equal((await controller.status()).canStart,true);assert.equal((await controller.start()).state,'starting');
 assert.equal(f.launches.length,1);assert.ok(f.live.has(2),'the unrelated process is never terminated');
});
test('concurrent requests and separate server instances launch one supervisor',async()=>{
 const f=fixture(),other=createWorkerSupervisorController(f.options);
 await Promise.all([f.controller.start(),f.controller.start(),other.start()]);
 assert.equal(f.launches.length,1);assert.equal((await f.controller.start()).canStart,false);
});
test('an online supervisor on another host and an existing local process prevent duplicate starts',async()=>{
 const f=fixture();f.online=true;assert.equal((await f.controller.start()).state,'online');assert.equal(f.launches.length,0);
 f.online=false;f.live.add(55);f.files.set(f.file('worker-supervisor.pid'),JSON.stringify({pid:55}));
 assert.equal((await f.controller.start()).state,'starting');assert.equal(f.launches.length,0);
});
test('dead launch markers can recover without killing processes or modifying account settings',async()=>{
 const f=fixture();f.files.set(f.file('worker-supervisor-start.json'),JSON.stringify({pid:55,startedAt:0}));
 await f.controller.start();assert.equal(f.launches.length,1);assert.equal(f.live.has(1),true);
});
test('spawn failures release the launch marker and show a useful error',async()=>{
 const f=fixture();f.error=Object.assign(Error('Denied'),{code:'EACCES'});
 await assert.rejects(f.controller.start(),/permission/);
 assert.equal(f.files.has(f.file('worker-supervisor-start.json')),false);assert.deepEqual(f.closed,[7]);
 f.error=null;await f.controller.start();assert.equal(f.launches.length,2);
});
test('serverless deployments and explicitly disabled test environments never execute commands',async()=>{
 for(const env of [{VERCEL:'1'},{WORKER_LAUNCH_DISABLED:'1'}]){
  const f=fixture();Object.assign(f.proc.env,env);
  assert.equal((await f.controller.start()).state,'unavailable');assert.equal(f.launches.length,0);
 }
 const f=fixture();f.files.delete(f.script);assert.equal((await f.controller.start()).canStart,false);
});
test('unknown database state fails before starting a process',async()=>{
 const f=fixture(),controller=createWorkerSupervisorController({...f.options,isOnline:async()=>{throw Error('Database unavailable');}});
 await assert.rejects(controller.start(),/Database unavailable/);assert.equal(f.launches.length,0);
});
test('a running process without a heartbeat eventually reports attention instead of claiming startup succeeded',async()=>{
 const f=fixture();await f.controller.start();f.time=200001;
 assert.equal((await f.controller.status()).state,'unresponsive');assert.equal((await f.controller.start()).canStart,false);
 assert.equal(f.launches.length,1);
});
