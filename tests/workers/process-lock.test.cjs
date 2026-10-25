'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {acquireProcessLock}=require('../../src/lib/worker-process-lock.cjs');
function fixture(){const files=new Map();return{files,fs:{mkdirSync(){},readFileSync:file=>{if(!files.has(file))throw Error('missing');return files.get(file);},
 writeFileSync:(file,value)=>{if(files.has(file))throw Object.assign(Error('exists'),{code:'EEXIST'});files.set(file,value);},unlinkSync:file=>files.delete(file),statSync:()=>({mtimeMs:99000})}};}
test('a live or still-being-written process lock cannot be stolen',()=>{
 const f=fixture();f.files.set('worker.pid','{"pid":2}');const options={fs:f.fs,pid:1,now:()=>100000,alive:id=>id===2};
 assert.throws(()=>acquireProcessLock('worker.pid',options),/already running/);f.files.set('worker.pid','');assert.throws(()=>acquireProcessLock('worker.pid',options),/already running/);
});
test('a stale lock recovers once, and cleanup never deletes a replacement owner’s lock',()=>{
 const f=fixture();f.files.set('worker.pid','{"pid":2}');const release=acquireProcessLock('worker.pid',{fs:f.fs,pid:1,now:()=>100000,alive:()=>false});
 assert.equal(JSON.parse(f.files.get('worker.pid')).pid,1);f.files.set('worker.pid','{"pid":3,"token":"new-owner"}');release();assert.equal(JSON.parse(f.files.get('worker.pid')).pid,3);
});

test('an old worker marker pointing to an unrelated live process is cleared without terminating that process',async()=>{
 const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
 const {clearUnownedProcessLock}=require('../../src/lib/worker-process-identity.cjs');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'compel-lock-owner-')),file=path.join(directory,'worker.pid'),script=path.join(directory,'fixture-owner.cjs');
 let child,closed;
 try {
  fs.writeFileSync(file,JSON.stringify({pid:process.pid}));
  await clearUnownedProcessLock(file,path.resolve(__dirname,'../../worker.cjs'));
  assert.equal(fs.existsSync(file),false);assert.doesNotThrow(()=>process.kill(process.pid,0));
  fs.writeFileSync(script,'setInterval(()=>{},1000);');
  child=require('node:child_process').spawn(process.execPath,[script],{windowsHide:true,stdio:'ignore'});
  closed=new Promise(resolve=>child.once('exit',resolve));
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  fs.writeFileSync(file,JSON.stringify({pid:child.pid}));
  await clearUnownedProcessLock(file,script);assert.equal(fs.existsSync(file),true);
 }finally{if(child){child.kill('SIGKILL');await closed;}if(fs.existsSync(file))fs.unlinkSync(file);if(fs.existsSync(script))fs.unlinkSync(script);fs.rmdirSync(directory);}
});
