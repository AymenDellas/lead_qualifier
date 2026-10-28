'use strict';

// Page availability is separate from account security. Never clear a security
// hold or infer a restriction from a generic server error.
function unavailable({url='',status=0}={}) {
 let parsed;try{parsed=new URL(url);}catch{return null;}
 if(!/(^|\.)(linkedin\.com|licdn\.com)$/i.test(parsed.hostname))return null;
 const fallback=parsed.pathname.match(/^\/error_pages\/(5\d\d)\.html$/i);
 if(!(status>=500&&status<=599)&&!fallback)return null;
 const description=status>=500&&status<=599?'HTTP '+status:'the '+fallback[1]+' error page';
 const reason='LinkedIn returned '+description+'. The requested page is unavailable; retain its checkpoint for manual retry.';
 return Object.assign(Error(reason),{failure:{stage:'page',code:'LINKEDIN_PAGE_UNAVAILABLE',reason,retryable:false}});
}

function assertProfile(url,expected,status=0) {
 const error=unavailable({url,status});if(error)throw error;
 if(require('./linkedin-workers.cjs').profileUrl(url)!==expected){
  const reason='The rendered visit ended on another page; the selected profile was not confirmed.';
  throw Object.assign(Error(reason),{failure:{stage:'page',code:'WARMUP_REDIRECT',reason,retryable:false}});
 }
}

module.exports={unavailable,assertProfile};
