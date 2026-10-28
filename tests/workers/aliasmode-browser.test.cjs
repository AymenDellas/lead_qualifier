'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {createAliasModeBrowser}=require('../../src/lib/aliasmode-browser.cjs');
let fixtureId=0;
function fixture({active=false,saved=null,headless=true}={}){
 const id='fixture-'+(++fixtureId),account={id,aliasmode_profile_id:id,binding_revision:0,launch_mode:'headless'},owner='owner-'+id;
 let row=saved?{...saved,account_id:id}:null,allowed=true,connected=false,stopWorks=true,connectError=false,startGate=null;
 const calls=[],browser=new EventEmitter(),page={isClosed:()=>false,bringToFront:async()=>{},close:async()=>calls.push('page.close'),target:()=>({_targetId:'compel-tab'})};
 browser.isConnected=()=>connected;browser.version=async()=> 'Chrome/146';browser.disconnect=async()=>{calls.push('disconnect');connected=false;browser.emit('disconnected');};browser.close=async()=>assert.fail('Never close an attached browser through CDP');
 browser.targets=()=>[{type:()=> 'page',_targetId:'human-tab',page:async()=>assert.fail('Do not adopt a human tab')},...(row?.target_id==='compel-tab'?[{type:()=> 'page',_targetId:'compel-tab',page:async()=>page}]:[])];
 browser.newPage=async()=>{calls.push('newPage');return page;};browser.target=()=>({createCDPSession:async()=>({send:async()=>({processInfo:[{type:'browser',id:12345}]}),detach:async()=>{}})});
 const store={assertOwner:async()=>{if(!allowed)throw Object.assign(Error('Ownership changed'),{failure:{stage:'provider'},code:'ALIASMODE_OWNERSHIP_CHANGED'});},session:async()=>row,saveSession:async(_p,a,o,value)=>{row={account_id:a.id,owner:o,...value,target_id:value.targetId};},finishSession:async()=>{if(row)row.closed_at='closed';}};
 const api={active:async()=>{calls.push('active');return {active,...(active?{headless,endpoint:'ws://127.0.0.1:9222/devtools/browser/fixture'}:{})};},start:async(_id,options)=>{headless=options.headless;calls.push('start');if(startGate)await startGate;active=true;return {active:true,headless,endpoint:'ws://127.0.0.1:9222/devtools/browser/fixture'};},stop:async()=>{calls.push('stop');if(stopWorks)active=false;}};
 const options={account,owner,pool:{},provider:{store,client:api},puppeteer:{connect:async settings=>{calls.push('connect');assert.equal(settings.defaultViewport,null);if(connectError)throw Error('Connection refused');connected=true;return browser;}}};
 return {account,options,calls,browser,page,get row(){return row;},get active(){return active;},set allowed(v){allowed=v;},set stopWorks(v){stopWorks=v;},set connectError(v){connectError=v;},set startGate(v){startGate=v;}};
}
test('visible is the default and explicit headless configuration remains supported',async()=>{
 const f=fixture();delete f.account.launch_mode;const b=createAliasModeBrowser(f.options);await b.open();assert.equal(b.isHeadless(),false);await b.open({headless:false});assert.equal(f.calls.filter(v=>v==='connect').length,1);await b.recycle();
});
test('closed profiles start through AliasMode and concurrent opens share one CDP connection and tab',async()=>{
 const f=fixture(),b=createAliasModeBrowser(f.options);const [one,two]=await Promise.all([b.open(),b.open()]);assert.equal(one,two);assert.equal(b.pid(),12345);assert.equal(b.isHeadless(),true);assert.deepEqual(f.calls,['active','start','connect','newPage']);await b.close();assert.equal(f.active,true);
});
test('an already-open manual profile retains human tabs and is only disconnected on cleanup',async()=>{
 const f=fixture({active:true}),b=createAliasModeBrowser(f.options);await b.open();assert.equal(b.isHeadless(),true);assert.equal(f.calls.includes('start'),false);await b.recycle();assert.equal(f.active,true);assert.equal(f.calls.includes('stop'),false);
});
test('successful processing adoption authorizes managed recycling through the API',async()=>{
 const f=fixture({active:true}),b=createAliasModeBrowser(f.options);await b.open();await b.adopt();await b.recycle();assert.equal(f.active,false);assert.equal(f.row.closed_at,'closed');assert.equal(b.isOpen(),false);
});
test('explicit close stops the selected profile even when it originally opened manually',async()=>{
 const f=fixture({active:true}),b=createAliasModeBrowser(f.options);await b.open();await b.stop();assert.equal(f.active,false);assert.equal(f.calls.filter(c=>c==='stop').length,1);assert.ok(f.calls.indexOf('page.close')<f.calls.indexOf('stop'));
});
test('attachment failure never closes a previously opened manual profile',async()=>{
 const f=fixture({active:true});f.connectError=true;const b=createAliasModeBrowser(f.options);await assert.rejects(b.open(),e=>e.code==='ALIASMODE_CDP_CONNECT');assert.equal(f.calls.includes('stop'),false);assert.equal(f.active,true);
});
test('attachment failure cleans up a profile this operation started through AliasMode',async()=>{
 const f=fixture();f.connectError=true;await assert.rejects(createAliasModeBrowser(f.options).open(),e=>e.code==='ALIASMODE_CDP_CONNECT');assert.equal(f.active,false);assert.equal(f.calls.includes('stop'),true);
});
test('different automation owners cannot attach to the same profile concurrently',async()=>{
 const f=fixture(),one=createAliasModeBrowser(f.options),two=createAliasModeBrowser({...f.options,owner:'other'});await one.open();await assert.rejects(two.open(),e=>e.code==='ALIASMODE_PROFILE_BUSY');await one.close();
});
test('cancelling a pending start releases the connection and closes only the newly started profile',async()=>{
 let release;const f=fixture();f.startGate=new Promise(resolve=>{release=resolve;});const b=createAliasModeBrowser(f.options),opening=b.open();await new Promise(resolve=>setImmediate(resolve));const closing=b.close();release();await assert.rejects(opening,e=>e.code==='ALIASMODE_OPEN_CANCELLED');await closing;assert.equal(f.active,false);assert.equal(b.isOpen(),false);
});
test('ownership loss blocks API stop while disconnection remains available',async()=>{
 const f=fixture(),b=createAliasModeBrowser(f.options);await b.open();f.allowed=false;await assert.rejects(b.stop(),e=>e.code==='ALIASMODE_OWNERSHIP_CHANGED');assert.equal(f.calls.includes('stop'),false);await b.disconnect();assert.equal(f.active,true);
});
test('unconfirmed profile closure retains the connected owner and does not reopen another instance',async()=>{
 const f=fixture(),b=createAliasModeBrowser(f.options);await b.open();f.stopWorks=false;await assert.rejects(b.stop(),e=>e.code==='ALIASMODE_STOP_PENDING');assert.equal(b.isOpen(),true);await b.open();assert.equal(f.calls.filter(c=>c==='start').length,1);await b.close();
});
test('a recorded worker tab is reused after reconnection without selecting other restored tabs',async()=>{
 const f=fixture({active:true,saved:{managed:true,headless:true,pid:12345,target_id:'compel-tab'}}),b=createAliasModeBrowser(f.options);await b.open();assert.equal(f.calls.includes('newPage'),false);await b.close();
});

test('a provider lifecycle transition never launches a competing profile instance',async()=>{
 const f=fixture();f.options.provider.client.active=async()=>{throw Object.assign(Error('Profile starting'),{code:'ALIASMODE_LIFECYCLE_STARTING',failure:{stage:'provider'}});};
 await assert.rejects(createAliasModeBrowser(f.options).open(),e=>e.code==='ALIASMODE_LIFECYCLE_STARTING');assert.equal(f.calls.includes('start'),false);
});
test('intentional provider closure does not report an unexpected disconnect',async()=>{
 const f=fixture();let failures=0;f.options.onDisconnect=()=>failures++;const original=f.options.provider.client.stop;f.options.provider.client.stop=async()=>{f.browser.emit('disconnected');await original();};
 const b=createAliasModeBrowser(f.options);await b.open();await b.stop();assert.equal(failures,0);
});

test('owned mode changes close before reopening and record the actual mode',async()=>{
 const f=fixture(),b=createAliasModeBrowser(f.options);await b.open();await b.open({headless:false});assert.equal(b.isHeadless(),false);assert.equal(f.calls.filter(c=>c==='start').length,2);assert.equal(f.calls.filter(c=>c==='stop').length,1);assert.equal(f.row.headless,false);await b.close();
});
test('an externally opened visible profile cannot silently become headless processing or be stopped',async()=>{
 const f=fixture({active:true,headless:false}),b=createAliasModeBrowser(f.options);await assert.rejects(b.open(),e=>e.code==='ALIASMODE_MODE_CONFLICT');assert.equal(f.calls.includes('stop'),false);assert.equal(f.calls.includes('start'),false);assert.equal(f.calls.includes('newPage'),false);
});
test('a saved managed flag cannot authorize closing a replacement browser',async()=>{
 const f=fixture({active:true,headless:false,saved:{managed:true,headless:false,pid:999,target_id:'compel-tab'}}),b=createAliasModeBrowser(f.options);await assert.rejects(b.open(),e=>e.code==='ALIASMODE_MODE_CONFLICT');assert.equal(f.calls.includes('stop'),false);assert.equal(f.calls.includes('page.close'),false);assert.equal(f.calls.includes('disconnect'),true);
});
test('a verified saved PID and worker target permit mode recovery after agent restart',async()=>{
 const f=fixture({active:true,headless:false,saved:{managed:true,headless:false,pid:12345,target_id:'compel-tab'}}),b=createAliasModeBrowser(f.options);await b.open();assert.equal(b.isHeadless(),true);assert.equal(f.calls.filter(c=>c==='stop').length,1);assert.equal(f.calls.filter(c=>c==='start').length,1);await b.close();
});
test('missing live mode evidence blocks attachment even if saved mode claims headless',async()=>{
 const f=fixture({active:true,saved:{managed:true,headless:true,pid:12345,target_id:'compel-tab'}});f.options.provider.client.active=async()=>({active:true,endpoint:'ws://127.0.0.1:9222/devtools/browser/fixture'});
 await assert.rejects(createAliasModeBrowser(f.options).open(),e=>e.code==='ALIASMODE_MODE_UNVERIFIED');assert.equal(f.calls.includes('connect'),false);assert.equal(f.calls.includes('stop'),false);
});
test('a wrong-mode CLI launch receipt is cleaned up only at its confirmed port',async()=>{
 const f=fixture();f.options.provider.client.start=async()=>{f.options.provider.client.active=async()=>({active:true,headless:false,endpoint:'ws://127.0.0.1:9888/devtools/browser/replacement'});throw Object.assign(Error('Mode unverified'),{code:'ALIASMODE_MODE_UNVERIFIED',failure:{stage:'provider'},startedProfilePort:9222});};
 await assert.rejects(createAliasModeBrowser(f.options).open(),e=>e.code==='ALIASMODE_CLEANUP_PENDING');assert.equal(f.calls.includes('stop'),false);
});
