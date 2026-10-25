'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
function api(){
 let allowed=true,starts=0,reads=0,state={state:'starting',canStart:false,message:'Starting workers'};
 const exports={},context={exports,module:{exports},Request,Response,URL,require:name=>{
  if(name==='next/server')return {NextResponse:{json:(data,init)=>Response.json(data,init)}};
  if(name==='@/lib/pg_setup')return {pool:{query:async()=>({rows:[{online:false}]})}};
  if(name==='@/lib/worker-admin')return {requireWorkerAdmin:async()=>{if(!allowed)throw Error('Not local');}};
  if(name==='@/lib/worker-supervisor-control.cjs')return {createWorkerSupervisorController:()=>({status:async()=>{reads++;return state;},start:async()=>{starts++;return state;}})};
  throw Error('Unexpected dependency '+name);
 }};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname,'../../src/app/api/worker-supervisor/route.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context);
 return {...exports,get starts(){return starts;},get reads(){return reads;},set allowed(value){allowed=value;},set state(value){state=value;}};
}
const request=(body={action:'start'},headers={})=>new Request('http://localhost:3000/api/worker-supervisor',{method:'POST',headers:{origin:'http://localhost:3000','content-type':'application/json',...headers},body:JSON.stringify(body)});
test('status reads never launch processes and valid explicit starts are accepted',async()=>{
 const a=api();assert.equal((await a.GET(new Request('http://localhost:3000/api/worker-supervisor'))).status,200);
 assert.equal(a.starts,0);assert.equal(a.reads,1);
 const response=await a.POST(request());assert.equal(response.status,202);assert.equal(a.starts,1);
 assert.equal(response.headers.get('cache-control'),'no-store');
});
test('worker admin authorization is required before any launch or status read',async()=>{
 const a=api();a.allowed=false;assert.equal((await a.POST(request())).status,403);
 assert.equal((await a.GET(new Request('http://localhost:3000/api/worker-supervisor'))).status,403);
 assert.equal(a.starts,0);assert.equal(a.reads,0);
});
test('cross-site and missing-origin requests cannot launch commands',async()=>{
 const a=api();for(const headers of [{origin:'http://other.example'},{origin:''},{'sec-fetch-site':'cross-site'}])assert.equal((await a.POST(request(undefined,headers))).status,403);
 assert.equal(a.starts,0);
});
test('arbitrary commands, paths and unsupported actions are rejected before launch',async()=>{
 const a=api();for(const body of [{action:'stop'},{action:'start',command:'cmd /c arbitrary'},{action:'start',path:'elsewhere'},null])assert.equal((await a.POST(request(body))).status,400);
 assert.equal((await a.POST(request(undefined,{'content-type':'text/plain'}))).status,400);assert.equal(a.starts,0);
});
test('hosted or unavailable launchers are reported without a false success',async()=>{
 const a=api();a.state={state:'unavailable',canStart:false,message:'Use the local app'};
 assert.equal((await a.POST(request())).status,409);
});
