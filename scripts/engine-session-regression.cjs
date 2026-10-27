'use strict';
const fs=require('node:fs'),path=require('node:path'),q=require('../src/lib/prospect-qualification.cjs');
const directory=path.resolve(__dirname,'../data/engine-v2/session-hardening');
function replay(snapshot){
 const report={records:snapshot.leads.length,decisionChanges:[],evidenceChanges:[],errors:[]},clock=Date.now;
 Date.now=()=>Date.parse(snapshot.snapshotAt);
 try{for(const lead of snapshot.leads){try{
  const research=structuredClone(lead.prospect_assessment.baseResearch||lead.prospect_assessment.research);
  const a=q.assessProspect(research,{email:lead.email,review:lead.prospect_review,now:snapshot.snapshotAt,legacyFollowersUnchecked:(lead.prospect_assessment.version||1)<2&&!research.followers});
  const pipeline=q.pipelineForAssessment(a);
  if(pipeline!==lead.replay.pipeline)report.decisionChanges.push({id:lead.id,before:lead.replay.pipeline,after:pipeline});
  if(JSON.stringify(a.qualification)!==JSON.stringify(lead.replay.qualification)||JSON.stringify(a.blockers)!==JSON.stringify(lead.replay.blockers))report.evidenceChanges.push({id:lead.id});
 }catch(error){report.errors.push({id:lead.id,error:error.message});}}}finally{Date.now=clock;}
 return report;
}
if(require.main===module){
 const phase=process.argv[2]||'final';if(!/^[a-z0-9-]+$/i.test(phase))throw Error('Invalid phase name.');
 const report=replay(JSON.parse(fs.readFileSync(path.join(directory,'regression-before.json'),'utf8')));
 fs.writeFileSync(path.join(directory,phase+'-regression.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify({...report,evidenceChanges:report.evidenceChanges.length}));
 if(report.decisionChanges.length||report.evidenceChanges.length||report.errors.length)process.exitCode=1;
}
module.exports={replay};
