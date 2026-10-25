'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {normalizeEngineResult,normalizeEngineResults}=require('../../src/lib/engine-result.cjs');
test('failed and prospecting outcomes without contact fields keep their facts and renderable arrays',()=>{
 for(const status of ['ERROR','CANCELLED','PROSPECTED']){
  const input={status,failure:{reason:'Saved reason'},prospectQualification:{assessment:'retained'}};
  const result=normalizeEngineResult(input,'https://www.linkedin.com/in/fixture/');
  assert.equal(result.status,status);assert.equal(result.failure,input.failure);assert.equal(result.prospectQualification,input.prospectQualification);
  assert.deepEqual(result.emails,[]);assert.deepEqual(result.websites,[]);assert.deepEqual(result.logs,[]);assert.match(result.url,/\/in\/fixture\//);
  assert.equal(input.emails,undefined,'normalizing previews never rewrites saved outcomes');
 }
});
test('old caches with null or malformed fields cannot reach length, map or export with a non-array value',()=>{
 const result=normalizeEngineResults([null,42,{url:null,status:'ERROR',emails:'not an array',websites:[{},'https://fixture.test'],logs:[null,'Saved log']},
  {url:'https://www.linkedin.com/in/contact/',status:'QUALIFIED',emails:[null,'contact@fixture.test'],websites:null}]);
 assert.equal(result.length,2);assert.equal(result[0].url,'');assert.deepEqual(result[0].websites,['https://fixture.test']);assert.deepEqual(result[0].logs,['Saved log']);
 assert.deepEqual(result[1].emails,['contact@fixture.test']);assert.equal(result[1].status,'QUALIFIED');assert.deepEqual(normalizeEngineResults({}),[]);
 assert.equal(normalizeEngineResult(null),null);
});
