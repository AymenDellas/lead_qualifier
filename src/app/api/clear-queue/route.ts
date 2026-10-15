import { NextResponse } from 'next/server';
import { pool } from '@/lib/pg_setup';
import { requireWorkerAdmin } from '@/lib/worker-admin';
import { clearQueue } from '@/lib/linkedin-workers.cjs';
export const dynamic = 'force-dynamic';
export async function POST() {
 await requireWorkerAdmin();
 const deletedCount=await clearQueue(pool);
 return NextResponse.json({status:'success',deletedCount,message:`Cleared ${deletedCount} waiting jobs. Running jobs will finish.`});
}
