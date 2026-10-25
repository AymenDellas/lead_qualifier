import {NextResponse} from 'next/server';
import {pool} from '@/lib/pg_setup';
import {requireWorkerAdmin} from '@/lib/worker-admin';
import {recheckFollowers} from '@/lib/follower-recheck.cjs';
export const runtime='nodejs';
export async function POST(request:Request){
 try{await requireWorkerAdmin();const origin=request.headers.get('origin');if(!origin||new URL(origin).origin!==new URL(request.url).origin||request.headers.get('sec-fetch-site')==='cross-site')throw Error('Use the local CRM to request follower rechecks.');}
 catch{return NextResponse.json({error:'Follower rechecks are available from the local worker dashboard.'},{status:403});}
 try{const body=await request.json();if(!body||Object.keys(body).some(key=>key!=='ids'))throw Error('Expected selected CRM lead IDs.');return NextResponse.json(await recheckFollowers(pool,body.ids));}
 catch(error){return NextResponse.json({error:error instanceof Error?error.message:'Could not queue follower rechecks.'},{status:400});}
}
