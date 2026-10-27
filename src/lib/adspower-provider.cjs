'use strict';
const store=require('./adspower-store.cjs'),{createAdsPowerClient}=require('./adspower-client.cjs');
function createAdsPowerProvider({pool,client,now=Date.now}={}){
 const api=client||createAdsPowerClient({config:()=>store.privateConfig(pool)});let due=0,refresh=null;
 async function sync(){
  await store.ensure(pool);const row=(await pool.query('SELECT refresh_requested_at::text AS token FROM compel_adspower_config WHERE id=1')).rows[0];
  if(now()<due&&row.token===refresh)return;due=now()+30000;refresh=row.token;
  try{await api.health();const result=await api.list();await pool.query("UPDATE compel_adspower_config SET status=$1::jsonb,profiles=$2::jsonb,last_refreshed_at=NOW() WHERE id=1",[JSON.stringify({state:'connected',reason:'AdsPower Local API connected.',truncated:result.truncated,checkedAt:new Date(now()).toISOString()}),JSON.stringify(result.profiles)]);}
  catch(error){await pool.query('UPDATE compel_adspower_config SET status=$1::jsonb,last_refreshed_at=NOW() WHERE id=1',[JSON.stringify({state:'unavailable',code:error.code||'ADSPOWER_UNAVAILABLE',reason:error.failure?.reason||'AdsPower Local API is unavailable.',checkedAt:new Date(now()).toISOString()})]);}
 }
 return {client:api,sync,store};
}
module.exports={createAdsPowerProvider};
