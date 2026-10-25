import { NextResponse } from 'next/server';
import { pool } from '@/lib/pg_setup';
import { requireWorkerAdmin } from '@/lib/worker-admin';
import { queueStatus } from '@/lib/linkedin-workers.cjs';
export const dynamic = 'force-dynamic';
export async function GET(request:Request) {
 await requireWorkerAdmin();
 const includeHistory=!request?.url||new URL(request.url).searchParams.get('history')!=='0';
 return NextResponse.json(await queueStatus(pool,{includeHistory}),{headers:{'Cache-Control':'no-store'}});
}
