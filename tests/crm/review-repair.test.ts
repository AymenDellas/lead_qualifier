import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pool} from '../../src/lib/pg_setup';
import {research,prospect,NOW} from '../prospects/fixtures.cjs';
import {assessProspect} from '../../src/lib/prospect-qualification.cjs';
const core=require('../../src/lib/linkedin-workers.cjs');
const repair=require('../../scripts/engine-review-repair.cjs');

test('stored-evidence repairs are atomic, idempotent, preserve holds/contact history and stage only eligible refreshes',
 {skip:process.env.CRM_TEST_POSTGRES!=='1'},async()=>{
 const client=await pool.connect(),ensure=core.ensure,enqueue=core.enqueue;
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'compel-policy-repair-test-'));
 try{
  await client.query(`CREATE TEMP TABLE leads(id text PRIMARY KEY,linkedin_url text,email text,prospect_assessment jsonb,prospect_review jsonb,
   pipeline_status text,followers_check_status text,do_not_contact bool,contacted bool,contacted_source text,linkedin_dm_at timestamptz)`);
  await client.query('CREATE TEMP TABLE compel_linkedin_accounts(id text,processing_enabled bool,attention_reason text)');
  await client.query("INSERT INTO compel_linkedin_accounts VALUES('held',FALSE,'Security review required')");
  await client.query('CREATE TEMP TABLE case_study_prospects(id text,linkedin_url text,data jsonb)');
  await client.query('CREATE TEMP TABLE compel_worker_jobs(id text,payload jsonb)');
  await client.query(repair.SCHEMA.replace('CREATE TABLE IF NOT EXISTS','CREATE TEMP TABLE IF NOT EXISTS'));
  await client.query('SET search_path=pg_temp');
  const fixtures=[
   {id:'foreign',stage:'REVIEW',location:'Paris, France',followers:null,protected:false},
   {id:'missing',stage:'REVIEW',location:'Toronto, Canada',followers:null,protected:false},
   {id:'threshold',stage:'NOT_QUALIFIED',location:'Toronto, Canada',followers:{count:700,rawText:'700 followers',threshold:1000,checkedAt:NOW},protected:false},
   {id:'foreign-qualified',stage:'QUALIFIED',location:'Singapore, Singapore',followers:null,protected:false},
   {id:'protected',stage:'REVIEW',location:'Toronto, Canada',followers:null,protected:true},
   {id:'legacy-qualified',stage:'QUALIFIED',location:'Toronto, Canada',followers:null,protected:false},
  ];
  for(const f of fixtures){
   const url=`https://www.linkedin.com/in/repair-${f.id}/`,r=research({linkedinUrl:url,profileLocation:f.location,followers:f.followers,lastActivityAt:null});
   const value=prospect(f.id,{linkedin_url:url,prospect_assessment:assessProspect(r,{email:'ava@avamorgan.test',now:NOW})});
   await client.query(`INSERT INTO leads VALUES($1,$2,$3,$4,NULL,$5,'UNCHECKED',$6,$6,$7,NULL)`,
    [f.id,url,value.email,JSON.stringify(value.prospect_assessment),f.stage,f.protected,f.protected?'MANUAL':null]);
  }
  const before=(await client.query('SELECT id,email,do_not_contact,contacted,contacted_source,linkedin_dm_at FROM leads ORDER BY id')).rows;
  const tx={query:client.query.bind(client),connect:async()=>({query:client.query.bind(client),release:()=>{}})};
  core.ensure=async()=>{};
  let queued=0;
  core.enqueue=async(p:any,urls:string[],options:any)=>{
   assert.equal(options.explicitRetry,true);
   const jobs=[];for(const url of urls){const id='repair-job-'+(++queued);await p.query("INSERT INTO compel_worker_jobs VALUES($1,'{}')",[id]);jobs.push({id,url});}
   return {queued:jobs,skipped:[]};
  };
  const result=await repair.run(tx,{apply:true,queue:true,reportDirectory:directory});
  assert.equal(result.applied,5);assert.equal(result.queued.length,2);
  const rows=(await client.query('SELECT * FROM leads ORDER BY id')).rows;
  assert.equal(rows.find(r=>r.id==='foreign').pipeline_status,'NOT_QUALIFIED');
  assert.equal(rows.find(r=>r.id==='foreign-qualified').pipeline_status,'NOT_QUALIFIED');
  assert.equal(rows.find(r=>r.id==='threshold').pipeline_status,'REVIEW');
  assert.equal(rows.find(r=>r.id==='legacy-qualified').pipeline_status,'QUALIFIED');
  assert.deepEqual((await client.query('SELECT id,email,do_not_contact,contacted,contacted_source,linkedin_dm_at FROM leads ORDER BY id')).rows,before);
  assert.equal((await client.query('SELECT attention_reason,processing_enabled FROM compel_linkedin_accounts')).rows[0].attention_reason,'Security review required');
  assert.equal((await client.query('SELECT processing_enabled FROM compel_linkedin_accounts')).rows[0].processing_enabled,false);
  assert.ok((await client.query('SELECT payload FROM compel_worker_jobs')).rows.every(r=>r.payload.policyRepair));
  const again=await repair.run(tx,{apply:true,queue:true,reportDirectory:directory});
  assert.equal(again.applied,0);assert.equal(again.queued.length,0);assert.equal(queued,2);
  await client.query('UPDATE compel_linkedin_accounts SET processing_enabled=TRUE');
  await assert.rejects(repair.run(tx,{apply:true,reportDirectory:directory}),/Pause account processing/);
 }finally{
  core.ensure=ensure;core.enqueue=enqueue;
  await client.query('RESET search_path');client.release();await pool.end();
 }
});
