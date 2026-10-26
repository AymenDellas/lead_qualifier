'use strict';

// Read only rendered page content. No private endpoints, session-cookie reads,
// application-state scraping, fingerprint changes, or synthetic DOM clicks.
const cheerio = require('cheerio');
const {profileUrl} = require('./linkedin-workers.cjs');
const {cleanIdentity} = require('./linkedin-session-identity.cjs');
const {pageSignal, failure} = require('./linkedin-session-policy.cjs');
const telemetry=require('./engine-telemetry.cjs');
const followerPolicy=require('./follower-policy.cjs');
const text = value => String(value || '').replace(/\s+/g, ' ').trim();
const identityLabels={
 me:'^(?:Me|Vous|Yo|Ich|Eu|Io|صفحتي|أنا|انا)$',
 view:'^(?:View (?:my )?profile|Voir (?:le |mon )?profil|Ver (?:mi )?perfil|Profil anzeigen|عرض (?:الملف الشخصي|ملفي الشخصي|ملفك الشخصي)|مشاهدة (?:الملف الشخصي|ملفي الشخصي))$',
 signOut:'^(?:Sign out|Log out|Se déconnecter|Cerrar sesión|Abmelden|تسجيل الخروج|تسجيل خروج)$',
};
const identityLabel=value=>text(value).replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,'');
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
  const selector='main,[role="main"],header,[role="banner"],nav,[role="navigation"],dialog,[role="dialog"],.feed-identity-module,.profile-card,[data-view-name="identity-self-profile"],[data-view-name="nav-settings__dropdown"],.global-nav__me';
  const roots = [...document.querySelectorAll(selector)]
   .filter(n => !n.parentElement?.closest(selector));
  const content = roots.filter(n => n.getClientRects().length).map(root => {
   const clone = root.cloneNode(true), originals = [root,...root.querySelectorAll('*')], copies = [clone,...clone.querySelectorAll('*')];
   originals.forEach((n,i) => {
    if(['SCRIPT','STYLE','SVG','NOSCRIPT','TEMPLATE','IFRAME'].includes(n.tagName) || n.hidden || getComputedStyle(n).display==='none' || getComputedStyle(n).visibility==='hidden') copies[i]?.remove();
    if(n.tagName==='A'&&n.href)copies[i]?.setAttribute('href',n.href);
   });
   clone.querySelectorAll('*').forEach(n => {
    for(const a of [...n.attributes]) if(!['href','class','id','role','open','aria-label','aria-level','aria-hidden','alt','datetime','data-urn','data-view-name'].includes(a.name)) n.removeAttribute(a.name);
   });
   return clone.outerHTML;
  }).join('');
  // These are account notices, not phrases found in somebody's post or bio.
  const alerts = [...document.querySelectorAll('[role="alert"],dialog,[role="dialog"]')].filter(n => n.getClientRects().length).map(n => n.innerText).join('\n');
  return {url:location.href, title:document.title, notice:alerts.slice(0,12000), html:'<html><body>'+content+'</body></html>'};
 });
}
async function inspected(page, options={}, response) {
 options.checkResponse?.(response?.status?.() || 0, page.url());
 const state=await snapshot(page);
 if(Buffer.byteLength(state.html)>2*1024*1024) throw problem('PAGE_CONTENT_SIZE','Rendered LinkedIn content exceeded the reading limit.');
 const signal=pageSignal({url:state.url,status:response?.status?.()||0,text:state.title+'\n'+state.notice,manual:options.manual===true});
 if(signal) throw Object.assign(new Error(signal.reason),{failure:failure(signal)});
 return state;
}
async function inspectNotice(page,options={}){
 options.checkResponse?.(0,page.url());
 const state=await page.evaluate(()=>({url:location.href,title:document.title,notice:[...document.querySelectorAll('[role="alert"],dialog,[role="dialog"]')].filter(n=>n.getClientRects().length).map(n=>n.innerText).join('\n').slice(0,12000)}));
 const signal=pageSignal({url:state.url,text:state.title+'\n'+state.notice,manual:options.manual===true});
 if(signal)throw Object.assign(new Error(signal.reason),{failure:failure(signal)});return state;
}
async function firstControl(page, selector, match=()=>true) {
 const elements=await page.$$(selector);
 let selected=null;
 for(const el of elements) {
  try {
   if(selected){await el.dispose();continue;}
   const info=await el.evaluate(n=>({href:n.href||'',label:n.getAttribute('aria-label')||n.textContent||'',visible:!!n.getClientRects().length,disabled:!!n.disabled||n.getAttribute('aria-disabled')==='true'}));
   if(!selected&&info.visible&&!info.disabled&&match(info)) selected=el;
   else await el.dispose();
  }catch(error){await el.dispose().catch(()=>{});if(!detachedControl(error)){await selected?.dispose().catch(()=>{});throw error;}}
 }
 return selected;
}
function detachedControl(error) {
 return /Node is detached from document|Attempted to use detached Frame|JSHandle is disposed/i.test(error?.message||'');
}
async function controlPoint(el) {
 // ElementHandle.click/hover wait on animation frames before scrolling. Chrome
 // can suspend those frames while minimized. Use native scrolling, measured
 // rendered bounds, and ordinary browser pointer input instead.
 await el.scrollIntoView();
 const box=await el.boundingBox();
 if(!box||box.width<=0||box.height<=0)throw problem('PAGE_CHANGED','The rendered control is no longer available. Processing stopped before clicking.');
 return {x:box.x+box.width/2,y:box.y+box.height/2};
}
async function pressControl(page,el) {
 const point=await controlPoint(el);await page.mouse.click(point.x,point.y);
}
async function clickControl(page, selector, match, kind, options={}) {
 const probe=await firstControl(page,selector,match);
 if(!probe)return false;
 await probe.dispose();
 await inspectNotice(page,options);
 await options.beforeCheck?.(kind);
 // Ownership checks can yield while LinkedIn hydrates its navigation. Never
 // retain a DOM handle across that check; reacquire the visible control instead.
 for(let attempt=0;attempt<2;attempt++) {
  const el=await firstControl(page,selector,match);
  if(!el)return false;
  try {await pressControl(page,el);return true;}
  catch(error){if(!detachedControl(error)||attempt===1)throw error;}
  finally {await el.dispose().catch(()=>{});}
 }
 return false;
}
async function openProfile(page, person, options={}) {
 const expected=profileUrl(person);
 if(!expected) throw problem('PROFILE_IDENTITY','The requested LinkedIn profile URL is invalid.');
 await options.beforeCheck?.('profile_page');
 const response=await page.goto(expected,{waitUntil:'domcontentloaded',timeout:45000});
 let firstState=await inspected(page,options,response);
 if([404,410].includes(response?.status?.()))throw problem('PROFILE_UNAVAILABLE','The queued profile is no longer available. No profile facts were assigned.');
 // Navigation's DOMContentLoaded can precede the rendered member card. Use
 // the SAME identity check for readiness and extraction, including visibility,
 // rather than waking on a heading whose photo/self link is still hydrating.
 // This only observes the current page: no navigation retry or extra request.
 const deadline=Date.now()+12000;
 do {
  const state=firstState||await inspected(page,options);firstState=null;
  if(profileUrl(state.url)!==expected)throw problem('PROFILE_REDIRECT','The queued URL redirected to another profile. No facts were assigned to the requested person.');
  try{return {...state,profile:parseProfile(state,person,options.accountId)};}
  catch(error){if(error.failure?.code!=='PROFILE_IDENTITY')throw error;}
  try{await page.waitForFunction(person=>{
   const visible=n=>n.getClientRects().length&&getComputedStyle(n).visibility!=='hidden';
   const canonical=value=>{try{const u=new URL(value,location.href);return u.origin==='https://www.linkedin.com'&&/^\/in\/[^/]+\/?$/.test(u.pathname)?u.origin+u.pathname.toLowerCase().replace(/\/?$/,'/'):null;}catch{return null;}};
   const roots=[...document.querySelectorAll('main,[role="main"]')],headings=roots.flatMap(n=>[...n.querySelectorAll('h1')]).filter(visible);
   if(headings.length===1&&headings[0].textContent.trim()){
    const top=headings[0].closest('section')||headings[0].parentElement?.parentElement;
    if(top?.querySelector('.text-body-medium,[data-view-name="profile-card-headline"],a[href*="/overlay/contact-info"],.dist-value,.pv-text-details__left-panel'))return true;
   }
   const cards=new Set();
   for(const link of roots.flatMap(n=>[...n.querySelectorAll('a[href*="/overlay/contact-info"]')]).filter(visible)){
    if(canonical(link.href.replace(/\/overlay\/contact-info\/?$/,''))!==person)continue;
    const top=link.closest('section');if(!top)continue;
    const names=[...top.querySelectorAll('h2,[role="heading"][aria-level="1"]')].filter(n=>visible(n)&&n.closest('section')===top&&n.textContent.trim());
    if(names.length===1&&[...top.querySelectorAll('a[href]')].some(a=>visible(a)&&canonical(a.href)===person))cards.add(top);
   }
   return cards.size===1;
  },{timeout:Math.max(1,deadline-Date.now()),polling:'mutation'},expected);}catch{break;}
 }while(Date.now()<deadline);
 throw problem('PAGE_CHANGED','The LinkedIn profile heading did not load in the supported layout. Processing paused; queued profiles are retained.');
}
async function profileDiagnostics(page) {
 // Bounded rendered structure only: no session state, cookies, input values,
 // scripts, hidden application data or network responses are inspected.
 const structure=await page.evaluate(()=>{
  const visible=n=>!!n.getClientRects().length&&getComputedStyle(n).visibility!=='hidden';
  return {path:location.pathname,title:document.title,
   headings:[...document.querySelectorAll('h1,h2,h3,[role="heading"]')].filter(visible).slice(0,30).map(n=>({tag:n.tagName,role:n.getAttribute('role'),level:n.getAttribute('aria-level'),text:(n.innerText||'').trim().slice(0,180),parents:[n.parentElement,n.parentElement?.parentElement,n.parentElement?.parentElement?.parentElement].filter(Boolean).map(p=>({tag:p.tagName,role:p.getAttribute('role'),view:p.getAttribute('data-view-name'),class:p.className}))})),
   landmarks:[...document.querySelectorAll('main,[role="main"]')].map(n=>({tag:n.tagName,role:n.getAttribute('role'),text:(n.innerText||'').slice(0,12000)}))};
 });
 return structure;
}
function signedInIdentity(state, now=new Date().toISOString()) {
 const $=cheerio.load(state.html), identities=[];
 // Never infer the viewer from feed authors, suggestions, the configured email,
 // or the profile currently being inspected.
 const scopes=$('.feed-identity-module,.profile-card:has(a[href*="/me/"]),.profile-card:has(a[href*="/dashboard/"]),[data-view-name="identity-self-profile"],.global-nav__me,[data-view-name="nav-settings__dropdown"]');
 scopes.each((_i,node)=>{
  // LinkedIn also renders identity-self-profile on the profile link itself.
  // find() only visits descendants, so excluding that anchor loses the viewer.
  const scope=$(node), links=scope.find('a[href]').addBack('a[href]').toArray().filter(n=>profileUrl($(n).attr('href')));
  const urls=[...new Set(links.map(n=>profileUrl($(n).attr('href'))))];
  if(urls.length!==1)return;
  const link=links.find(n=>!new RegExp(identityLabels.view,'iu').test(identityLabel($(n).text())) && text($(n).text()));
  const name=text(scope.find('h2,h3,.artdeco-entity-lockup__title,.feed-identity-module__actor-meta').first().text()) || text(link&&$(link).text()) || text(scope.find('img[alt]').first().attr('alt')).replace(/^(?:photo of|profile photo of)\s+/i,'');
  if(!name||new RegExp(identityLabels.view,'iu').test(identityLabel(name))||new RegExp(identityLabels.me,'iu').test(identityLabel(name))||/^(?:profile photo|profile|الملف الشخصي)$/iu.test(identityLabel(name)))return;
  const identity=cleanIdentity({name,profileUrl:urls[0],checkedAt:now});
  if(identity)identities.push(identity);
 });
 const urls=[...new Set(identities.map(i=>i.profileUrl))];
 return urls.length===1?identities[0]:null;
}
async function readSignedInIdentity(page,options={}) {
 // Manual sign-in observes the page the user is using. It must not click the
 // Me menu repeatedly, navigate, or interpret an unfinished feed as a failure.
 if(options.passive)return signedInIdentity(await inspected(page,options))||await readAccountMenuIdentity(page);
 options.onMenuAttempt?.(false);
 await page.waitForSelector('nav,header,.feed-identity-module,.profile-card',{timeout:12000});
 let identity=signedInIdentity(await inspected(page,options));
 if(identity)return identity;
 const meSelector='button.global-nav__primary-link-me-menu-trigger,.global-nav__me button,button[aria-label="Me"],header button,nav button,[role="navigation"] button,[role="banner"] button';
 const meControl=info=>new RegExp(identityLabels.me,'iu').test(identityLabel(info.label));
 const opened=await clickControl(page,meSelector,meControl,'identity',options);
 options.onMenuAttempt?.(opened);
 if(!opened)return null;
 // Account menus can render in a portal with generated classes. Observe the
 // opened menu for a bounded time without clicking again or navigating.
 identity=signedInIdentity(await inspected(page,options))||await readAccountMenuIdentity(page);
 if(!identity){
  await page.waitForFunction(pattern=>[...document.querySelectorAll('a[href*="/in/"]')].some(a=>a.getClientRects().length&&new RegExp(pattern,'iu').test((a.textContent||'').replace(/\s+/g,' ').replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,'').trim())),{timeout:6000,polling:'mutation'},identityLabels.view).catch(()=>{});
  identity=signedInIdentity(await inspected(page,options))||await readAccountMenuIdentity(page);
 }
 // A manual window stays on the revealed identity for the user to review.
 if(!options.leaveMenuOpen) {
  const control=await firstControl(page,meSelector,meControl);
  if(control)try{await pressControl(page,control);}catch(error){if(!detachedControl(error))throw error;}finally{await control.dispose().catch(()=>{});}
 }
 return identity;
}

async function readAccountMenuIdentity(page) {
 // Only called after opening the real navigation Me control. Modern LinkedIn
 // uses generated classes and puts this account card in an unlabelled portal.
 // Require its explicit View profile link and a single member in that card.
 const candidate=await page.evaluate(labels=>{
  const visible=n=>!!n.getClientRects().length&&getComputedStyle(n).visibility!=='hidden';
  const clean=s=>(s||'').replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,'').replace(/\s+/g,' ').trim();
  const meLabel=new RegExp(labels.me,'iu'),viewLabel=new RegExp(labels.view,'iu'),signOutLabel=new RegExp(labels.signOut,'iu');
  const member=n=>{try{const u=new URL(n.href);return u.protocol==='https:'&&u.hostname==='www.linkedin.com'&&/^\/in\/[^/]+\/?$/.test(u.pathname)?u.origin+u.pathname.replace(/\/$/,'')+'/':null;}catch{return null;}};
  const generic={test:s=>meLabel.test(s)||viewLabel.test(s)||signOutLabel.test(s)||/^(?:Account|Profile|Manage|Settings|الحساب|الملف الشخصي|إدارة|الإعدادات|الاعدادات)$/iu.test(s)};
  const me=[...document.querySelectorAll('header button,nav button,[role="navigation"] button,[role="banner"] button')].some(n=>visible(n)&&meLabel.test(clean(n.getAttribute('aria-label')||n.innerText)));
  if(!me)return null;
  const viewLinks=[...document.querySelectorAll('a[href*="/in/"]')].filter(n=>visible(n)&&!n.closest('main,[role="main"],article')&&viewLabel.test(clean(n.innerText||n.getAttribute('aria-label'))));
  const identities=[];
  for(const view of viewLinks) {
   const url=member(view);if(!url)continue;
   let card=view.parentElement,cardName='';
   for(let depth=0;card&&depth<6&&!['BODY','MAIN','HTML'].includes(card.tagName);depth++,card=card.parentElement) {
    const links=[...card.querySelectorAll('a[href*="/in/"]')].filter(visible),urls=[...new Set(links.map(member).filter(Boolean))];
    if(urls.length!==1||urls[0]!==url)break;
    // Sign out is an account control, never text in a post or a suggestion.
    const accountControl=[...card.querySelectorAll('a,button')].some(n=>visible(n)&&signOutLabel.test(clean(n.innerText||n.getAttribute('aria-label'))));
    const named=links.map(n=>clean(n.querySelector('h2,h3,strong,p')?.innerText||n.innerText)).find(s=>s&&!generic.test(s));
    const heading=[...card.querySelectorAll('h2,h3')].filter(visible).map(n=>clean(n.innerText)).find(s=>s&&!generic.test(s));
    const photo=[...card.querySelectorAll('img[alt]')].filter(visible).map(n=>clean(n.alt).replace(/^(?:profile (?:photo|picture) of|photo of)\s+/i,'')).find(s=>s&&!generic.test(s)&&!/^profile (?:photo|picture)$/i.test(s));
    const paragraph=card.querySelector('img')?[...card.querySelectorAll('p')].filter(visible).map(n=>clean(n.innerText)).find(s=>s&&!generic.test(s)):null;
    cardName=cardName||heading||named||photo||paragraph||'';
    if(accountControl&&cardName){identities.push({name:cardName,profileUrl:url});break;}
   }
  }
  const urls=[...new Set(identities.map(i=>i.profileUrl))];
  return urls.length===1?identities[0]:null;
 },identityLabels);
 return cleanIdentity(candidate&&{...candidate,checkedAt:new Date().toISOString()});
}

// Bounded structural diagnostics for a manual sign-in that cannot identify the
// viewer. No cookies, form values, auth URLs, feed text or credentials are read.
async function signInDiagnostics(page) {
 return page.evaluate(()=>{
  const visible=n=>!!n.getClientRects().length&&getComputedStyle(n).visibility!=='hidden';
  const info=n=>({tag:n.tagName,class:n.className,role:n.getAttribute('role'),view:n.getAttribute('data-view-name'),label:n.getAttribute('aria-label')});
  return {
   path:location.pathname,
   controls:[...document.querySelectorAll('header button,nav button,[role="navigation"] button,[role="banner"] button')].filter(visible).slice(0,24).map(n=>({...info(n),text:(n.innerText||'').trim().slice(0,80)})),
   profileLinks:[...document.querySelectorAll('a[href*="/in/"]')].filter(visible).slice(0,30).map(n=>({
    ...info(n),ancestors:[n.parentElement,n.parentElement?.parentElement,n.parentElement?.parentElement?.parentElement].filter(Boolean).map(info),
   })),
  };
 });
}
const sectionLabels={About:['About','À propos','Acerca de','Sobre','Info','Informazioni','نبذة','نبذة عن'],Featured:['Featured','À la une','Destacado','Destaques','Im Fokus','In primo piano','مميز'],Activity:['Activity','Activité','Actividad','Atividades','Aktivitäten','Attività','النشاط']};
const sectionKey=value=>text(value).normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase();
function section($, label) {
 const names=(sectionLabels[label]||[label]).map(sectionKey);
 return $(':is(main,[role="main"]) section').toArray().reverse().map(n=>$(n)).find(n=>{
  const heading=n.find('h2,[role="heading"]').filter((_i,h)=>$(h).closest('section')[0]===n[0]).first(),title=text(heading.find('[aria-hidden="true"]').first().text()||heading.text());
  return n.find('#'+label.toLowerCase().replace(/ /g,'_')).filter((_i,h)=>$(h).closest('section')[0]===n[0]).length||names.includes(sectionKey(title));
 });
}
function profileCard($,expected) {
 const roots=$(':is(main,[role="main"])'), legacy=roots.find('h1');
 if(legacy.length===1&&text(legacy.text())) {
  const top=legacy.closest('section').length?legacy.closest('section'):legacy.parent().parent();
  if(top.find('.text-body-medium,[data-view-name="profile-card-headline"],a[href*="/overlay/contact-info"],.dist-value,.pv-text-details__left-panel').length)return {heading:legacy,top};
 }
 const matches=[];
 roots.find('a[href*="/overlay/contact-info"]').each((_i,link)=>{
  let url;try{url=new URL($(link).attr('href'),expected);}catch{return;}
  if(!/\/overlay\/contact-info\/?$/.test(url.pathname)||profileUrl(url.origin+url.pathname.replace(/\/overlay\/contact-info\/?$/,''))!==expected)return;
  const top=$(link).closest('section');if(!top.length||matches.some(m=>m.top[0]===top[0]))return;
  const headings=top.find('h2,[role="heading"][aria-level="1"]').filter((_i,h)=>$(h).closest('section')[0]===top[0]&&text($(h).text()));
  const ownLink=top.find('a[href]').toArray().some(n=>{try{return profileUrl(new URL($(n).attr('href'),expected).href)===expected;}catch{return false;}});
  if(headings.length===1&&ownLink)matches.push({heading:headings.first(),top});
 });
 return matches.length===1?matches[0]:null;
}
function parseProfile(state,person,accountId='',now=new Date().toISOString()) {
 const expected=profileUrl(person), $=cheerio.load(state.html),card=expected&&profileUrl(state.url)===expected&&profileCard($,expected);
 if(!card)throw problem('PROFILE_IDENTITY','The rendered page did not confirm the requested LinkedIn profile.');
 const {heading,top}=card;
 if(/^(?:profile (?:not found|unavailable)|page not found|something went wrong)$/i.test(text(heading.text())))throw problem('PROFILE_IDENTITY','The page shows an unavailable profile, not a confirmed member.');
 const name=text(heading.text()), parts=name.split(' '), about=section($,'About'), featured=section($,'Featured');
 const summary=about?text(about.find('.inline-show-more-text,.pv-shared-text-with-see-more,.display-flex.ph5.pv3').first().text()||about.find('p').toArray().map(n=>$(n).text()).join(' ')||about.clone().find('h2,button').remove().end().text()):'';
 const websites=[];
 for(const area of [about,featured]) if(area)area.find('a[href]').each((_i,n)=>{const u=externalUrl($(n).attr('href'));if(u&&!websites.includes(u))websites.push(u);});
 const distance=text(top.find('.dist-value,.distance-badge,[aria-label*="degree connection"]').first().text());
 const connection=/^1st$|1st degree/i.test(distance)?'CONNECTED':/^2nd$|^3rd$|[23](?:nd|rd) degree/i.test(distance)?'NOT_CONNECTED':top.find('button').toArray().some(n=>/^pending$/i.test(text($(n).text())))?'PENDING':'UNKNOWN';
 // In the generated-class layout the headline is a direct paragraph in the
 // nearest name container; location is the next paragraph. Do not read the
 // outer Primary content section or recommended members' paragraphs.
 const nameBlock=heading.parentsUntil(top).toArray().map(n=>$(n)).find(n=>n.children('p').length);
 const ownField=(_i,node)=>{
  if($(node).closest('aside,[role="complementary"],article,[role="article"]').length)return false;
  for(const parent of [node,...$(node).parentsUntil(top).toArray()]){
   if(parent===top[0]||$(parent).find(heading[0]).length)break;
   const members=$(parent).find('a[href]').toArray().map(a=>{try{const u=new URL($(a).attr('href'),expected);return /^\/(?:in|company)\/[^/]+\/?$/.test(u.pathname)?u.href:null;}catch{return null;}}).filter(Boolean);
   if(members.length&&!members.some(url=>profileUrl(url)===expected))return false;
  }
  return true;
 };
 const headline=text(top.find('.text-body-medium.break-words,.text-body-medium,[data-view-name="profile-card-headline"]').filter(ownField).first().text()||nameBlock?.children('p').filter(ownField).first().text());
 const location=text(top.find('.pv-text-details__left-panel.mt2 .text-body-small,.text-body-small.inline.t-black--light.break-words,[data-view-name="profile-card-location"]').filter(ownField).first().text()||nameBlock?.find('p').filter(ownField).filter((_i,n)=>!$(n).find('a').length&&$(n).parent()[0]!==nameBlock[0]&&text($(n).text())!=='·').first().text());
 const audience=profileAudience($,top,expected,now);
 return {url:expected,firstName:parts[0],lastName:parts.slice(1).join(' '),headline,...audience,
  about:summary,profileLocation:location,
  profileIdentityConfirmed:true,websites,website:websites[0]||'',websiteSource:websites.length?'visible_profile':'',emails:[],emailSource:'',primaryEmail:'',
  linkedinContact:{accountId,connection,openProfile:'UNKNOWN',checkedAt:now,source:'WORKER',note:'Connection status read from the matching rendered profile. Free messaging is not inferred from a Message button or Premium badge.'},
  activityStatus:'Unknown',lastActivityAt:null,latestPostText:'',status:'PENDING',logs:['Profile identity confirmed from the rendered page.'],
  linkedinAccountId:accountId,linkedinCapture:{version:2,stage:'profile',complete:false,checkedAt:now}};
}
function profileAudience($,top,person,now){
 const activity=section($,'Activity'),areas=[{area:top,activity:false}];
 if(activity?.find('a[href*="/recent-activity/"]').toArray().some(a=>{try{return new URL($(a).attr('href'),person).pathname.startsWith(new URL(person).pathname+'recent-activity/');}catch{return false;}}))areas.push({area:activity,activity:true});
 const numeric='[\\d٠-٩۰-۹][\\d٠-٩۰-۹.,٬٫ \\u00a0\\u202f]*[kKmM]?\\+?';
 const allLabels='(?:'+followerPolicy.LABELS.followers+'|'+followerPolicy.LABELS.connections+')';
 const widget=new RegExp(numeric+'\\s*'+allLabels+'(?![\\p{L}\\p{N}])','giu');
 const pick=kind=>{
  const values=new Map();let unparseable='';
  for(const entry of areas){
   const nodes=entry.area.find('*').toArray(),boundary=entry.activity?nodes.findIndex(n=>$(n).is('article,[role="article"],[data-urn*="urn:li:activity"],.feed-shared-update-v2')||$(n).is('h2')&&!sectionLabels.Activity.map(sectionKey).includes(sectionKey($(n).text()))):-1;
   const ownHeading=entry.area.find('h1,h2,[role="heading"]').first()[0];
   entry.area.find('p,li,span,a,div,button,[aria-label]').each((_i,node)=>{
    if(boundary>=0&&nodes.indexOf(node)>=boundary)return;
    if($(node).closest('aside,[role="complementary"],article,[role="article"]').length)return;
    // A suggested member/company card may be nested inside this section in
    // generated layouts. Its audience is not the owner's audience.
    for(const parent of [node,...$(node).parentsUntil(entry.area).toArray()]){
     if(parent===entry.area[0]||ownHeading&&(parent===ownHeading||$(parent).find(ownHeading).length))break;
     const profiles=$(parent).find('a[href]').addBack('a[href]').toArray().map(a=>{try{const u=new URL($(a).attr('href'),person);return u.origin==='https://www.linkedin.com'&&/^\/(?:in|company)\/[^/]+\/?$/.test(u.pathname)?u.href:null;}catch{return null;}}).filter(Boolean);
     if(profiles.length&&!profiles.some(url=>profileUrl(url)===profileUrl(person)))return;
    }
    for(const raw of [text($(node).text()),text($(node).attr('aria-label'))].filter(Boolean)){
     if(raw.length>200)continue;
     const clean=raw.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,'');
     const direct=followerPolicy.audienceRecord(raw,kind);
     if(direct.count!==null){values.set(direct.count,direct);continue;}
     const matches=[...clean.matchAll(widget)],residue=clean.replace(widget,'').replace(/[\s·•|,;/+\-–—]/g,'');
     // Split only a complete audience widget; prose such as "I help 2K
     // followers" and other people's post text are never follower evidence.
     if(matches.length&&!residue)for(const match of matches){const record=followerPolicy.audienceRecord(match[0],kind);if(record.count!==null)values.set(record.count,record);}
     else if(!unparseable&&new RegExp('(?:'+followerPolicy.LABELS[kind]+')$','iu').test(clean))unparseable=raw;
    }
   });
  }
  const records=[...values.values()],chosen=records.length===1?records[0]:{count:null,rawText:records.map(r=>r.rawText).join(' | ')||unparseable};
  return {...chosen,checkedAt:now,...(kind==='followers'?{threshold:followerPolicy.minFollowers()}:{})};
 };
 return {followers:pick('followers'),connections:pick('connections')};
}
function parseContact(state,person) {
 const $=cheerio.load(state.html), modal=$('dialog,[role="dialog"]');
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
 return telemetry.span('linkedin.activity',()=>readActivityInner(page,person,options));
}
async function readActivityInner(page,person,options={}) {
 const {activityRoute,extractActivityPage,POST_HEADING}=require('./linkedin-activity-page.cjs');
 if(profileUrl(page.url())!==profileUrl(person))await openProfile(page,person,options);
 const state=await inspected(page,options),$=cheerio.load(state.html);
 const routes=$('main a[href]').toArray().map(n=>activityRoute(new URL($(n).attr('href'),state.url).href,person)).filter(Boolean);
 if(!routes.length)return null;
 if(!await clickControl(page,'main a[href*="/recent-activity/"]',n=>routes.includes(n.href),'activity_page',options))return null;
 await page.waitForFunction(()=>/\/recent-activity\//.test(location.pathname),{timeout:12000,polling:'mutation'});
 await inspectNotice(page,options);
 await page.waitForFunction(pattern=>document.querySelector('main [data-urn*="urn:li:activity"],main .feed-shared-update-v2,main article header,main [role="article"] header')||[...document.querySelectorAll('main h2')].some(n=>new RegExp(pattern,'iu').test(n.textContent.trim()))||/nothing to see for now/i.test(document.querySelector('main')?.innerText||''),{timeout:10000,polling:'mutation'},POST_HEADING).catch(()=>{});
 const activity=await inspected(page,options);
 return {...extractActivityPage(activity.html,{profileUrl:person,pageUrl:activity.url,now:options.now}),activityCheck:{httpStatus:200,retryable:false}};
}
async function captureProfile(page,person,options={}) {
 const unwatch=telemetry.observePage(page);
 try {
 let state=await telemetry.span('linkedin.profile',()=>openProfile(page,person,options));
 const finish=async(value,stage='complete')=>{
  value.linkedinCapture={...value.linkedinCapture,stage,complete:true};value.linkedinCapturedAt=new Date().toISOString();
  await options.onCheckpoint?.(value);return value;
 };
 const rejectOutside=profile=>options.requireTargetLocation&&require('./discovery-location-evidence.cjs').parsePersonLocation(profile.profileLocation||'').status==='OUTSIDE_TARGET'
  ?finish({...profile,status:'REJECTED',decisionStage:'location',reasonCode:'LOCATION_OUTSIDE_TARGET'},'location_decided'):null;
 let initial=state.profile||parseProfile(state,person,options.accountId);
 if(options.requireTargetLocation)initial.targetLocationRequired=true;
 const outside=rejectOutside(initial);if(outside)return await outside;
 if(initial.followers.count===null&&!initial.followers.rawText){
  await options.beforeCheck?.('profile');
  await page.evaluate(()=>window.scrollBy({top:650,behavior:'instant'}));
  await page.waitForFunction(({labels,person})=>{
   const canonical=value=>{try{const u=new URL(value,location.href);return u.origin==='https://www.linkedin.com'&&/^\/in\/[^/]+\/?$/.test(u.pathname)?u.origin+u.pathname.toLowerCase().replace(/\/?$/,'/'):null;}catch{return null;}};
   const label=new RegExp('^[\\d٠-٩۰-۹][\\d٠-٩۰-۹.,٬٫ \\u00a0\\u202f]*[kKmM]?\\s*(?:'+labels+')$','iu');
   const ownRoot=document.querySelector('main h1')?.closest('section');
   const roots=[...document.querySelectorAll('main section')].filter(root=>root===ownRoot||[...root.querySelectorAll('a[href*="/recent-activity/"]')].some(a=>canonical(a.href.replace(/\/recent-activity\/.*$/,'/'))===person));
   for(const root of roots)for(const n of root.querySelectorAll('p,li,span,a,div,button,[aria-label]')){
    if(!n.getClientRects().length||n.closest('aside,[role="complementary"],article,[role="article"],[data-urn*="urn:li:activity"],.feed-shared-update-v2'))continue;
    let foreign=false;
    for(let parent=n;parent&&parent!==root;parent=parent.parentElement){
     if(parent.querySelector('h1'))break;
     const members=[...parent.querySelectorAll('a[href]')].filter(a=>{try{return /^\/(in|company)\/[^/]+\/?$/.test(new URL(a.href).pathname);}catch{return false;}});
     if(members.length&&!members.some(a=>canonical(a.href)===person)){foreign=true;break;}
    }
    if(foreign)continue;
    if([n.innerText,n.getAttribute('aria-label')].some(value=>value&&value.length<200&&label.test(value.normalize('NFKC').replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u064b-\u065f\u0670]/g,'').trim())))return true;
   }
   return false;
  },{timeout:2000,polling:'mutation'},{labels:followerPolicy.LABELS.followers,person:profileUrl(person)}).catch(()=>{});
  state=await inspected(page,options);initial=parseProfile(state,person,options.accountId);
  if(options.requireTargetLocation)initial.targetLocationRequired=true;
  const outside=rejectOutside(initial);if(outside)return await outside;
 }
 const saved=options.resume,capturedAt=Date.parse(saved?.linkedinCapture?.checkedAt);
 const resumeValid=saved?.linkedinCapture?.version===2&&saved.profileIdentityConfirmed&&profileUrl(saved.url)===profileUrl(person)&&saved.linkedinAccountId===options.accountId&&Number.isFinite(capturedAt)&&Date.now()-capturedAt>=0&&Date.now()-capturedAt<86400000;
 const followerGate=followerPolicy.followersDecision(initial.followers,followerPolicy.minFollowers());
 if(followerGate.status!=='CONTINUE')return finish({...initial,status:followerGate.status,decisionStage:'followers',reasonCode:followerGate.reason,
  ...(followerGate.status==='REVIEW'?{failure:{stage:'qualification',code:followerGate.reason,reason:'Follower count is not confirmed on the rendered profile. Review the saved evidence.',retryable:false}}:{})},'followers_decided');
 if(options.requireTargetLocation){
  const location=require('./discovery-location-evidence.cjs').parsePersonLocation(initial.profileLocation||'');
  if(location.status!=='CONFIRMED')return finish({...initial,status:location.status==='OUTSIDE_TARGET'?'REJECTED':'REVIEW',decisionStage:'location',reasonCode:location.status==='OUTSIDE_TARGET'?'LOCATION_OUTSIDE_TARGET':'LOCATION_UNCONFIRMED',
   ...(location.status==='OUTSIDE_TARGET'?{}:{failure:{stage:'qualification',code:'LOCATION_UNCONFIRMED',reason:'The rendered profile did not confirm a UK, US or Canada location. Review the saved location evidence.',retryable:false}})},'location_decided');
 }
 if(!resumeValid)await options.onCheckpoint?.(initial);
 // Some LinkedIn layouts hydrate About/Activity only when their section is
 // approached. Limit scrolling to this profile and count every attempt.
 for(let pass=0;pass<3;pass++) {
  const $=cheerio.load(state.html);
  if($('main a[href*="/recent-activity/"]').length)break;
  await options.beforeCheck?.('profile');
  // A minimized Chrome window may never acknowledge wheel input. Scroll the
  // rendered document directly; this still runs its ordinary scroll/lazy-load
  // handlers, without a compositor-dependent pointer command or navigation.
  await page.evaluate(()=>window.scrollBy({top:650,behavior:'instant'}));
  await page.waitForFunction(()=>{
   return document.querySelector('main a[href*="/recent-activity/"]')?.getClientRects().length;
  },{timeout:2000,polling:'mutation'}).catch(()=>{});
  state=await inspected(page,options);
  if(profileUrl(state.url)!==profileUrl(person))throw problem('PROFILE_IDENTITY','The page changed while loading profile sections. Processing stopped.');
 }
 const capturedProfile=parseProfile(state,person,options.accountId);
 if(options.requireTargetLocation)capturedProfile.targetLocationRequired=true;
 if(resumeValid){capturedProfile.about||=saved.about||'';capturedProfile.websites=[...new Set([...(saved.websites||[]),...capturedProfile.websites])];}
 // A dated matching-author preview already proves recent activity. Older or
 // undated preview cards do not establish inactivity and use the observed feed.
 let activity=resumeValid&&saved.lastActivityAt&&['activity','contact'].includes(saved.linkedinCapture.stage)
  ?{activityStatus:saved.activityStatus,lastActivityAt:saved.lastActivityAt,latestPostText:saved.latestPostText,activityEvidence:saved.activityEvidence}:null;
 if(!activity){
  const preview=require('./linkedin-activity-page.cjs').extractActivityPage(state.html,{profileUrl:person,pageUrl:state.url,allowProfile:true,now:options.now});
  activity=preview.activityStatus==='Active'&&preview.lastActivityAt?preview:await readActivity(page,person,options);
 }
 const activityResult={...capturedProfile,...activity,followers:initial.followers,connections:initial.connections};
 if(options.requireRecentActivity!==false&&(!activityResult.lastActivityAt||activityResult.activityStatus!=='Active')){
  const inactive=activityResult.activityStatus==='Inactive'&&!!activityResult.lastActivityAt;
  return finish({...activityResult,status:inactive?'REJECTED':'REVIEW',decisionStage:'activity',reasonCode:inactive?'ACTIVITY_INACTIVE':'ACTIVITY_UNCONFIRMED',
   ...(!inactive?{failure:{stage:'qualification',code:'ACTIVITY_UNCONFIRMED',reason:activityResult.activityEvidence?.reason||'No reliably dated matching-author activity. Review the saved evidence.',retryable:false}}:{})},'activity_decided');
 }
 activityResult.linkedinCapture.stage='activity';if(!(resumeValid&&saved.linkedinCapture.stage==='contact'))await options.onCheckpoint?.(activityResult);
 if(profileUrl(page.url())!==profileUrl(person))state=await telemetry.span('linkedin.profile_return',()=>openProfile(page,person,options));
 for(let pass=0;pass<2&&!capturedProfile.about&&!section(cheerio.load(state.html),'About');pass++){
  await options.beforeCheck?.('profile');await page.evaluate(()=>window.scrollBy({top:650,behavior:'instant'}));
  await page.waitForFunction(()=>document.querySelector('main #about')?.closest('section')?.getClientRects().length,{timeout:2000,polling:'mutation'}).catch(()=>{});
  state=await inspected(page,options);
 }
 // Expand only the requested profile's About text. Never click messaging,
 // invitation, or other account-changing controls while qualifying a lead.
 if(await clickControl(page,'main section:has(#about) button.inline-show-more-text__button,main section:has(#about) button[aria-label*="see more"]',()=>true,'profile',options))state=await inspected(page,options);
 const result={...parseProfile(state,person,options.accountId),...activity,followers:initial.followers,connections:initial.connections};
 if(options.requireTargetLocation)result.targetLocationRequired=true;
 result.about||=capturedProfile.about;
 result.websites=[...new Set([...capturedProfile.websites,...result.websites])];result.website=result.websites[0]||'';
 result.websiteSource||=capturedProfile.websiteSource;
 result.linkedinCapture.stage='activity';
 const resumeContact=resumeValid&&saved.linkedinCapture.stage==='contact';
 if(resumeContact){
  result.emails=saved.emails||[];result.emailSource=saved.emailSource||'';
  result.websites=[...new Set([...(saved.websites||[]),...result.websites])];result.website=result.websites[0]||'';result.websiteSource=saved.websiteSource||result.websiteSource;
  result.logs.push('Resumed saved contact evidence; the contact panel was not reopened.');
 }
 // Do not overwrite a later saved stage with an earlier checkpoint.
 if(resumeContact)result.linkedinCapture.stage='contact';
 await telemetry.span('linkedin.contact',async()=>{
 const contactOpened=!resumeContact&&await clickControl(page,'main a[href*="/overlay/contact-info"]',n=>{
  try{const u=new URL(n.href);return profileUrl(u.origin+u.pathname.replace(/\/overlay\/contact-info\/?$/,''))===profileUrl(person);}catch{return false;}
 },'contact',options);
 if(contactOpened) {
  await page.waitForFunction(()=>[...document.querySelectorAll('dialog,[role="dialog"]')].some(n=>n.getClientRects().length&&getComputedStyle(n).visibility!=='hidden'),{timeout:8000,polling:'mutation'});
  const contact=parseContact(await inspected(page,options),person);
  if(!contact)throw problem('PAGE_CHANGED','The contact panel could not be associated with the requested profile. Saved profile facts are retained.');
  result.emails=contact.emails;result.emailSource=contact.emails.length?'linkedin':'';
  result.websites=[...new Set([...contact.websites,...result.websites])];result.website=result.websites[0]||'';
  if(contact.websites.length)result.websiteSource='contact_modal';
  const closed=await clickControl(page,':is(dialog,[role="dialog"]) button[aria-label*="Dismiss"],:is(dialog,[role="dialog"]) button[aria-label*="Close"],:is(dialog,[role="dialog"]) button.artdeco-modal__dismiss',()=>true,'contact',options);
  if(!closed)throw problem('PAGE_CHANGED','The contact panel could not be closed. Processing stopped before another action.');
  await page.waitForFunction(()=>![...document.querySelectorAll('dialog,[role="dialog"]')].some(n=>n.getClientRects().length),{timeout:8000,polling:'mutation'});
 }else if(!resumeContact)result.logs.push('No rendered contact-info control was available. No contact details were guessed.');
 });
 result.linkedinCapture.stage='contact';await options.onCheckpoint?.(result);
 return finish(result);
 }finally{unwatch();}
}
module.exports={snapshot,inspected,firstControl,controlPoint,pressControl,clickControl,signedInIdentity,readSignedInIdentity,signInDiagnostics,profileDiagnostics,parseProfile,parseContact,openProfile,readActivity,captureProfile,externalUrl};
