'use strict';
const textOf=v=>typeof v==='string'?v:typeof v?.text==='string'?v.text:typeof v?.text?.text==='string'?v.text.text:'';
function extractActivity(response,{profileUrn,profileUrl,now=new Date().toISOString(),endpoint='profileUpdatesV2',requireAuthorMatch=false}={}){
 const observed=Date.parse(now),index=new Map(),collections=[],seen=new Set();
 function indexObjects(v){if(!v||typeof v!=='object'||seen.has(v))return;seen.add(v);if(!Array.isArray(v))for(const k of ['entityUrn','urn'])if(typeof v[k]==='string')index.set(v[k],v);for(const value of Object.values(v))indexObjects(value);}
 indexObjects(response);
 // Collection elements belong to the requested feed. Included actors, comments
 // and arbitrary metadata timestamps are not candidate posts by themselves.
 function collect(v,depth=0){
  if(!v||typeof v!=='object'||Array.isArray(v)||depth>5)return;
  for(const key of ['elements','*elements'])if(Array.isArray(v[key]))collections.push(v[key]);
  for(const [key,value]of Object.entries(v))if(/^(?:data|feed|updates|memberShareFeed)$/.test(key))collect(value,depth+1);
 }
 collect(response);
 const entries=collections.flat(),records=[];let unresolved=0,ignoredForeign=0;
 const resolve=v=>typeof v==='string'?index.get(v):v;
 const idPart=u=>String(u||'').match(/(?:fsd_profile|fs_profile|fs_miniProfile):([^,\s)]+)/)?.[1];
 const requested=idPart(profileUrn);
 for(const entry of entries){
  let item=resolve(entry);
  for(let depth=0;depth<3&&item&&typeof item==='object';depth++){
   const nested=resolve(item.update||item['*update']||item.feedUpdate||item['*feedUpdate']);
   const union=item.value&&typeof item.value==='object'?Object.entries(item.value).find(([k])=>/Update|Share/.test(k))?.[1]:null;
   if(nested&&typeof nested==='object')item=nested;else if(union)item=resolve(union);else break;
  }
  if(!item||typeof item!=='object'){unresolved++;continue;}
  const actor=resolve(item.actor||item['*actor']);
  const mini=resolve(actor?.miniProfile||actor?.['*miniProfile']||actor?.profile||actor?.['*profile']);
  const actorReferences=[...(actor?.image?.attributes||[]),...(actor?.name?.attributes||[])].map(v=>v?.['*miniProfile']||v?.['*profile']);
  const actorUrn=[actor?.urn,actor?.entityUrn,actor?.profileUrn,actor?.['*miniProfile'],mini?.entityUrn,item.actorUrn,...actorReferences].find(v=>idPart(v))||'';
  const actorId=idPart(actorUrn);
  const actorUrl=actor?.navigationContext?.actionTarget;
  const canonical=v=>String(v||'').match(/linkedin\.com\/in\/([^/?#]+)/i)?.[1]?.toLowerCase();
  const sameUrl=!!canonical(actorUrl)&&canonical(actorUrl)===canonical(profileUrl),sameId=!!requested&&actorId===requested;
  if(requireAuthorMatch){
   const foreignId=!!requested&&!!actorId&&actorId!==requested,foreignUrl=!!canonical(actorUrl)&&!sameUrl;
   if((sameId||sameUrl)&&(foreignId||foreignUrl)){unresolved++;continue;}
   if(foreignId||foreignUrl||/^urn:li:company:/.test(actor?.urn||'')||/linkedin\.com\/company\//.test(actorUrl||'')){ignoredForeign++;continue;}
   if(!sameId&&!sameUrl){unresolved++;continue;}
  }
  if(requested&&actorId&&actorId!==requested){unresolved++;continue;}
  if(/^urn:li:company:/.test(actor?.urn||'')||actorUrl&&/linkedin\.com\/company\//.test(actorUrl)){unresolved++;continue;}
  if(actorUrl&&profileUrl&&/linkedin\.com\/in\//.test(actorUrl)){
   const canonical=v=>String(v).match(/linkedin\.com\/in\/([^/?#]+)/i)?.[1]?.toLowerCase();
   if(canonical(actorUrl)!==canonical(profileUrl)){unresolved++;continue;}
  }
  const meta=item.updateMetadata||item.metadata||{};
  const urn=[item.urn,item.entityUrn,item.activityUrn,item.updateUrn,meta.urn,meta.updateUrn].find(v=>typeof v==='string'&&/urn:li:activity:\d+/.test(v));
  let at=null,method='';
  for(const v of [item.createdAt,item.postedAt,item.publishedAt,meta.createdAt,meta.postedAt,meta.publishedAt]){
   const n=typeof v==='number'?v:typeof v==='string'&&/^\d{13}$/.test(v)?Number(v):NaN;
   if(n>=Date.UTC(2015,0,1)&&n<=observed){at=n;method='post_timestamp';break;}
  }
  if(at===null&&urn)try{const n=Number(BigInt(urn.match(/urn:li:activity:(\d+)/)[1])>>22n);if(n>=Date.UTC(2015,0,1)&&n<=observed){at=n;method='activity_urn';}}catch{/* invalid activity ID */}
  const postText=textOf(item.commentary||item.shareCommentary||item.content?.commentary);
  if(at===null){unresolved++;continue;}
  records.push({postUrn:urn||'',authorUrn:actorUrn,at:new Date(at).toISOString(),method,association:actorId||requireAuthorMatch&&sameUrl?'matching_author':'requested_profile_feed',text:postText.slice(0,2500)});
 }
 records.sort((a,b)=>Date.parse(b.at)-Date.parse(a.at));
 const selected=records[0]||null;
 // A truncated feed without dates cannot establish inactivity, even when empty.
 const activityStatus=selected?observed-Date.parse(selected.at)<=30*86400000?'Active':unresolved?'Unknown':'Inactive':'Unknown';
 return {activityStatus,lastActivityAt:activityStatus==='Unknown'?null:selected?.at||null,latestPostText:selected?.text||'',
  activityEvidence:{version:requireAuthorMatch?2:1,endpoint,profileUrn:profileUrn||'',profileUrl:profileUrl||'',checkedAt:now,feedElements:entries.length,unresolved,...(requireAuthorMatch?{ignoredForeign}:{}),selected,records:records.slice(0,10),reason:selected?activityStatus==='Unknown'?'Undated feed records prevent confirming inactivity.':'Dated activity record found.':collections.length?'Feed did not provide a reliably dated activity record.':'Activity response did not contain a recognized feed collection.'}};
}
module.exports={extractActivity};
