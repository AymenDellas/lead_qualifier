'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const reader=require('../../src/lib/linkedin-voyager-reader.cjs'),q=require('../../src/lib/prospect-qualification.cjs');
const person='https://www.linkedin.com/in/voyager-fixture/',urn='urn:li:fsd_profile:ACoFixture',now='2026-10-26T12:00:00.000Z';
const profile=(changes={})=>({data:{profile:{publicIdentifier:'voyager-fixture',entityUrn:urn,firstName:'Ava',lastName:'Morgan',headline:'Executive coach',locationName:'Toronto, Canada',followerCount:1234,connectionCount:500,...changes}}});
const activity=(entries)=>({data:{elements:entries||[{actor:{profileUrn:urn},createdAt:Date.parse(now)-86400000,commentary:{text:'Own dated post'}}]}});
function fixture(overrides={}){
 const calls=[],checks=[],checkpoints=[],responses={profile:{status:200,data:profile()},activity:{status:200,data:activity()},contact:{status:200,data:{data:{emailAddress:'ava@practice.test',websites:[]}}},...overrides};
 const options={accountId:'one',now,requireTargetLocation:true,beforeCheck:async kind=>checks.push(kind),onCheckpoint:async value=>checkpoints.push(structuredClone(value)),
  request:async(_page,kind,url)=>{assert.equal(url,person);calls.push(kind);const value=responses[kind]||{status:404,data:null};if(value instanceof Error)throw value;return value;}};
 return {calls,checks,checkpoints,options,run:extra=>reader.captureProfile({url:()=> 'https://www.linkedin.com/feed/'},person,{...options,...extra})};
}
test('profile parsing binds identity, country and audience to the requested member only',()=>{
 const data=profile({followerCount:undefined,'*followingInfo':'own-follow-info'});
 data.included=[{entityUrn:'other-follow-info',followerCount:99999},{entityUrn:'own-follow-info',profileUrn:urn,followerCount:'1.2K'},
  {publicIdentifier:'other',entityUrn:'urn:li:fsd_profile:Other',followerCount:99999,locationName:'Paris, France'}];
 const value=reader.parseProfileResponse(data,person,'one',now);
 assert.equal(value.firstName,'Ava');assert.equal(value.profileLocation,'Toronto, Canada');assert.equal(value.followers.count,1200);assert.equal(value.followers.rawText,'1.2K');assert.equal(value.connections.count,500);
 assert.equal(reader.parseProfileResponse({included:[data.included[2]]},person,'one',now),null);
 data.included[1].profileUrn='urn:li:fsd_profile:Other';assert.equal(reader.parseProfileResponse(data,person,'one',now).followers.count,null);
 assert.equal(reader.parseProfileResponse({data:{elements:[profile().data.profile]}},person,'one',now).followers.count,1234);
});
test('numeric, formatted and localized follower values retain raw evidence; conflicts require review',()=>{
 for(const [raw,count]of [[1234,1234],['1,234',1234],['12K',12000],['1M',1000000],['\u200f1,119\u200f من المتابعين',1119]]){
  const value=reader.parseProfileResponse(profile({followerCount:raw}),person,'one',now);assert.equal(value.followers.count,count);assert.equal(value.followers.rawText,String(raw));
 }
 assert.equal(reader.parseProfileResponse(profile({followerCount:1234,followersCount:1235}),person).followers.count,null);
 assert.equal(reader.parseProfileResponse(profile({followerCount:undefined,connectionCount:5000}),person).followers.count,null);
});
test('request construction is limited to the requested person and declared endpoint kinds',()=>{
 assert.match(reader.requestPath('profile',person),/\/voyager\/api\/identity\/profiles\/voyager-fixture\/profileView$/);
 assert.match(reader.requestPath('activity',person,urn),/count=10/);
 assert.throws(()=>reader.requestPath('anything',person),/Unsupported/);
 assert.throws(()=>reader.requestPath('profile','https://attacker.test/in/other/'),/Invalid/);
 assert.throws(()=>reader.requestPath('activity',person,'urn:li:company:1'),/supported activity identity/);
});
test('normal capture uses three targeted reads and saves profile, activity and contact checkpoints',async()=>{
 const f=fixture(),value=await f.run();assert.deepEqual(f.calls,['profile','activity','contact']);assert.deepEqual(f.checks,['profile_page']);
 assert.equal(value.profileIdentityConfirmed,true);assert.equal(value.followers.threshold,500);assert.equal(value.activityStatus,'Active');assert.deepEqual(value.emails,['ava@practice.test']);
 assert.equal(value.linkedinCapture.complete,true);assert.equal(value.linkedinCapture.reader,'VOYAGER_V1');assert.equal(value.targetLocationRequired,true);
 assert.deepEqual(f.checkpoints.map(v=>v.linkedinCapture.stage),['profile','activity','contact','complete']);
 const research=await require('../../src/lib/prospect-research.cjs').researchProspect({...value,linkedinUrl:person},{qualificationFirst:true,now,fetchPage:()=>assert.fail('Published email avoids website work')});
 assert.equal(q.pipelineForAssessment(q.assessProspect(research,{email:value.primaryEmail,now})),'QUALIFIED');
});
test('foreign and low-follower decisions stop all downstream requests; absent followers never use connections',async()=>{
 for(const [changes,reason,status]of [[{locationName:'Paris, France',followerCount:undefined},'LOCATION_OUTSIDE_TARGET','REJECTED'],
  [{followerCount:500},'FOLLOWERS_BELOW_MIN','REJECTED'],[{locationName:'Toronto'},'LOCATION_UNCONFIRMED','REVIEW']]){
  const f=fixture({profile:{status:200,data:profile(changes)}}),value=await f.run();assert.equal(value.reasonCode,reason);assert.equal(value.status,status);assert.deepEqual(f.calls,['profile']);
 }
 const f=fixture({profile:{status:200,data:profile({followerCount:undefined,connectionCount:5000})}}),value=await f.run();
 assert.equal(value.status,'REVIEW');assert.equal(value.reasonCode,'FOLLOWERS_NOT_SHOWN');assert.deepEqual(f.calls,['profile','profileFallback']);
});
test('501 followers continue; profile fallback is bounded and merges only verified same-member fields',async()=>{
 const f=fixture({profile:{status:200,data:profile({followerCount:undefined})},profileFallback:{status:200,data:profile({followerCount:501,locationName:''})}});
 const value=await f.run();assert.equal(value.followers.count,501);assert.equal(value.profileLocation,'Toronto, Canada');assert.equal(value.activityStatus,'Active');
 assert.deepEqual(f.calls,['profile','profileFallback','activity','contact']);
 const wrong=fixture({profile:{status:200,data:{included:[{publicIdentifier:'someone-else',firstName:'Wrong',followerCount:99999}]}},profileFallback:{status:404}});
 await assert.rejects(wrong.run(),e=>e.failure.code==='PROFILE_IDENTITY');assert.deepEqual(wrong.calls,['profile','profileFallback']);
});
test('strict activity ignores known foreign actors while missing/undated own authors stay unconfirmed',async()=>{
 const old={actor:{profileUrn:urn},createdAt:Date.parse(now)-90*86400000},foreign={actor:{profileUrn:'urn:li:fsd_profile:Other'},createdAt:Date.parse(now)-1000};
 const f=fixture({activity:{status:200,data:activity([old,foreign])}}),value=await f.run();assert.equal(value.status,'REJECTED');assert.equal(value.reasonCode,'ACTIVITY_INACTIVE');assert.equal(value.activityEvidence.ignoredForeign,1);assert.deepEqual(f.calls,['profile','activity']);
 for(const entry of [{createdAt:Date.parse(now)-1000},{actor:{profileUrn:urn}},{actor:{profileUrn:urn},createdAt:Date.parse(now)+10000}]){
  const f=fixture({activity:{status:200,data:activity([old,entry])}}),value=await f.run();assert.equal(value.status,'REVIEW');assert.equal(value.reasonCode,'ACTIVITY_UNCONFIRMED');assert.deepEqual(f.calls,['profile','activity']);
 }
});
test('an activity failure resumes the stored own profile without repeating its request or freshening its observation',async()=>{
 const error=Object.assign(Error('Transport failed'),{failure:{code:'VOYAGER_TRANSPORT',stage:'linkedin',retryable:true}});
 const f=fixture({activity:error});await assert.rejects(f.run(),/Transport/);const saved=f.checkpoints.at(-1);assert.equal(saved.linkedinCapture.complete,false);
 const resumed=fixture(),value=await resumed.run({resume:saved,now:'2026-10-26T12:01:00.000Z'});assert.deepEqual(resumed.calls,['activity','contact']);assert.equal(value.linkedinCapturedAt,now);
 const other=fixture();await other.run({resume:saved,accountId:'two'});assert.equal(other.calls[0],'profile');
});
test('an incomplete fallback checkpoint retries only the alternate profile request',async()=>{
 const error=Object.assign(Error('Alternate unavailable'),{failure:{code:'VOYAGER_TRANSPORT',stage:'linkedin',retryable:true}});
 const f=fixture({profile:{status:200,data:profile({followerCount:undefined})},profileFallback:error});await assert.rejects(f.run(),/Alternate/);
 const next=fixture({profileFallback:{status:200,data:profile()}});await next.run({resume:f.checkpoints.at(-1)});assert.deepEqual(next.calls,['profileFallback','activity','contact']);
});
test('contact data never comes from arbitrary included members and completed contact stages resume once',async()=>{
 const f=fixture({contact:{status:200,data:{included:[{publicIdentifier:'other',emailAddress:'other@company.test'}]}}});const value=await f.run();assert.equal(value.primaryEmail,'');assert.deepEqual(f.calls,['profile','activity','contact','featured']);
 assert.throws(()=>reader.contactData({data:{publicIdentifier:'other',emailAddress:'other@company.test'}},person),e=>e.failure.code==='PROFILE_IDENTITY');
 assert.throws(()=>reader.contactData({data:{'*contactInfo':'foreign-info'},included:[{entityUrn:'foreign-info',publicIdentifier:'other',emailAddress:'other@company.test'}]},person),e=>e.failure.code==='PROFILE_IDENTITY');
 assert.throws(()=>reader.contactData({data:{profileUrn:'urn:li:fsd_profile:Other',emailAddress:'other@company.test'}},person,urn),e=>e.failure.code==='PROFILE_IDENTITY');
 const ok=fixture();await ok.run();const saved=ok.checkpoints.find(v=>v.linkedinCapture.stage==='contact');const resume=fixture();await resume.run({resume:saved});assert.deepEqual(resume.calls,[]);
});
test('account restrictions never trigger a fallback or another read',async()=>{
 const error=Object.assign(Error('Review account'),{failure:{stage:'linkedin',code:'LINKEDIN_AUTH',reason:'Review account',retryable:false}});
 const f=fixture({profile:error});await assert.rejects(f.run(),e=>e.failure===error.failure);assert.deepEqual(f.calls,['profile']);
 const controlled=fixture();await assert.rejects(controlled.run({beforeCheck:async()=>{throw Error('Paused');}}),/Paused/);assert.deepEqual(controlled.calls,[]);
});
