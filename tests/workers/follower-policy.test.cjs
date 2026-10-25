'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {parseFollowerCount,parseAudienceCount,audienceRecord,followersDecision,minFollowers}=require('../../src/lib/follower-policy.cjs');
test('counts parse commas, K/M suffixes and compact bare values',()=>{
 for(const [text,count]of [['1,234 followers',1234],['1.2K',1200],['12K',12000],['1M',1000000],['1.25m followers',1250000],['1 234 followers',1234],['0 followers',0],['1,234K',1234000]])assert.equal(parseFollowerCount(text),count,text);
});
test('absent, ambiguous and connections-only text never supplies a follower count',()=>{
 for(const text of ['',undefined,'followers','500+ connections','1,500 connections','1.2 followers','1,000+ followers','1K people','I help coaches reach 12K followers','NaN','1KK','-100 followers'])assert.equal(parseFollowerCount(text),null,String(text));
 assert.equal(audienceRecord('500+ connections','connections').count,500);
 assert.equal(audienceRecord('500+ connections').count,null);
});
test('localized follower labels and number separators are explicit; unknown languages remain reviewable',()=>{
 for(const [text,count]of [['1 234 abonnés',1234],['1.234 seguidores',1234],['1,2K seguidores',1200],['١٬٢٣٤ متابع',1234],['12K volgers',12000]])assert.equal(parseFollowerCount(text),count,text);
 assert.equal(parseFollowerCount('1234 未知ラベル'),null);
});
test('strict greater-than threshold produces continue, rejection or review with evidence',()=>{
 assert.deepEqual(followersDecision({count:1001,rawText:'1,001 followers'}),{status:'CONTINUE',reason:null,threshold:1000});
 for(const count of [0,999,1000])assert.equal(followersDecision({count}).reason,'FOLLOWERS_BELOW_MIN');
 assert.deepEqual(followersDecision({count:null,rawText:''}),{status:'REVIEW',reason:'FOLLOWERS_NOT_SHOWN',threshold:1000});
 assert.equal(followersDecision({count:null,rawText:'followers'}).reason,'FOLLOWERS_UNPARSEABLE');
 assert.equal(followersDecision({count:1500},2000).status,'REJECTED');
 assert.equal(followersDecision({count:2001},2000).status,'CONTINUE');
 assert.equal(minFollowers({}),1000);assert.equal(minFollowers({MIN_FOLLOWERS:'1200'}),1200);assert.throws(()=>minFollowers({MIN_FOLLOWERS:'bad'}),/integer/);
 assert.equal(parseAudienceCount('10000000000000000000000000M'),null);
});
