'use client';

import { useState } from 'react';
import { ArrowLeft, ArrowRight, Lightbulb, Search, Sparkles, ThumbsDown, X } from 'lucide-react';
import { PILLARS } from './api';

const PAGE_SIZE = 3;

export default function IdeaBank({ideas,busy,aiConfigured,onWrite,onReject,onGenerate,onHide}) {
  const [query,setQuery] = useState('');
  const [filter,setFilter] = useState('unused');
  const [page,setPage] = useState(0);
  const unused = ideas.filter(idea=>!idea.usedCount).length;
  const matches = ideas.filter(idea=>(filter==='all'||filter==='unused'&&!idea.usedCount||filter==='drafted'&&idea.usedCount>0)&&[idea.hook,idea.topic,idea.angle].join(' ').toLowerCase().includes(query.trim().toLowerCase()));
  const lastPage = Math.max(0,Math.ceil(matches.length/PAGE_SIZE)-1);
  const currentPage = Math.min(page,lastPage);
  const visible = matches.slice(currentPage*PAGE_SIZE,(currentPage+1)*PAGE_SIZE);

  return <section className="studio-idea-bank" aria-label="Saved idea bank">
    <div className="studio-bank-heading"><div><span className="label-micro"><Lightbulb className="h-4 w-4"/> YOUR IDEA BANK</span><h3>A strong starting point, already here.</h3><p>{unused} unused · {ideas.length} total · Browse without AI credits</p></div><button className="btn btn-ghost" disabled={busy} onClick={onHide} aria-label="Hide idea bank"><X className="h-4 w-4"/></button></div>
    <div className="studio-bank-controls"><label className="studio-bank-search"><Search className="h-4 w-4"/><span className="sr-only">Search saved ideas</span><input className="field w-full" placeholder="Search hooks, topics, or angles…" value={query} onChange={event=>{setQuery(event.target.value);setPage(0);}}/></label><label><span className="sr-only">Show ideas</span><select className="field" value={filter} onChange={event=>{setFilter(event.target.value);setPage(0);}}><option value="unused">Unused ideas</option><option value="all">All saved ideas</option><option value="drafted">Already drafted</option></select></label></div>
    {visible.length?<div className="studio-idea-grid">{visible.map(idea=><article key={idea.id} className="panel studio-idea"><div className="studio-idea-meta"><span className="label-micro">{PILLARS[idea.pillar]?.label}</span><span>{idea.generatedBy==='starter'?'Starter idea':'Saved AI idea'}{idea.usedCount>0?' · Drafted':''}</span></div><h3>{idea.hook}</h3><p>{idea.whyRelevant}</p><details className="studio-idea-angle"><summary>See the angle</summary><p>{idea.angle}</p>{idea.buyerProblem&&<p><strong>Buyer’s problem:</strong> {idea.buyerProblem}</p>}</details><div><button className="btn btn-outline" disabled={busy||!aiConfigured} onClick={()=>onWrite(idea.id)}>Write this<ArrowRight className="h-3.5 w-3.5"/></button><button className="btn btn-ghost" disabled={busy} onClick={()=>onReject(idea)} aria-label={`Not for me: ${idea.topic}`} title="Not for me"><ThumbsDown className="h-4 w-3.5"/></button></div></article>)}</div>:<div className="studio-bank-empty"><strong>{query?'No matching ideas.':filter==='unused'?'You’ve explored all your unused ideas.':'No ideas in this view yet.'}</strong><p>{query?'Try another search or clear your filters.':'Choose All saved ideas to revisit an angle, or generate more below.'}</p><button className="btn btn-ghost" onClick={()=>{setQuery('');setFilter('all');setPage(0);}}>Show all saved ideas</button></div>}
    {matches.length>PAGE_SIZE&&<div className="studio-bank-pagination"><button className="btn btn-ghost" disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}><ArrowLeft className="h-3.5 w-3.5"/>Previous</button><span>Page {currentPage+1} of {lastPage+1}</span><button className="btn btn-outline" disabled={currentPage===lastPage} onClick={()=>setPage(currentPage+1)}>More saved ideas<ArrowRight className="h-3.5 w-3.5"/></button></div>}
    <div className="studio-bank-generate"><div><strong>Want fresh angles?</strong><p>Generate 3 more ideas with AI and keep them here for later.</p><small>Uses AI credits. Writing or rewriting a draft also uses AI.</small></div><button className="btn btn-outline" disabled={busy||!aiConfigured} onClick={()=>{setQuery('');setFilter('unused');setPage(0);onGenerate();}}><Sparkles className="h-4 w-4"/>Generate more ideas</button></div>
  </section>;
}
