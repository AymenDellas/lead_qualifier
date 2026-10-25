import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pool} from '../../src/lib/pg_setup';
import {getCrmLeads,getCrmPage,setCrmContacted,crmLead} from '../../src/lib/crm-store';
import {prospect} from '../prospects/fixtures.cjs';
import {hasQualifiedEmail} from '../../src/lib/prospect-qualification.cjs';

// Explicit opt-in only. Every application query is pinned to this connection
// with pg_temp-only resolution, so it cannot read or change real lead records.
test('Postgres projection, paging and contact batches preserve evidence atomically', {skip:process.env.CRM_TEST_POSTGRES!=='1'}, async()=>{
 const client=await pool.connect();const query=pool.query;
 try {
  await client.query('BEGIN');
  await client.query(`CREATE TEMP TABLE leads (
    id text PRIMARY KEY,linkedin_url text,first_name text,last_name text,company text,website text,website_source text,
    email text,all_emails text,email_status text,email_verification_method text,email_verification_reason text,
    email_verification_score int,email_verified_at timestamptz,email_verification_expires_at timestamptz,
    hook text,hook_source text,pipeline_status text,location text,contacted boolean,contacted_source text,
    contacted_at timestamptz,linkedin_dm_at timestamptz,outcome text,do_not_contact boolean,created_at timestamptz,
    prospect_review jsonb,prospect_assessment jsonb) ON COMMIT DROP`);
  await client.query('CREATE TEMP TABLE case_study_prospects (id text,linkedin_url text,data jsonb) ON COMMIT DROP');
  await client.query('SET LOCAL search_path=pg_temp');
  assert.equal((await client.query('SHOW search_path')).rows[0].search_path,'pg_temp');
  (pool as any).query=client.query.bind(client);
  const originals=new Map<string,ReturnType<typeof prospect>>();
  for(const id of ['manual','platform','hunter','dm','queued','empty-facts']){
   const value=prospect(id);
   if(id==='empty-facts')value.prospect_assessment={research:{...value.prospect_assessment.research,facts:{},profileIdentityConfirmed:false}};
   originals.set(id,value);
   await client.query(`INSERT INTO leads(id,linkedin_url,email,pipeline_status,contacted,contacted_source,linkedin_dm_at,created_at,
    prospect_assessment,email_status,email_verification_method,email_verified_at,email_verification_expires_at,email_verification_score)
    VALUES($1,$2,$3,'QUALIFIED',$4,$5,$6,CURRENT_TIMESTAMP,$7,'VALID','SMTP_DIRECT',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+interval '1 day',98)`,
    [id,`https://www.linkedin.com/in/crm-review-${id}`,value.email,['platform','dm','queued'].includes(id),
     id==='platform'?'PLATFORM':id==='dm'?'LINKEDIN':null,id==='dm'?new Date():null,JSON.stringify(value.prospect_assessment)]);
  }
  await client.query(`INSERT INTO case_study_prospects VALUES('h','http://uk.linkedin.com/in/CRM-REVIEW-HUNTER/?tracking=review','{}')`);
  const initial=await getCrmLeads();
  assert.equal(initial.length,6);assert.equal(initial.find(l=>l.id==='hunter')?.in_hunter,true);
  for(const lead of initial){
   const full=crmLead(originals.get(lead.id)!);
   assert.equal(lead.prospect_assessment?.score,full.prospect_assessment?.score);
   assert.equal(hasQualifiedEmail(lead),hasQualifiedEmail(full));
  }
  assert.ok(initial.find(l=>l.id==='empty-facts')?.prospect_assessment);
  const pages: Awaited<ReturnType<typeof getCrmPage>>[]=[];
  for(const offset of [0,2,4])pages.push(await getCrmPage(2,offset));
  assert.ok(pages.every(page=>page.total===6&&page.data.length===2));
  assert.equal(new Set(pages.flatMap(page=>page.data.map(row=>row.id))).size,6);
  const saved=await setCrmContacted(['manual','platform','hunter','queued','manual'],true);
  assert.equal(saved.length,4);assert.equal(saved.find(l=>l.id==='manual')?.contacted_source,'MANUAL');
  assert.equal(saved.find(l=>l.id==='platform')?.contacted_source,'PLATFORM');assert.equal(saved.find(l=>l.id==='hunter')?.contacted_source,'HUNTER');
  await assert.rejects(setCrmContacted(['manual','hunter'],false));
  assert.equal((await client.query(`SELECT contacted FROM leads WHERE id='manual'`)).rows[0].contacted,true);
  await assert.rejects(setCrmContacted(['manual','missing'],false));
  assert.equal((await client.query(`SELECT contacted FROM leads WHERE id='manual'`)).rows[0].contacted,true);
  await assert.rejects(setCrmContacted(['dm'],false));
  assert.equal((await setCrmContacted(['manual'],false))[0].contacted_source,null);
 } finally {pool.query=query;await client.query('ROLLBACK');client.release();await pool.end();}
});
