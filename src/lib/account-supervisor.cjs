'use strict';
const path=require('node:path');
function createAccountSupervisor({root,pool,core,fork,stopChild,log=()=>{}}) {
 const children=new Map();let stopping=false,busy=false;
 // A child that exits is not automatically relaunched. A new explicit action
 // changes its command token; a dashboard refresh or settings edit does not.
 const command=a=>a.logout_token?'logout:'+a.logout_token:a.login_token?'connect:'+a.login_token:a.authorized?'start:'+(a.processing_token||a.processing_until):'';
 async function tick() {
  if(stopping||busy)return;busy=true;
  try {
   await pool.query('UPDATE compel_worker_config SET supervisor_seen_at=NOW() WHERE id=1');
   await core.expireLoginRequests(pool);
   const accounts=(await pool.query(`SELECT a.*,a.changed_at::text AS control_version,a.processing_until::text AS processing_token,a.login_requested_at::text AS login_token,a.logout_requested_at::text AS logout_token,
    (a.processing_enabled AND a.processing_until>NOW()) AS authorized FROM compel_linkedin_accounts a WHERE archived IS FALSE ORDER BY position,id`)).rows;
   const rows=new Map(accounts.map(a=>[a.id,a]));
   for(const [id,entry]of children) {
    const a=rows.get(id);
    if(entry.child&&(!a||!a.enabled&&!a.login_token&&!a.logout_token)) {
     await stopChild(entry.child);entry.child=null;
    }
   }
   for(const a of accounts) {
    const entry=children.get(a.id)||{child:null,command:''};children.set(a.id,entry);
    const next=command(a);entry.version=a.control_version;
    if(entry.child) {if(next)entry.command=next;continue;}
    if(!next||next===entry.command||a.attention_reason&&!a.login_token&&!a.logout_token)continue;
    if(!a.enabled&&!a.login_token&&!a.logout_token)continue;
    entry.command=next;
    const child=fork(path.join(root,'worker.cjs'),['--account',a.id],{cwd:root,windowsHide:true,stdio:['ignore','inherit','inherit','ipc']});
    entry.child=child;log('Opened session host for '+a.label+'.');
    child.once('error',error=>log('Account host error: '+error.message));
    child.once('exit',()=>{
     if(entry.child===child)entry.child=null;
     if(!stopping)void core.pauseProcessing(pool,a.id,'The local account host stopped. Start explicitly to continue.',false,null,entry.version).catch(error=>log(error.message));
    });
   }
  }finally{busy=false;}
 }
 async function close() {
  stopping=true;
  await Promise.allSettled([...children.values()].filter(e=>e.child).map(e=>stopChild(e.child)));
 }
 return {tick,close,children};
}
module.exports={createAccountSupervisor};
