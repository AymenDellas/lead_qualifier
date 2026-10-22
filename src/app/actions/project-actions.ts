'use server';
import { requireAdmin } from '@/lib/project-workspace-auth';
import { revalidatePath } from 'next/cache';
import { businessTransaction, mapProject, recordActivity } from '@/lib/business-store';
import { validateProject } from '@/lib/business-validation';
import { prepareWorkspaceSave, type WorkspaceEdit } from '@/lib/project-workspace';
import { isProjectId, projectFiles, readUpload, storeProjectFile } from '@/lib/project-files';
import type { ProjectData } from '@/lib/business';

export async function saveProjectWorkspaceAction(id: string, expectedRevision: number, edit: WorkspaceEdit) {
  await requireAdmin();
  if (!isProjectId(id)) throw new Error('Choose a valid project.');
  const saved = await businessTransaction(async client => {
    const result = await client.query('SELECT * FROM business_projects WHERE id=$1 FOR UPDATE', [id]);
    const row = result.rows[0];
    if (!row || row.revision !== expectedRevision) throw new Error('This project changed. Reload saved data before saving.');
    const next = prepareWorkspaceSave(row.data, edit);
    const files = await projectFiles(client, id);
    if (next.deliverables.some(item => item.visibleToClient && item.status === 'REVIEW' && !item.content.trim() && !item.url.trim()
      && !files.some(file => file.kind === 'deliverable' && file.itemId === item.id)))
      throw new Error('Add content, a link or a file before asking the client to review a deliverable.');
    validateProject(next);
    const updated = await client.query('UPDATE business_projects SET data=$2,revision=revision+1,updated_at=NOW() WHERE id=$1 RETURNING *', [id, JSON.stringify(next)]);
    await recordActivity(client, row.opportunity_id, 'DELIVERY', 'Project deliverables, requests and setup updated');
    return mapProject(updated.rows[0]);
  });
  if (saved.data.onboarding?.portalToken) revalidatePath(`/portal/${saved.data.onboarding.portalToken}/project`);
  return saved;
}
export async function loadProjectFilesAction(id: string) {
  await requireAdmin();
  if (!isProjectId(id)) throw new Error('Choose a valid project.');
  return businessTransaction(client => projectFiles(client, id));
}
export async function uploadProjectFileAction(form: FormData) {
  await requireAdmin();
  const projectId = String(form.get('projectId') || '');
  const itemId = String(form.get('itemId') || '');
  const kind = String(form.get('kind') || '');
  const revision = Number(form.get('revision'));
  if (!isProjectId(projectId) || !['deliverable', 'request'].includes(kind)) throw new Error('Choose a valid project item.');
  const upload = await readUpload(form.get('file'));
  if (!upload) throw new Error('Choose a file first.');
  await businessTransaction(async client => {
    const result = await client.query('SELECT * FROM business_projects WHERE id=$1 FOR UPDATE', [projectId]);
    const row = result.rows[0];
    if (!row || row.revision !== revision) throw new Error('This project changed. Reload saved data before uploading.');
    const project = row.data as ProjectData;
    if (kind !== 'deliverable' || !project.deliverables.some(item => item.id === itemId)) throw new Error('Upload project output to a saved deliverable. Client files are submitted through their requests.');
    await storeProjectFile(client, projectId, 'deliverable', itemId, upload, 'COMPEL');
    const next = { ...project, deliverables: project.deliverables.map(item => item.id === itemId ? { ...item, version: (item.version || 1) + 1,
      status: item.visibleToClient && item.status === 'DONE' ? 'REVIEW' as const : item.status } : item) };
    validateProject(next);
    await client.query('UPDATE business_projects SET data=$2,revision=revision+1,updated_at=NOW() WHERE id=$1', [projectId, JSON.stringify(next)]);
    await recordActivity(client, row.opportunity_id, 'DELIVERY', `Added file: ${upload.name}`);
    if (project.onboarding?.portalToken) revalidatePath(`/portal/${project.onboarding.portalToken}/project`);
  });
}
export async function archiveProjectFileAction(projectId: string, fileId: string, revision: number) {
  await requireAdmin();
  if (!isProjectId(projectId) || !isProjectId(fileId)) throw new Error('Choose a valid file.');
  await businessTransaction(async client => {
    const result = await client.query('SELECT * FROM business_projects WHERE id=$1 FOR UPDATE', [projectId]);
    const row = result.rows[0];
    if (!row || row.revision !== revision) throw new Error('This project changed. Reload saved data before removing a file.');
    const file = await client.query('UPDATE business_project_files SET archived=TRUE WHERE id=$1 AND project_id=$2 AND NOT archived RETURNING item_id,kind', [fileId, projectId]);
    if (!file.rows[0]) throw new Error('File not found.');
    const project = row.data as ProjectData;
    if (file.rows[0].kind === 'request') throw new Error('Client submissions are retained with their request.');
    const remainingFiles = await projectFiles(client, projectId);
    const next = { ...project, deliverables: project.deliverables.map(item => item.id === file.rows[0].item_id ? { ...item, version: (item.version || 1) + 1,
      status: item.visibleToClient && ['DONE', 'REVIEW'].includes(item.status)
        ? !item.content.trim() && !item.url.trim() && !remainingFiles.some(file => file.kind === 'deliverable' && file.itemId === item.id)
          ? 'DOING' as const : 'REVIEW' as const
        : item.status } : item) };
    validateProject(next);
    await client.query('UPDATE business_projects SET data=$2,revision=revision+1,updated_at=NOW() WHERE id=$1', [projectId, JSON.stringify(next)]);
    await recordActivity(client, row.opportunity_id, 'DELIVERY', 'Removed a deliverable file from the shared workspace');
    if (project.onboarding?.portalToken) revalidatePath(`/portal/${project.onboarding.portalToken}/project`);
  });
}
