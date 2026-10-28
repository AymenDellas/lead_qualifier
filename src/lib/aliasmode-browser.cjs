'use strict';
const {profileId,providerError}=require('./aliasmode-client.cjs');
const ownership=new Map();
function createAliasModeBrowser({account,owner,pool,provider,puppeteer=require('puppeteer'),onDisconnect=()=>{},onStage=()=>{}}){
 const id=profileId(account.aliasmode_profile_id),store=provider.store,api=provider.client;
 let entry=null,opening=null,openingMode=null,closing=null,cancelled=false;
 const assertOwner=()=>store.assertOwner(pool,account,owner);
 const isOpen=()=>!!entry?.browser?.isConnected()&&!entry.page?.isClosed();
 async function persist(){if(entry)await store.saveSession(pool,account,owner,{managed:entry.managed,headless:entry.headless,pid:entry.pid,targetId:entry.targetId});}
 async function detach(release=true){if(entry){entry.expected=true;if(entry.listener)entry.browser?.off?.('disconnected',entry.listener);try{await entry.browser?.disconnect();}catch{}entry=null;}if(release&&ownership.get(id)===owner)ownership.delete(id);}
 async function stopProfile(force=false){
  await assertOwner();if(!force&&!entry?.managed){await detach();await store.finishSession(pool,account,owner);return;}
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
 function open({headless=account.launch_mode==='headless'}={}){
  if(closing)return Promise.reject(providerError('ALIASMODE_CLOSING','This profile is closing. Wait for confirmation before reopening.'));
  if(typeof headless!=='boolean')return Promise.reject(providerError('ALIASMODE_MODE_UNVERIFIED','Choose a supported browser mode.'));
  if(opening)return openingMode===headless?opening:Promise.reject(providerError('ALIASMODE_MODE_CONFLICT','A different browser mode is still opening. Wait for it to finish.'));
  if(isOpen()&&entry.headless===headless)return Promise.resolve({browser:entry.browser,page:entry.page});
  if(ownership.has(id)&&ownership.get(id)!==owner)return Promise.reject(providerError('ALIASMODE_PROFILE_BUSY','This AliasMode profile already has an automation owner.'));
  cancelled=false;openingMode=headless;ownership.set(id,owner);
  opening=(async()=>{
   let started=false,startedPort=null,ownedEndpoint=null,browser=null,createdPage=null;
   const check=async()=>{await assertOwner();if(cancelled)throw providerError('ALIASMODE_OPEN_CANCELLED','Profile opening was cancelled. Queued work is retained.');};
   const modeConflict=()=>providerError('ALIASMODE_MODE_CONFLICT','This profile is open in a different mode and its browser ownership is unverified. Use Close profile, then Verify session or Start again.');
   try{
    if(isOpen()&&entry.headless!==headless){if(!entry.managed)throw modeConflict();await stopProfile(false);ownership.set(id,owner);}else if(entry)await detach(false);
    await check();onStage('ALIASMODE_CHECK','Checking the bound AliasMode profile and browser mode.');const saved=await store.session(pool,id);let state=await (api.inspect||api.active)(id);
    let previous=saved?.account_id===account.id&&!saved.closed_at?saved:null;
    if(state.active&&typeof state.headless!=='boolean')throw providerError('ALIASMODE_MODE_UNVERIFIED','AliasMode did not confirm the running browser mode. Check its helper and profile before processing.');
    if(state.active&&state.headless!==headless){
     if(!previous?.managed||!previous.target_id||!previous.pid)throw modeConflict();
     // A saved managed flag alone cannot authorize closing a replacement human
     // browser. Verify both its live PID and our recorded worker target first.
     browser=await puppeteer.connect({browserWSEndpoint:state.endpoint,defaultViewport:null,protocolTimeout:30000});await check();
     const pid=await resolvePid(browser),target=browser.targets().find(t=>t.type()==='page'&&t._targetId===previous.target_id);
     if(pid!==previous.pid||!target)throw modeConflict();
     entry={browser,page:await target.page(),pid,managed:true,headless:state.headless,targetId:previous.target_id,expected:true};
     await stopProfile(false);ownership.set(id,owner);browser=null;previous=null;state={active:false};
    }
    await check();if(!state.active){onStage('PROFILE_OPENING',headless?'Opening the saved AliasMode profile headlessly.':'Opening the saved AliasMode profile visibly for manual review.');
     try{state=await api.start(id,{headless});started=true;ownedEndpoint=state.endpoint;startedPort=Number(new URL(state.endpoint).port);}
     catch(error){
      // A timeout may occur after AliasMode actually launched the profile. Reconcile
      // before another start; do not guess ownership of that ambiguous instance.
      startedPort=error.startedProfilePort||null;
      if(['ALIASMODE_UNAVAILABLE','ALIASMODE_CLI_TIMEOUT','ALIASMODE_CLI_RACE'].includes(error.code)){const observed=await api.active(id).catch(()=>null);if(observed?.active){await store.saveSession(pool,account,owner,{managed:false,headless:null,pid:null,targetId:null});}}
      throw error;
     }
    }
    if(state.headless!==headless)throw providerError('ALIASMODE_MODE_UNVERIFIED','AliasMode did not confirm the requested browser mode. No LinkedIn work was started.');
    onStage('BROWSER_MODE_VERIFIED',headless?'Headless browser confirmed.':'Visible browser confirmed for manual review.');
    await check();onStage('CDP_ATTACHING','Attaching Puppeteer to the AliasMode browser.');
    browser=await puppeteer.connect({browserWSEndpoint:state.endpoint,defaultViewport:null,protocolTimeout:30000});await check();
    const version=await browser.version();if(!/chrome|chromium|sunbrowser/i.test(version))throw providerError('ALIASMODE_BROWSER_CORE','This integration requires an AliasMode Chromium profile (Firefox has no CDP).');
    const pid=await resolvePid(browser);await check();
    // Reuse only the recorded worker target. Never close or adopt arbitrary
    // restored tabs, and never create an incognito context without its cookies.
    const target=previous?.target_id?browser.targets().find(t=>t.type()==='page'&&t._targetId===previous.target_id):null;
    const page=target?await target.page():(createdPage=await browser.newPage());await check();
    const managed=started||previous?.managed===true&&previous.pid===pid&&!!target;
    entry={browser,page,pid,managed,headless:state.headless,targetId:page.target()._targetId,expected:false};
    entry.listener=()=>{if(entry?.browser===browser&&!entry.expected)onDisconnect(providerError('ALIASMODE_CDP_DISCONNECTED','AliasMode browser connection closed. The same profile will be reconciled; checkpoints are retained.'));};
    browser.on('disconnected',entry.listener);await persist();return {browser,page};
   }catch(error){
    if(entry)await detach(false);
    try{await createdPage?.close();}catch{}
    try{await browser?.disconnect();}catch{}
    let cleanupFailure=null;
    if(started||startedPort){try{await assertOwner();const observed=await api.active(id);if(observed.active){if(ownedEndpoint&&observed.endpoint!==ownedEndpoint||startedPort&&Number(new URL(observed.endpoint).port)!==startedPort)throw Error('Browser instance changed');await api.stop(id);if((await api.active(id)).active)throw Error('Still open');}await store.finishSession(pool,account,owner);}catch{cleanupFailure=providerError('ALIASMODE_CLEANUP_PENDING','The profile opened but attachment failed, and AliasMode closure is unconfirmed. Review that profile before retrying.');}}
    if(ownership.get(id)===owner)ownership.delete(id);entry=null;
    if(cleanupFailure)throw cleanupFailure;
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
