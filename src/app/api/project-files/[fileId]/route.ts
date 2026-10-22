import { requireAdmin } from '@/lib/project-workspace-auth';
import { businessTransaction } from '@/lib/business-store';
import { fileDownload, isProjectId } from '@/lib/project-files';
export const dynamic = 'force-dynamic';
export async function GET(_request: Request, { params }: { params: Promise<{ fileId: string }> }) {
  await requireAdmin();
  const { fileId } = await params;
  if (!isProjectId(fileId)) return new Response('File not found.', { status: 404 });
  return businessTransaction(async client => {
    const result = await client.query('SELECT bytes,file_name FROM business_project_files WHERE id=$1 AND NOT archived', [fileId]);
    return result.rows[0] ? fileDownload(result.rows[0].bytes, result.rows[0].file_name) : new Response('File not found.', { status: 404 });
  });
}
