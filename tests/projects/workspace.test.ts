import test from 'node:test';
import assert from 'node:assert/strict';
import { blankOpportunity, buildProject, DEFAULT_OFFER, normalizeOnboarding } from '../../src/lib/business';
import { applyClientResponse, applyDeliverableReview, clientProjectView, currentReview, deliveryWorkspace,
  prepareWorkspaceSave, reportClientSetup, validateDeliveryData, workspaceEdit } from '../../src/lib/project-workspace';

function fixture() {
  const project = buildProject({ ...blankOpportunity(), name: 'Test client', funnel: 'DIRECT_TO_CALL', mode: 'CASE_STUDY' }, DEFAULT_OFFER);
  const edit = workspaceEdit(project);
  edit.internalNotes = 'Private delivery notes, never for clients';
  edit.requests = [{id:'request-one',title:'Share your logo',instructions:'Upload the approved logo or share its location.',responseType:'ANY',dueAt:'',required:true,status:'REQUESTED',feedback:''}];
  edit.setup = [{id:'task-one',title:'Invite the team',instructions:'Use a collaborator invitation.',owner:'CLIENT',status:'TODO',dueAt:''},
    {id:'task-two',title:'Connect tracking',instructions:'Compel will verify booking events.',owner:'COMPEL',status:'TODO',dueAt:''}];
  edit.deliverables[0] = {...edit.deliverables[0], visibleToClient:true, content:'The landing page copy to review.',status:'REVIEW'};
  return prepareWorkspaceSave(project, edit);
}

test('existing projects retain their original scope and deliverables, with draft content private by default', () => {
  const legacy = buildProject({ ...blankOpportunity(), name:'Legacy client', funnel:'DIRECT_TO_CALL' }, DEFAULT_OFFER);
  const before = JSON.stringify(legacy);
  assert.deepEqual(deliveryWorkspace(legacy),{requests:[],setup:[],internalNotes:''});
  assert.equal(clientProjectView(legacy,normalizeOnboarding(legacy)).deliverables.length,0);
  assert.equal(JSON.stringify(legacy),before);
  assert.ok(workspaceEdit(legacy).deliverables.every(item => item.visibleToClient === false));
});
test('client view excludes private drafts, notes, fees, measurement data and portal tokens', () => {
  const project = fixture();
  project.assets='private asset notes'; project.terms='internal terms'; project.onboarding!.portalToken='private portal token';
  const view=clientProjectView(project,normalizeOnboarding(project));
  assert.equal(view.deliverables.length,1);
  assert.equal(view.scope.included,project.onboarding!.scope.included);
  assert.doesNotMatch(JSON.stringify(view),/Private delivery notes|private asset notes|internal terms|private portal token|minimumIncrease/);
});
test('approvals refer to the reviewed version; later edits invalidate approval and retain its history', () => {
  const project=fixture(), item=project.deliverables[0];
  const approved=applyDeliverableReview(project,item.id,item.version!,'APPROVED','Looks good.');
  assert.equal(approved.deliverables[0].status,'DONE');
  assert.equal(currentReview(approved.deliverables[0])?.decision,'APPROVED');
  const edit=workspaceEdit(approved);edit.deliverables[0].content='A revised page.';
  const updated=prepareWorkspaceSave(approved,edit);
  assert.equal(updated.deliverables[0].version,item.version!+1);
  assert.equal(updated.deliverables[0].status,'REVIEW');
  assert.equal(currentReview(updated.deliverables[0]),undefined);
  assert.equal(updated.deliverables[0].reviews!.length,1);
  assert.throws(()=>applyDeliverableReview(updated,item.id,item.version!,'APPROVED',''),/changed/);
});
test('private, absent, completed and duplicate deliverable reviews cannot be approved', () => {
  const project=fixture(), item=project.deliverables[0];
  assert.throws(()=>applyDeliverableReview(project,'another-project-item',1,'APPROVED',''),/not currently/);
  assert.throws(()=>applyDeliverableReview(project,project.deliverables[1].id,1,'APPROVED',''),/not currently/);
  const approved=applyDeliverableReview(project,item.id,item.version!,'APPROVED','');
  assert.throws(()=>applyDeliverableReview(approved,item.id,item.version!,'APPROVED',''),/not currently/);
  assert.throws(()=>applyDeliverableReview(project,item.id,item.version!,'CHANGES_REQUESTED',' '),/Tell us/);
});
test('changes requested return to work in progress and can be reopened as a new review version', () => {
  const project=fixture(), item=project.deliverables[0];
  const changed=applyDeliverableReview(project,item.id,item.version!,'CHANGES_REQUESTED','Please change the headline.');
  assert.equal(changed.deliverables[0].status,'DOING');
  const edit=workspaceEdit(changed);edit.deliverables[0].status='REVIEW';
  assert.equal(prepareWorkspaceSave(changed,edit).deliverables[0].version,item.version!+1);
});
test('client responses are preserved across internal edits and cannot overwrite newer answers', () => {
  const project=fixture();
  const response=applyClientResponse(project,'request-one',1,0,'Our approved logo','https://example.com/logo.png',false);
  assert.equal(deliveryWorkspace(response).requests[0].status,'SUBMITTED');
  const edit=workspaceEdit(response);edit.requests[0].feedback='Thanks, this is useful.';
  const saved=prepareWorkspaceSave(response,edit);
  assert.equal(deliveryWorkspace(saved).requests[0].response,'Our approved logo');
  assert.equal(deliveryWorkspace(saved).requests[0].responseRevision,1);
  assert.throws(()=>applyClientResponse(saved,'request-one',1,0,'old response','',false),/changed/);
  edit.requests[0].instructions='Now share the monochrome version.';
  const newRequest=prepareWorkspaceSave(saved,edit);
  assert.equal(deliveryWorkspace(newRequest).requests[0].version,2);
  assert.equal(deliveryWorkspace(newRequest).requests[0].status,'REQUESTED');
  assert.throws(()=>applyClientResponse(newRequest,'request-one',1,1,'stale','',false),/changed/);
});
test('each request type requires the requested response and links cannot use executable protocols', () => {
  for (const responseType of ['TEXT','LINK','FILE','ANY'] as const) {
    const project=fixture();project.delivery!.requests[0].responseType=responseType;
    assert.throws(()=>applyClientResponse(project,'request-one',1,0,'','',false),/Add /);
    const response=responseType==='TEXT'?'Here is the answer':'';
    const link=responseType==='LINK'?'https://example.com/file':'';
    assert.equal(applyClientResponse(project,'request-one',1,0,response,link,responseType==='FILE'||responseType==='ANY').delivery!.requests[0].status,'SUBMITTED');
  }
  assert.throws(()=>applyClientResponse(fixture(),'request-one',1,0,'','javascript:alert(1)',false));
  assert.throws(()=>applyClientResponse(fixture(),'request-one',1,0,'','https://name:secret@example.com',false));
});
test('completed requests are closed; revision feedback and real client submissions cannot be fabricated by saving an editor', () => {
  const project=fixture(),edit=workspaceEdit(project);
  edit.requests[0].status='CHANGES_REQUESTED';
  assert.throws(()=>prepareWorkspaceSave(project,edit),/Explain/);
  edit.requests[0].status='SUBMITTED';
  assert.throws(()=>prepareWorkspaceSave(project,edit),/comes from/);
  edit.requests[0].status='COMPLETE';
  const closed=prepareWorkspaceSave(project,edit);
  assert.throws(()=>applyClientResponse(closed,'request-one',1,0,'answer','',false),/no longer open/);
});
test('client setup reports wait for verification and cannot complete Compel tasks', () => {
  const project=fixture();
  const reported=reportClientSetup(project,'task-one');
  assert.equal(reported.delivery!.setup[0].status,'WAITING');
  assert.ok(reported.delivery!.setup[0].clientReportedAt);
  assert.throws(()=>reportClientSetup(project,'task-two'),/no longer open/);
  assert.throws(()=>reportClientSetup(reported,'task-one'),/no longer open/);
  const edit=workspaceEdit(reported);edit.setup[0].status='DONE';
  assert.equal(prepareWorkspaceSave(reported,edit).delivery!.setup[0].status,'DONE');
});
test('saved items and responses cannot accidentally disappear; duplicate identifiers fail validation', () => {
  const project=fixture(),edit=workspaceEdit(project);edit.requests=[];
  assert.throws(()=>prepareWorkspaceSave(project,edit),/Keep saved items/);
  const bad=structuredClone(project);bad.delivery!.setup.push(bad.delivery!.setup[0]);
  assert.throws(()=>validateDeliveryData(bad),/unique ID/);
});
