'use strict';

// Classify explicit LinkedIn account signals, not arbitrary third-party assets
// or wording in a member's post. This is a stop mechanism, not bot evasion.
function pageSignal({url='',status=0,text='',manual=false}={}) {
 text=String(text).normalize('NFKC').replace(/[\u064b-\u065f\u0670\u061c\u200e\u200f]/g,'');
 let path;
 try { const u=new URL(url);if(!/(^|\.)(?:linkedin\.com|licdn\.com)$/i.test(u.hostname))return null;path=u.pathname; }catch{return null;}
 if(status===429)return {code:'LINKEDIN_RATE_LIMIT',reason:'LinkedIn returned HTTP 429 (rate limit). Processing stopped; review the account before resuming.'};
 if([403,999].includes(status)||/your account (?:has been |is )(?:temporarily |permanently )?(?:restricted|suspended)|we.ve (?:temporarily )?restricted your account|automated (?:activity|software).*?(?:detected|prohibited)|(?:تم (?:تقييد|تعليق|إيقاف) حسابك|حسابك (?:مقيد|معلق)|قيدنا حسابك)/i.test(text))
  return {code:'LINKEDIN_AUTH',reason:`LinkedIn reported an access restriction${status?' (HTTP '+status+')':''}. Processing stopped; resolve the account notice before reconnecting.`};
 if(/^\/(?:checkpoint|challenge)(?:\/|$)/i.test(path))return {code:'LINKEDIN_AUTH',reason:'LinkedIn requires a security check. Processing stopped; complete the check manually.'};
 if(/security warning|security verification|verify your identity|unusual (?:activity|sign.in)|(?:تحذير أمني|تحقق أمني|التحقق من هويتك|تحقق من هويتك|تأكيد هويتك|نشاط غير (?:عادي|معتاد))/i.test(text))return {code:'LINKEDIN_AUTH',reason:'LinkedIn displayed a security warning. Processing stopped; review it manually before resuming.'};
 if(status===401||!manual&&/^\/(?:login|uas|authwall|signup)(?:\/|$)/i.test(path))return {code:'LINKEDIN_AUTH',reason:`LinkedIn sign-in is required${status?' (HTTP '+status+')':''}. Processing stopped; use manual sign-in.`};
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
