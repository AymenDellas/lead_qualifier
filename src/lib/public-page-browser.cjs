'use strict';
// Public rendering uses a fresh cookie-free context. Every network response is
// fulfilled by the same DNS-pinned public HTTP reader used for static research.
const {fetchPublicPage,publicUrl}=require('./prospect-research.cjs');
function createPageRenderer(browser,{maxPages=3,fetchResource=fetchPublicPage}={}){
 let used=0,tail=Promise.resolve();const cache=new Map();
 return function render(value,options={}){
  const key=publicUrl(value).href;if(cache.has(key))return cache.get(key);
  if(used++>=maxPages)return Promise.reject(new Error('Public browser fallback budget reached.'));
  const url=publicUrl(value).href;
  const run=tail.then(async()=>{
   const deadline=Date.now()+Math.min(10000,options.timeoutMs||10000);
   const context=await browser.createBrowserContext(),controller=new AbortController();let timer;
   try{
    const page=await context.newPage();let requests=0,bytes=0,documentFailure=null;
    const userAgent=await browser.userAgent();
    timer=setTimeout(()=>{controller.abort();context.close().catch(()=>{});},Math.max(1,deadline-Date.now()));
    await page.setRequestInterception(true);
    page.on('request',async request=>{
     try{
      if(request.method()!=='GET'||!['document','script','stylesheet','xhr','fetch'].includes(request.resourceType())||++requests>60)throw new Error('Unsupported public page request.');
      publicUrl(request.url());
      const response=await fetchResource(request.url(),{resource:true,followRedirects:false,userAgent,signal:controller.signal});
      bytes+=response.body.length;if(bytes>12*1024*1024)throw new Error('Public render response budget reached.');
      const headers={};for(const k of ['content-type','location','access-control-allow-origin'])if(response.headers[k])headers[k]=response.headers[k];
      await request.respond({status:response.status,headers,body:response.body});
     }catch(error){
      if(request.resourceType()==='document'&&(!request.isNavigationRequest||request.isNavigationRequest())&&(!request.frame||request.frame()===page.mainFrame()))documentFailure=error;
      try{await request.abort('blockedbyclient');}catch{/* closed or already handled */}
     }
    });
    let navigation;
    try{navigation=await page.goto(url,{waitUntil:'domcontentloaded',timeout:Math.max(1,deadline-Date.now())});}
    catch(error){throw documentFailure||error;}
    if(documentFailure)throw documentFailure;
    if(navigation?.status()>=400)throw Object.assign(new Error('Website returned HTTP '+navigation.status()+'.'),{httpStatus:navigation.status()});
    try{await page.waitForNetworkIdle({idleTime:250,timeout:Math.max(1,Math.min(2500,deadline-Date.now()))});}catch{/* DOM evidence still inspected */}
    // This is a known local popup control, not an arbitrary form submission.
    const openedContact=await page.evaluate(()=>{
     const contact=[...document.querySelectorAll('a[href]')].find(a=>/^javascript:WebPlatform\.Popups\.show\(\d+\);?$/i.test(a.getAttribute('href')||'')&&/^contact$/i.test(a.textContent.trim()));
     if(contact){contact.click();return true;}return false;
    });
    if(openedContact)try{await page.waitForNetworkIdle({idleTime:250,timeout:Math.max(1,Math.min(2500,deadline-Date.now()))});}catch{/* inspect any contact content that loaded */}
    const html=await page.evaluate(()=>{
     const clone=document.documentElement.cloneNode(true),original=[...document.querySelectorAll('a[href]')],copied=[...clone.querySelectorAll('a[href]')];
     copied.forEach((a,i)=>a.setAttribute('href',original[i].href));
     clone.querySelectorAll('script,style,noscript,template').forEach(n=>n.remove());
     return clone.outerHTML;
    });
    if(Buffer.byteLength(html)>4*1024*1024)throw new Error('Rendered page exceeded the research size limit.');
    return {url:page.url(),html,rendered:true};
   }finally{clearTimeout(timer);controller.abort();await context.close().catch(()=>{});}
  });
  tail=run.catch(()=>{});cache.set(key,run);return run;
 };
}
module.exports={createPageRenderer};
