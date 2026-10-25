'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const code=ts.transpileModule(fs.readFileSync('src/app/api/engine-control/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
test('Engine control authenticates, rejects cross-site/arbitrary actions and returns the persisted account state',async()=>{
 let allowed=false,mutations=0;
 const module={exports:{}},deps={'next/server':{NextResponse:{json:(body,options)=>({body,status:options?.status||200})}},'@/lib/pg_setup':{pool:{}},'@/lib/worker-admin':{requireWorkerAdmin:async()=>{if(!allowed)throw Error('unauthorized');}},'@/lib/engine-controls.cjs':{controlEngine:async(_pool,action)=>{mutations++;return{action,updated:['fixture'],blocked:[]};}},'@/lib/linkedin-workers.cjs':{queueStatus:async()=>({queueSize:271,workerStatus:{processingAuthorized:true}})}};
 vm.runInNewContext(code,{module,exports:module.exports,URL,require:name=>deps[name]});
 const request=(body,origin='http://localhost')=>new Request('http://localhost/api/engine-control',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify(body)});
 await assert.rejects(module.exports.POST(request({action:'resume'})),/unauthorized/);allowed=true;
 assert.equal((await module.exports.POST(request({action:'resume'},'https://unrelated.test'))).status,403);
 for(const body of [{action:'login'},{action:'resume',id:'arbitrary'},{action:'start',command:'anything'}])assert.equal((await module.exports.POST(request(body))).status,400);
 assert.equal(mutations,0);const result=await module.exports.POST(request({action:'resume'}));assert.equal(result.status,200);assert.equal(result.body.workerStatus.processingAuthorized,true);assert.equal(mutations,1);
});
