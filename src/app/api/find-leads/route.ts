import { NextResponse } from 'next/server';
import { runDorkEngine, SearchConfig } from '@/lib/dorkEngine';
import fs from 'fs';
import path from 'path';
import { insertOrUpdateLead } from '@/lib/db';

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { job_titles, locations, max_urls_target, negative_keywords } = body;

        if (!job_titles || !locations) {
            return NextResponse.json({ error: 'Missing job_titles or locations' }, { status: 400 });
        }

        const jobId = `find-${Date.now()}`;
        const queueResultsDir = path.join(process.cwd(), 'queue-results');
        if (!fs.existsSync(queueResultsDir)) {
            fs.mkdirSync(queueResultsDir, { recursive: true });
        }

        const progressFile = path.join(queueResultsDir, `${jobId}.json`);

        // Initial state
        fs.writeFileSync(progressFile, JSON.stringify({
            status: 'running',
            jobId,
            found: 0,
            totalQueries: job_titles.length * locations.length,
            currentQuery: '',
            results: []
        }));

        // Fire & Forget background task
        const config: SearchConfig = {
            job_titles,
            locations,
            max_urls_target: max_urls_target || 500,
            negative_keywords: negative_keywords || []
        };

        const apiKey = process.env.SERPER_API_KEY;
        if (!apiKey) {
            return NextResponse.json({ error: 'Missing SERPER_API_KEY' }, { status: 500 });
        }

        // Run in background
        Promise.resolve().then(async () => {
            try {
                const results = await runDorkEngine(config, apiKey, (found, totalQueries, qIdx, query) => {
                    fs.writeFileSync(progressFile, JSON.stringify({
                        status: 'running',
                        jobId,
                        found,
                        totalQueries,
                        currentQuery: query,
                        results: [] // Don't write all results on every tick to save IO
                    }));
                });

                fs.writeFileSync(progressFile, JSON.stringify({
                    status: 'done',
                    jobId,
                    found: results.length,
                    results
                }));

                // Auto-Push to CRM
                for (const r of results) {
                    await insertOrUpdateLead({
                        linkedin_url: r.url,
                        location: r.location,
                        pipeline_status: 'INBOX'
                    });
                }

            } catch (err: any) {
                fs.writeFileSync(progressFile, JSON.stringify({
                    status: 'error',
                    jobId,
                    error: err.message
                }));
            }
        });

        return NextResponse.json({ success: true, jobId });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
