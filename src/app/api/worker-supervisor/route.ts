import {NextResponse} from 'next/server';
import {pool} from '@/lib/pg_setup';
import {requireWorkerAdmin} from '@/lib/worker-admin';
import {createWorkerSupervisorController} from '@/lib/worker-supervisor-control.cjs';
import type {QueryConfig} from 'pg';

export const dynamic='force-dynamic';
export const runtime='nodejs';
const supervisor=createWorkerSupervisorController({isOnline:async()=>{
    try {
        const query:QueryConfig&{query_timeout:number}={text:`SELECT supervisor_seen_at>NOW()-interval '45 seconds' AS online FROM compel_worker_config WHERE id=1`,query_timeout:5000};
        const result=await pool.query<{online:boolean}>(query);
        return result.rows[0]?.online===true;
    } catch(error) {
        if(['42P01','42703'].includes((error as {code?:string}).code||''))return false;
        throw new Error('Could not check worker status. Try again when the database is available.');
    }
}});
async function authorize(request:Request,mutation=false) {
    await requireWorkerAdmin();
    if(mutation) {
        const origin=request.headers.get('origin');
        if(!origin||new URL(origin).origin!==new URL(request.url).origin||request.headers.get('sec-fetch-site')==='cross-site')
            throw new Error('Start workers from the local Compel app.');
    }
}
export async function GET(request:Request) {
    try{await authorize(request);}catch{return NextResponse.json({error:'Worker controls are available only from the local app.'},{status:403});}
    try{return NextResponse.json(await supervisor.status(),{headers:{'Cache-Control':'no-store'}});}
    catch(error){return NextResponse.json({error:error instanceof Error?error.message:'Could not check workers.'},{status:503});}
}
export async function POST(request:Request) {
    try{await authorize(request,true);}catch{return NextResponse.json({error:'Start workers from the local Compel app.'},{status:403});}
    try {
        if(!request.headers.get('content-type')?.startsWith('application/json'))return NextResponse.json({error:'Expected a worker start request.'},{status:400});
        const body=await request.json();
        if(!body||body.action!=='start'||Object.keys(body).some(key=>key!=='action'))return NextResponse.json({error:'Only the worker start action is supported.'},{status:400});
        const state=await supervisor.start();
        return NextResponse.json(state,{status:state.state==='unavailable'?409:state.state==='starting'?202:200,headers:{'Cache-Control':'no-store'}});
    } catch(error){return NextResponse.json({error:error instanceof Error?error.message:'Could not start workers.'},{status:503});}
}
