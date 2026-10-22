'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {pageSignal,failure,isFeed,sameMember}=require('../../src/lib/linkedin-session-policy.cjs');
test('login and security signals stop processing, including a restriction page returned with HTTP 200',()=>{
 for(const values of [
  {url:'https://www.linkedin.com/checkpoint/challenge/'},
  {url:'https://www.linkedin.com/login'},
  {url:'https://www.linkedin.com/feed/',status:403},
  {url:'https://www.linkedin.com/feed/',status:429},
  {url:'https://www.linkedin.com/feed/',status:999},
  {url:'https://www.linkedin.com/checkpoint/lg/login-submit',status:200,text:'Your account has been temporarily restricted'},
  {url:'https://www.linkedin.com/feed/',status:200,text:'Your account is restricted'},
 ]){
  const signal=pageSignal(values);assert.ok(signal,JSON.stringify(values));
  assert.equal(failure(signal).retryable,false);
 }
});
test('manual login pages stay available for the human; challenges remain visible stop signals',()=>{
 assert.equal(pageSignal({url:'https://www.linkedin.com/login',manual:true}),null);
 assert.ok(pageSignal({url:'https://www.linkedin.com/checkpoint/challenge/',manual:true}));
 assert.ok(pageSignal({url:'https://www.linkedin.com/login',manual:true,text:'Your account is temporarily suspended'}));
});
test('third-party errors and ordinary LinkedIn content are not classified as account restrictions',()=>{
 for(const values of [{url:'https://linkedin.com.attacker.test/feed',status:403},{url:'https://example.test/login',status:429},{url:'https://www.linkedin.com/feed/',text:'This post discusses restricted businesses.'},{url:'https://www.linkedin.com/feed/',status:200}])assert.equal(pageSignal(values),null);
});
test('identity polling requires the LinkedIn feed, not an unrelated URL containing /feed',()=>{
 assert.equal(isFeed('https://www.linkedin.com/feed/'),true);
 for(const url of ['https://example.test/feed/','https://linkedin.com.attacker.test/feed','https://www.linkedin.com/login?next=/feed','https://www.linkedin.com/feed-copy','http://www.linkedin.com/feed/'])assert.equal(isFeed(url),false);
 assert.equal(sameMember({memberUrn:'one'},{memberUrn:'two'}),false);
 assert.equal(sameMember({profileUrl:'https://www.linkedin.com/in/one/'},{profileUrl:'https://www.linkedin.com/in/one'}),true);
 assert.equal(sameMember({memberUrn:''},{memberUrn:''}),false);
});
