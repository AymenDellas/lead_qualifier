import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

// Force dynamic — never cache this route
export const dynamic = "force-dynamic";
export const revalidate = 0;

const PROJECT_ROOT = process.cwd();
const QUEUE_DIR = path.join(PROJECT_ROOT, "queue");
const RESULTS_DIR = path.join(PROJECT_ROOT, "queue-results");

// Ensure dirs exist
if (!fs.existsSync(QUEUE_DIR)) fs.mkdirSync(QUEUE_DIR, { recursive: true });
if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

// ── GET: Check job status ──
export async function GET(request: NextRequest) {
    const jobId = request.nextUrl.searchParams.get("jobId");

    if (!jobId) {
        // Check if worker is alive
        const statusPath = path.join(RESULTS_DIR, "worker-status.json");
        let workerStatus: any = "unknown";
        try {
            if (fs.existsSync(statusPath)) {
                const raw = JSON.parse(fs.readFileSync(statusPath, "utf8"));
                // Check if status file is stale (>60s old = worker likely dead)
                const updatedAt = new Date(raw.updatedAt || 0).getTime();
                const isStale = Date.now() - updatedAt > 120_000;
                workerStatus = { ...raw, stale: isStale };
            }
        } catch { }

        return NextResponse.json({
            status: "ok",
            worker: workerStatus,
            queueSize: fs.readdirSync(QUEUE_DIR).filter(f => f.endsWith('.json')).length,
            usage: {
                step1: 'POST with { "linkedinUrl": "https://www.linkedin.com/in/some-profile" }',
                step2: 'Response returns { "jobId": "..." }',
                step3: "GET /api/process-lead?jobId=... to poll for results",
            },
        });
    }

    // Check if result file exists (job completed)
    const resultPath = path.join(RESULTS_DIR, `${jobId}.json`);
    if (fs.existsSync(resultPath)) {
        try {
            const data = JSON.parse(fs.readFileSync(resultPath, "utf8"));
            return NextResponse.json({
                jobId,
                status: "done",
                result: data.result,
            });
        } catch {
            return NextResponse.json({ jobId, status: "error", error: "Failed to read result" }, { status: 500 });
        }
    }

    // Check if job is still in queue (waiting to be picked up)
    const queuePath = path.join(QUEUE_DIR, `${jobId}.json`);
    if (fs.existsSync(queuePath)) {
        return NextResponse.json({
            jobId,
            status: "queued",
            message: "Job is in the queue, waiting for worker to pick it up.",
        });
    }

    // Check if worker is processing it right now
    const statusPath = path.join(RESULTS_DIR, "worker-status.json");
    try {
        if (fs.existsSync(statusPath)) {
            const ws = JSON.parse(fs.readFileSync(statusPath, "utf8"));
            if (ws.status === "processing" && ws.jobId === jobId) {
                return NextResponse.json({
                    jobId,
                    status: "processing",
                    message: `Worker is currently scraping ${ws.url}`,
                });
            }
        }
    } catch { }

    // Job not found anywhere — might have been processed and cleaned up
    return NextResponse.json({ jobId, status: "not_found", message: "Job not found. It may have expired or was never created." }, { status: 404 });
}

// ── POST: Queue a new job ──
export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { linkedinUrl, webhookUrl } = body;

        if (!linkedinUrl) {
            return NextResponse.json({ error: "Missing 'linkedinUrl'" }, { status: 400 });
        }

        // Validate URL format
        if (!linkedinUrl.includes('linkedin.com/in/')) {
            return NextResponse.json({ error: "Invalid LinkedIn profile URL" }, { status: 400 });
        }

        // Check worker is alive
        const statusPath = path.join(RESULTS_DIR, "worker-status.json");
        if (!fs.existsSync(statusPath)) {
            return NextResponse.json({ error: "Worker is not running. Start it with: node worker.cjs" }, { status: 503 });
        }

        // Check worker staleness
        try {
            const ws = JSON.parse(fs.readFileSync(statusPath, "utf8"));
            const updatedAt = new Date(ws.updatedAt || 0).getTime();
            if (Date.now() - updatedAt > 90_000 && ws.status !== 'processing') {
                return NextResponse.json({ error: "Worker appears offline (status file is stale). Restart with: node worker.cjs" }, { status: 503 });
            }
        } catch { /* non-fatal */ }

        const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        // Drop job file into queue/
        const jobPath = path.join(QUEUE_DIR, `${jobId}.json`);
        const tmpPath = `${jobPath}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify({ jobId, linkedinUrl, webhookUrl: webhookUrl || null, createdAt: new Date().toISOString() }));
        fs.renameSync(tmpPath, jobPath);

        console.log(`[API] Queued job ${jobId} for ${linkedinUrl}`);

        return NextResponse.json({
            jobId,
            status: "queued",
            pollUrl: `/api/process-lead?jobId=${jobId}`,
        });
    } catch (error) {
        console.error('[API] POST error:', error);
        return NextResponse.json({ error: "Internal error" }, { status: 500 });
    }
}
