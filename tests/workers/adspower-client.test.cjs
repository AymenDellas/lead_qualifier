'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createAdsPowerClient,baseUrl,websocket}=require('../../src/lib/adspower-client.cjs');
function fixture(data={}){const calls=[];return {calls,client:createAdsPowerClient({controlIntervalMs:0,config:{baseUrl:'http://127.0.0.1:50325',apiKey:'fixture-api-key'},fetch:async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify({code:0,data}),{status:200});}})};}
test('only loopback API addresses and browser endpoints are accepted',()=>{
 assert.equal(baseUrl('http://127.0.0.1:50325'),'http://127.0.0.1:50325');
 for(const value of ['https://attacker.test','http://127.0.0.1:50325/path','http://user:secret@localhost:50325','file:///tmp'])assert.throws(()=>baseUrl(value));
 for(const value of ['ws://attacker.test:90/devtools/browser/id','ws://127.0.0.1:9/other','ws://user:secret@localhost:9/devtools/browser/id'])assert.throws(()=>websocket(value));
});
test('start uses profile ID and API bearer auth without returning the token or overriding profile configuration',async()=>{
 const f=fixture({ws:{puppeteer:'ws://127.0.0.1:9222/devtools/browser/fixture'}}),value=await f.client.start('profile-one');
 assert.equal(f.calls[0].options.headers.Authorization,'Bearer fixture-api-key');assert.equal(f.calls[0].options.redirect,'error');
 const body=JSON.parse(f.calls[0].options.body);assert.equal(body.profile_id,'profile-one');assert.equal(body.headless,'1');assert.equal(body.password_filling,'0');assert.equal(body.launch_args,undefined);assert.equal(body.cdp_mask,undefined);assert.ok(!JSON.stringify(value).includes('fixture-api-key'));
});
test('profile lists whitelist metadata and never return credentials or proxy details',async()=>{
 const f=fixture({list:[{user_id:'one',name:'Main',password:'private-password',proxy_password:'private-proxy',username:'private-email',group_name:'Work'}]});
 const result=await f.client.list();assert.deepEqual(result.profiles,[{id:'one',name:'Main',group:'Work',number:''}]);assert.ok(!JSON.stringify(result).includes('private'));
});
test('API failures are provider failures and vendor messages cannot leak credentials',async()=>{
 for(const status of [401,403,429,500]){const client=createAdsPowerClient({controlIntervalMs:0,fetch:async()=>new Response('private-api-key',{status})});await assert.rejects(client.health(),e=>e.failure.stage==='provider'&&!e.message.includes('private-api-key'));}
 const client=createAdsPowerClient({controlIntervalMs:0,fetch:async()=>new Response(JSON.stringify({code:-1,msg:'invalid API key private-api-key'}))});await assert.rejects(client.list(),e=>e.code==='ADSPOWER_API_AUTH'&&!e.message.includes('private-api-key'));
});
test('unknown browser state is never treated as inactive and unsafe CDP endpoints are rejected',async()=>{
 await assert.rejects(fixture({status:'unknown'}).client.active('one'),e=>e.code==='ADSPOWER_API_RESPONSE');
 await assert.rejects(fixture({status:'Active',ws:{puppeteer:'ws://attacker.test:90/devtools/browser/id'}}).client.active('one'),e=>e.code==='ADSPOWER_CDP_ENDPOINT');
 await assert.rejects(fixture().client.start('../other'),e=>e.code==='ADSPOWER_PROFILE_ID');
});
test('local control calls are serialized while an earlier response is pending',async()=>{
 let release;const gate=new Promise(resolve=>{release=resolve;});let calls=0;
 const client=createAdsPowerClient({controlIntervalMs:0,fetch:async()=>{calls++;if(calls===1)await gate;return new Response('{"code":0}');}});
 const first=client.health(),second=client.health();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);release();await Promise.all([first,second]);assert.equal(calls,2);
});
