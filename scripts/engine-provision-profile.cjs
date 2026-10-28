'use strict';
async function main(){
 if(process.env.VERCEL)throw Error('Provision profiles only on the local worker computer.');
 const [name,engine='aliasmode-chromium']=process.argv.slice(2);if(!name)throw Error('Usage: node scripts/engine-provision-profile.cjs "Expected member name" [aliasmode-chromium|cloakbrowser]');
 require('./test-env.cjs');const {Pool}=require('pg'),pool=new Pool({connectionString:process.env.DATABASE_URL,max:1,ssl:{rejectUnauthorized:false}});
 const core=require('../src/lib/linkedin-workers.cjs'),store=require('../src/lib/aliasmode-store.cjs');let client;
 try{await core.ensure(pool);client=require('../src/lib/aliasmode-client.cjs').createAliasModeClient({config:()=>store.privateConfig(pool)});
  const created=await client.createProfile({name,engine});
  // Publish the safe receipt before the DB handoff. A failed import must not
  // trigger another vendor create or silently delete a partially provisioned profile.
  console.log(JSON.stringify({profileId:created.id,engine,created:true}));
  const id=await store.importProfile(pool,{profileId:created.id,name,expectedMemberName:name});
  await pool.query('UPDATE compel_linkedin_accounts SET engine=$2 WHERE id=$1',[id,engine]);
  console.log(JSON.stringify({accountId:id,paused:true,next:'Configure its proxy in AliasMode, then save and verify the binding in CompelOS.'}));
 }finally{await client?.idle();await pool.end();}
}
if(require.main===module)main().catch(error=>{console.error(error.failure?.reason||error.message);process.exitCode=1;});
module.exports={main};
