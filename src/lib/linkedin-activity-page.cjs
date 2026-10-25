'use strict';
const cheerio=require('cheerio');
const {profileUrl}=require('./linkedin-workers.cjs');
function activityRoute(value,person){
 try{const u=new URL(value),prefix=u.pathname.match(/^\/in\/[^/]+\//)?.[0];return u.origin==='https://www.linkedin.com'&&prefix&&profileUrl(u.origin+prefix)===profileUrl(person)&&/^\/in\/[^/]+\/recent-activity\/(?:all|posts)\/?$/.test(u.pathname)?u.href:null;}catch{return null;}
}
function relativeDate(text,now){
 const value=String(text||'').trim().replace(/\s*[•·].*$/,'');
 const m=value.match(/^(\d+)\s*(s|sec|m|min|h|hr|d|w|wk|mo|yr|y)$/i);
 if(!m&&!/^(?:now|just now)$/i.test(value))return null;
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
 const modern=$('h2').toArray().filter(n=>$(n).text().trim()==='Feed post').map(n=>n.parent);
 const cards=modern.length?modern:$('[data-urn*="urn:li:activity"],.feed-shared-update-v2').toArray().filter(n=>!$(n).parents('[data-urn*="urn:li:activity"],.feed-shared-update-v2').length);
 let unresolved=0;
 if(valid)for(const card of cards.slice(0,20)){
  const node=$(card),header=modern.includes(card)?node.children('h2').first().next():node.find('.update-components-actor,.feed-shared-actor').first();
  const author=header.find('a[href]').toArray().find(n=>/linkedin\.com\/(?:in|company)\//.test($(n).attr('href')||''));
  const authorUrl=author?$(author).attr('href'):'';
  if(profileUrl(authorUrl)!==requested){unresolved++;continue;}
  // Only this post's own activity ID or author-header date is evidence. Dates
  // on quoted posts, comments and suggested people are never substituted.
  const urn=(node.attr('data-urn')||'').match(/urn:li:activity:\d+/)?.[0]||'';
  let at=null,method='';
  if(urn)try{const n=Number(BigInt(urn.split(':').at(-1))>>22n);if(n>=Date.UTC(2015,0,1)&&n<=Date.parse(now)){at=new Date(n).toISOString();method='activity_urn';}}catch{}
  if(!at){
   // Stop before a second person's/company's header (a quoted/reposted item).
   const other=header.find('a[href]').toArray().find(n=>/linkedin\.com\/(?:in|company)\//.test($(n).attr('href')||'')&&profileUrl($(n).attr('href'))!==requested);
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
 return {activityStatus:status,lastActivityAt:status==='Unknown'?null:selected?.at||null,latestPostText:selected?.text||'',activityEvidence:{version:1,endpoint:allowProfile?'profile_activity_preview':'profile_activity_page',profileUrn,profileUrl:person,checkedAt:now,feedElements:cards.length,unresolved,selected,records:records.slice(0,10),reason:!valid?'Activity page did not match the requested profile.':selected?'Visible author-matched activity inspected.':empty?'Activity page reports no visible posts; dated activity remains unconfirmed.':'Activity page did not provide a reliably dated, author-matched post.'}};
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
module.exports={activityRoute,relativeDate,extractActivityPage,checkActivityPage,checkSavedActivity};
