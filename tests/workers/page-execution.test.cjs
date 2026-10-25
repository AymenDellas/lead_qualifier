'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const puppeteer=require('puppeteer');
const reader=require('../../src/lib/linkedin-browser-page.cjs');
const person='https://www.linkedin.com/in/fixture-coach/';
const profile=`<!doctype html><html><body><nav><a href="/in/unrelated/">Somebody else</a></nav><main>
 <section><h1>Fixture Coach</h1><div class="text-body-medium break-words">Career coach for experienced professionals</div><div class="text-body-small inline t-black--light break-words">Vancouver, Canada</div><p>2,345 followers</p><p>500+ connections</p><span class="dist-value">1st</span><span>Premium</span><button>Message</button><a id="contact" href="/in/fixture-coach/overlay/contact-info/">Contact info</a></section>
 <section><div id="about"></div><h2>About</h2><div class="inline-show-more-text">I help leaders change careers. <a href="https://fixture-coach.test/">My practice</a><span style="display:none">HIDDEN CLAIM</span></div></section>
 <section><div id="featured"></div><h2>Featured</h2><a href="https://fixture-coach.test/results">Client stories</a></section>
 <section><h2>Activity</h2><a href="/in/fixture-coach/recent-activity/all/">Show all posts</a></section>
 </main><aside><a href="mailto:not-the-coach@other.test">Suggestion</a></aside>
 <script>document.querySelector('#contact').onclick=e=>{e.preventDefault();history.pushState({},'',e.currentTarget.href);const modal=document.createElement('div');modal.setAttribute('role','dialog');modal.innerHTML='<h2>Fixture Coach contact info</h2><a href="mailto:coach@fixture-coach.test">Email</a><a href="https://fixture-coach.test/contact">Website</a><button aria-label="Dismiss">Close</button>';modal.style.cssText='position:fixed;top:20px;left:20px;z-index:99';document.body.append(modal);modal.querySelector('button').onclick=()=>{modal.remove();history.pushState({},'','/in/fixture-coach/');};};</script></body></html>`;
// Anonymized structure observed in the account that stopped: h2 member name,
// generated classes, plain paragraphs, and nested Primary content sections.
const currentProfile=profile
 .replace('<main>','<main><section aria-label="Primary content">')
 .replace('</main>','</section></main>')
 .replace('<section><h1>Fixture Coach</h1><div class="text-body-medium break-words">Career coach for experienced professionals</div><div class="text-body-small inline t-black--light break-words">Vancouver, Canada</div>',
  '<section class="generated-card"><a href="/in/fixture-coach/" aria-label="Profile photo"></a><div><div><h2>Fixture Coach</h2></div><p>Career coach for experienced professionals</p><div><p>Vancouver, Canada</p></div></div>')
 .replace('<div class="inline-show-more-text">','<p>')
 .replace('HIDDEN CLAIM</span></div>','HIDDEN CLAIM</span></p>');
function activity(days=7){
 const at=Date.now()-days*86400000,urn=String(BigInt(at)<<22n);
 return `<main><article class="feed-shared-update-v2" data-urn="urn:li:activity:${urn}"><div class="update-components-actor"><a href="${person}">Fixture Coach</a><time datetime="${new Date(at).toISOString()}">7d</time></div><p>Published career advice.</p></article></main>`;
}
async function fixture(fn,handler,{background=false}={}) {
 const browser=await puppeteer.launch({headless:!background,args:['--no-sandbox']});
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
  if(background){const session=await page.target().createCDPSession();const {windowId}=await session.send('Browser.getWindowForTarget');await session.send('Browser.setWindowBounds',{windowId,bounds:{left:-30000,top:0,width:1366,height:768}});await session.detach();}
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
  assert.deepEqual(checkpoints.map(c=>c.linkedinCapture.stage),['profile','activity','contact','complete']);
  assert.deepEqual(steps,['profile_page','activity_page','profile_page','contact','contact']);
  assert.ok(requests.every(url=>url===person||url===person+'recent-activity/all/'),'Only ordinary page navigation is permitted');
 });
});

test('an offscreen ordinary Chrome window completes profile, contact and activity capture without restoring itself',async()=>{
 await fixture(async(page,requests)=>{
  const result=await reader.captureProfile(page,person,{accountId:'background-fixture',beforeCheck:async()=>{}});
  assert.equal(result.linkedinCapture.complete,true);assert.deepEqual(result.emails,['coach@fixture-coach.test']);assert.equal(result.activityStatus,'Active');
  const session=await page.target().createCDPSession();const state=await session.send('Browser.getWindowForTarget');assert.equal(state.bounds.windowState,'normal');assert.equal(state.bounds.left,-30000);await session.detach();
  assert.ok(requests.every(url=>url===person||url===person+'recent-activity/all/'));
 },undefined,{background:true});
});

test('current h2 profile cards capture headline, location, nested About, contact and activity while offscreen',async()=>{
 await fixture(async(page,requests)=>{
  const result=await reader.captureProfile(page,person,{accountId:'current-layout',beforeCheck:async()=>{}});
  assert.equal(result.firstName,'Fixture');assert.equal(result.headline,'Career coach for experienced professionals');assert.equal(result.profileLocation,'Vancouver, Canada');
  assert.equal(result.about,'I help leaders change careers. My practice');assert.deepEqual(result.emails,['coach@fixture-coach.test']);assert.equal(result.activityStatus,'Active');assert.equal(result.linkedinCapture.complete,true);
  assert.ok(!result.about.includes('Fixture Coach'));assert.ok(!result.about.includes('Show all posts'));
  assert.equal(requests.length,3);
 },url=>({status:200,contentType:'text/html',body:url.includes('/recent-activity/')?activity():currentProfile}),{background:true});
});

test('profile readiness waits for the visible identity card to finish hydrating without revisiting the profile',async()=>{
 const hydrating=currentProfile.replace('<a href="/in/fixture-coach/" aria-label="Profile photo"></a>','<a id="self-photo" aria-label="Profile photo"></a>')
  .replace('</body>','<script>setTimeout(()=>document.querySelector("#self-photo").href="/in/fixture-coach/",700);</script></body>');
 await fixture(async(page,requests)=>{
  const state=await reader.openProfile(page,person);
  assert.equal(reader.parseProfile(state,person).firstName,'Fixture');assert.equal(requests.length,1);
 },()=>({status:200,contentType:'text/html',body:hydrating}),{background:true});
});

test('native contact dialogs are read and dismissed while hidden legacy dialogs are ignored',async()=>{
 const native=currentProfile.replace('<main>','<div role="dialog" style="display:none"><a href="mailto:wrong@other.test">Hidden contact</a></div><main>')
  .replace("document.createElement('div')","document.createElement('dialog')").replace("modal.setAttribute('role','dialog')","modal.setAttribute('open','')");
 await fixture(async page=>{
  const result=await reader.captureProfile(page,person,{accountId:'native-dialog',beforeCheck:async()=>{}});
  assert.deepEqual(result.emails,['coach@fixture-coach.test']);assert.equal(result.linkedinCapture.complete,true);assert.equal(result.activityStatus,'Active');
 },url=>({status:200,contentType:'text/html',body:url.includes('/recent-activity/')?activity():native}),{background:true});
});

test('h2 fallback requires the requested member card and rejects suggested, ambiguous and wrong-person cards',()=>{
 const state={url:person,html:currentProfile};assert.equal(reader.parseProfile(state,person).firstName,'Fixture');
 for(const html of [
  currentProfile.replaceAll('/in/fixture-coach/','/in/wrong-member/'),
  currentProfile.replace('<h2>Fixture Coach</h2>','<h2>Fixture Coach</h2><h2>Another member</h2>'),
  '<main><section><h2>Suggested Coach</h2><p>Suggested headline</p></section></main>',
 ])assert.throws(()=>reader.parseProfile({...state,html},person),e=>e.failure.code==='PROFILE_IDENTITY');
 const roleMain=currentProfile.replace('<main>','<div role="main">').replace('</main>','</div>');
 assert.equal(reader.parseProfile({...state,html:roleMain},person).headline,'Career coach for experienced professionals');
});

test('a single offscreen account runtime continues across three current-layout profiles without another Start',async()=>{
 const {createAccountRuntime}=require('../../src/lib/account-runtime.cjs');
 const {fullCapture}=require('../../src/lib/worker-research-queue.cjs');
 await fixture(async(page,requests)=>{
  const viewer={name:'Fixture Owner',profileUrl:'https://www.linkedin.com/in/fixture-owner/'};
  const jobs=[1,2,3].map(i=>({jobId:'batch-'+i,linkedinUrl:person.replace('fixture-coach','fixture-coach-'+i)})),handoffs=[],holds=[];
  const account={enabled:true,authorized:true,confirmed_identity:viewer,control_version:'one-start',processing_token:'one-start'};
  let opens=0;
  const runtime=createAccountRuntime({accountId:'fixture',owner:'owner',pool:{},reader,
   browserOwner:{isOpen:()=>true,open:async()=>{opens++;return {browser:page.browser(),page};}},
   core:{readRuntimeAccount:async()=>({...account}),processingAllowed:async()=>account.authorized,reserveLinkedInCheck:async()=>({}),
    claim:async()=>jobs.length?{job:jobs.shift()}:null,checkpoint:async()=>{},pauseProcessing:async(_p,_id,reason)=>{holds.push(reason);account.authorized=false;}},
   discoveryStore:{claimSource:async()=>null},researchQueue:{fullCapture,handoff:async(_p,id,_o,result)=>{assert.ok(fullCapture(result));handoffs.push({id,result});}},
  });
  await runtime.tick();assert.equal(handoffs.length,1);
  // Re-reading server state is what dashboard polling/reloads do. It must not
  // change persisted intent or create a new session between profiles.
  await runtime.tick();await runtime.tick();await runtime.tick();
  assert.equal(handoffs.length,3);assert.equal(jobs.length,0);assert.deepEqual(holds,[]);assert.equal(account.authorized,true);assert.equal(opens,1);
  assert.deepEqual(handoffs.map(x=>x.result.firstName),['Coach1','Coach2','Coach3']);
  assert.ok(handoffs.every(x=>x.result.emails.length===1&&x.result.linkedinCapture.complete));
  assert.equal(runtime.snapshot().status,'ready');assert.equal(requests.filter(u=>u.endsWith('/feed/')).length,1);
 },url=>{
  if(url.endsWith('/feed/'))return {status:200,contentType:'text/html',body:'<nav></nav><aside class="feed-identity-module"><h3>Fixture Owner</h3><a href="https://www.linkedin.com/in/fixture-owner/">Fixture Owner</a></aside><main>Feed</main>'};
  const i=url.match(/fixture-coach-(\d)/)?.[1]||'1';
  return {status:200,contentType:'text/html',body:(url.includes('/recent-activity/')?activity():currentProfile).replaceAll('fixture-coach','fixture-coach-'+i).replaceAll('Fixture Coach','Coach'+i+' Example')};
 },{background:true});
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
  await assert.rejects(reader.captureProfile(page,person),e=>e.failure.code==='PROFILE_REDIRECT');
 },()=>({status:200,contentType:'text/html',body:profile.replace('<h1>','<script>history.replaceState({},"","/in/wrong-person/")</script><h1>')}));
});

test('an explicitly missing profile is a per-profile failure, not an account restriction',async()=>{
 await fixture(async page=>{
  await assert.rejects(reader.captureProfile(page,person),e=>e.failure.code==='PROFILE_UNAVAILABLE');
 },()=>({status:404,contentType:'text/html',body:'<main><h1>Profile not found</h1></main>'}));
});

test('identity startup reacquires a navigation control replaced while awaiting its activity permit',async()=>{
 await fixture(async page=>{
  await page.setContent(`<header><nav><button aria-label="Me" onclick="document.querySelector('#menu').hidden=false">Me</button></nav></header><div id="menu" class="global-nav__me" hidden><h3>Hydrated Viewer</h3><a href="https://www.linkedin.com/in/hydrated-viewer/">View profile</a></div>`);
  let permits=0;
  const identity=await reader.readSignedInIdentity(page,{leaveMenuOpen:true,beforeCheck:async kind=>{
   assert.equal(kind,'identity');permits++;
   await page.$eval('button',node=>node.replaceWith(node.cloneNode(true)));
  }});
  assert.equal(identity?.name,'Hydrated Viewer');assert.equal(permits,1,'hydration must not replay the activity request');
 });
});

test('a missing profile heading has an actionable stop and bounded diagnostics exclude credentials and hidden data',async()=>{
 await fixture(async page=>{
  await assert.rejects(reader.openProfile(page,person),e=>e.failure?.code==='PAGE_CHANGED'&&/heading did not load/.test(e.failure.reason));
  const diagnostics=await reader.profileDiagnostics(page);
  assert.equal(diagnostics.headings[0].text,'Visible page notice');
  assert.ok(JSON.stringify(diagnostics).length<50000);
  assert.doesNotMatch(JSON.stringify(diagnostics),/SECRET_FORM_VALUE|HIDDEN_STATE_VALUE/);
 },()=>({status:200,contentType:'text/html',body:'<main><h2>Visible page notice</h2><input type="password" value="SECRET_FORM_VALUE"><script>window.privateState="HIDDEN_STATE_VALUE";</script></main>'}));
});

test('manual identity observation waits for rendered self identity without clicking controls or navigating',async()=>{
 await fixture(async(page,requests)=>{
  await page.setContent(`<nav class="global-nav__me"><button aria-label="Me" onclick="document.querySelector('#menu').hidden=false">Me</button><div id="menu" hidden><h3>Manual Viewer</h3><a href="https://www.linkedin.com/in/manual-viewer/">View profile</a></div></nav><main><a href="https://www.linkedin.com/in/author/">Feed author</a></main>`);
  const options={passive:true,manual:true,beforeCheck:()=>assert.fail('No automated page interaction during manual sign-in')};
  for(let n=0;n<3;n++)assert.equal(await reader.readSignedInIdentity(page,options),null);
  assert.equal(await page.$eval('#menu',n=>n.hidden),true,'manual observation must not open the menu');
  await page.click('button[aria-label="Me"]');
  assert.equal((await reader.readSignedInIdentity(page,options)).name,'Manual Viewer');
  await page.setContent('<aside data-view-name="identity-self-profile"><h3>Self Card Viewer</h3><a href="https://www.linkedin.com/in/self-card-viewer/">Self Card Viewer</a></aside><main>Feed</main>');
  assert.equal((await reader.readSignedInIdentity(page,options)).name,'Self Card Viewer');
  await page.setContent('<main><a data-view-name="identity-self-profile" href="https://www.linkedin.com/in/linked-self-card/"><h3>Linked Self Card</h3><p>Career coach</p></a><a href="https://www.linkedin.com/in/feed-author/">Feed Author</a></main>');
  const linked=await reader.readSignedInIdentity(page,options);
  assert.equal(linked?.profileUrl,'https://www.linkedin.com/in/linked-self-card/');
  assert.equal(linked?.name,'Linked Self Card');
  assert.deepEqual(requests,[]);
 });
});

test('generated-class navigation identifies the viewer from the actual Me account menu, including a portal outside the header',async()=>{
 await fixture(async page=>{
  await page.setContent(`<header><nav><button class="generated-class" onclick="document.querySelector('#account-portal').hidden=false">Me</button></nav></header>
   <main><article><h3>Feed Author</h3><a href="https://www.linkedin.com/in/feed-author/">View profile</a></article></main>
   <div hidden id="account-portal"><div><img alt="Portal Viewer"><h3>Portal Viewer</h3><p>Leadership coach</p><a href="https://www.linkedin.com/in/portal-viewer/">View profile</a></div><button>Sign out</button></div>`);
  const steps=[];
  assert.equal(await reader.readSignedInIdentity(page,{passive:true,manual:true}),null,'feed View profile links do not identify the viewer');
  const viewer=await reader.readSignedInIdentity(page,{manual:true,leaveMenuOpen:true,beforeCheck:async kind=>steps.push(kind)});
  assert.equal(viewer?.name,'Portal Viewer');assert.equal(viewer?.profileUrl,'https://www.linkedin.com/in/portal-viewer/');
  assert.deepEqual(steps,['identity']);assert.equal(await page.$eval('#account-portal',n=>n.hidden),false);
  assert.equal((await reader.readSignedInIdentity(page,{passive:true,manual:true})).profileUrl,viewer.profileUrl,'a menu the user opens is also observed without another click');
  await page.setContent('<header><nav><button>Me</button></nav></header><div><div><img alt="Profile picture"><p>Paragraph Viewer</p><p>Business coach</p><a href="https://www.linkedin.com/in/paragraph-viewer/">View profile</a></div><h3>Account</h3><h3>Manage</h3><button>Sign out</button></div>');
  assert.equal((await reader.readSignedInIdentity(page,{passive:true,manual:true}))?.name,'Paragraph Viewer','settings headings must never replace the member name');
 });
});
test('pausing after contact capture retains evidence; resuming skips the completed contact step',async()=>{
 let saved;
 await fixture(async page=>{
  await assert.rejects(reader.captureProfile(page,person,{accountId:'fixture',onCheckpoint:async value=>{saved=structuredClone(value);if(value.linkedinCapture.stage==='contact')throw Object.assign(Error('paused'),{failure:{stage:'control',code:'WORKER_PAUSED',reason:'Paused'}});}}),/paused/);
  assert.equal(saved.linkedinCapture.stage,'contact');assert.deepEqual(saved.emails,['coach@fixture-coach.test']);
  const steps=[];
  const resumed=await reader.captureProfile(page,person,{accountId:'fixture',resume:saved,beforeCheck:async kind=>steps.push(kind)});
  assert.deepEqual(resumed.emails,saved.emails);assert.deepEqual(steps,['profile_page']);assert.equal(resumed.linkedinCapture.complete,true);
 });
});
test('lazy profile sections are read after bounded browser scrolling; generic error headings cannot establish identity',async()=>{
 const lazy=profile.replace('<section><div id="about">','<div style="height:900px"></div><section hidden id="lazy-about"><div id="about">').replace('<section><h2>Activity</h2>','<section hidden id="lazy-activity"><h2>Activity</h2>').replace('</body>','<script>addEventListener("scroll",()=>{document.querySelector("#lazy-about").hidden=false;document.querySelector("#lazy-activity").hidden=false;});</script></body>');
 await fixture(async page=>{
  const steps=[];const result=await reader.captureProfile(page,person,{beforeCheck:async kind=>steps.push(kind)});
  assert.match(result.about,/I help leaders change careers/);assert.equal(result.activityStatus,'Active');assert.equal(steps.filter(kind=>kind==='profile').length,1);
 },url=>({status:200,contentType:'text/html',body:url.includes('/recent-activity/')?activity():lazy}),{background:true});
 assert.throws(()=>reader.parseProfile({url:person,html:'<main><section><h1>Profile not found</h1></section></main>'},person),e=>e.failure.code==='PROFILE_IDENTITY');
 const accessible=profile.replace('<div id="about"></div><h2>About</h2>','<h2><span aria-hidden="true">About</span><span class="visually-hidden">About</span></h2>');
 assert.match(reader.parseProfile({url:person,html:accessible},person).about,/I help leaders change careers/,'Duplicated screen-reader headings still identify the About section');
});
test('follower decisions stop after identity with one page and retain separate connection evidence',async()=>{
 for(const [label,status,reason,count]of [['900 followers','REJECTED','FOLLOWERS_BELOW_MIN',900],['1,000 followers','REJECTED','FOLLOWERS_BELOW_MIN',1000],['many followers','REVIEW','FOLLOWERS_UNPARSEABLE',null],['','REVIEW','FOLLOWERS_NOT_SHOWN',null]]){
  const html=profile.replace('<p>2,345 followers</p>',label?'<p>'+label+'</p>':'');
  await fixture(async(page,requests)=>{
   const steps=[],result=await reader.captureProfile(page,person,{beforeCheck:async kind=>steps.push(kind)});
   assert.equal(result.status,status);assert.equal(result.reasonCode,reason);assert.equal(result.followers.count,count);
   assert.equal(result.connections.count,500);assert.equal(result.linkedinCapture.complete,true);
   assert.deepEqual(steps,['profile_page']);assert.equal(requests.length,1);assert.deepEqual(result.emails,[]);
  },()=>({status:200,contentType:'text/html',body:html}));
 }
});
test('a recent matching-author preview avoids the activity page and profile return',async()=>{
 const html=profile.replace('</main>',activity().replace(/^<main>|<\/main>$/g,'')+'</main>');
 await fixture(async(page,requests)=>{
  const steps=[],result=await reader.captureProfile(page,person,{beforeCheck:async kind=>steps.push(kind)});
  assert.equal(result.activityStatus,'Active');assert.equal(result.activityEvidence.endpoint,'profile_activity_preview');
  assert.deepEqual(result.emails,['coach@fixture-coach.test']);assert.equal(requests.length,1);
  assert.ok(!steps.includes('activity_page'));
 },()=>({status:200,contentType:'text/html',body:html}));
});
test('coach prospecting retains its original business criteria when recent activity is not a qualification requirement',async()=>{
 await fixture(async page=>{const result=await reader.captureProfile(page,person,{requireRecentActivity:false});assert.equal(result.linkedinCapture.complete,true);assert.equal(result.activityStatus,'Inactive');assert.deepEqual(result.emails,['coach@fixture-coach.test']);assert.notEqual(result.decisionStage,'activity');},url=>({status:200,contentType:'text/html',body:url.includes('/recent-activity/')?activity(90):profile}));
});
