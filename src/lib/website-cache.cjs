'use strict';
// Bounded anonymous HTML cache; attribution is re-evaluated for each person.
const ready=new WeakMap();
const SCHEMA=`CREATE TABLE IF NOT EXISTS compel_website_cache (
 domain TEXT NOT NULL,slot INTEGER NOT NULL CHECK(slot BETWEEN 1 AND 8),url TEXT NOT NULL,final_url TEXT NOT NULL,
 html TEXT NOT NULL CHECK(octet_length(html)<=262144),observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(domain,slot),UNIQUE(domain,url));`;
async function ensure(pool){if(!ready.has(pool))ready.set(pool,pool.query(SCHEMA).catch(error=>{ready.delete(pool);throw error;}));return ready.get(pool);}
function createWebsiteCache(pool,fetchPage,{ttlSeconds=86400}={}){
 const pending=new Map();
 return async function read(value,options={}){
  const url=require('./prospect-research.cjs').publicUrl(value).href,domain=new URL(url).hostname;
  if(pending.has(url))return pending.get(url);
  const run=(async()=>{
   await ensure(pool);
   const cached=(await pool.query("SELECT html,final_url FROM compel_website_cache WHERE domain=$1 AND url=$2 AND observed_at>NOW()-$3*interval '1 second'",[domain,url,ttlSeconds])).rows[0];
   if(cached)return {url:cached.final_url,html:cached.html,cacheHit:true};
   const result=await fetchPage(url,options);
   if(typeof result.html==='string'&&Buffer.byteLength(result.html)<=262144){
    await pool.query(`WITH updated AS (
     UPDATE compel_website_cache SET html=$4,final_url=$3,observed_at=NOW() WHERE domain=$1 AND url=$2 RETURNING slot
    ), free AS (SELECT n FROM generate_series(1,8) n WHERE NOT EXISTS(
     SELECT 1 FROM compel_website_cache c WHERE c.domain=$1 AND c.slot=n) ORDER BY n LIMIT 1)
    INSERT INTO compel_website_cache(domain,slot,url,final_url,html)
     SELECT $1,n,$2,$3,$4 FROM free WHERE NOT EXISTS(SELECT 1 FROM updated) ON CONFLICT DO NOTHING`,[domain,url,result.url,result.html]);
   }
   return result;
  })();pending.set(url,run);try{return await run;}finally{pending.delete(url);}
 };
}
module.exports={SCHEMA,createWebsiteCache};
