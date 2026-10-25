'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const q=require('../../src/lib/prospect-qualification.cjs');
const now=new Date().toISOString(),person='https://www.linkedin.com/in/fixture-coach/';
function research(count){const r=q.emptyResearch({profileIdentityConfirmed:true,linkedinUrl:person,lastActivityAt:now,activityStatus:'Active',
 followers:count===undefined?null:{count,rawText:count===null?'many followers':count+' followers',checkedAt:now,threshold:1000}},now);
 r.contacts=[{address:'coach@practice.test',source:'linkedin',url:person,ownership:'PUBLISHED'}];return r;}
test('only more than threshold can reach the unchanged email and activity qualifier',()=>{
 for(const count of [0,999,1000]){
  const a=q.assessProspect(research(count),{email:'coach@practice.test',now});assert.equal(a.qualification.qualified,false);assert.equal(q.pipelineForAssessment(a),'NOT_QUALIFIED');assert.equal(a.blockers[0],'FOLLOWERS_BELOW_MIN');
 }
 const a=q.assessProspect(research(1001),{email:'coach@practice.test',now});assert.equal(a.version,q.QUALIFICATION_VERSION);assert.equal(a.qualification.qualified,true);assert.equal(q.pipelineForAssessment(a),'QUALIFIED');
 const noEmail=q.assessProspect(research(2000),{now});assert.equal(noEmail.qualification.qualified,false);assert.equal(q.pipelineForAssessment(noEmail),'NOT_QUALIFIED');
});
test('absent or unparseable follower evidence is REVIEW regardless of email/activity',()=>{
 for(const count of [undefined,null]){const a=q.assessProspect(research(count),{email:'coach@practice.test',now});assert.equal(a.qualification.qualified,false);assert.equal(q.pipelineForAssessment(a),'REVIEW');}
});
test('captured custom thresholds survive replay on a dashboard with different environment defaults',()=>{
 const r=research(1500);r.followers.threshold=2000;const a=q.assessProspect(r,{email:'coach@practice.test',now});assert.equal(a.qualification.followersThreshold,2000);assert.equal(q.pipelineForAssessment(a),'NOT_QUALIFIED');
 const override=q.assessProspect(r,{email:'coach@practice.test',now,minFollowers:1000});assert.equal(q.pipelineForAssessment(override),'QUALIFIED');
});
test('stored pre-v2 qualified records remain unchecked until an explicit fresh recheck',()=>{
 const r=research(undefined),legacy=q.assessProspect(r,{email:'coach@practice.test',now,legacyFollowersUnchecked:true});
 assert.equal(legacy.version,1);assert.equal(q.pipelineForAssessment(legacy),'QUALIFIED');assert.equal(legacy.research.followers,null);
 assert.equal(q.pipelineForAssessment(q.assessProspect(r,{email:'coach@practice.test',now})),'REVIEW');
});
test('an early follower rejection remains REJECTED through the public lane and CRM, with activity intentionally unread',async()=>{
 const {createResearchRunner}=require('../../src/lib/worker-research-runner.cjs');let saved;
 const r=research(1000);r.activityStatus='Unknown';r.lastActivityAt=null;r.contacts=[];
 const runner=createResearchRunner({pool:{query:async()=>({rows:[]})},owner:'fixture',core:{complete:async()=>{}},
  researchProspect:async()=>r,saveWorkerResearch:async(_pool,input)=>{saved=input;const assessment=q.assessProspect(input.research);return {id:'crm',assessment,pipelineStatus:q.pipelineForAssessment(assessment)};},launch:async()=>assert.fail('Followers must not start a website browser.')});
 const {result}=await runner.process({jobId:'early-reject',linkedinUrl:person,nativePostProcess:true,resumeResult:{url:person,profileIdentityConfirmed:true,followers:r.followers,decisionStage:'followers',linkedinCapture:{complete:true},emails:[]}});
 assert.equal(result.status,'REJECTED');assert.equal(saved.reviewRequired,false);assert.equal(result.prospectQualification.qualification.followersReason,'FOLLOWERS_BELOW_MIN');await runner.close();
});
