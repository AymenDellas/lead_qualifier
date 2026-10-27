import { NextResponse } from 'next/server';
import { pool } from '@/lib/pg_setup';
import { requireWorkerAdmin } from '@/lib/worker-admin';
import { settings, requestLogin, startProcessing, pauseProcessing, accountEvents } from '@/lib/linkedin-workers.cjs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
 await requireWorkerAdmin();
 const account=new URL(request.url).searchParams.get('events');
 if(account){
  if(!/^(?:legacy-\d+|[a-f0-9-]{36})$/.test(account))return NextResponse.json({error:'Invalid account.'},{status:400});
  return NextResponse.json(await accountEvents(pool,account),{headers:{'Cache-Control':'no-store'}});
 }
 return NextResponse.json(await settings(pool), { headers: { 'Cache-Control': 'no-store' } });
}
export async function PUT(request: Request) {
 await requireWorkerAdmin();
 void request;
 // LEGACY: saveSettings(pool, body) previously edited Chrome account credentials.
 return NextResponse.json({error:'Manage linked AliasMode profiles through /api/aliasmode.'},{status:409});
}
export async function POST(request: Request) {
 await requireWorkerAdmin();
 try {
  const origin=request.headers.get('origin');
  if(!origin||new URL(origin).origin!==new URL(request.url).origin||request.headers.get('sec-fetch-site')==='cross-site')return NextResponse.json({error:'Use the account controls in the local app.'},{status:403});
  const {id,action} = await request.json();
  if (typeof id !== 'string' || !/^(?:legacy-\d+|[a-f0-9-]{36})$/.test(id)) throw new Error('Invalid account.');
  if (action==='logout') {
   return NextResponse.json({error:'Sign out manually in AliasMode. Closing a profile preserves its LinkedIn sign-in.'},{status:409});
  }
  const account=(await settings(pool)).accounts.find(a=>a.id===id);
  if(action!=='pause'&&!account?.aliasmodeProfileId)throw Error('Link an AliasMode profile before opening or starting this account.');
  if(action==='start'&&account?.closePending)throw Error('Wait for profile closure before starting.');
  if(action==='start'){
   await startProcessing(pool,id);
   return NextResponse.json(await settings(pool));
  }
  if(action==='pause'){
   await pauseProcessing(pool,id);
   return NextResponse.json(await settings(pool));
  }
  if (action!==undefined && action!=='login') throw new Error('Invalid account action.');
  await requestLogin(pool,id);
  return NextResponse.json(await settings(pool));
 } catch(error) {return NextResponse.json({error:error instanceof Error ? error.message : 'Could not request sign-in.'},{status:400});}
}
