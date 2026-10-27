'use strict';
const {Pool}=require('pg'),{randomUUID}=require('node:crypto');
require('@next/env').loadEnvConfig(require('node:path').resolve(__dirname,'../..'));
async function database(){
 const schema='compel_engine_test_'+randomUUID().replaceAll('-',''),raw=new Pool({connectionString:process.env.DATABASE_URL,max:5,connectionTimeoutMillis:10000,query_timeout:20000,ssl:{rejectUnauthorized:false}});
 const names='compel_adspower_config|compel_adspower_sessions|compel_worker_events|compel_worker_config|compel_linkedin_accounts|compel_worker_usage|compel_worker_profile_usage|compel_worker_account_profiles|compel_worker_day|compel_worker_sessions|compel_worker_jobs|compel_research_budget|compel_prospect_runs|compel_research_runtime|compel_engine_agents|leads';
 const qualify=sql=>sql.replace(new RegExp('\\b('+names+')\\b','g'),`"${schema}".$1`);
 const pool={query:(sql,args)=>raw.query(qualify(sql),args),connect:async()=>{const c=await raw.connect();return {query:(sql,args)=>c.query(qualify(sql),args),release:()=>c.release()};}};
 await raw.query(`CREATE SCHEMA "${schema}"`);
 return {pool,close:async()=>{if(!/^compel_engine_test_[a-f0-9]{32}$/.test(schema))throw Error('Invalid test schema');await raw.query(`DROP SCHEMA "${schema}" CASCADE`);await raw.end();}};
}
module.exports={database};
