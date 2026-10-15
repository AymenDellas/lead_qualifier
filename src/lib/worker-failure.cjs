'use strict';
function failureOf(result) {
 if(result?.failure?.reason)return result.failure;
 const text=(result?.logs||[]).join('\n');
 const issue=(stage,code,reason,retryable=true)=>({stage,code,reason,retryable});
 if(/Automated interpretation.*(?:429|rate limit|shared AI token budget)/i.test(text))return issue('research','AI_RATE_LIMIT','AI provider rate limit reached; scraped profile retained.');
 if(/Automated interpretation.*413/i.test(text))return issue('research','AI_SIZE','AI request exceeded the provider size limit.');
 if(/Automated interpretation.*(?:failed|unavailable|could not complete)/i.test(text))return issue('research','AI_UNAVAILABLE','AI qualification could not complete; scraped profile retained.');
 if(/Research could not complete/i.test(text))return issue('research','RESEARCH_FAILED','Website or qualification research could not complete.');
 if(/CRM save|Save error|database/i.test(text))return issue('crm','CRM_SAVE','CRM save failed; research retained.');
 if(/timed out|timeout|page crashed|target closed|session closed|execution context/i.test(text))return issue('linkedin','BROWSER_TIMEOUT','LinkedIn browser timed out or closed.');
 return issue('linkedin','SCRAPE_FAILED','LinkedIn profile could not be read.');
}
module.exports={failureOf};
