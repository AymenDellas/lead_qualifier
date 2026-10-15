'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {signOut}=require('../../src/lib/linkedin-signout.cjs');
function fixture({logoutUnavailable=false,stillAuthenticated=false,feedAccessible=false}={}) {
 let cookies=[{name:'li_at',domain:'.linkedin.com'},{name:'JSESSIONID',domain:'.linkedin.com'},{name:'other',domain:'example.test'}];
 const visited=[],deleted=[];
 const browser={newPage:async()=>({goto:async url=>{visited.push(url);if(logoutUnavailable&&url.includes('/m/logout/'))throw new Error('network');},url:()=>feedAccessible?'https://www.linkedin.com/feed/':'https://www.linkedin.com/login?fromSignIn=true'}),
  cookies:async()=>cookies,deleteCookie:async(...values)=>{deleted.push(...values);if(!stillAuthenticated)cookies=cookies.filter(cookie=>!values.includes(cookie));}};
 return {browser,visited,deleted,getCookies:()=>cookies};
}
test('sign-out removes only this browser’s LinkedIn cookies and confirms the login redirect',async()=>{
 const f=fixture();await signOut(f.browser);
 assert.deepEqual(f.deleted.map(c=>c.name),['li_at','JSESSIONID']);
 assert.deepEqual(f.getCookies(),[{name:'other',domain:'example.test'}]);
 assert.equal(f.visited.length,2);
});
test('sign-out still clears a local session if the remote logout page is unavailable',async()=>{
 const f=fixture({logoutUnavailable:true});await signOut(f.browser);assert.equal(f.getCookies().length,1);
});
test('sign-out cannot report success with an authentication cookie or authenticated feed',async()=>{
 await assert.rejects(signOut(fixture({stillAuthenticated:true}).browser),/authentication cookie/);
 await assert.rejects(signOut(fixture({feedAccessible:true}).browser),/did not confirm/);
});
