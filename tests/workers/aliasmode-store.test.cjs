'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),core=require('../../src/lib/linkedin-workers.cjs'),store=require('../../src/lib/aliasmode-store.cjs'),{database}=require('./db-fixture.cjs');
test('profile bindings use additive isolated PostgreSQL state and preserve holds, usage and account identity',async()=>{
 const db=await database(),pool=db.pool;try{
  await core.ensure(pool);await store.ensure(pool);
  const id=await store.importProfile(pool,{profileId:'fixture-one',name:'Profile one',expectedMemberName:'John Dilah'});
  await pool.query("UPDATE compel_linkedin_accounts SET attention_reason='Existing hold',daily_limit=123 WHERE id=$1",[id]);
  await store.bind(pool,{accountId:id,profileId:'fixture-two',name:'Renamed',bindingRevision:0});
  let row=(await pool.query('SELECT * FROM compel_linkedin_accounts WHERE id=$1',[id])).rows[0];assert.equal(row.attention_reason,'Existing hold');assert.equal(row.daily_limit,123);assert.equal(row.processing_enabled,false);assert.equal(row.expected_member_name,'John Dilah');assert.equal(row.email,'aliasmode:fixture-one');
  await assert.rejects(store.bind(pool,{accountId:id,profileId:'third',bindingRevision:0}),/changed/);
  await core.acquireSession(pool,id,'fixture-owner');await assert.rejects(store.bind(pool,{accountId:id,profileId:'third',bindingRevision:1}),/Close/);
  await store.saveSession(pool,{id,aliasmode_profile_id:'fixture-two',binding_revision:1},'fixture-owner',{managed:true,headless:true,pid:10,targetId:'tab'});
  await assert.rejects(store.saveSession(pool,{id,aliasmode_profile_id:'wrong',binding_revision:1},'fixture-owner',{managed:true}),e=>e.code==='ALIASMODE_OWNERSHIP_CHANGED');
  assert.equal((await store.session(pool,'fixture-two')).owner,'fixture-owner');
 }finally{await db.close();}
});
test('AliasMode config has no API key and profile imports remain paused',async()=>{
 const db=await database(),pool=db.pool;try{
  await core.ensure(pool);await store.ensure(pool);
  await store.saveConfig(pool,{baseUrl:'http://127.0.0.1:50400',revision:0});
  const publicValue=await store.publicSettings(pool);assert.equal(publicValue.revision,1);assert.equal('apiKeyConfigured' in publicValue,false);assert.equal('apiKey' in await store.privateConfig(pool),false);
  await assert.rejects(store.saveConfig(pool,{baseUrl:publicValue.baseUrl,revision:1,apiKey:'must-not-store'}),/Invalid/);
  const one=await store.importProfile(pool,{profileId:'one',name:'One',expectedMemberName:'John Dilah'});await assert.rejects(store.importProfile(pool,{profileId:'one',name:'Duplicate',expectedMemberName:'Other'}),/already linked/);
  const row=(await pool.query('SELECT processing_enabled,confirmed_identity,connected_at FROM compel_linkedin_accounts WHERE id=$1',[one])).rows[0];assert.equal(row.processing_enabled,false);assert.equal(row.confirmed_identity,null);assert.equal(row.connected_at,null);
  await store.requestClose(pool,one);const token=(await pool.query('SELECT close_requested_at::text AS token FROM compel_linkedin_accounts WHERE id=$1',[one])).rows[0].token;
  assert.equal(await store.finishClose(pool,one,'2000-01-01T00:00:00Z'),false);assert.equal(await store.finishClose(pool,one,token),true);
 }finally{await db.close();}
});
