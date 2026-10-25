'use strict';
const fs=require('node:fs'),path=require('node:path');
const qualification=require('../src/lib/prospect-qualification.cjs');
function replay(snapshot){
 const realNow=Date.now,at=Date.parse(snapshot.snapshotAt);if(!Number.isFinite(at))throw Error('Snapshot needs a fixed replay clock.');
 const changes=[],preExisting=[],errors=[],nonFollowerChanges=[];Date.now=()=>at;
 try{for(const lead of snapshot.leads){
  const expected=lead.replay;
  try{
   const assessment=qualification.assessProspect(lead.prospect_assessment.baseResearch||lead.prospect_assessment.research,
    {email:lead.email,review:lead.prospect_review,now:snapshot.snapshotAt});
   const pipeline=qualification.pipelineForAssessment(assessment),stored=lead.pipeline_status==='OUTREACH'?'QUALIFIED':lead.pipeline_status;
   if(qualification.QUALIFICATION_VERSION>=2){
    // Diagnostic isolation only, never persisted as lead evidence: passing this
    // one new gate must reproduce every original email/activity decision.
    const threshold=require('../src/lib/follower-policy.cjs').minFollowers();
    const research=structuredClone(lead.prospect_assessment.baseResearch||lead.prospect_assessment.research);
    research.followers={count:threshold+1,rawText:'DIAGNOSTIC ONLY',checkedAt:snapshot.snapshotAt,threshold};
    const shadow=qualification.assessProspect(research,{email:lead.email,review:lead.prospect_review,now:snapshot.snapshotAt});
    const fields=['qualified','activity','activityAgeDays','attributableEmail','needsRetry','needsAttention'];
    if(qualification.pipelineForAssessment(shadow)!==expected.pipeline||fields.some(key=>shadow.qualification[key]!==expected.qualification[key])||JSON.stringify(shadow.blockers)!==JSON.stringify(expected.blockers))
     nonFollowerChanges.push({id:lead.id,before:expected,after:{pipeline:qualification.pipelineForAssessment(shadow),qualification:shadow.qualification,blockers:shadow.blockers}});
   }
   if(expected.error)errors.push({id:lead.id,baselineError:expected.error});
   if(stored!==expected.pipeline)preExisting.push({id:lead.id,stored,replay:expected.pipeline});
   if(pipeline!==expected.pipeline||JSON.stringify(assessment.qualification)!==JSON.stringify(expected.qualification)||JSON.stringify(assessment.blockers)!==JSON.stringify(expected.blockers))
    changes.push({id:lead.id,before:expected,after:{pipeline,qualification:assessment.qualification,blockers:assessment.blockers}});
  }catch(error){errors.push({id:lead.id,error:error.message});}
 }}finally{Date.now=realNow;}
 return {snapshotAt:snapshot.snapshotAt,version:qualification.QUALIFICATION_VERSION||qualification.VERSION,records:snapshot.leads.length,changed:changes.length,changes,nonFollowerChanges,preExisting,errors};
}
if(require.main===module){
 const phase=process.argv[2]||'phase-1';if(!/^[a-z0-9-]+$/i.test(phase))throw Error('Use a phase name with letters, numbers and hyphens.');
 const directory=path.resolve(__dirname,'../data/engine-v2'),snapshot=JSON.parse(fs.readFileSync(path.join(directory,'regression-before.json'),'utf8'));
 const result=replay(snapshot);fs.writeFileSync(path.join(directory,phase+'-regression.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify({...result,changes:result.changes.map(row=>({id:row.id,before:row.before.pipeline,after:row.after.pipeline,reason:row.after.qualification.followersReason}))},null,2));if(result.nonFollowerChanges.length||result.errors.length||(qualification.QUALIFICATION_VERSION<2&&result.changed))process.exitCode=1;
}
module.exports={replay};
