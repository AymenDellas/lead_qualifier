const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const Module=require('node:module');
const ts=require('typescript');
const root=path.resolve(__dirname,'../..');
const resolve=Module._resolveFilename;
Module._resolveFilename=function(request,parent,...args){return resolve.call(this,request.startsWith('@/')?path.join(root,'src',request.slice(2)):request,parent,...args);};
require.extensions['.ts']=(module,filename)=>module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,filename);
const stub=(file,exports)=>{require.cache[require.resolve(file)]={id:file,filename:file,loaded:true,exports};};
stub('next/cache',{revalidatePath(){}});
let allowAdmin=true,adminChecks=0,queries=0,row,files;
stub(path.join(root,'src/lib/project-workspace-auth.ts'),{async requireAdmin(){adminChecks++;if(!allowAdmin)throw Error('Sign in first');}});
const projectId='11111111-1111-4111-8111-111111111111',token='22222222-2222-4222-8222-222222222222';
const client={async query(sql,params=[]){
  queries++;
  if(sql.startsWith('SELECT * FROM business_projects WHERE id='))return {rows:params[0]===row.id?[row]:[]};
  if(sql.startsWith('SELECT * FROM business_projects WHERE data->'))return {rows:params[0]===row.data.onboarding.portalToken?[row]:[]};
  if(sql.startsWith('UPDATE business_projects')){row.data=JSON.parse(params[1]);row.revision++;return {rows:[row]};}
  if(sql.startsWith('SELECT COUNT(*)'))return {rows:[{count:files.filter(f=>!f.archived).length}]};
  if(sql.startsWith('INSERT INTO business_project_files')){files.push({id:params[0],project_id:params[1],item_id:params[2],kind:params[3],file_name:params[4],bytes:params[5],size:params[6],uploaded_by:params[7],archived:false,created_at:new Date().toISOString()});return {rows:[]};}
  if(sql.startsWith('SELECT id,project_id'))return {rows:files.filter(f=>f.project_id===params[0]&&!f.archived)};
  if(sql.startsWith('UPDATE business_project_files')){const f=files.find(f=>f.id===params[0]&&f.project_id===params[1]&&!f.archived);if(f)f.archived=true;return {rows:f?[f]:[]};}
  if(sql.startsWith('SELECT f.*,p.data')){assert.match(sql,/portalToken.*=\$2/);const f=files.find(f=>f.id===params[0]&&!f.archived&&row.data.onboarding.portalToken===params[1]);return {rows:f?[{...f,project:row.data}]:[]};}
  if(sql.startsWith('SELECT bytes,file_name'))return {rows:files.filter(f=>f.id===params[0]&&!f.archived)};
  throw Error(`Unexpected isolated test SQL: ${sql}`);
}};
stub(path.join(root,'src/lib/business-store.ts'),{businessTransaction:async fn=>{const before=structuredClone({row,files});try{return await fn(client);}catch(e){row=before.row;files=before.files;throw e;}},recordActivity:async()=>{},mapProject:r=>({id:r.id,data:r.data,revision:r.revision})});
const b=require('../../src/lib/business.ts'),p=require('../../src/lib/project-workspace.ts');
const admin=require('../../src/app/actions/project-actions.ts'),portal=require('../../src/app/actions/project-portal-actions.ts');
const clientDownload=require('../../src/app/portal/[token]/files/[fileId]/route.ts');
const internalDownload=require('../../src/app/api/project-files/[fileId]/route.ts');
function reset(){allowAdmin=true;adminChecks=0;queries=0;files=[];const data=b.buildProject({...b.blankOpportunity(),name:'Isolated project test',funnel:'DIRECT_TO_CALL',mode:'CASE_STUDY'},b.DEFAULT_OFFER);data.onboarding.portalToken=token;const edit=p.workspaceEdit(data);edit.deliverables[0]={...edit.deliverables[0],content:'Approved landing page copy',visibleToClient:true,status:'REVIEW'};edit.requests=[{id:'request-one',title:'Share the logo',instructions:'Upload your approved logo',responseType:'FILE',dueAt:'',required:true,status:'REQUESTED',feedback:''}];edit.setup=[{id:'setup-one',title:'Connect domain',instructions:'Invite Compel',owner:'CLIENT',status:'TODO',dueAt:''}];row={id:projectId,opportunity_id:'test-opportunity',revision:1,data:p.prepareWorkspaceSave(data,edit)};}
function form(values){const f=new FormData();f.set('token',token);for(const[k,v]of Object.entries(values))f.set(k,String(v));return f;}
function reviewForm(version=row.data.deliverables[0].version){return form({itemId:row.data.deliverables[0].id,version,decision:'APPROVED',feedback:'Approved'});}

test('every internal project action authenticates before reading or writing data',async()=>{
  reset();allowAdmin=false;
  for(const work of [()=>admin.saveProjectWorkspaceAction(projectId,1,p.workspaceEdit(row.data)),()=>admin.loadProjectFilesAction(projectId),()=>admin.uploadProjectFileAction(new FormData()),()=>admin.archiveProjectFileAction(projectId,projectId,1),()=>internalDownload.GET(new Request('http://localhost'),{params:Promise.resolve({fileId:projectId})})])await assert.rejects(work,/Sign in/);
  assert.equal(adminChecks,5);assert.equal(queries,0);
});
test('invalid and revoked portal tokens cannot mutate a project or store a file',async()=>{
  reset();const f=form({itemId:'request-one',version:1,responseRevision:0,response:'Logo',responseUrl:''});f.set('token','invalid');f.set('file',new File(['logo'],'logo.txt'));
  const invalid=await portal.submitProjectRequestAction(f);assert.equal(invalid.ok,false);assert.equal(queries,0);
  f.set('token','33333333-3333-4333-8333-333333333333');assert.equal((await portal.submitProjectRequestAction(f)).ok,false);assert.equal(files.length,0);assert.equal(row.revision,1);
});
test('client response saves actual file bytes and only the token-owned request, ignoring forged privileged fields',async()=>{
  reset();const f=form({itemId:'request-one',version:1,responseRevision:0,response:'Use the logo attached.',responseUrl:'',projectId:'another-project',status:'COMPLETE',internalNotes:'forged',visibleToClient:true});f.set('file',new File(['test logo bytes'],'approved-logo.txt'));
  assert.equal((await portal.submitProjectRequestAction(f)).ok,true);
  assert.equal(files.length,1);assert.equal(files[0].uploaded_by,'CLIENT');assert.equal(files[0].project_id,projectId);assert.equal(Buffer.from(files[0].bytes).toString(),'test logo bytes');
  assert.equal(row.data.delivery.requests[0].status,'SUBMITTED');assert.equal(row.data.delivery.internalNotes,'');assert.equal(row.data.status,'ONBOARDING');
  assert.equal((await portal.submitProjectRequestAction(f)).ok,false);assert.equal(files.length,1);
});
test('files are private to the matching portal token and hidden deliverables remain inaccessible',async()=>{
  reset();const f=form({itemId:'request-one',version:1,responseRevision:0,response:'Logo',responseUrl:''});f.set('file',new File(['contents'],'logo.txt'));await portal.submitProjectRequestAction(f);
  const id=files[0].id;
  const wrong=await clientDownload.GET(new Request('http://localhost'),{params:Promise.resolve({token:'33333333-3333-4333-8333-333333333333',fileId:id})});assert.equal(wrong.status,404);
  const good=await clientDownload.GET(new Request('http://localhost'),{params:Promise.resolve({token,fileId:id})});assert.equal(await good.text(),'contents');assert.equal(good.headers.get('cache-control'),'private, no-store');assert.match(good.headers.get('content-disposition'),/^attachment/);assert.equal(good.headers.get('x-content-type-options'),'nosniff');
  files[0].kind='deliverable';files[0].item_id=row.data.deliverables[1].id;
  assert.equal((await clientDownload.GET(new Request('http://localhost'),{params:Promise.resolve({token,fileId:id})})).status,404);
});
test('an admin file replacement invalidates approval and stale approvals cannot apply to the new version',async()=>{
  reset();const initialVersion=row.data.deliverables[0].version;assert.equal((await portal.reviewProjectDeliverableAction(reviewForm())).ok,true);assert.equal(row.data.deliverables[0].status,'DONE');
  const f=form({projectId,itemId:row.data.deliverables[0].id,kind:'deliverable',revision:row.revision});f.set('file',new File(['new file'],'page.txt'));
  await admin.uploadProjectFileAction(f);assert.equal(row.data.deliverables[0].version,initialVersion+1);assert.equal(row.data.deliverables[0].status,'REVIEW');assert.equal(row.data.deliverables[0].reviews.length,1);
  assert.equal((await portal.reviewProjectDeliverableAction(reviewForm(initialVersion))).ok,false);assert.equal((await portal.reviewProjectDeliverableAction(reviewForm(initialVersion+1))).ok,true);
});
test('stale admin saves cannot overwrite a client response and blank work cannot request approval',async()=>{
  reset();const original=p.workspaceEdit(row.data);assert.equal((await portal.reportProjectSetupAction(form({itemId:'setup-one'}))).ok,true);
  await assert.rejects(admin.saveProjectWorkspaceAction(projectId,1,original),/changed/);
  const edit=p.workspaceEdit(row.data);edit.deliverables[0].content='';
  await assert.rejects(admin.saveProjectWorkspaceAction(projectId,row.revision,edit),/Add content/);
});
test('removing the final file takes an otherwise empty shared deliverable out of review',async()=>{
  reset();const item=row.data.deliverables[0];item.content='';item.url='';
  const f=form({projectId,itemId:item.id,kind:'deliverable',revision:row.revision});f.set('file',new File(['review file'],'page.txt'));
  await admin.uploadProjectFileAction(f);
  await admin.archiveProjectFileAction(projectId,files[0].id,row.revision);
  assert.equal(row.data.deliverables[0].status,'DOING');assert.equal(files[0].archived,true);
  assert.equal((await portal.reviewProjectDeliverableAction(reviewForm())).ok,false);
});
test('file limits reject oversized or unsupported uploads and new uploads roll back with an invalid client response',async()=>{
  reset();for(const file of [new File(['bad'],'program.exe'),new File([new Uint8Array(p.MAX_PROJECT_FILE_BYTES+1)],'large.txt')]){
    const f=form({itemId:'request-one',version:1,responseRevision:0,response:'',responseUrl:''});f.set('file',file);assert.equal((await portal.submitProjectRequestAction(f)).ok,false);
  }
  assert.equal(files.length,0);assert.equal(row.revision,1);
});
test('client-reported access cannot downgrade verified access or forge setup owned by Compel',async()=>{
  reset();row.data.onboarding.access=[{id:'verified',platform:'Test tool',reason:'Test',permission:'Editor',instructions:'Invite',required:true,nonBlocking:false,status:'VERIFIED'}];
  assert.equal((await portal.reportProjectAccessAction(form({itemId:'verified'}))).ok,false);assert.equal(row.data.onboarding.access[0].status,'VERIFIED');
  row.data.delivery.setup[0].owner='COMPEL';assert.equal((await portal.reportProjectSetupAction(form({itemId:'setup-one'}))).ok,false);
});
