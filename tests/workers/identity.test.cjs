'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {identityFromMe,cleanIdentity}=require('../../src/lib/linkedin-session-identity.cjs');
const mini={firstName:'Ava',lastName:'Morgan',publicIdentifier:'Ava-Morgan',entityUrn:'urn:li:fs_miniProfile:memberA'};
test('signed-in identity comes from the current member, independently of saved login email',()=>{
 const identity=identityFromMe({miniProfile:mini});
 assert.equal(identity.name,'Ava Morgan');assert.equal(identity.profileUrl,'https://www.linkedin.com/in/ava-morgan/');
 assert.equal(identity.memberUrn,mini.entityUrn);assert.ok(identity.checkedAt);
});
test('normalized me responses resolve only the referenced member, never other included people',()=>{
 const identity=identityFromMe({data:{'*miniProfile':mini.entityUrn},included:[{...mini,firstName:'Other',entityUrn:'urn:li:fs_miniProfile:other'},mini]});
 assert.equal(identity.name,'Ava Morgan');
 assert.equal(identityFromMe({data:{},included:[mini]}),null);
 assert.equal(identityFromMe({data:{'*miniProfile':'urn:li:fs_miniProfile:missing'},included:[mini]}),null);
});
test('profile links and names are sanitized; incomplete identity is not guessed from a label or email',()=>{
 assert.equal(identityFromMe({email:'configured@example.test',label:'Account 1'}),null);
 assert.equal(cleanIdentity({name:'Ava',profileUrl:'https://attacker.test/in/ava/'}),null);
 assert.equal(cleanIdentity({name:'Ava',profileUrl:'javascript:alert(1)'}),null);
 assert.equal(cleanIdentity({name:'Ava',profileUrl:'https://user:password@www.linkedin.com/in/ava/'}),null);
 assert.equal(cleanIdentity({...mini,name:' Ava\n Morgan ',profileUrl:'https://www.linkedin.com/in/ava/?trk=test'}).name,'Ava Morgan');
 assert.equal(identityFromMe({miniProfile:{firstName:'Ava'}}),null);
});
