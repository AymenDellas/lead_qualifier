import { z } from 'zod/v4';
import type { Deliverable, OnboardingData, ProjectData } from './business';

export const MAX_PROJECT_FILE_BYTES = 3 * 1024 * 1024;
export const PROJECT_FILE_EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'svg', 'txt', 'md', 'docx', 'xlsx', 'pptx', 'csv', 'zip', 'html', 'css', 'json'];
export const PROJECT_STATUS_LABELS = { ONBOARDING: 'Preparing to start', BUILDING: 'In progress', APPROVAL: 'Ready for review', LIVE: 'Live', COMPLETE: 'Complete' } as const;
export const DELIVERABLE_STATUS_LABELS = { TODO: 'Planned', DOING: 'In progress', BLOCKED: 'Waiting on something', REVIEW: 'Ready for your review', DONE: 'Complete' } as const;
export const REQUEST_STATUS_LABELS = { REQUESTED: 'Needs your response', SUBMITTED: 'Submitted for review', CHANGES_REQUESTED: 'Please update your response', COMPLETE: 'Complete' } as const;
export const SETUP_STATUS_LABELS = { TODO: 'To do', DOING: 'In progress', WAITING: 'Waiting for verification', DONE: 'Complete' } as const;
export type DeliverableReview = { version: number; decision: 'APPROVED' | 'CHANGES_REQUESTED'; feedback: string; createdAt: string };
export type DeliveryRequest = {
  id: string; title: string; instructions: string; responseType: 'TEXT' | 'LINK' | 'FILE' | 'ANY';
  dueAt: string; required: boolean; status: keyof typeof REQUEST_STATUS_LABELS; version: number;
  response: string; responseUrl: string; responseRevision: number; submittedAt: string; feedback: string;
};
export type SetupTask = { id: string; title: string; instructions: string; owner: 'COMPEL' | 'CLIENT'; status: keyof typeof SETUP_STATUS_LABELS; dueAt: string; clientReportedAt: string };
export type DeliveryWorkspace = { requests: DeliveryRequest[]; setup: SetupTask[]; internalNotes: string };
export type ProjectFile = { id: string; projectId: string; itemId: string; kind: 'deliverable' | 'request'; name: string; size: number; createdAt: string; uploadedBy: 'COMPEL' | 'CLIENT' };

const id = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/);
const text = z.string().max(20_000);
const title = z.string().trim().min(1, 'Add a title.').max(200);
const date = z.string().max(50).refine(value => !value || Number.isFinite(Date.parse(value)), 'Enter a valid date.');
const url = z.string().max(2000).refine(value => {
  if (!value) return true;
  try { const parsed = new URL(value); return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password; }
  catch { return false; }
}, 'Links must start with https:// or http:// and contain no credentials.');
const reviewSchema = z.object({ version: z.number().int().positive(), decision: z.enum(['APPROVED', 'CHANGES_REQUESTED']), feedback: text, createdAt: date });
export const deliveryWorkspaceSchema = z.object({
  requests: z.array(z.object({ id, title, instructions: text, responseType: z.enum(['TEXT', 'LINK', 'FILE', 'ANY']), dueAt: date, required: z.boolean(),
    status: z.enum(['REQUESTED', 'SUBMITTED', 'CHANGES_REQUESTED', 'COMPLETE']), version: z.number().int().positive(),
    response: text, responseUrl: url, responseRevision: z.number().int().nonnegative(), submittedAt: date, feedback: text })).max(100),
  setup: z.array(z.object({ id, title, instructions: text, owner: z.enum(['COMPEL', 'CLIENT']),
    status: z.enum(['TODO', 'DOING', 'WAITING', 'DONE']), dueAt: date, clientReportedAt: date })).max(100), internalNotes: text,
});
export const workspaceEditSchema = z.object({
  status: z.enum(['ONBOARDING', 'BUILDING', 'APPROVAL', 'LIVE', 'COMPLETE']), launchAt: date, internalNotes: text,
  deliverables: z.array(z.object({ id, title, content: z.string().max(100_000), url, dueAt: date,
    status: z.enum(['TODO', 'DOING', 'BLOCKED', 'REVIEW', 'DONE']), visibleToClient: z.boolean() })).max(100),
  requests: z.array(z.object({ id, title, instructions: text, responseType: z.enum(['TEXT', 'LINK', 'FILE', 'ANY']),
    dueAt: date, required: z.boolean(), status: z.enum(['REQUESTED', 'SUBMITTED', 'CHANGES_REQUESTED', 'COMPLETE']), feedback: text })).max(100),
  setup: z.array(z.object({ id, title, instructions: text, owner: z.enum(['COMPEL', 'CLIENT']), status: z.enum(['TODO', 'DOING', 'WAITING', 'DONE']), dueAt: date })).max(100),
});
export type WorkspaceEdit = z.infer<typeof workspaceEditSchema>;
export function deliveryWorkspace(project: ProjectData): DeliveryWorkspace {
  return project.delivery || { requests: [], setup: [], internalNotes: '' };
}
export function validateDeliveryData(project: ProjectData) {
  if (project.delivery) deliveryWorkspaceSchema.parse(project.delivery);
  for (const item of project.deliverables || []) {
    if (item.visibleToClient !== undefined) z.boolean().parse(item.visibleToClient);
    if (item.version !== undefined) z.number().int().positive().parse(item.version);
    if (item.reviews !== undefined) z.array(reviewSchema).max(100).parse(item.reviews);
  }
  for (const list of [project.deliverables || [], deliveryWorkspace(project).requests, deliveryWorkspace(project).setup])
    if (new Set(list.map(item => item.id)).size !== list.length) throw new Error('Each item needs a unique ID.');
}
export function workspaceEdit(project: ProjectData): WorkspaceEdit {
  const delivery = deliveryWorkspace(project);
  return { status: project.status, launchAt: project.launchAt, internalNotes: delivery.internalNotes,
    deliverables: project.deliverables.map(({ id, title, content, url, dueAt, status, visibleToClient }) => ({ id, title, content, url, dueAt, status, visibleToClient: visibleToClient === true })),
    requests: delivery.requests.map(({ id, title, instructions, responseType, dueAt, required, status, feedback }) => ({ id, title, instructions, responseType, dueAt, required, status, feedback })),
    setup: delivery.setup.map(({ id, title, instructions, owner, status, dueAt }) => ({ id, title, instructions, owner, status, dueAt })) };
}
const changed = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);
export function prepareWorkspaceSave(project: ProjectData, raw: unknown): ProjectData {
  const edit = workspaceEditSchema.parse(raw);
  const previous = deliveryWorkspace(project);
  // Closing or unpublishing retains client responses and review history.
  for (const [oldList, newList] of [[project.deliverables, edit.deliverables], [previous.requests, edit.requests], [previous.setup, edit.setup]] as const)
    if (oldList.some(old => !newList.some(item => item.id === old.id))) throw new Error('Keep saved items. Complete requests or unpublish deliverables instead of deleting them.');
  const deliverables = edit.deliverables.map(item => {
    const old = project.deliverables.find(saved => saved.id === item.id);
    const contentChanged = old && changed([old.title, old.content, old.url, old.visibleToClient === true], [item.title, item.content, item.url, item.visibleToClient]);
    const reopened = old && item.status === 'REVIEW' && old.status !== 'REVIEW';
    return { ...item, version: old ? (old.version || 1) + (contentChanged || reopened ? 1 : 0) : 1, reviews: old?.reviews || [],
      status: contentChanged && item.visibleToClient && item.status === 'DONE' ? 'REVIEW' as const : item.status };
  });
  const requests = edit.requests.map(item => {
    const old = previous.requests.find(saved => saved.id === item.id);
    if (item.status === 'SUBMITTED' && !old?.submittedAt) throw new Error('Submitted status comes from the client response.');
    if (item.status === 'CHANGES_REQUESTED' && !item.feedback.trim()) throw new Error('Explain what the client needs to change.');
    const instructionsChanged = old && changed([old.title, old.instructions, old.responseType, old.required], [item.title, item.instructions, item.responseType, item.required]);
    return { ...item, version: old ? old.version + (instructionsChanged ? 1 : 0) : 1,
      response: old?.response || '', responseUrl: old?.responseUrl || '', responseRevision: old?.responseRevision || 0, submittedAt: old?.submittedAt || '',
      status: instructionsChanged && ['COMPLETE', 'SUBMITTED'].includes(item.status) ? 'REQUESTED' as const : item.status };
  });
  const setup = edit.setup.map(item => ({ ...item, clientReportedAt: previous.setup.find(old => old.id === item.id)?.clientReportedAt || '' }));
  const next = { ...project, status: edit.status, launchAt: edit.launchAt, deliverables, delivery: { requests, setup, internalNotes: edit.internalNotes } };
  validateDeliveryData(next);
  return next;
}
export function currentReview(item: Pick<Deliverable, 'version' | 'reviews'>) {
  return [...(item.reviews || [])].reverse().find(review => review.version === (item.version || 1));
}
export function applyDeliverableReview(project: ProjectData, itemId: string, version: number, decision: 'APPROVED' | 'CHANGES_REQUESTED', feedback: string, now = new Date().toISOString()): ProjectData {
  const item = project.deliverables.find(item => item.id === itemId && item.visibleToClient);
  if (!item || item.status !== 'REVIEW') throw new Error('This deliverable is not currently open for review.');
  if ((item.version || 1) !== version) throw new Error('This deliverable changed. Reload and review the latest version.');
  if (decision === 'CHANGES_REQUESTED' && !feedback.trim()) throw new Error('Tell us what you would like changed.');
  text.parse(feedback);
  if ((item.reviews?.length || 0) >= 100) throw new Error('Contact your project lead to continue this review.');
  const next = { ...item, status: decision === 'APPROVED' ? 'DONE' as const : 'DOING' as const,
    reviews: [...(item.reviews || []), { version, decision, feedback, createdAt: now }] };
  return { ...project, deliverables: project.deliverables.map(old => old.id === itemId ? next : old) };
}
export function applyClientResponse(project: ProjectData, itemId: string, version: number, responseRevision: number, response: string, responseUrl: string, hasFile: boolean, now = new Date().toISOString()): ProjectData {
  const delivery = deliveryWorkspace(project);
  const item = delivery.requests.find(item => item.id === itemId);
  if (!item || item.status === 'COMPLETE') throw new Error('This request is no longer open.');
  if (item.version !== version || item.responseRevision !== responseRevision) throw new Error('This request changed. Reload before submitting again.');
  text.parse(response); url.parse(responseUrl);
  if ((item.responseType === 'TEXT' && !response.trim()) || (item.responseType === 'LINK' && !responseUrl.trim()) || (item.responseType === 'FILE' && !hasFile)
    || (item.responseType === 'ANY' && !response.trim() && !responseUrl.trim() && !hasFile))
    throw new Error(`Add ${item.responseType === 'FILE' ? 'a file' : item.responseType === 'LINK' ? 'a link' : item.responseType === 'TEXT' ? 'your answer' : 'an answer, link or file'} before submitting.`);
  return { ...project, delivery: { ...delivery, requests: delivery.requests.map(old => old.id === itemId
    ? { ...old, response, responseUrl, responseRevision: old.responseRevision + 1, submittedAt: now, status: 'SUBMITTED' as const } : old) } };
}
export function reportClientSetup(project: ProjectData, itemId: string): ProjectData {
  const delivery = deliveryWorkspace(project);
  const item = delivery.setup.find(item => item.id === itemId && item.owner === 'CLIENT');
  if (!item || ['DONE', 'WAITING'].includes(item.status)) throw new Error('This setup task is no longer open.');
  return { ...project, delivery: { ...delivery, setup: delivery.setup.map(old => old.id === itemId
    ? { ...old, status: 'WAITING' as const, clientReportedAt: new Date().toISOString() } : old) } };
}
export function clientProjectView(project: ProjectData, onboarding: OnboardingData) {
  const delivery = deliveryWorkspace(project);
  return {
    name: onboarding.projectName || project.name, clientName: onboarding.clientName, status: project.status, launchAt: project.launchAt,
    scope: { included: onboarding.scope.included, excluded: onboarding.scope.excluded, confirmed: onboarding.scope.confirmed },
    deliverables: project.deliverables.filter(item => item.visibleToClient === true).map(({ id, title, content, url, dueAt, status, version, reviews }) =>
      ({ id, title, content, url, dueAt, status, version: version || 1, reviews: reviews || [] })), requests: delivery.requests, setup: delivery.setup,
    access: onboarding.access.map(({ id, platform, instructions, reason, permission, status, required, nonBlocking }) => ({ id, platform, instructions, reason, permission, status, required, nonBlocking })),
  };
}
export type ClientProjectView = ReturnType<typeof clientProjectView>;
export const formatProjectDate = (value: string) => value ? new Date(value.length === 10 ? `${value}T12:00:00Z` : value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '';
