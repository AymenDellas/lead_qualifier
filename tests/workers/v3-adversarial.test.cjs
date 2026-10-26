'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const geo=require('../../src/lib/discovery-location-evidence.cjs');
const audience=require('../../src/lib/follower-policy.cjs');
const reader=require('../../src/lib/linkedin-browser-page.cjs');
const activity=require('../../src/lib/linkedin-activity-page.cjs');
const q=require('../../src/lib/prospect-qualification.cjs');
const person='https://www.linkedin.com/in/adversarial-owner/',now=new Date().toISOString();
const profile=body=>({url:person,html:`<main><section><h1>Fixture Owner</h1><div class="text-body-medium">Executive coach</div><p class="text-body-small inline t-black--light break-words">London, England, United Kingdom</p>${body}</section></main>`});
function research(overrides={}){
 const value=q.emptyResearch({url:person,profileIdentityConfirmed:true,lastActivityAt:now,profileLocation:'London, England, United Kingdom',targetLocationRequired:true,
  followers:{count:501,rawText:'501 followers',threshold:500,checkedAt:now}},now);
 value.contacts=[{address:'owner@coaching-practice.test',source:'linkedin',url:person,ownership:'PUBLISHED'}];
 return {...value,...overrides};
}

test('search country, employer and client markets cannot supply person residence',()=>{
 for(const item of [
  {link:'https://us.linkedin.com/in/owner/',title:'Owner | Helping US clients',snippet:'Location: Paris, France · International executive coach'},
  {snippet:'Microsoft United States · Executive Coach'},
  {snippet:'India United States · Executive Coach'},
  {snippet:'Paris France United States · Executive Coach'},
  {snippet:'I serve clients in United States · Executive Coach'},
  {attributes:{Location:'Paris, France'},rich_snippet:{top:{attributes:{Location:'United States'}}}},
 ])assert.notEqual(geo.assessDiscoveryLocation(item,'US').status,'CONFIRMED',JSON.stringify(item));
 assert.equal(geo.canonicalDiscoveryTarget('CA'),null,'CA can be California or Canada');
 assert.notEqual(geo.assessDiscoveryLocation({snippet:'Location: London, Ontario, Canada'},'UK').status,'CONFIRMED');
});

test('explicit country distinguishes same-named places and unsupported-country exclusions',()=>{
 assert.equal(geo.parsePersonLocation('Paris, Texas, United States').country,'US');
 assert.equal(geo.parsePersonLocation('London, Ontario, Canada').country,'Canada');
 assert.equal(geo.parsePersonLocation('Belfast, Northern Ireland').country,'UK');
 assert.equal(geo.parsePersonLocation('Dublin, Ireland').status,'OUTSIDE_TARGET');
 for(const value of ['London','CA','Global','Clients in US','Paris France United States'])assert.notEqual(geo.parsePersonLocation(value).status,'CONFIRMED',value);
});

test('follower boundary is strictly 500 and exact Arabic source text remains available',()=>{
 assert.equal(audience.followersDecision({count:500}).status,'REJECTED');
 assert.equal(audience.followersDecision({count:501}).status,'CONTINUE');
 assert.equal(audience.parseFollowerCount('500+ connections'),null);
 for(const [raw,count]of [['\u200f1,119\u200f من المتابعين',1119],['\u200f23,838\u200f من المتابعين',23838]]){
  const parsed=audience.audienceRecord(raw);assert.equal(parsed.count,count);assert.equal(parsed.rawText,raw);
 }
});

test('a suggested person inside the owner section cannot supply missing owner followers',()=>{
 for(const foreign of [
  '<aside><h3>Other Coach</h3><a href="/in/other/">Other Coach</a><span>25,000 followers</span></aside>',
  '<div><a href="/in/other/">Other Coach</a><span>25,000 followers</span></div>',
 ])assert.equal(reader.parseProfile(profile(foreign),person).followers.count,null,foreign);
 const state=profile('<p>I help people build an audience of 25,000 followers</p>');
 assert.equal(reader.parseProfile(state,person).followers.count,null);
});

test('split own count and label are readable while connections and conflicting counts stay separate',()=>{
 const own=reader.parseProfile(profile('<div><span>1,119</span> <span>followers</span> · <span>500+</span> <span>connections</span></div>'),person);
 assert.equal(own.followers.count,1119);assert.equal(own.connections.count,500);
 const conflict=reader.parseProfile(profile('<p>600 followers</p><p>900 followers</p>'),person);
 assert.equal(conflict.followers.count,null);
});

test('foreign posts do not create uncertain owner activity; undated owner posts still do',()=>{
 const old=new Date(Date.parse(now)-50*86400000).toISOString();
 const card=(url,date)=>`<article class="feed-shared-update-v2"><header><a href="${url}">Author</a>${date?`<time datetime="${date}">Date</time>`:''}</header><p>Rendered post</p></article>`;
 const options={profileUrl:person,pageUrl:person+'recent-activity/all/',now};
 assert.equal(activity.extractActivityPage('<main>'+card(person,old)+card('https://www.linkedin.com/in/other/',null)+'</main>',options).activityStatus,'Inactive');
 assert.equal(activity.extractActivityPage('<main>'+card(person,old)+card(person,null)+'</main>',options).activityStatus,'Unknown');
});

test('unknown identity or activity stays REVIEW instead of becoming a statistics-only rejection',()=>{
 for(const overrides of [{lastActivityAt:null,activityStatus:'Unknown'}, {profileIdentityConfirmed:false},
  {profileIdentityConfirmed:false,followers:{count:100,rawText:'100 followers',threshold:500,checkedAt:now}}]){
  const assessed=q.assessProspect(research(overrides),{email:'owner@coaching-practice.test',now});
  assert.equal(q.pipelineForAssessment(assessed),'REVIEW',JSON.stringify(overrides));
 }
});

test('current country exclusion does not need invented downstream follower, activity or email facts',()=>{
 const assessed=q.assessProspect(research({profileLocation:'Paris, France',followers:null,lastActivityAt:null,contacts:[]}),{now});
 assert.equal(q.pipelineForAssessment(assessed),'NOT_QUALIFIED');assert.equal(assessed.qualification.locationReason,'LOCATION_OUTSIDE_TARGET');
 assert.equal(q.pipelineForAssessment(q.assessProspect(research({profileLocation:'London'}),{email:'owner@coaching-practice.test',now})),'REVIEW');
});

test('v2 qualified evidence survives the version bump, while unsupported future versions are not trusted',()=>{
 const prior=q.assessProspect(research(),{email:'owner@coaching-practice.test',now});prior.version=2;
 assert.equal(q.hasQualifiedEmail({pipeline_status:'QUALIFIED',email:'owner@coaching-practice.test',prospect_assessment:prior}),true);
 prior.version=999;assert.equal(q.hasQualifiedEmail({pipeline_status:'QUALIFIED',email:'owner@coaching-practice.test',prospect_assessment:prior}),false);
});

test('activity v2 attribution survives validation and cannot become an empty evidence checkpoint',()=>{
 const evidence={version:2,endpoint:'profile_activity_page',profileUrl:person,profileUrn:'',checkedAt:now,feedElements:2,unresolved:0,ignoredForeign:1,
  selected:{postUrn:'',authorUrn:'',at:now,method:'visible_post_timestamp',association:'matching_author',text:'Own post'},records:[],reason:'Own date and foreign-card attribution recorded.'};
 const validated=q.validateResearch(research({activityEvidence:evidence}));
 assert.equal(validated.activityEvidence.version,2);assert.equal(validated.activityEvidence.ignoredForeign,1);assert.equal(validated.activityEvidence.selected.at,now);
});
