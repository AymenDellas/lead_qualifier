import { NextRequest, NextResponse } from "next/server";
import { processSingleLead } from "@/app/actions/scraper-actions";

// ── In-memory job store ──
// Jobs persist for the lifetime of the server process.
// On Render, the process stays alive between requests.
type Job = {
    id: string;
    status: "pending" | "processing" | "done" | "error";
    linkedinUrl: string;
    result?: any;
    error?: string;
    createdAt: number;
    completedAt?: number;
};

const jobs = new Map<string, Job>();

// Clean up jobs older than 30 minutes to prevent memory leaks
function cleanOldJobs() {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [id, job] of jobs) {
        if (job.createdAt < cutoff) jobs.delete(id);
    }
}

// ── GET: Check job status or show usage ──
export async function GET(request: NextRequest) {
    const jobId = request.nextUrl.searchParams.get("jobId");

    // If no jobId, show usage instructions
    if (!jobId) {
        return NextResponse.json({
            status: "ok",
            endpoint: "POST /api/process-lead",
            usage: {
                step1: "POST with { \"linkedinUrl\": \"https://www.linkedin.com/in/some-profile\" }",
                step2: "Response returns { \"jobId\": \"...\" }",
                step3: "GET /api/process-lead?jobId=... to poll for results",
            },
        });
    }

    // Look up the job
    const job = jobs.get(jobId);
    if (!job) {
        return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    if (job.status === "done") {
        const elapsed = job.completedAt
            ? ((job.completedAt - job.createdAt) / 1000).toFixed(1) + "s"
            : undefined;
        return NextResponse.json({
            jobId: job.id,
            status: "done",
            elapsed,
            result: job.result,
        });
    }

    if (job.status === "error") {
        return NextResponse.json({
            jobId: job.id,
            status: "error",
            error: job.error,
        }, { status: 500 });
    }

    // Still processing
    const elapsed = ((Date.now() - job.createdAt) / 1000).toFixed(1);
    return NextResponse.json({
        jobId: job.id,
        status: job.status,
        elapsed: elapsed + "s",
        message: "Still processing. Poll this URL again in a few seconds.",
    });
}

// ── POST: Start a new job ──
export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { linkedinUrl } = body;

        if (!linkedinUrl || typeof linkedinUrl !== "string") {
            return NextResponse.json(
                { error: "Missing or invalid 'linkedinUrl' field" },
                { status: 400 }
            );
        }

        // Clean up old jobs periodically
        cleanOldJobs();

        // Create a new job
        const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const job: Job = {
            id: jobId,
            status: "processing",
            linkedinUrl,
            createdAt: Date.now(),
        };
        jobs.set(jobId, job);

        console.log(`[API] Job ${jobId} created for ${linkedinUrl}`);

        // Start processing in the background (fire and forget)
        processSingleLead(linkedinUrl)
            .then((result) => {
                job.status = "done";
                job.result = result;
                job.completedAt = Date.now();
                const elapsed = ((job.completedAt - job.createdAt) / 1000).toFixed(1);
                console.log(`[API] Job ${jobId} done in ${elapsed}s — status: ${result.status}`);
            })
            .catch((error) => {
                job.status = "error";
                job.error = error instanceof Error ? error.message : "Internal server error";
                job.completedAt = Date.now();
                console.error(`[API] Job ${jobId} failed:`, error);
            });

        // Return immediately with the job ID
        return NextResponse.json({
            jobId,
            status: "processing",
            pollUrl: `/api/process-lead?jobId=${jobId}`,
            message: "Job started. Poll the pollUrl to check for results.",
        });
    } catch (error) {
        console.error("[API] POST error:", error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Internal server error" },
            { status: 500 }
        );
    }
}
