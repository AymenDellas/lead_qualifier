'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {canonicalDiscoveryTarget,parsePersonLocation,assessDiscoveryLocation}=require('../../src/lib/discovery-location-evidence.cjs');

test('Finder targets accept only unambiguous UK/US/Canada country aliases',()=>{
 for(const [input,country]of [['US','US'],['U.S.A.','US'],['United States','US'],['UK','UK'],['United Kingdom','UK'],['Great Britain','UK'],['Canada','Canada'],['CAN','Canada']])assert.equal(canonicalDiscoveryTarget(input),country);
 for(const input of ['CA','London','Georgia','America','India','France','','US clients','Canada coach'])assert.equal(canonicalDiscoveryTarget(input),null,input);
});

test('explicit person-location country fields support UK/US/Canada and localized country suffixes',()=>{
 for(const [raw,country]of [
  ['London, England, United Kingdom','UK'],['Edinburgh, Scotland, United Kingdom','UK'],['Northern Ireland','UK'],
  ['Toronto, Ontario, Canada','Canada'],['Québec, Canada','Canada'],['Montréal Québec Canada','Canada'],
  ['Little Canada, Minnesota, United States','US'],['Paris, Texas, United States','US'],['Georgia, United States','US'],['New York, NY, U.S.A.','US'],
  ['Taos, New Mexico, United States','US'],['Highlands, New Jersey, United States','US'],['Providence, Rhode Island, United States','US'],
  ['Charlottetown, Prince Edward Island, Canada','Canada'],
  ['نيويورك نيويورك الولايات المتحدة','US'],['إنجلترا لندن الكبرى المملكة المتحدة','UK'],['أونتاريو تورونتو كندا','Canada'],['Londres, Royaume-Uni','UK'],
 ]){const result=parsePersonLocation(raw);assert.equal(result.status,'CONFIRMED',raw);assert.equal(result.country,country,raw);assert.equal(result.rawText,raw);}
});

test('foreign person locations never become targets because of a familiar city, suffix, or market mention',()=>{
 for(const raw of ['Bengaluru, Karnataka, India','Paris, France','London, Ontario, Australia','London, South Africa','Lisbon, Portugal','Singapore, Singapore','Hong Kong, Hong Kong SAR, Hong Kong SAR China',
  'كوينسلاند برزبين اوستراليا','نورد-هولاند أمستردام هولندا','نوردرهين-ويستفالين كولونيا ألمانيا','باريس فرنسا','بنغالور الهند'])assert.equal(parsePersonLocation(raw).status,'OUTSIDE_TARGET',raw);
 for(const raw of ['London','Toronto','Ontario','California','CA','Greater Boston','India · United States','I help US clients','Serving clients in London, United Kingdom','مدرب لخدمة العملاء في المملكة المتحدة'])assert.notEqual(parsePersonLocation(raw).status,'CONFIRMED',raw);
 assert.equal(parsePersonLocation('India, United States').status,'CONFLICT');
 assert.equal(parsePersonLocation('Canada, United Kingdom').status,'CONFLICT');
});

test('SERP explicit location evidence is stored separately from requested query location',()=>{
 for(const item of [
  {snippet:'Location: London, England, United Kingdom · Experience: Practice'},
  {snippet:'London, England, United Kingdom · 500+ connections'},
  {snippet:'London, England, United Kingdom. Experience: Practice'},
  {attributes:{Location:'London, England, United Kingdom'},snippet:'I help clients in India'},
  {rich_snippet:{top:{extensions:['London, England, United Kingdom','500+ connections']}}},
 ]){const found=assessDiscoveryLocation(item,'UK','2026-10-25T12:00:00Z');assert.equal(found.status,'CONFIRMED',JSON.stringify(item));assert.equal(found.country,'UK');assert.equal(found.evidence.country,'UK');assert.equal(found.evidence.requestedLocation,'UK');assert.equal(found.evidence.observedAt,'2026-10-25T12:00:00Z');assert.ok(found.evidence.rawText.includes('United Kingdom'));}
});

test('query, title, subdomain and service markets cannot prove residence',()=>{
 for(const item of [
  {link:'https://uk.linkedin.com/in/coach',title:'Coach - United Kingdom',snippet:'I coach clients in the UK, US and Canada'},
  {location:'United States',query:'site:linkedin.com/in "United States"',snippet:''},
  {snippet:'I work with US clients from India'},
  {snippet:'Executive Coach, United States · Helping leaders'},
  {snippet:'Experience: Coach at UK Company · Education: University of Canada'},
  {attributes:{Location:'London'},title:'United Kingdom coach'},
 ])assert.notEqual(assessDiscoveryLocation(item,'UK').status,'CONFIRMED',JSON.stringify(item));
});

test('outside, conflicting and wrong requested-country evidence fails closed',()=>{
 assert.equal(assessDiscoveryLocation({snippet:'Location: Bengaluru, India · I help UK clients'},'UK').reasonCode,'LOCATION_OUTSIDE_TARGET');
 assert.equal(assessDiscoveryLocation({snippet:'Location: Paris, France · Canada coaching'},'Canada').status,'OUTSIDE_TARGET');
 assert.equal(assessDiscoveryLocation({snippet:'Location: Toronto, Canada'},'UK').reasonCode,'LOCATION_TARGET_MISMATCH');
 assert.equal(assessDiscoveryLocation({attributes:{Location:'New York, United States'},snippet:'Location: Paris, France'},'US').reasonCode,'LOCATION_CONFLICT');
 assert.equal(assessDiscoveryLocation({attributes:{Location:'London'},snippet:'United States · 500+ connections'},'US').reasonCode,'LOCATION_CONFLICT');
 assert.equal(assessDiscoveryLocation({snippet:'Location: New York, United States'},'CA').reasonCode,'LOCATION_TARGET_UNSUPPORTED');
});
