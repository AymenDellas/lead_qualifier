import { handleCopyStudio } from '@/lib/copy-studio/server/http';
import { readCopyStudioOnboardings } from '@/lib/copy-studio/server/onboarding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

type Context = { params: Promise<{ operation: string }> };
export async function GET(request: Request, context: Context) {
  const { operation } = await context.params;
  if (operation === 'onboardings') {
    try {
      return Response.json({ onboardings: await readCopyStudioOnboardings() }, { headers: { 'Cache-Control': 'no-store' } });
    } catch {
      return Response.json({ error: 'Onboarding could not be loaded. Retry or continue with a manual brief.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
  }
  return handleCopyStudio(request, operation);
}
export async function POST(request: Request, context: Context) {
  return handleCopyStudio(request, (await context.params).operation);
}
