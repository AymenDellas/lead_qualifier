import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { MAX_PROJECT_FILE_BYTES, PROJECT_FILE_EXTENSIONS, type ProjectFile } from './project-workspace';

export const isProjectId = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const metadata = (row: any): ProjectFile => ({ id: row.id, projectId: row.project_id, itemId: row.item_id, kind: row.kind,
  name: row.file_name, size: row.size, uploadedBy: row.uploaded_by, createdAt: new Date(row.created_at).toISOString() });
export async function projectFiles(client: PoolClient, projectId: string): Promise<ProjectFile[]> {
  const result = await client.query('SELECT id,project_id,item_id,kind,file_name,size,uploaded_by,created_at FROM business_project_files WHERE project_id=$1 AND NOT archived ORDER BY created_at DESC', [projectId]);
  return result.rows.map(metadata);
}
export async function readUpload(value: FormDataEntryValue | null) {
  if (!(value instanceof File) || !value.size) return null;
  if (value.size > MAX_PROJECT_FILE_BYTES) throw new Error('Use a file smaller than 3 MB. For larger files, share a link.');
  const name = value.name.replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 180);
  if (!PROJECT_FILE_EXTENSIONS.includes(name.split('.').at(-1)?.toLowerCase() || '')) throw new Error('Use a document, image, text file or ZIP archive.');
  const bytes = Buffer.from(await value.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_PROJECT_FILE_BYTES) throw new Error('The file could not be read or is too large.');
  return { id: randomUUID(), name, bytes };
}
export async function storeProjectFile(client: PoolClient, projectId: string, kind: ProjectFile['kind'], itemId: string,
  upload: NonNullable<Awaited<ReturnType<typeof readUpload>>>, uploadedBy: ProjectFile['uploadedBy']) {
  const count = await client.query('SELECT COUNT(*)::int AS count FROM business_project_files WHERE project_id=$1 AND NOT archived', [projectId]);
  if (count.rows[0].count >= 100) throw new Error('This project already has 100 files. Remove an old file or share a link.');
  await client.query('INSERT INTO business_project_files(id,project_id,item_id,kind,file_name,bytes,size,uploaded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [upload.id, projectId, itemId, kind, upload.name, upload.bytes, upload.bytes.length, uploadedBy]);
}
export function fileDownload(bytes: Uint8Array, name: string): Response {
  return new Response(new Uint8Array(bytes), { headers: {
    'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox",
  } });
}
