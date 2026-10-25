'use strict';
const { randomUUID } = require('node:crypto');
const { validateResearch, assessProspect, pipelineForAssessment, isUnsafeContact, hostOf } = require('./prospect-qualification.cjs');
const {json}=require('./linkedin-workers.cjs');
const schemaReady=new WeakMap();
async function saveWorkerResearch(pool, input) {
 if (!schemaReady.has(pool)) schemaReady.set(pool,pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS prospect_assessment JSONB;
  ALTER TABLE leads ADD COLUMN IF NOT EXISTS prospect_review JSONB;
  ALTER TABLE leads ADD COLUMN IF NOT EXISTS prospect_researched_at TIMESTAMPTZ;
  ALTER TABLE leads ADD COLUMN IF NOT EXISTS followers_check_status TEXT NOT NULL DEFAULT 'UNCHECKED';`).catch(error=>{schemaReady.delete(pool);throw error;}));
 await schemaReady.get(pool);
 const research=validateResearch(input.research);
 const {profileUrl}=require('./linkedin-workers.cjs');
 const url=profileUrl(input.linkedinUrl);
 if (!url || profileUrl(research.linkedinUrl)!==url) throw new Error('Research profile does not match the CRM profile.');
 const client=await pool.connect();
 try {
  await client.query('BEGIN');
  if (input.jobId && input.owner) {
   const owned=await client.query("SELECT id FROM compel_worker_jobs WHERE id=$1 AND owner=$2 AND status='processing' AND lease_until>NOW() FOR UPDATE",[input.jobId,input.owner]);
   if (!owned.rowCount) throw new Error('Job lease lost; stale research was not saved.');
  }
  // Serialize re-research of URL variants without relying on a legacy unique index.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[url]);
  const profileKey=new URL(url).pathname.split('/in/')[1].replace(/\/$/,'');
  let lead=(await client.query(`SELECT * FROM leads WHERE lower(substring(linkedin_url from '/in/([^/?#]+)'))=$1
   ORDER BY do_not_contact DESC NULLS LAST,(contacted IS TRUE AND contacted_source IS NOT NULL) DESC,created_at,id LIMIT 1 FOR UPDATE`,[profileKey])).rows[0];
  if (!lead) lead=(await client.query(`INSERT INTO leads(id,linkedin_url,pipeline_status) VALUES($1,$2,'INBOX') RETURNING *`,[randomUUID(),url])).rows[0];
  const emails=[...new Set(research.contacts.filter(c=>!isUnsafeContact(c.address)).map(c=>c.address.trim().toLowerCase()))];
  const owned=research.contacts.filter(c=>['PUBLISHED','DOMAIN_MATCH'].includes(c.ownership)&&!isUnsafeContact(c.address)).map(c=>c.address.trim().toLowerCase());
  const requested=String(input.email||'').trim().toLowerCase(),existing=String(lead.email||'').trim().toLowerCase();
  const email=owned.includes(requested)?requested:owned[0]||emails[0]||(!isUnsafeContact(existing)?existing:'');
  const changed=email!==existing;
  const assessment=assessProspect(research,{review:lead.prospect_review,email});
  const stage=input.reviewRequired?'REVIEW':pipelineForAssessment(assessment);
  const rejectedHosts=require('./profile-public-contacts.cjs').profileWebsiteEvidence(research).rejectedHosts;
  const discardWebsite=lead.website_source==='about_section'&&rejectedHosts.includes(hostOf(lead.website));
  await client.query(`UPDATE leads SET prospect_assessment=$2::jsonb,prospect_researched_at=$3,pipeline_status=$4,
   followers_check_status=CASE WHEN $14 THEN 'CHECKED' ELSE 'REVIEW' END,
   first_name=COALESCE(NULLIF($5,''),first_name),last_name=COALESCE(NULLIF($6,''),last_name),
   website=COALESCE(NULLIF($7,''),CASE WHEN $13 THEN NULL ELSE website END),website_source=COALESCE(NULLIF($8,''),website_source),
   location=COALESCE(NULLIF($9,''),location),email=$10,all_emails=$11,
   email_status=CASE WHEN $12 THEN 'UNVERIFIED' ELSE email_status END,
   email_verification_method=CASE WHEN $12 THEN NULL ELSE email_verification_method END,
   email_verification_reason=CASE WHEN $12 THEN NULL ELSE email_verification_reason END,
   email_verification_score=CASE WHEN $12 THEN NULL ELSE email_verification_score END,
   email_verified_at=CASE WHEN $12 THEN NULL ELSE email_verified_at END,
   email_verification_expires_at=CASE WHEN $12 THEN NULL ELSE email_verification_expires_at END WHERE id=$1`,
   [lead.id,json(assessment),research.researchedAt,stage,input.firstName||'',input.lastName||'',research.website,input.websiteSource||'',research.profileIdentityConfirmed?research.profileLocation:'',email,JSON.stringify(emails.length?emails:email?[email]:[]),changed,discardWebsite,Number.isSafeInteger(research.followers?.count)]);
  await client.query('COMMIT'); return {id:lead.id,tier:assessment.tier,pipelineStatus:stage,assessment};
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
module.exports={saveWorkerResearch};
