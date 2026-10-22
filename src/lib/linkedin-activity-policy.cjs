'use strict';
const DEFAULT_LIMITS=Object.freeze({profile:{hourly:15,daily:25},contact:{hourly:20,daily:50},activity:{hourly:15,daily:25},discovery:{hourly:15,daily:40},identity:{hourly:5,daily:10}});
const CATEGORIES=Object.keys(DEFAULT_LIMITS);
function category(kind){return ({profile_page:'profile',featured:'profile',activity_page:'activity',other:'identity'})[kind]||kind;}
function validateLimits(value={}) {
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!CATEGORIES.includes(k)))throw Error('Invalid activity limits.');
 return Object.fromEntries(CATEGORIES.map(key=>{
  const limit=value[key]??DEFAULT_LIMITS[key];
  if(!limit||!Number.isInteger(limit.hourly)||!Number.isInteger(limit.daily)||limit.hourly<1||limit.hourly>30||limit.daily<1||limit.daily>2000||limit.hourly>limit.daily)throw Error('Each activity needs a limit of 1–30 per hour and 1–2,000 per 24 hours; the hourly limit cannot exceed the daily limit.');
  return [key,{hourly:limit.hourly,daily:limit.daily}];
 }));
}
function validateHours(value) {
 if(value==null)return null;
 if(typeof value!=='object'||!Array.isArray(value.days)||!value.days.length||value.days.some(d=>!Number.isInteger(d)||d<0||d>6)||new Set(value.days).size!==value.days.length)throw Error('Choose at least one working day.');
 if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.start)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.end)||value.start===value.end)throw Error('Choose different start and end times in HH:MM format.');
 if(typeof value.timezone!=='string'||value.timezone.length>100)throw Error('Choose a valid time zone.');
 try{new Intl.DateTimeFormat('en-US',{timeZone:value.timezone}).format();}catch{throw Error('Choose a valid time zone.');}
 return {timezone:value.timezone,days:[...value.days].sort(),start:value.start,end:value.end};
}
function hoursAllowed(hours,now=Date.now()) {
 if(!hours)return true;
 const parts=new Intl.DateTimeFormat('en-US',{timeZone:hours.timezone,weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
 const get=type=>parts.find(p=>p.type===type)?.value;
 const day=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(get('weekday')),minute=Number(get('hour'))*60+Number(get('minute'));
 const minutes=s=>Number(s.slice(0,2))*60+Number(s.slice(3)),start=minutes(hours.start),end=minutes(hours.end);
 return start<end?hours.days.includes(day)&&minute>=start&&minute<end:(hours.days.includes(day)&&minute>=start||hours.days.includes((day+6)%7)&&minute<end);
}
function windowUsage(events,now=Date.now()) {
 const rows=events.map(e=>({...e,at:Date.parse(e.created_at||e.createdAt)})).filter(e=>Number.isFinite(e.at)&&e.at>now-86400000&&e.at<=now);
 return {daily:rows.length,hourly:rows.filter(e=>e.at>now-3600000).length,actions:Object.fromEntries(CATEGORIES.map(key=>[key,{daily:rows.filter(e=>category(e.data?.kind)===key).length,hourly:rows.filter(e=>category(e.data?.kind)===key&&e.at>now-3600000).length}]))};
}
function actionWait(events,kind,limits,now=Date.now()) {
 const limit=validateLimits(limits)[category(kind)];if(!limit)return 0;
 let wait=0;
 for(const [name,window] of [['hourly',3600000],['daily',86400000]]) {
  const times=events.filter(e=>category(e.data?.kind)===category(kind)).map(e=>Date.parse(e.created_at||e.createdAt)).filter(at=>at>now-window&&at<=now).sort((a,b)=>a-b);
  if(times.length>=limit[name])wait=Math.max(wait,times[times.length-limit[name]]+window-now+1);
 }
 return wait;
}
module.exports={DEFAULT_LIMITS,CATEGORIES,category,validateLimits,validateHours,hoursAllowed,windowUsage,actionWait};
