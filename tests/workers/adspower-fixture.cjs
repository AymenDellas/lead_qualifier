'use strict';
// Retained inactive AdsPower fixtures; active coverage lives in aliasmode-* files.
// 'use strict';
// // Local test-only AdsPower analogue. It launches disposable fixture Chrome and
// // exposes its real CDP endpoint. Production never falls back to this launcher.
// const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
// const {createAdsPowerBrowser}=require('../../src/lib/adspower-browser.cjs');
// async function fixture(){
//  const root=fs.mkdtempSync(path.join(os.tmpdir(),'compel-adspower-fixture-')),browsers=new Map(),sessions=new Map(),owners=[];
//  function create(id){
//   const account={id,adspower_profile_id:id,binding_revision:0},owner='fixture/'+id;
//   const api={active:async()=>{const b=browsers.get(id);return b?.isConnected()?{active:true,endpoint:b.wsEndpoint()}:{active:false};},start:async(_id,{headless})=>{const b=await require('puppeteer').launch({headless,userDataDir:path.join(root,id),defaultViewport:null});browsers.set(id,b);return {active:true,endpoint:b.wsEndpoint()};},stop:async()=>{const b=browsers.get(id);if(b)await b.close();browsers.delete(id);}};
//   const store={assertOwner:async()=>{},session:async()=>sessions.get(id)||null,saveSession:async(_p,a,o,value)=>sessions.set(id,{...value,target_id:value.targetId,account_id:a.id,owner:o}),finishSession:async()=>{const s=sessions.get(id);if(s)s.closed_at='closed';}};
//   const browser=createAdsPowerBrowser({account,owner,pool:{},provider:{client:api,store}});owners.push(browser);return browser;
//  }
//  async function close(){await Promise.allSettled(owners.map(o=>o.disconnect()));for(const b of browsers.values())await b.close().catch(()=>{});
//   const target=path.resolve(root),parent=path.resolve(os.tmpdir());if(path.dirname(target)!==parent||!path.basename(target).startsWith('compel-adspower-fixture-'))throw Error('Unsafe fixture cleanup');fs.rmSync(target,{recursive:true,force:true});
//  }
//  return {create,close,browsers,sessions,root};
// }
// module.exports={fixture};
