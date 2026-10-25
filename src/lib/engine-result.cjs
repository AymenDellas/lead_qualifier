'use strict';
const string=value=>typeof value==='string'?value:'';
const strings=value=>Array.isArray(value)?value.filter(item=>typeof item==='string'):[];

// Worker outcomes, older saved runs and session caches do not all have contact
// fields. Normalize the display shape without changing facts or qualification.
function normalizeEngineResult(value,fallbackUrl='') {
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 return {...value,url:string(value.url)||string(value.linkedinUrl)||string(fallbackUrl),
  status:string(value.status)||'ERROR',firstName:string(value.firstName),headline:string(value.headline),
  activityStatus:string(value.activityStatus)||'Unknown',website:string(value.website),
  websites:strings(value.websites),emails:strings(value.emails),logs:strings(value.logs)};
}
function normalizeEngineResults(value) {
 return Array.isArray(value)?value.map(item=>normalizeEngineResult(item)).filter(Boolean):[];
}
module.exports={normalizeEngineResult,normalizeEngineResults};
