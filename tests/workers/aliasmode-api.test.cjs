'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
test('AliasMode routes enforce local admin/origin checks and only return public provider metadata',async()=>{
 const code=ts.transpileModule(fs.readFileSync('src/app/api/aliasmode/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
 const module={exports:{}},calls=[];let allowed=false;
 const settings={baseUrl:'http://127.0.0.1:50400',profiles:[],revision:1,status:{state:'connected'}};
 const ads={publicSettings:async()=>settings,saveConfig:async(_p,input)=>{calls.push(['save',input.baseUrl]);return settings;},requestRefresh:async()=>calls.push(['refresh']),bind:async()=>calls.push(['bind']),importProfile:async()=>calls.push(['import']),updateAccount:async()=>calls.push(['update']),requestClose:async()=>calls.push(['close']),allowProcessing:async()=>calls.push(['allow'])};
 const dependencies={'next/server':{NextResponse:{json:(body,options)=>({body,status:options?.status||200})}},'@/lib/pg_setup':{pool:{}},'@/lib/worker-admin':{requireWorkerAdmin:async()=>{if(!allowed)throw Error('not local');}},'@/lib/linkedin-workers.cjs':{ensure:async()=>{},settings:async()=>({accounts:[]})},'@/lib/aliasmode-store.cjs':ads};
 vm.runInNewContext(code,{module,exports:module.exports,URL,require:name=>dependencies[name]});
 const request=(method,body,origin='http://localhost')=>new Request('http://localhost/api/aliasmode',{method,headers:{origin,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 assert.equal((await module.exports.GET(request('GET'))).status,403);allowed=true;
 assert.equal((await module.exports.PUT(request('PUT',{baseUrl:'http://127.0.0.1:50400'},'https://other.test'))).status,403);assert.equal(calls.length,0);
 assert.equal((await module.exports.POST(request('POST',{action:'delete_all'}))).status,400);
 const saved=await module.exports.PUT(request('PUT',{baseUrl:'http://127.0.0.1:50400'}));assert.equal(saved.status,200);assert.ok(!JSON.stringify(saved.body).includes('fixture-key'));assert.equal(calls[0][1],'http://127.0.0.1:50400');
 for(const action of ['refresh','bind','import','update','allow'])assert.equal((await module.exports.POST(request('POST',{action}))).status,200);
 assert.equal((await module.exports.POST(request('POST',{action:'close',accountId:'fixture'}))).status,200);
});
