'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {parseProfile}=require('../../src/lib/linkedin-browser-page.cjs');
const {extractActivityPage,relativeDate}=require('../../src/lib/linkedin-activity-page.cjs');
const person='https://www.linkedin.com/in/evidence-fixture/',now='2026-10-25T12:00:00.000Z';
const top=audience=>`<main><section><h1>Evidence Fixture</h1><div class="text-body-medium">Career coach</div><a href="${person}overlay/contact-info/">Contact</a>${audience}</section>`;
const parse=html=>parseProfile({url:person,html:html+'</main>'},person,'fixture',now);
test('nested suggested-member location cannot override the requested member country',()=>{
 const html=top('<div><a href="/in/foreign/">Other member</a><div data-view-name="profile-card-location">Paris, France</div></div><div data-view-name="profile-card-location">Toronto, Canada</div>');
 assert.equal(parse(html).profileLocation,'Toronto, Canada');
});
test('direct div, inline split counts, accessible audience labels and connections remain separate evidence',()=>{
 for(const html of ['<div>2,345 followers</div><div>500+ connections</div>','<div><span>2,345</span> followers · <span>500+</span> connections</div>','<button aria-label="2,345 followers">Audience</button><p>500+ connections</p>']){
  const record=parse(top(html));assert.equal(record.followers.count,2345,html);assert.equal(record.connections.count,500,html);
 }
 assert.equal(parse(top('<p>I help 2,345 followers</p><p>500+ connections</p>')).followers.count,null,'prose does not establish audience size');
 assert.equal(parse(top('<p>500+ connections</p>')).followers.count,null,'connections never substitute for followers');
 for(const foreign of ['<aside><h3>Suggested</h3><a href="/in/foreign/">Other member</a><span>25,000 followers</span></aside>','<div><a href="/in/foreign/">Other member</a><span>25,000 followers</span></div>','<div><a href="/company/foreign/">Other company</a><span>25,000 followers</span></div>'])assert.equal(parse(top(foreign)).followers.count,null,'nested foreign cards are not owner evidence');
});
test('own localized Activity header can supply followers but post prose and related members cannot',()=>{
 const header='<section><h2>النشاط</h2><div>2,345 followers</div><a href="'+person+'recent-activity/all/">كل المنشورات</a>';
 const card='<article><p>9,999 followers</p></article>';
 assert.equal(parse(top('')+header+card+'</section>').followers.count,2345);
 assert.equal(parse(top('')+header.replace('<div>2,345 followers</div>','')+card+'</section><aside>9,999 followers</aside>').followers.count,null);
 assert.equal(parse(top('<p>2,345 followers</p><p>2,346 followers</p>')).followers.count,null,'conflicting counts still need review');
});
const card=(author,date,heading='Feed post')=>`<div><h2>${heading}</h2><div><a href="${author}">Author</a><p>${date}</p></div><p>Post body</p></div>`;
const settings={profileUrl:person,pageUrl:person+'recent-activity/all/',now};
test('foreign actors do not create unresolved own activity; undated matching or missing actors still do',()=>{
 const ownOld=card(person,'9yr'),foreign=card('https://www.linkedin.com/in/foreign/','2d');
 const known=extractActivityPage(ownOld+foreign,settings);assert.equal(known.activityStatus,'Inactive');assert.equal(known.activityEvidence.unresolved,0);assert.equal(known.activityEvidence.ignoredForeign,1);
 assert.equal(extractActivityPage(ownOld+card(person,''),settings).activityStatus,'Unknown');
 assert.equal(extractActivityPage(ownOld+card('','2d'),settings).activityStatus,'Unknown');
 assert.equal(extractActivityPage(foreign,settings).activityStatus,'Unknown');
});
test('localized rounded dates keep the thirty-day uncertainty boundary and author association',()=>{
 for(const label of ['منذ يومين','‏٢ أيام‏','منذ أسبوعين','hace 2 días','il y a 2 jours','2 days ago'])assert.ok(relativeDate(label,now),label);
 for(const label of ['منذ شهر','4w','1mo','I posted 2 days ago'])assert.equal(relativeDate(label,now),null,label);
 assert.equal(extractActivityPage(card(person,'منذ يومين','منشور الموجز'),settings).activityStatus,'Active');
 const semantic=`<main><article><header><a href="${person}">Owner</a><time datetime="2026-10-24T12:00:00Z">Yesterday</time></header><p>Body</p></article></main>`;
 assert.equal(extractActivityPage(semantic,settings).activityStatus,'Active');
 const legacy=`<article class="feed-shared-update-v2"><div class="update-components-actor"><a href="${person}">Owner</a><p>2d</p></div></article>`;
 assert.equal(extractActivityPage(card(person,'9yr')+legacy,settings).activityStatus,'Active','mixed rendered card layouts are all inspected');
});
