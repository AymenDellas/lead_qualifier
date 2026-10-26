'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createBoundedQueue,createLimiter,createSavePool}=require('../../src/lib/bounded-work.cjs');
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
test('admission overlaps work, respects the memory bound and preserves save order',async()=>{
 const gate=deferred(),order=[],queue=createBoundedQueue({capacity:2});
 const one=await queue.submit(async()=>{order.push(1);await gate.promise;});
 const two=await queue.submit(async()=>{order.push(2);});
 let admitted=false;const three=queue.submit(async()=>order.push(3)).then(receipt=>{admitted=true;return receipt;});
 await Promise.resolve();assert.equal(admitted,false);assert.equal(queue.size,2);assert.deepEqual(order,[1]);
 gate.resolve();await one.done;await two.done;await (await three).done;await queue.idle();
 assert.deepEqual(order,[1,2,3]);assert.equal(queue.size,0);await queue.close();
});
test('errors stay visible and closing rejects blocked admissions without losing active saves',async()=>{
 const gate=deferred(),errors=[],queue=createBoundedQueue({capacity:1,onError:e=>errors.push(e.message)});
 const active=await queue.submit(async()=>{await gate.promise;throw Error('DB unavailable');});
 const blocked=queue.submit(async()=>assert.fail('Closed task cannot execute'));
 const check=assert.rejects(blocked,/closed/),closing=queue.close();gate.resolve();
 await check;await assert.rejects(active.done,/DB unavailable/);await closing;
 assert.equal(queue.size,0);assert.equal(queue.error.message,'DB unavailable');assert.deepEqual(errors,['DB unavailable']);
});
test('three shared HTTP slots bound concurrency across independent callers',async()=>{
 const limit=createLimiter(3,6),gate=deferred();let active=0,peak=0;
 const tasks=Array.from({length:10},()=>limit(async()=>{active++;peak=Math.max(peak,active);await gate.promise;active--;}));
 await new Promise(resolve=>setImmediate(resolve));assert.equal(active,3);gate.resolve();await Promise.all(tasks);assert.equal(peak,3);
});
test('account save scopes share one memory bound and isolate errors, drains and closure',async()=>{
 const pool=createSavePool({capacity:2}),errors=[],one=pool.scope({onError:e=>errors.push(e.message)}),two=pool.scope();
 const gate=deferred(),order=[];
 const first=await one.submit(async()=>{order.push('one');await gate.promise;throw Error('one failed');});
 const second=await two.submit(async()=>order.push('two'));
 let admitted=false;const blocked=two.submit(async()=>order.push('three')).then(receipt=>{admitted=true;return receipt;});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(pool.size,2);assert.equal(admitted,false);
 const closing=one.close();gate.resolve();await assert.rejects(first.done,/one failed/);await closing;
 await second.done;await(await blocked).done;await two.idle();
 assert.deepEqual(order,['one','two','three']);assert.deepEqual(errors,['one failed']);
 assert.equal(one.error.message,'one failed');assert.equal(two.error,null);two.clearError();assert.ok(one.error);
 await assert.rejects(one.submit(async()=>{}),/closed/);
 const next=await two.submit(async()=>42);assert.equal(await next.done,42,'closing one account does not close the shared queue');
 await two.close();await pool.close();assert.equal(pool.size,0);
});
