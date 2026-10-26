'use strict';

// Search terms, a LinkedIn subdomain, and a person's markets are not residence
// evidence. Only an explicit location field or a geographic SERP metadata row
// may supply the person's country. Shared with rendered-profile verification.
const normalized=value=>String(value||'').normalize('NFKD').replace(/\p{M}/gu,'').replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,'').replace(/\s+/g,' ').trim();
const key=value=>normalized(value).toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const TARGETS={
 UK:['UK','GB','GBR','United Kingdom','Great Britain','Britain','England','Scotland','Wales','Northern Ireland','Royaume-Uni','Reino Unido','المملكة المتحدة'],
 US:['US','USA','United States','United States of America','États-Unis','Estados Unidos','Vereinigte Staaten','الولايات المتحدة','الولايات المتحدة الأمريكية'],
 Canada:['Canada','CAN','Canadá','كندا'],
};
const countries=new Map(Object.entries(TARGETS).flatMap(([country,aliases])=>aliases.map(alias=>[key(alias),country])));
const OUTSIDE=['India','France','Germany','Australia','New Zealand','Ireland','Republic of Ireland','Pakistan','Bangladesh','Sri Lanka','Nepal','China','Japan','Singapore','Malaysia','Philippines','Indonesia','Vietnam','Thailand','South Africa','Nigeria','Kenya','Egypt','Morocco','Tunisia','Algeria','United Arab Emirates','UAE','Saudi Arabia','Qatar','Kuwait','Bahrain','Israel','Turkey','Türkiye','Italy','Spain','Portugal','Netherlands','The Netherlands','Belgium','Switzerland','Austria','Poland','Sweden','Norway','Denmark','Finland','Iceland','Russia','Ukraine','Romania','Greece','Mexico','Brazil','Argentina','Chile','Colombia','Peru','Hong Kong','Taiwan','South Korea','Corée du Sud','Inde','Indien','Deutschland','Australie','الهند','فرنسا','ألمانيا','المغرب'];
const outside=new Set(OUTSIDE.map(key)),countryNames=new Map();
for(const [country,aliases]of Object.entries(TARGETS))for(const alias of aliases)countryNames.set(normalized(alias).toLowerCase(),country);
for(const alias of OUTSIDE)countryNames.set(normalized(alias).toLowerCase(),null);
// LinkedIn localizes the rendered country name. Intl supplies country labels,
// not a city gazetteer; we still require a complete anchored country token.
for(const locale of ['en','fr','ar','de','es','pt']){
 const display=new Intl.DisplayNames([locale],{type:'region'});
 for(let first=65;first<=90;first++)for(let second=65;second<=90;second++){
  const code=String.fromCharCode(first,second),label=display.of(code);
  if(!label||label===code)continue;
  const country=(code==='GB'?'UK':code==='US'?'US':code==='CA'?'Canada':null)||countries.get(key(label))||null;
  if(country)countries.set(key(label),country);else outside.add(key(label));
  countryNames.set(normalized(label).toLowerCase(),country);
 }
}
outside.add(key('اوستراليا'));countryNames.set('اوستراليا',null);
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const countrySuffixes=[...countryNames].filter(([label])=>label.length>3).sort((a,b)=>b[0].length-a[0].length).map(([label,country])=>({country,pattern:new RegExp('(?:^|[\\s,])'+escape(label)+'$','iu')}));
const LOCATION_LABEL='(?:Location|Localisation|Ubicaci[oó]n|Standort|الموقع(?: الجغرافي)?)';
const prose=/\b(?:clients?|customers?|serving|serve|help(?:ing)?|worked?|experience|education|university|school|coach(?:ing)?|consult(?:ant|ing)?|market|target|formerly|previously|born|raised|remote|worldwide|international|global|speaks?|language|based|founder|ceo|cto|cfo|director|manager|president|company|corporation|executive|leadership|llc|ltd)\b|عملاء|العملاء|أساعد|اساعد|اخدم|أخدم|استشاري|مستشار|مدرب|جامعة|https?:|@|[\/&]/iu;
// These complete subdivisions are not mentions of Mexico, Jersey or Iceland
// (whose German name is Island). An explicit terminal country is still needed.
const subdivisions={US:['New Mexico','New Jersey','Rhode Island'],Canada:['Prince Edward Island']};

function countryMentions(value,country){
 let clean=normalized(value);
 for(const region of subdivisions[country]||[])clean=clean.replace(new RegExp('(?:^|[\\s,])'+escape(region)+'(?=$|[\\s,])','giu'),' ');
 const words=clean.split(/[\s,]+/u),found=[];
 for(let i=0;i<words.length;i++){
  for(let length=Math.min(8,words.length-i);length>0;length--){
   const token=key(words.slice(i,i+length).join(' ')),local=countries.get(token),foreign=outside.has(token);
   if(!local&&!foreign)continue;
   // These names have an explicit US state/city interpretation when the field
   // also ends with United States; don't misread them as foreign countries.
   if(!(country==='US'&&(token==='georgia'||token==='canada'&&key(words[i-1])==='little')))found.push(local||'OUTSIDE');
   i+=length-1;break;
  }
 }
 return found;
}

function canonicalDiscoveryTarget(value){return countries.get(key(value))||null;}

function parsePersonLocation(value){
 const rawText=typeof value==='string'?value.replace(/\s+/g,' ').trim().slice(0,240):'';
 const clean=normalized(rawText).replace(new RegExp('^'+LOCATION_LABEL+'\\s*:\\s*','iu'),'').replace(/\.$/,'').trim();
 const result={status:'UNCONFIRMED',country:null,rawText};
 if(!clean||clean.length>160||prose.test(clean)||/[;|·\n]/u.test(clean))return result;
 const parts=clean.split(',').map(p=>p.trim()).filter(Boolean);
 if(parts.length>5||parts.some(p=>p.length>80||!/^[\p{L}\p{N}\s.'’()\-]+$/u.test(p)))return result;
 const terminal=parts.at(-1);let country=canonicalDiscoveryTarget(terminal),foreign=outside.has(key(terminal));
 if(!country&&!foreign){const suffix=countrySuffixes.find(candidate=>candidate.pattern.test(terminal));if(suffix){country=suffix.country;foreign=!country;}}
 if(!country&&!foreign)return result;
 const mentions=countryMentions(clean,country);
 if(country&&mentions.some(mention=>mention!==country))return {...result,status:'CONFLICT'};
 // Earlier exact country tokens cannot silently be interpreted as a city. A
 // city such as Little Canada or Paris, Texas does not match a country token.
 const earlier=parts.slice(0,-1).map(p=>({country:canonicalDiscoveryTarget(p),foreign:outside.has(key(p))&&!(country==='US'&&key(p)==='georgia')}));
 if(earlier.some(p=>country&&p.foreign||p.country&&p.country!==country))return {...result,status:'CONFLICT'};
 return {...result,status:country?'CONFIRMED':'OUTSIDE_TARGET',country};
}

function resultLocationCandidates(item){
 const candidates=[],seen=new Set();
 const add=(value,source)=>{if(typeof value!=='string'||!value.trim())return;const raw=value.replace(/<[^>]*>/g,' ').replace(/&nbsp;/gi,' ').replace(/\s+/g,' ').trim();const id=source+'|'+raw;if(!seen.has(id)){seen.add(id);candidates.push({rawText:raw,source});}};
 const attributes=[item?.attributes,item?.richSnippet?.top?.attributes,item?.rich_snippet?.top?.attributes];
 for(const values of attributes)if(values&&typeof values==='object'&&!Array.isArray(values))for(const [label,value]of Object.entries(values)){
  if(/^(?:location|country|localisation|standort|ubicación|الموقع(?: الجغرافي)?)$/iu.test(label.trim()))add(value,'SERP_ATTRIBUTE_LOCATION');
 }
 const snippet=typeof item?.snippet==='string'?item.snippet:'';
 const explicit=new RegExp('(?:^|[·|;\\n])\\s*'+LOCATION_LABEL+'\\s*:\\s*([^·|;\\n]+)','giu');
 for(const match of snippet.matchAll(explicit))add(match[1].split(/\.\s+(?=[\p{L}])/u)[0].replace(/\s+(?:Experience|Education|Connections|Followers)\s*:.*$/iu,''),'SERP_SNIPPET_LOCATION');
 // LinkedIn's Google metadata commonly begins "City, Region, Country · ...".
 // Whole free-text snippets and headlines are never searched for country names.
 if(!new RegExp('^\\s*'+LOCATION_LABEL+'\\s*:','iu').test(snippet)){
  const prefix=snippet.split(/[·|\n]/u)[0].split(/\.\s+(?=[\p{L}\d])/u)[0].trim();
  if(prefix.includes(',')||canonicalDiscoveryTarget(prefix)||outside.has(key(prefix)))add(prefix,'SERP_LOCATION_PREFIX');
 }
 for(const rich of [item?.richSnippet?.top,item?.rich_snippet?.top])for(const extension of Array.isArray(rich?.extensions)?rich.extensions:[]){
  if(typeof extension==='string'&&parsePersonLocation(extension).status!=='UNCONFIRMED')add(extension,'SERP_RICH_METADATA_LOCATION');
 }
 return candidates;
}

function assessDiscoveryLocation(item,requestedLocation,observedAt=new Date().toISOString()){
 const target=canonicalDiscoveryTarget(requestedLocation),candidates=resultLocationCandidates(item);
 const records=candidates.map(candidate=>({...parsePersonLocation(candidate.rawText),source:candidate.source}));
 const base={status:'UNCONFIRMED',country:null,rawText:'',source:null,reasonCode:'LOCATION_NOT_SHOWN'};
 if(!target)return {...base,reasonCode:'LOCATION_TARGET_UNSUPPORTED'};
 if(!records.length)return base;
 const decisive=records.filter(r=>r.status!=='UNCONFIRMED');
 if(records.some(r=>r.status==='CONFLICT')||new Set(decisive.map(r=>r.country||'OUTSIDE')).size>1)return {...base,status:'CONFLICT',rawText:records.map(r=>r.rawText).join(' | ').slice(0,500),reasonCode:'LOCATION_CONFLICT'};
 if(!decisive.length)return {...base,rawText:records[0].rawText,source:records[0].source,reasonCode:'LOCATION_UNCONFIRMED'};
 // A malformed explicit Location field cannot be rescued by an unrelated row.
 if(records.some(r=>r.status==='UNCONFIRMED'&&r.source!=='SERP_LOCATION_PREFIX'))return {...base,status:'CONFLICT',rawText:records.map(r=>r.rawText).join(' | ').slice(0,500),reasonCode:'LOCATION_CONFLICT'};
 const chosen=decisive[0];
 if(chosen.status==='OUTSIDE_TARGET'||chosen.country!==target)return {...chosen,status:'OUTSIDE_TARGET',reasonCode:chosen.country?'LOCATION_TARGET_MISMATCH':'LOCATION_OUTSIDE_TARGET'};
 return {...chosen,reasonCode:null,evidence:{version:1,status:'CONFIRMED',country:chosen.country,rawText:chosen.rawText,source:chosen.source,requestedLocation,observedAt}};
}

module.exports={canonicalDiscoveryTarget,parsePersonLocation,assessDiscoveryLocation};
