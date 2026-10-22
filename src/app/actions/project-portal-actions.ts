'use server';
import { applyClientResponse, applyDeliverableReview, reportClientSetup, deliveryWorkspace } from '@/lib/project-workspace';
import { projectFiles, readUpload, storeProjectFile } from '@/lib/project-files';
import { portalProjectMutation, projectFormValue } from '@/lib/project-portal-store';

export async function submitProjectRequestAction(form: FormData) {
  return portalProjectMutation(form, async (client, row) => {
    const itemId = projectFormValue(form, 'itemId', 100);
    const item = deliveryWorkspace(row.data).requests.find(item => item.id === itemId);
    if (!item || item.status === 'COMPLETE') throw new Error('This request is no longer open.');
    const upload = await readUpload(form.get('file'));
    const files = await projectFiles(client, row.id);
    const next = applyClientResponse(row.data, itemId, Number(form.get('version')), Number(form.get('responseRevision')),
      projectFormValue(form, 'response'), projectFormValue(form, 'responseUrl', 2000), Boolean(upload || files.some(file => file.kind === 'request' && file.itemId === itemId)));
    if (upload) await storeProjectFile(client, row.id, 'request', itemId, upload, 'CLIENT');
    return next;
  }, 'Client submitted a project request response');
}
export async function reviewProjectDeliverableAction(form: FormData) {
  return portalProjectMutation(form, async (_client, row) => {
    const decision = projectFormValue(form, 'decision', 40);
    if (!['APPROVED', 'CHANGES_REQUESTED'].includes(decision)) throw new Error('Please check your review decision.');
    return applyDeliverableReview(row.data, projectFormValue(form, 'itemId', 100), Number(form.get('version')),
      decision as 'APPROVED' | 'CHANGES_REQUESTED', projectFormValue(form, 'feedback'));
  }, 'Client reviewed a deliverable version');
}
export async function reportProjectSetupAction(form: FormData) {
  return portalProjectMutation(form, async (_client, row) => reportClientSetup(row.data, projectFormValue(form, 'itemId', 100)), 'Client reported setup ready for verification');
}
export async function reportProjectAccessAction(form: FormData) {
  return portalProjectMutation(form, async (_client, row) => {
    const itemId = projectFormValue(form, 'itemId', 100);
    const item = row.data.onboarding?.access.find(item => item.id === itemId);
    if (!item || ['VERIFIED', 'NOT_NEEDED', 'RECEIVED'].includes(item.status)) throw new Error('This access task is no longer open.');
    return { ...row.data, onboarding: { ...row.data.onboarding!, access: row.data.onboarding!.access.map(old => old.id === itemId ? { ...old, status: 'RECEIVED' as const } : old) } };
  }, 'Client reported access granted');
}
