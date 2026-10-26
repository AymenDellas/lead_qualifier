'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {planLeadRepair}=require('../../src/lib/review-remediation.cjs');
const {assessProspect}=require('../../src/lib/prospect-qualification.cjs');
const {research,prospect,NOW}=require('../prospects/fixtures.cjs');
function lead(overrides={}){
 const r=research({profileLocation:'Toronto, Canada',lastActivityAt:null,activityStatus:'Unknown',...overrides});
 return prospect('repair-fixture',{pipeline_status:'REVIEW',prospect_assessment:assessProspect(r,{email:'ava@avamorgan.test',now:NOW})});
}
test('stored explicit foreign residence becomes a negative decision without needing followers or activity',()=>{
 const value=lead({profileLocation:'Paris, France',followers:{count:null,rawText:'',checkedAt:NOW,threshold:1000}});
 const before=JSON.stringify(value),plan=planLeadRepair(value,NOW);
 assert.equal(plan.pipeline,'NOT_QUALIFIED');assert.equal(plan.reason,'LOCATION_OUTSIDE_TARGET');
 assert.equal(plan.assessment.research.researchedAt,NOW);assert.equal(JSON.stringify(value),before);
});
test('Arabic count is repaired from original raw evidence without inventing recent activity or email',()=>{
 const value=lead({followers:{count:null,rawText:'\u200f1,119\u200f من المتابعين',checkedAt:NOW,threshold:1000},contacts:[]});
 const plan=planLeadRepair(value,NOW);
 assert.equal(plan.repairedFollowers,true);assert.equal(plan.assessment.research.followers.count,1119);
 assert.equal(plan.assessment.research.followers.rawText,value.prospect_assessment.research.followers.rawText);
 assert.equal(plan.assessment.research.followers.checkedAt,NOW);assert.equal(plan.pipeline,'REVIEW');
 assert.equal(plan.assessment.research.lastActivityAt,null);assert.equal(plan.assessment.qualification.followersThreshold,500);
});
test('identity, unknown geography, unresolved own activity and connections remain review requirements',()=>{
 for(const overrides of [{profileIdentityConfirmed:false,profileLocation:'Paris, France',followers:{count:100,rawText:'100 followers'}},
  {profileLocation:'Toronto'},{followers:{count:null,rawText:'500+ connections'}},
  {activityEvidence:{version:2,unresolved:1,ignoredForeign:0,records:[],checkedAt:NOW}}]){
  const plan=planLeadRepair(lead(overrides),NOW);assert.equal(plan.pipeline,'REVIEW',JSON.stringify(overrides));
 }
});
test('old-threshold rejects above 500 become review candidates, not automatic qualifications',()=>{
 const value=lead({followers:{count:700,rawText:'700 followers',checkedAt:NOW,threshold:1000}});
 value.pipeline_status='NOT_QUALIFIED';value.prospect_assessment.qualification.followers='REJECTED';
 value.prospect_assessment.qualification.followersThreshold=1000;
 const plan=planLeadRepair(value,NOW);assert.equal(plan.thresholdRecheck,true);assert.equal(plan.pipeline,'REVIEW');
 value.pipeline_status='QUALIFIED';assert.equal(planLeadRepair(value,NOW),null);
});
test('different profile research and already sufficient stored evidence cannot be promoted by this repair',()=>{
 const value=lead();value.prospect_assessment.baseResearch.linkedinUrl='https://www.linkedin.com/in/someone-else/';
 assert.equal(planLeadRepair(value,NOW),null);
 assert.equal(planLeadRepair(lead({lastActivityAt:NOW}),NOW),null);
});
test('proved foreign qualified records are corrected without requeueing or requiring a follower read',()=>{
 const value=lead({profileLocation:'Singapore, Singapore',followers:null});value.pipeline_status='QUALIFIED';
 const plan=planLeadRepair(value,NOW);assert.equal(plan.pipeline,'NOT_QUALIFIED');assert.equal(plan.reason,'LOCATION_OUTSIDE_TARGET');
 value.prospect_assessment.research.profileIdentityConfirmed=false;value.prospect_assessment.baseResearch.profileIdentityConfirmed=false;
 assert.equal(planLeadRepair(value,NOW),null);
});
