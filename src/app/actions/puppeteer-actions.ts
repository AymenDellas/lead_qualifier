"use server";

import { spawn, ChildProcess } from "child_process";
import fs from "fs";
import path from "path";

const PROJECT_ROOT = process.cwd();
const RESULTS_DIR = path.join(PROJECT_ROOT, "scrape-results");
const PROGRESS_FILE = path.join(RESULTS_DIR, "progress.json");
const ALL_RESULTS_FILE = path.join(RESULTS_DIR, "all-results.json");
const ALL_RESULTS_CSV = path.join(RESULTS_DIR, "all-results.csv");
const URLS_FILE = path.join(PROJECT_ROOT, "_puppeteer-urls.txt");
const PID_FILE = path.join(RESULTS_DIR, "puppeteer.pid");

export type PuppeteerResult = {
    url: string;
    firstName: string;
    activityStatus: string;
    emails: string[];
    websites: string[];
    website: string;
    status: string;
    logs: string[];
};

export type PuppeteerProgress = {
    isRunning: boolean;
    totalUrls: number;
    completed: number;
    remaining: number;
    results: PuppeteerResult[];
    lastUpdate: string | null;
};

// ── Start a new Puppeteer scraping job ──
export async function startPuppeteerJob(urls: string[]): Promise<{ success: boolean; error?: string }> {
    // Check if already running
    if (isPuppeteerRunning()) {
        return { success: false, error: "A scraping job is already running." };
    }

    // Clear old results
    if (fs.existsSync(RESULTS_DIR)) {
        const files = fs.readdirSync(RESULTS_DIR);
        for (const f of files) {
            if (f.endsWith("-results.json") || f === "progress.json" || f === "all-results.json" || f === "all-results.csv") {
                fs.unlinkSync(path.join(RESULTS_DIR, f));
            }
        }
    } else {
        fs.mkdirSync(RESULTS_DIR, { recursive: true });
    }

    // Write URLs to file
    fs.writeFileSync(URLS_FILE, urls.join("\n"), "utf8");

    // Spawn puppeteer-scraper.cjs as a detached background process
    const child = spawn("node", ["puppeteer-scraper.cjs", URLS_FILE], {
        cwd: PROJECT_ROOT,
        detached: true,
        stdio: "ignore",
        shell: process.platform === 'win32' ? 'cmd.exe' : true,
    });

    child.unref();

    // Save PID so we can check/kill later
    if (child.pid) {
        fs.writeFileSync(PID_FILE, String(child.pid), "utf8");
    }

    return { success: true };
}

// ── Resume an existing job ──
export async function resumePuppeteerJob(): Promise<{ success: boolean; error?: string }> {
    if (isPuppeteerRunning()) {
        return { success: false, error: "A scraping job is already running." };
    }

    if (!fs.existsSync(URLS_FILE)) {
        return { success: false, error: "No previous URL file found. Upload a CSV first." };
    }

    // Spawn without clearing results — progress.json will handle resume
    const child = spawn("node", ["puppeteer-scraper.cjs", URLS_FILE], {
        cwd: PROJECT_ROOT,
        detached: true,
        stdio: "ignore",
        shell: process.platform === 'win32' ? 'cmd.exe' : true,
    });

    child.unref();

    if (child.pid) {
        fs.writeFileSync(PID_FILE, String(child.pid), "utf8");
    }

    return { success: true };
}

// ── Stop a running job ──
export async function stopPuppeteerJob(): Promise<{ success: boolean }> {
    if (!fs.existsSync(PID_FILE)) return { success: false };

    try {
        const pid = parseInt(fs.readFileSync(PID_FILE, "utf8").trim());
        // Kill the process tree (cross-platform)
        if (process.platform === 'win32') {
            spawn("taskkill", ["/pid", String(pid), "/f", "/t"], { shell: "cmd.exe" });
        } else {
            try { process.kill(pid, 'SIGKILL'); } catch {}
        }
        fs.unlinkSync(PID_FILE);
        return { success: true };
    } catch {
        return { success: false };
    }
}

// ── Poll for progress ──
export async function getPuppeteerProgress(): Promise<PuppeteerProgress> {
    const running = isPuppeteerRunning();

    // Read progress file
    let completed = 0;
    let totalUrls = 0;
    if (fs.existsSync(PROGRESS_FILE)) {
        try {
            const prog = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
            completed = prog.totalCompleted || prog.completed?.length || 0;
        } catch { /* ignore */ }
    }

    // Count total URLs
    if (fs.existsSync(URLS_FILE)) {
        const content = fs.readFileSync(URLS_FILE, "utf8");
        totalUrls = content.split("\n").filter(u => u.trim().includes("linkedin.com/in/")).length;
    }

    // Read all results
    let results: PuppeteerResult[] = [];
    if (fs.existsSync(ALL_RESULTS_FILE)) {
        try {
            results = JSON.parse(fs.readFileSync(ALL_RESULTS_FILE, "utf8"));
        } catch { /* ignore */ }
    } else {
        // Merge worker files
        if (fs.existsSync(RESULTS_DIR)) {
            const files = fs.readdirSync(RESULTS_DIR).filter(f => f.match(/worker-\d+-results\.json/));
            for (const f of files) {
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, f), "utf8"));
                    results.push(...data);
                } catch { /* ignore */ }
            }
        }
    }

    return {
        isRunning: running,
        totalUrls,
        completed: results.length || completed,
        remaining: Math.max(0, totalUrls - (results.length || completed)),
        results,
        lastUpdate: new Date().toISOString(),
    };
}

// ── Check if puppeteer process is running ──
function isPuppeteerRunning(): boolean {
    if (!fs.existsSync(PID_FILE)) return false;
    try {
        const pid = parseInt(fs.readFileSync(PID_FILE, "utf8").trim());
        // Check if process is alive
        process.kill(pid, 0);
        return true;
    } catch {
        // Process doesn't exist — clean up stale PID file
        try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
        return false;
    }
}

// ── Get results as CSV string ──
export async function getPuppeteerResultsCSV(): Promise<string> {
    if (fs.existsSync(ALL_RESULTS_CSV)) {
        return fs.readFileSync(ALL_RESULTS_CSV, "utf8");
    }

    const progress = await getPuppeteerProgress();
    if (progress.results.length === 0) return "";

    const headers = ["LinkedIn URL", "First Name", "Status", "Activity Status", "Emails", "Websites"];
    const csvCell = (val: string) => `"${val.replace(/"/g, '""')}"`;
    const rows = progress.results.map(r =>
        [
            csvCell(r.url),
            csvCell(r.firstName || ""),
            csvCell(r.status),
            csvCell(r.activityStatus || ""),
            csvCell(r.emails.join("; ")),
            csvCell(r.websites.join("; ")),
        ].join(",")
    );

    return [headers.join(","), ...rows].join("\n");
}
