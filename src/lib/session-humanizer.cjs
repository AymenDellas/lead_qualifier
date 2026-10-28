'use strict';
const {randomInt}=require('node:crypto');
const {profileUrl}=require('./linkedin-workers.cjs');
async function interact(page,{assertActive=async()=>{},random=randomInt}={}){
 await assertActive();
 if(!/^https:\/\/www\.linkedin\.com\/(?:feed|in\/)/.test(page.url()))return;
 // Only scrolling and pointer movement. Never target links/buttons, submit a
 // form, react, follow, connect, or send a message as incidental "humanization".
 const point=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
 const x=random(40,Math.max(41,Math.min(point.width-40,1100))),y=random(80,Math.max(81,Math.min(point.height-40,700)));
 await assertActive();await page.mouse?.move(x,y,{steps:random(3,9)});
 await assertActive();const distance=random(120,421);
 // A background/occluded page need not schedule an animation frame. Scrolling
 // is synchronous here; subsequent page inspection observes the rendered DOM.
 await page.evaluate(dy=>{scrollBy({top:dy,behavior:'instant'});},distance);
 await assertActive();
}
async function visit(page,url,{assertActive=async()=>{}}={}){
 const canonical=profileUrl(url);if(!canonical)throw Error('Rendered session visit requires a canonical person profile.');
 await assertActive();const response=await page.goto(canonical,{waitUntil:'domcontentloaded',timeout:20000});await assertActive();return response;
}
module.exports={interact,visit};
