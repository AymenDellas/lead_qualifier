'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {createAliasModeCli,environment}=require('../../src/lib/aliasmode-cli.cjs');
const executable=path.resolve('fixture-install/aliasmode-mcp.exe');
function fixture(){const calls=[];let headless=true;const cli=createAliasModeCli({executable,env:{PATH:'fixture-path',DATABASE_URL:'private-db',AUTH_SECRET:'private-auth'},run:(file,args,options,done)=>{
 calls.push({file,args,options});const id=args[args.indexOf('--profile')+1];let result=args[0]==='version'?{version:'0.1.0-beta.69'}:args[1]==='status'?{profileId:id,state:'running',running:true,headless,port:9222}:{profileId:id,alreadyOpen:false,headless,port:9222};done(null,JSON.stringify({ok:true,result}));
 }});return {cli,calls,set headless(value){headless=value;}};}
test('supported CLI headless launch uses an argument array, hidden child window and scrubbed environment',async()=>{
 const f=fixture();assert.deepEqual(await f.cli.open('profile-one'),{headless:true,port:9222});await f.cli.version();assert.equal(f.calls.length,2);
 assert.deepEqual(f.calls[1].args,['browser','open','--profile','profile-one','--headless','--json']);assert.equal(f.calls[1].options.shell,false);assert.equal(f.calls[1].options.windowsHide,true);assert.equal(f.calls[1].options.env.DATABASE_URL,undefined);assert.equal(f.calls[1].options.env.AUTH_SECRET,undefined);assert.equal(f.calls[1].options.env.PATH,'fixture-path');assert.equal(f.calls[1].options.timeout,120000);
 await assert.rejects(f.cli.open('id; unsafe'),e=>e.code==='ALIASMODE_PROFILE_ID');assert.equal(f.calls.length,2);
});
test('visible launch omits the flag and requires actual visible confirmation',async()=>{
 const f=fixture();await assert.rejects(f.cli.open('one',{headless:false}),e=>e.code==='ALIASMODE_MODE_UNVERIFIED'&&e.startedProfilePort===9222);f.headless=false;
 assert.deepEqual(await f.cli.open('one',{headless:false}),{headless:false,port:9222});assert.equal(f.calls.at(-1).args.includes('--headless'),false);
});
test('mode status is whitelisted and never returns an endpoint or raw vendor fields',async()=>{
 const f=fixture();assert.deepEqual(await f.cli.status('one'),{running:true,state:'running',headless:true,port:9222});assert.deepEqual(environment({PATH:'safe',PRIVATE_KEY:'private'}),{PATH:'safe'});
});
test('timeouts, missing helper and raw vendor errors produce actionable sanitized provider errors',async()=>{
 for(const [error,code]of [[{code:'ENOENT'},'ALIASMODE_HELPER_MISSING'],[{killed:true},'ALIASMODE_CLI_TIMEOUT'],[{code:1},'ALIASMODE_CLI_REJECTED']]){
  const cli=createAliasModeCli({executable,run:(_f,_a,_o,done)=>done(error,JSON.stringify({ok:false,error:'private-token ws://private-endpoint'}))});await assert.rejects(cli.status('one'),e=>e.code===code&&!e.message.includes('private')&&e.failure.stage==='provider');
 }
});
test('helper calls have a shared one-process memory bound and no pacing sleep',async()=>{
 let active=0,peak=0;const pending=[];const cli=createAliasModeCli({executable,run:(_f,args,_o,done)=>{active++;peak=Math.max(peak,active);pending.push(()=>{active--;done(null,JSON.stringify({ok:true,result:{profileId:args[3],state:'closed',running:false}}));});}});
 const a=cli.status('one'),b=cli.status('two');await new Promise(r=>setImmediate(r));assert.equal(pending.length,1);pending.shift()();await new Promise(r=>setImmediate(r));pending.shift()();await Promise.all([a,b]);await cli.idle();assert.equal(peak,1);
});
