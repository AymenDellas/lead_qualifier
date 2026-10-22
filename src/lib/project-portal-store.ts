import type { PoolClient } from 'pg';
import { revalidatePath } from 'next/cache';
import { normalizeOnboarding, onboardingBlockers, type ProjectData } from './business';
import { businessTransaction, recordActivity } from './business-store';
import { validateProject } from './business-validation';
import { clientProjectView } from './project-workspace';
import { isProjectId, projectFiles } from './project-files';

export type ProjectActionResult = { ok: boolean; message: string };
export const projectFormValue = (form: FormData, key: string, max = 20_000) => {
  const value = form.get(key);
  if (typeof value !== 'string' || value.length > max) throw new Error('Please check the form and try again.');
  return value.trim();
};
export async function readProjectPortal(token: string) {
  if (!isProjectId(token)) return null;
  return businessTransaction(async client => {
    const result = await client.query(`SELECT p.*,o.data AS opportunity,v.profile FROM business_projects p
      JOIN business_opportunities o ON o.id=p.opportunity_id JOIN business_offer_versions v ON v.version=p.offer_version
      WHERE p.data->'onboarding'->>'portalToken'=$1`, [token]);
    const row = result.rows[0];
    if (!row) return null;
    const project = row.data as ProjectData;
    const onboarding = normalizeOnboarding(project, row.opportunity, row.profile);
    const view = clientProjectView(project, onboarding);
    const files = (await projectFiles(client, row.id)).filter(file => file.kind === 'request'
      ? view.requests.some(item => item.id === file.itemId) : view.deliverables.some(item => item.id === file.itemId));
    return { view, files, onboardingTasks: onboardingBlockers(onboarding, 'client').map(item => ({ key: item.key, label: item.label, detail: item.detail })) };
  });
}
export async function portalProjectMutation(form: FormData,
  work: (client: PoolClient, row: { id: string; opportunity_id: string; data: ProjectData }) => Promise<ProjectData>, note: string): Promise<ProjectActionResult> {
  try {
    const token = projectFormValue(form, 'token', 100);
    if (!isProjectId(token)) throw new Error('This project link is invalid.');
    await businessTransaction(async client => {
      const result = await client.query("SELECT * FROM business_projects WHERE data->'onboarding'->>'portalToken'=$1 FOR UPDATE", [token]);
      const row = result.rows[0];
      if (!row) throw new Error('This project link is no longer available.');
      const next = await work(client, row);
      validateProject(next);
      await client.query('UPDATE business_projects SET data=$2,revision=revision+1,updated_at=NOW() WHERE id=$1', [row.id, JSON.stringify(next)]);
      await recordActivity(client, row.opportunity_id, 'DELIVERY', note);
    });
    revalidatePath(`/portal/${token}/project`);
    revalidatePath(`/portal/${token}`);
    return { ok: true, message: 'Saved. Your project team can see this update.' };
  } catch (error) {
    // Domain/validation errors are useful; infrastructure details never belong in a public response.
    const message = error instanceof Error && /^(This |Add |Tell us |Use |Links must |The file |Each |Contact your |Please check)/.test(error.message)
      ? error.message : 'We could not save this update. Your answers are still here. Please try again.';
    return { ok: false, message };
  }
}
