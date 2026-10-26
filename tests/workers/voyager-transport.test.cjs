'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {requestVoyager}=require('../../src/lib/linkedin-voyager-reader.cjs');
const person='https://www.linkedin.com/in/voyager-fixture/';
function fixture({status=200,body='{"data":{"ok":true}}',cookie='JSESSIONID="fixture-csrf-value"',type,network=false}={}){
 const requests=[],checks=[],context=vm.createContext({document:{cookie},location:{href:'https://www.linkedin.com/feed/'},AbortSignal,TextDecoder,Uint8Array,
  fetch:async(url,options)=>{requests.push({url,options});if(network)throw Error('Offline fixture');const response=new Response(body,{status});return type?{...response,type,status,url,body:response.body}:response;}});
 const page={url:()=> 'https://www.linkedin.com/feed/',evaluate:async(fn,args)=>vm.runInContext('('+fn.toString()+')',context)(args)};
 return {requests,checks,page,run:()=>requestVoyager(page,'profile',person,{beforeCheck:async kind=>checks.push(kind)})};
}
test('transport keeps session tokens inside the browser and makes a targeted GET with bounded redirects',async()=>{
 const f=fixture(),response=await f.run();assert.equal(response.data.data.ok,true);assert.equal(f.requests.length,1);
 const {url,options}=f.requests[0];assert.equal(url,'https://www.linkedin.com/voyager/api/identity/profiles/voyager-fixture/profileView');
 assert.equal(options.method,'GET');assert.equal(options.credentials,'include');assert.equal(options.redirect,'manual');assert.equal(options.headers['csrf-token'],'fixture-csrf-value');
 assert.ok(!JSON.stringify(response).includes('fixture-csrf-value'));assert.deepEqual(f.checks,['profile']);
});
test('401/403/429/999 immediately stop account access without fallback',async()=>{
 for(const status of [401,403,429,999]){
  // WHATWG Response forbids status 999; the browser callback envelope can
  // still contain it, so use the same envelope returned by page.evaluate.
  const f=status===999?{run:()=>requestVoyager({url:()=> 'https://www.linkedin.com/feed/',evaluate:async()=>({status:999,body:'',url:'https://www.linkedin.com/voyager/api/test'})},'profile',person)}:fixture({status});
  await assert.rejects(f.run(),e=>e.failure.stage==='linkedin'&&e.failure.retryable===false&&['LINKEDIN_AUTH','LINKEDIN_RATE_LIMIT'].includes(e.failure.code));
 }
});
test('expired sessions, redirects, HTML authwalls and embedded account restrictions stop',async()=>{
 const cases=[{cookie:''},{status:302,body:'',type:'opaqueredirect'},
  {body:'<html><title>LinkedIn</title><body><h1>Your account has been temporarily restricted</h1><p>Unusually high volume of profile data</p></body></html>'},
  {body:'<html><form action="/login"><input name="session_key"></form></html>'},
  {body:'{"status":403,"message":"Your account has been temporarily restricted"}'}];
 for(const values of cases){const f=fixture(values);await assert.rejects(f.run(),e=>e.failure.code==='LINKEDIN_AUTH');if(values.cookie==='')assert.equal(f.requests.length,0);}
});
test('unsupported classic endpoints allow a bounded caller-selected alternate; transient errors stay retryable',async()=>{
 for(const status of [400,404,405,410])assert.equal((await fixture({status}).run()).status,status);
 assert.equal((await fixture({body:'{"status":404}'}).run()).status,404);
 for(const values of [{status:503},{network:true},{body:'{"status":503}'}])await assert.rejects(fixture(values).run(),e=>e.failure.code==='VOYAGER_TRANSPORT'&&e.failure.retryable===true);
});
test('malformed and oversized responses require review without exporting raw response content',async()=>{
 for(const body of ['not JSON','null','[]','<html>Unexpected page</html>'])await assert.rejects(fixture({body}).run(),e=>e.failure.code==='VOYAGER_RESPONSE_SHAPE');
 await assert.rejects(fixture({body:'x'.repeat(2*1024*1024+1)}).run(),e=>e.failure.code==='VOYAGER_RESPONSE_SIZE');
});
test('non-LinkedIn pages and interrupted account admission cannot send a request',async()=>{
 const f=fixture();f.page.url=()=> 'https://attacker.test/';await assert.rejects(f.run(),e=>e.failure.code==='LINKEDIN_AUTH');assert.equal(f.requests.length,0);
 const other=fixture();await assert.rejects(requestVoyager(other.page,'profile',person,{beforeCheck:async()=>{throw Error('Account paused');}}),/paused/);assert.equal(other.requests.length,0);
});
