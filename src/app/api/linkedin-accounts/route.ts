import { NextResponse } from 'next/server';
import { pool } from '@/lib/pg_setup';
import { requireWorkerAdmin } from '@/lib/worker-admin';
import { settings, saveSettings, requestLogin, requestLogout } from '@/lib/linkedin-workers.cjs';
export const dynamic = 'force-dynamic';
export async function GET() {
 await requireWorkerAdmin();
 return NextResponse.json(await settings(pool), { headers: { 'Cache-Control': 'no-store' } });
}
export async function PUT(request: Request) {
 await requireWorkerAdmin();
 try { return NextResponse.json(await saveSettings(pool, await request.json())); }
 catch(error) { return NextResponse.json({error:error instanceof Error ? error.message : 'Could not save accounts.'}, {status:400}); }
}
export async function POST(request: Request) {
 await requireWorkerAdmin();
 try {
  const {id,action} = await request.json();
  if (typeof id !== 'string' || !/^(?:legacy-\d+|[a-f0-9-]{36})$/.test(id)) throw new Error('Invalid account.');
  if (action==='logout') {
   await requestLogout(pool,id);
   return NextResponse.json(await settings(pool));
  }
  if (action!==undefined && action!=='login') throw new Error('Invalid account action.');
  await requestLogin(pool,id);
  return NextResponse.json({ok:true});
 } catch(error) {return NextResponse.json({error:error instanceof Error ? error.message : 'Could not request sign-in.'},{status:400});}
}
