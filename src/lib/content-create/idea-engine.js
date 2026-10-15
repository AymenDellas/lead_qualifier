import { get, list, put } from './db.js';
import { builtInIdeas } from './idea-library.js';

const pillars = new Set(['principle','pov','transformation','breakdown']);
const cooldownMs = 30 * 24 * 60 * 60 * 1000;
const recentMs = 60 * 24 * 60 * 60 * 1000;

function savedConcept(item) {
  return {id:`concept:${item.id}`,pillar:'principle',topic:item.name,category:item.tags?.[0] || 'strategy',angle:item.angles?.[0] || `A coaching-funnel application of ${item.name}`,recommendedFormat:'Carousel',reason:'A concept you have saved in Compel Knowledge.',simpleDefinition:item.definition || '',deeperExplanation:item.mechanism || '',whyItMatters:item.whyItMatters || '',coachingExample:item.coachingExample || '',commonMistake:item.badExample || '',goodImplementation:item.goodExample || '',potentialExceptions:item.exceptions || [],possibleContentAngles:item.angles || [],evidenceNeeded:item.evidence || 'Add a source or real observation before making a strong claim.'};
}
function savedBelief(item) {
  return {id:`belief:${item.id}`,pillar:'pov',topic:item.tags?.[0] || 'Compel belief',category:'strategy',statement:item.statement,angle:item.statement,argument:item.explanation || '',recommendedFormat:'Text post',reason:'A position you saved in Compel Knowledge.',learning:{concept:item.tags?.[0] || 'Compel belief',definition:'A saved Compel position, not an established conversion principle.',whyValid:item.explanation || 'Explain why you hold this position before publishing.',mechanism:item.explanation || '',exceptions:[],evidenceNeeded:item.evidence || 'Add an observed example or a relevant source.'}};
}

function analyzedFunnel(item) {
  return {id:`funnel:${item.id}`,pillar:'breakdown',topic:item.title || item.observed.headline,category:'strategy',angle:item.analysis.strongestAngle,recommendedFormat:'Carousel',sourceUrl:item.url,reason:'A verified public funnel with a reviewed analysis. Recheck the live page before drafting; this angle remains a hypothesis.',requiresEvidence:true,learning:{concept:'Funnel diagnosis',definition:'Identify the strongest content-worthy tension visible in a real funnel.',whyValid:`The saved analysis points to “${item.analysis.evidencePhrase}” as visible page evidence; verify it again before using.`,mechanism:item.analysis.whyItMatters || item.analysis.tension || '',exceptions:item.analysis.unknowns || [],evidenceNeeded:'Recheck the live page and inspect any unobserved traffic, booking, or follow-up steps before making a strong claim.'}};
}

export function ideaCatalog(db) {
  const concepts=list(db,'concepts').filter(item=>item.name).map(savedConcept);
  const beliefs=list(db,'beliefs').filter(item=>item.statement).map(savedBelief);
  const funnels=list(db,'funnels').filter(item=>item.url && item.observed?.headline && item.analysis?.strongestAngle && item.analysis?.pageFingerprint===item.fingerprint).map(analyzedFunnel);
  return [...beliefs,...concepts,...funnels,...builtInIdeas];
}

export function markIdea(db, ideaId, stage, postId = null) {
  if (!ideaId || !['suggested','drafted','approved','published'].includes(stage)) return null;
  const idea=ideaCatalog(db).find(item=>item.id===ideaId);
  if (!idea) return null;
  const current=get(db,'ideaUsage',ideaId) || {id:ideaId,pillar:idea.pillar,topic:idea.topic,category:idea.category,suggestedCount:0,postIds:[]};
  const now=new Date().toISOString();
  const next={...current,id:ideaId,pillar:idea.pillar,topic:idea.topic,category:idea.category};
  if (stage==='suggested') { next.suggestedCount=(next.suggestedCount || 0)+1; next.suggestedAt=now; }
  else {
    if (postId && !next.postIds.includes(postId)) next.postIds=[...next.postIds,postId];
    if (stage==='drafted') next.draftedAt=now;
    if (stage==='approved') next.approvedAt=now;
    if (stage==='published') next.publishedAt=now;
  }
  return put(db,'ideaUsage',next);
}

function candidateScore(idea, usage, history, now) {
  const categoryRecent=history.filter(row=>row.category===idea.category && now-new Date(row.suggestedAt || 0).getTime()<recentMs).length;
  const topicRecent=history.filter(row=>row.topic===idea.topic && now-new Date(row.suggestedAt || 0).getTime()<recentMs).length;
  const used=usage?.publishedAt ? 12 : usage?.approvedAt ? 9 : usage?.draftedAt ? 6 : 0;
  return categoryRecent*3 + topicRecent*5 + used + (usage?.suggestedCount || 0)*2;
}

export function suggestIdea(db, {pillar, revisit=false, today=false} = {}) {
  if (pillar && !pillars.has(pillar)) throw Object.assign(new Error('Select a valid content pillar'),{status:400});
  const now=Date.now();
  const history=list(db,'ideaUsage');
  const usageById=new Map(history.map(row=>[row.id,row]));
  let candidates=ideaCatalog(db).filter(item=>(!pillar || item.pillar===pillar) && (!today || item.pillar!=='breakdown' || item.sourceUrl));
  if (!revisit) candidates=candidates.filter(item=>!usageById.get(item.id)?.suggestedAt || now-new Date(usageById.get(item.id).suggestedAt).getTime()>=cooldownMs);
  if (!candidates.length) throw Object.assign(new Error('All ideas in this pillar were suggested recently. Choose “Revisit ideas” to see one again, or add a new concept or belief in Knowledge.'),{status:409});
  const recentPillarCount=key=>history.filter(row=>row.pillar===key && now-new Date(row.suggestedAt || 0).getTime()<recentMs).length;
  candidates.sort((a,b)=>{
    const aScore=candidateScore(a,usageById.get(a.id),history,now)+(today ? recentPillarCount(a.pillar)*10 : 0);
    const bScore=candidateScore(b,usageById.get(b.id),history,now)+(today ? recentPillarCount(b.pillar)*10 : 0);
    return aScore-bScore || a.id.localeCompare(b.id);
  });
  const idea=candidates[0];
  markIdea(db,idea.id,'suggested');
  return {idea,usage:get(db,'ideaUsage',idea.id),today};
}

