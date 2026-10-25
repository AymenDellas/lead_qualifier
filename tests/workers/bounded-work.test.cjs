'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createBoundedQueue,createLimiter}=require('../../src/lib/bounded-work.cjs');
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
