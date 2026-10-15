import { openDatabase, get, list, put } from './db.js';
import { generate, aiStatus } from './ai.js';
import { researchUrl } from './research.js';
import { approvePost, schedulePost, publishPost } from './rules.js';
import { DEFAULT_DIRECTION, FORMATS, EDITABLE_FIELDS, draftSnapshot } from './studio-shared.js';
import { normalizeVideoPlan, syncVideoEdges, videoCopy } from './video-plan.js';
import { starterIdeas } from './starter-ideas.js';

const clean = (value, limit = 2000) => String(value ?? '').trim().slice(0, limit);
const error = message => { throw new Error(message); };

export async function searchPublicExample(query) {
  const key = process.env.SERPER_API_KEY_1 || process.env.SERPER_API_KEY;
  if (!key || !query) return [];
  const response = await fetch('https://google.serper.dev/search', {
    method: 'POST', headers: {'X-API-KEY': key, 'Content-Type': 'application/json'},
    body: JSON.stringify({q:clean(query,300),num:3}), signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error('Public source search is temporarily unavailable.');
  const result = await response.json();
  return (result.organic || []).map(item=>item.link).filter(url=>typeof url === 'string').slice(0,3);
}

// Injectable dependencies let the workflow be verified without spending model
// credits or touching the user's posts and preferences.
export function createStudio({db, modelGenerate = generate, research = researchUrl, search = searchPublicExample} = {}) {
  const database = () => db || openDatabase(process.env.CONTENT_CREATE_DB_PATH);
  const direction = () => ({...DEFAULT_DIRECTION,...get(database(),'settings','creative-direction')?.value});
  const required = (collection,id) => get(database(),collection,id) || error('That item is no longer available. Refresh and try again.');
  const resolveIdea = id => get(database(),'ideas',id) || starterIdeas.find(idea=>idea.id===id) || error('That idea is no longer available. Explore your saved ideas again.');
  const ideaBank = () => {
    const posts = list(database(),'posts');
    const rejected = new Set(list(database(),'feedback').filter(item=>item.kind==='rejected').map(item=>item.ideaId).filter(Boolean));
    const saved = list(database(),'ideas').filter(idea=>idea.generatedBy==='ai' && idea.hook && idea.angle);
    return [...saved,...starterIdeas].filter(idea=>!rejected.has(idea.id)).map(idea=>({...idea,usedCount:posts.filter(post=>post.ideaId===idea.id).length}));
  };
  const unchanged = (current,expected) => {
    if (expected && current.updatedAt !== expected) error('This draft changed in another session. Reopen it before editing so neither version is lost.');
  };
  const sourceCandidates = () => list(database(),'funnels').filter(item=>item.url).slice(0,12).map(item=>({id:item.id,url:item.url,title:item.title || item.observed?.headline || 'Saved funnel'}));
  const context = () => {
    const posts = list(database(),'posts');
    const feedback = list(database(),'feedback');
    return {
      creativeDirection: direction(),
      availableSources: sourceCandidates(),
      editorialMemory: {
        recentPosts: posts.slice(0,15).map(post=>({topic:post.topic,title:post.title,hook:post.hook,status:post.status})),
        recentIdeas: list(database(),'ideas').filter(idea=>idea.generatedBy==='ai').slice(0,12).map(idea=>({topic:idea.topic,angle:idea.angle})),
        liked: feedback.filter(item=>item.kind==='liked').slice(0,4).map(item=>({topic:item.topic,copy:item.copy})),
        rejected: feedback.filter(item=>item.kind==='rejected').slice(0,8).map(item=>({topic:item.topic,angle:item.angle,reason:item.reason})),
        revisions: feedback.filter(item=>item.kind==='revision').slice(0,8).map(item=>({instruction:item.reason,preferredCopy:item.copy})),
      },
      beliefs: list(database(),'beliefs').slice(0,20),
      knowledge: list(database(),'concepts').slice(0,20),
    };
  };

  async function ideas(seed = {}) {
    const result = await modelGenerate('ideas', {...context(), sourceType:'Saved creative direction',sourceText:JSON.stringify({task:'Generate fresh editorial ideas from the saved direction and editorial preferences. This is not evidence of any client outcome. If supplied, anchor the ideas in the optional source.',optionalSource:seed.source || null,notes:clean(seed.sourceText,14000)}),imageDataUrl:seed.imageDataUrl || null});
    if (!Array.isArray(result.output?.ideas) || result.output.ideas.length !== 3) error('No usable ideas came back. Please try again.');
    const existing = list(database(),'ideas');
    const signature = idea => clean(idea.angle,1000).toLowerCase().replace(/\s+/g,' ');
    return result.output.ideas.map(idea=>existing.find(saved=>signature(saved)===signature(idea)) || put(database(),'ideas',{
      topic:clean(idea.topic,300),angle:clean(idea.angle,1000),hook:clean(idea.hook,500),
      pillar:['principle','pov','transformation','breakdown'].includes(idea.pillar)?idea.pillar:'principle',
      buyerProblem:clean(idea.buyerProblem),whyRelevant:clean(idea.whyRelevant),searchQuery:clean(idea.searchQuery,300),sourceId:clean(idea.sourceId,100),generatedBy:'ai',
    }));
  }

  async function material(idea, input) {
    if (input.sourceUrl) return {source:await research(clean(input.sourceUrl,2000)),note:''};
    if (input.sourceText || input.imageDataUrl) return {source:null,note:''};
    if (idea.pillar !== 'breakdown') return {source:null,note:''};
    const saved = sourceCandidates().find(item=>item.id===idea.sourceId);
    let urls = saved ? [saved.url] : [];
    if (!urls.length) {
      try { urls = await search(idea.searchQuery || `${direction().audience} coaching program book consultation`); } catch { /* Fall back to an illustrative argument. */ }
    }
    for (const url of urls.slice(0,3)) {
      try {
        const source = await research(url);
        if (source.text?.trim().length > 100) return {source,note:''};
      } catch { /* Only verified page text may ground a breakdown. */ }
    }
    return {source:null,note:'A public example could not be verified. This post teaches the idea with an illustrative example instead.'};
  }

  function normalizeOutput(output, current = {}, format = current.format) {
    const hook = clean(output.recommendedHook,1000);
    if (!hook || !clean(output.body,20000)) error('The AI returned an incomplete draft. Your previous version is safe.');
    let body = clean(output.body,20000);
    if (body.startsWith(hook)) body = body.slice(hook.length).trim();
    const cta = clean(output.cta,2000);
    if (cta && body.endsWith(cta)) body = body.slice(0,-cta.length).trim();
    if (!body) error('The AI returned only a hook. Please try again.');
    // Model output supplies copy, never record identity, sources or workflow
    // state. Ignore extra keys even if the provider ignores the JSON schema.
    const fields = ['topic','audience','funnelStage','hooks','shortVersion','slides','learning','claimFlags','sourceNotes','audit','auditDimensions','transformation'];
    const content = Object.fromEntries(fields.filter(key=>key in output).map(key=>[key,output[key]]));
    const videoPlan = format === 'Short video script' ? normalizeVideoPlan(syncVideoEdges(normalizeVideoPlan(output.videoPlan),{hook,cta})) : null;
    if (videoPlan) body = videoCopy(videoPlan).body;
    return {...current,...content,title:clean(output.title,300) || 'Untitled draft',hook,body,cta,videoPlan,approvedAt:null,status:'Drafting'};
  }

  async function draft(input = {}) {
    const format = FORMATS.includes(input.format) ? input.format : 'Text post';
    const slideCount = Math.max(5,Math.min(10,Number(input.slideCount)||7));
    // Draft from a bank idea in one model request. Source-led posts ask that
    // same drafting request to find their angle; browsing never triggers AI.
    const supplied = input.sourceUrl ? await research(clean(input.sourceUrl,2000)) : null;
    const hasMaterial = Boolean(supplied || input.sourceText?.trim() || input.imageDataUrl);
    const sourceIdea = {id:null,pillar:supplied?'breakdown':'principle',topic:'Your supplied material',hook:'',angle:'Choose the strongest useful angle supported by the supplied material and saved creative direction. Keep the argument specific to that source.',buyerProblem:'',whyRelevant:'Grounded in the source you supplied.',generatedBy:'source'};
    const idea = input.ideaId ? resolveIdea(input.ideaId) : hasMaterial ? sourceIdea : ideaBank().find(item=>!item.usedCount);
    if (!idea) error('You have drafted all your available ideas. Explore the bank to reuse one, or choose Generate more ideas. No AI request was made.');
    const {source,note} = supplied ? {source:supplied,note:''} : await material(idea,input);
    const pillar = note ? 'principle' : idea.pillar;
    const sourceText = JSON.stringify({
      editorialIdea:idea, sourceStatus:source?'Fetched public page':input.sourceText?'User-provided material':input.imageDataUrl?'User-provided screenshot':'Editorial argument with illustrative examples only. No real client observations or results supplied.',
      page:source, userMaterial:clean(input.sourceText,14000),
    });
    const result = await modelGenerate('draft',{
      ...context(),pillar,format,slideCount,sourceText,sourceType:source?'Public page':'AI editorial idea',sourceUrl:source?.url || '',imageDataUrl:input.imageDataUrl || null,
      selectedAngle:{title:idea.topic,hook:idea.hook,angle:idea.angle},
    });
    const post = put(database(),'posts',{
      ...normalizeOutput(result.output,{},format),pillar,format,ideaId:idea.id,ideaSnapshot:idea,
      sourceType:source?'Public page':input.sourceText?'Notes':input.imageDataUrl?'Screenshot':'AI editorial idea',sourceText,sourceUrl:source?.url || '',sourceImage:input.imageDataUrl || null,
      researchNote:note,whyRelevant:idea.whyRelevant,buyerProblem:idea.buyerProblem,versions:[],
    });
    return {post};
  }

  function save(id, patch, expectedUpdatedAt) {
    const current = required('posts',id);
    unchanged(current,expectedUpdatedAt);
    const changes = {};
    for (const key of EDITABLE_FIELDS) {
      if (!(key in patch)) continue;
      if (key === 'slides') {
        if (!Array.isArray(patch.slides) || patch.slides.length > 15) error('Use at most 15 slides.');
        changes.slides = patch.slides.map((slide,index)=>({number:index+1,role:clean(slide.role,100),copy:clean(slide.copy,2000),visualDirection:clean(slide.visualDirection),imagePrompt:clean(slide.imagePrompt)}));
      } else if (key === 'videoPlan') {
        if (patch.videoPlan) {
          if (current.format !== 'Short video script') error('Recording plans belong to video scripts.');
          changes.videoPlan = normalizeVideoPlan(patch.videoPlan);
        } else if (current.videoPlan) error('Keep the recording plan with this video script.');
      } else changes[key] = clean(patch[key],key==='body'||key==='shortVersion'?20000:2000);
    }
    const plan = changes.videoPlan || current.videoPlan;
    if (plan) {
      if ('body' in changes && changes.body !== videoCopy(plan).body) error('Edit the spoken lines in each frame so your script and recording plan stay together.');
      changes.videoPlan = normalizeVideoPlan(syncVideoEdges(plan,{...current,...changes}));
      Object.assign(changes,videoCopy(changes.videoPlan));
    }
    const changed = Object.entries(changes).some(([key,value])=>JSON.stringify(value)!==JSON.stringify(current[key]));
    if (!changed) return current;
    return put(database(),'posts',{...current,...changes,title:changes.title || current.title || 'Untitled draft',approvedAt:null,status:'Drafting'});
  }

  async function revise(id, instruction, expectedUpdatedAt) {
    const current = required('posts',id);
    unchanged(current,expectedUpdatedAt);
    if (!clean(instruction)) error('Tell the AI what to change.');
    const revisionInstruction = instruction === 'Stronger hook' ? 'Write three stronger, specific opening hooks and select one. Keep the body, CTA, and all other copy unchanged.' : instruction === 'Shorter' ? 'Shorter: cut the total public copy by roughly one third, preserving the core point and necessary qualifications. Remove repeated reasoning and abstract setup.' : instruction === 'More specific' ? 'Replace abstract advice with a concrete illustrative example or precise wording. Never invent results, statistics, offer promises, or personal experience.' : instruction === 'Less formal' ? 'Use plain, conversational sentences. Remove academic explanations and corporate phrasing while preserving the argument and factual qualifications.' : clean(instruction);
    const result = await modelGenerate('draft',{
      ...context(),pillar:current.pillar,format:current.format,slideCount:current.slides?.length || 7,
      sourceText:current.sourceText || 'No external evidence was supplied. Keep examples illustrative.',sourceType:current.sourceType,sourceUrl:current.sourceUrl,imageDataUrl:current.sourceImage,
      existingDraft:{...draftSnapshot(current),learning:current.learning,claimFlags:current.claimFlags},revisionInstruction,
    });
    // A model request can take a minute; never overwrite an edit made meanwhile.
    unchanged(required('posts',id),current.updatedAt);
    const versions = [...(current.versions || []),{...draftSnapshot(current),learning:current.learning,claimFlags:current.claimFlags,sourceNotes:current.sourceNotes,label:clean(instruction,100),savedAt:new Date().toISOString()}].slice(-12);
    const revised = normalizeOutput(result.output,current);
    // The hook shortcut is intentionally narrow, even if the model rewrites
    // other fields despite being asked to preserve them.
    if (instruction === 'Stronger hook') {
      for (const key of ['title','topic','body','cta','shortVersion','slides','learning','claimFlags','sourceNotes']) revised[key] = current[key];
      if (current.format === 'Short video script') revised.videoPlan = syncVideoEdges(current.videoPlan,revised);
    }
    const post = put(database(),'posts',{...revised,id,versions});
    put(database(),'feedback',{kind:'revision',postId:id,topic:post.topic,reason:clean(instruction),copy:clean(post.body,1200)});
    return post;
  }

  function feedback({postId = '',ideaId = '',kind,reason = '',expectedUpdatedAt = ''}) {
    if (!['liked','rejected'].includes(kind)) error('Choose a valid preference.');
    const item = postId ? required('posts',postId) : resolveIdea(ideaId);
    if (postId) unchanged(item,expectedUpdatedAt);
    if (kind === 'liked' && !postId) error('Choose a draft first.');
    if (kind === 'liked' && item.format === 'Carousel' && (!item.slides?.length || item.slides.some(slide=>!slide.copy?.trim()))) error('Fill each slide before approving.');
    // Validate approval before writing the preference, so a failed approval does
    // not train future suggestions on unfinished content.
    const approved = kind === 'liked' ? approvePost(item) : null;
    put(database(),'feedback',{id:`${postId?'post':'idea'}:${item.id}:preference`,kind,postId:postId || null,ideaId:ideaId || item.ideaId || null,topic:item.topic,angle:item.angle || item.ideaSnapshot?.angle,reason:clean(reason),copy:clean(item.body,1200)});
    return approved ? put(database(),'posts',approved) : postId ? put(database(),'posts',{...item,approvedAt:null,status:'Drafting'}) : null;
  }

  function restore(id, expectedUpdatedAt) {
    const current = required('posts',id);
    unchanged(current,expectedUpdatedAt);
    const versions = [...(current.versions || [])];
    const previous = versions.pop();
    if (!previous) error('There is no earlier AI version to restore.');
    const restored = {...draftSnapshot(previous),learning:previous.learning,claimFlags:previous.claimFlags,sourceNotes:previous.sourceNotes};
    // An undo is also a taste signal: remove the latest instruction from memory.
    const latest = list(database(),'feedback').find(item=>item.postId===id && item.kind==='revision');
    if (latest) put(database(),'feedback',{...latest,kind:'undone'});
    return put(database(),'posts',{...current,...restored,versions,approvedAt:null,status:'Drafting'});
  }

  function publish(id, publishedDate) {
    validDate(publishedDate);
    return put(database(),'posts',publishPost(required('posts',id),publishedDate));
  }
  function validDate(date) {
    const parsed = new Date(`${date}T12:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10)!==date) error('Choose a valid publication date.');
  }

  return {
    state: () => ({posts:list(database(),'posts'),ideas:ideaBank(),direction:direction(),directionSaved:Boolean(get(database(),'settings','creative-direction')),feedback:list(database(),'feedback').filter(item=>item.kind!=='undone'),ai:aiStatus()}),
    saveDirection: input => {
      const value = Object.fromEntries(Object.keys(DEFAULT_DIRECTION).map(key=>[key,clean(input[key],key==='examples'?10000:2000)]));
      if (!value.audience || !value.offer) error('Add your audience and offer so the AI has a clear direction.');
      put(database(),'settings',{id:'creative-direction',value});
      return value;
    },
    ideas,draft,save,revise,feedback,restore,publish,
    schedule: (id,date) => {validDate(date);return put(database(),'posts',schedulePost(required('posts',id),date));},
    manual: () => put(database(),'posts',{title:'Untitled draft',topic:'',hook:'',body:'',cta:'',pillar:'pov',format:'Text post',status:'Drafting',versions:[],slides:[],claimFlags:[],sourceNotes:[]}),
  };
}
