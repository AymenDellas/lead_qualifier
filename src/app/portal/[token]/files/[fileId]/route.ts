import { businessTransaction } from '@/lib/business-store';
import { fileDownload, isProjectId } from '@/lib/project-files';
import type { ProjectData } from '@/lib/business';
export const dynamic = 'force-dynamic';
export async function GET(_request: Request, { params }: { params: Promise<{ token: string; fileId: string }> }) {
  const { token, fileId } = await params;
  if (!isProjectId(token) || !isProjectId(fileId)) return new Response('File not found.', { status: 404 });
  return businessTransaction(async client => {
    const result = await client.query(`SELECT f.*,p.data AS project FROM business_project_files f JOIN business_projects p ON p.id=f.project_id
      WHERE f.id=$1 AND NOT f.archived AND p.data->'onboarding'->>'portalToken'=$2`, [fileId, token]);
    const row = result.rows[0];
    const project = row?.project as ProjectData | undefined;
    const visible = project && (row.kind === 'request' ? project.delivery?.requests.some(item => item.id === row.item_id)
      : project.deliverables.some(item => item.id === row.item_id && item.visibleToClient));
    return row && visible ? fileDownload(row.bytes, row.file_name) : new Response('File not found.', { status: 404 });
  });
}
