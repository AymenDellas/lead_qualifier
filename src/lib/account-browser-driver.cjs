'use strict';
module.exports={createAccountDriver(){throw Error('Local Chrome launch is disabled. LinkedIn browsers are managed by AliasMode.');}};
// LEGACY CHROME REFERENCE — inactive; retained at the user’s request.
// 'use strict';
// // Keep plugin state per account, including when browsers launch concurrently.
// // The base Puppeteer revision still determines the pinned full Chrome binary.
// function createAccountDriver(base=require('puppeteer')){
//  const driver=base.default||base;
//  const launchContext=new(require('node:async_hooks').AsyncLocalStorage)();
//  // puppeteer-extra deep-clones launch options, which turns AbortSignal into
//  // an ordinary object. Restore the original signal at the actual launch
//  // boundary so Pause/Close can still cancel startup. Context is launch-local.
//  const extra=require('puppeteer-extra').addExtra({
//   defaultArgs:options=>driver.defaultArgs(options),
//   executablePath:()=>driver.executablePath(),
//   launch:options=>driver.launch({...options,signal:launchContext.getStore()?.signal}),
//  });
//  extra.use(require('puppeteer-extra-plugin-stealth')());
//  return {browserVersion:driver.browserVersion,configuration:driver.configuration,
//   executablePath:()=>driver.executablePath(),
//   launch:({signal,...options})=>launchContext.run({signal},()=>extra.launch(options)),
//   get plugins(){return extra.plugins;}};
// }
// module.exports={createAccountDriver};
//
