'use strict';
const core=require('./linkedin-workers.cjs');

// Engine buttons operate the same bounded account sessions as Manage accounts.
// Connecting or queueing never authorizes activity, and review holds are kept.
async function controlEngine(pool,action) {
 if(!['resume','pause'].includes(action))throw new Error('Choose Resume or Pause.');
 const config=await core.settings(pool),updated=[],blocked=[];
 if(action==='resume'&&!config.supervisorOnline)throw new Error('Workers are offline. Start workers before resuming processing.');
 const accounts=action==='pause'?config.accounts.filter(a=>a.processingEnabled):config.accounts.filter(a=>a.enabled&&!a.signedOut&&!a.logoutPending);
 if(action==='resume'&&!accounts.length)throw new Error('No accounts are selected to process. Enable an account and a processing slot in Manage accounts.');
 for(const account of accounts) {
  try {
   if(action==='resume')await core.startProcessing(pool,account.id);
   else await core.pauseProcessing(pool,account.id,'Processing paused from Engine. Pending profiles are retained.');
   updated.push(account.id);
  }catch(error){blocked.push({id:account.id,label:account.label,reason:error.message});}
 }
 if(blocked.length&&!updated.length)throw new Error(blocked.map(a=>`${a.label}: ${a.reason}`).join(' '));
 return {action,updated,blocked};
}
module.exports={controlEngine};
