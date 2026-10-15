'use strict';
// Runs inside the account's leased worker browser, never the user's browser.
async function signOut(browser,log=()=>{}) {
 const page=await browser.newPage();
 try { await page.goto('https://www.linkedin.com/m/logout/',{waitUntil:'domcontentloaded',timeout:30000}); }
 catch { log('LinkedIn logout page unavailable; clearing this worker session locally.'); }
 const isLinkedIn=cookie=>/(^|\.)linkedin\.com$/i.test(cookie.domain);
 const cookies=(await browser.cookies()).filter(isLinkedIn);
 if(cookies.length)await browser.deleteCookie(...cookies);
 if((await browser.cookies()).some(cookie=>isLinkedIn(cookie)&&cookie.name==='li_at'))throw new Error('LinkedIn authentication cookie was not cleared.');
 // A fresh navigation confirms the saved session cannot reopen the feed.
 await page.goto('https://www.linkedin.com/feed/',{waitUntil:'domcontentloaded',timeout:45000});
 const url=new URL(page.url());
 if(!/(^|\.)linkedin\.com$/i.test(url.hostname)||!/^\/(?:login|uas|authwall|signup)(?:\/|$)/.test(url.pathname))
  throw new Error('LinkedIn did not confirm the logged-out session. Try signing out again.');
 log('LinkedIn signed out; login page confirmed.');
}
module.exports={signOut};
