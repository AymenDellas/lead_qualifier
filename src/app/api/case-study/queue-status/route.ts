import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const ROOT = process.cwd();
const QUEUE_DIR = path.join(ROOT, 'case-study-queue');
const RESULTS_DIR = path.join(ROOT, 'case-study-results');
const LIMITS_FILE = path.join(ROOT, 'data', 'case-study-worker-limits.json');

function readRecentLogs() {
    const logPath = path.join(RESULTS_DIR, 'worker-log.jsonl');
    if (!fs.existsSync(logPath)) return [];
    try {
        return fs.readFileSync(logPath, 'utf8')
            .trim()
            .split(/\r?\n/)
            .slice(-120)
            .map((line) => JSON.parse(line))
            .filter((entry) => entry && typeof entry.message === 'string');
    } catch {
        return [];
    }
}

export async function GET() {
    try {
        fs.mkdirSync(QUEUE_DIR, { recursive: true });
        fs.mkdirSync(RESULTS_DIR, { recursive: true });
        const queueSize = fs.readdirSync(QUEUE_DIR).filter((name) => name.endsWith('.json')).length;
        let workerStatus: Record<string, unknown> | null = null;
        const statusPath = path.join(RESULTS_DIR, 'worker-status.json');
        if (fs.existsSync(statusPath)) {
            try {
                const raw = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
                const updatedAt = Date.parse(raw.updatedAt || '');
                workerStatus = {
                    ...raw,
                    stale: !Number.isFinite(updatedAt) || Date.now() - updatedAt > 45000,
                };
            } catch {
                workerStatus = { status: 'error', stale: true, reason: 'Worker status file is unreadable.' };
            }
        }
        let dailyStats = { date: '', count: 0, limit: Number(process.env.CASE_STUDY_DAILY_SCRAPE_LIMIT || 150) };
        if (fs.existsSync(LIMITS_FILE)) {
            try {
                const raw = JSON.parse(fs.readFileSync(LIMITS_FILE, 'utf8'));
                const today = new Date().toISOString().slice(0, 10);
                dailyStats = {
                    date: raw.date || '',
                    count: raw.date === today ? Number(raw.count || 0) : 0,
                    limit: Number(process.env.CASE_STUDY_DAILY_SCRAPE_LIMIT || 150),
                };
            } catch {
                // A fresh worker run will replace malformed stats.
            }
        }
        const recentLogs = Array.isArray(workerStatus?.recentLogs)
            ? workerStatus.recentLogs
            : readRecentLogs();
        return NextResponse.json({ status: 'ok', queueSize, workerStatus, dailyStats, recentLogs });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Could not read the Case Study worker.' },
            { status: 500 },
        );
    }
}
