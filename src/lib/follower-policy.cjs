'use strict';
const DEFAULT_MIN_FOLLOWERS=1000;
const LABELS={followers:'followers?|abonn[ée]s?|seguidores?|volgers|seguaci|follower(?:innen)?|follower:innen|متابع(?:ون|ين|ًا|اً)?|팔로워|フォロワー',
 connections:'connections?|relations?|conexiones|contatti|connecties|kontakte|زميل(?:ا|اً|ًا)?|اتصالات'};
function digits(value){return String(value||'').replace(/[٠-٩]/g,d=>String(d.charCodeAt(0)-1632)).replace(/[۰-۹]/g,d=>String(d.charCodeAt(0)-1776)).replace(/٬/g,',').replace(/٫/g,'.');}
function parseAudienceCount(value,{lowerBound=false}={}){
 let text=digits(value).trim().replace(/[\u00a0\u202f]/g,' ');
 if(lowerBound)text=text.replace(/\+$/,'');
 if(!/^[\d., ]+[kKmM]?$/.test(text))return null;
 const suffix=text.match(/[kKmM]$/)?.[0].toUpperCase();if(suffix)text=text.slice(0,-1).trim();
 let numeric;
 if(suffix){
  text=text.replace(/ /g,'');
  if(/^\d{1,3}(?:,\d{3})+$/.test(text))text=text.replace(/,/g,'');
  else if(/^\d+,\d{1,2}$/.test(text))text=text.replace(',','.');
  if(!/^\d+(?:\.\d+)?$/.test(text))return null;
  numeric=Number(text)*(suffix==='K'?1000:1000000);
 }else{
  if(!/^\d+$/.test(text)&&!/^\d{1,3}(?:[, .]\d{3})+$/.test(text))return null;
  numeric=Number(text.replace(/[, .]/g,''));
 }
 const count=Math.round(numeric);return Number.isSafeInteger(count)&&count>=0?count:null;
}
function audienceRecord(value,kind='followers'){
 const rawText=String(value||'').replace(/\s+/g,' ').trim().slice(0,200);
 const expression=new RegExp('^([\\d٠-٩۰-۹.,٬٫ \\u00a0\\u202f]+[kKmM]?'+(kind==='connections'?'\\+?':'')+')\\s*(?:'+LABELS[kind]+')$','iu');
 const match=rawText.match(expression);
 return {rawText,count:match?parseAudienceCount(match[1],{lowerBound:kind==='connections'}):null};
}
function parseFollowerCount(value){
 const record=audienceRecord(value);return record.count??parseAudienceCount(value);
}
function minFollowers(env=globalThis.process?.env||{}){
 if(!env.MIN_FOLLOWERS)return DEFAULT_MIN_FOLLOWERS;
 const value=Number(env.MIN_FOLLOWERS);if(!Number.isSafeInteger(value)||value<0)throw Error('MIN_FOLLOWERS must be a non-negative integer.');return value;
}
function followersDecision(record,threshold=DEFAULT_MIN_FOLLOWERS){
 if(!Number.isSafeInteger(record?.count)||record.count<0)return {status:'REVIEW',reason:record?.rawText?'FOLLOWERS_UNPARSEABLE':'FOLLOWERS_NOT_SHOWN',threshold};
 return record.count>threshold?{status:'CONTINUE',reason:null,threshold}:{status:'REJECTED',reason:'FOLLOWERS_BELOW_MIN',threshold};
}
module.exports={DEFAULT_MIN_FOLLOWERS,parseAudienceCount,parseFollowerCount,audienceRecord,followersDecision,minFollowers,LABELS};
