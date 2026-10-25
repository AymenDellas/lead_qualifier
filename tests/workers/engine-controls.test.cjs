'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const core=require('../../src/lib/linkedin-workers.cjs'),{controlEngine}=require('../../src/lib/engine-controls.cjs');

test('Resume authorizes configured account sessions, Pause persists the stop, and held accounts stay held',async()=>{
 const originals={settings:core.settings,start:core.startProcessing,pause:core.pauseProcessing};
 const calls=[],accounts=[{id:'one',label:'Fixture one',enabled:true,connectedAt:'confirmed',processingEnabled:false},{id:'held',label:'Fixture held',enabled:true,attentionReason:'Security review',processingEnabled:false},{id:'unselected',label:'Fixture unselected',enabled:true,processingEnabled:false}];
 let supervisorOnline=true;
 try {
  core.settings=async()=>({activeCount:2,supervisorOnline,accounts});
  core.startProcessing=async(_pool,id,minutes)=>{assert.equal(minutes,60);const account=accounts.find(a=>a.id===id);if(account.attentionReason)throw Error('Resolve the account review first.');account.processingEnabled=true;calls.push(['start',id]);};
  core.pauseProcessing=async(_pool,id)=>{accounts.find(a=>a.id===id).processingEnabled=false;calls.push(['pause',id]);};
  const resumed=await controlEngine({},'resume');assert.deepEqual(resumed.updated,['one']);assert.equal(resumed.blocked[0].id,'held');assert.equal(accounts[1].attentionReason,'Security review');assert.equal(accounts[2].processingEnabled,false);
  await controlEngine({},'pause');assert.deepEqual(calls,[['start','one'],['pause','one']]);assert.ok(accounts.every(a=>!a.processingEnabled));
  supervisorOnline=false;await assert.rejects(controlEngine({},'resume'),/Workers are offline/);assert.equal(calls.length,2);
  await assert.rejects(controlEngine({},'login'),/Resume or Pause/);
  supervisorOnline=true;accounts[0].attentionReason='Review';await assert.rejects(controlEngine({},'resume'),/Resolve the account review/);assert.equal(calls.length,2);
 } finally {Object.assign(core,{settings:originals.settings,startProcessing:originals.start,pauseProcessing:originals.pause});}
});
