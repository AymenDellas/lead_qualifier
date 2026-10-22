'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const puppeteer=require('puppeteer');
const reader=require('../../src/lib/linkedin-browser-page.cjs');
const policy=require('../../src/lib/linkedin-activity-policy.cjs');
const person='https://www.linkedin.com/in/fixture-coach/';
const profile=`<!doctype html><html><body><nav><a href="/in/unrelated/">Somebody else</a></nav><main>
 <section><h1>Fixture Coach</h1><div class="text-body-medium break-words">Career coach for experienced professionals</div><div class="text-body-small inline t-black--light break-words">Vancouver, Canada</div><span class="dist-value">1st</span><span>Premium</span><button>Message</button><a id="contact" href="/in/fixture-coach/overlay/contact-info/">Contact info</a></section>
 <section><div id="about"></div><h2>About</h2><div class="inline-show-more-text">I help leaders change careers. <a href="https://fixture-coach.test/">My practice</a><span style="display:none">HIDDEN CLAIM</span></div></section>
 <section><div id="featured"></div><h2>Featured</h2><a href="https://fixture-coach.test/results">Client stories</a></section>
 <section><h2>Activity</h2><a href="/in/fixture-coach/recent-activity/all/">Show all posts</a></section>
 </main><aside><a href="mailto:not-the-coach@other.test">Suggestion</a></aside>
 <script>document.querySelector('#contact').onclick=e=>{e.preventDefault();history.pushState({},'',e.currentTarget.href);const modal=document.createElement('div');modal.setAttribute('role','dialog');modal.innerHTML='<h2>Fixture Coach contact info</h2><a href="mailto:coach@fixture-coach.test">Email</a><a href="https://fixture-coach.test/contact">Website</a><button aria-label="Dismiss">Close</button>';document.body.append(modal);modal.querySelector('button').onclick=()=>{modal.remove();history.pushState({},'','/in/fixture-coach/');};};</script></body></html>`;
function activity(){
 const at=Date.now()-7*86400000,urn=String(BigInt(at)<<22n);
 return `<main><article class="feed-shared-update-v2" data-urn="urn:li:activity:${urn}"><div class="update-components-actor"><a href="${person}">Fixture Coach</a><time datetime="${new Date(at).toISOString()}">7d</time></div><p>Published career advice.</p></article></main>`;
}
async function fixture(fn,handler) {
 const browser=await puppeteer.launch({headless:true,args:['--no-sandbox']});
 try {
  const page=await browser.newPage(),requests=[];
  await page.setRequestInterception(true);
  page.on('request',request=>{
   if(request.isNavigationRequest())requests.push(request.url());
   assert.ok(!request.url().includes('/voyager/'),'No manufactured private API requests');
   const response=handler?.(request.url());
   // All navigation is fulfilled locally. No request reaches LinkedIn, a saved
   // browser profile, or any third-party server.
   request.respond(response||{status:200,contentType:'text/html',body:request.url().includes('/recent-activity/')?activity():profile}).catch(()=>{});
  });
  await fn(page,requests);
 }finally{await browser.close();}
}
test('real browser captures only the matching rendered profile, contact panel and authored activity, with recoverable checkpoints',async()=>{
 await fixture(async(page,requests)=>{
  const steps=[],checkpoints=[];
  const result=await reader.captureProfile(page,person,{accountId:'fixture-account',beforeCheck:async kind=>steps.push(kind),onCheckpoint:async value=>checkpoints.push(structuredClone(value))});
  assert.equal(result.firstName,'Fixture');assert.equal(result.headline,'Career coach for experienced professionals');assert.equal(result.profileLocation,'Vancouver, Canada');
  assert.deepEqual(result.emails,['coach@fixture-coach.test']);assert.ok(!result.about.includes('HIDDEN CLAIM'));
  assert.equal(result.linkedinContact.connection,'CONNECTED');assert.equal(result.linkedinContact.openProfile,'UNKNOWN','Premium and a Message button are not free-message proof');
  assert.equal(result.activityStatus,'Active');assert.equal(result.linkedinCapture.complete,true);
  assert.deepEqual(checkpoints.map(c=>c.linkedinCapture.stage),['profile','contact','complete']);
  assert.deepEqual(steps,['profile_page','contact','contact','activity_page']);
  assert.ok(requests.every(url=>url===person||url===person+'recent-activity/all/'),'Only ordinary page navigation is permitted');
 });
});
test('identity comes from the self card or Me menu; a feed author and suggested person never identify the viewer',async()=>{
 await fixture(async page=>{
  await page.setContent('<nav></nav><main><a href="https://www.linkedin.com/in/not-the-viewer/">Feed Author</a></main>');
  assert.equal(await reader.readSignedInIdentity(page),null);
  await page.setContent('<nav></nav><aside class="feed-identity-module"><h3>Fixture Viewer</h3><a href="https://www.linkedin.com/in/viewer/">Fixture Viewer</a></aside><main><h3>Feed Author</h3><a href="https://www.linkedin.com/in/author/">Feed Author</a></main>');
  const viewer=await reader.readSignedInIdentity(page);assert.equal(viewer.profileUrl,'https://www.linkedin.com/in/viewer/');assert.equal(viewer.name,'Fixture Viewer');
  await page.setContent(`<nav class="global-nav__me"><button aria-label="Me" onclick="document.querySelector('#menu').hidden=false">Me</button><div id="menu" hidden><h3>Menu Viewer</h3><a href="https://www.linkedin.com/in/menu-viewer/">View profile</a></div></nav>`);
  assert.equal((await reader.readSignedInIdentity(page,{beforeCheck:async()=>{}})).profileUrl,'https://www.linkedin.com/in/menu-viewer/');
 });
});
test('a restriction stops before contact/activity controls, and a changed profile is never attributed to the requested person',async()=>{
 await fixture(async(page,requests)=>{
  await assert.rejects(reader.captureProfile(page,person),e=>e.failure.code==='LINKEDIN_AUTH');
  assert.equal(requests.length,1);
 },()=>({status:403,contentType:'text/html',body:'<title>Your account is restricted</title><main>Resolve the account check.</main>'}));
 await fixture(async page=>{
  await assert.rejects(reader.captureProfile(page,person),e=>e.failure.code==='PROFILE_IDENTITY');
 },()=>({status:200,contentType:'text/html',body:profile.replace('<h1>','<script>history.replaceState({},"","/in/wrong-person/")</script><h1>')}));
});
test('pausing after contact capture retains evidence; resuming skips the completed contact step',async()=>{
 let saved;
 await fixture(async page=>{
  await assert.rejects(reader.captureProfile(page,person,{accountId:'fixture',onCheckpoint:async value=>{saved=structuredClone(value);},beforeCheck:async kind=>{if(kind==='activity_page')throw Object.assign(Error('paused'),{failure:{stage:'control',code:'WORKER_PAUSED',reason:'Paused'}});}}),/paused/);
  assert.equal(saved.linkedinCapture.stage,'contact');assert.deepEqual(saved.emails,['coach@fixture-coach.test']);
  const steps=[];
  const resumed=await reader.captureProfile(page,person,{accountId:'fixture',resume:saved,beforeCheck:async kind=>steps.push(kind)});
  assert.deepEqual(resumed.emails,saved.emails);assert.deepEqual(steps,['profile_page','activity_page']);assert.equal(resumed.linkedinCapture.complete,true);
 });
});
test('lazy profile sections are read after bounded browser scrolling; generic error headings cannot establish identity',async()=>{
 const lazy=profile.replace('<section><div id="about">','<section hidden id="lazy-about"><div id="about">').replace('<section><h2>Activity</h2>','<section hidden id="lazy-activity"><h2>Activity</h2>').replace('</body>','<script>addEventListener("wheel",()=>{document.querySelector("#lazy-about").hidden=false;document.querySelector("#lazy-activity").hidden=false;});</script></body>');
 await fixture(async page=>{
  const steps=[];const result=await reader.captureProfile(page,person,{beforeCheck:async kind=>steps.push(kind)});
  assert.match(result.about,/I help leaders change careers/);assert.equal(result.activityStatus,'Active');assert.equal(steps.filter(kind=>kind==='profile').length,1);
 },url=>({status:200,contentType:'text/html',body:url.includes('/recent-activity/')?activity():lazy}));
 assert.throws(()=>reader.parseProfile({url:person,html:'<main><section><h1>Profile not found</h1></section></main>'},person),e=>e.failure.code==='PROFILE_IDENTITY');
 const accessible=profile.replace('<div id="about"></div><h2>About</h2>','<h2><span aria-hidden="true">About</span><span class="visually-hidden">About</span></h2>');
 assert.match(reader.parseProfile({url:person,html:accessible},person).about,/I help leaders change careers/,'Duplicated screen-reader headings still identify the About section');
});
test('working hours respect weekdays, overnight ranges and daylight-saving transitions without starting activity',()=>{
 const hours=policy.validateHours({timezone:'America/New_York',days:[1],start:'22:00',end:'02:00'});
 assert.equal(policy.hoursAllowed(hours,Date.parse('2026-10-20T02:30:00Z')),true,'Monday 22:30');
 assert.equal(policy.hoursAllowed(hours,Date.parse('2026-10-20T05:30:00Z')),true,'Tuesday 01:30 from Monday overnight');
 assert.equal(policy.hoursAllowed(hours,Date.parse('2026-10-20T06:00:00Z')),false);
 const dst=policy.validateHours({timezone:'America/New_York',days:[0],start:'01:00',end:'02:00'});
 for(const time of ['2026-11-01T05:30:00Z','2026-11-01T06:30:00Z'])assert.equal(policy.hoursAllowed(dst,Date.parse(time)),true,'Both instances of the repeated DST hour');
 assert.throws(()=>policy.validateHours({...hours,timezone:'Invalid/Zone'}),/time zone/);assert.throws(()=>policy.validateHours({...hours,days:[]}),/working day/);
});
test('activity windows span UTC midnight, share profile kinds and expire at their actual timestamps',()=>{
 const now=Date.parse('2026-10-22T00:05:00Z'),events=[1,2,3].map(n=>({created_at:new Date(now-n*60000).toISOString(),data:{kind:'profile_page'}}));
 events.push({created_at:new Date(now-25*3600000).toISOString(),data:{kind:'profile_page'}});
 const limits={profile:{hourly:3,daily:5}};
 assert.equal(policy.windowUsage(events,now).daily,3);assert.equal(policy.actionWait(events,'profile',limits,now),3420001);
 assert.equal(policy.actionWait(events,'contact',limits,now),0);
 assert.throws(()=>policy.validateLimits({profile:{hourly:4,daily:3}}),/cannot exceed/);
});
