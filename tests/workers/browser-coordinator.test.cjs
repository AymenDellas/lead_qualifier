'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createBrowserCoordinator}=require('../../src/lib/browser-coordinator.cjs');
test('browser reservations remain bounded and failed close retains its reservation',async()=>{const manager=createBrowserCoordinator({max:1});let fail=false;const inner={open:async()=>({}),close:async()=>{if(fail)throw Error('still open');},pid:()=>100};const one=manager.wrap('one',inner),two=manager.wrap('two',inner);await one.open();await assert.rejects(two.open(),e=>e.code==='BROWSER_CAPACITY');fail=true;await assert.rejects(one.close(),/still open/);assert.equal(manager.reserved.size,1);fail=false;await one.close();assert.equal(manager.reserved.size,0);});
test('only provider-confirmed stop/recycle releases a browser slot; no filesystem recovery exists',async()=>{const manager=createBrowserCoordinator({max:1});let fail=true;const one=manager.wrap('one',{open:async()=>({}),close:async()=>{},stop:async()=>{if(fail)throw Error('unconfirmed');},recycle:async()=>{}});await one.open();await assert.rejects(one.stop(),/unconfirmed/);assert.equal(manager.reserved.size,1);fail=false;await one.stop();assert.equal(manager.reserved.size,0);assert.equal(require('../../src/lib/browser-coordinator.cjs').recoverSingletons,undefined);});
// RETIRED LOCAL CHROME TESTS — retained as comments; AdsPower contracts replace these cases.
// 'use strict';
// const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
// const {createBrowserCoordinator,recoverSingletons}=require('../../src/lib/browser-coordinator.cjs');
// test('one LinkedIn browser is reserved atomically, released after close, and retained on failed close',async()=>{
//  const manager=createBrowserCoordinator({owner:'fixture',max:1});let open=false,fail=false;
//  const inner={profileDirectory:os.tmpdir(),isOpen:()=>open,open:async()=>{open=true;return {browser:{process:()=>null}};},close:async()=>{if(fail)throw Error('still alive');open=false;}};
//  const a=manager.wrap('one',inner),b=manager.wrap('two',{...inner,isOpen:()=>false});
//  await a.open();await assert.rejects(b.open(),e=>e.code==='BROWSER_CAPACITY');assert.equal(manager.reserved.size,1);
//  fail=true;await assert.rejects(a.close(),/still alive/);assert.equal(manager.reserved.size,1);fail=false;await a.close();assert.equal(manager.reserved.size,0);
// });
// test('Singleton locks recover only for a confirmed-dead Chrome and expired dead agent heartbeat',async()=>{
//  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'compel-singleton-')),lock=path.join(dir,'SingletonLock'),metadata=path.join(dir,'compel-browser-owner.json');
//  try{
//   fs.writeFileSync(lock,'fixture');await assert.rejects(recoverSingletons(dir),e=>e.code==='BROWSER_OWNER_UNVERIFIED');
//   fs.writeFileSync(metadata,JSON.stringify({chromePid:11,agentPid:12,agentScript:'worker.cjs',heartbeatAt:90000}));
//   await assert.rejects(recoverSingletons(dir,{now:()=>100000,processOwner:async()=>false}),e=>e.code==='BROWSER_PROFILE_IN_USE');
//   await assert.rejects(recoverSingletons(dir,{now:()=>130001,processOwner:async()=>null}),e=>e.code==='BROWSER_PROFILE_IN_USE');
//   await recoverSingletons(dir,{now:()=>130001,processOwner:async()=>false});assert.equal(fs.existsSync(lock),false);
//  }finally{if(fs.existsSync(lock))fs.unlinkSync(lock);fs.unlinkSync(metadata);fs.rmdirSync(dir);}
// });
//
