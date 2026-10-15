import { NextResponse } from 'next/server';
import { requireWorkerAdmin } from '@/lib/worker-admin';
export async function POST() {
    await requireWorkerAdmin();
    return NextResponse.json({error:'AI hook generation is disabled.'},{status:409});
}
