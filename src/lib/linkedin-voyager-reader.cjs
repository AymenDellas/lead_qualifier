'use strict';
// Explicitly restored by the user on 2026-10-26. Requests use only the owner's
// existing browser session; no credential/cookie values leave that browser.
const rendered=require('./linkedin-browser-page.cjs');
const {profileUrl}=require('./linkedin-workers.cjs');
const qualification=require('./prospect-qualification.cjs');
const followersPolicy=require('./follower-policy.cjs');
const {pageSignal,failure}=require('./linkedin-session-policy.cjs');
const telemetry=require('./engine-telemetry.cjs');
const READER='VOYAGER_V1',MAX_BYTES=2*1024*1024;
const text=value=>typeof value==='string'?value.replace(/\s+/g,' ').trim():typeof value?.text==='string'?value.text.trim():typeof value?.text?.text==='string'?value.text.text.trim():'';
const issue=(code,reason,retryable=false)=>Object.assign(Error(reason),{failure:{stage:'linkedin',code,reason,retryable}});
function slugOf(person){
 const canonical=profileUrl(person);if(!canonical)throw issue('PROFILE_IDENTITY','Invalid requested LinkedIn person URL.');
 const slug=decodeURIComponent(new URL(canonical).pathname.split('/')[2]);
 if(!/^[\p{L}\p{N}_.-]{1,200}$/u.test(slug))throw issue('PROFILE_IDENTITY','The requested LinkedIn identifier is unsupported.');
 return slug;
}
function requestPath(kind,person,profileUrn=''){
 const slug=slugOf(person),segment=encodeURIComponent(slug);
 if(kind==='profile')return '/voyager/api/identity/profiles/'+segment+'/profileView';
 if(kind==='contact')return '/voyager/api/identity/profiles/'+segment+'/profileContactInfo';
 if(kind==='featured')return '/voyager/api/identity/profiles/'+segment+'/featuredContent';
 if(kind==='profileFallback'||kind==='contactFallback'){
  const decoration=kind==='profileFallback'?'FullProfileWithEntities-101':'ProfileContactInfo-14';
  return '/voyager/api/identity/dash/profiles?'+new URLSearchParams({q:'memberIdentity',memberIdentity:slug,decorationId:'com.linkedin.voyager.dash.deco.identity.profile.'+decoration});
 }
 if(kind==='activity'){
  if(!/^urn:li:(?:fsd_profile|fs_profile|fs_miniProfile):[a-zA-Z0-9_-]+$/.test(profileUrn))throw issue('ACTIVITY_UNCONFIRMED','The matching profile did not supply a supported activity identity.');
  return '/voyager/api/identity/profileUpdatesV2?'+new URLSearchParams({count:'10',includeLongTermHistory:'true',moduleKey:'creator_profile_all_content_view:desktop',numComments:'0',numLikes:'0',profileUrn,q:'memberShareFeed'});
 }
 throw Error('Unsupported Voyager request kind.');
}
function notice(body){
 if(typeof body!=='string'||!body)return '';
 if(/^\s*</.test(body)){
  const $=require('cheerio').load(body);$('script,style,input,textarea,iframe,noscript').remove();
  return text($('title').text()+' '+$('body').text()).slice(0,12000);
 }
 try{const data=JSON.parse(body);return [data.message,data.error?.message,data.data?.message].filter(v=>typeof v==='string').join(' ').slice(0,12000);}catch{return '';}
}
async function requestVoyager(page,kind,person,options={}){
 const path=requestPath(kind,person,options.profileUrn);
 const current=new URL(page.url());
 if(current.origin!=='https://www.linkedin.com')throw issue('LINKEDIN_AUTH','The saved account is not on LinkedIn. Use Open session to review it.');
 await options.beforeCheck?.(kind==='activity'?'activity':kind.startsWith('contact')?'contact':'profile');
 const response=await telemetry.span('linkedin.voyager.'+kind,()=>page.evaluate(async({path,maxBytes})=>{
  const match=document.cookie.match(/(?:^|;\s*)JSESSIONID=([^;]+)/);
  if(!match)return {status:401,url:location.href,missingSession:true};
  let csrf=match[1].replace(/^"|"$/g,'');try{csrf=decodeURIComponent(csrf).replace(/^"|"$/g,'');}catch{}
  try{
   const res=await fetch('https://www.linkedin.com'+path,{method:'GET',credentials:'include',redirect:'manual',
    headers:{accept:'application/vnd.linkedin.normalized+json+2.1','x-restli-protocol-version':'2.0.0','x-li-lang':'en_US','csrf-token':csrf},signal:AbortSignal.timeout(15000)});
   if(res.type==='opaqueredirect'||res.status>=300&&res.status<400)return {status:302,url:res.url,redirected:true};
   const parts=[];let bytes=0;
   if(res.body){const reader=res.body.getReader();for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>maxBytes){await reader.cancel();return {status:res.status,url:res.url,tooLarge:true};}parts.push(value);}}
   const buffer=new Uint8Array(bytes);let offset=0;for(const part of parts){buffer.set(part,offset);offset+=part.byteLength;}
   return {status:res.status,url:res.url,body:new TextDecoder().decode(buffer)};
  }catch{return {status:0,url:'https://www.linkedin.com'+path,networkFailure:true};}
 },{path,maxBytes:MAX_BYTES}));
 if(response.redirected)throw issue('LINKEDIN_AUTH','LinkedIn redirected the data request to an account check. Processing stopped; review the account manually.');
 const signal=pageSignal({url:response.url||'https://www.linkedin.com'+path,status:response.status,text:notice(response.body)});
 if(signal)throw Object.assign(Error(signal.reason),{failure:failure(signal)});
 options.checkResponse?.(response.status,response.url||'https://www.linkedin.com'+path);
 if(response.tooLarge)throw issue('VOYAGER_RESPONSE_SIZE','LinkedIn data exceeded the bounded response size; saved evidence requires review.');
 if(response.status===0||response.status>=500)throw issue('VOYAGER_TRANSPORT','LinkedIn data request failed'+(response.status?' (HTTP '+response.status+')':'')+'. Saved checkpoints are retained.',true);
 if([400,404,405,410].includes(response.status))return {status:response.status,data:null};
 if(response.status!==200)throw issue('VOYAGER_UNAVAILABLE','LinkedIn data request returned HTTP '+response.status+'. Review the saved evidence.');
 let data;try{data=JSON.parse(response.body);}catch{
  if(/<form[^>]+(?:login|sign.?in)|name=["'](?:session_key|session_password|password)["']/i.test(response.body||''))throw issue('LINKEDIN_AUTH','LinkedIn returned a sign-in page instead of profile data. Processing stopped; review the account manually.');
  throw issue('VOYAGER_RESPONSE_SHAPE','LinkedIn returned an unsupported data format. No profile facts were guessed.');
 }
 if(!data||typeof data!=='object'||Array.isArray(data))throw issue('VOYAGER_RESPONSE_SHAPE','LinkedIn returned an unsupported data structure.');
 const errorStatus=Number(data.status||data.error?.status||data.data?.status||0);
 const embedded=pageSignal({url:'https://www.linkedin.com'+path,status:errorStatus,text:notice(response.body)});
 if(embedded)throw Object.assign(Error(embedded.reason),{failure:failure(embedded)});
 if(errorStatus>=500)throw issue('VOYAGER_TRANSPORT','LinkedIn returned a service data error (HTTP '+errorStatus+').',true);
 if([400,404,405,410].includes(errorStatus))return {status:errorStatus,data:null};
 if(errorStatus>=400)throw issue('VOYAGER_RESPONSE_SHAPE','LinkedIn returned a data error (HTTP '+errorStatus+').');
 return {status:200,data};
}
function objects(response){
 if(response?.included!=null&&!Array.isArray(response.included)||response?.data?.included!=null&&!Array.isArray(response.data.included))throw issue('VOYAGER_RESPONSE_SHAPE','LinkedIn returned an unsupported included-object structure.');
 return [response?.data?.profile,response?.profile,response?.data,response,...(response?.included||[]),...(response?.data?.included||[]),...(Array.isArray(response?.data?.elements)?response.data.elements:[])].filter(v=>v&&typeof v==='object');
}
function identifier(value){try{return decodeURIComponent(String(value||'')).toLowerCase();}catch{return '';}}
function matchingObjects(response,slug){return objects(response).filter(v=>[v.publicIdentifier,v.vanityName].some(id=>typeof id==='string'&&identifier(id)===identifier(slug)));}
function linkedObjects(response,matching){
 const index=new Map(objects(response).filter(v=>v.entityUrn).map(v=>[v.entityUrn,v])),bound=[...matching];
 const identities=new Set(matching.map(p=>p.entityUrn).filter(Boolean));
 for(const object of matching){if(typeof object['*miniProfile']==='string')identities.add(object['*miniProfile']);if(object.miniProfile?.entityUrn)identities.add(object.miniProfile.entityUrn);}
 const identityKey=value=>String(value||'').match(/^urn:li:(?:fsd_profile|fs_profile|fs_miniProfile):(.+)$/)?.[1];
 const ids=new Set([...identities].map(identityKey).filter(Boolean));
 for(let at=0;at<bound.length&&at<32;at++)for(const [key,value]of Object.entries(bound[at])){
  if(!/^(?:\*?followingInfo|\*?followerInfo|\*?memberRelationship|\*?miniProfile)$/i.test(key))continue;
  const linked=typeof value==='string'?index.get(value):value;
  if(!linked||typeof linked!=='object')continue;
  if(bound.includes(linked))continue;
  if(['profileUrn','memberUrn','*profile'].some(key=>identityKey(linked[key])&&ids.size&&!ids.has(identityKey(linked[key]))))continue;
  if([linked.publicIdentifier,linked.vanityName].some(id=>id&&!matching.some(m=>[m.publicIdentifier,m.vanityName].some(own=>own&&identifier(own)===identifier(id)))))continue;
  bound.push(linked);
 }
 return bound;
}
function audience(bound,kind,now){
 const keys=kind==='followers'?['followerCount','followersCount','numFollowers']:['connectionCount','connectionsCount','numConnections'];
 const records=[];
 for(const object of bound)for(const key of keys){
  const value=object[key];if(typeof value!=='string'&&typeof value!=='number')continue;
  const rawText=String(value).trim().slice(0,200),count=typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:kind==='followers'?followersPolicy.parseFollowerCount(rawText):followersPolicy.audienceRecord(rawText,'connections').count??followersPolicy.parseAudienceCount(rawText,{lowerBound:true});
  records.push({count,rawText});
 }
 const counts=[...new Set(records.filter(v=>v.count!==null).map(v=>v.count))];
 return {count:counts.length===1?counts[0]:null,rawText:counts.length===1?records.find(v=>v.count===counts[0]).rawText:records.map(v=>v.rawText).join(' | ').slice(0,200),checkedAt:now,...(kind==='followers'?{threshold:followersPolicy.minFollowers()}:{})};
}
function parseProfileResponse(response,person,accountId='',now=new Date().toISOString()){
 const slug=slugOf(person),matching=matchingObjects(response,slug),profile=qualification.extractMatchingProfile(response,slug);
 if(!profile||!matching.length)return null;
 const firstName=text(profile.firstName)||text(matching.find(p=>text(p.firstName))?.firstName),lastName=text(profile.lastName)||text(matching.find(p=>text(p.lastName))?.lastName);
 if(!firstName&&!lastName)return null;
 const bound=linkedObjects(response,matching),urns=bound.map(p=>p.entityUrn||p.urn).filter(v=>typeof v==='string'&&/^urn:li:(?:fsd_profile|fs_profile|fs_miniProfile):[a-zA-Z0-9_-]+$/.test(v));
 const profileUrn=(urns.find(v=>v.startsWith('urn:li:fsd_profile:'))||urns.find(v=>v.startsWith('urn:li:fs_miniProfile:'))||urns[0]||'').replace(/^urn:li:fs_miniProfile:/,'urn:li:fsd_profile:');
 const headline=text(profile.headline)||text(profile.occupation),about=text(profile.summary)||text(profile.about);
 const websites=[...new Set((about.match(/https?:\/\/[^\s<>"']+/g)||[]).map(url=>rendered.externalUrl(url)).filter(Boolean))].slice(0,8);
 return {url:profileUrl(person),firstName:firstName.slice(0,200),lastName:lastName.slice(0,200),headline:headline.slice(0,1000),about:about.slice(0,12000),profileUrn,
  profileIdentityConfirmed:true,profileLocation:qualification.extractProfileLocation(response,slug),followers:audience(bound,'followers',now),connections:audience(bound,'connections',now),
  websites,website:websites[0]||'',websiteSource:websites.length?'about_section':'',emails:[],primaryEmail:'',emailSource:'',activityStatus:'Unknown',lastActivityAt:null,latestPostText:'',status:'PENDING',
  linkedinAccountId:accountId,linkedinContact:{accountId,connection:'UNKNOWN',openProfile:'UNKNOWN',checkedAt:now,source:'WORKER',note:'No messaging permission inferred from Voyager profile data.'},
  logs:['Requested member identity confirmed from Voyager profile data.'],linkedinCapture:{version:2,reader:READER,stage:'profile',complete:false,checkedAt:now,profileResolved:false}};
}
function mergeProfile(one,two){
 if(!one)return two;if(!two)return one;
 const merged={...one};for(const key of ['firstName','lastName','headline','about','profileLocation','profileUrn'])if(two[key])merged[key]=two[key];
 if(two.followers.count!==null)merged.followers=two.followers;if(two.connections.count!==null)merged.connections=two.connections;
 merged.websites=[...new Set([...one.websites,...two.websites])];merged.website=merged.websites[0]||'';merged.websiteSource=merged.website?'about_section':'';return merged;
}
function contactData(response,person,profileUrn=''){
 const slug=slugOf(person),direct=response?.data?.profileContactInfo||response?.profileContactInfo||response?.data||response;
 const info=qualification.extractProfileContactInfo(response,slug),emails=[];
 const identityKey=value=>String(value||'').match(/^urn:li:(?:fsd_profile|fs_profile|fs_miniProfile):(.+)$/)?.[1],expected=identityKey(profileUrn);
 for(const value of [direct,info])if(value&&([value.publicIdentifier,value.vanityName].some(id=>id&&identifier(id)!==identifier(slug))||expected&&['profileUrn','memberUrn','*profile'].some(key=>identityKey(value[key])&&identityKey(value[key])!==expected)))throw issue('PROFILE_IDENTITY','Contact response identified another member; no contacts were assigned.');
 const value=typeof info.emailAddress==='string'?info.emailAddress:info.emailAddress?.emailAddress||info.emailAddress?.email;
 if(typeof value==='string'&&!qualification.isUnsafeContact(value))emails.push(value.trim().toLowerCase());
 const websites=[...new Set((Array.isArray(info.websites)?info.websites:[]).map(w=>rendered.externalUrl(typeof w==='string'?w:w?.url||'')).filter(Boolean))].slice(0,8);
 return {emails,websites};
}
async function captureProfile(page,person,options={}){
 const url=profileUrl(person);slugOf(person);
 const now=options.now||new Date().toISOString(),request=options.request||requestVoyager,unwatch=telemetry.observePage(page);
 const previous=options.resume,stamp=Date.parse(previous?.linkedinCapture?.checkedAt);
 const reusable=previous?.linkedinCapture?.reader===READER&&profileUrl(previous.url)===url&&previous.linkedinAccountId===options.accountId&&Number.isFinite(stamp)&&Date.parse(now)>=stamp&&Date.parse(now)-stamp<86400000;
 let result=reusable?structuredClone(previous):null;
 const save=async()=>{await options.onCheckpoint?.(structuredClone(result));};
 const finish=async(stage='complete')=>{result.linkedinCapture={...result.linkedinCapture,stage,complete:true};result.linkedinCapturedAt=result.linkedinCapture.checkedAt;await save();return result;};
 const decide=(stage,status,reason)=>{result.status=status;result.decisionStage=stage;result.reasonCode=reason;if(status==='REVIEW')result.failure={stage:'qualification',code:reason,reason:'Saved '+stage+' evidence needs review.',retryable:false};};
 try{
  if(!result?.linkedinCapture.profileResolved){
   await options.beforeCheck?.('profile_page');
   const fallbackOnly=reusable&&previous.linkedinCapture.profileVariant==='fallback';
   if(!fallbackOnly){
    const response=await request(page,'profile',url,options);
    result=response.status===200?parseProfileResponse(response.data,url,options.accountId,now):null;
   }
   const foreign=result&&options.requireTargetLocation&&require('./discovery-location-evidence.cjs').parsePersonLocation(result.profileLocation).status==='OUTSIDE_TARGET';
   if(!foreign&&(!result||result.followers.count===null)){
    result||={url,linkedinAccountId:options.accountId,profileIdentityConfirmed:false,linkedinCapture:{version:2,reader:READER,checkedAt:now,stage:'profile',complete:false}};
    result.linkedinCapture.profileVariant='fallback';await save();
    const response=await request(page,'profileFallback',url,options);
    const parsed=response.status===200?parseProfileResponse(response.data,url,options.accountId,now):null;
    result=result.profileIdentityConfirmed?mergeProfile(result,parsed):parsed;
   }
   if(!result?.profileIdentityConfirmed)throw issue('PROFILE_IDENTITY','Voyager did not identify the requested member. No other profile facts were substituted.');
   result.linkedinCapture.profileResolved=true;result.linkedinCapture.reader=READER;await save();
  }
  result.status='PENDING';delete result.failure;delete result.decisionStage;delete result.reasonCode;
  if(options.requireTargetLocation)result.targetLocationRequired=true;
  const place=options.requireTargetLocation?require('./discovery-location-evidence.cjs').parsePersonLocation(result.profileLocation):null;
  if(place?.status==='OUTSIDE_TARGET'){decide('location','REJECTED','LOCATION_OUTSIDE_TARGET');return finish('location_decided');}
  result.followers.threshold=followersPolicy.minFollowers();
  const follower=followersPolicy.followersDecision(result.followers,followersPolicy.minFollowers());
  if(follower.status!=='CONTINUE'){decide('followers',follower.status,follower.reason);return finish('followers_decided');}
  if(place&&place.status!=='CONFIRMED'){decide('location','REVIEW','LOCATION_UNCONFIRMED');return finish('location_decided');}
  if(!['activity','contact'].includes(result.linkedinCapture.stage)){
   const response=result.profileUrn?await request(page,'activity',url,{...options,profileUrn:result.profileUrn}):null;
   const activity=require('./linkedin-activity.cjs').extractActivity(response?.data||{}, {profileUrn:result.profileUrn,profileUrl:url,now,endpoint:'voyager_profileUpdatesV2',requireAuthorMatch:true});
   Object.assign(result,activity);result.linkedinCapture.stage='activity';await save();
  }
  if(options.requireRecentActivity!==false&&result.activityStatus!=='Active'){
   decide('activity',result.activityStatus==='Inactive'?'REJECTED':'REVIEW',result.activityStatus==='Inactive'?'ACTIVITY_INACTIVE':'ACTIVITY_UNCONFIRMED');return finish('activity_decided');
  }
  if(result.linkedinCapture.stage!=='contact'){
   let response=await request(page,'contact',url,options);
   if(response.status!==200)response=await request(page,'contactFallback',url,options);
   if(response.status===200){
    const found=contactData(response.data,url,result.profileUrn);result.emails=found.emails;result.primaryEmail=found.emails[0]||'';result.emailSource=found.emails.length?'linkedin':'';
    result.websites=[...new Set([...found.websites,...result.websites])];result.website=result.websites[0]||'';if(found.websites.length)result.websiteSource='contact_modal';
   }else result.logs.push('Contact data unavailable; no addresses were guessed.');
   result.linkedinCapture.stage='contact';await save();
  }
  if(!result.website&&!result.emails.length&&!result.linkedinCapture.featuredChecked){
   const response=await request(page,'featured',url,options);result.linkedinCapture.featuredChecked=true;
   if(response.status===200){
    // Only declared article/link URLs in this requested collection are website
    // candidates. Never mine arbitrary URLs from included member/company data.
    const elements=response.data?.data?.elements||response.data?.elements||[];
    for(const item of elements)for(const value of [item?.url,item?.link?.url,item?.article?.url]){const link=rendered.externalUrl(value);if(link&&!result.websites.includes(link))result.websites.push(link);}
    result.website=result.websites[0]||'';if(result.website)result.websiteSource='featured_section';
   }
  }
  result.logs.push('Voyager capture complete; no rendered member/activity/contact page navigation.');return finish();
 }finally{unwatch();}
}
module.exports={...rendered,captureProfile,requestVoyager,requestPath,parseProfileResponse,contactData,READER};
