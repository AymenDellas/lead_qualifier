"use client";

import dynamic from "next/dynamic";
import React, { useState, useEffect, useCallback } from "react";
import {
    Upload,
    FileText,
    Search,
    Download,
    Globe,
    ExternalLink,
    Loader2,
    Pause,
    Play,
    RotateCcw,
    Sheet,
    History,
    Trash2,
    FolderOpen,
    X,
    Clock,
    Database,
    StopCircle,
    ShieldCheck,
    Zap,
    Server,
    Radar,
    CalendarDays,
    ScanSearch,
    ClipboardCheck,
    WandSparkles,
    PenLine,
    MessagesSquare,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { failureOf } from "@/lib/worker-failure.cjs";
import CrmDatabase from "./CrmDatabase";
import BusinessWorkspace from "./business/BusinessWorkspace";
import CaseStudyHunter from "./business/CaseStudyHunter";
import DiscoveryCallsWorkspace from "./business/DiscoveryCallsWorkspace";
import FunnelAnalyzer from "./FunnelAnalyzer";
import ContentCreate from "./content-create/ContentCreate";
const CopyStudio = dynamic(() => import("./copy-studio/App"), { ssr: false, loading: () => <div className="panel panel-body text-dim">Loading Copy Studio…</div> });

import type { BusinessView } from '@/lib/business';

import {
    saveProgress,
    loadProgress,
    listSavedRuns,
    loadSavedRun,
    deleteSavedRun,
    type Lead,
    type SavedRun,
} from "@/app/actions/scraper-actions";
import { scrapeWebsiteEmails, type WebsiteScrapeResult } from "@/app/actions/scraper-actions";
import { getVerificationReadiness, verifyEmailBatchFast, type VerificationResult } from "@/app/actions/email-verifier-actions";
import VerificationProviderStatus from '@/components/VerificationProviderStatus';

// ── Worker API helper: submit job & poll until done ──
async function processLeadViaWorker(linkedinUrl: string): Promise<Lead> {
    const res = await fetch('/api/process-lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ linkedinUrl, nativePostProcess: true }),
    });
    const queued = await res.json();
    if (!res.ok || queued.error) throw new Error(queued.error || 'Failed to queue job');
    const jobId = queued.jobId;

    // Poll until worker finishes
    for (let attempt = 0; attempt < 120; attempt++) {
        await new Promise(r => setTimeout(r, 3000));
        const pollRes = await fetch(`/api/process-lead?jobId=${jobId}`);
        const data = await pollRes.json();
        if (data.status === 'done') {
            const r = data.result;
            return {
                url: r.url || linkedinUrl,
                status: r.status || 'ERROR',
                firstName: r.firstName || '',
                headline: r.headline || '',
                activityStatus: r.activityStatus || 'Unknown',
                website: r.website || '',
                websites: r.websites || [],
                emails: r.emails || [],
                logs: r.logs || [],
                prospectQualification: r.prospectQualification,
            };
        }
        if (data.status === 'not_found' || data.status === 'error') {
            throw new Error(data.error || data.message || 'Job failed');
        }
    }
    throw new Error('Job timed out after 6 minutes');
}
import { exportToGoogleSheets, isGoogleSheetsConfigured } from "@/app/actions/google-sheets";
import UrlCleaner from "./UrlCleaner";
import FinderEngine from "./FinderEngine";
import LinkedInAccounts from "./LinkedInAccounts";

import Papa from 'papaparse';

// ── Toast Notification System ──
type Toast = { id: number; message: string; type: 'success' | 'error' | 'info'; };
let toastId = 0;

function ToastContainer({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
    return (
        <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2 w-[min(24rem,calc(100vw-2.5rem))]">
            {toasts.map(t => (
                <div
                    key={t.id}
                    className="panel flex items-start gap-2.5 px-3.5 py-2.5 shadow-[0_14px_40px_rgba(0,0,0,0.6)] animate-in slide-in-from-right-2 fade-in duration-200"
                >
                    <span
                        className={cn(
                            "mt-[6px] w-1.5 h-1.5 rounded-[1px] flex-none",
                            t.type === 'success' && "bg-[var(--signal)]",
                            t.type === 'error' && "bg-[var(--bad)]",
                            t.type === 'info' && "bg-[var(--text-faint)]",
                        )}
                        aria-hidden
                    />
                    <span className="text-[13px] flex-1 leading-snug text-[var(--text)]">{t.message}</span>
                    <button onClick={() => onDismiss(t.id)} className="btn btn-ghost !p-1 -mr-1 -mt-0.5" aria-label="Dismiss">
                        <X className="w-3 h-3" />
                    </button>
                </div>
            ))}
        </div>
    );
}

// ── Confirmation Dialog ──
function ConfirmDialog({ open, message, onConfirm, onCancel }: {
    open: boolean; message: string; onConfirm: () => void; onCancel: () => void;
}) {
    if (!open) return null;
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 animate-in fade-in duration-150">
            <div className="panel p-5 max-w-sm w-full shadow-[0_24px_60px_rgba(0,0,0,0.7)]">
                <p className="text-[var(--text)] text-sm leading-relaxed mb-5">{message}</p>
                <div className="flex gap-2 justify-end">
                    <button onClick={onCancel} className="btn btn-outline">Cancel</button>
                    <button onClick={onConfirm} className="btn btn-danger">Delete</button>
                </div>
            </div>
        </div>
    );
}

/**
 * A scrape outcome, said in words rather than in the enum the worker stores.
 * ACTIVITY_FAILED in particular does not mean anything went wrong — the person
 * simply hasn't posted recently — and reading it as a failure is what made the
 * old orange "Activity Failed" tile look like something to go and fix.
 */
const LEAD_STATUS: Record<string, { label: string; mark: string }> = {
    QUALIFIED: { label: 'Qualified', mark: 'mark-ok' },
    INVESTIGATE: { label: 'Not qualified', mark: 'mark-idle' },
    NURTURE: { label: 'Not qualified', mark: 'mark-idle' },
    REJECTED: { label: 'Not qualified', mark: 'mark-idle' },
    ACTIVITY_FAILED: { label: 'Activity unknown', mark: 'mark-warn' },
    ACTIVE_NO_CONTACT: { label: 'Contact needs review', mark: 'mark-warn' },
    SCANNING: { label: 'Scanning', mark: 'mark-info' },
    PENDING: { label: 'Waiting', mark: 'mark-idle' },
    ERROR: { label: 'Failed', mark: 'mark-bad' },
};

function LeadStatusMark({ status, researched }: { status: string; researched: boolean }) {
    const s = LEAD_STATUS[status] ?? { label: status, mark: 'mark-idle' };
    return <span className={cn("mark", s.mark)}>{s.label}</span>;
}

/**
 * A verification verdict, named for what it tells you about sending.
 *
 * The distinction that has to survive the rename: an UNKNOWN caused by the
 * recipient's server refusing *this machine* is not a fact about the lead. The
 * probe never reached the point of asking about the mailbox. Styling that like
 * a dead address is how a few hundred live addresses came to look spent, so it
 * says so plainly and never takes the failure colour.
 */
function VerifyMark({ result }: { result: VerificationResult }) {
    if (result.error) return <span className="mark mark-warn">Check failed</span>;
    if (result.status === 'VALID') return <span className="mark mark-ok">Safe to send</span>;
    if (result.status === 'INVALID') return <span className="mark mark-bad">No mailbox</span>;
    if (result.status === 'RISKY') {
        return (
            <span
                className="mark mark-warn"
                title={result.checks.catchAll
                    ? 'This domain accepts mail to any address, so being accepted proves nothing about this one'
                    : 'Accepted, but the address could not be shown to be real'}
            >
                {result.checks.catchAll ? 'Catch-all' : 'Unproven'}
            </span>
        );
    }
    if (/refused our probe/i.test(result.reason || '')) {
        return (
            <span
                className="mark mark-idle"
                title="The recipient's server refused this computer before it would answer. That is a verdict about us, not about whether the mailbox exists."
            >
                Host refused us
            </span>
        );
    }
    return <span className="mark mark-idle">No answer</span>;
}

/** The profile slug, which is the only part of a LinkedIn URL worth reading. */
function slugOf(url: string): string {
    return url?.match(/linkedin\.com\/in\/([^\/?#]+)/)?.[1] || url || 'unknown profile';
}

/** One line describing what happened to a profile, for the activity feed. */
function describeLead(l: any): string {
    const who = l.firstName || slugOf(l.url);
    const emails: string[] = l.emails || [];
    const status = LEAD_STATUS[l.status]?.label ?? l.status;

    if (l.status === 'QUALIFIED') {
        return emails.length > 0
            ? `${who} — qualified, ${emails[0]}${emails.length > 1 ? ` and ${emails.length - 1} more` : ''}`
            : `${who} — qualified, no address found`;
    }
    if (l.status === 'ACTIVITY_FAILED') return `${who} — activity unknown; business research needed`;
    if (l.status === 'ERROR') return `${who} — ${failureOf(l).reason}`;
    if (l.status === 'REJECTED' && l.prospectQualification?.nextAction) return `${who} — ${l.prospectQualification.nextAction}`;
    return `${who} — ${String(status).toLowerCase()}`;
}

type TabId = 'engine' | 'cleaner' | 'hunter' | 'unbouncer' | 'finder' | 'crm' | 'case-study' | 'discovery' | 'funnel' | 'content-create' | 'copy-studio' | BusinessView;

type NavItem = { id: TabId; label: string; icon: typeof Radar; signal?: boolean };

/**
 * The rail, split by what the section is for. Pipeline is the daily path a lead
 * travels — find it, scrape it, work it. Tools are the one-off utilities that
 * happen to live in the same app and were previously indistinguishable from it.
 */
const NAV_SECTIONS: { workspace: NavItem[]; pipeline: NavItem[]; tools: NavItem[] } = {
    workspace: [
        { id: 'today', label: 'Overview', icon: CalendarDays },
        { id: 'case-study', label: 'Case Study Hunter', icon: ScanSearch, signal: true },
        { id: 'discovery', label: 'Discovery Calls', icon: MessagesSquare },
        { id: 'onboarding', label: 'Onboarding', icon: ClipboardCheck },
        { id: 'content-create', label: 'Create', icon: WandSparkles },
        { id: 'copy-studio', label: 'Copy Studio', icon: PenLine },
    ],
    pipeline: [
        { id: 'finder', label: 'Finder', icon: Radar },
        { id: 'engine', label: 'Engine', icon: Zap },
        { id: 'crm', label: 'Leads', icon: Database, signal: true },
    ],
    tools: [
        { id: 'funnel', label: 'Funnel Analyzer', icon: ScanSearch },
        { id: 'unbouncer', label: 'Verify email', icon: ShieldCheck },
        { id: 'hunter', label: 'Find email', icon: Globe },
        { id: 'cleaner', label: 'Clean URLs', icon: FileText },
    ],
};

/** What each screen is called, and one line on what it does. */
const SCREENS: Record<TabId, { title: string; sub: string }> = {
    today: { title: 'Overview', sub: 'Your pipeline and onboarding, at a glance' },
    onboarding: { title: 'Onboarding', sub: 'Move accepted clients from agreement to ready-to-build' },
    discovery: { title: 'Discovery Calls', sub: 'Prepare the conversation, capture answers, and agree on the next step' },
    'case-study': { title: 'Case Study Hunter', sub: 'Find warm coaches, collect their websites, and manage LinkedIn outreach' },
    'content-create': { title: 'Create', sub: 'AI ideas and posts shaped by your voice' },
    'copy-studio': { title: 'Copy Studio', sub: 'Turn your offer into a landing page that gives people a reason to act' },
    funnel: { title: 'Funnel Analyzer', sub: 'Find landing-page conversion killers and plan the rebuild' },
    engine: { title: 'Engine', sub: 'Scrapes LinkedIn profiles and finds their contact details' },
    finder: { title: 'Finder', sub: 'Searches Google for profiles matching a niche and location' },
    crm: { title: 'Leads', sub: 'Everything found so far, and who is ready to email' },
    unbouncer: { title: 'Verify email', sub: 'Checks whether an address accepts mail before you send to it' },
    hunter: { title: 'Find email', sub: 'Pulls addresses off a list of websites — no LinkedIn needed' },
    cleaner: { title: 'Clean URLs', sub: 'Normalises a messy list of LinkedIn links' },
};

export default function Dashboard() {
    const [activeTab, setActiveTab] = useState<TabId>('today');
    const [onboardingProjectId, setOnboardingProjectId] = useState<string | undefined>();
    const [copyStudioOpened, setCopyStudioOpened] = useState(false);
    useEffect(() => { if (activeTab === 'copy-studio') setCopyStudioOpened(true); }, [activeTab]);
    const [contentCreateOpened, setContentCreateOpened] = useState(false);
    useEffect(() => { if (activeTab === 'content-create') setContentCreateOpened(true); }, [activeTab]);
    const [caseStudyEntryView, setCaseStudyEntryView] = useState<'TODAY' | 'CRM_OUTREACH'>('TODAY');
    const [progress, setProgress] = useState(0);
    const [isProcessing, setIsProcessing] = useState(false);
    // (A "Row Limit" input used to sit on this screen. It was never read by any
    // handler — the batch always queued every loaded URL — so it was a control
    // that promised something the app didn't do. Removed with its state.)
    const [csvUrls, setCsvUrls] = useState<string[]>([]);
    const [leads, setLeads] = useState<Lead[]>([]);
    const [logs, setLogs] = useState<{ msg: string, time: string, type: 'info' | 'success' | 'error', isJson?: boolean }[]>([]);
    const [isDragging, setIsDragging] = useState(false);
    const [batchInfo, setBatchInfo] = useState<string>('');
    const isPausedRef = React.useRef(false);
    const [isPaused, setIsPaused] = useState(false);
    const isCancelledRef = React.useRef(false);

    // New state
    const [toasts, setToasts] = useState<Toast[]>([]);
    const [sheetsConfigured, setSheetsConfigured] = useState(false);
    const [sheetsExporting, setSheetsExporting] = useState(false);
    const [savedRuns, setSavedRuns] = useState<SavedRun[]>([]);
    const [showHistory, setShowHistory] = useState(false);
    const [historyLoading, setHistoryLoading] = useState(false);
    const [confirmDialog, setConfirmDialog] = useState<{ open: boolean; message: string; onConfirm: () => void }>({ open: false, message: '', onConfirm: () => { } });

    // ── Email Hunter state ──
    const [hunterUrls, setHunterUrls] = useState('');
    const [hunterResults, setHunterResults] = useState<WebsiteScrapeResult[]>([]);
    const [hunterProcessing, setHunterProcessing] = useState(false);
    const [hunterProgress, setHunterProgress] = useState(0);
    const [hunterTotal, setHunterTotal] = useState(0);
    const hunterCancelledRef = React.useRef(false);

    // ── Email Unbouncer state ──
    const [unbouncerInput, setUnbouncerInput] = useState('');
    const [unbouncerSourceMap, setUnbouncerSourceMap] = useState<Record<string, string>>({});
    const [unbouncerResults, setUnbouncerResults] = useState<VerificationResult[]>([]);
    const [unbouncerProcessing, setUnbouncerProcessing] = useState(false);
    const [unbouncerProgress, setUnbouncerProgress] = useState(0);
    const [unbouncerTotal, setUnbouncerTotal] = useState(0);
    const unbouncerCancelledRef = React.useRef(false);

    // ── Live Queue State ──
    const [queueSize, setQueueSize] = useState<number>(0);
    const [retryingFailed, setRetryingFailed] = useState(false);
    const [workerStatus, setWorkerStatus] = useState<any>(null);
    const [dailyStats, setDailyStats] = useState<{ date: string; count: number; limit: number }>({ date: '', count: 0, limit: 0 });

    useEffect(() => {
        if (activeTab !== 'engine') return;
        const fetchStatus = async () => {
            try {
                const res = await fetch('/api/queue-status');
                if (res.ok) {
                    const data = await res.json();
                    setQueueSize(data.queueSize || 0);
                    setWorkerStatus(data.workerStatus);
                    if (data.dailyStats) setDailyStats(data.dailyStats);
                    
                    // Update isProcessing state based on active work
                    const isWorking = (data.queueSize > 0) || (data.workerStatus && data.workerStatus.status === 'processing');
                    setIsProcessing(isWorking);
                    
                    if (data.recentResults && data.recentResults.length > 0) {
                        // Extract only valid results (sometimes recentResults has status wrappers)
                        const extractedLeads = data.recentResults.map((r: any) => r.result ? r.result : r);
                        setLeads(extractedLeads);

                        // One readable sentence per result. This used to be
                        // JSON.stringify of the whole lead, which put a 30-line
                        // pretty-printed blob in the feed for every profile —
                        // the same data the results table below already shows,
                        // in the least readable form available.
                        const niceLogs = extractedLeads.map((l: any, index: number) => ({
                            msg: describeLead(l),
                            time: data.recentResults[index].completedAt ? new Date(data.recentResults[index].completedAt).toLocaleTimeString() : 'Time unavailable',
                            type: l.status === 'QUALIFIED' ? 'success' as const
                                : l.status === 'ERROR' ? 'error' as const
                                    : 'info' as const,
                        }));
                        setLogs(niceLogs.reverse()); // Reverse so newest is at the bottom if we scroll down
                    }
                }
            } catch (e) {
                // ignore
            }
        };
        fetchStatus();
        const int = setInterval(fetchStatus, 3000);
        return () => clearInterval(int);
    }, [activeTab]);

    // ── Toast helpers ──
    const addToast = useCallback((message: string, type: Toast['type']) => {
        const id = ++toastId;
        setToasts(prev => [...prev, { id, message, type }]);
        setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 5000);
    }, []);

    const dismissToast = useCallback((id: number) => {
        setToasts(prev => prev.filter(t => t.id !== id));
    }, []);

    // ── Restore state from sessionStorage on mount ──
    useEffect(() => {
        try {
            const savedLeads = sessionStorage.getItem('compel_leads');
            const savedUrls = sessionStorage.getItem('compel_urls');
            const savedProgress = sessionStorage.getItem('compel_progress');
            if (savedLeads) setLeads(JSON.parse(savedLeads));
            if (savedUrls) setCsvUrls(JSON.parse(savedUrls));
            if (savedProgress) setProgress(parseInt(savedProgress));

            // Restore unbouncer results
            const savedUnbouncer = sessionStorage.getItem('compel_unbouncer_results');
            const savedUnbouncerInput = sessionStorage.getItem('compel_unbouncer_input');
            if (savedUnbouncer) {
                const parsed = JSON.parse(savedUnbouncer);
                setUnbouncerResults(parsed);
                setUnbouncerTotal(parsed.length);
                setUnbouncerProgress(parsed.length);
            }
            if (savedUnbouncerInput) setUnbouncerInput(savedUnbouncerInput);
        } catch { /* ignore */ }

        // Check if Google Sheets is configured
        isGoogleSheetsConfigured().then(setSheetsConfigured).catch(() => { });
    }, []);

    // ── Persist state to sessionStorage ──
    useEffect(() => {
        try {
            if (leads.length > 0) sessionStorage.setItem('compel_leads', JSON.stringify(leads));
            if (csvUrls.length > 0) sessionStorage.setItem('compel_urls', JSON.stringify(csvUrls));
            sessionStorage.setItem('compel_progress', String(progress));
        } catch { /* ignore */ }
    }, [leads, csvUrls, progress]);

    // ── Persist unbouncer results to sessionStorage ──
    useEffect(() => {
        try {
            if (unbouncerResults.length > 0) {
                sessionStorage.setItem('compel_unbouncer_results', JSON.stringify(unbouncerResults));
            }
            if (unbouncerInput.length > 0) {
                sessionStorage.setItem('compel_unbouncer_input', unbouncerInput);
            }
        } catch { /* ignore */ }
    }, [unbouncerResults, unbouncerInput]);

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        processFile(file);
    };

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(true);
    };

    const handleDragLeave = () => {
        setIsDragging(false);
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
        const file = e.dataTransfer.files?.[0];
        if (file && file.type === "text/csv") {
            processFile(file);
        }
    };

    const processFile = (file: File) => {
        Papa.parse(file, {
            complete: (results) => {
                const urls = results.data
                    .map((row: any) => row[0]?.trim())
                    .filter((val: string | undefined) => val && val.startsWith('http'));

                setCsvUrls(urls);
                setLogs([{ msg: `Successfully ingested ${urls.length} URLs from CSV.`, time: new Date().toLocaleTimeString(), type: 'info' }]);
                addToast(`${urls.length} URLs loaded from CSV`, 'success');
            },
            header: false
        });
    };

    const SAVE_INTERVAL = 10;

    /**
     * How many ranked leads one "fetch pending" pulls. Matches the worker's
     * DEFAULT_DAILY_SCRAPE_LIMIT, so a batch is about a day of LinkedIn budget —
     * queueing more than that just fixes tomorrow's ordering to today's scores.
     */
    const QUEUE_BATCH_SIZE = Math.max(400, dailyStats.limit);
    
    const handleFetchPendingLeads = async (location: string, autoStart: boolean = false) => {
        try {
            setLogs(prev => [...prev, { msg: `Fetching pending (${location}) leads from CRM...`, time: new Date().toLocaleTimeString(), type: 'info' }]);
            addToast(`Fetching pending ${location} leads...`, 'info');
            // Ranked by fit score, best first, capped at roughly a day of worker
            // budget. Pulling the whole inbox only ever queued the same work in a
            // worse order — see the queue-ordering note in the route.
            const res = await fetch(`/api/crm/leads/${location}?limit=${QUEUE_BATCH_SIZE}`);
            if (res.ok) {
                const data = await res.json();
                const rows = Array.isArray(data) ? data : (data?.leads ?? []);
                if (rows.length > 0) {
                    const urls = rows.map((lead: any) => lead.linkedin_url).filter(Boolean);
                    const total = data?.total ?? urls.length;
                    const scored = data?.scored ?? 0;
                    setCsvUrls(urls);
                    const detail = total > urls.length
                        ? `Loaded top ${urls.length} of ${total} pending (${scored} scored), best fit first.`
                        : `Found ${urls.length} pending leads in CRM (${scored} scored).`;
                    setLogs(prev => [...prev, { msg: detail, time: new Date().toLocaleTimeString(), type: 'success' }]);
                    addToast(`Loaded ${urls.length} leads`, 'success');
                    if (autoStart) {
                        setTimeout(() => {
                            handleStartEngine(0, [], urls, location);
                        }, 500);
                    }
                } else {
                    addToast(`No pending leads found in ${location}`, 'info');
                }
            } else {
                throw new Error('Failed to fetch from CRM');
            }
        } catch (error: any) {
            setLogs(prev => [...prev, { msg: `Error fetching pending leads: ${error.message}`, time: new Date().toLocaleTimeString(), type: 'error' }]);
            addToast('Error fetching pending leads', 'error');
        }
    };

    const handleStartEngine = async (resumeFrom = 0, existingLeads: Lead[] = [], overrideUrls?: string[], targetRegion: string = 'na') => {
        const targetUrls = overrideUrls || csvUrls;
        if (targetUrls.length === 0) {
            addToast('No URLs loaded. Upload a CSV first.', 'error');
            return;
        }

        // Check worker is alive (soft check — don't block if status file hasn't been created yet)
        try {
            const healthRes = await fetch('/api/process-lead');
            const health = await healthRes.json();
            if (health.worker && typeof health.worker === 'object' && health.worker.stale) {
                addToast('Worker appears offline (status stale). Jobs will queue and process when worker starts.', 'info');
            }
        } catch {
            // API unreachable — but don't block, the batch endpoint might still work
            addToast('Could not check worker status — proceeding anyway.', 'info');
        }

        const urlsToProcess = targetUrls.slice(Math.max(0,resumeFrom));
        if (!urlsToProcess.length) { addToast('This saved list is already complete.', 'info'); return; }

        setLogs(prev => [...prev, {
            msg: `Engine Ignition: Sending ${urlsToProcess.length} leads to background queue (Region: ${targetRegion})...`,
            time: new Date().toLocaleTimeString(), type: 'info'
        }]);

        try {
            const res = await fetch('/api/queue-batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ urls: urlsToProcess, nativePostProcess: true, targetRegion: targetRegion.toLowerCase() })
            });

            if (!res.ok) throw new Error("Failed to queue batch");

            const data = await res.json();
            const skipped = data.skipped?.length || 0;
            const summary = `Queued ${data.queuedCount} profiles${skipped ? `; skipped ${skipped} already queued, completed today, or invalid` : ''}.`;
            addToast(summary, data.queuedCount ? 'success' : 'info');
            setLogs(prev => [...prev,{msg:summary,time:new Date().toLocaleTimeString(),type:'info'}]);
            setBatchInfo(summary);
            if (data.queuedCount > 0) setIsProcessing(true);
        } catch (error: any) {
            addToast(`Error queueing jobs: ${error.message}`, 'error');
            setLogs(prev => [...prev, { msg: `Error: ${error.message}`, time: new Date().toLocaleTimeString(), type: 'error' }]);
        }
    };

    const handleResumeFromSave = async () => {
        const saved = await loadProgress();
        if (saved && saved.leads.length > 0) {
            setLogs(prev => [...prev, {
                msg: `📂 Loaded ${saved.processedCount}/${saved.totalCount} leads from saved progress. Resuming...`,
                time: new Date().toLocaleTimeString(), type: 'info'
            }]);
            addToast(`Loaded ${saved.processedCount} leads from saved progress`, 'info');
            handleStartEngine(saved.processedCount, saved.leads);
        } else {
            addToast('No saved progress found.', 'error');
        }
    };

    const handlePause = () => {
        isPausedRef.current = !isPausedRef.current;
        setIsPaused(isPausedRef.current);
        setLogs(prev => [...prev, {
            msg: isPausedRef.current ? '⏸ Processing paused.' : '▶ Processing resumed.',
            time: new Date().toLocaleTimeString(), type: 'info'
        }]);
        addToast(isPausedRef.current ? 'Processing paused' : 'Processing resumed', 'info');
    };

    const handleCancel = async () => {
        isCancelledRef.current = true;
        // Unpause so the pause-wait loop exits and sees the cancel flag
        isPausedRef.current = false;
        setIsPaused(false);
        setLogs(prev => [...prev, {
            msg: '🛑 Cancelling... will stop after the current lead finishes.',
            time: new Date().toLocaleTimeString(), type: 'info'
        }]);
        addToast('Cancelling after current lead...', 'info');

        try {
            await fetch('/api/clear-queue', { method: 'POST' });
            setQueueSize(0);
        } catch (error) {
            // ignore
        }
    };

    const handleRetryFailed = async () => {
        setRetryingFailed(true);
        try {
            const response = await fetch('/api/queue-batch', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'retry_failed'})});
            const data = await response.json();
            if(!response.ok) throw new Error(data.error || 'Could not schedule recovery.');
            addToast(data.queuedCount ? `Recovery queued for ${data.queuedCount} failed profiles; ${data.researchOnly} use their saved scrape.` : 'No failed profiles available to retry.', data.queuedCount ? 'success' : 'info');
            if(data.queuedCount) {setQueueSize(n=>n+data.queuedCount);setIsProcessing(true);}
        } catch(error) {addToast(error instanceof Error ? error.message : 'Could not schedule recovery.', 'error');}
        finally {setRetryingFailed(false);}
    };

    const handleClearQueue = async () => {
        if (!confirm("Are you sure you want to empty the queue? This will delete all pending and processing jobs.")) return;
        try {
            const res = await fetch('/api/clear-queue', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                addToast(`Queue cleared! Deleted ${data.deleted} files.`, 'success');
            } else {
                addToast(data.error || 'Failed to clear queue', 'error');
            }
        } catch (error) {
            addToast('Error clearing queue', 'error');
        }
    };

    const handleExport = () => {
        if (leads.length === 0) return;

        const headers = ["LinkedIn URL", "First Name", "Status", "Activity Status", "Websites", "Emails"];
        const csvCell = (val: string) => `"${val.replace(/"/g, '""')}"`;
        const csvContent = [
            headers.join(","),
            ...leads.map(l => [
                csvCell(l.url),
                csvCell(l.firstName || ''),
                csvCell(l.status),
                csvCell(l.activityStatus || ''),
                csvCell((l.websites || []).join('; ') || l.website || ''),
                csvCell(l.emails.join("; "))
            ].join(","))
        ].join("\n");

        const blob = new Blob([csvContent], { type: 'text/csv' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.setAttribute('hidden', '');
        a.setAttribute('href', url);
        a.setAttribute('download', `Compel_Leads_${new Date().toISOString().slice(0, 10)}.csv`);
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        addToast(`Exported ${leads.length} leads to CSV`, 'success');
    };

    // ── Google Sheets Export ──
    const handleSheetsExport = async () => {
        if (leads.length === 0) return;
        setSheetsExporting(true);
        addToast('Exporting to Google Sheets...', 'info');

        try {
            const result = await exportToGoogleSheets(leads);
            if (result.success && result.url) {
                addToast('Exported to Google Sheets!', 'success');
                window.open(result.url, '_blank');
            } else {
                addToast(result.error || 'Failed to export to Google Sheets', 'error');
            }
        } catch {
            addToast('Google Sheets export failed', 'error');
        } finally {
            setSheetsExporting(false);
        }
    };

    // ── Saved Runs History ──
    const handleOpenHistory = async () => {
        setShowHistory(true);
        setHistoryLoading(true);
        try {
            const runs = await listSavedRuns();
            setSavedRuns(runs);
        } catch {
            addToast('Failed to load saved runs', 'error');
        } finally {
            setHistoryLoading(false);
        }
    };

    const handleLoadRun = async (filename: string) => {
        const data = await loadSavedRun(filename);
        if (data) {
            setLeads(data.leads);
            setProgress(100);
            setShowHistory(false);
            addToast(`Loaded ${data.leads.length} leads from saved run`, 'success');
        } else {
            addToast('Failed to load saved run', 'error');
        }
    };

    const handleDeleteRun = (filename: string) => {
        setConfirmDialog({
            open: true,
            message: `Delete saved run "${filename}"? This cannot be undone.`,
            onConfirm: async () => {
                setConfirmDialog({ open: false, message: '', onConfirm: () => { } });
                const ok = await deleteSavedRun(filename);
                if (ok) {
                    setSavedRuns(prev => prev.filter(r => r.filename !== filename));
                    addToast('Saved run deleted', 'success');
                } else {
                    addToast('Failed to delete saved run', 'error');
                }
            },
        });
    };

    // Dynamic Stats Calculations
    const currentLeads = Array.isArray(leads) ? leads : [];
    const qualifiedCount = currentLeads.filter(l => l.status === 'QUALIFIED').length;
    const activityFailedCount = currentLeads.filter(l => l.status === 'ERROR').length;
    const emailsFound = currentLeads.reduce((acc, curr) => acc + (curr.emails?.length || 0), 0);
    const withEmail = currentLeads.filter(l => (l.emails?.length || 0) > 0).length;

    const screen = SCREENS[activeTab];

    // ── Worker readout ──
    // The API combines the saved daily budget with persisted CRM decisions.
    const doneToday = workerStatus?.dailyCount ?? dailyStats.count ?? 0;
    const dailyLimit = workerStatus?.dailyLimit || dailyStats.limit || 0;
    const qualifiedToday = workerStatus?.dailyQualified ?? 0;
    const rejectedToday = workerStatus?.dailyRejected ?? 0;
    const failedToday = workerStatus?.dailyErrors ?? 0;
    const reviewedToday = (workerStatus?.dailyReview ?? 0) + (workerStatus?.dailyNurture ?? 0);
    const judgedToday = workerStatus?.dailyCompleted ?? qualifiedToday + rejectedToday + reviewedToday + failedToday;
    const passRate = judgedToday > 0 ? Math.round((qualifiedToday / judgedToday) * 100) : null;
    const budgetPct = dailyLimit > 0 ? Math.min(100, Math.round(((workerStatus?.dailyBudgetCount ?? doneToday) / dailyLimit) * 100)) : 0;
    const perHour = workerStatus?.ratePerHour ?? (workerStatus?.avgJobDurationMs
        ? Math.round(3600000 / workerStatus.avgJobDurationMs)
        : null);

    // "Offline" and "idle" look identical in a status file — the difference is
    // whether the heartbeat is still being written. Say which one it is.
    const workerState: 'running' | 'paused' | 'idle' | 'offline' =
        workerStatus?.stale || !workerStatus ? 'offline'
            : workerStatus.status === 'processing' ? 'running'
                : workerStatus.status === 'paused' ? 'paused'
                    : 'idle';
    const workerLabel = {
        running: 'Worker running',
        paused: 'Worker paused',
        idle: 'Worker idle',
        offline: 'Worker offline',
    }[workerState];
    const workerDot = {
        running: '',
        paused: 'dot-warn',
        idle: 'dot-idle',
        offline: 'dot-bad',
    }[workerState];

    // ── Tool readouts ──
    const hunterUrlCount = hunterUrls
        .split('\n')
        .filter(u => { const t = u.trim(); return t.length > 3 && !t.startsWith('#'); })
        .length;

    const unbouncerDetected = new Set(
        unbouncerInput
            .split('\n')
            .map(e => e.trim().toLowerCase())
            .filter(e => e.length > 3 && e.includes('@')),
    ).size;

    const verifyCounts = {
        VALID: unbouncerResults.filter(r => r.status === 'VALID').length,
        RISKY: unbouncerResults.filter(r => r.status === 'RISKY').length,
        UNKNOWN: unbouncerResults.filter(r => r.status === 'UNKNOWN').length,
        INVALID: unbouncerResults.filter(r => r.status === 'INVALID').length,
    };
    // How much of "no answer" is actually about this machine rather than the
    // addresses. Without it the unknown pile reads as a pile of dead leads.
    const hostRefusedCount = unbouncerResults.filter(
        r => r.status === 'UNKNOWN' && /refused our probe/i.test(r.reason || ''),
    ).length;

    // ── Email Hunter handlers ──
    const handleHunterCancel = () => {
        hunterCancelledRef.current = true;
        addToast('Cancelling after current website finishes...', 'info');
    };

    const handleHunterStart = async () => {
        const urls = hunterUrls
            .split('\n')
            .map(u => u.trim())
            .filter(u => u.length > 3 && !u.startsWith('#'));

        if (urls.length === 0) {
            addToast('Paste some website URLs first (one per line).', 'error');
            return;
        }

        hunterCancelledRef.current = false;
        setHunterProcessing(true);
        setHunterResults([]);
        setHunterProgress(0);
        setHunterTotal(urls.length);

        const results: WebsiteScrapeResult[] = [];

        for (let i = 0; i < urls.length; i++) {
            if (hunterCancelledRef.current) {
                addToast(`Cancelled at ${i}/${urls.length}.`, 'info');
                break;
            }

            try {
                const scrapePromise = scrapeWebsiteEmails(urls[i]);
                const cancelPromise = new Promise((_, reject) => {
                    const int = setInterval(() => {
                        if (hunterCancelledRef.current) {
                            clearInterval(int);
                            reject(new Error("CANCELLED"));
                        }
                    }, 500);
                });
                
                const result = await Promise.race([scrapePromise, cancelPromise]) as WebsiteScrapeResult;
                results.push(result);
                setHunterResults([...results]);
            } catch (error: any) {
                if (error.message === "CANCELLED") {
                    break;
                }
                results.push({ website: urls[i], emails: [], status: 'ERROR', error: 'Unknown error' });
                setHunterResults([...results]);
            }
            setHunterProgress(i + 1);
        }

        setHunterProcessing(false);
        setHunterResults([...results]);
        const totalEmails = results.reduce((acc, r) => acc + r.emails.length, 0);
        addToast(`Done! Found ${totalEmails} email(s) across ${results.length} website(s).`, 'success');
    };

    const handleHunterExport = () => {
        if (hunterResults.length === 0) return;
        const csvCell = (val: string) => `"${val.replace(/"/g, '""')}"`;
        const rows = [
            'Website,Emails,Status',
            ...hunterResults.map(r => [
                csvCell(r.website),
                csvCell(r.emails.join('; ')),
                csvCell(r.status),
            ].join(','))
        ].join('\n');
        const blob = new Blob([rows], { type: 'text/csv' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `Email_Hunter_${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        addToast(`Exported ${hunterResults.length} results to CSV`, 'success');
    };

    const handleHunterCSV = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        Papa.parse(file, {
            complete: (results) => {
                // Find the website/domain column by header name
                const headers = (results.meta?.fields || []).map((h: string) => h.toLowerCase().trim());
                const websiteCol = results.meta?.fields?.find((_: string, i: number) => {
                    const h = headers[i];
                    return h === 'website' || h === 'domain' || h === 'url' || h === 'site' || h === 'web';
                });

                let urls: string[] = [];
                if (websiteCol) {
                    // Extract from the matched column
                    urls = (results.data as any[])
                        .map((row: any) => String(row[websiteCol] || '').trim())
                        .filter((val: string) => val.length > 3 && (val.includes('.') || val.startsWith('http')))
                        .filter((val: string) => !val.toLowerCase().includes('linkedin.com'));
                } else {
                    addToast('No "website" or "domain" column found in CSV. Please check headers.', 'error');
                    return;
                }

                setHunterUrls(urls.join('\n'));
                addToast(`${urls.length} website URLs loaded from "${websiteCol}" column`, 'success');
            },
            header: true,
            skipEmptyLines: true,
        });
    };

    // ── Email Unbouncer handlers ──
    const handleUnbouncerStart = async () => {
        const rawEmails = unbouncerInput
            .split('\n')
            .map(e => e.trim().toLowerCase())
            .filter(e => e.length > 3 && e.includes('@'));

        // Deduplicate emails to avoid spending credits on repeated addresses.
        const emails = [...new Set(rawEmails)];
        const dupeCount = rawEmails.length - emails.length;

        if (emails.length === 0) {
            addToast('Paste some emails first (one per line) or upload a CSV.', 'error');
            return;
        }

        try {
            const readiness = await getVerificationReadiness();
            if (!readiness.ready) {
                addToast(readiness.message, 'error');
                return;
            }
        } catch {
            addToast('Could not connect to the verifier. Reload and try again.', 'error');
            return;
        }

        if (dupeCount > 0) {
            addToast(`Removed ${dupeCount} duplicate email(s). Verifying ${emails.length} unique.`, 'info');
        }

        unbouncerCancelledRef.current = false;
        setUnbouncerProcessing(true);
        setUnbouncerResults([]);
        setUnbouncerProgress(0);
        setUnbouncerTotal(emails.length);

        const allResults: VerificationResult[] = [];
        const BATCH_SIZE = 5; // Small batches keep progress and credit balances current.
        let requestFailed = false;

        for (let i = 0; i < emails.length; i += BATCH_SIZE) {
            if (unbouncerCancelledRef.current) {
                addToast(`Cancelled at ${allResults.length}/${emails.length}. Results preserved.`, 'info');
                break;
            }

                const batch = emails.slice(i, i + BATCH_SIZE);
                const batchPayload = batch.map(address => ({
                    address,
                    source: unbouncerSourceMap[address],
                }));
            const batchNum = Math.floor(i / BATCH_SIZE) + 1;
            const totalBatches = Math.ceil(emails.length / BATCH_SIZE);

            try {
                addToast(`Processing batch ${batchNum}/${totalBatches} (${batch.length} emails)...`, 'info');
                
                // Server Actions cannot cancel a running provider call. Finish
                // the current bounded batch, then honour cancellation before the next.
                const batchResults = await verifyEmailBatchFast(batchPayload);
                allResults.push(...batchResults);
                if (batchResults.some(result => result.stopRun)) {
                    requestFailed = true;
                    addToast(batchResults.find(result => result.error)?.reason || 'Verification stopped. Retry later.', 'error');
                }
            } catch {
                // An automatic retry could charge twice for a partially completed request.
                requestFailed = true;
                addToast('Verification request failed. Completed results are preserved; retry the remaining addresses.', 'error');
            }

            // Update UI once per batch (not per email)
            setUnbouncerResults([...allResults]);
            setUnbouncerProgress(Math.min(allResults.length, emails.length));
            if (requestFailed) break;
        }

        setUnbouncerProcessing(false);
        const validCount = allResults.filter(r => r.status === 'VALID').length;
        if (!requestFailed && !unbouncerCancelledRef.current) addToast(`Done! ${validCount} safe to send out of ${allResults.length} emails checked.`, 'success');
    };

    const handleUnbouncerCancel = () => {
        unbouncerCancelledRef.current = true;
        addToast('Cancelling after current batch...', 'info');
    };

    const handleUnbouncerCSV = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        Papa.parse(file, {
            complete: (results) => {
                const headers = (results.meta?.fields || []).map((h: string) => h.toLowerCase().trim());
                const emailCol = results.meta?.fields?.find((_: string, i: number) => {
                    const h = headers[i];
                    return h === 'email' || h === 'emails' || h === 'e-mail' || h === 'email_address' || h === 'emailaddress' || h === 'mail';
                });

                const sourceCol = results.meta?.fields?.find((_: string, i: number) => headers[i] === 'source');
                let emails: string[] = [];
                let sourceMap: Record<string, string> = {};
                
                if (emailCol) {
                    const validRows = (results.data as any[])
                        .filter(row => {
                            const em = String(row[emailCol] || '').trim().toLowerCase();
                            return em.length > 3 && em.includes('@');
                        });
                    
                    emails = validRows.map(row => String(row[emailCol] || '').trim().toLowerCase());
                    
                    if (sourceCol) {
                        validRows.forEach(row => {
                            const em = String(row[emailCol] || '').trim().toLowerCase();
                            const src = String(row[sourceCol] || '').trim().toLowerCase();
                            if (src) sourceMap[em] = src;
                        });
                    }
                } else {
                    addToast('No "email" column found in CSV. Expected: email, emails, e-mail, email_address, or mail.', 'error');
                    return;
                }

                setUnbouncerSourceMap(sourceMap);
                setUnbouncerInput(emails.join('\n'));
                addToast(`${emails.length} emails loaded from "${emailCol}" column`, 'success');
            },
            header: true,
            skipEmptyLines: true,
        });
        // Reset file input so same file can be re-uploaded
        e.target.value = '';
    };

    const handleUnbouncerExport = () => {
        if (unbouncerResults.length === 0) return;
        const csvCell = (val: string) => `"${val.replace(/"/g, '""')}"`;
        const rows = [
            'Email,Status,Score,Method,Checked At,Expires At,Syntax,MX Record,Disposable,Role Account,Free Provider,SMTP Valid,Catch-All,Provider,Reason',
            ...unbouncerResults.map(r => [
                csvCell(r.email),
                csvCell(r.status),
                r.score,
                csvCell(r.method || ''),
                csvCell(r.checkedAt || ''),
                csvCell(r.expiresAt || ''),
                r.checks.syntax ? 'Yes' : 'No',
                r.checks.mxRecord ? 'Yes' : 'No',
                r.checks.disposable ? 'Yes' : 'No',
                r.checks.roleAccount ? 'Yes' : 'No',
                r.checks.freeProvider ? 'Yes' : 'No',
                r.checks.smtpValid === null ? 'N/A' : r.checks.smtpValid ? 'Yes' : 'No',
                r.checks.catchAll === null ? 'N/A' : r.checks.catchAll ? 'Yes' : 'No',
                csvCell(r.provider || ''),
                csvCell(r.reason),
            ].join(','))
        ].join('\n');
        const blob = new Blob([rows], { type: 'text/csv' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `Email_Verification_${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        addToast(`Exported ${unbouncerResults.length} verification results to CSV`, 'success');
    };

    const handleUnbouncerExportValid = () => {
        const valid = unbouncerResults.filter(r => r.status === 'VALID');
        if (valid.length === 0) { addToast('No valid emails to export.', 'error'); return; }
        const csvCell = (val: string) => `"${val.replace(/"/g, '""')}"`;
        const rows = ['Email,Score,Method,Checked At,Expires At,Provider,Reason', ...valid.map(r => [
            csvCell(r.email), r.score, csvCell(r.method || ''), csvCell(r.checkedAt || ''), csvCell(r.expiresAt || ''), csvCell(r.provider || ''), csvCell(r.reason),
        ].join(','))].join('\n');
        const blob = new Blob([rows], { type: 'text/csv' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `Valid_Emails_${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        addToast(`Exported ${valid.length} valid emails to CSV`, 'success');
    };

    return (
        <>
            <div className="flex min-h-screen">
                <aside className="sidebar w-[236px] flex-none hidden lg:flex flex-col sticky top-0 h-screen">
                    <div className="flex items-center gap-3 px-5 h-[76px] border-b border-[#2b3d5b] flex-none">
                        <span className="w-9 h-9 rounded-xl bg-[#5373e8] text-white flex items-center justify-center text-lg font-bold shadow-[0_5px_12px_rgba(4,12,29,0.28)]" aria-hidden>C</span>
                        <span className="min-w-0">
                            <span className="block text-[16px] leading-tight font-semibold tracking-tight text-white">Compel</span>
                            <span className="block text-[11px] text-[#afbfda] mt-0.5">Workspace</span>
                        </span>
                    </div>

                    <nav className="flex-1 overflow-y-auto p-3.5 space-y-6 pt-6" aria-label="Main navigation">
                        <div className="space-y-0.5">
                            <p className="label-micro px-3 pb-2">Workspace</p>
                            {NAV_SECTIONS.workspace.map(item => <button key={item.id} onClick={() => { if (item.id === 'case-study') setCaseStudyEntryView('TODAY'); setActiveTab(item.id); }} className={cn('nav-item', activeTab === item.id && 'nav-item-active')}><item.icon className="w-4 h-4 flex-none" />{item.label}</button>)}
                        </div>
                        <div className="space-y-0.5">
                            <p className="label-micro px-3 pb-2">Pipeline</p>
                            {NAV_SECTIONS.pipeline.map(item => (
                                <button
                                    key={item.id}
                                    onClick={() => setActiveTab(item.id)}
                                    className={cn("nav-item", item.signal && "nav-item-signal", activeTab === item.id && "nav-item-active")}
                                >
                                    <item.icon className="w-4 h-4 flex-none" />
                                    {item.label}
                                    {item.id === 'engine' && queueSize > 0 && (
                                        <span className="nav-count">{queueSize}</span>
                                    )}
                                </button>
                            ))}
                        </div>
                        <div className="space-y-0.5">
                            <p className="label-micro px-3 pb-2">Tools</p>
                            {NAV_SECTIONS.tools.map(item => (
                                <button
                                    key={item.id}
                                    onClick={() => setActiveTab(item.id)}
                                    className={cn("nav-item", activeTab === item.id && "nav-item-active")}
                                >
                                    <item.icon className="w-4 h-4 flex-none" />
                                    {item.label}
                                </button>
                            ))}
                        </div>
                    </nav>

                    <div className="flex-none border-t border-[#2b3d5b] px-5 py-4 bg-[#1c2c47]">
                        <div className="flex items-center gap-2">
                            <span className={cn("dot-live", workerDot)} aria-hidden />
                            <span className="text-[12px] font-medium text-[#d2dcef]">{workerLabel}</span>
                        </div>
                        <p className="text-[11px] text-[#a9b9d2] mt-1.5">
                            <span className="num">{doneToday.toLocaleString()}</span>
                            {dailyLimit > 0 && <> of <span className="num">{dailyLimit.toLocaleString()}</span></>} profiles today
                        </p>
                    </div>
                </aside>

                <div className="flex-1 min-w-0 flex flex-col">
                    <div className="lg:hidden topbar px-4 py-3 flex items-center gap-3">
                        <span className="w-8 h-8 rounded-lg bg-[var(--signal)] text-white flex items-center justify-center font-bold flex-none" aria-label="Compel">C</span>
                        <div className="tabs">
                            {[...NAV_SECTIONS.workspace, ...NAV_SECTIONS.pipeline, ...NAV_SECTIONS.tools].map(item => (
                                <button
                                    key={item.id}
                                    onClick={() => setActiveTab(item.id)}
                                    className={cn("tab", item.signal && "tab-signal", activeTab === item.id && "tab-active")}
                                >
                                    {item.label}
                                </button>
                            ))}
                        </div>
                    </div>

                    <header className="topbar min-h-[76px] px-4 md:px-6 lg:px-8 py-4 flex items-center gap-4 flex-none sticky top-0 z-20">
                        <div className="min-w-0">
                            <h1 className="text-[21px] leading-tight font-semibold tracking-[-0.035em] text-[var(--text)] truncate">{screen.title}</h1>
                            <p className="text-[12px] text-[var(--text-dim)] truncate mt-0.5 hidden sm:block">{screen.sub}</p>
                        </div>
                        <div className="ml-auto flex items-center gap-1.5 flex-none">
                            {activeTab === 'engine' && (
                                <>
                                    <button onClick={handleOpenHistory} className="btn btn-ghost !px-2" title="Saved runs">
                                        <History className="w-3.5 h-3.5" />
                                    </button>
                                    <button onClick={handleExport} disabled={leads.length === 0} className="btn btn-outline">
                                        <Download className="w-3.5 h-3.5" />
                                        Export
                                    </button>
                                    {sheetsConfigured && (
                                        <button onClick={handleSheetsExport} disabled={leads.length === 0 || sheetsExporting} className="btn btn-outline">
                                            {sheetsExporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sheet className="w-3.5 h-3.5" />}
                                            Sheets
                                        </button>
                                    )}
                                </>
                            )}
                        </div>
                    </header>

                    <main className="flex-1 min-w-0 p-4 md:p-6 lg:p-8">

                {activeTab === 'engine' ? (
                    <div className="space-y-4">
                        {/*
                         * Three figures, not eight. The row this replaced showed Total /
                         * Gate Passed / Emails Found / Efficiency / Activity Failed —
                         * five tiles of which four described the same handful of leads,
                         * so none of them was read. These three answer the only
                         * questions the screen exists for: is there work, is it moving,
                         * and is any of it any good.
                         */}
                        <div className="figures">
                            <div className="fig">
                                <div className="fig-value">{queueSize.toLocaleString()}</div>
                                <p className="label-micro mt-2">In queue</p>
                                <p className="fig-sub">
                                    {queueSize === 0
                                        ? 'Nothing waiting — queue a region below'
                                        : 'Profiles waiting for the worker'}
                                </p>
                            </div>
                            <div className="fig">
                                <div className="fig-value">
                                    {doneToday.toLocaleString()}
                                    {dailyLimit > 0 && (
                                        <span className="text-[var(--text-faint)] text-[17px] font-medium"> / {dailyLimit.toLocaleString()}</span>
                                    )}
                                </div>
                                <p className="label-micro mt-2">Distinct profiles today</p>
                                {/* The budget bar belongs against the number it qualifies,
                                    not in a panel two columns away. */}
                                {dailyLimit > 0 && (
                                    <div className="bar-track mt-2.5 max-w-[220px]">
                                        <div className={cn("bar-fill", budgetPct >= 100 && "bar-fill-warn")} style={{ width: `${budgetPct}%` }} />
                                    </div>
                                )}
                                <p className="fig-sub">
                                    {dailyLimit > 0
                                        ? `${(workerStatus?.dailyRemaining ?? Math.max(0, dailyLimit - doneToday)).toLocaleString()} left in today's budget`
                                        : 'No daily cap configured'}
                                </p>
                                <p className="fig-sub">Retries use no extra slots</p>
                            </div>
                            <div className="fig">
                                <div className="fig-value fig-value-signal">{qualifiedToday.toLocaleString()}</div>
                                <p className="label-micro mt-2">Qualified today</p>
                                <p className="fig-sub">
                                    {passRate === null
                                        ? 'No completed profiles yet today'
                                        : `${passRate}% of ${judgedToday.toLocaleString()} distinct profiles completed`}
                                </p>
                                {failedToday > 0 && <p className="fig-sub">{failedToday.toLocaleString()} need attention</p>}
                            </div>
                        </div>

                        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)] gap-4 items-start">
                            {/* ── Start a run ────────────────────────────────────── */}
                            <section className="panel">
                                <div className="panel-head">
                                    Start a run
                                    {csvUrls.length > 0 && (
                                        <span className="hint">
                                            <span className="num">{csvUrls.length.toLocaleString()}</span> profiles loaded
                                        </span>
                                    )}
                                </div>

                                <div className="panel-body space-y-5">
                                    {/*
                                     * Three regions, not two. For an unscraped lead the
                                     * location field holds the search location, not the
                                     * person's, and a large legacy cohort reads literally
                                     * 'Unknown' — all of which buckets to OTHER. With only
                                     * NA and UK buttons the overwhelming majority of the
                                     * inbox was unreachable from this screen entirely.
                                     */}
                                    <div>
                                        <p className="field-label">Pull from the leads you already have</p>
                                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                                            <button onClick={() => handleFetchPendingLeads('NA', true)} className="btn btn-outline justify-start">
                                                <Database className="w-3.5 h-3.5" />
                                                North America
                                            </button>
                                            <button onClick={() => handleFetchPendingLeads('UK', true)} className="btn btn-outline justify-start">
                                                <Database className="w-3.5 h-3.5" />
                                                United Kingdom
                                            </button>
                                            <button onClick={() => handleFetchPendingLeads('OTHER', true)} className="btn btn-outline justify-start">
                                                <Database className="w-3.5 h-3.5" />
                                                Everywhere else
                                            </button>
                                        </div>
                                        <p className="field-hint">
                                            Takes the best-scoring <span className="num">{QUEUE_BATCH_SIZE}</span> profiles
                                            waiting in that region and starts straight away. Most of your list is in
                                            &ldquo;everywhere else&rdquo;.
                                        </p>
                                    </div>

                                    <div className="flex items-center gap-3" aria-hidden>
                                        <span className="h-px flex-1 bg-[var(--line)]" />
                                        <span className="label-micro">or upload a list</span>
                                        <span className="h-px flex-1 bg-[var(--line)]" />
                                    </div>

                                    <div
                                        onDragOver={handleDragOver}
                                        onDragLeave={handleDragLeave}
                                        onDrop={handleDrop}
                                        className={cn(
                                            "drop px-5 py-6 flex items-center gap-4 cursor-pointer",
                                            isDragging && "drop-active",
                                            csvUrls.length > 0 && !isDragging && "drop-loaded",
                                        )}
                                    >
                                        <input
                                            type="file"
                                            accept=".csv"
                                            onChange={handleFileChange}
                                            className="absolute inset-0 opacity-0 cursor-pointer z-20"
                                            aria-label="Upload a CSV of LinkedIn URLs"
                                        />
                                        <Upload className={cn("w-5 h-5 flex-none", csvUrls.length > 0 ? "text-[var(--signal)]" : "text-[var(--text-faint)]")} />
                                        <div className="min-w-0">
                                            <p className="text-[13px] font-medium text-[var(--text)]">
                                                {csvUrls.length > 0
                                                    ? <><span className="num">{csvUrls.length.toLocaleString()}</span> profiles ready</>
                                                    : "Drop a CSV here, or click to choose one"}
                                            </p>
                                            <p className="text-[11.5px] text-[var(--text-faint)] mt-0.5">
                                                One LinkedIn URL per row, first column
                                            </p>
                                        </div>
                                    </div>

                                    <div className="flex flex-wrap items-center gap-2 pt-1">
                                        {!isProcessing ? (
                                            <button
                                                onClick={() => handleStartEngine()}
                                                disabled={csvUrls.length === 0}
                                                className="btn btn-primary btn-lg"
                                            >
                                                <Play className="w-3.5 h-3.5" />
                                                {csvUrls.length > 0
                                                    ? `Queue ${csvUrls.length.toLocaleString()} profiles`
                                                    : 'Queue profiles'}
                                            </button>
                                        ) : (
                                            <>
                                                <button onClick={handlePause} className="btn btn-outline btn-lg">
                                                    {isPaused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
                                                    {isPaused ? 'Resume' : 'Pause'}
                                                </button>
                                                <button onClick={handleCancel} className="btn btn-danger btn-lg" title="Stop after the profile in flight">
                                                    <StopCircle className="w-3.5 h-3.5" />
                                                    Stop
                                                </button>
                                            </>
                                        )}

                                        <span className="flex-1" />

                                        <button
                                            onClick={handleResumeFromSave}
                                            disabled={isProcessing || csvUrls.length === 0}
                                            className="btn btn-ghost"
                                            title="Pick up the last saved run where it stopped"
                                        >
                                            <RotateCcw className="w-3.5 h-3.5" />
                                            Resume last
                                        </button>
                                        <button
                                            onClick={handleRetryFailed}
                                            disabled={retryingFailed}
                                            className="btn btn-ghost"
                                            title="Recover failed profiles, using saved scrapes when available"
                                        >
                                            <RotateCcw className="w-3.5 h-3.5" />
                                            Retry failed
                                            {activityFailedCount > 0 && <span className="num text-[var(--warn)]">{activityFailedCount}</span>}
                                        </button>
                                        <button onClick={handleClearQueue} className="btn btn-ghost !text-[var(--bad)]" title="Delete every pending job">
                                            <Trash2 className="w-3.5 h-3.5" />
                                            Empty queue
                                        </button>
                                    </div>
                                </div>
                            </section>

                            {/* ── Worker, and what it is doing ───────────────────── */}
                            <div className="space-y-4">
                                <LinkedInAccounts />
                                <section className={cn("panel", workerState === 'running' && "rail-live")}>
                                <div className="panel-head">
                                    <Server className="w-3.5 h-3.5 text-[var(--text-faint)]" />
                                    Worker
                                    <span className="hint flex items-center gap-1.5">
                                        <span className={cn("dot-live", workerDot)} aria-hidden />
                                        {workerLabel.replace('Worker ', '')}
                                    </span>
                                </div>

                                <div className="panel-body space-y-4">
                                    <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                                        <div>
                                            <p className="label-micro">Rate</p>
                                            <p className="num text-[15px] text-[var(--text)] mt-0.5">
                                                {perHour !== null ? `${perHour}/hr` : '—'}
                                            </p>
                                        </div>
                                        <div>
                                            <p className="label-micro">Memory</p>
                                            <p className="num text-[15px] text-[var(--text)] mt-0.5">
                                                {workerStatus?.memoryMB ? `${workerStatus.memoryMB} MB` : '—'}
                                            </p>
                                        </div>
                                        <div>
                                            <p className="label-micro">Qualified</p>
                                            <p className="num text-[15px] text-[var(--signal)] mt-0.5">{qualifiedToday.toLocaleString()}</p>
                                        </div>
                                        <div>
                                            <p className="label-micro">Rejected</p>
                                            <p className="num text-[15px] text-[var(--text-dim)] mt-0.5">{rejectedToday.toLocaleString()}</p>
                                        </div>
                                    </div>

                                    {workerState === 'running' && workerStatus?.url && (
                                        <div className="pt-3 border-t border-[var(--line)]">
                                            <p className="label-micro">Now scraping</p>
                                            <p className="text-[12px] text-[var(--text-dim)] truncate mt-1 font-[family-name:var(--font-mono)]">
                                                {workerStatus.url.split('/in/')[1] || workerStatus.url}
                                            </p>
                                        </div>
                                    )}
                                </div>

                                {workerState === 'paused' && workerStatus?.pauseReason === 'DAILY_LIMIT' && <p role="status" className="panel-note">
                                    Daily profile limit reached. {queueSize.toLocaleString()} queued profiles are saved. New profiles resume {workerStatus.nextDailyResetAt ? `after ${new Date(workerStatus.nextDailyResetAt).toLocaleString()}` : 'when the daily allowance resets'} while the worker is running. Retries and saved website research can continue without another daily slot.
                                </p>}
                                {workerStatus?.waitingCount > 0 && <p role="status" className="panel-note">
                                    {workerStatus.waitingCount} profiles retained for automatic retry. {workerStatus.nextRetryAt ? `Next retry after ${new Date(workerStatus.nextRetryAt).toLocaleTimeString()}.` : ''} Saved scrapes do not use another LinkedIn daily slot.
                                </p>}
                                {workerState === 'offline' && (
                                    <div className="panel-note">
                                        The worker isn&rsquo;t reporting in. Anything you queue is kept and
                                        processed as soon as it starts again.
                                    </div>
                                )}
                                </section>

                                {/* ── Activity ───────────────────────────────── */}
                                {/* Sits under the worker rather than at the foot of
                                    the page: it is the worker talking, and down there
                                    it was below the fold whenever results existed. */}
                                <section className="panel">
                                    <div className="panel-head">
                                        Activity
                                        <span className="hint">{logs.length > 0 ? 'Newest last' : 'Quiet'}</span>
                                    </div>
                                    <div className="panel-body max-h-[260px] overflow-y-auto">
                                        {logs.length > 0 ? (
                                            <div className="space-y-1">
                                                {logs.map((log, i) => (
                                                    <div
                                                        key={i}
                                                        className={cn(
                                                            "feed-row",
                                                            log.type === 'success' && "feed-row-ok",
                                                            log.type === 'error' && "feed-row-bad",
                                                        )}
                                                    >
                                                        <p className="text-[12.5px] text-[var(--text-dim)] leading-snug break-words">{log.msg}</p>
                                                        <p className="feed-time mt-0.5">{log.time}</p>
                                                    </div>
                                                ))}
                                            </div>
                                        ) : (
                                            <p className="text-[12.5px] text-[var(--text-faint)]">
                                                Nothing has run yet. What the worker does shows up here.
                                            </p>
                                        )}
                                    </div>
                                </section>
                            </div>
                        </div>

                        {/* ── Results ────────────────────────────────────────────── */}
                        <section className="panel">
                            <div className="panel-head">
                                Results
                                <span className="hint">
                                    {currentLeads.length > 0
                                        ? <>
                                            <span className="num">{currentLeads.length.toLocaleString()}</span> profiles ·{' '}
                                            <span className="num">{qualifiedCount.toLocaleString()}</span> qualified ·{' '}
                                            <span className="num">{withEmail.toLocaleString()}</span> with an address
                                        </>
                                        : 'Nothing yet'}
                                </span>
                            </div>

                            <div className="tbl-wrap !border-0 !rounded-none">
                                <table className="w-full text-[13px]">
                                    <thead>
                                        <tr className="tbl-head">
                                            <th className="text-right px-4 py-2.5 w-12">#</th>
                                            <th className="text-left px-4 py-2.5">Profile</th>
                                            <th className="text-left px-4 py-2.5">Name</th>
                                            <th className="text-left px-4 py-2.5">Status</th>
                                            <th className="text-left px-4 py-2.5">Website</th>
                                            <th className="text-left px-4 py-2.5">Email</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {currentLeads.length > 0 ? currentLeads.map((lead, i) => {
                                            const slug = lead.url.match(/linkedin\.com\/in\/([^\/]+)/)?.[1] || lead.url;
                                            const sites = (lead.websites && lead.websites.length > 0)
                                                ? lead.websites
                                                : lead.website ? [lead.website] : [];
                                            return (
                                                <tr key={i} className="tbl-row">
                                                    <td className="px-4 py-2.5 num text-[11px] text-[var(--text-faint)] text-right align-top">{i + 1}</td>
                                                    <td className="px-4 py-2.5 align-top">
                                                        <a
                                                            href={lead.url}
                                                            target="_blank"
                                                            rel="noopener noreferrer"
                                                            className="inline-flex items-center gap-1.5 text-[var(--text-dim)] hover:text-[var(--text)] transition-colors group"
                                                        >
                                                            <span className="truncate max-w-[190px]">{slug}</span>
                                                            <ExternalLink className="w-3 h-3 flex-none opacity-0 group-hover:opacity-100 transition-opacity" />
                                                        </a>
                                                    </td>
                                                    <td className="px-4 py-2.5 align-top text-[var(--text)]">
                                                        {lead.firstName || <span className="text-[var(--text-faint)]">—</span>}
                                                    </td>
                                                    <td className="px-4 py-2.5 align-top">
                                                        <div className="flex items-center gap-2">
                                                            <LeadStatusMark status={lead.status} researched={!!lead.prospectQualification} />
                                                            {lead.timedOut && <span className="badge badge-warn">TIMED OUT</span>}
                                                        </div>
                                                        {lead.status === 'ERROR' && <p className="mt-1 text-xs text-[var(--text-dim)] max-w-64">{failureOf(lead).reason}</p>}
                                                        {lead.status === 'REJECTED' && lead.prospectQualification?.nextAction && <p className="mt-1 text-xs text-[var(--text-dim)] max-w-64">{lead.prospectQualification.nextAction}</p>}
                                                        {lead.prospectQualification?.research?.crawl && <p className="mt-1 text-xs text-[var(--text-faint)] max-w-64">{lead.prospectQualification.research.crawl.inspected} pages read · {lead.prospectQualification.research.crawl.complete ? 'Crawl complete' : lead.prospectQualification.research.crawl.retryable === false ? 'Website needs attention' : 'Crawl saved for retry'}</p>}
                                                    </td>
                                                    <td className="px-4 py-2.5 align-top">
                                                        {sites.length > 0 ? (
                                                            <div className="flex flex-col gap-1">
                                                                {sites.map((w, wi) => (
                                                                    <a
                                                                        key={wi}
                                                                        href={w}
                                                                        target="_blank"
                                                                        rel="noopener noreferrer"
                                                                        className="text-[12px] text-[var(--text-dim)] hover:text-[var(--text)] transition-colors truncate max-w-[210px]"
                                                                    >
                                                                        {w.replace(/^https?:\/\/(www\.)?/, '')}
                                                                    </a>
                                                                ))}
                                                            </div>
                                                        ) : <span className="text-[var(--text-faint)]">—</span>}
                                                    </td>
                                                    <td className="px-4 py-2.5 align-top">
                                                        {lead.emails.length > 0 ? (
                                                            <div className="flex flex-col gap-1">
                                                                {lead.emails.map((email, ei) => (
                                                                    <span key={ei} className={cn("text-[12px] font-[family-name:var(--font-mono)]", ei === 0 ? "text-[var(--signal)]" : "text-[var(--text-faint)]")}>
                                                                        {email}
                                                                    </span>
                                                                ))}
                                                            </div>
                                                        ) : <span className="text-[var(--text-faint)]">—</span>}
                                                    </td>
                                                </tr>
                                            );
                                        }) : (
                                            <tr>
                                                <td colSpan={6} className="px-4 py-16 text-center">
                                                    <p className="text-[13px] text-[var(--text-dim)]">No runs yet today.</p>
                                                    <p className="text-[12px] text-[var(--text-faint)] mt-1">
                                                        Pick a region above to start one.
                                                    </p>
                                                </td>
                                            </tr>
                                        )}
                                    </tbody>
                                </table>
                            </div>
                        </section>

                    </div>
                ) : activeTab === 'hunter' ? (
                    /* ── Find email: websites in, addresses out ── */
                    <div className="space-y-4 max-w-[1100px]">
                        <section className="panel">
                            <div className="panel-head">
                                Websites
                                <span className="hint">
                                    {hunterUrlCount > 0
                                        ? <><span className="num">{hunterUrlCount.toLocaleString()}</span> ready</>
                                        : 'One per line'}
                                </span>
                            </div>
                            <div className="panel-body space-y-3">
                                <textarea
                                    value={hunterUrls}
                                    onChange={e => setHunterUrls(e.target.value)}
                                    placeholder={"https://www.example.com\nhttps://coaching-site.com\nwww.another-site.io"}
                                    className="field w-full h-40 resize-y font-[family-name:var(--font-mono)] text-[12.5px] leading-relaxed"
                                    disabled={hunterProcessing}
                                />

                                <div className="flex items-center gap-2 flex-wrap">
                                    {!hunterProcessing ? (
                                        <button
                                            onClick={handleHunterStart}
                                            disabled={hunterUrls.trim().length === 0}
                                            className="btn btn-primary btn-lg"
                                        >
                                            <Search className="w-3.5 h-3.5" />
                                            Find addresses
                                        </button>
                                    ) : (
                                        <button onClick={handleHunterCancel} className="btn btn-danger btn-lg">
                                            <StopCircle className="w-3.5 h-3.5" />
                                            Stop
                                        </button>
                                    )}

                                    <label className="btn btn-outline cursor-pointer">
                                        <Upload className="w-3.5 h-3.5" />
                                        Load CSV
                                        <input type="file" accept=".csv" onChange={handleHunterCSV} className="hidden" />
                                    </label>

                                    <span className="flex-1" />

                                    {hunterResults.length > 0 && (
                                        <button onClick={handleHunterExport} className="btn btn-ghost">
                                            <Download className="w-3.5 h-3.5" />
                                            Export
                                        </button>
                                    )}
                                </div>

                                {hunterProcessing && (
                                    <div>
                                        <div className="bar-track">
                                            <div
                                                className="bar-fill"
                                                style={{ width: `${hunterTotal > 0 ? (hunterProgress / hunterTotal) * 100 : 0}%` }}
                                            />
                                        </div>
                                        <p className="text-[11.5px] text-[var(--text-faint)] mt-2">
                                            <span className="num">{hunterProgress}</span> of <span className="num">{hunterTotal}</span> websites checked
                                        </p>
                                    </div>
                                )}
                            </div>
                        </section>

                        {hunterResults.length > 0 && (
                            <section className="panel">
                                <div className="panel-head">
                                    Results
                                    <span className="hint">
                                        <span className="num">{hunterResults.filter(r => r.emails.length > 0).length}</span> of{' '}
                                        <span className="num">{hunterResults.length}</span> sites gave an address ·{' '}
                                        <span className="num">{hunterResults.reduce((a, r) => a + r.emails.length, 0)}</span> found
                                    </span>
                                </div>
                                <div className="tbl-wrap !border-0 !rounded-none">
                                    <table className="w-full text-[13px]">
                                        <thead>
                                            <tr className="tbl-head">
                                                <th className="text-right px-4 py-2.5 w-12">#</th>
                                                <th className="text-left px-4 py-2.5">Website</th>
                                                <th className="text-left px-4 py-2.5">Addresses</th>
                                                <th className="text-left px-4 py-2.5">Result</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {hunterResults.map((r, i) => (
                                                <tr key={i} className="tbl-row">
                                                    <td className="px-4 py-2.5 num text-[11px] text-[var(--text-faint)] text-right align-top">{i + 1}</td>
                                                    <td className="px-4 py-2.5 align-top">
                                                        <a
                                                            href={r.website.startsWith('http') ? r.website : 'https://' + r.website}
                                                            target="_blank"
                                                            rel="noopener noreferrer"
                                                            className="text-[var(--text-dim)] hover:text-[var(--text)] transition-colors truncate block max-w-[320px]"
                                                        >
                                                            {r.website.replace(/^https?:\/\/(www\.)?/, '')}
                                                        </a>
                                                    </td>
                                                    <td className="px-4 py-2.5 align-top">
                                                        {r.emails.length > 0 ? (
                                                            <div className="flex flex-col gap-1">
                                                                {r.emails.map((email, ei) => (
                                                                    <span key={ei} className={cn("text-[12px] font-[family-name:var(--font-mono)]", ei === 0 ? "text-[var(--signal)]" : "text-[var(--text-faint)]")}>
                                                                        {email}
                                                                    </span>
                                                                ))}
                                                            </div>
                                                        ) : <span className="text-[var(--text-faint)]">—</span>}
                                                    </td>
                                                    <td className="px-4 py-2.5 align-top">
                                                        <span className={cn(
                                                            "mark",
                                                            r.status === 'SUCCESS' && "mark-ok",
                                                            r.status === 'NO_EMAILS' && "mark-idle",
                                                            r.status === 'ERROR' && "mark-bad",
                                                        )}>
                                                            {r.status === 'SUCCESS' ? 'Found' : r.status === 'NO_EMAILS' ? 'None on site' : 'Unreachable'}
                                                        </span>
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </section>
                        )}
                    </div>
                ) : activeTab === 'unbouncer' ? (
                    /* ── Verify email ── */
                    <div className="space-y-4 max-w-[1200px]">
                        <section className="panel">
                            <div className="panel-head">
                                Addresses
                                <span className="hint">
                                    {unbouncerDetected > 0
                                        ? <><span className="num">{unbouncerDetected.toLocaleString()}</span> ready</>
                                        : 'One per line'}
                                </span>
                            </div>
                            <div className="panel-body space-y-3">
                                <textarea
                                    value={unbouncerInput}
                                    onChange={e => setUnbouncerInput(e.target.value)}
                                    placeholder={"john@example.com\njane.doe@company.io\nhello@startup.com"}
                                    className="field w-full h-40 resize-y font-[family-name:var(--font-mono)] text-[12.5px] leading-relaxed"
                                    disabled={unbouncerProcessing}
                                />

                                <div className="flex items-center gap-2 flex-wrap">
                                    {!unbouncerProcessing ? (
                                        <button
                                            onClick={handleUnbouncerStart}
                                            disabled={unbouncerInput.trim().length === 0}
                                            className="btn btn-primary btn-lg"
                                        >
                                            <Zap className="w-3.5 h-3.5" />
                                            Check addresses
                                        </button>
                                    ) : (
                                        <button onClick={handleUnbouncerCancel} className="btn btn-danger btn-lg">
                                            <StopCircle className="w-3.5 h-3.5" />
                                            Stop
                                        </button>
                                    )}

                                    <label className="btn btn-outline cursor-pointer">
                                        <Upload className="w-3.5 h-3.5" />
                                        Load CSV
                                        <input type="file" accept=".csv" onChange={handleUnbouncerCSV} className="hidden" />
                                    </label>

                                    <span className="flex-1" />

                                    {unbouncerResults.length > 0 && (
                                        <>
                                            <button onClick={handleUnbouncerExport} className="btn btn-ghost">
                                                <Download className="w-3.5 h-3.5" />
                                                Export all
                                            </button>
                                            <button onClick={handleUnbouncerExportValid} className="btn btn-outline">
                                                <ShieldCheck className="w-3.5 h-3.5" />
                                                Export safe to send
                                            </button>
                                        </>
                                    )}
                                </div>

                                <VerificationProviderStatus
                                    provider={unbouncerResults.find(result => result.verificationProvider)?.verificationProvider}
                                    remainingCredits={unbouncerResults.length ? unbouncerResults[unbouncerResults.length - 1].remainingCredits : undefined}
                                />
                                {unbouncerProcessing && (
                                    <div>
                                        <div className="bar-track">
                                            <div
                                                className="bar-fill"
                                                style={{ width: `${unbouncerTotal > 0 ? (unbouncerProgress / unbouncerTotal) * 100 : 0}%` }}
                                            />
                                        </div>
                                        <p className="text-[11.5px] text-[var(--text-faint)] mt-2">
                                            <span className="num">{unbouncerProgress}</span> of <span className="num">{unbouncerTotal}</span> checked
                                        </p>
                                    </div>
                                )}
                            </div>
                        </section>

                        {unbouncerResults.length > 0 && (
                            <>
                                {/*
                                 * Four outcomes named for what they mean rather than for
                                 * the label the verifier stores. "Unknown" reads as a
                                 * problem with the lead; overwhelmingly it is a verdict
                                 * about the machine doing the asking, and the count of
                                 * host refusals is printed underneath for exactly that
                                 * reason.
                                 */}
                                <div className="figures">
                                    <div className="fig">
                                        <div className="fig-value fig-value-signal">{verifyCounts.VALID.toLocaleString()}</div>
                                        <p className="label-micro mt-2">Safe to send</p>
                                        <p className="fig-sub">Verified mailbox, with safety checks passed</p>
                                    </div>
                                    <div className="fig">
                                        <div className="fig-value fig-value-warn">{verifyCounts.RISKY.toLocaleString()}</div>
                                        <p className="label-micro mt-2">Risky</p>
                                        <p className="fig-sub">Catch-all, disposable, role or other unsafe address</p>
                                    </div>
                                    <div className="fig">
                                        <div className="fig-value">{verifyCounts.UNKNOWN.toLocaleString()}</div>
                                        <p className="label-micro mt-2">No answer</p>
                                        <p className="fig-sub">
                                            {hostRefusedCount > 0
                                                ? <><span className="num">{hostRefusedCount}</span> refused us, not the address</>
                                                : 'The server never gave a verdict'}
                                        </p>
                                    </div>
                                    <div className="fig">
                                        <div className="fig-value" style={{ color: 'var(--bad)' }}>{verifyCounts.INVALID.toLocaleString()}</div>
                                        <p className="label-micro mt-2">Invalid</p>
                                        <p className="fig-sub">Invalid address, domain or rejected mailbox</p>
                                    </div>
                                </div>

                                <section className="panel">
                                    <div className="panel-head">
                                        Detail
                                        {unbouncerProcessing && (
                                            <span className="hint flex items-center gap-1.5">
                                                <span className="dot-live" aria-hidden />
                                                Checking
                                            </span>
                                        )}
                                    </div>
                                    <div className="tbl-wrap !border-0 !rounded-none">
                                        <table className="w-full text-[13px]">
                                            <thead>
                                                <tr className="tbl-head">
                                                    <th className="text-right px-4 py-2.5 w-12">#</th>
                                                    <th className="text-left px-4 py-2.5">Address</th>
                                                    <th className="text-left px-4 py-2.5">Result</th>
                                                    <th className="text-left px-4 py-2.5 w-[120px]">Score</th>
                                                    <th className="text-left px-4 py-2.5">Why</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {unbouncerResults.map((r, i) => (
                                                    <tr key={i} className="tbl-row">
                                                        <td className="px-4 py-2.5 num text-[11px] text-[var(--text-faint)] text-right align-top">{i + 1}</td>
                                                        <td className="px-4 py-2.5 align-top">
                                                            <div className="flex items-center gap-1.5 flex-wrap">
                                                                <span className="text-[12.5px] font-[family-name:var(--font-mono)] text-[var(--text)]">{r.email}</span>
                                                                {r.provider && <span className="chip">{r.provider}</span>}
                                                                {r.method && <span className="chip">{r.method.replace(/_/g, ' ').toLowerCase()}</span>}
                                                            </div>
                                                        </td>
                                                        <td className="px-4 py-2.5 align-top">
                                                            <VerifyMark result={r} />
                                                        </td>
                                                        <td className="px-4 py-2.5 align-top">
                                                            <div className="flex items-center gap-2">
                                                                <div className="bar-track w-14 !h-1.5">
                                                                    <div
                                                                        className={cn(
                                                                            "bar-fill",
                                                                            r.score >= 75 ? "" : r.score >= 45 ? "bar-fill-warn" : r.score >= 25 ? "bar-fill-dim" : "bar-fill-bad",
                                                                        )}
                                                                        style={{ width: `${r.score}%` }}
                                                                    />
                                                                </div>
                                                                <span className="num text-[12px] text-[var(--text-dim)]">{r.score}</span>
                                                            </div>
                                                        </td>
                                                        <td className="px-4 py-2.5 align-top">
                                                            <span className="text-[12px] text-[var(--text-dim)] line-clamp-2 max-w-[380px]" title={r.reason}>
                                                                {r.reason}
                                                            </span>
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                    <div className="panel-note">
                                        <span>Only <strong className="text-[var(--signal)]">Safe to send</strong> results are included in the safe export.</span>
                                        <span>&ldquo;No answer&rdquo; means verification was inconclusive. Check failed results can be retried.</span>
                                    </div>
                                </section>
                            </>
                        )}
                    </div>
                ) : activeTab === 'cleaner' ? (
                    <UrlCleaner />
                ) : activeTab === 'finder' ? (
                    <FinderEngine onPushToEngine={(urls) => {
                        setCsvUrls(urls);
                        setActiveTab('engine');
                        setTimeout(() => {
                            handleStartEngine(0, [], urls);
                        }, 500);
                    }} />
                ) : activeTab === 'crm' ? (
                    <CrmDatabase onOpenCaseStudy={() => { setCaseStudyEntryView('CRM_OUTREACH'); setActiveTab('case-study'); }} onPushToEngine={(urls) => {
                        setCsvUrls(urls);
                        setActiveTab('engine');
                        // Start processing automatically with the new urls
                        setTimeout(() => {
                            handleStartEngine(0, [], urls);
                        }, 500);
                    }} />
                ) : activeTab === 'case-study' ? (
                    <CaseStudyHunter initialView={caseStudyEntryView} />
                ) : activeTab === 'discovery' ? (
                    <DiscoveryCallsWorkspace onOnboarding={(id) => { setOnboardingProjectId(id); setActiveTab('onboarding'); }} />
                ) : activeTab === 'funnel' ? (
                    null
                ) : activeTab === 'copy-studio' ? (
                    null
                ) : activeTab === 'content-create' ? (
                    null
                ) : <BusinessWorkspace view={activeTab as BusinessView} onNavigate={setActiveTab} initialProjectId={onboardingProjectId} />}
                    {(copyStudioOpened || activeTab === 'copy-studio') && <div hidden={activeTab !== 'copy-studio'}><CopyStudio /></div>}
                    {(contentCreateOpened || activeTab === 'content-create') && <div hidden={activeTab !== 'content-create'}><ContentCreate /></div>}
                    <div hidden={activeTab !== 'funnel'}>
                        <FunnelAnalyzer />
                    </div>

                    </main>
                </div>
            </div>

            {/* Saved Runs History Modal */}
            {showHistory && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 animate-in fade-in duration-150">
                    <div className="panel w-full max-w-xl max-h-[80vh] overflow-hidden flex flex-col shadow-[0_24px_60px_rgba(0,0,0,0.7)]">
                        <div className="panel-head flex-none">
                            Saved runs
                            <button onClick={() => setShowHistory(false)} className="btn btn-ghost !p-1 ml-auto" aria-label="Close">
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        <div className="flex-1 overflow-y-auto">
                            {historyLoading ? (
                                <div className="flex items-center justify-center py-16">
                                    <Loader2 className="w-5 h-5 text-[var(--text-faint)] animate-spin" />
                                </div>
                            ) : savedRuns.length > 0 ? (
                                savedRuns.map((run) => (
                                    <div key={run.filename} className="tbl-row px-4 py-3 flex items-center justify-between gap-3">
                                        <div className="flex-1 min-w-0">
                                            <p className="text-[13px] text-[var(--text)] truncate">{run.filename}</p>
                                            <div className="flex items-center gap-3 mt-1 flex-wrap">
                                                <span className="text-[11px] text-[var(--text-faint)] flex items-center gap-1">
                                                    <Clock className="w-3 h-3" />
                                                    {new Date(run.savedAt).toLocaleString()}
                                                </span>
                                                <span className="text-[11px] text-[var(--signal)]">
                                                    <span className="num">{run.qualifiedCount}</span> qualified
                                                </span>
                                                <span className="text-[11px] text-[var(--text-faint)]">
                                                    <span className="num">{run.emailsFound}</span> addresses
                                                </span>
                                                <span className="text-[11px] text-[var(--text-faint)]">
                                                    <span className="num">{run.processedCount}</span>/<span className="num">{run.totalCount}</span> done
                                                </span>
                                            </div>
                                        </div>
                                        <div className="flex gap-1 flex-none">
                                            <button onClick={() => handleLoadRun(run.filename)} className="btn btn-outline !px-2" title="Load this run">
                                                <FolderOpen className="w-3.5 h-3.5" />
                                            </button>
                                            <button onClick={() => handleDeleteRun(run.filename)} className="btn btn-ghost !px-2 !text-[var(--bad)]" title="Delete this run">
                                                <Trash2 className="w-3.5 h-3.5" />
                                            </button>
                                        </div>
                                    </div>
                                ))
                            ) : (
                                <div className="py-16 text-center">
                                    <p className="text-[13px] text-[var(--text-dim)]">No saved runs yet</p>
                                    <p className="text-[12px] text-[var(--text-faint)] mt-1">Finished runs are saved here automatically</p>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Confirm Dialog */}
            <ConfirmDialog
                open={confirmDialog.open}
                message={confirmDialog.message}
                onConfirm={confirmDialog.onConfirm}
                onCancel={() => setConfirmDialog({ open: false, message: '', onConfirm: () => { } })}
            />

            {/* Toast Notifications */}
            <ToastContainer toasts={toasts} onDismiss={dismissToast} />
        </>
    );
}
