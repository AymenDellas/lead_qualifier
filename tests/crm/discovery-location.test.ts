import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {pool} from '../../src/lib/pg_setup';
import {insertDiscoveryProvenance,type DiscoveryProvenance} from '../../src/lib/db';
const connect=pool.connect;
afterEach(()=>{pool.connect=connect;});
const input=():DiscoveryProvenance=>({linkedin_url:'https://www.linkedin.com/in/location-fixture/',location:'US',
 query:'Executive Coach United States',templateId:'fixture',niche:'Executive Coach',discoveryLocation:'United States',
 locationEvidence:{version:1,status:'CONFIRMED',country:'US',rawText:'Austin, Texas, United States',
  source:'SERP_SNIPPET_LOCATION',requestedLocation:'United States',observedAt:'2026-10-26T10:00:00Z'},
 page:1,rank:1,title:'Ava Morgan - Executive Coach | LinkedIn',snippet:'Location: Austin, Texas, United States',runId:'fixture',fitScore:70,fitReasons:[]});
test('Finder DB guard rejects absent, foreign, mismatched and conflicting location proof before connecting',async()=>{
 (pool as any).connect=()=>assert.fail('Invalid evidence must not open a connection');
 for(const transform of [
  (p:DiscoveryProvenance)=>({...p,locationEvidence:undefined}),
  (p:DiscoveryProvenance)=>({...p,location:'Canada'}),
  (p:DiscoveryProvenance)=>({...p,discoveryLocation:'UK'}),
  (p:DiscoveryProvenance)=>({...p,locationEvidence:{...p.locationEvidence,rawText:'Paris, France'}}),
  (p:DiscoveryProvenance)=>({...p,locationEvidence:{...p.locationEvidence,rawText:'India United States'}}),
  (p:DiscoveryProvenance)=>({...p,locationEvidence:{...p.locationEvidence,observedAt:'bad-date'}}),
  (p:DiscoveryProvenance)=>({...p,locationEvidence:{...p.locationEvidence,source:'QUERY_TARGET'}}),
 ])await assert.rejects(insertDiscoveryProvenance(transform(input()) as DiscoveryProvenance),/person-location evidence/);
});
test('Finder persists actual country separately from query target and raw evidence',async()=>{
 const calls:{sql:string,args:any[]}[]=[];let released=false;
 (pool as any).connect=async()=>({query:async(sql:string,args:any[])=>{calls.push({sql,args});return {rows:[]};},release:()=>{released=true;}});
 assert.deepEqual(await insertDiscoveryProvenance(input()),{inserted:true});
 assert.equal(calls.length,2);assert.match(calls[1].sql,/discovery_location_evidence/);
 assert.equal(calls[1].args[2],'US');assert.equal(calls[1].args[6],'United States');
 assert.deepEqual(JSON.parse(calls[1].args[16]),input().locationEvidence);assert.equal(released,true);
});
test('re-finding a profile preserves current location, pipeline, manual edits and first-touch provenance',async()=>{
 const calls:{sql:string,args:any[]}[]=[];
 (pool as any).connect=async()=>({query:async(sql:string,args:any[])=>{calls.push({sql,args});return {rows:sql.startsWith('SELECT')?[{id:'existing',fit_score:90}]:[]};},release:()=>{}});
 assert.deepEqual(await insertDiscoveryProvenance(input()),{inserted:false});
 const update=calls[1].sql;assert.doesNotMatch(update,/\blocation\s*=|pipeline_status\s*=|discovery_query\s*=|discovery_location\s*=/i);
 assert.match(update,/COALESCE\(discovery_location_evidence/);assert.equal(calls[1].args[1],false);
});
