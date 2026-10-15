import { NextResponse } from 'next/server';
import { pool } from '@/lib/pg_setup';
import { requireWorkerAdmin } from '@/lib/worker-admin';
import { queueStatus } from '@/lib/linkedin-workers.cjs';
export const dynamic = 'force-dynamic';
export async function GET() {
 await requireWorkerAdmin();
 return NextResponse.json(await queueStatus(pool),{headers:{'Cache-Control':'no-store'}});
}
