'use strict';
const {isUnsafeContact,isPlatformWebsite}=require('./prospect-qualification.cjs');
const {personEmail}=require('./contact-person.cjs');
const EMAIL=/[a-z\d._%+-]+@(?:[a-z\d-]+\.)+[a-z]{2,24}/gi;
function tokenSafe(token){
 const suffix=token.split(/[./?#]/).filter(Boolean).at(-1)||'';
 // Do not silently repair joined sentences such as .comAre or .coachFor.
 return !/[a-z][A-Z]|[A-Z][a-z]/.test(suffix);
}
function publishedProfileEmails(input){
 if(!input.profileIdentityConfirmed)return [];
 const text=String(input.about||''),out=[];
 for(const match of text.matchAll(EMAIL)){
  const raw=match[0],before=text.slice(Math.max(0,match.index-140),match.index),after=text.slice(match.index+raw.length);
  if(isUnsafeContact(raw)||!tokenSafe(raw)||/^[\w@]|^\.[\w-]|^-(?!-{2})/.test(after)||/[\w@]$/.test(before))continue;
  // A sentence joined onto a local part is ambiguous, not a new email guess.
  if(/\blet[’']?s\s*$/i.test(before)&&/^connect\./i.test(raw))continue;
  const invitation=/(?:\be-?mail(?:ing)?\b|\breach\s+(?:me|out)\b|\bcontact\s+me\b|\blet[’']?s\s+(?:talk|connect|start\s+a\s+conversation)\b|📧|📩|💌|✉)/iu.test(before.normalize('NFKC').replace(/([a-z])([A-Z])/g,'$1 $2'));
  const lineStart=text.lastIndexOf('\n',match.index-1)+1,lineEnd=text.indexOf('\n',match.index+raw.length);
  const line=text.slice(lineStart,lineEnd<0?text.length:lineEnd).trim();
  const signature=personEmail(raw,input)&&line.replace(raw,'').replace(/[\s:|✉📧📩💌-]/gu,'')==='';
  if(!invitation&&!signature||/\b(?:example|sample|testimonial|client['’]s\s+email)\b/i.test(before.slice(-80)))continue;
  out.push({address:raw.toLowerCase(),source:'linkedin',url:input.linkedinUrl||input.url,ownership:'PUBLISHED',excerpt:(before.slice(-90)+raw).trim()});
 }
 return [...new Map(out.map(c=>[c.address,c])).values()];
}
function profileWebsiteEvidence(input){
 const text=String(input.about||''),urls=[],rejectedHosts=[];
 const pattern=/(?<![\w@.-])(?:https?:\/\/|www\.)[^\s"'<>\])]+|(?<![\w@.-])(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z]{2,24}(?:\/[^\s"'<>\])]+)?/gi;
 for(const match of text.matchAll(pattern)){
  const token=match[0].replace(/[.,;:!?]+$/g,'');
  try{
   const url=new URL(/^https?:\/\//i.test(token)?token:'https://'+token);
   if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.port||isPlatformWebsite(url.href))continue;
   // A domain occurring inside an address is not a published website URL.
   if(text[match.index-1]==='@')continue;
   const before=text.slice(Math.max(0,match.index-70),match.index),after=text.slice(match.index+match[0].length);
   const explicit=/^(?:https?:\/\/|www\.)/i.test(token);
   const lineStart=text.lastIndexOf('\n',match.index-1)+1,lineEnd=text.indexOf('\n',match.index+token.length);
   const line=text.slice(lineStart,lineEnd<0?text.length:lineEnd).trim();
   const standalone=line===match[0]||line===token;
   const context=/\b(?:visit|website|web\s*site|site|url|online|learn\s+more|find\s+me|see\s+more)\s*(?:at|on|is|here)?\s*[:=]?\s*$/i.test(before);
   const safe=tokenSafe(url.hostname)&&!/^-[a-z]/i.test(after)&&(explicit||url.pathname!=='/'||standalone||context);
   if(!safe){rejectedHosts.push(url.hostname.replace(/^www\./,''));continue;}
   urls.push(url.href);
  }catch{/* malformed published URL */}
 }
 return {urls:[...new Set(urls)].slice(0,8),rejectedHosts:[...new Set(rejectedHosts)]};
}
function publishedProfileWebsites(input){return profileWebsiteEvidence(input).urls;}
module.exports={publishedProfileEmails,publishedProfileWebsites,profileWebsiteEvidence};
