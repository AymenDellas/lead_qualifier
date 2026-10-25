'use strict';
const core=require('./linkedin-workers.cjs');
async function recheckFollowers(pool,ids,options={}){
 if(!Array.isArray(ids)||!ids.length||ids.length>500||ids.some(id=>typeof id!=='string'||!id||id.length>200))throw Error('Select 1–500 CRM leads.');
 await core.ensure(pool);
 const rows=(await pool.query('SELECT id,linkedin_url FROM leads WHERE id=ANY($1::text[]) ORDER BY id',[[...new Set(ids)]])).rows;
 const result=await core.enqueue(pool,rows.map(row=>row.linkedin_url),{explicitRetry:true,...(options.engineBatchId?{engineBatchId:options.engineBatchId}:{})});
 await pool.query("SELECT pg_notify('compel_engine_wake','')");return {...result,selected:rows.length};
}
module.exports={recheckFollowers};
