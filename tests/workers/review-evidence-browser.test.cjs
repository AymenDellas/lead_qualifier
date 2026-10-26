'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),puppeteer=require('puppeteer');
const reader=require('../../src/lib/linkedin-browser-page.cjs');
const person='https://www.linkedin.com/in/evidence-fixture/';
const profile=(location,audience)=>`<!doctype html><html><head><meta charset="utf-8"></head><body><main><section><h1>Evidence Fixture</h1><div class="text-body-medium">Career coach</div><div data-view-name="profile-card-location">${location}</div>${audience}</section><section><div id="about"></div><h2>About</h2><p>Coaching experienced leaders.</p></section><section><h2>النشاط</h2><a href="${person}recent-activity/all/">كل المنشورات</a><div id="audience"></div></section></main></body></html>`;
test('lazy localized follower header is read on the existing profile before a missing-count decision',async()=>{
 const browser=await puppeteer.launch({headless:true});try{
  const page=await browser.newPage(),requests=[],checks=[];
  await page.setRequestInterception(true);page.on('request',r=>{if(r.isNavigationRequest())requests.push(r.url());r.respond({status:200,contentType:'text/html',body:profile('Toronto, Canada','').replace('<section><h2>النشاط</h2>','<div style="height:1000px"></div><section><h2>النشاط</h2>').replace('</body>','<script>addEventListener("scroll",()=>{document.querySelector("#audience").textContent="200 followers";});</script></body>')}).catch(()=>{});});
  // The fixture's observed scroll hydrates a low count. There must be no
  // activity/contact/site navigation before rejecting that actual count.
  const result=await reader.captureProfile(page,person,{beforeCheck:async kind=>checks.push(kind)});
  assert.equal(result.followers.count,200);assert.equal(result.reasonCode,'FOLLOWERS_BELOW_MIN');assert.equal(result.status,'REJECTED');assert.equal(requests.length,1);assert.deepEqual(checks,['profile_page','profile']);
 }finally{await browser.close();}
});
test('rendered country exits precede further profile work; country ambiguity never silently passes',async()=>{
 const browser=await puppeteer.launch({headless:true});try{
  const page=await browser.newPage();let location='',audience='',navs=0;
  await page.setRequestInterception(true);page.on('request',r=>{if(r.isNavigationRequest())navs++;r.respond({status:200,contentType:'text/html',body:profile(location,audience)}).catch(()=>{});});
  for(const entry of [
   {location:'Paris, France',audience:'',reason:'LOCATION_OUTSIDE_TARGET',status:'REJECTED'},
   {location:'Paris, France',audience:'<p>200 followers</p>',reason:'LOCATION_OUTSIDE_TARGET',status:'REJECTED'},
   {location:'Toronto',audience:'<p>2,345 followers</p>',reason:'LOCATION_UNCONFIRMED',status:'REVIEW'},
   {location:'Toronto',audience:'<p>200 followers</p>',reason:'FOLLOWERS_BELOW_MIN',status:'REJECTED'},
  ]){
   location=entry.location;audience=entry.audience;const before=navs,checks=[];
   const result=await reader.captureProfile(page,person,{requireTargetLocation:true,beforeCheck:async kind=>checks.push(kind)});
   assert.equal(result.targetLocationRequired,true);assert.equal(result.reasonCode,entry.reason);assert.equal(result.status,entry.status);assert.equal(navs-before,1);assert.deepEqual(checks,['profile_page']);
  }
 }finally{await browser.close();}
});
test('foreign suggested followers cannot wake readiness before the owner audience hydrates',async()=>{
 const browser=await puppeteer.launch({headless:true});try{
  const page=await browser.newPage();let navs=0;
  const body=profile('Toronto, Canada','<aside><a href="/in/suggested/">Other person</a><p>25,000 followers</p></aside>')
   .replace('<section><h2>النشاط</h2>','<div style="height:1000px"></div><section><h2>النشاط</h2>')
   .replace('</body>','<script>addEventListener("scroll",()=>setTimeout(()=>document.querySelector("#audience").textContent="200 followers",150),{once:true});</script></body>');
  await page.setRequestInterception(true);page.on('request',r=>{if(r.isNavigationRequest())navs++;r.respond({status:200,contentType:'text/html',body}).catch(()=>{});});
  const result=await reader.captureProfile(page,person,{requireTargetLocation:true});
  assert.equal(result.followers.count,200);assert.equal(result.reasonCode,'FOLLOWERS_BELOW_MIN');assert.equal(navs,1);
 }finally{await browser.close();}
});
