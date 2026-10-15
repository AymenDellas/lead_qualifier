'use client';

import { useState } from 'react';
import { ArrowRight, Check, Copy, Mic, Monitor, MousePointer2 } from 'lucide-react';
import { miroBoardPrompt, videoCopy } from '@/lib/content-create/video-plan';

function Field({label,children}) {
  return <label className="block min-w-0"><span className="field-label">{label}</span>{children}</label>;
}

export default function VideoRecordingPlan({post,editing,busy,onUpdate,onCopy}) {
  const [requestedFrame,setSelected] = useState(0);
  const plan = post.videoPlan;
  const boardPrompt = miroBoardPrompt(post);
  const selected = Math.min(requestedFrame,plan.frames.length-1);
  const frame = plan.frames[selected];
  const duration = plan.frames.reduce((sum,item)=>sum+item.seconds,0);
  const start = plan.frames.slice(0,selected).reduce((sum,item)=>sum+item.seconds,0);
  const updatePlan = next => onUpdate({videoPlan:next,...videoCopy(next)});
  const updateFrame = patch => updatePlan({...plan,frames:plan.frames.map((item,index)=>index===selected?{...item,...patch}:item)});
  const updateItem = (index,patch) => updateFrame({items:frame.items.map((item,i)=>i===index?{...item,...patch}:item)});

  return <div className="studio-video">
    <div className="studio-video-heading"><div><span className="label-micro"><Monitor className="h-3.5 w-3.5"/> MIRO WALKTHROUGH</span><h4>Your board. Your words. One recording.</h4></div><span className="studio-video-duration">{plan.frames.length} frames · ~{duration}s</span></div>
    <section className="studio-video-prompt" aria-label="Image-generation prompt for Miro">
      <div className="studio-video-prompt-heading"><div><h5>Generate images for your board</h5><p>One prompt for {plan.frames.length} finished, styled images with all the text and visuals. Paste it into ChatGPT image generation, then copy the images into Miro.</p></div><button className="btn btn-outline" disabled={busy} onClick={()=>onCopy(boardPrompt,'Image prompt copied. Generate the images in ChatGPT, then paste them into Miro.')}><Copy className="h-3.5 w-3.5"/>Copy image prompt</button></div>
      <details><summary>View full image prompt</summary><textarea className="field w-full" aria-label="Full image-generation prompt" readOnly rows={12} value={boardPrompt}/></details>
    </section>
    <details className="studio-video-setup" open>
      <summary>Before you press record</summary>
      {editing?<fieldset disabled={busy} className="studio-video-setup-fields"><Field label="Recording setup"><textarea className="field w-full min-h-24" value={plan.recordingSetup} onChange={event=>updatePlan({...plan,recordingSetup:event.target.value})}/></Field><Field label="Miro board layout"><textarea className="field w-full min-h-24" value={plan.boardLayout} onChange={event=>updatePlan({...plan,boardLayout:event.target.value})}/></Field></fieldset>:<div className="studio-video-setup-fields"><div><strong>Recording setup</strong><p>{plan.recordingSetup}</p></div><div><strong>Build the board</strong><p>{plan.boardLayout}</p></div></div>}
      <p className="studio-video-footnote">Generate the images with the prompt above and paste them into Miro before recording. Timings are approximate; leave room to point and pause.</p>
    </details>
    <div className="studio-video-frames" role="group" aria-label="Recording frames">{plan.frames.map((item,index)=><button key={index} aria-pressed={selected===index} onClick={()=>setSelected(index)} className={selected===index?'is-selected':''}><span className="num">{String(index+1).padStart(2,'0')}</span><strong>{item.title}</strong><small>{index===0?'Opening':index===plan.frames.length-1?'Close':`${item.seconds}s`}</small></button>)}</div>
    <div className="studio-video-frame-heading"><strong>Frame {selected+1} · {frame.title}</strong><span className="num">~{start}–{start+frame.seconds}s</span></div>
    {editing&&<fieldset disabled={busy} className="studio-video-frame-settings"><Field label="Frame title"><input className="field w-full" value={frame.title} onChange={event=>updateFrame({title:event.target.value})}/></Field><Field label="Seconds"><input className="field w-full" type="number" min="3" max="60" value={frame.seconds} onChange={event=>updateFrame({seconds:Number(event.target.value)})}/></Field></fieldset>}
    <div className="studio-video-scene">
      <section className="studio-video-spoken"><span className="label-micro"><Mic className="h-3.5 w-3.5"/> SAY THIS</span>{editing?<fieldset disabled={busy}><Field label={`Spoken script for frame ${selected+1}`}><textarea className="field w-full min-h-48" value={frame.script} onChange={event=>updateFrame({script:event.target.value})}/></Field></fieldset>:<p>{frame.script}</p>}<div className="studio-video-action"><span className="label-micro"><MousePointer2 className="h-3.5 w-3.5"/> WHILE YOU SAY IT</span>{editing?<fieldset disabled={busy}><Field label="Recording action"><textarea className="field w-full min-h-28" value={frame.action} onChange={event=>updateFrame({action:event.target.value})}/></Field></fieldset>:<p>{frame.action}</p>}</div></section>
      <section className="studio-video-board"><div className="studio-section-label"><span className="label-micro">PUT ON THE BOARD</span><button className="btn btn-ghost" disabled={busy} onClick={()=>onCopy(frame.items.map(item=>item.text).join('\n'),`Frame ${selected+1} text copied.`)} aria-label={`Copy board text for frame ${selected+1}`}><Copy className="h-3.5 w-3.5"/>Text</button></div><div className="studio-video-board-items">{frame.items.map((item,index)=><div key={index} className={`studio-video-board-item ${item.kind==='Heading'?'is-heading':''}`}><span>{item.kind} · {item.placement}</span>{editing?<fieldset disabled={busy} className="space-y-2"><Field label={`Board item ${index+1} text`}><textarea className="field w-full min-h-20" value={item.text} onChange={event=>updateItem(index,{text:event.target.value})}/></Field><Field label={`Board item ${index+1} placement`}><input className="field w-full" value={item.placement} onChange={event=>updateItem(index,{placement:event.target.value})}/></Field></fieldset>:<p>{item.text}</p>}</div>)}</div><div className="studio-video-layout"><strong>Layout & connections</strong>{editing?<fieldset disabled={busy}><Field label="Frame layout"><textarea className="field w-full min-h-28" value={frame.layout} onChange={event=>updateFrame({layout:event.target.value})}/></Field></fieldset>:<p>{frame.layout}</p>}</div></section>
    </div>
    <div className="studio-video-next"><span><Check className="h-3.5 w-3.5"/> Your words paired with the visual</span>{selected<plan.frames.length-1?<button className="btn btn-outline" onClick={()=>setSelected(selected+1)}>Next frame<ArrowRight className="h-3.5 w-3.5"/></button>:<button className="btn btn-ghost" onClick={()=>setSelected(0)}>Back to opening</button>}</div>
  </div>;
}
