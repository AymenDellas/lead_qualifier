'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),p=require('../../src/lib/account-session-policy.cjs');
const now=Date.parse('2026-10-27T12:00:00Z');
const account=()=>({aliasmode_profile_id:'fixture',binding_revision:1,session_revision:2,engine:'aliasmode-chromium',launch_mode:'headful',proxy_id:'dedicated-one',proxy_host:'proxy.test',proxy_port:8000,proxy_country:'GB',proxy_timezone:'Europe/London',daily_limit:300,session_evidence:{expectedExitIp:'192.0.2.10'},session_policy:{}});
function ready(){const a=account(),key=p.evidenceKey(a);Object.assign(a.session_evidence,{network:{verdict:'PASS',key},fingerprint:{hash:'baseline'},gate:{verdict:'PASS',key,fingerprintHash:'baseline'}});return a;}
test('network evidence cannot pass without exact fixed exit IP and country/timezone matching',()=>{
 const a=account(),observed={ip:'192.0.2.10',country:'GB',timezone:'Europe/London'};
 assert.equal(p.networkVerdict(observed,a).verdict,'PASS');
 for(const change of [{ip:'192.0.2.11'},{country:'US'},{timezone:'UTC'},{datacenter:true},{rotating:true}])assert.equal(p.networkVerdict({...observed,...change},a).verdict,'FAIL');
 assert.equal(p.networkVerdict({},a).verdict,'UNKNOWN');delete a.session_evidence.expectedExitIp;assert.equal(p.networkVerdict(observed,a).verdict,'UNKNOWN');
});
test('incomplete diagnostics, stale binding evidence and fingerprint drift block qualification before warmup',()=>{
 const a=ready();assert.equal(p.lifecycle(a,{now}).state,'WARMUP');
 a.session_evidence.gate.verdict='UNKNOWN';assert.equal(p.lifecycle(a,{now}).state,'PROVISION');a.session_evidence.gate.verdict='PASS';
 a.binding_revision++;assert.equal(p.lifecycle(a,{now}).state,'PROVISION');a.binding_revision--;
 a.session_evidence.drift={before:'one',after:'two'};assert.equal(p.lifecycle(a,{now}).state,'HOLD');
 a.attention_reason='Exact saved LinkedIn notice';assert.equal(p.lifecycle(a,{now}).reason,a.attention_reason);
});
test('warmup requires observed distinct local days and elapsed time; ramp never exceeds saved account ceiling',()=>{
 const a=ready();a.session_evidence.warmupDays=['2026-10-23','2026-10-24','2026-10-25','2026-10-26'];a.session_evidence.rampStartedAt=new Date(now).toISOString();
 assert.equal(p.lifecycle(a,{now}).limit,15);assert.equal(p.lifecycle(a,{now:now+7*86400000}).limit,30);assert.equal(p.lifecycle(a,{now:now+14*86400000}).limit,60);assert.equal(p.lifecycle(a,{now:now+21*86400000}).limit,100);
 a.daily_limit=20;assert.equal(p.lifecycle(a,{now:now+21*86400000}).limit,20);
 a.session_evidence.warmupDays=['2026-10-27','2026-10-27','2026-10-27','2026-10-27'];assert.equal(p.lifecycle(a,{now}).state,'WARMUP');
});
test('recovery deadline is authoritative and never authorizes an account with a review hold',()=>{
 const a=ready();a.session_evidence.recoveryUntil=new Date(now+7*86400000).toISOString();assert.equal(p.lifecycle(a,{now}).state,'RECOVERY');
 a.attention_reason='Hold';assert.equal(p.lifecycle(a,{now:now+30*86400000}).state,'HOLD');
});
test('fingerprint binds observed properties to immutable profile/configuration identity',()=>{
 const probe={userAgent:'Chrome fixture',platform:'Win32',timezone:'Europe/London',locale:'en-GB',screen:{width:1920,height:1080},hardwareConcurrency:4};
 const a=p.fingerprint(probe,{profileId:'one',mode:'headful'});assert.equal(a.hash,p.fingerprint(structuredClone(probe),{profileId:'one',mode:'headful'}).hash);
 assert.notEqual(a.hash,p.fingerprint({...probe,timezone:'UTC'},{profileId:'one',mode:'headful'}).hash);
 assert.notEqual(a.hash,p.fingerprint(probe,{profileId:'two',mode:'headful'}).hash);
 assert.throws(()=>p.fingerprint({}),/incomplete/);
});
test('spacing is bounded without jitter timers; invalid configuration is rejected',()=>{
 assert.equal(p.interval({},(a,b)=>a),60000);assert.equal(p.interval({},(a,b)=>b-1),150000);
 for(const c of [{minIntervalSeconds:10},{maxIntervalSeconds:59},{unexpected:1},{warmupDays:0}])assert.throws(()=>p.config(c));
});
