'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createAliasModeProvider}=require('../../src/lib/aliasmode-provider.cjs');
test('metadata sync is single-flight, revision fenced and waits on shutdown',async()=>{
 let release,health=0;const gate=new Promise(resolve=>{release=resolve;}),queries=[];
 const pool={query:async(sql,args)=>{queries.push({sql,args});if(sql.includes('to_regclass'))return {rows:[{ready:true}]};return {rows:[{revision:7,token:'refresh'}]};}};
 const client={health:async()=>{health++;await gate;},list:async()=>({profiles:[{id:'one'}],truncated:false}),idle:async()=>{}};
 const provider=createAliasModeProvider({pool,client});const a=provider.sync(),b=provider.sync();assert.equal(a,b);await new Promise(r=>setImmediate(r));assert.equal(health,1);release();await provider.idle();
 const update=queries.find(q=>q.sql.includes('SET status='));assert.match(update.sql,/revision=\$3/);assert.equal(update.args[2],7);
 await provider.sync();assert.equal(health,1,'unchanged metadata remains cached until due');
});
