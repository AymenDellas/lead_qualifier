import { NextResponse } from 'next/server';
import { createFinderProgressStore } from '@/lib/finder-progress';

const progressStore = createFinderProgressStore();

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const jobId = searchParams.get('jobId');

        if (!jobId || !/^find-\d+$/.test(jobId)) {
            return NextResponse.json({ error: 'Invalid jobId' }, { status: 400 });
        }

        const parsed = await progressStore.read(jobId);
        if (!parsed) {
            return NextResponse.json({ status: 'unknown' });
        }

        // A discovery run is an orphaned promise with no supervisor: restart the dev
        // server mid-run and this file sits at `running` forever, so the UI polls a
        // job that no longer exists and the operator waits on nothing. The engine
        // stamps `heartbeatAt` on every write, so silence is detectable — same
        // 120-second threshold the worker's own status uses.
        const STALE_MS = 120_000;
        if (parsed.status === 'running' && typeof parsed.heartbeatAt === 'number') {
            const silentFor = Date.now() - parsed.heartbeatAt;
            if (silentFor > STALE_MS) {
                return NextResponse.json({
                    ...parsed,
                    status: 'error',
                    error: `No progress for ${Math.round(silentFor / 1000)}s — the discovery task is gone (server restart?). Leads found before it stopped are already saved.`,
                });
            }
        }

        return NextResponse.json(parsed);
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
