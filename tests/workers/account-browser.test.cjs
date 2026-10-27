'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createAccountBrowser}=require('../../src/lib/account-browser.cjs');
test('the compatibility browser entry point delegates only to AliasMode',()=>{assert.equal(createAccountBrowser,require('../../src/lib/aliasmode-browser.cjs').createAliasModeBrowser);});
test('missing or invalid AliasMode bindings fail without launching local Chrome',()=>{for(const id of [null,'../profile','https://other.test'])assert.throws(()=>createAccountBrowser({account:{id:'fixture',aliasmode_profile_id:id},provider:{},owner:'fixture'}),e=>e.code==='ALIASMODE_PROFILE_ID');});
// RETIRED LOCAL CHROME TESTS â€” retained as comments; AliasMode contracts replace these cases.
// 'use strict';
//
// const { test } = require('node:test');
// const assert = require('node:assert/strict');
// const path = require('node:path');
// const { EventEmitter } = require('node:events');
// const { createAccountBrowser } = require('../../src/lib/account-browser.cjs');
//
// let fixtureId = 0;
// function deferred() {
//     let resolve, reject;
//     const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
//     return { promise, resolve, reject };
// }
//
// function fixture() {
//     const root = path.resolve('isolated-account-browser-' + ++fixtureId);
//     const bundled=path.resolve('chrome-for-testing.exe');
//     const existing = new Set([bundled]), directories = [], launches = [], browsers = [], notices = [];
//     const fs = { existsSync: name => existing.has(name), mkdirSync: (name, options) => { directories.push({ name, options }); existing.add(name); } };
//     let launchGate = null, launchError = null, pageError = null, hangClose = false, killWorks = true;
//     const puppeteer = { configuration: {}, executablePath:()=>bundled, launch: async options => {
//         launches.push(options);
//         if (launchGate) await launchGate.promise;
//         if (launchError) throw launchError;
//         const browser = new EventEmitter(), child = new EventEmitter();
//         child.pid = 700 + launches.length; child.exitCode = null; child.signalCode = null; child.signals = [];
//         child.kill = signal => {
//             child.signals.push(signal);
//             if (killWorks) { child.signalCode = signal; child.emit('exit', null, signal); browser.connected = false; }
//             return killWorks;
//         };
//         browser.child = child; browser.connected = true; browser.closeCalls = 0; browser.newPageCalls = 0; browser.commands = []; browser.detaches = 0;
//         browser.isConnected = () => browser.connected;
//         browser.process = () => child;
//         browser.close = async () => {
//             browser.closeCalls++;
//             if (hangClose) return new Promise(() => {});
//             browser.connected = false; child.exitCode = 0; child.emit('exit', 0); browser.emit('disconnected');
//         };
//         browser.windowState='normal';browser.rectangle={left:100,top:80,width:1366,height:768};browser.windowCommands=[];browser.fronts=0;
//         browser.page = { isClosed: () => false,bringToFront:async()=>{browser.fronts++;},target:()=>({createCDPSession:async()=>({
//             send:async(command,args)=>{browser.windowCommands.push({command,args});if(command==='Browser.getWindowForTarget')return{windowId:37,bounds:{...browser.rectangle,windowState:browser.windowState}};if(args.bounds.windowState)browser.windowState=args.bounds.windowState;else Object.assign(browser.rectangle,args.bounds);},detach:async()=>{},
//         })}) };
//         browser.newPage = async () => { browser.newPageCalls++; if (pageError) throw pageError; return browser.page; };
//         browser.target = () => ({ createCDPSession: async () => ({
//             send: async (command, args) => {
//                 browser.commands.push({ command, args });
//                 if (command === 'Target.getTargets') return { targetInfos: [{ type: 'page', targetId: 'saved' }, { type: 'worker', targetId: 'worker' }] };
//                 if (command === 'Target.createTarget') return { targetId: 'keeper' };
//                 return { success: true };
//             },
//             detach: async () => { browser.detaches++; },
//         }) });
//         browser.disconnectUnexpectedly = () => { browser.connected = false; browser.emit('disconnected'); };
//         browsers.push(browser);
//         return browser;
//     } };
//     const options = { root, account: { id: 'legacy-0', profile_key: 'account-0' }, puppeteer, fs, closeTimeoutMs: 5, onDisconnect: error => notices.push(error) };
//     return { root, existing, directories, launches, browsers, notices, options, puppeteer,
//         set launchGate(value) { launchGate = value; }, set launchError(value) { launchError = value; },
//         set pageError(value) { pageError = value; }, set hangClose(value) { hangClose = value; }, set killWorks(value) { killWorks = value; } };
// }
//
// test('creation is inert; repeated and concurrent opens reuse one visible saved browser', async () => {
//     const f = fixture(), owner = createAccountBrowser(f.options);
//     assert.equal(owner.isOpen(), false); assert.equal(owner.get(), null);
//     assert.equal(f.launches.length, 0); assert.equal(f.directories.length, 0);
//     const [first, second] = await Promise.all([owner.open(), owner.open()]);
//     assert.equal(first, second); assert.equal(await owner.open(), first);
//     assert.equal(owner.get(), first); assert.equal(owner.isOpen(), true);
//     assert.equal(f.launches.length, 1); assert.equal(first.browser.newPageCalls, 1);
//     const options = f.launches[0];
//     assert.equal(options.userDataDir, path.join(f.root, '.browser-profiles', 'account-0'));
//     assert.equal(options.headless, true); assert.equal(options.channel, undefined); assert.equal(options.executablePath,path.resolve('chrome-for-testing.exe'));
//     assert.deepEqual(options.defaultViewport,{width:1366,height:768}); assert.deepEqual(options.args, ['--window-size=1366,768']);
//     assert.equal(options.handleSIGINT, false); assert.equal(options.handleSIGTERM, false);
//     assert.equal(options.waitForInitialPage, false);
//     assert.deepEqual(first.browser.commands, [
//         { command: 'Target.getTargets', args: undefined },
//         { command: 'Target.createTarget', args: { url: 'about:blank' } },
//         { command: 'Target.closeTarget', args: { targetId: 'saved' } },
//         { command: 'Target.closeTarget', args: { targetId: 'keeper' } },
//     ]);
//     assert.equal(first.browser.detaches, 1);
//     await owner.close();
// });
// test('background and reveal preserve the owned window geometry and keep Chrome rendering without minimizing',async()=>{
//  const f=fixture(),owner=createAccountBrowser(f.options),{browser}=await owner.open({headless:false});
//  browser.windowState='maximized';await owner.background();assert.equal(browser.windowState,'normal');assert.equal(browser.rectangle.left,-30000);
//  await owner.background();await owner.reveal();assert.equal(browser.windowState,'maximized');assert.equal(browser.fronts,1);assert.equal(browser.rectangle.left,100);assert.equal(browser.rectangle.top,80);
//  assert.equal(f.launches.length,1);assert.equal(f.launches[0].headless,false);assert.equal(browser.newPageCalls,1);assert.equal(browser.closeCalls,0);
//  assert.equal(browser.windowCommands.filter(c=>c.command==='Browser.setWindowBounds').length,5);
//  await owner.close();assert.equal(await owner.minimize(),false);
// });
// test('an unavailable window command does not close or relaunch its account browser',async()=>{
//  const f=fixture(),owner=createAccountBrowser(f.options),{browser,page}=await owner.open({headless:false});
//  page.target=()=>({createCDPSession:async()=>{throw Error('Window controls unavailable');}});
//  await assert.rejects(owner.minimize(),/Window controls unavailable/);assert.equal(owner.isOpen(),true);assert.equal(f.launches.length,1);await owner.close();
// });
//
// test('preserves existing legacy cookie paths even with a separate profile root', async () => {
//     const f = fixture(), legacy = path.join(f.root, '.browser-profiles', 'account-0');
//     f.existing.add(legacy);
//     const owner = createAccountBrowser({ ...f.options, profileRoot: path.resolve('separate-local-state') });
//     await owner.open(); assert.equal(f.launches[0].userDataDir, legacy); await owner.close();
//     const next = createAccountBrowser({ ...f.options, account: { profile_key: 'new-account' }, profileRoot: path.resolve('separate-local-state') });
//     await next.open(); assert.equal(f.launches[1].userDataDir, path.resolve('separate-local-state', 'new-account')); await next.close();
// });
//
// test('uses bundled Chrome for Testing instead of a configured system Chrome override', async () => {
//     const f = fixture(); f.puppeteer.configuration.executablePath = path.resolve('installed-chrome.exe');
//     const owner = createAccountBrowser(f.options); await owner.open();
//     assert.equal(f.launches[0].executablePath,path.resolve('chrome-for-testing.exe'));
//     assert.equal(f.launches[0].channel, undefined); await owner.close();
// });
//
// test('honors the CommonJS Puppeteer namespace default configuration', async () => {
//     const f = fixture(), executablePath = path.resolve('chrome-for-testing.exe');
//     const puppeteer = { default:f.puppeteer };
//     const owner = createAccountBrowser({ ...f.options, puppeteer }); await owner.open();
//     assert.equal(f.launches[0].executablePath, executablePath);
//     assert.equal(f.launches[0].channel, undefined); await owner.close();
// });
//
// test('normal close is idempotent, leaves saved state intact, and allows an explicit reopen', async () => {
//     const f = fixture(), owner = createAccountBrowser(f.options), { browser } = await owner.open();
//     await Promise.all([owner.close(), owner.close()]); await owner.close();
//     assert.equal(browser.closeCalls, 1); assert.deepEqual(browser.child.signals, []);
//     assert.equal(owner.get(), null); assert.equal(owner.isOpen(), false); assert.equal(f.notices.length, 0);
//     assert.equal(f.existing.has(f.launches[0].userDataDir), true);
//     await owner.open(); assert.equal(f.launches.length, 2); await owner.close();
// });
//
// test('unexpected disconnect notifies once and cannot silently relaunch', async () => {
//     const f = fixture(), owner = createAccountBrowser(f.options), { browser } = await owner.open();
//     browser.disconnectUnexpectedly(); browser.emit('disconnected');
//     assert.equal(f.notices.length, 1); assert.equal(f.notices[0].code, 'BROWSER_DISCONNECTED');
//     assert.equal(owner.get(), null); assert.equal(owner.isOpen(), false);
//     await assert.rejects(owner.open(), { code: 'BROWSER_DISCONNECTED' });
//     assert.equal(f.launches.length, 1); assert.equal(browser.closeCalls, 0);
//     await owner.close(); await owner.open(); assert.equal(f.launches.length, 2); await owner.close();
// });
//
// test('a closed page also requires explicit recovery without creating another page', async () => {
//     const f = fixture(), owner = createAccountBrowser(f.options), { browser, page } = await owner.open();
//     page.isClosed = () => true;
//     await assert.rejects(owner.open(), { code: 'BROWSER_DISCONNECTED' });
//     assert.equal(browser.newPageCalls, 1); await owner.close();
// });
//
// test('competing owners cannot open the same profile until its owner closes', async () => {
//     const f = fixture(), first = createAccountBrowser(f.options), second = createAccountBrowser(f.options);
//     await first.open(); await assert.rejects(second.open(), { code: 'BROWSER_PROFILE_IN_USE' });
//     assert.equal(f.launches.length, 1); await second.close(); assert.equal(first.isOpen(), true);
//     await first.close(); await second.open(); assert.equal(f.launches.length, 2); await second.close();
// });
//
// test('launch and page setup failures release ownership after cleaning up only their browser', async () => {
//     const f = fixture(), owner = createAccountBrowser(f.options);
//     f.launchError = new Error('Launch failed'); await assert.rejects(owner.open(), /Launch failed/);
//     assert.equal(owner.get(), null);
//     f.launchError = null; f.pageError = new Error('Page failed'); await assert.rejects(owner.open(), /Page failed/);
//     assert.equal(f.browsers[0].closeCalls, 1); assert.equal(f.browsers[0].detaches, 1);
//     f.pageError = null; await owner.open(); await owner.close();
// });
//
// test('a hung close is bounded and signals only the owned child process', async () => {
//     const f = fixture(), owner = createAccountBrowser(f.options), { browser } = await owner.open();
//     f.hangClose = true; await owner.close();
//     assert.deepEqual(browser.child.signals, ['SIGKILL']); assert.equal(owner.get(), null);
// });
//
// test('failed process termination retains ownership instead of allowing another browser', async () => {
//     const f = fixture(), owner = createAccountBrowser(f.options), other = createAccountBrowser(f.options);
//     await owner.open(); f.hangClose = true; f.killWorks = false;
//     await assert.rejects(owner.close(), { code: 'BROWSER_CLOSE_FAILED' });
//     await assert.rejects(other.open(), { code: 'BROWSER_PROFILE_IN_USE' });
//     f.killWorks = true; await owner.close(); await other.open(); await other.close();
// });
//
// test('close during launch aborts, returns promptly, and cleans up a late launch result', async () => {
//     const f = fixture(), gate = deferred(); f.launchGate = gate;
//     const owner = createAccountBrowser(f.options), opening = owner.open();
//     const outcome = assert.rejects(opening, { code: 'BROWSER_OPEN_CANCELLED' });
//     await owner.close(); assert.equal(f.launches[0].signal.aborted, true);
//     assert.equal(owner.isOpen(), false); gate.resolve(); await outcome;
//     assert.equal(f.browsers[0].closeCalls, 1); assert.equal(f.browsers[0].newPageCalls, 0);
//     f.launchGate = null; await owner.open(); await owner.close();
// });
//
// test('invalid profile keys fail before filesystem changes or browser launch', () => {
//     const f = fixture();
//     for (const profile_key of ['', '../account', '..\\account', '/account', 'C:\\account', 'account:stream']) {
//         assert.throws(() => createAccountBrowser({ ...f.options, account: { profile_key } }), { code: 'BROWSER_PROFILE_INVALID' });
//     }
//     assert.equal(f.launches.length, 0); assert.equal(f.directories.length, 0);
// });
// test('missing pinned Chrome for Testing fails before launch with a useful recovery action',async()=>{
//  const f=fixture();f.existing.delete(path.resolve('chrome-for-testing.exe'));const owner=createAccountBrowser(f.options);
//  await assert.rejects(owner.open(),error=>error.code==='CHROME_FOR_TESTING_MISSING'&&/puppeteer browsers install chrome/.test(error.message));assert.equal(f.launches.length,0);
// });
//
