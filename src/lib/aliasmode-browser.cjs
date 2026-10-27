'use strict';
const {profileId,providerError}=require('./aliasmode-client.cjs');
const ownership=new Map();
function createAliasModeBrowser({account,owner,pool,provider,puppeteer=require('puppeteer'),onDisconnect=()=>{},onStage=()=>{}}){
 const id=profileId(account.aliasmode_profile_id),store=provider.store,api=provider.client;
 let entry=null,opening=null,closing=null,cancelled=false;
 const assertOwner=()=>store.assertOwner(pool,account,owner);
 const isOpen=()=>!!entry?.browser?.isConnected()&&!entry.page?.isClosed();
 async function persist(){if(entry)await store.saveSession(pool,account,owner,{managed:entry.managed,headless:entry.headless,pid:entry.pid,targetId:entry.targetId});}
 async function detach(release=true){if(entry){entry.expected=true;entry.browser?.off?.('disconnected',entry.listener);try{await entry.browser?.disconnect();}catch{}entry=null;}if(release&&ownership.get(id)===owner)ownership.delete(id);}
 async function stopProfile(force=false){
  await assertOwner();const saved=await store.session(pool,id);if(!force&&!entry?.managed&&!saved?.managed){await detach();await store.finishSession(pool,account,owner);return;}
  // The lease/binding fence is required even when Chrome/CDP is disconnected.
  if(entry)entry.expected=true;
  try{
   // Do not restore another worker tab after every managed recycle. This is
   // only our recorded/created target; never close a restored human tab here.
   if(entry?.page&&!entry.page.isClosed())await entry.page.close().catch(()=>{});
   await assertOwner();
   await api.stop(id);const status=await api.active(id);if(status.active)throw providerError('ALIASMODE_STOP_PENDING','AliasMode has not confirmed profile closure. Check the profile before reopening.');
  }catch(error){if(entry)entry.expected=false;throw error;}
  await detach();await store.finishSession(pool,account,owner);
 }
 async function resolvePid(browser){
  const session=await browser.target().createCDPSession();try{const data=await session.send('SystemInfo.getProcessInfo'),pid=Number(data.processInfo?.find(p=>p.type==='browser')?.id);if(Number.isSafeInteger(pid)&&pid>0)return pid;throw Error('Missing browser PID');}
  catch{throw providerError('ALIASMODE_RESOURCE_ACCOUNTING','Cannot identify this AliasMode browser process for memory accounting. Check the Chromium/CDP version; the account remains paused.');}finally{await session.detach().catch(()=>{});}
 }
 function open({headless=true}={}){
  if(closing)return Promise.reject(providerError('ALIASMODE_CLOSING','This profile is closing. Wait for confirmation before reopening.'));
  if(opening)return opening;if(isOpen())return Promise.resolve({browser:entry.browser,page:entry.page});
  if(ownership.has(id)&&ownership.get(id)!==owner)return Promise.reject(providerError('ALIASMODE_PROFILE_BUSY','This AliasMode profile already has an automation owner.'));
  cancelled=false;ownership.set(id,owner);
  opening=(async()=>{
   let started=false,browser=null,createdPage=null;const check=async()=>{await assertOwner();if(cancelled)throw providerError('ALIASMODE_OPEN_CANCELLED','Profile opening was cancelled. Queued work is retained.');};
   try{
    if(entry)await detach(false);
    await check();onStage('ALIASMODE_CHECK','Checking the bound AliasMode profile.');const saved=await store.session(pool,id);let state=await api.active(id);
    const previous=saved?.account_id===account.id&&!saved.closed_at?saved:null;
    let managed=state.active&&previous?.managed===true,mode=state.active?(previous?.headless??null):null;
    await check();if(!state.active){onStage('PROFILE_OPENING','Opening the saved AliasMode profile.');
     try{state=await api.start(id,{headless});started=true;managed=true;mode=state.headless??null;}
     catch(error){
      // A timeout may occur after AliasMode actually launched the profile. Reconcile
      // before another start; do not guess ownership of that ambiguous instance.
      if(error.code==='ALIASMODE_UNAVAILABLE'){const observed=await api.active(id).catch(()=>null);if(observed?.active){await store.saveSession(pool,account,owner,{managed:false,headless:null,pid:null,targetId:null});}}
      throw error;
     }
    }
    await check();onStage('CDP_ATTACHING','Attaching Puppeteer to the AliasMode browser.');
    browser=await puppeteer.connect({browserWSEndpoint:state.endpoint,defaultViewport:null,protocolTimeout:30000});await check();
    const version=await browser.version();if(!/chrome|chromium|sunbrowser/i.test(version))throw providerError('ALIASMODE_BROWSER_CORE','This integration requires an AliasMode Chromium profile (Firefox has no CDP).');
    const pid=await resolvePid(browser);await check();
    // Reuse only the recorded worker target. Never close or adopt arbitrary
    // restored tabs, and never create an incognito context without its cookies.
    const target=previous?.target_id?browser.targets().find(t=>t.type()==='page'&&t._targetId===previous.target_id):null;
    const page=target?await target.page():(createdPage=await browser.newPage());await check();
    entry={browser,page,pid,managed,headless:mode,targetId:page.target()._targetId,expected:false};
    entry.listener=()=>{if(entry?.browser===browser&&!entry.expected)onDisconnect(providerError('ALIASMODE_CDP_DISCONNECTED','AliasMode browser connection closed. The same profile will be reconciled; checkpoints are retained.'));};
    browser.on('disconnected',entry.listener);await persist();return {browser,page};
   }catch(error){
    try{await createdPage?.close();}catch{}
    try{await browser?.disconnect();}catch{}
    if(started){try{await assertOwner();await api.stop(id);if((await api.active(id)).active)throw Error('Still open');await store.finishSession(pool,account,owner);}catch{throw providerError('ALIASMODE_CLEANUP_PENDING','The profile opened but attachment failed, and AliasMode closure is unconfirmed. Review that profile before retrying.');}}
    if(ownership.get(id)===owner)ownership.delete(id);entry=null;
    if(error.failure?.stage==='provider')throw error;throw providerError('ALIASMODE_CDP_CONNECT','Could not attach to the AliasMode profile. Check the browser core, Local API and CDP connection.');
   }
  })();const task=opening;task.finally(()=>{if(opening===task)opening=null;}).catch(()=>{});return task;
 }
 async function disconnect(){cancelled=true;if(opening)await opening.catch(()=>{});await detach();}
 function close(){if(closing)return closing;cancelled=true;closing=(async()=>{if(opening)await opening.catch(()=>{});await detach();})();const task=closing;task.finally(()=>{if(closing===task)closing=null;}).catch(()=>{});return task;}
 return {provider:'ALIASMODE',open,close,disconnect,isOpen,isHeadless:()=>entry?.headless??null,pid:()=>entry?.pid||null,
  get:()=>isOpen()?{browser:entry.browser,page:entry.page}:null,
  heartbeat:()=>{},recycle:()=>stopProfile(false),stop:()=>stopProfile(true),
  adopt:async()=>{await assertOwner();if(!entry)throw providerError('ALIASMODE_CDP_DISCONNECTED','The AliasMode session is disconnected.');entry.managed=true;await persist();},
  reveal:async()=>{if(!isOpen())return false;if(entry.headless===true)return false;await entry.page.bringToFront();return true;},background:async()=>false,
 };
}
module.exports={createAliasModeBrowser};
