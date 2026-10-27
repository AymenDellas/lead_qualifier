'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createAliasModeClient,baseUrl,websocket}=require('../../src/lib/aliasmode-client.cjs');
function fixture(data={}){const calls=[];return {calls,client:createAliasModeClient({config:{baseUrl:'http://127.0.0.1:50400',apiKey:'must-never-forward'},fetch:async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify({code:0,data}),{status:200});}})};}
test('only loopback API and CDP addresses are accepted',()=>{
 assert.equal(baseUrl(),'http://127.0.0.1:50400');
 for(const value of ['https://attacker.test','http://127.0.0.1:50400/path','http://user:secret@localhost:50400','file:///tmp'])assert.throws(()=>baseUrl(value));
 for(const value of ['ws://attacker.test:90/devtools/browser/id','ws://127.0.0.1:9/other','ws://user:secret@localhost:9/devtools/browser/id'])assert.throws(()=>websocket(value));
});
test('start and stop use supported V1 GETs without auth, launch flags or session overrides',async()=>{
 const f=fixture({ws:{puppeteer:'ws://127.0.0.1:9222/devtools/browser/fixture'}});
 const value=await f.client.start('profile-one',{headless:true});await f.client.stop('profile-one');
 const url=new URL(f.calls[0].url);assert.equal(url.pathname,'/api/v1/browser/start');assert.equal(url.searchParams.get('user_id'),'profile-one');assert.equal(url.searchParams.has('launch_args'),false);
 assert.equal(f.calls[0].options.method,'GET');assert.equal(f.calls[0].options.headers.Authorization,undefined);assert.equal(f.calls[0].options.redirect,'error');assert.equal(value.headless,null);
 assert.equal(new URL(f.calls[1].url).pathname,'/api/v1/browser/stop');assert.ok(!JSON.stringify(f.calls).includes('must-never-forward'));
});
test('profile lists return public identifiers only',async()=>{
 const f=fixture({list:[{user_id:'one',name:'Main',password:'private-password',proxy_password:'private-proxy',username:'private-email',group_name:'Work',serial_number:'2'}]});
 assert.deepEqual((await f.client.list()).profiles,[{id:'one',name:'Main',group:'Work',number:'2'}]);
});
test('API error envelopes and HTTP failures never expose raw vendor responses',async()=>{
 for(const status of [401,403,429,500]){const client=createAliasModeClient({fetch:async()=>new Response('private-token',{status})});await assert.rejects(client.health(),e=>e.failure.stage==='provider'&&!e.message.includes('private-token'));}
 const client=createAliasModeClient({fetch:async()=>new Response(JSON.stringify({code:-1,msg:'private-token ws://credentials'}))});await assert.rejects(client.health(),e=>e.code==='ALIASMODE_API_REJECTED'&&!e.message.includes('private-token'));
});
test('transition and uncertain states are never mistaken for an inactive profile',async()=>{
 for(const lifecycle of ['starting','stopping','uncertain']){const f=fixture({status:'Inactive',lifecycle});await assert.rejects(f.client.active('one'),e=>e.code==='ALIASMODE_LIFECYCLE_'+lifecycle.toUpperCase());}
 assert.deepEqual(await fixture({status:'Inactive'}).client.active('one'),{active:false});
 await assert.rejects(fixture({status:'Active',lifecycle:'running'}).client.active('one'),e=>e.code==='ALIASMODE_CDP_ENDPOINT');
 await assert.rejects(fixture({status:'Inactive',lifecycle:'running'}).client.active('one'),e=>e.code==='ALIASMODE_API_RESPONSE');
});
test('unconfirmed teardown has an explicit recoverable provider reason',async()=>{
 const client=createAliasModeClient({fetch:async()=>new Response(JSON.stringify({code:-1,msg:'browser teardown unconfirmed: one'}))});await assert.rejects(client.stop('one'),e=>e.code==='ALIASMODE_STOP_PENDING');
});
test('local control concurrency is bounded without vendor rate-limit timers',async()=>{
 let active=0,peak=0,releases=[];const client=createAliasModeClient({fetch:async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>releases.push(r));active--;return new Response(JSON.stringify({code:0,data:{}}));}});
 const tasks=[client.health(),client.health(),client.health()];await new Promise(r=>setImmediate(r));assert.equal(peak,2);releases.splice(0).forEach(r=>r());await new Promise(r=>setImmediate(r));releases.splice(0).forEach(r=>r());await Promise.all(tasks);await client.idle();assert.equal(peak,2);
});
