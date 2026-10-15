import { NextResponse } from 'next/server';
import { pool } from '@/lib/pg_setup';
import { requireWorkerAdmin } from '@/lib/worker-admin';
import { enqueue, retryFailed } from '@/lib/linkedin-workers.cjs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
 await requireWorkerAdmin();
 try {
  const body=await request.json();
  if(body.action==='retry_failed')return NextResponse.json({status:'success',...await retryFailed(pool)});
  const result=await enqueue(pool,body.urls,{nativePostProcess:!!body.nativePostProcess,targetRegion:body.targetRegion});
  return NextResponse.json({status:'success',...result});
 }catch(error){return NextResponse.json({error:error instanceof Error ? error.message : 'Could not queue profiles.'},{status:400});}
}
