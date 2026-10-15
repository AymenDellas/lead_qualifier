'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const core=require('../../src/lib/linkedin-workers.cjs');
const key={DATABASE_URL:'postgres://fixture:long-fixture-password@fixture.invalid/db'};
test('credentials are randomized authenticated ciphertext, never plain password',()=>{
 const first=core.encrypt('a private password',key),second=core.encrypt('a private password',key);
 assert.notEqual(first,second);assert.equal(core.decrypt(first,key),'a private password');
 assert.ok(!first.includes('private password'));
 assert.throws(()=>core.decrypt(first,{DATABASE_URL:key.DATABASE_URL+'changed'}));
 const pieces=first.split('.');pieces[2]=Buffer.from('tampered').toString('base64url');
 assert.throws(()=>core.decrypt(pieces.join('.'),key));
});

test('hosted and persistent database ports share encryption, while existing logins remain readable',()=>{
 const direct={DATABASE_URL:'postgres://fixture:long-fixture-password@fixture.invalid:5432/db'};
 const pooled={DATABASE_URL:direct.DATABASE_URL.replace(':5432/',':6543/')};
 assert.equal(core.decrypt(core.encrypt('fixture password',pooled),direct),'fixture password');
 const {createHash,randomBytes,createCipheriv}=require('node:crypto');
 const oldKey=createHash('sha256').update('compel/linkedin-credentials/v1\0').update(direct.DATABASE_URL).digest();
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',oldKey,iv);
 const bytes=Buffer.concat([cipher.update('saved login','utf8'),cipher.final()]);
 const legacy=[iv,cipher.getAuthTag(),bytes].map(value=>value.toString('base64url')).join('.');
 assert.equal(core.decrypt(legacy,direct),'saved login');
});
test('account counts, duplicate identities, limits and passwords are validated',()=>{
 const account={label:'First',email:'first@example.test',password:'fixture',enabled:true,dailyLimit:400};
 const body={revision:0,activeCount:1,accounts:[account]};
 assert.equal(core.validateSettings(body).accounts.length,1);
 assert.throws(()=>core.validateSettings({...body,activeCount:2}));
 assert.throws(()=>core.validateSettings({...body,accounts:[account,{...account,email:'FIRST@EXAMPLE.TEST'}]}));
 assert.throws(()=>core.validateSettings({...body,accounts:[{...account,dailyLimit:401}]}));
 assert.throws(()=>core.validateSettings({...body,accounts:[{...account,password:''}]}));
 assert.throws(()=>core.validateSettings({...body,accounts:[{...account,id:'../../account-0'}]}));
 assert.equal(core.validateSettings({...body,activeCount:0}).activeCount,0);
});
test('only actual LinkedIn person URLs are accepted and normalized for deduplication',()=>{
 assert.equal(core.profileUrl('https://uk.linkedin.com/in/Ava/?trk=test'),'https://www.linkedin.com/in/ava/');
 for(const value of ['https://linkedin.com.attacker.test/in/ava','https://attacker.test/linkedin.com/in/ava','https://linkedin.com/company/acme','http://linkedin.com/in/ava','https://user:password@linkedin.com/in/ava'])assert.equal(core.profileUrl(value),null);
});
test('database JSON preserves emoji and handles malformed browser text',()=>{
 const value=JSON.parse(core.json({text:'Hello 😀\ud83d text\u0000'}));
 assert.equal(value.text,'Hello 😀� text');
});
