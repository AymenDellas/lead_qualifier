import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/pg_setup';
import { requireWorkerAdmin } from '@/lib/worker-admin';
import { queueStatus, jobStatus, enqueue } from '@/lib/linkedin-workers.cjs';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
 await requireWorkerAdmin();
 const id=request.nextUrl.searchParams.get('jobId');
 if (id) {
  const result=await jobStatus(pool,id);
  return NextResponse.json(result,{status:result.status==='not_found'?404:200});
 }
 const result=await queueStatus(pool);
 return NextResponse.json({...result,worker:result.workerStatus});
}
export async function POST(request: Request) {
 await requireWorkerAdmin();
 try {
  const body=await request.json();
  const result=await enqueue(pool,[body.linkedinUrl],{nativePostProcess:!!body.nativePostProcess,targetRegion:body.targetRegion});
  if (!result.jobs.length) throw new Error(result.skipped[0]?.reason || 'Could not queue this profile.');
  return NextResponse.json({jobId:result.jobs[0],status:'queued',pollUrl:`/api/process-lead?jobId=${result.jobs[0]}`});
 }catch(error){return NextResponse.json({error:error instanceof Error ? error.message : 'Could not queue this profile.'},{status:400});}
}
