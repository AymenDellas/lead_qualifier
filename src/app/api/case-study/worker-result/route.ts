import { NextRequest, NextResponse } from 'next/server';
import { upsertCaseStudyWorkerResult } from '@/lib/case-study-store';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        if (!body?.job || !body?.result)
            return NextResponse.json({ error: 'Missing worker job or result.' }, { status: 400 });
        const prospect = await upsertCaseStudyWorkerResult(body.job, body.result);
        return NextResponse.json({ status: 'saved', prospectId: prospect.id });
    } catch (error) {
        console.error('[CaseStudy] Worker result save failed:', error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Could not save worker result.' },
            { status: 500 },
        );
    }
}
