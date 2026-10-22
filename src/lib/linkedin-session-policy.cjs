'use strict';

// Classify explicit LinkedIn account signals, not arbitrary third-party assets
// or wording in a member's post. This is a stop mechanism, not bot evasion.
function pageSignal({url='',status=0,text='',manual=false}={}) {
 let path;
 try { const u=new URL(url);if(!/(^|\.)linkedin\.com$/i.test(u.hostname))return null;path=u.pathname; }catch{return null;}
 if(status===429)return {code:'LINKEDIN_RATE_LIMIT',reason:'LinkedIn reported a rate limit. Processing stopped; review the account before resuming.'};
 if([403,999].includes(status)||/your account (?:has been |is )(?:temporarily |permanently )?(?:restricted|suspended)|we.ve (?:temporarily )?restricted your account|automated (?:activity|software).*?(?:detected|prohibited)/i.test(text))
  return {code:'LINKEDIN_AUTH',reason:'LinkedIn reported an access restriction. Processing stopped; resolve the account notice before reconnecting.'};
 if(/^\/(?:checkpoint|challenge)(?:\/|$)/i.test(path))return {code:'LINKEDIN_AUTH',reason:'LinkedIn requires a security check. Processing stopped; complete the check manually.'};
 if(!manual&&(status===401||/^\/(?:login|uas|authwall|signup)(?:\/|$)/i.test(path)))return {code:'LINKEDIN_AUTH',reason:'LinkedIn sign-in is required. Processing stopped; use manual sign-in.'};
 return null;
}
function failure(signal) {return {...signal,stage:'linkedin',retryable:false};}
function isFeed(value){try{const u=new URL(value);return u.protocol==='https:'&&/(^|\.)linkedin\.com$/i.test(u.hostname)&&/^\/feed(?:\/|$)/.test(u.pathname);}catch{return false;}}
function sameMember(a,b){
 if(!a||!b)return false;
 if(a.memberUrn&&b.memberUrn)return a.memberUrn===b.memberUrn;
 return !!a.profileUrl&&!!b.profileUrl&&a.profileUrl.toLowerCase().replace(/\/$/,'')===b.profileUrl.toLowerCase().replace(/\/$/,'');
}
module.exports={pageSignal,failure,isFeed,sameMember};
