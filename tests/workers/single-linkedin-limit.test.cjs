'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {recordLinkedInAction}=require('../../src/lib/linkedin-workers.cjs');
test('action counts do not read or enforce old budgets, gaps, hours or rolling windows',async()=>{
 const calls=[],pool={query:async(sql,args)=>{
  calls.push(sql);assert.doesNotMatch(sql,/next_check_at|request_interval_seconds|activity_limits|working_hours|compel_worker_events|daily_request_limit/);
  if(sql.startsWith('SELECT 1 FROM compel_linkedin_accounts'))return {rowCount:1};
  assert.match(sql,/INSERT INTO compel_worker_usage/);return {rowCount:1,rows:[{request_count:100000}]};
 }};
 for(const kind of ['profile_page','contact','activity_page','identity','discovery']){
  const result=await recordLinkedInAction(pool,'account','owner',kind);assert.equal(result.request_count,100000);assert.equal(result.waitMs,undefined);
 }
 assert.equal(calls.length,10);
});
test('explicit pause still prevents a page action and manual checks stay identity-only',async()=>{
 const pool={query:async()=>({rowCount:0})};
 assert.equal((await recordLinkedInAction(pool,'a','o','profile_page')).stopped,true);
 await assert.rejects(recordLinkedInAction(pool,'a','o','contact',{manual:true}),/only verify/);
});
