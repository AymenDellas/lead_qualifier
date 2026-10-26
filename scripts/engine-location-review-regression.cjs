'use strict';
const fs=require('node:fs'),path=require('node:path'),q=require('../src/lib/prospect-qualification.cjs');
function replay(snapshot,{currentPolicy=false}={}){
 const result={snapshotAt:snapshot.snapshotAt,records:snapshot.leads.length,currentPolicy,decisionChanges:[],evidenceChanges:[],unexpected:[],errors:[]};
 const originalNow=Date.now;Date.now=()=>Date.parse(snapshot.snapshotAt);
 try{for(const lead of snapshot.leads){try{
  const research=structuredClone(lead.prospect_assessment.baseResearch||lead.prospect_assessment.research),before=lead.replay;
  if(currentPolicy)research.targetLocationRequired=true;
  const context={email:lead.email,review:lead.prospect_review,now:snapshot.snapshotAt,
   legacyFollowersUnchecked:(lead.prospect_assessment.version||1)<2&&!research.followers,...(currentPolicy?{minFollowers:500}:{})};
  const after=q.assessProspect(research,context),pipeline=q.pipelineForAssessment(after);
  const evidence={id:lead.id,stored:lead.pipeline_status,before,after:{pipeline,qualification:after.qualification,blockers:after.blockers}};
  const fields=['qualified','activity','activityAgeDays','attributableEmail','needsRetry','needsAttention','followers','followersReason','followersThreshold'];
  if(fields.some(key=>before.qualification[key]!==after.qualification[key])||JSON.stringify(before.blockers)!==JSON.stringify(after.blockers))result.evidenceChanges.push(evidence);
  if(pipeline!==before.pipeline){
   const withoutCountry=currentPolicy?q.pipelineForAssessment(q.assessProspect({...research,targetLocationRequired:false},context)):pipeline;
   evidence.category=currentPolicy&&pipeline!==withoutCountry?'REQUESTED_COUNTRY_GATE':
    currentPolicy&&before.qualification.followers==='REJECTED'&&after.qualification.followers==='CONTINUE'?'REQUESTED_FOLLOWER_THRESHOLD':
    pipeline==='REVIEW'&&(!research.profileIdentityConfirmed||after.qualification.activity==='UNKNOWN')?'CONSISTENT_UNCERTAINTY_REVIEW':'UNEXPECTED';
   result.decisionChanges.push(evidence);if(evidence.category==='UNEXPECTED')result.unexpected.push(evidence);
  }
 }catch(error){result.errors.push({id:lead.id,error:error.message});}}}finally{Date.now=originalNow;}
 return result;
}
if(require.main===module){
 const directory=path.resolve(__dirname,'../data/engine-v2/location-review-v3'),snapshot=JSON.parse(fs.readFileSync(path.join(directory,'regression-before.json'),'utf8'));
 const phase=process.argv[2]||'final';if(!/^[a-z0-9-]+$/i.test(phase))throw Error('Invalid phase.');
 const reports=[replay(snapshot),replay(snapshot,{currentPolicy:true})];
 fs.writeFileSync(path.join(directory,phase+'-regression.json'),JSON.stringify(reports,null,2));
 console.log(JSON.stringify(reports.map(r=>({...r,evidenceChanges:r.evidenceChanges.length,decisionChanges:r.decisionChanges.map(c=>({id:c.id,before:c.before.pipeline,after:c.after.pipeline,category:c.category})),unexpected:r.unexpected.length})),null,2));
 if(reports.some(r=>r.errors.length||r.unexpected.length))process.exitCode=1;
}
module.exports={replay};
