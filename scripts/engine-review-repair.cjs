'use strict';
const fs=require('node:fs'),path=require('node:path');
const {POLICY_KEY,planLeadRepair}=require('../src/lib/review-remediation.cjs');
const core=require('../src/lib/linkedin-workers.cjs');
const defaultDirectory=path.resolve(__dirname,'../data/engine-v2/location-review-v3');
const SCHEMA=`CREATE TABLE IF NOT EXISTS compel_qualification_repairs (
 policy_key TEXT NOT NULL,lead_id TEXT NOT NULL,before_pipeline TEXT NOT NULL,after_pipeline TEXT NOT NULL,
 before_assessment JSONB NOT NULL,after_assessment JSONB NOT NULL,reason TEXT NOT NULL,
 job_id TEXT,queue_reason TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(policy_key,lead_id));`;
async function run(pool,{apply=false,queue=false,reportDirectory=defaultDirectory}={}){
 const directory=reportDirectory;
 if(queue&&!apply)throw Error('Queueing requires --apply.');
 const rows=(await pool.query(`SELECT * FROM leads WHERE pipeline_status IN ('REVIEW','NOT_QUALIFIED','QUALIFIED','OUTREACH') AND prospect_assessment IS NOT NULL ORDER BY id`)).rows;
 const at=new Date().toISOString(),plans=rows.map(row=>planLeadRepair(row,at)).filter(Boolean);
 fs.mkdirSync(directory,{recursive:true});
 const snapshot=path.join(directory,'repair-input-'+at.replace(/[^0-9]/g,'')+'.json');
 fs.writeFileSync(snapshot,JSON.stringify({at,leads:rows.filter(row=>plans.some(p=>p.id===row.id))},null,2),{flag:'wx'});
 const report={at,policy:POLICY_KEY,apply,planned:plans.length,repairedFollowers:plans.filter(p=>p.repairedFollowers).length,
  snapshot:path.basename(snapshot),changes:plans.map(p=>({id:p.id,before:p.beforePipeline,after:p.pipeline,reason:p.reason})),applied:0,skipped:[],queued:[],queueSkipped:[]};
 if(apply){
  await core.ensure(pool);await pool.query(SCHEMA);
  const client=await pool.connect(),tx={query:client.query.bind(client)};
  try{
   await client.query('BEGIN');
   await client.query("SELECT pg_advisory_xact_lock(hashtext('compel/qualification-repair/v3'))");
   // Keep human pause/holds intact. This migration never starts LinkedIn work.
   const accounts=await client.query('SELECT id,processing_enabled FROM compel_linkedin_accounts FOR UPDATE');
   if(accounts.rows.some(account=>account.processing_enabled))throw Error('Pause account processing before applying the repair.');
   for(const plan of plans){
    const original=rows.find(row=>row.id===plan.id);
    const originalReview=original.prospect_review==null?null:JSON.stringify(original.prospect_review);
    const audited=await client.query(`INSERT INTO compel_qualification_repairs(policy_key,lead_id,before_pipeline,after_pipeline,before_assessment,after_assessment,reason)
     SELECT $1,$2,$3,$4,$5::jsonb,$6::jsonb,$7 WHERE EXISTS(SELECT 1 FROM leads WHERE id=$2 AND pipeline_status=$3
      AND prospect_assessment=$5::jsonb AND prospect_review IS NOT DISTINCT FROM $8::jsonb AND email IS NOT DISTINCT FROM $9)
     ON CONFLICT DO NOTHING RETURNING lead_id`,[POLICY_KEY,plan.id,plan.beforePipeline,plan.pipeline,JSON.stringify(original.prospect_assessment),JSON.stringify(plan.assessment),plan.reason,originalReview,original.email]);
    if(!audited.rowCount){report.skipped.push(plan.id);continue;}
    const changed=await client.query(`UPDATE leads SET prospect_assessment=$2::jsonb,pipeline_status=$3,
     followers_check_status=CASE WHEN $7 THEN 'CHECKED' ELSE followers_check_status END
     WHERE id=$1 AND pipeline_status=$4 AND prospect_assessment=$5::jsonb AND prospect_review IS NOT DISTINCT FROM $6::jsonb
      AND email IS NOT DISTINCT FROM $8 RETURNING id`,[plan.id,JSON.stringify(plan.assessment),plan.pipeline,plan.beforePipeline,JSON.stringify(original.prospect_assessment),originalReview,plan.repairedFollowers,original.email]);
    if(!changed.rowCount)throw Error('Concurrent lead edit prevented repair; transaction rolled back.');
    report.applied++;
   }
   if(queue){
    const eligible=(await client.query(`SELECT r.lead_id,l.linkedin_url FROM compel_qualification_repairs r JOIN leads l ON l.id=r.lead_id
     WHERE r.policy_key=$1 AND r.job_id IS NULL AND r.queue_reason IS NULL AND l.pipeline_status='REVIEW'
      AND l.prospect_assessment=r.after_assessment AND NOT COALESCE(l.do_not_contact,FALSE)
      AND NOT(COALESCE(l.contacted,FALSE) AND l.contacted_source IS NOT NULL) AND l.linkedin_dm_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM leads other WHERE other.id<>l.id
       AND lower(substring(other.linkedin_url from '/in/([^/?#]+)'))=lower(substring(l.linkedin_url from '/in/([^/?#]+)'))
       AND (COALESCE(other.do_not_contact,FALSE) OR COALESCE(other.contacted,FALSE) AND other.contacted_source IS NOT NULL
        OR other.linkedin_dm_at IS NOT NULL OR other.pipeline_status IN ('QUALIFIED','OUTREACH')))
      AND NOT EXISTS(SELECT 1 FROM case_study_prospects p WHERE p.data->>'crmLeadId'=l.id
       OR lower(substring(p.linkedin_url from '/in/([^/?#]+)'))=lower(substring(l.linkedin_url from '/in/([^/?#]+)')))
     ORDER BY r.lead_id`,[POLICY_KEY])).rows;
    const queued=await core.enqueue(tx,eligible.map(row=>row.linkedin_url),{explicitRetry:true});
    for(const row of eligible){
     const job=queued.queued.find(job=>job.url===core.profileUrl(row.linkedin_url));
     if(job){
      await client.query(`UPDATE compel_worker_jobs SET payload=payload||jsonb_build_object('policyRepair',$2::text,'crmLeadId',$3::text) WHERE id=$1`,[job.id,POLICY_KEY,row.lead_id]);
      await client.query('UPDATE compel_qualification_repairs SET job_id=$3 WHERE policy_key=$1 AND lead_id=$2',[POLICY_KEY,row.lead_id,job.id]);
      report.queued.push({id:row.lead_id,jobId:job.id});
     }else{
      const reason=queued.skipped.find(entry=>core.profileUrl(entry.url)===core.profileUrl(row.linkedin_url))?.reason||'Already queued';
      await client.query('UPDATE compel_qualification_repairs SET queue_reason=$3 WHERE policy_key=$1 AND lead_id=$2',[POLICY_KEY,row.lead_id,reason]);report.queueSkipped.push({id:row.lead_id,reason});
     }
    }
   }
   await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 }
 fs.writeFileSync(path.join(directory,apply?'repair-applied.json':'repair-plan.json'),JSON.stringify(report,null,2));
 return report;
}
if(require.main===module){
 const pool=require('./engine-benchmark.cjs').poolForRoot(path.resolve(__dirname,'..'));
 run(pool,{apply:process.argv.includes('--apply'),queue:process.argv.includes('--queue')})
  .then(r=>console.log(JSON.stringify({...r,changes:r.changes.filter(c=>c.before!==c.after),queued:r.queued.length,skipped:r.skipped.length},null,2)))
  .catch(error=>{console.error(error.message);process.exitCode=1;}).finally(()=>pool.end());
}
module.exports={run,SCHEMA};
