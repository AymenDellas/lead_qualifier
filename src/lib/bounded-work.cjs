'use strict';
// Memory backpressure, never a LinkedIn usage throttle. Receipts distinguish
// admission from completion; failures remain observable until explicitly reset.
function createBoundedQueue({capacity=6,concurrency=1,onError=()=>{}}={}){
 if(!Number.isInteger(capacity)||capacity<1||!Number.isInteger(concurrency)||concurrency<1||concurrency>capacity)throw Error('Invalid bounded queue capacity.');
 let active=0,size=0,closed=false,lastError=null;const queue=[],admissions=[],idleWaiters=[];
 function wake(){while(admissions.length&&size<capacity){size++;admissions.shift().resolve();}}
 function settled(){if(!size){for(const resolve of idleWaiters.splice(0))resolve();}}
 function drain(){
  while(active<concurrency&&queue.length){
   const task=queue.shift();active++;
   Promise.resolve().then(task.run).then(task.resolve,error=>{
    lastError=error;task.reject(error);try{Promise.resolve(onError(error,task.metadata)).catch(()=>{});}catch{}
   }).finally(()=>{active--;size--;wake();drain();settled();});
  }
 }
 async function submit(run,metadata){
  if(closed)throw Error('Save queue is closed.');
  if(size>=capacity)await new Promise((resolve,reject)=>admissions.push({resolve,reject}));else size++;
  if(closed){size--;wake();settled();throw Error('Save queue is closed.');}
  let resolve,reject;const done=new Promise((yes,no)=>{resolve=yes;reject=no;});done.catch(()=>{});
  queue.push({run,metadata,resolve,reject});drain();return {done};
 }
 function idle(){return size?new Promise(resolve=>idleWaiters.push(resolve)):Promise.resolve();}
 async function close(){closed=true;for(const waiter of admissions.splice(0))waiter.reject(Error('Save queue is closed.'));await idle();}
 return {submit,idle,close,clearError:()=>{lastError=null;},get error(){return lastError;},get size(){return size;},capacity};
}
function createLimiter(concurrency=3,capacity=96){
 const queue=createBoundedQueue({concurrency,capacity});
 return async task=>(await queue.submit(task)).done;
}
module.exports={createBoundedQueue,createLimiter};
