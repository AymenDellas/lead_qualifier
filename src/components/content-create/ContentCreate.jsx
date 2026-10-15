'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, ChevronDown, Copy, Download, FileText, Loader2, MessageSquare, Monitor, Plus, RefreshCw, Settings2, Sparkles, ThumbsDown, ThumbsUp, Undo2, X } from 'lucide-react';
import { loadContentStudio, saveContentDirection, generateMoreContentIdeas, generateContentPost, saveContentPost, reviseContentPost, recordContentFeedback, restoreContentVersion, markContentPublished, scheduleContentPost, startContentFragment } from '@/app/actions/content-create-actions';
import { DEFAULT_DIRECTION, FORMATS, draftSnapshot, postText } from '@/lib/content-create/studio-shared';
import { PILLARS, today, addDays } from './api';
import { downloadSlide } from './slide-export';
import VideoRecordingPlan from './VideoRecordingPlan';
import Teleprompter from './Teleprompter';
import IdeaBank from './IdeaBank';
import { naturalVideoRevision, recordingPlanText, syncVideoEdges } from '@/lib/content-create/video-plan';
import './studio.css';

const INITIAL = {posts:[],ideas:[],feedback:[],direction:DEFAULT_DIRECTION,directionSaved:false,ai:{configured:false}};
const QUICK_EDITS = ['Stronger hook', 'More specific', 'Less formal', 'Shorter'];
const DIRECTION_FIELDS = [
  ['audience','Who should want to read your posts?','For example: executive coaches selling to founders.'],
  ['offer','What do you help them with?','Your offer, in plain language.'],
  ['topics','What should you become known for?','The problems and subjects you want to own.'],
  ['beliefs','What do you believe?','Your opinions, principles, and things you disagree with.'],
  ['tone','How should the writing sound?','Your voice, plus words or habits to avoid.'],
  ['cta','What should readers do next?','The kind of conversation or action you want to encourage.'],
  ['examples','Posts you like (optional)','Paste examples of your voice. The AI uses the style, not their personal claims.'],
];
async function unwrap(promise) {
  const result = await promise;
  if (result.error) throw new Error(result.error);
  return result.data;
}
function Field({label,children,hint}) {
  return <label className="block min-w-0"><span className="field-label">{label}</span>{children}{hint&&<span className="field-hint block">{hint}</span>}</label>;
}

export default function ContentCreate() {
  const [state,setState] = useState(INITIAL);
  const [loading,setLoading] = useState(true);
  const [view,setView] = useState('studio');
  const [direction,setDirection] = useState(DEFAULT_DIRECTION);
  const [post,setPost] = useState(null);
  const [format,setFormat] = useState('Text post');
  const [slideCount,setSlideCount] = useState(7);
  const [showIdeas,setShowIdeas] = useState(true);
  const [busy,setBusy] = useState('');
  const [elapsed,setElapsed] = useState(0);
  const [notice,setNotice] = useState('');
  const [error,setError] = useState('');
  const [saveState,setSaveState] = useState('Saved');
  const [editing,setEditing] = useState(false);
  const [teleprompterOpen,setTeleprompterOpen] = useState(false);
  const [instruction,setInstruction] = useState('');
  const [slideIndex,setSlideIndex] = useState(0);
  const [sourceUrl,setSourceUrl] = useState('');
  const [sourceText,setSourceText] = useState('');
  const [imageDataUrl,setImageDataUrl] = useState(null);
  const [imageName,setImageName] = useState('');
  const [plannedDate,setPlannedDate] = useState(addDays(today(),1));
  const [publishedDate,setPublishedDate] = useState(today());
  const [publishReview,setPublishReview] = useState(false);
  const current = useRef(null);
  const editSequence = useRef(0);
  const savedSequence = useRef(0);
  const saveQueue = useRef(Promise.resolve());
  const saveTimer = useRef(null);
  const mounted = useRef(true);
  const operation = useRef(false);

  const refresh = useCallback(async()=>{
    const result = await unwrap(loadContentStudio());
    if (mounted.current) setState(result);
    return result;
  },[]);
  useEffect(()=>{
    mounted.current = true;
    refresh().then(result=>{
      if (!mounted.current) return;
      setDirection(result.direction);
    }).catch(e=>setError(e.message)).finally(()=>setLoading(false));
    return ()=>{mounted.current=false;};
  },[refresh]);
  useEffect(()=>{
    if (!busy) {setElapsed(0);return;}
    const start = Date.now();
    const timer = setInterval(()=>setElapsed(Math.floor((Date.now()-start)/1000)),1000);
    return ()=>clearInterval(timer);
  },[busy]);

  const choosePost = saved => {
    // Old drafts sometimes stored the opening and CTA in body as well. Split
    // them before editing, so choosing a new hook doesn't leave the old one.
    let body = String(saved.body || '').trim();
    const hook = saved.hook || saved.recommendedHook || '';
    if (hook && body.startsWith(hook)) body = body.slice(hook.length).trim();
    if (saved.cta && body.endsWith(saved.cta)) body = body.slice(0,-saved.cta.length).trim();
    saved = {...saved,hook,body};
    clearTimeout(saveTimer.current);
    current.current = saved;
    editSequence.current = 0;
    savedSequence.current = 0;
    setPost(saved);
    setFormat(saved.format || 'Text post');
    setSlideIndex(0);
    setEditing(false);
    setPublishReview(false);
    setInstruction('');
    setShowIdeas(false);
    setSaveState('Saved');
    setPlannedDate(saved.plannedDate||addDays(today(),1));
    setView('studio');
  };
  const persist = useCallback(()=>{
    clearTimeout(saveTimer.current);
    const target = current.current;
    const sequence = editSequence.current;
    if (!target || sequence===savedSequence.current) return saveQueue.current;
    const patch = draftSnapshot(target);
    const work = async()=>{
      if (mounted.current) setSaveState('Saving…');
      const expected = current.current?.id===target.id ? current.current.updatedAt : target.updatedAt;
      const saved = await unwrap(saveContentPost(target.id,patch,expected));
      if (current.current?.id===target.id) {
        current.current = {...current.current,updatedAt:saved.updatedAt};
        savedSequence.current = sequence;
        if (mounted.current) {
          setPost(previous=>({...previous,updatedAt:saved.updatedAt}));
          setSaveState(sequence===editSequence.current?'Saved':'Unsaved changes');
        }
      }
      if (mounted.current) setState(previous=>({...previous,posts:previous.posts.map(item=>item.id===saved.id?saved:item)}));
      return saved;
    };
    const promise = saveQueue.current.catch(()=>{}).then(work);
    saveQueue.current = promise;
    promise.catch(e=>{if(mounted.current){setSaveState('Save failed');setError(e.message);}});
    return promise;
  },[]);
  useEffect(()=>()=>{clearTimeout(saveTimer.current);persist().catch(()=>{});},[persist]);
  useEffect(()=>{
    const warn = event=>{if(editSequence.current!==savedSequence.current){event.preventDefault();event.returnValue='';}};
    window.addEventListener('beforeunload',warn);
    return ()=>window.removeEventListener('beforeunload',warn);
  },[]);
  const update = patch => {
    const next = {...current.current,...patch,approvedAt:null,status:'Drafting'};
    if (next.videoPlan) next.videoPlan = syncVideoEdges(next.videoPlan,next);
    current.current = next;
    editSequence.current += 1;
    setPost(next);
    setSaveState('Unsaved changes');
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(()=>persist().catch(()=>{}),700);
  };
  const run = async(label,work)=>{
    if (operation.current) return;
    operation.current = true;
    setBusy(label);setError('');setNotice('');
    try {await persist();await work();}
    catch(e){setError(e.message);}
    finally{operation.current=false;if(mounted.current)setBusy('');}
  };
  const generatePost = ideaId => run('Writing your post',async()=>{
    const result = await unwrap(generateContentPost({ideaId,format,slideCount,sourceUrl,sourceText,imageDataUrl}));
    choosePost(result.post);await refresh();setNotice('Your draft is ready and saved.');
  });
  const exploreIdeas = () => {setShowIdeas(true);setView('studio');};
  const generateMoreIdeas = () => run('Generating three new ideas',async()=>{
    await unwrap(generateMoreContentIdeas());
    await refresh();setShowIdeas(true);setView('studio');
    setNotice('Your ideas are saved in the bank. You can browse them again without using AI credits.');
  });
  const revise = text => run('Reworking your draft',async()=>{
    choosePost(await unwrap(reviseContentPost(current.current.id,text,current.current.updatedAt)));
    await refresh();setNotice('New version saved. You can undo this revision.');
  });
  const approve = () => run('Saving your preference',async()=>{
    choosePost(await unwrap(recordContentFeedback({postId:current.current.id,kind:'liked',expectedUpdatedAt:current.current.updatedAt})));
    await refresh();setNotice('Approved. This version will help shape future drafts.');
  });
  const reject = idea => run('Saving your preference',async()=>{
    const saved = await unwrap(recordContentFeedback(idea?{ideaId:idea.id,kind:'rejected'}:{postId:current.current.id,kind:'rejected',expectedUpdatedAt:current.current.updatedAt}));
    if (!idea) choosePost(saved);
    await refresh();setShowIdeas(true);
    setNotice(idea?'Idea hidden from your bank. No AI credits used.':'Preference saved. Choose another saved idea below; your draft is still saved.');
  });
  const copyPost = () => run('Preparing your post',async()=>{
    await navigator.clipboard.writeText(postText(current.current));
    setNotice(current.current.format==='Carousel'?'Caption copied. Download the slides below.':current.current.format==='Short video script'?'Spoken script copied. Ready to rehearse.':'Post copied. Ready to paste into LinkedIn.');
  });
  const copyVideoText = (text,message) => run('Preparing your recording notes',async()=>{
    await navigator.clipboard.writeText(text);
    setNotice(message);
  });
  const copyRecordingPlan = () => run('Preparing your recording plan',async()=>{
    await navigator.clipboard.writeText(recordingPlanText(current.current));
    setNotice('Recording plan copied: image-generation prompt, setup, exact visual text, script, and presenter cues.');
  });
  const changeView = next => run('Saving your work',async()=>{if(next==='saved')await refresh();setView(next);});
  const readImage = file => {
    if(!file)return;
    if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>7_000_000){setError('Choose a PNG, JPG, or WebP under 7 MB.');return;}
    const reader = new FileReader();
    reader.onload=()=>{setImageDataUrl(reader.result);setImageName(file.name);};
    reader.onerror=()=>setError('The screenshot could not be read. Try another file.');
    reader.readAsDataURL(file);
  };
  const slide = post?.slides?.[slideIndex];
  const flags = post?.claimFlags || [];
  const canApprove = Boolean(post?.hook?.trim()&&post?.body?.trim()&&(post.format!=='Carousel'||post.slides?.length&&post.slides.every(item=>item.copy?.trim())));
  const likes = state.feedback.filter(item=>item.kind==='liked').length;
  const revisions = state.feedback.filter(item=>item.kind==='revision').length;

  if(loading)return <div className="panel panel-body flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin"/>Opening your content studio…</div>;
  return <div className="content-studio space-y-5" aria-busy={Boolean(busy)}>
    <div className="studio-navigation"><div className="tabs" role="tablist" aria-label="Content studio">{[['studio','Studio'],['saved',`Saved posts (${state.posts.length})`],['direction','Your direction']].map(([key,label])=><button key={key} role="tab" aria-selected={view===key} disabled={Boolean(busy)} className={`tab ${view===key?'tab-active':''}`} onClick={()=>changeView(key)}>{key==='direction'&&<Settings2 className="h-3.5 w-3.5"/>}{label}</button>)}</div><span className="studio-quiet-status"><span className={`studio-status-dot ${state.ai.configured?'is-connected':''}`}/>{state.ai.configured?'Ready to create':'AI unavailable'}</span></div>
    {error&&<div className="studio-message is-error" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={()=>setError('')}><X className="h-4 w-4"/></button></div>}
    {notice&&<div className="studio-message" role="status"><span>{notice}</span><button aria-label="Dismiss notice" onClick={()=>setNotice('')}><X className="h-4 w-4"/></button></div>}
    {busy&&<div className="studio-progress" role="status"><Loader2 className="h-4 w-4 animate-spin"/><span>{busy}…{elapsed>=10&&<small> {elapsed}s · You can keep this page open while the AI finishes.</small>}</span></div>}

    {view==='direction'&&<section className="panel overflow-hidden"><div className="panel-body studio-direction-intro"><span className="label-micro">SET ONCE. USE EVERY TIME.</span><h2>Your taste is the brief.</h2><p>Tell the AI who you want to reach and how you want to sound. New AI ideas and every draft follow this direction.</p>{!state.directionSaved&&<p className="field-hint">We’ve filled in a starting direction for Compel. Adjust anything that doesn’t fit.</p>}</div><form className="panel-body border-t border-[var(--line)]" onSubmit={event=>{event.preventDefault();run('Saving your direction',async()=>{const saved=await unwrap(saveContentDirection(direction));setDirection(saved);await refresh();setView('studio');setNotice('Direction saved. Your next ideas and drafts will use it.');});}}><fieldset disabled={Boolean(busy)} className="grid gap-5 md:grid-cols-2">{DIRECTION_FIELDS.map(([key,label,hint])=><div key={key} className={key==='examples'?'md:col-span-2':''}><Field label={label} hint={hint}><textarea className={`field w-full resize-y ${key==='examples'?'min-h-40':'min-h-24'}`} required={key==='audience'||key==='offer'} maxLength={key==='examples'?10000:2000} value={direction[key]} onChange={event=>setDirection(previous=>({...previous,[key]:event.target.value}))}/></Field></div>)}<div className="flex flex-wrap items-center gap-3 md:col-span-2"><button type="submit" className="btn btn-primary"><Check className="h-4 w-4"/>Save direction</button><span className="field-hint">{likes} approved drafts · {revisions} revision preferences</span></div></fieldset></form></section>}

    {view==='saved'&&<section className="panel overflow-hidden"><div className="panel-head">Your content library<span className="hint">AI drafts and fragments are saved here</span></div>{state.posts.length?<div>{state.posts.map(saved=><button key={saved.id} disabled={Boolean(busy)} className="studio-saved-row" onClick={()=>run('Opening your draft',async()=>choosePost(saved))}><span className="studio-saved-icon"><FileText className="h-5 w-5"/></span><span className="min-w-0 flex-1"><strong>{saved.title||'Untitled draft'}</strong><small>{saved.format} · {PILLARS[saved.pillar]?.label} · {new Date(saved.updatedAt).toLocaleDateString()}</small></span><span className={`mark ${saved.approvedAt?'mark-ok':'mark-idle'}`}>{saved.status==='Drafting'?'Draft':saved.status}</span><ArrowRight className="h-4 w-4 shrink-0"/></button>)}</div>:<div className="panel-body studio-empty-library"><FileText className="h-7 w-7"/><h3>Your first post starts in Studio.</h3><p>Generate a draft and it will be saved here automatically.</p><button className="btn btn-outline" onClick={()=>setView('studio')}>Go to Studio<ArrowRight className="h-4 w-4"/></button></div>}</section>}

    {view==='studio'&&<>
      <section className={`panel studio-hero ${post?'has-draft':''}`}><div className="studio-hero-copy"><span className="label-micro"><Sparkles className="h-3.5 w-3.5"/> COMPEL CONTENT STUDIO</span><h2>{post?'Keep the ideas coming.':'Your next post, handled.'}</h2><p>{post?'A fresh angle whenever you need one. Your current draft stays saved.':'An idea worth sharing. A draft in your voice. You make the call.'}</p><div className="studio-generate-controls"><label className="studio-format"><span className="sr-only">Format for your next post</span><select disabled={Boolean(busy)} value={format} onChange={event=>setFormat(event.target.value)}>{FORMATS.map(value=><option key={value}>{value}</option>)}</select><ChevronDown className="h-3.5 w-3.5"/></label>{format==='Carousel'&&<select className="field" aria-label="Number of slides" disabled={Boolean(busy)} value={slideCount} onChange={event=>setSlideCount(Number(event.target.value))}>{[5,6,7,8,9,10].map(number=><option key={number} value={number}>{number} slides</option>)}</select>}<button className={`btn ${post?'btn-outline':'btn-primary'}`} disabled={Boolean(busy)||!state.ai.configured} onClick={()=>generatePost()}><Sparkles className="h-4 w-4"/>{post?'Generate another post':'Generate today’s post'}</button><button className="btn btn-ghost" disabled={Boolean(busy)} onClick={exploreIdeas}>Explore ideas<ArrowRight className="h-4 w-4"/></button></div>{format==='Short video script'&&<p className="field-hint mt-3">Includes a prompt for finished board images, plus your script and recording cues.</p>}<p className="field-hint mt-3">Explore saved ideas for free. Generate a post to turn one into a draft with AI.</p>{!state.ai.configured&&<p className="field-hint">Connect the Create AI provider in the dashboard environment to generate posts. You can still save a fragment below.</p>}</div>{!post&&<div className="studio-direction-summary"><span className="label-micro">YOUR CURRENT DIRECTION</span><strong>{state.direction.audience}</strong><p>{state.direction.topics}</p><button disabled={Boolean(busy)} onClick={()=>setView('direction')}>{state.directionSaved?'Fine-tune your direction':'Make it yours'}<ArrowRight className="h-3.5 w-3.5"/></button></div>}</section>
      <details className="studio-material"><summary>Have something specific in mind? <span>Optional source or example</span></summary><fieldset disabled={Boolean(busy)} className="studio-material-fields"><Field label="Public page URL"><input className="field w-full" type="url" value={sourceUrl} onChange={event=>setSourceUrl(event.target.value)} placeholder="https://…"/></Field><Field label="An idea, notes, or original copy"><textarea className="field min-h-24 w-full" value={sourceText} maxLength={14000} onChange={event=>setSourceText(event.target.value)} placeholder="Only if you want to steer the next draft…"/></Field><Field label="Screenshot"><input className="field w-full" type="file" accept="image/png,image/jpeg,image/webp" onChange={event=>readImage(event.target.files?.[0])}/></Field>{imageName&&<button className="btn btn-ghost" onClick={()=>{setImageDataUrl(null);setImageName('');}}>Remove {imageName}<X className="h-3 w-3"/></button>}<p className="field-hint">Used for your next generated post. Leave everything empty to use an unused idea from your bank.</p>{(sourceUrl||sourceText||imageName)&&<button className="btn btn-ghost" onClick={()=>{setSourceUrl('');setSourceText('');setImageDataUrl(null);setImageName('');}}>Clear source</button>}</fieldset></details>
      {showIdeas&&<IdeaBank ideas={state.ideas} busy={Boolean(busy)} aiConfigured={state.ai.configured} onWrite={generatePost} onReject={reject} onGenerate={generateMoreIdeas} onHide={()=>setShowIdeas(false)}/>}

      {post?<div className="studio-workspace"><section className="panel studio-draft"><div className="studio-draft-header"><div><span className="label-micro">{post.format==='Carousel'?'YOUR CAROUSEL':post.format==='Short video script'?'YOUR VIDEO SCRIPT':'YOUR NEXT POST'}</span><h3>{post.title||'Untitled draft'}</h3></div><span className="studio-save-state" role="status">{saveState==='Saved'?<Check className="h-3.5 w-3.5"/>:saveState==='Saving…'?<Loader2 className="h-3.5 w-3.5 animate-spin"/>:null}{saveState}{saveState==='Save failed'&&<button onClick={()=>persist().catch(()=>{})}>Retry</button>}</span></div><div className="studio-draft-toolbar"><div className="seg"><button className={`seg-item ${!editing?'seg-item-active':''}`} onClick={()=>setEditing(false)}>Preview</button><button className={`seg-item ${editing?'seg-item-active':''}`} onClick={()=>setEditing(true)}>{post.videoPlan?'Edit script & board':'Edit copy'}</button></div><span className="studio-word-count">{postText(post).split(/\s+/).filter(Boolean).length} words · {postText(post).length} characters</span></div>
        {post.format==='Short video script'&&post.videoPlan?<VideoRecordingPlan key={post.id} post={post} editing={editing} busy={Boolean(busy)} onUpdate={update} onCopy={copyVideoText}/>:editing?<fieldset disabled={Boolean(busy)} className="studio-editor"><Field label="Working title"><input className="field w-full" value={post.title||''} onChange={event=>update({title:event.target.value})}/></Field><Field label="Opening hook"><textarea className="field min-h-20 w-full" value={post.hook||''} onChange={event=>update({hook:event.target.value})}/></Field><Field label={post.format==='Carousel'?'Caption body':post.format==='Short video script'?'Script body':'Post body'}><textarea className="field min-h-80 w-full resize-y" value={post.body||''} onChange={event=>update({body:event.target.value})}/></Field><Field label="Closing line / CTA"><textarea className="field min-h-20 w-full" value={post.cta||''} onChange={event=>update({cta:event.target.value})}/></Field></fieldset>:<div className="studio-post-preview"><div className="studio-author"><span>C</span><div><strong>Compel</strong><small>{post.format==='Short video script'?'Spoken script preview':'LinkedIn post preview'}</small></div><span className="studio-preview-label">Unpublished</span></div><div className="studio-post-copy">{postText(post)||<span className="text-[var(--text-faint)]">Your words go here. Open Edit copy to save a thought.</span>}</div></div>}
        {post.format==='Short video script'&&!post.videoPlan&&<div className="studio-video-upgrade"><div><strong>Give this script a Miro board.</strong><p>Get the exact board text, layout, and recording cues for each part.</p></div><button className="btn btn-outline" disabled={Boolean(busy)||!state.ai.configured} onClick={()=>revise('Add a Miro recording plan to this script. Preserve the spoken words, splitting the middle into visual beats.')}><Sparkles className="h-4 w-4"/>Add Miro recording plan</button></div>}
        {post.format==='Carousel'&&<div className="studio-carousel"><div className="studio-section-label"><strong>Slide {post.slides?.length?slideIndex+1:0} of {post.slides?.length||0}</strong><button disabled={Boolean(busy)||(post.slides?.length||0)>=15} className="btn btn-ghost" onClick={()=>{const slides=[...(post.slides||[]),{number:(post.slides?.length||0)+1,role:'New slide',copy:''}];update({slides});setSlideIndex(slides.length-1);}}><Plus className="h-3.5 w-3.5"/>Add slide</button></div>{slide&&<><div className="studio-slide-preview"><div><span>COMPEL / FUNNEL NOTES</span><span>{String(slideIndex+1).padStart(2,'0')}</span></div><span className="studio-slide-role">{slide.role}</span><p>{slide.copy||'Add slide copy below.'}</p><small>{slideIndex===0?'Swipe to explore →':'One clear idea. One useful next step.'}</small></div><div className="studio-slide-controls"><div className="flex flex-wrap gap-1">{post.slides.map((item,index)=><button key={index} aria-label={`Show slide ${index+1}`} aria-pressed={index===slideIndex} className={index===slideIndex?'is-selected':''} onClick={()=>setSlideIndex(index)}>{index+1}</button>)}</div><button className="btn btn-outline" disabled={!slide.copy?.trim()} onClick={()=>downloadSlide(slide,slideIndex,post.slides.length).catch(e=>setError(e.message))}><Download className="h-4 w-4"/>PNG</button></div><details><summary>Edit this slide</summary><fieldset disabled={Boolean(busy)} className="mt-3 space-y-3"><Field label="Slide role"><input className="field w-full" value={slide.role||''} onChange={event=>update({slides:post.slides.map((item,index)=>index===slideIndex?{...item,role:event.target.value}:item)})}/></Field><Field label="Slide copy"><textarea className="field min-h-28 w-full" value={slide.copy||''} onChange={event=>update({slides:post.slides.map((item,index)=>index===slideIndex?{...item,copy:event.target.value}:item)})}/></Field><button className="btn btn-ghost" onClick={()=>{update({slides:post.slides.filter((_,index)=>index!==slideIndex)});setSlideIndex(Math.max(0,slideIndex-1));}}>Remove slide</button></fieldset></details></>}</div>}
        <div className="studio-draft-footer">{post.format==='Short video script'&&<button className="btn btn-outline" disabled={Boolean(busy)||!postText(post)} onClick={()=>run('Opening teleprompter',async()=>setTeleprompterOpen(true))}><Monitor className="h-4 w-4"/>Teleprompter</button>}<button className="btn btn-primary" disabled={Boolean(busy)||!postText(post)} onClick={copyPost}><Copy className="h-4 w-4"/>{post.format==='Carousel'?'Copy caption':post.format==='Short video script'?'Copy script':'Copy post'}</button>{post.videoPlan&&<button className="btn btn-outline" disabled={Boolean(busy)} onClick={copyRecordingPlan}><Copy className="h-4 w-4"/>Copy recording plan</button>}<button className="btn btn-outline" disabled={Boolean(busy)||!canApprove||Boolean(post.approvedAt)} onClick={approve}>{post.approvedAt?<Check className="h-4 w-4"/>:<ThumbsUp className="h-4 w-4"/>}{post.approvedAt?'Approved':'This works'}</button><button className="btn btn-ghost" disabled={Boolean(busy)} onClick={()=>reject()}><ThumbsDown className="h-4 w-4"/>Different direction</button></div><div className="studio-publish-note"><span>{post.status==='Published'?`Marked published · ${post.publishedDate}`:post.status==='Scheduled'?`Planned for ${post.plannedDate} · publish manually`:post.format==='Short video script'?'Paste your generated images into Miro, record your walkthrough, and publish your video.':'Copy it when you’re happy. You publish it yourself.'}</span>{post.approvedAt&&post.status!=='Published'&&<button disabled={Boolean(busy)} onClick={()=>setPublishReview(!publishReview)}>Mark as published</button>}</div>{publishReview&&<div className="studio-publish-form"><Field label="Actual publication date"><input className="field" type="date" value={publishedDate} onChange={event=>setPublishedDate(event.target.value)}/></Field><button className="btn btn-outline" disabled={Boolean(busy)||!publishedDate} onClick={()=>run('Updating your library',async()=>{choosePost(await unwrap(markContentPublished(current.current.id,publishedDate)));await refresh();setNotice('Marked as published in your library.');})}>I published this</button></div>}
      </section><aside className="studio-sidebar"><section className="panel"><div className="panel-head"><Sparkles className="h-4 w-4"/>Make it more you</div><div className="panel-body"><p className="studio-sidebar-intro">Good direction, needs a tweak? Tell your editor.</p><div className="studio-quick-edits">{(post.format==='Short video script'?['Make it flow naturally',...QUICK_EDITS]:QUICK_EDITS).map(text=><button key={text} className="btn btn-outline" disabled={Boolean(busy)||!state.ai.configured||!post.body?.trim()} onClick={()=>revise(text==='Make it flow naturally'?naturalVideoRevision:text)}>{text}</button>)}</div><form className="studio-revision-form" onSubmit={event=>{event.preventDefault();if(instruction.trim())revise(instruction);}}><Field label="Your instruction"><textarea className="field w-full min-h-24" disabled={Boolean(busy)} value={instruction} maxLength={2000} onChange={event=>setInstruction(event.target.value)} placeholder="Make the example about a coach with plenty of calls but few good-fit prospects…"/></Field><button type="submit" className="btn btn-outline w-full" disabled={Boolean(busy)||!state.ai.configured||!instruction.trim()||!post.body?.trim()}><RefreshCw className="h-3.5 w-3.5"/>Rewrite with this direction</button></form>{post.versions?.length>0&&<button className="btn btn-ghost mt-3" disabled={Boolean(busy)} onClick={()=>run('Restoring your previous draft',async()=>{choosePost(await unwrap(restoreContentVersion(current.current.id,current.current.updatedAt)));await refresh();setNotice('Previous version restored.');})}><Undo2 className="h-3.5 w-3.5"/>Undo last AI revision</button>}</div></section>
        {post.whyRelevant&&<section className="studio-why"><span className="label-micro">WHY THIS IDEA</span><p>{post.whyRelevant}</p>{post.buyerProblem&&<small>Reader’s problem: {post.buyerProblem}</small>}</section>}
        {post.hooks?.length>0&&<details className="panel studio-detail"><summary>Try another opening</summary><div className="space-y-2">{post.hooks.map((hook,index)=><button key={index} disabled={Boolean(busy)} className={`studio-hook ${post.hook===hook?'is-selected':''}`} onClick={()=>update({hook})}>{hook}</button>)}</div></details>}
        <details className={`panel studio-detail ${flags.length?'has-flags':''}`}><summary>{flags.length?`${flags.length} ${flags.length===1?'claim':'claims'} to check`:'Sources & reasoning'}</summary><div className="studio-source-notes">{flags.length>0&&<ul>{flags.map((flag,index)=><li key={index}>{flag}</li>)}</ul>}{post.sourceUrl&&/^https?:\/\//.test(post.sourceUrl)&&<a href={post.sourceUrl} target="_blank" rel="noreferrer">Open researched page ↗</a>}{post.researchNote&&<p>{post.researchNote}</p>}{post.sourceNotes?.map((note,index)=><p key={index}>{note}</p>)}{post.learning?.mechanism&&<p>{post.learning.mechanism}</p>}<small>{post.learning?.evidenceType||'No evidence rating'} · Review factual claims before publishing.</small></div></details>
        {post.approvedAt&&post.status!=='Published'&&<details className="panel studio-detail"><summary>Plan publication</summary><div className="space-y-3"><Field label="Planned date"><input className="field w-full" type="date" disabled={Boolean(busy)} value={plannedDate} onChange={event=>setPlannedDate(event.target.value)}/></Field><button className="btn btn-outline" disabled={Boolean(busy)||!plannedDate} onClick={()=>run('Saving your planned date',async()=>{choosePost(await unwrap(scheduleContentPost(current.current.id,plannedDate)));await refresh();setNotice('Date saved. Publishing remains manual.');})}>Save date</button><p className="field-hint">A planning date, not automatic publishing.</p></div></details>}
      </aside></div>:<section className="studio-start"><div className="studio-start-icon"><MessageSquare className="h-6 w-6"/></div><h3>You bring the taste. AI brings the first draft.</h3><p>Choose a saved idea, or let us pick an unused one for your next post.<br/>Approve what sounds like you. Refine what doesn’t.</p><div className="studio-start-steps"><span><b>01</b> A relevant idea</span><span><b>02</b> Copy in your voice</span><span><b>03</b> Your final call</span></div></section>}
      <div className="studio-bottom"><span>{likes?`${likes} approved ${likes===1?'draft helps':'drafts help'} shape your next post.`:'Your approved drafts and revision requests shape future suggestions.'}</span><button disabled={Boolean(busy)} onClick={()=>run('Saving a blank draft',async()=>{choosePost(await unwrap(startContentFragment()));setEditing(true);await refresh();})}><Plus className="h-3.5 w-3.5"/>Save a thought myself</button></div>
    </>}
    {teleprompterOpen&&post&&<Teleprompter title={post.title} script={postText(post)} onClose={()=>setTeleprompterOpen(false)}/>}
  </div>;
}
