import { NextResponse } from 'next/server';
import { openDatabase, get, list, put } from '@/lib/content-create/db';
import { validatePost, approvePost, schedulePost, publishPost } from '@/lib/content-create/rules';
import { ideaCatalog, markIdea, suggestIdea } from '@/lib/content-create/idea-engine';
import { researchUrl } from '@/lib/content-create/research';
import { generate, aiStatus } from '@/lib/content-create/ai';

export const runtime='nodejs';
export const dynamic='force-dynamic';

let connection;
function database(){ if(!connection)connection=openDatabase(process.env.CONTENT_CREATE_DB_PATH); return connection; }
const answer=(value,status=200)=>NextResponse.json(value,{status,headers:{'Cache-Control':'no-store'}});
const problem=(message,status=400)=>answer({error:message},status);
async function input(request){
  const length=Number(request.headers.get('content-length')||0);
  if(length>12_000_000)throw Object.assign(new Error('Request is too large'),{status:413});
  try{const body=await request.text();return body ? JSON.parse(body) : {};}catch{throw Object.assign(new Error('Invalid JSON request'),{status:400});}
}
function context(db){
  return {
    beliefs:list(db,'beliefs').map(item=>({statement:item.statement,explanation:item.explanation,evidence:item.evidence})).filter(item=>item.statement).slice(0,40),
    knowledge:list(db,'concepts').map(item=>({name:item.name,definition:item.definition,mechanism:item.mechanism,evidence:item.evidence,evidenceType:item.evidenceType,exceptions:item.exceptions,coachingExample:item.coachingExample,metrics:item.metrics,angles:item.angles})).slice(0,40),
    metricsSummary:{},
  };
}
function required(db,collection,id){const item=get(db,collection,id);if(!item)throw Object.assign(new Error('Record not found'),{status:404});return item;}
async function route(request,{params}){
  try{
    const db=database(),path=(await params).path||[];
    const [resource,id,action]=path;
    const method=request.method;
    if(method==='GET'&&resource==='state'&&!id)return answer({posts:list(db,'posts'),ideas:list(db,'ideas'),concepts:list(db,'concepts'),beliefs:list(db,'beliefs'),settings:list(db,'settings'),ai:aiStatus()});
    if(method==='POST'&&resource==='idea'&&id==='suggest')return answer(suggestIdea(db,await input(request)));
    if(method==='POST'&&resource==='idea'&&id==='today')return answer(suggestIdea(db,{today:true}));
    if(method==='GET'&&resource==='idea'&&id==='library')return answer({ideas:ideaCatalog(db),usage:list(db,'ideaUsage')});
    if(method==='POST'&&resource==='research-url')return answer(await researchUrl((await input(request)).url));
    if(method==='POST'&&resource==='generate'){
      const payload=await input(request);
      if(payload.mode!=='draft')return problem('Only Create drafts are available in this tab');
      const result=await generate('draft',{...payload,...context(db)});
      if(payload.ideaId)markIdea(db,payload.ideaId,'drafted');
      return answer(result);
    }
    if(method==='POST'&&resource==='beliefs'&&!id){
      const payload=await input(request);
      if(!String(payload.statement||'').trim())return problem('Enter a belief first');
      return answer(put(db,'beliefs',{statement:String(payload.statement).trim().slice(0,1000),tags:Array.isArray(payload.tags)?payload.tags:[]}),201);
    }
    if(method==='POST'&&resource==='posts'&&!id){
      const payload=await input(request);
      const saved=put(db,'posts',validatePost({...payload,approvedAt:null,status:payload.status||'Idea'}));
      markIdea(db,saved.ideaId,'drafted',saved.id);
      return answer(saved,201);
    }
    if(method==='PUT'&&resource==='posts'&&id&&!action){
      const current=required(db,'posts',id),payload=await input(request);
      const contentChanged=['body','hook','slides','learning','claimFlags'].some(key=>key in payload&&JSON.stringify(payload[key])!==JSON.stringify(current[key]));
      const merged={...current,...payload,id,approvedAt:contentChanged?null:current.approvedAt};
      if(contentChanged&&['Approved','Scheduled','Published'].includes(current.status))merged.status='Ready for review';
      if(payload.status&&['Approved','Scheduled','Published'].includes(payload.status)&&!current.approvedAt)return problem('Use the human approval workflow before this status');
      const saved=put(db,'posts',validatePost(merged,current));
      if(saved.ideaId)markIdea(db,saved.ideaId,'drafted',saved.id);
      return answer(saved);
    }
    if(method==='POST'&&resource==='posts'&&id&&action){
      const current=required(db,'posts',id),payload=await input(request);
      if(action==='approve'){const saved=put(db,'posts',approvePost(current));markIdea(db,saved.ideaId,'approved',saved.id);return answer(saved);}
      if(action==='schedule')return answer(put(db,'posts',schedulePost(current,payload.plannedDate)));
      if(action==='publish'){
        if(payload.confirmed!==true)return problem('Confirm that you published this post manually');
        const saved=put(db,'posts',publishPost(current,payload.publishedDate));
        markIdea(db,saved.ideaId,'published',saved.id);
        return answer(saved);
      }
    }
    return problem('Unknown Create action',404);
  }catch(error){return problem(error.message||'Create request failed',Number(error.status)||400);}
}

export {route as GET,route as POST,route as PUT};
