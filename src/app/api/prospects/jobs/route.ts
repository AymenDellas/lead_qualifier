import { NextResponse } from 'next/server';
import { pool } from '@/lib/pg_setup';
import { jobStatus, queueStatus } from '@/lib/linkedin-workers.cjs';
import { requireWorkerAdmin } from '@/lib/worker-admin';
import { PROSPECT_JOB_POLL_SIZE } from '@/lib/prospect-batches';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
    await requireWorkerAdmin();
    const ids = (new URL(request.url).searchParams.get('ids') || '').split(',').filter(Boolean);
    if (ids.length > PROSPECT_JOB_POLL_SIZE || ids.some(id => !/^job_[a-zA-Z0-9_-]{1,100}$/.test(id))) return NextResponse.json({ error: 'Invalid research jobs.' }, { status: 400 });
    const jobs = await Promise.all(ids.map(async id => {
        const result = await jobStatus(pool,id);
        return { id, status: result.status === 'done' ? result.result?.crmSaved === false || result.result?.status === 'ERROR' ? 'error' : 'done' : result.status === 'not_found' || result.status === 'cancelled' ? 'error' : 'queued',
            tier: result.result?.prospectQualification?.tier || null, error: result.result?.crmSaved === false ? 'Research finished but CRM save failed. Retry the save or research.' : result.status==='cancelled' ? 'Research cancelled.' : '' };
    }));
    const state = (await queueStatus(pool)).workerStatus;
    const worker = {ready:!state.stale,pausedReason:state.status==='paused'?'An account needs attention. Check LinkedIn accounts.':'',dailyCount:state.dailyCount,dailyLimit:state.dailyLimit};
    return NextResponse.json({ jobs, worker });
}
