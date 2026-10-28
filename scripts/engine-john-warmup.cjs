'use strict';
// This single-use authorization was explicitly granted by the user on 28 Oct.
// The existing agent performs all browser actions; this CLI never attaches CDP.
const fs=require('node:fs'),path=require('node:path'),exp=require('../src/lib/worker-warmup-experiment.cjs');
async function main(){
 if(process.env.VERCEL)throw Error('Warmup is local only.');
 const [command='report']=process.argv.slice(2);if(!['prepare','start','report','watch','cancel'].includes(command))throw Error('Use prepare, start, report, watch or cancel.');
 const pool=require('./engine-benchmark.cjs').poolForRoot(path.resolve(__dirname,'..')),core=require('../src/lib/linkedin-workers.cjs'),dir=path.resolve(__dirname,'../data/engine-v2/john-warmup');fs.mkdirSync(dir,{recursive:true});
 // One dedicated LISTEN connection and one bounded reporting connection.
 pool.options.max=2;
 const output=b=>{fs.writeFileSync(path.join(dir,'experiment-report.json'),JSON.stringify(b,null,2));console.log(JSON.stringify({id:b?.id,state:b?.state,requested:b?.requested_count,attempts:b?.report?.attempts?.length,visits:b?.report?.visits?.length,lastVisited:b?.report?.lastVisited,reason:b?.report?.reason,traffic:b?.report?.traffic}));};
 try{
  if(command==='prepare'){
   const candidates=(await core.queueCandidates(pool)).slice(0,20);if(candidates.length!==20)throw Error('Need 20 eligible, distinct CRM Inbox profiles.');
   const sourceIds=candidates.map(x=>x.id),digests=(await pool.query('SELECT id,md5(to_jsonb(l)::text) AS digest FROM leads l WHERE id=ANY($1::text[]) ORDER BY id',[sourceIds])).rows;
   output(await exp.prepare(pool,candidates.map(x=>core.profileUrl(x.linkedin_url)),{leadIds:sourceIds,beforeDigests:digests}));return;
  }
  if(command==='start'){output(await exp.start(pool));return;}
  if(command==='cancel'){await exp.cancel(pool);output(await exp.load(pool));return;}
  let b=await exp.load(pool);if(!b)throw Error('Prepare the experiment first.');output(b);
  if(command==='watch'){
   const c=await pool.connect();let wake=null;try{await c.query('LISTEN compel_engine_wake');c.on('notification',()=>wake?.());let previous=JSON.stringify([b.state,b.report.attempts.length,b.report.visits.length]);
    while(['WARMUP_AUTHORIZED','WARMUP_RUNNING'].includes(b.state)){
     await new Promise(resolve=>{const t=setTimeout(()=>{wake=null;resolve();},45000);wake=()=>{clearTimeout(t);wake=null;resolve();};});
     b=await exp.load(pool);const signature=JSON.stringify([b.state,b.report.attempts.length,b.report.visits.length]);if(signature!==previous){output(b);previous=signature;}
     else console.log(JSON.stringify({state:b.state,visits:b.report.visits.length,waiting:true,expiresAt:b.report.expiresAt}));
    }
   }finally{c.release();}
  }
  if(b.report.source?.leadIds){const after=(await pool.query('SELECT id,md5(to_jsonb(l)::text) AS digest FROM leads l WHERE id=ANY($1::text[]) ORDER BY id',[b.report.source.leadIds])).rows;const unchanged=JSON.stringify(after)===JSON.stringify(b.report.source.beforeDigests);await pool.query('UPDATE compel_engine_batches SET report=report||$2::jsonb WHERE id=$1',[exp.ID,JSON.stringify({crmUnchanged:unchanged,afterDigests:after})]);b=await exp.load(pool);output(b);console.log(JSON.stringify({crmUnchanged:unchanged}));}
 }finally{await pool.end();}
}
if(require.main===module)main().catch(e=>{console.error(e.code||e.name,e.message);process.exitCode=1;});
module.exports={main};
