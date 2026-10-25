'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {extractActivity}=require('../../src/lib/linkedin-activity.cjs');
const {publishedProfileEmails,publishedProfileWebsites}=require('../../src/lib/profile-public-contacts.cjs');
const {researchProspect,parsePage}=require('../../src/lib/prospect-research.cjs');
const {assessProspect,validateResearch}=require('../../src/lib/prospect-qualification.cjs');
const {createPageRenderer}=require('../../src/lib/public-page-browser.cjs');
const now='2026-10-11T12:00:00.000Z',recent='2026-10-10T12:00:00.000Z',old='2026-08-01T12:00:00.000Z';
const input={followers:{rawText:"2,000 followers",count:2000,checkedAt:now,threshold:1000},firstName:'Ava',lastName:'Morgan',profileIdentityConfirmed:true,lastActivityAt:recent,linkedinUrl:'https://www.linkedin.com/in/ava/',websites:['https://practice.test/']};
const options={now,profileUrn:'urn:li:fsd_profile:ava',profileUrl:input.linkedinUrl};
const urn=date=>'urn:li:activity:'+(BigInt(Date.parse(date))<<22n);
const intro='<html><body><h1>Ava Morgan Coaching</h1><p>Ava Morgan helps leaders develop communication and leadership skills through executive coaching.</p>';

test('normalized feed references select the newest actual post and retain its own author, text and timestamp',()=>{
 const response={data:{'*elements':['old','new']},included:[
  {entityUrn:'new',urn:urn(recent),actor:{profileUrn:options.profileUrn},commentary:{text:{text:'Newest actual post'}}},
  {entityUrn:'old',createdAt:Date.parse(old),commentary:{text:'Older long post '.repeat(100)}},
  {entityUrn:'unrelated',createdAt:Date.parse(now),lastModifiedAt:Date.parse(now),elements:[],commentary:{text:'Not in the requested feed'}}
 ]};
 const result=extractActivity(response,options);
 assert.equal(result.activityStatus,'Active');assert.equal(result.lastActivityAt,recent);assert.equal(result.latestPostText,'Newest actual post');
 assert.equal(result.activityEvidence.selected.association,'matching_author');assert.equal(result.activityEvidence.selected.method,'activity_urn');
 assert.equal(validateResearch(require('./fixtures.cjs').research({...result})).activityEvidence.selected.postUrn,urn(recent));
});
test('empty, undated, unrelated and future timestamps cannot prove inactivity or recent activity',()=>{
 for(const response of [
  {data:{elements:[]},included:[{urn:urn(recent)}]},
  {data:{elements:[{commentary:{text:'A real but undated post'},lastModifiedAt:Date.parse(recent)}]}},
  {data:{elements:[{urn:urn('2026-10-12T12:00:00Z')}]}},
  {data:{elements:[{createdAt:Date.parse(recent),actor:{profileUrn:'urn:li:fsd_profile:someone-else'}}]}}
 ]){const r=extractActivity(response,options);assert.equal(r.activityStatus,'Unknown');assert.equal(r.lastActivityAt,null);}
 const r=extractActivity({data:{elements:[{createdAt:Date.parse(old)}]}},options);
 assert.equal(r.activityStatus,'Inactive');assert.equal(r.lastActivityAt,old);
 assert.equal(extractActivity({data:{elements:[{createdAt:Date.parse(old)},{}]}},options).activityStatus,'Unknown');
});
test('public About emails support explicit invitations, joined headings, emoji and sentence punctuation without guessing malformed addresses',()=>{
 for(const about of ['Email me: ava@practice.test','minutesEmail: ava@practice.test','✉️ ava@practice.test------------------','reach out at Ava@practice.test','emailing me at ava@practice.test. Credentials']){
  assert.deepEqual(publishedProfileEmails({...input,about}).map(c=>c.address),['ava@practice.test']);
 }
 for(const about of ['Email: Team@Practice.comAre you interested?','Let’s connect.ava@practice.test','Let’s connect.rosscox@actioncoach.com','Sample email: ava@practice.test','A client’s email: ava@practice.test'])assert.equal(publishedProfileEmails({...input,about}).length,0);
 assert.equal(publishedProfileEmails({...input,about:'Email me: ava@practice.test',profileIdentityConfirmed:false}).length,0);
});
test('published bare domains, www URLs and saved CRM websites are read; email domains and platform links do not become guessed websites',async()=>{
 const about='Visit www.practice.test/contact or OtherBrand.test/about. Email: ava@inbox.test. https://scheduler.zoom.us/ava/session Success in life.Along with growth.Decisions matter.';
 assert.deepEqual(publishedProfileWebsites({...input,about}),['https://www.practice.test/contact','https://otherbrand.test/about']);
 const calls=[];
 await researchProspect({...input,about:'',websites:[],knownWebsite:'https://saved.test/actual'},{now,ai:false,fetchPage:async url=>{calls.push(url);return {url,html:intro+'</body></html>'};}});
 assert.deepEqual(calls,['https://saved.test/actual']);
});
test('an explicit personal parent-domain email on a matching practice subdomain is attributed',async()=>{
 const r=await researchProspect({...input,websites:['https://ava.parent.test/']},{now,ai:false,fetchPage:async url=>({url,html:intro+'<a href="mailto:amorgan@parent.test">Write to Ava</a></body></html>'})});
 assert.equal(r.contacts[0].address,'amorgan@parent.test');
});
test('published profile contacts qualify before website work and the saved continuation retains qualification',async()=>{
 let calls=0;
 const profile={...input,about:'Email me: ava@practice.test'};
 const first=await researchProspect(profile,{now,ai:false,qualificationFirst:true,fetchPage:async()=>{calls++;throw Error('Unavailable');}});
 assert.equal(calls,0);assert.equal(first.crawl.complete,false);assert.equal(assessProspect(first,{now,email:'ava@practice.test'}).qualification.qualified,true);
 const next=await researchProspect(profile,{now,ai:false,qualificationFirst:true,previousResearch:first,fetchPage:async url=>{calls++;return {url,html:intro+'</body></html>'};}});
 assert.equal(calls,1);assert.equal(next.crawl.complete,true);assert.equal(next.contacts[0].source,'linkedin');
 const unknown=await researchProspect({...profile,lastActivityAt:null,activityStatus:'Inactive',websites:[]},{now,ai:false});
 assert.equal(assessProspect(unknown,{now,email:'ava@practice.test'}).qualification.activity,'UNKNOWN');
});
test('attributed plain-text personal contacts work across a parent domain or Gmail, excluding testimonials and vendor credits',async()=>{
 for(const [address,body,path]of [['amorgan@parent.test','<p>Contact us: amorgan@parent.test</p>','/contact'],['ava.morgan@gmail.com','<footer>Contact: ava.morgan@gmail.com</footer>','/'],['ava@secondbrand.test','<p>For questions reach out to ava@secondbrand.test</p>','/']]){
  const r=await researchProspect({...input,websites:['https://practice.test'+path]},{now,ai:false,fetchPage:async url=>({url,html:intro+body+'<blockquote>Email client@client.test</blockquote><div class="vendor">Email ava@designer.test</div></body></html>'})});
  assert.deepEqual(r.contacts.map(c=>c.address),[address]);assert.equal(assessProspect(r,{now,email:address}).qualification.qualified,true);
 }
 const wrong=await researchProspect(input,{now,ai:false,fetchPage:async url=>({url,html:'<html><body><h1>Someone Else Coaching</h1><p>Someone Else is an executive coach and helps leaders build skills.</p><footer>Contact someone@gmail.com</footer></body></html>'})});
 assert.equal(wrong.contacts.length,0);
});
test('binary-looking responses, challenge pages and missing roots remain incomplete; rendering can recover an actual public page',async()=>{
 for(const html of ['\uFFFD'.repeat(500),'<html><title>Just a moment...</title><body>Verify you are human '+ 'challenge '.repeat(100)+'</body></html>'])assert.equal(parsePage(html,input.websites[0]).readable,false);
 const missing=await researchProspect(input,{now,ai:false,fetchPage:async()=>{throw Object.assign(Error('HTTP 404'),{httpStatus:404});}});
 assert.equal(missing.crawl.complete,false);assert.equal(missing.crawl.retryable,false);assert.match(missing.crawl.stoppedReason,/unavailable/);
 let rendered=0;
 const recovered=await researchProspect(input,{now,ai:false,fetchPage:async url=>({url,html:'<html><body><div id=app></div></body></html>'}),renderPage:async url=>{rendered++;return{url,html:intro+'<footer>Contact ava@practice.test</footer></body></html>'};}});
 assert.equal(rendered,1);assert.equal(recovered.contacts[0].address,'ava@practice.test');assert.equal(recovered.crawl.evidenceSufficient,true);assert.equal(recovered.crawl.retryable,false);
});
test('an old incomplete checkpoint rechecks attribution once, then resumes without repeatedly fetching its root',async()=>{
 const fetchPage=async url=>({url,html:intro+'<a href="/contact">Contact</a><a href="/notes">Notes</a><footer>Contact ava@secondbrand.test</footer></body></html>'});
 let r=await researchProspect(input,{now,ai:false,maxPages:1,fetchPage});r.crawl.attributionVersion=0;
 const calls=[];
 r=await researchProspect(input,{now,ai:false,maxPages:1,previousResearch:r,fetchPage:async url=>{calls.push(url);return fetchPage(url);}});
 assert.equal(r.crawl.attributionVersion,3);
 r=await researchProspect(input,{now,ai:false,previousResearch:r,fetchPage:async url=>{calls.push(url);return fetchPage(url);}});
 assert.equal(calls.length,0,'Sufficient saved attributed contact evidence needs no recrawl');assert.equal(r.crawl.retryable,false);
});
test('browser fallback uses isolated contexts, filters all requests, shares bounded renders and closes contexts',async()=>{
 let contexts=0,closed=0,handler,fetches=0;const requests=[];
 const browser={userAgent:async()=> 'Fixture',createBrowserContext:async()=>{contexts++;return{close:async()=>{closed++;},newPage:async()=>({
  setRequestInterception:async()=>{},on:(event,fn)=>{assert.equal(event,'request');handler=fn;},url:()=>input.websites[0],
  goto:async()=>{for(const [method,url,type]of [['GET',input.websites[0],'document'],['POST','https://practice.test/form','fetch'],['GET','http://127.0.0.1/private','xhr'],['GET','https://practice.test/image.png','image']]){
   const request={method:()=>method,url:()=>url,resourceType:()=>type,respond:async v=>requests.push({method,url,v}),abort:async()=>requests.push({method,url,aborted:true})};await handler(request);
  }},waitForNetworkIdle:async()=>{},evaluate:async fn=>fn.toString().includes('clone.outerHTML')?intro+'</body></html>':undefined
 })};}};
 const render=createPageRenderer(browser,{maxPages:1,fetchResource:async(url,opts)=>{fetches++;assert.equal(opts.resource,true);assert.equal(opts.followRedirects,false);assert.equal(opts.userAgent,'Fixture');return{status:200,headers:{'content-type':'text/html','set-cookie':'secret'},body:Buffer.from('HTML')};}});
 const [a,b]=await Promise.all([render(input.websites[0]),render(input.websites[0])]);assert.equal(a,b);assert.equal(contexts,1);assert.equal(closed,1);assert.equal(fetches,1);assert.equal(requests.filter(r=>r.aborted).length,3);assert.ok(!requests[0].v.headers['set-cookie']);
 await assert.rejects(render('https://other.test/'),/budget/);
});
