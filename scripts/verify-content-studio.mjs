import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudio } from '../src/lib/content-create/studio.js';
import { openDatabase, get, put, list } from '../src/lib/content-create/db.js';
import { DEFAULT_DIRECTION, postText } from '../src/lib/content-create/studio-shared.js';
import { recordingPlanText, videoCopy } from '../src/lib/content-create/video-plan.js';
import { sampleVideoPlan } from './fixtures/content-video-plan.mjs';
import { starterIdeas } from '../src/lib/content-create/starter-ideas.js';

function setup(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(),'compel-content-test-'));
  const path = join(directory,'studio.json');
  const db = openDatabase(path);
  t.after(()=>{unlinkSync(path);rmdirSync(directory);});
  const calls = [];
  const modelGenerate = async(mode,context)=>{
    calls.push({mode,context});
    if(mode==='ideas')return {output:{ideas:[0,1,2].map(index=>({topic:`Topic ${index}`,angle:`Angle ${index}`,hook:`Hook ${index}`,pillar:'principle',buyerProblem:'Unclear call expectations',whyRelevant:'Clarifies the buyer’s next decision.',searchQuery:'',sourceId:''}))}};
    return {output:{title:'A clearer next step',topic:'Call clarity',hooks:['Hook','Alternative','Another'],recommendedHook:'Hook',body:context.revisionInstruction?'A more specific revised body.':'A complete useful post body.',cta:'A natural closing question?',shortVersion:'Short body',videoPlan:context.format==='Short video script'?sampleVideoPlan(context.revisionInstruction?'A more specific revised body.':'A complete useful post body.'):null,slides:context.format==='Carousel'?Array.from({length:context.slideCount},(_,index)=>({number:index+1,role:'Lesson',copy:`Slide ${index+1}`})):[],learning:{evidenceType:'hypothesis',supportingSource:'',mechanism:'Reduces uncertainty.'},claimFlags:[],sourceNotes:['Illustrative example.']}};
  };
  const studio = createStudio({db,modelGenerate,search:async()=>[],research:async()=>{throw new Error('Source unavailable');},...overrides});
  return {db,calls,studio,modelGenerate};
}

test('one action drafts an unused bank idea in one AI request without manual material',async t=>{
  const {studio,calls,db}=setup(t);
  const {post}=await studio.draft();
  assert.deepEqual(calls.map(call=>call.mode),['draft']);
  assert.equal(calls[0].context.creativeDirection.audience,DEFAULT_DIRECTION.audience);
  assert.equal(post.status,'Drafting');
  assert.equal(post.approvedAt,null);
  assert.equal(get(db,'posts',post.id).body,'A complete useful post body.');
  assert.equal(list(db,'ideas').length,0);
  assert.equal(post.ideaId,starterIdeas[0].id);
  assert.match(calls[0].context.sourceText,/illustrative examples only/i);
});

test('saved direction and editorial choices reach future idea and draft prompts',async t=>{
  const {studio,calls}=setup(t);
  studio.saveDirection({...DEFAULT_DIRECTION,audience:'Executive coaches',tone:'Plain and direct',examples:'An example of my voice.'});
  const {post}=await studio.draft();
  studio.feedback({postId:post.id,kind:'liked'});
  const rejected=(await studio.ideas())[2];
  studio.feedback({ideaId:rejected.id,kind:'rejected',reason:'Too generic'});
  await studio.ideas();
  const context=calls.at(-1).context;
  assert.equal(context.creativeDirection.audience,'Executive coaches');
  assert.equal(context.editorialMemory.liked[0].copy,post.body);
  assert.equal(context.editorialMemory.rejected[0].reason,'Too generic');
  assert.equal(context.creativeDirection.examples,'An example of my voice.');
  assert.equal(context.editorialMemory.recentPosts[0].status,'Approved');
});

test('an unfinished fragment saves, reloads, and cannot be approved yet',t=>{
  const {studio}=setup(t);
  const fragment=studio.manual();
  const saved=studio.save(fragment.id,{body:'A promising half sentence'},fragment.updatedAt);
  assert.equal(studio.state().posts[0].body,saved.body);
  assert.equal(saved.status,'Drafting');
  assert.throws(()=>studio.feedback({postId:saved.id,kind:'liked'}),/hook/);
  assert.equal(studio.state().feedback.length,0);
});

test('editing an approved post revokes approval and prevents planning or publication',async t=>{
  const {studio}=setup(t);
  const {post}=await studio.draft();
  const approved=studio.feedback({postId:post.id,kind:'liked'});
  const edited=studio.save(post.id,{body:'Changed argument'},approved.updatedAt);
  assert.equal(edited.approvedAt,null);
  assert.throws(()=>studio.schedule(post.id,'2026-10-01'),/approval/);
  assert.throws(()=>studio.publish(post.id,'2026-10-01'),/approval/);
});

test('AI revisions preserve source, keep undo history, and contribute preferences',async t=>{
  const {studio,calls}=setup(t);
  const {post}=await studio.draft({sourceText:'An original example supplied by the user.'});
  const revised=await studio.revise(post.id,'More specific',post.updatedAt);
  assert.equal(revised.versions.length,1);
  assert.equal(revised.versions[0].body,post.body);
  assert.equal(calls.at(-1).context.sourceText,post.sourceText);
  assert.equal(calls.at(-1).context.existingDraft.body,post.body);
  const restored=studio.restore(post.id,revised.updatedAt);
  assert.equal(restored.body,post.body);
  assert.equal(restored.versions.length,0);
  assert.equal(studio.state().feedback.filter(item=>item.kind==='revision').length,0);
});

test('a failed model revision leaves the saved draft untouched',async t=>{
  const {studio,db}=setup(t);
  const {post}=await studio.draft();
  const failing=createStudio({db,modelGenerate:async()=>{throw new Error('Provider unavailable');}});
  await assert.rejects(failing.revise(post.id,'Shorter',post.updatedAt),/Provider unavailable/);
  assert.deepEqual(get(db,'posts',post.id),post);
});

test('concurrent edits are not overwritten by an older save or in-flight AI revision',async t=>{
  const {studio,db,modelGenerate}=setup(t);
  const {post}=await studio.draft();
  const edited=studio.save(post.id,{body:'Newer human edit'},post.updatedAt);
  assert.throws(()=>studio.save(post.id,{body:'Stale edit'},post.updatedAt),/another session/);
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const slow=createStudio({db,modelGenerate:async(...args)=>{await gate;return modelGenerate(...args);}});
  const pending=slow.revise(post.id,'Shorter',edited.updatedAt);
  studio.save(post.id,{body:'Edited while AI was thinking'},edited.updatedAt);
  release();
  await assert.rejects(pending,/another session/);
  assert.equal(get(db,'posts',post.id).body,'Edited while AI was thinking');
});

test('a breakdown gets fetched public evidence; failed research becomes an illustrative principle',async t=>{
  const {studio,db,calls,modelGenerate}=setup(t);
  const idea=put(db,'ideas',{pillar:'breakdown',topic:'Consultation expectations',angle:'Make the call clear',searchQuery:'coaching consultation offer',whyRelevant:'Buyer clarity'});
  const verified=createStudio({db,modelGenerate,search:async()=>['https://example.com/coaching'],research:async url=>({url,title:'A real page',text:'Book a consultation. '.repeat(20)})});
  const {post}=await verified.draft({ideaId:idea.id});
  assert.equal(post.pillar,'breakdown');
  assert.equal(post.sourceUrl,'https://example.com/coaching');
  assert.match(calls.at(-1).context.sourceText,/Fetched public page/);
  const fallback=await studio.draft({ideaId:idea.id});
  assert.equal(fallback.post.pillar,'principle');
  assert.match(fallback.post.researchNote,/could not be verified/);
  assert.equal(fallback.post.sourceUrl,'');
});

test('a supplied URL is fetched once and informs the draft without a separate idea request',async t=>{
  const {db,calls,modelGenerate}=setup(t);
  let fetched=0;
  const studio=createStudio({db,modelGenerate,research:async url=>{fetched++;return {url,text:'Specific original offer copy.'};}});
  await studio.draft({sourceUrl:'https://example.com/offer'});
  assert.equal(fetched,1);
  assert.deepEqual(calls.map(call=>call.mode),['draft']);
  assert.match(calls[0].context.sourceText,/Specific original offer copy/);
  assert.match(calls[0].context.selectedAngle.angle,/supplied material/);
});

test('carousel slide count is passed through and incomplete slides prevent approval',async t=>{
  const {studio,calls}=setup(t);
  const {post}=await studio.draft({format:'Carousel',slideCount:5});
  assert.equal(post.slides.length,5);
  assert.equal(calls.at(-1).context.slideCount,5);
  studio.save(post.id,{slides:[{role:'Hook',copy:''}]},post.updatedAt);
  assert.throws(()=>studio.feedback({postId:post.id,kind:'liked'}),/Fill each slide/);
});

test('publication is an explicit record of a manual action and dates are validated',async t=>{
  const {studio}=setup(t);
  const {post}=await studio.draft();
  studio.feedback({postId:post.id,kind:'liked'});
  assert.throws(()=>studio.publish(post.id,'2026-02-31'),/valid publication date/);
  assert.equal(studio.schedule(post.id,'2026-10-01').status,'Scheduled');
  assert.equal(studio.publish(post.id,'2026-10-01').status,'Published');
});

test('copy and preview do not duplicate hooks or CTAs in legacy drafts',()=>{
  assert.equal(postText({hook:'Opening',body:'Body',cta:'Closing'}),'Opening\n\nBody\n\nClosing');
  assert.equal(postText({hook:'Opening',body:'Opening\n\nBody\n\nClosing',cta:'Closing'}),'Opening\n\nBody\n\nClosing');
});

test('rejecting a previously liked draft updates both the preference and approval',async t=>{
  const {studio}=setup(t);
  const {post}=await studio.draft();
  studio.feedback({postId:post.id,kind:'liked'});
  const rejected=studio.feedback({postId:post.id,kind:'rejected'});
  assert.equal(rejected.approvedAt,null);
  assert.equal(rejected.status,'Drafting');
  assert.equal(studio.state().feedback.length,1);
  assert.equal(studio.state().feedback[0].kind,'rejected');
});

test('the stronger hook shortcut does not rewrite an approved body or its sources',async t=>{
  const {studio}=setup(t);
  const {post}=await studio.draft();
  const revised=await studio.revise(post.id,'Stronger hook',post.updatedAt);
  assert.equal(revised.body,post.body);
  assert.deepEqual(revised.sourceNotes,post.sourceNotes);
  assert.equal(revised.approvedAt,null);
});

test('approval applies only to the version the user reviewed',async t=>{
  const {studio}=setup(t);
  const {post}=await studio.draft();
  studio.save(post.id,{body:'A newer draft'},post.updatedAt);
  assert.throws(()=>studio.feedback({postId:post.id,kind:'liked',expectedUpdatedAt:post.updatedAt}),/another session/);
  assert.equal(studio.state().feedback.length,0);
});

test('unexpected model keys cannot overwrite another post or approve a draft',async t=>{
  const {studio,db,modelGenerate}=setup(t);
  const existing=studio.manual();
  const rogue=createStudio({db,modelGenerate:async(...args)=>{
    const result=await modelGenerate(...args);
    if(args[0]==='draft')Object.assign(result.output,{id:existing.id,status:'Published',approvedAt:'2026-09-26',sourceUrl:'https://invented.example'});
    return result;
  }});
  const {post}=await rogue.draft();
  assert.notEqual(post.id,existing.id);
  assert.equal(get(db,'posts',existing.id).body,'');
  assert.equal(post.approvedAt,null);
  assert.equal(post.sourceUrl,'');
});

test('video generation saves exact Miro objects and a script that matches its recording beats',async t=>{
  const {studio,db}=setup(t);
  const {post}=await studio.draft({format:'Short video script'});
  assert.deepEqual(videoCopy(post.videoPlan),{hook:post.hook,body:post.body,cta:post.cta});
  const saved=get(db,'posts',post.id);
  assert.equal(saved.videoPlan.frames[1].items[1].text,'Before: Book now');
  assert.equal(saved.videoPlan.frames[1].items[1].placement,'Left');
  assert.match(recordingPlanText(saved),/Frame 2: Make it clear \(10–60s, approximate\)/);
  assert.match(recordingPlanText(saved),/Explain the next step/);
  assert.match(recordingPlanText(saved),/ON SCREEN/);
  assert.doesNotMatch(postText(saved),/ON SCREEN|Recording setup/);
});

test('incomplete AI board plans cannot save or replace a video draft',async t=>{
  const {studio,db,modelGenerate}=setup(t);
  const {post}=await studio.draft({format:'Short video script'});
  for (const plan of [null,{...sampleVideoPlan(),frames:[]},{...sampleVideoPlan(),frames:sampleVideoPlan().frames.map((frame,index)=>index===1?{...frame,items:[{kind:'Sticky note',text:'',placement:'Left'}]}:frame)}]) {
    const broken=createStudio({db,modelGenerate:async(...args)=>{const result=await modelGenerate(...args);result.output.videoPlan=plan;return result;}});
    await assert.rejects(broken.revise(post.id,'More specific',post.updatedAt),/incomplete Miro/);
    assert.deepEqual(get(db,'posts',post.id),post);
  }
});

test('frame edits, hook selection and undo preserve a single spoken script',async t=>{
  const {studio}=setup(t);
  const {post}=await studio.draft({format:'Short video script'});
  const approved=studio.feedback({postId:post.id,kind:'liked'});
  const plan=structuredClone(post.videoPlan);
  plan.frames[1].script='A corrected example that I can read aloud.';
  const edited=studio.save(post.id,{videoPlan:plan,...videoCopy(plan)},approved.updatedAt);
  assert.equal(edited.body,plan.frames[1].script);
  assert.equal(edited.approvedAt,null);
  const hooked=studio.save(post.id,{hook:'A better opening'},edited.updatedAt);
  assert.equal(hooked.videoPlan.frames[0].script,'A better opening');
  assert.throws(()=>studio.save(post.id,{body:'Unpaired body edit'},hooked.updatedAt),/each frame/);
  const revised=await studio.revise(post.id,'More specific',hooked.updatedAt);
  assert.equal(revised.videoPlan.frames[1].script,revised.body);
  const restored=studio.restore(post.id,revised.updatedAt);
  assert.deepEqual(restored.videoPlan,hooked.videoPlan);
  assert.equal(restored.body,hooked.body);
});

test('stronger-hook revisions keep the Miro layout and remaining beats intact',async t=>{
  const {studio,db,modelGenerate}=setup(t);
  const {post}=await studio.draft({format:'Short video script'});
  const changing=createStudio({db,modelGenerate:async(...args)=>{const result=await modelGenerate(...args);result.output.recommendedHook='A sharper opening';result.output.videoPlan.boardLayout='A different layout';return result;}});
  const revised=await changing.revise(post.id,'Stronger hook',post.updatedAt);
  assert.equal(revised.videoPlan.frames[0].script,'A sharper opening');
  assert.equal(revised.videoPlan.boardLayout,post.videoPlan.boardLayout);
  assert.deepEqual(revised.videoPlan.frames.slice(1),post.videoPlan.frames.slice(1));
  assert.equal(revised.body,post.body);
});

test('older script-only drafts can acquire a board plan and undo back to their original',async t=>{
  const {studio,db}=setup(t);
  const older=put(db,'posts',{title:'An older video',format:'Short video script',pillar:'principle',hook:'Hook',body:'A complete useful post body.',cta:'A natural closing question?',versions:[]});
  const revised=await studio.revise(older.id,'Add a Miro recording plan',older.updatedAt);
  assert.equal(revised.videoPlan.frames.length,3);
  const restored=studio.restore(older.id,revised.updatedAt);
  assert.equal(restored.videoPlan,null);
  assert.equal(postText(restored),postText(older));
});

test('browsing the starter bank and reopening it never invokes the AI',t=>{
  const {db,calls,studio}=setup(t);
  assert.equal(studio.state().ideas.length,18);
  assert.equal(new Set(studio.state().ideas.map(idea=>idea.id)).size,18);
  const reopened=createStudio({db,modelGenerate:()=>{throw new Error('Browsing must not call AI');}});
  assert.deepEqual(reopened.state().ideas,studio.state().ideas);
  assert.equal(calls.length,0);
  assert.equal(list(db,'ideas').length,0);
});

test('all previously generated ideas remain available alongside starters after reload',t=>{
  const {db,calls}=setup(t);
  const ids=Array.from({length:8},(_,index)=>put(db,'ideas',{generatedBy:'ai',pillar:'principle',topic:`Saved topic ${index}`,hook:`Saved hook ${index}`,angle:`Saved angle ${index}`}).id);
  const reloaded=createStudio({db,modelGenerate:()=>{throw new Error('Browsing must not call AI');}}).state();
  assert.equal(reloaded.ideas.length,26);
  assert.ok(ids.every(id=>reloaded.ideas.some(idea=>idea.id===id)));
  assert.equal(calls.length,0);
});

test('explicit idea generation saves a reusable batch and does not duplicate existing angles',async t=>{
  const {studio,calls,db}=setup(t);
  const first=await studio.ideas();
  assert.deepEqual(calls.map(call=>call.mode),['ideas']);
  assert.equal(studio.state().ideas.length,21);
  assert.equal(createStudio({db}).state().ideas.length,21);
  const repeated=await studio.ideas();
  assert.deepEqual(repeated.map(idea=>idea.id),first.map(idea=>idea.id));
  assert.equal(list(db,'ideas').length,3);
});

test('rejecting an idea or draft hides its angle without spending AI credits',async t=>{
  const {studio,calls}=setup(t);
  const first=studio.state().ideas[0];
  studio.feedback({ideaId:first.id,kind:'rejected'});
  assert.equal(calls.length,0);
  assert.ok(!studio.state().ideas.some(idea=>idea.id===first.id));
  const {post}=await studio.draft();
  const count=calls.length;
  studio.feedback({postId:post.id,kind:'rejected'});
  assert.equal(calls.length,count);
  assert.ok(!studio.state().ideas.some(idea=>idea.id===post.ideaId));
});

test('automatic selection rotates unused saved ideas, while used ideas remain reusable',async t=>{
  const {studio,calls}=setup(t);
  const first=await studio.draft();
  const second=await studio.draft();
  assert.notEqual(first.post.ideaId,second.post.ideaId);
  assert.equal(studio.state().ideas.find(idea=>idea.id===first.post.ideaId).usedCount,1);
  await studio.draft({ideaId:first.post.ideaId});
  assert.equal(studio.state().ideas.find(idea=>idea.id===first.post.ideaId).usedCount,2);
  assert.deepEqual(calls.map(call=>call.mode),['draft','draft','draft']);
});

test('an exhausted bank asks for an explicit choice instead of buying another idea request',async t=>{
  const {studio,calls}=setup(t);
  for (const idea of studio.state().ideas) studio.feedback({ideaId:idea.id,kind:'rejected'});
  await assert.rejects(studio.draft(),/No AI request was made/);
  assert.equal(calls.length,0);
  assert.equal(studio.state().ideas.length,0);
});
