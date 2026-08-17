import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

const PROJECT_ROOT = process.cwd();
const QUEUE_DIR = path.join(PROJECT_ROOT, "queue");
const RESULTS_DIR = path.join(PROJECT_ROOT, "queue-results");

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { urls, nativePostProcess, targetRegion } = body;

        if (!urls || !Array.isArray(urls)) {
            return NextResponse.json({ error: "Missing or invalid 'urls' array" }, { status: 400 });
        }

        if (!fs.existsSync(QUEUE_DIR)) fs.mkdirSync(QUEUE_DIR, { recursive: true });
        if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

        const queuedJobs = [];

        for (const url of urls) {
            if (!url.includes('linkedin.com/in/')) continue;

            const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const jobPath = path.join(QUEUE_DIR, `${jobId}.json`);
            const tmpPath = `${jobPath}.tmp`;
            
            fs.writeFileSync(tmpPath, JSON.stringify({ 
                jobId, 
                linkedinUrl: url, 
                nativePostProcess: !!nativePostProcess,
                targetRegion: targetRegion || 'na', // Default to na if not provided
                createdAt: new Date().toISOString() 
            }));
            fs.renameSync(tmpPath, jobPath);
            queuedJobs.push(jobId);
        }

        console.log(`[API] Queued batch of ${queuedJobs.length} jobs`);

        return NextResponse.json({
            status: "success",
            queuedCount: queuedJobs.length,
            jobs: queuedJobs
        });
    } catch (error) {
        console.error('[API] Batch POST error:', error);
        return NextResponse.json({ error: "Internal error" }, { status: 500 });
    }
}
