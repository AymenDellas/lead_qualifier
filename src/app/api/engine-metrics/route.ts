import {NextResponse} from 'next/server';
import {pool} from '@/lib/pg_setup';
import {requireWorkerAdmin} from '@/lib/worker-admin';
import {readMetrics} from '@/lib/engine-telemetry.cjs';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export async function GET(request:Request){
 try{await requireWorkerAdmin();}catch{return NextResponse.json({error:'Use the local Compel dashboard to view engine measurements.'},{status:403});}
 try{
  const batchId=new URL(request.url).searchParams.get('batch');
  if(batchId&&!/^[a-zA-Z0-9_-]{1,100}$/.test(batchId))return NextResponse.json({error:'Invalid batch identifier.'},{status:400});
  return NextResponse.json(await readMetrics(pool,{batchId}),{headers:{'Cache-Control':'no-store'}});
 }catch{return NextResponse.json({error:'Engine measurements are unavailable. Check the database connection.'},{status:503});}
}
