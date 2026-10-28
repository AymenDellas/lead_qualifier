'use strict';
// Submit an explicit PostgreSQL command. The single agent retains ownership of
// the account browser; this script never creates a second CDP session/worker.
async function main(){
 if(process.env.VERCEL)throw Error('Session diagnostics run only on the local worker computer.');
 const [accountId,command='diagnostics']=process.argv.slice(2);if(!accountId)throw Error('Usage: node scripts/engine-stealth-check.cjs <account-id> [preflight|approve-identity|diagnostics]');
 require('./test-env.cjs');const {Pool}=require('pg'),pool=new Pool({connectionString:process.env.DATABASE_URL,max:1,ssl:{rejectUnauthorized:false}});
 try{await require('../src/lib/linkedin-workers.cjs').ensure(pool);await require('../src/lib/account-session-store.cjs').request(pool,accountId,command);console.log('Session diagnostic requested. Start the local agent to run it; review holds remain authoritative.');}finally{await pool.end();}
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={main};
