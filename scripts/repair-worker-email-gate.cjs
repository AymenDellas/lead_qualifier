'use strict';
const fs=require('node:fs'),path=require('node:path'),{Pool}=require('pg');
const root=path.resolve(__dirname,'..');
for(const line of fs.readFileSync(path.join(root,'.env.local'),'utf8').split('\n')){
 const match=line.replace(/\r/g,'').match(/^([^#=]+)=(.+)$/);
 if(match)process.env[match[1].trim()]=match[2].trim().replace(/^(['"])([\s\S]*)\1$/,'$2');
}
async function main(){
 const pool=new Pool({connectionString:process.env.DATABASE_URL,max:1,ssl:{rejectUnauthorized:false}});
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  // Limit the repair to actual engine research with an empty address. Keep
  // every record, its research, verification, suppression and outcome fields.
  const before=await client.query(`SELECT id,pipeline_status FROM leads WHERE prospect_assessment IS NOT NULL
   AND pipeline_status IN ('QUALIFIED','OUTREACH') AND NULLIF(trim(email),'') IS NULL FOR UPDATE`);
  const output=path.join(root,'output','worker-email-gate');fs.mkdirSync(output,{recursive:true});
  fs.writeFileSync(path.join(output,`before-${Date.now()}.json`),JSON.stringify(before.rows,null,2));
  const result=await client.query(`UPDATE leads SET pipeline_status='NOT_QUALIFIED' WHERE id=ANY($1::text[])`,[before.rows.map(row=>row.id)]);
  await client.query('COMMIT');console.log(`Moved ${result.rowCount} engine leads without email out of Qualified; all records retained.`);
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();await pool.end();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
