'use strict';
const fsDefault=require('node:fs'),path=require('node:path');
async function importLegacyFiles(pool,root,{core=require('./linkedin-workers.cjs'),fs=fsDefault,log=()=>{}}={}) {
 const ids=new Set((await pool.query('SELECT id FROM compel_worker_jobs')).rows.map(row=>row.id));
 const directory=path.join(root,'queue');
 if(fs.existsSync(directory))for(const name of fs.readdirSync(directory).filter(n=>/^job_[a-z0-9_-]+\.json$/i.test(n))) {
  const file=path.join(directory,name),id=name.slice(0,-5);
  try {
   // A cancelled or completed database job must never re-enter the queue just
   // because a disk recovery file still exists from the old worker.
   if(!ids.has(id)) {
    const job=JSON.parse(fs.readFileSync(file,'utf8'));
    if(job.jobId!==id)throw Error('Recovery filename does not match its job ID.');
    const outcome=await core.enqueue(pool,[job.linkedinUrl],{...job,jobId:id});
    if(!outcome.jobs.length&&!outcome.skipped.some(s=>s.reason==='Already queued'||/already.*today/i.test(s.reason)))continue;
    ids.add(id);
   }
   if(!fs.existsSync(file+'.migrated'))fs.renameSync(file,file+'.migrated');
  }catch(error){log('Legacy queue recovery file retained: '+error.message);}
 }
 const results=path.join(root,'queue-results');
 if(fs.existsSync(results))for(const name of fs.readdirSync(results).filter(n=>/^job_[a-z0-9_-]+\.json$/i.test(n))) {
  if(ids.has(name.slice(0,-5)))continue;
  try{await core.importResult(pool,name.slice(0,-5),JSON.parse(fs.readFileSync(path.join(results,name),'utf8')));}
  catch(error){log('Legacy result retained on disk: '+error.message);}
 }
}
module.exports={importLegacyFiles};
