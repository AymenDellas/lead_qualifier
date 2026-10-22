'use strict';

// Read only rendered page content. No private endpoints, session-cookie reads,
// application-state scraping, fingerprint changes, or synthetic DOM clicks.
const cheerio = require('cheerio');
const {profileUrl} = require('./linkedin-workers.cjs');
const {cleanIdentity} = require('./linkedin-session-identity.cjs');
const {pageSignal, failure} = require('./linkedin-session-policy.cjs');
const text = value => String(value || '').replace(/\s+/g, ' ').trim();
function problem(code, reason) {
 return Object.assign(new Error(reason), {failure: {stage:'linkedin', code, reason, retryable:false}});
}
function externalUrl(value, redirected=false) {
 try {
  const u = new URL(value);
  if(u.protocol !== 'https:' && u.protocol !== 'http:' || u.username || u.password) return null;
  if(!redirected&&u.hostname==='www.linkedin.com'&&u.pathname==='/redir/redirect'&&u.searchParams.has('url'))return externalUrl(u.searchParams.get('url'),true);
  if(/(^|\.)(linkedin\.com|licdn\.com)$/.test(u.hostname)) return null;
  return u.href;
 } catch { return null; }
}
async function snapshot(page) {
 return page.evaluate(() => {
  const roots = [...document.querySelectorAll('main,header,nav,[role="dialog"],.feed-identity-module,.profile-card')]
   .filter(n => !n.parentElement?.closest('main,header,nav,[role="dialog"],.feed-identity-module,.profile-card'));
  const content = roots.filter(n => n.getClientRects().length).map(root => {
   const clone = root.cloneNode(true), originals = [root,...root.querySelectorAll('*')], copies = [clone,...clone.querySelectorAll('*')];
   originals.forEach((n,i) => {
    if(['SCRIPT','STYLE','SVG','NOSCRIPT','TEMPLATE','IFRAME'].includes(n.tagName) || n.hidden || getComputedStyle(n).display==='none' || getComputedStyle(n).visibility==='hidden') copies[i]?.remove();
    if(n.tagName==='A'&&n.href)copies[i]?.setAttribute('href',n.href);
   });
   clone.querySelectorAll('*').forEach(n => {
    for(const a of [...n.attributes]) if(!['href','class','id','role','aria-label','aria-hidden','alt','datetime','data-urn','data-view-name'].includes(a.name)) n.removeAttribute(a.name);
   });
   return clone.outerHTML;
  }).join('');
  // These are account notices, not phrases found in somebody's post or bio.
  const alerts = [...document.querySelectorAll('[role="alert"],[role="dialog"]')].filter(n => n.getClientRects().length).map(n => n.innerText).join('\n');
  return {url:location.href, title:document.title, notice:alerts.slice(0,12000), html:'<html><body>'+content+'</body></html>'};
 });
}
async function inspected(page, options={}, response) {
 options.checkResponse?.(response?.status?.() || 0, page.url());
 const state=await snapshot(page);
 if(Buffer.byteLength(state.html)>2*1024*1024) throw problem('PAGE_CONTENT_SIZE','Rendered LinkedIn content exceeded the reading limit.');
 const signal=pageSignal({url:state.url,status:response?.status?.()||0,text:state.title+'\n'+state.notice});
 if(signal) throw Object.assign(new Error(signal.reason),{failure:failure(signal)});
 return state;
}
async function firstControl(page, selector, match=()=>true) {
 const elements=await page.$$(selector);
 let selected=null;
 for(const el of elements) {
  try {
   const info=await el.evaluate(n=>({href:n.href||'',label:n.getAttribute('aria-label')||n.textContent||'',visible:!!n.getClientRects().length,disabled:!!n.disabled||n.getAttribute('aria-disabled')==='true'}));
   if(!selected&&info.visible&&!info.disabled&&match(info)) selected=el;
   else await el.dispose();
  }catch(error){await el.dispose().catch(()=>{});throw error;}
 }
 return selected;
}
async function clickControl(page, selector, match, kind, options={}) {
 const el=await firstControl(page,selector,match);
 if(!el) return false;
 try {
  await inspected(page,options);
  await options.beforeCheck?.(kind);
  await el.click();
  return true;
 } finally {await el.dispose();}
}
async function openProfile(page, person, options={}) {
 const expected=profileUrl(person);
 if(!expected) throw problem('PROFILE_IDENTITY','The requested LinkedIn profile URL is invalid.');
 await options.beforeCheck?.('profile_page');
 const response=await page.goto(expected,{waitUntil:'domcontentloaded',timeout:45000});
 await inspected(page,options,response);
 await page.waitForSelector('main h1',{timeout:12000});
 const state=await inspected(page,options);
 if(profileUrl(state.url)!==expected) throw problem('PROFILE_IDENTITY','LinkedIn opened a different profile. No facts were assigned to the requested person.');
 return state;
}
function signedInIdentity(state, now=new Date().toISOString()) {
 const $=cheerio.load(state.html), identities=[];
 // Never infer the viewer from feed authors, suggestions, the configured email,
 // or the profile currently being inspected.
 const scopes=$('.feed-identity-module,.profile-card:has(a[href*="/me/"]),.profile-card:has(a[href*="/dashboard/"]),[data-view-name="identity-self-profile"],.global-nav__me,[data-view-name="nav-settings__dropdown"]');
 scopes.each((_i,node)=>{
  const scope=$(node), links=scope.find('a[href]').toArray().filter(n=>profileUrl($(n).attr('href')));
  const urls=[...new Set(links.map(n=>profileUrl($(n).attr('href'))))];
  if(urls.length!==1)return;
  const link=links.find(n=>!/^view profile$/i.test(text($(n).text())) && text($(n).text()));
  const name=text(scope.find('h2,h3,.artdeco-entity-lockup__title,.feed-identity-module__actor-meta').first().text()) || text(link&&$(link).text()) || text(scope.find('img[alt]').first().attr('alt')).replace(/^(?:photo of|profile photo of)\s+/i,'');
  if(!name||/^(?:me|view profile|profile photo|profile)$/i.test(name))return;
  const identity=cleanIdentity({name,profileUrl:urls[0],checkedAt:now});
  if(identity)identities.push(identity);
 });
 const urls=[...new Set(identities.map(i=>i.profileUrl))];
 return urls.length===1?identities[0]:null;
}
async function readSignedInIdentity(page,options={}) {
 await page.waitForSelector('nav,header,.feed-identity-module,.profile-card',{timeout:12000});
 let identity=signedInIdentity(await inspected(page,options));
 if(identity)return identity;
 const opened=await clickControl(page,'button.global-nav__primary-link-me-menu-trigger,.global-nav__me button,button[aria-label="Me"]',()=>true,'identity',options);
 if(!opened)return null;
 await page.waitForSelector('.global-nav__me a[href*="/in/"],[data-view-name="nav-settings__dropdown"] a[href*="/in/"]',{timeout:6000}).catch(()=>{});
 identity=signedInIdentity(await inspected(page,options));
 // Close the menu through its actual button so it cannot cover later controls.
 const control=await firstControl(page,'button.global-nav__primary-link-me-menu-trigger,.global-nav__me button,button[aria-label="Me"]');
 if(control)try{await control.click();}finally{await control.dispose();}
 return identity;
}
function section($, label) {
 return $('main section').toArray().map(n=>$(n)).find(n=>{
  const heading=n.find('h2').first(),title=text(heading.find('[aria-hidden="true"]').first().text()||heading.text());
  return n.find('#'+label.toLowerCase().replace(/ /g,'_')).length||title.toLowerCase()===label.toLowerCase();
 });
}
function parseProfile(state,person,accountId='',now=new Date().toISOString()) {
 const expected=profileUrl(person), $=cheerio.load(state.html), heading=$('main h1');
 if(!expected||profileUrl(state.url)!==expected||heading.length!==1||!text(heading.text()))throw problem('PROFILE_IDENTITY','The rendered page did not confirm the requested LinkedIn profile.');
 const top=heading.closest('section').length?heading.closest('section'):heading.parent().parent();
 if(!top.find('.text-body-medium,[data-view-name="profile-card-headline"],a[href*="/overlay/contact-info"],.dist-value,.pv-text-details__left-panel').length)throw problem('PROFILE_IDENTITY','A profile heading was present, but its rendered identity card was not confirmed.');
 const name=text(heading.text()), parts=name.split(' '), about=section($,'About'), featured=section($,'Featured');
 const summary=about?text(about.find('.inline-show-more-text,.pv-shared-text-with-see-more,.display-flex.ph5.pv3').first().text()||about.clone().find('h2,button').remove().end().text()):'';
 const websites=[];
 for(const area of [about,featured]) if(area)area.find('a[href]').each((_i,n)=>{const u=externalUrl($(n).attr('href'));if(u&&!websites.includes(u))websites.push(u);});
 const distance=text(top.find('.dist-value,.distance-badge,[aria-label*="degree connection"]').first().text());
 const connection=/^1st$|1st degree/i.test(distance)?'CONNECTED':/^2nd$|^3rd$|[23](?:nd|rd) degree/i.test(distance)?'NOT_CONNECTED':top.find('button').toArray().some(n=>/^pending$/i.test(text($(n).text())))?'PENDING':'UNKNOWN';
 return {url:expected,firstName:parts[0],lastName:parts.slice(1).join(' '),headline:text(top.find('.text-body-medium.break-words,.text-body-medium,[data-view-name="profile-card-headline"]').first().text()),
  about:summary,profileLocation:text(top.find('.pv-text-details__left-panel.mt2 .text-body-small,.text-body-small.inline.t-black--light.break-words,[data-view-name="profile-card-location"]').first().text()),
  profileIdentityConfirmed:true,websites,website:websites[0]||'',websiteSource:websites.length?'visible_profile':'',emails:[],emailSource:'',primaryEmail:'',
  linkedinContact:{accountId,connection,openProfile:'UNKNOWN',checkedAt:now,source:'WORKER',note:'Connection status read from the matching rendered profile. Free messaging is not inferred from a Message button or Premium badge.'},
  activityStatus:'Unknown',lastActivityAt:null,latestPostText:'',status:'PENDING',logs:['Profile identity confirmed from the rendered page.'],
  linkedinAccountId:accountId,linkedinCapture:{version:2,stage:'profile',complete:false,checkedAt:now}};
}
function parseContact(state,person) {
 const $=cheerio.load(state.html), modal=$('[role="dialog"]');
 let url;try{url=new URL(state.url);}catch{}
 if(!modal.length||!url||profileUrl(url.origin+url.pathname.replace(/\/overlay\/contact-info\/?$/,''))!==profileUrl(person))return null;
 const emails=[],websites=[];
 modal.find('a[href]').each((_i,n)=>{
  const href=$(n).attr('href')||'';
  if(/^mailto:/i.test(href)) {
   const email=href.slice(7).split('?')[0].trim();
   if(/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(email)&&!emails.includes(email))emails.push(email);
  } else {const u=externalUrl(href);if(u&&!websites.includes(u))websites.push(u);}
 });
 return {emails,websites};
}
async function readActivity(page,person,options={}) {
 const {activityRoute,extractActivityPage}=require('./linkedin-activity-page.cjs');
 if(profileUrl(page.url())!==profileUrl(person))await openProfile(page,person,options);
 const state=await inspected(page,options),$=cheerio.load(state.html);
 const routes=$('main a[href]').toArray().map(n=>activityRoute(new URL($(n).attr('href'),state.url).href,person)).filter(Boolean);
 if(!routes.length)return null;
 if(!await clickControl(page,'main a[href*="/recent-activity/"]',n=>routes.includes(n.href),'activity_page',options))return null;
 await page.waitForFunction(()=>/\/recent-activity\//.test(location.pathname),{timeout:12000});
 await inspected(page,options);
 await page.waitForFunction(()=>document.querySelector('main [data-urn*="urn:li:activity"],main .feed-shared-update-v2')||[...document.querySelectorAll('main h2')].some(n=>n.textContent.trim()==='Feed post')||/nothing to see for now/i.test(document.querySelector('main')?.innerText||''),{timeout:10000}).catch(()=>{});
 const activity=await inspected(page,options);
 return {...extractActivityPage(activity.html,{profileUrl:person,pageUrl:activity.url,now:options.now}),activityCheck:{httpStatus:200,retryable:false}};
}
async function captureProfile(page,person,options={}) {
 let state=await openProfile(page,person,options);
 parseProfile(state,person,options.accountId);
 // Some LinkedIn layouts hydrate About/Activity only when their section is
 // approached. Limit scrolling to this profile and count every attempt.
 for(let pass=0;pass<3;pass++) {
  const $=cheerio.load(state.html);
  if(section($,'About')&&$('main a[href*="/recent-activity/"]').length)break;
  await options.beforeCheck?.('profile');
  await page.mouse.move(600,500);await page.mouse.wheel({deltaY:650});
  await page.waitForFunction(()=>{
   const about=document.querySelector('main #about')?.closest('section'),activity=document.querySelector('main a[href*="/recent-activity/"]');
   return about?.getClientRects().length&&activity?.getClientRects().length;
  },{timeout:2000}).catch(()=>{});
  state=await inspected(page,options);
  if(profileUrl(state.url)!==profileUrl(person))throw problem('PROFILE_IDENTITY','The page changed while loading profile sections. Processing stopped.');
 }
 // Expand only the requested profile's About text. Never click messaging,
 // invitation, or other account-changing controls while qualifying a lead.
 if(await clickControl(page,'main section:has(#about) button.inline-show-more-text__button,main section:has(#about) button[aria-label*="see more"]',()=>true,'profile',options))state=await inspected(page,options);
 const result=parseProfile(state,person,options.accountId);
 const saved=options.resume, capturedAt=Date.parse(saved?.linkedinCapture?.checkedAt);
 const resumeContact=saved?.linkedinCapture?.version===2&&saved.linkedinCapture.stage==='contact'&&saved.profileIdentityConfirmed&&profileUrl(saved.url)===profileUrl(person)&&saved.linkedinAccountId===options.accountId&&Number.isFinite(capturedAt)&&Date.now()-capturedAt>=0&&Date.now()-capturedAt<86400000;
 if(resumeContact){
  result.emails=saved.emails||[];result.emailSource=saved.emailSource||'';
  result.websites=[...new Set([...(saved.websites||[]),...result.websites])];result.website=result.websites[0]||'';result.websiteSource=saved.websiteSource||result.websiteSource;
  result.logs.push('Resumed saved contact evidence; the contact panel was not reopened.');
 }
 // Do not overwrite a later saved stage with an earlier checkpoint.
 if(resumeContact)result.linkedinCapture.stage='contact';
 await options.onCheckpoint?.(result);
 const contactOpened=!resumeContact&&await clickControl(page,'main a[href*="/overlay/contact-info"]',n=>{
  try{const u=new URL(n.href);return profileUrl(u.origin+u.pathname.replace(/\/overlay\/contact-info\/?$/,''))===profileUrl(person);}catch{return false;}
 },'contact',options);
 if(contactOpened) {
  await page.waitForSelector('[role="dialog"]',{timeout:8000});
  const contact=parseContact(await inspected(page,options),person);
  if(!contact)throw problem('PAGE_CHANGED','The contact panel could not be associated with the requested profile. Saved profile facts are retained.');
  result.emails=contact.emails;result.emailSource=contact.emails.length?'linkedin':'';
  result.websites=[...new Set([...contact.websites,...result.websites])];result.website=result.websites[0]||'';
  if(contact.websites.length)result.websiteSource='contact_modal';
  const closed=await clickControl(page,'[role="dialog"] button[aria-label*="Dismiss"],[role="dialog"] button[aria-label*="Close"],[role="dialog"] button.artdeco-modal__dismiss',()=>true,'contact',options);
  if(!closed)throw problem('PAGE_CHANGED','The contact panel could not be closed. Processing stopped before another action.');
  await page.waitForFunction(()=>![...document.querySelectorAll('[role="dialog"]')].some(n=>n.getClientRects().length),{timeout:8000});
 }else if(!resumeContact)result.logs.push('No rendered contact-info control was available. No contact details were guessed.');
 result.linkedinCapture.stage='contact';await options.onCheckpoint?.(result);
 const activity=await readActivity(page,person,options);
 if(activity)Object.assign(result,activity);
 else result.logs.push('No observed activity link was available; recent activity remains unconfirmed.');
 result.linkedinCapture={...result.linkedinCapture,stage:'complete',complete:true};result.linkedinCapturedAt=new Date().toISOString();
 await options.onCheckpoint?.(result);
 return result;
}
module.exports={snapshot,inspected,firstControl,clickControl,signedInIdentity,readSignedInIdentity,parseProfile,parseContact,openProfile,readActivity,captureProfile,externalUrl};
