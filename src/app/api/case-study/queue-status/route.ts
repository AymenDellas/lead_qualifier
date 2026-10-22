import {requireWorkerAdmin} from '@/lib/worker-admin';
import {pool} from '@/lib/pg_setup';
import {queueStatus} from '@/lib/linkedin-workers.cjs';
import {NextResponse} from 'next/server';
export const dynamic='force-dynamic';
export async function GET(){
 await requireWorkerAdmin();
 const data=await queueStatus(pool),status=data.workerStatus;
 const last=data.recentResults?.[0];
 return NextResponse.json({...data,workerStatus:{...status,status:status.status==='processing'?'WORKING':status.status==='ready'?'READY':String(status.status).toUpperCase(),currentProfile:status.url,lastCompletedJobId:last?.jobId||'',lastCompletedAt:last?.completedAt||''}},{headers:{'Cache-Control':'private, no-store'}});
}
