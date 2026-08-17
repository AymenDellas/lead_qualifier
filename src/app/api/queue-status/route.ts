import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const PROJECT_ROOT = process.cwd();
const QUEUE_DIR = path.join(PROJECT_ROOT, "queue");
const RESULTS_DIR = path.join(PROJECT_ROOT, "queue-results");
const DATA_DIR = path.join(PROJECT_ROOT, "data");
const LIMITS_FILE = path.join(DATA_DIR, "worker-limits.json");

export async function GET(request: NextRequest) {
    try {
        if (!fs.existsSync(QUEUE_DIR)) fs.mkdirSync(QUEUE_DIR, { recursive: true });
        if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

        // 1. Get queue size
        const queueFiles = fs.readdirSync(QUEUE_DIR).filter(f => f.endsWith('.json'));
        const queueSize = queueFiles.length;

        // 2. Get worker status
        const statusPath = path.join(RESULTS_DIR, "worker-status.json");
        let workerStatus: any = null;
        try {
            if (fs.existsSync(statusPath)) {
                const raw = JSON.parse(fs.readFileSync(statusPath, "utf8"));
                const updatedAt = new Date(raw.updatedAt || 0).getTime();
                const isStale = Date.now() - updatedAt > 120_000;
                workerStatus = { ...raw, stale: isStale };
            }
        } catch { }

        // 3. Get daily limits
        let dailyStats = { date: '', count: 0, limit: 0 };
        try {
            if (fs.existsSync(LIMITS_FILE)) {
                const ld = JSON.parse(fs.readFileSync(LIMITS_FILE, "utf8"));
                const today = new Date().toISOString().split('T')[0];
                dailyStats = {
                    date: ld.date || '',
                    count: ld.date === today ? (ld.count || 0) : 0,
                    limit: parseInt(process.env.DAILY_SCRAPE_LIMIT || '0', 10)
                };
            }
        } catch { }

        // 4. Get recent completed jobs (last 50)
        let recentResults: any[] = [];
        try {
            const resultFiles = fs.readdirSync(RESULTS_DIR)
                .filter(f => f.startsWith('job_') && f.endsWith('.json'))
                .map(f => {
                    const filePath = path.join(RESULTS_DIR, f);
                    const stat = fs.statSync(filePath);
                    return { file: f, mtime: stat.mtime.getTime() };
                })
                .sort((a, b) => b.mtime - a.mtime)
                .slice(0, 50);

            for (const item of resultFiles) {
                const raw = fs.readFileSync(path.join(RESULTS_DIR, item.file), "utf8");
                try {
                    recentResults.push(JSON.parse(raw));
                } catch {}
            }
        } catch (err) {
            console.error("Error reading recent results:", err);
        }

        return NextResponse.json({
            status: "ok",
            queueSize,
            workerStatus,
            dailyStats,
            recentResults
        });
    } catch (error) {
        console.error('[API] GET queue-status error:', error);
        return NextResponse.json({ error: "Internal error" }, { status: 500 });
    }
}
