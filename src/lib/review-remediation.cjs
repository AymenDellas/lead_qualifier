'use strict';
const {profileUrl}=require('./linkedin-workers.cjs');
const {assessProspect,pipelineForAssessment}=require('./prospect-qualification.cjs');
const {audienceRecord,minFollowers}=require('./follower-policy.cjs');
const POLICY_KEY='location-review-v3-followers-500';

// A policy repair is not a new observation. Keep original capture dates,
// unknown activity, contact ownership and every unresolved activity card.
function planLeadRepair(lead,now=new Date().toISOString()){
 const stored=lead.prospect_assessment,original=stored?.baseResearch||stored?.research;
 if(!original)return null;
 const threshold=minFollowers(),count=original.followers?.count;
 const thresholdRecheck=lead.pipeline_status==='NOT_QUALIFIED'&&stored.qualification?.followers==='REJECTED'
  &&Number.isSafeInteger(count)&&count>threshold&&count<=(stored.qualification?.followersThreshold??original.followers?.threshold??1000);
 const foreignQualified=['QUALIFIED','OUTREACH'].includes(lead.pipeline_status)&&original.profileIdentityConfirmed===true
  &&require('./discovery-location-evidence.cjs').parsePersonLocation(original.profileLocation).status==='OUTSIDE_TARGET';
 if(lead.pipeline_status!=='REVIEW'&&!thresholdRecheck&&!foreignQualified)return null;
 const url=profileUrl(lead.linkedin_url);
 if(!url||profileUrl(original.linkedinUrl)!==url)return null;
 const research=structuredClone(original);research.targetLocationRequired=true;
 let repairedFollowers=false;
 if(research.followers){
  if(!Number.isSafeInteger(research.followers.count)&&research.profileIdentityConfirmed){
   const parsed=audienceRecord(research.followers.rawText);
   if(parsed.count!==null){research.followers.count=parsed.count;repairedFollowers=true;}
  }
  research.followers.threshold=threshold;
 }
 const assessment=assessProspect(research,{email:lead.email,review:lead.prospect_review,minFollowers:threshold,now});
 const pipeline=pipelineForAssessment(assessment);
 // Releasing REVIEW/old follower rejections into outreach needs a fresh normal
 // worker check. This tool can reject proven failures or retain REVIEW only.
 if(pipeline==='QUALIFIED')return null;
 return {id:lead.id,url,beforePipeline:lead.pipeline_status,pipeline,assessment,repairedFollowers,thresholdRecheck,
  reason:assessment.qualification.location==='REJECTED'?'LOCATION_OUTSIDE_TARGET':thresholdRecheck?'FOLLOWER_POLICY_RECHECK':
   assessment.qualification.followersReason||assessment.qualification.locationReason||
   (assessment.qualification.activity==='UNKNOWN'?'ACTIVITY_UNCONFIRMED':'RESEARCH_REVIEW')};
}
module.exports={POLICY_KEY,planLeadRepair};
