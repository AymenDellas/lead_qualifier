'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createAliasModeClient,baseUrl,websocket}=require('../../src/lib/aliasmode-client.cjs');
function fixture(data={}){const calls=[];return {calls,client:createAliasModeClient({config:{baseUrl:'http://127.0.0.1:50400',apiKey:'must-never-forward'},cli:{version:async()=>'0.1.0-beta.69',status:async()=>({running:true,state:'running',headless:true,port:9222}),idle:async()=>{}},fetch:async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify({code:0,data}),{status:200});}})};}
test('new profile provisioning explicitly chooses the native Chromium runtime and fixed screen without credentials',async()=>{
 for(const engine of ['aliasmode-chromium','cloakbrowser']){
  const f=fixture({id:'new-fixture'});await f.client.createProfile({name:'Fixture member',engine});const body=JSON.parse(f.calls[0].options.body);
  assert.equal(body.engine,'chromium');assert.equal(body.chromium_runtime,engine==='aliasmode-chromium'?'aliasmode':'cloakbrowser');assert.equal(body.fingerprint_config.screen_resolution,'1920_1080');assert.equal(f.calls[0].options.method,'POST');
  assert.ok(!JSON.stringify(body).includes('password'));assert.ok(!JSON.stringify(f.calls).includes('must-never-forward'));
 }
});
test('only loopback API and CDP addresses are accepted',()=>{
 assert.equal(baseUrl(),'http://127.0.0.1:50400');
 for(const value of ['https://attacker.test','http://127.0.0.1:50400/path','http://user:secret@localhost:50400','file:///tmp'])assert.throws(()=>baseUrl(value));
 for(const value of ['ws://attacker.test:90/devtools/browser/id','ws://127.0.0.1:9/other','ws://user:secret@localhost:9/devtools/browser/id'])assert.throws(()=>websocket(value));
});
test('CLI launches headlessly while Local API supplies CDP and confirmed stop without auth or launch flags',async()=>{
 let active=false;const calls=[],cli={version:async()=>'0.1.0-beta.69',status:async()=>({running:true,state:'running',headless:true,port:9222}),open:async(id,options)=>{calls.push({id,options});active=true;return {headless:true,port:9222};},idle:async()=>{}};
 const client=createAliasModeClient({cli,fetch:async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify({code:0,data:{status:active?'Active':'Inactive',...(active?{ws:{puppeteer:'ws://127.0.0.1:9222/devtools/browser/fixture'}}:{})}}));}});
 const value=await client.start('one',{headless:true});assert.equal(value.headless,true);assert.equal(calls.find(c=>c.id).options.headless,true);await client.stop('one');
 assert.ok(calls.filter(c=>c.url).every(c=>!c.url.includes('/start')&&!c.url.includes('launch_args')&&c.options.headers.Authorization===undefined));assert.equal(new URL(calls.at(-1).url).pathname,'/api/v1/browser/stop');
 await assert.rejects(client.start('one'),e=>e.code==='ALIASMODE_PROFILE_BUSY');
});
test('CLI and Local API instance disagreement fails closed',async()=>{
 const f=fixture({status:'Active',ws:{puppeteer:'ws://127.0.0.1:9999/devtools/browser/fixture'}});await assert.rejects(f.client.inspect('one'),e=>e.code==='ALIASMODE_INSTANCE_CHANGED');
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
