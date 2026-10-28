'use strict';
const store=require('./aliasmode-store.cjs'),{createAliasModeClient}=require('./aliasmode-client.cjs');
function createAliasModeProvider({pool,client,now=Date.now}={}){
 const api=client||createAliasModeClient({config:()=>store.privateConfig(pool)});let due=0,refresh=null,pending=null;
 async function refreshNow(){
  await store.ensure(pool);const row=(await pool.query('SELECT revision,refresh_requested_at::text AS token FROM compel_aliasmode_config WHERE id=1')).rows[0];
  if(now()<due&&row.token===refresh)return;due=now()+30000;refresh=row.token;
  try{await api.health();const capabilities=await api.capabilities?.()||{};const result=await api.list();await pool.query("UPDATE compel_aliasmode_config SET status=$1::jsonb,profiles=$2::jsonb,last_refreshed_at=NOW() WHERE id=1 AND revision=$3",[JSON.stringify({state:'connected',reason:'AliasMode connected. The installed helper verifies each account’s configured browser mode.',...capabilities,truncated:result.truncated,checkedAt:new Date(now()).toISOString()}),JSON.stringify(result.profiles),row.revision]);}
  catch(error){await pool.query('UPDATE compel_aliasmode_config SET status=$1::jsonb,last_refreshed_at=NOW() WHERE id=1 AND revision=$2',[JSON.stringify({state:'unavailable',code:error.code||'ALIASMODE_UNAVAILABLE',reason:error.failure?.reason||'AliasMode Local API is unavailable.',checkedAt:new Date(now()).toISOString()}),row.revision]);}
 }
 function sync(){if(!pending){pending=refreshNow().finally(()=>{pending=null;});}return pending;}
 return {client:api,sync,store,idle:async()=>{await pending;await api.idle?.();}};
}
module.exports={createAliasModeProvider};
