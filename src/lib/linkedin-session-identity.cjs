'use strict';
function cleanIdentity(value) {
 if(!value||typeof value!=='object')return null;
 const name=typeof value.name==='string'?value.name.replace(/\s+/g,' ').trim().slice(0,160):'';
 let profileUrl='';
 try {
  const url=new URL(value.profileUrl);
  if(url.protocol==='https:'&&url.hostname==='www.linkedin.com'&&!url.username&&!url.password&&/^\/in\/[^/?#]+\/?$/.test(url.pathname))
   profileUrl=`https://www.linkedin.com${url.pathname.replace(/\/$/,'').toLowerCase()}/`;
 }catch{}
 const memberUrn=typeof value.memberUrn==='string'&&/^urn:li:(?:fs_miniProfile|fs_profile|fsd_profile):[a-zA-Z0-9_-]+$/.test(value.memberUrn)?value.memberUrn:'';
 if(!name||(!profileUrl&&!memberUrn))return null;
 const checkedAt=typeof value.checkedAt==='string'&&Number.isFinite(Date.parse(value.checkedAt))?value.checkedAt:null;
 return {name,profileUrl,memberUrn,checkedAt};
}
function identityFromMe(payload) {
 if(!payload||typeof payload!=='object')return null;
 const included=[...(Array.isArray(payload.included)?payload.included:[]),...(Array.isArray(payload.data?.included)?payload.data.included:[])];
 for(const root of [payload.data?.data,payload.data,payload]) {
  if(!root||typeof root!=='object')continue;
  const ref=root['*miniProfile'];
  // Only use the profile returned by /me, or its exact referenced entity.
  // Other included people (e.g. feed authors) are never the signed-in identity.
  const mini=root.miniProfile&&typeof root.miniProfile==='object'?root.miniProfile:
   typeof ref==='string'?included.find(entity=>entity.entityUrn===ref):null;
  if(!mini)continue;
  const slug=typeof mini.publicIdentifier==='string'?mini.publicIdentifier.trim():'';
  const identity=cleanIdentity({name:[mini.firstName,mini.lastName].filter(item=>typeof item==='string').join(' '),
   profileUrl:slug?`https://www.linkedin.com/in/${slug}/`:'',memberUrn:mini.entityUrn||ref,checkedAt:new Date().toISOString()});
  if(identity)return identity;
 }
 return null;
}
module.exports={identityFromMe,cleanIdentity};
