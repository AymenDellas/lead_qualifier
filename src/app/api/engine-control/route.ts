import {NextResponse} from 'next/server';
import {pool} from '@/lib/pg_setup';
import {requireWorkerAdmin} from '@/lib/worker-admin';
import {controlEngine} from '@/lib/engine-controls.cjs';
import {queueStatus} from '@/lib/linkedin-workers.cjs';

export const dynamic='force-dynamic';
export async function POST(request:Request) {
 await requireWorkerAdmin();
 try {
  const origin=request.headers.get('origin');
  if(!origin||new URL(origin).origin!==new URL(request.url).origin||request.headers.get('sec-fetch-site')==='cross-site')return NextResponse.json({error:'Use the Engine controls in this app.'},{status:403});
  if(!request.headers.get('content-type')?.startsWith('application/json'))throw new Error('Expected an Engine control request.');
  const body=await request.json();
  if(!body||!['resume','pause'].includes(body.action)||Object.keys(body).some(key=>key!=='action'))throw new Error('Choose Resume or Pause.');
  const control=await controlEngine(pool,body.action);
  return NextResponse.json({...await queueStatus(pool),control},{headers:{'Cache-Control':'no-store'}});
 }catch(error){return NextResponse.json({error:error instanceof Error?error.message:'Could not update processing.'},{status:400});}
}
