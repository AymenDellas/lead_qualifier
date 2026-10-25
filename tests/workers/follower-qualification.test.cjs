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
test('stored pre-v2 qualified records remain unchecked until an explicit fresh recheck',()=>{
 const r=research(undefined),legacy=q.assessProspect(r,{email:'coach@practice.test',now,legacyFollowersUnchecked:true});
 assert.equal(legacy.version,1);assert.equal(q.pipelineForAssessment(legacy),'QUALIFIED');assert.equal(legacy.research.followers,null);
 assert.equal(q.pipelineForAssessment(q.assessProspect(r,{email:'coach@practice.test',now})),'REVIEW');
});
