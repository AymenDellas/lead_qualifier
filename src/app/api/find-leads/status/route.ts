import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const jobId = searchParams.get('jobId');

        if (!jobId) {
            return NextResponse.json({ error: 'Missing jobId' }, { status: 400 });
        }

        const queueResultsDir = path.join(process.cwd(), 'queue-results');
        const progressFile = path.join(queueResultsDir, `${jobId}.json`);

        if (!fs.existsSync(progressFile)) {
            return NextResponse.json({ status: 'unknown' });
        }

        const data = fs.readFileSync(progressFile, 'utf8');
        return NextResponse.json(JSON.parse(data));
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
