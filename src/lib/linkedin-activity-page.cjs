'use strict';
const cheerio=require('cheerio');
const {profileUrl}=require('./linkedin-workers.cjs');
const POST_HEADING='^(?:Feed post|منشور (?:في )?(?:الموجز|الخلاصة)|Post du fil d[’\u0027]actualité|Publication du fil|Publicación(?: del feed)?|Feedbeitrag|Publicação(?: no feed)?|Post del feed)$';
function activityRoute(value,person){
 try{const u=new URL(value),prefix=u.pathname.match(/^\/in\/[^/]+\//)?.[0];return u.origin==='https://www.linkedin.com'&&prefix&&profileUrl(u.origin+prefix)===profileUrl(person)&&/^\/in\/[^/]+\/recent-activity\/(?:all|posts)\/?$/.test(u.pathname)?u.href:null;}catch{return null;}
}
function relativeDate(text,now){
 let value=String(text||'').normalize('NFKC').replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u064b-\u065f]/g,'').trim().replace(/\s*[•·].*$/,'')
  .replace(/[٠-٩]/g,d=>String(d.charCodeAt(0)-1632)).replace(/[۰-۹]/g,d=>String(d.charCodeAt(0)-1776));
 value=value.replace(/^(?:منذ|قبل|il y a|hace|há|vor)\s+/iu,'').replace(/\s+ago$/i,'');
 const units={seconds:'s',second:'s',minutes:'m',minute:'m',hours:'h',hour:'h',days:'d',day:'d',weeks:'w',week:'w',months:'mo',month:'mo',years:'yr',year:'yr',
  ثانية:'s',ثوان:'s',ثواني:'s',دقيقة:'m',دقائق:'m',ساعة:'h',ساعات:'h',يوم:'d',أيام:'d',ايام:'d',أسبوع:'w',اسبوع:'w',أسابيع:'w',اسابيع:'w',شهر:'mo',أشهر:'mo',اشهر:'mo',شهور:'mo',سنة:'yr',سنوات:'yr',عام:'yr',أعوام:'yr',اعوام:'yr',
  jour:'d',jours:'d',semaine:'w',semaines:'w',mois:'mo',an:'yr',ans:'yr',día:'d',días:'d',semana:'w',semanas:'w',mes:'mo',meses:'mo',año:'yr',años:'yr'};
 const dual={ثانيتين:'s',دقيقتين:'m',ساعتين:'h',يومين:'d',أسبوعين:'w',اسبوعين:'w',شهرين:'mo',سنتين:'yr',عامين:'yr'};
 if(dual[value])value='2'+dual[value];else if(units[value])value='1'+units[value];
 const expanded=value.match(/^(\d+)\s+([^\d]+)$/u);if(expanded&&units[expanded[2].toLowerCase()])value=expanded[1]+units[expanded[2].toLowerCase()];
 const m=value.match(/^(\d+)\s*(s|sec|m|min|h|hr|d|w|wk|mo|yr|y)$/i);
 if(!m&&!/^(?:now|just now|الآن|الان|maintenant|ahora)$/iu.test(value))return null;
 const scale={s:1000,sec:1000,m:60000,min:60000,h:3600000,hr:3600000,d:86400000,w:604800000,wk:604800000,mo:31*86400000,yr:366*86400000,y:366*86400000};
 const unit=m?m[2].toLowerCase():'m',n=m?Number(m[1]):0;
 const minAge=n*(unit==='mo'?28*86400000:['yr','y'].includes(unit)?365*86400000:scale[unit]),maxAge=(n+1)*scale[unit];
 // Rounded labels crossing the 30-day boundary cannot establish activity.
 if(minAge<=30*86400000&&maxAge>30*86400000)return null;
 return new Date(Date.parse(now)-maxAge).toISOString();
}
function extractActivityPage(html,{profileUrl:person,profileUrn='',pageUrl,now=new Date().toISOString(),allowProfile=false}={}){
 const $=cheerio.load(html),records=[],requested=profileUrl(person);
 const valid=Boolean(requested&&(activityRoute(pageUrl,person)||allowProfile&&profileUrl(pageUrl)===requested));
 const modern=$('h2').toArray().filter(n=>new RegExp(POST_HEADING,'iu').test($(n).text().trim())).map(n=>n.parent);
 const legacy=$('[data-urn*="urn:li:activity"],.feed-shared-update-v2').toArray();
 // A normal article with an explicit author header is also rendered evidence;
 // never use an arbitrary body paragraph as an actor/date container.
 const semantic=$('main article,main [role="article"]').toArray().filter(n=>$(n).children('header').length);
 const candidates=[...new Set([...modern,...legacy,...semantic])];
 const cards=candidates.filter(n=>!$(n).parents().toArray().some(p=>candidates.includes(p)));
 let unresolved=0,ignoredForeign=0;
 if(valid)for(const card of cards.slice(0,20)){
  const node=$(card),heading=node.children('h2').toArray().find(n=>new RegExp(POST_HEADING,'iu').test($(n).text().trim())),header=heading?$(heading).next():node.children('header').first().length?node.children('header').first():node.find('.update-components-actor,.feed-shared-actor').first();
  const actorUrl=n=>{try{const u=new URL($(n).attr('href'),pageUrl);return u.origin==='https://www.linkedin.com'&&/^\/(?:in|company)\/[^/]+\/?$/.test(u.pathname)?u.href:'';}catch{return '';}};
  const author=header.find('a[href]').toArray().find(n=>actorUrl(n));
  const authorUrl=author?actorUrl(author):'';
  if(!authorUrl){unresolved++;continue;}
  // Other people's/company posts cannot meet the matching-author rule, so
  // they must not make an otherwise reliably dated own feed "unresolved".
  if(profileUrl(authorUrl)!==requested){ignoredForeign++;continue;}
  // Only this post's own activity ID or author-header date is evidence. Dates
  // on quoted posts, comments and suggested people are never substituted.
  const urn=(node.attr('data-urn')||'').match(/urn:li:activity:\d+/)?.[0]||'';
  let at=null,method='';
  if(urn)try{const n=Number(BigInt(urn.split(':').at(-1))>>22n);if(n>=Date.UTC(2015,0,1)&&n<=Date.parse(now)){at=new Date(n).toISOString();method='activity_urn';}}catch{}
  if(!at){
   // Stop before a second person's/company's header (a quoted/reposted item).
   const other=header.find('a[href]').toArray().find(n=>actorUrl(n)&&profileUrl(actorUrl(n))!==requested);
   const dateNodes=header.find('time,span,p').toArray();
   for(const n of dateNodes){
    if(other&&$(other).parents().toArray().some(p=>p===n))continue;
    if(other){const all=header.find('*').toArray();if(all.indexOf(n)>=all.indexOf(other))break;}
    const datetime=$(n).attr('datetime');
    const date=datetime&&Date.parse(datetime)>=Date.UTC(2015,0,1)&&Date.parse(datetime)<=Date.parse(now)?new Date(datetime).toISOString():relativeDate($(n).text(),now);
    if(date){at=date;method=datetime?'visible_post_timestamp':'visible_relative_time';break;}
   }
  }
  if(!at){unresolved++;continue;}
  records.push({postUrn:urn,authorUrn:profileUrn,at,method,association:'matching_author',text:node.text().replace(/\s+/g,' ').trim().slice(0,2500)});
 }
 records.sort((a,b)=>Date.parse(b.at)-Date.parse(a.at));
 const selected=records[0]||null,status=selected?Date.parse(now)-Date.parse(selected.at)<=30*86400000?'Active':unresolved?'Unknown':'Inactive':'Unknown';
 const empty=valid&&/nothing to see for now/i.test($('body').text())&&!cards.length;
 return {activityStatus:status,lastActivityAt:status==='Unknown'?null:selected?.at||null,latestPostText:selected?.text||'',activityEvidence:{version:2,endpoint:allowProfile?'profile_activity_preview':'profile_activity_page',profileUrn,profileUrl:person,checkedAt:now,feedElements:cards.length,unresolved,ignoredForeign,selected,records:records.slice(0,10),reason:!valid?'Activity page did not match the requested profile.':selected?'Visible author-matched activity inspected.':empty?'Activity page reports no visible posts; dated activity remains unconfirmed.':'Activity page did not provide a reliably dated, author-matched post.'}};
}
async function checkActivityPage(browser,person,options={}) {
 // Prefer the account's existing page. Only legacy callers need a temporary tab.
 const page=options.page||await browser.newPage();
 try {return await require('./linkedin-browser-page.cjs').readActivity(page,person,options);}
 finally {if(!options.page)await page.close().catch(()=>{});}
}
async function checkSavedActivity(browser,person,options={}) {
 return checkActivityPage(browser,person,options);
}
module.exports={activityRoute,relativeDate,extractActivityPage,checkActivityPage,checkSavedActivity,POST_HEADING};
