"use client";

import React, { useState, useEffect, useCallback } from "react";
import {
    Activity,
    Upload,
    FileText,
    Search,
    Mail,
    CheckCircle,
    AlertCircle,
    Download,
    BarChart3,
    Signal,
    Globe,
    ExternalLink,
    XCircle,
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
    ShieldX,
    ShieldAlert,
    ShieldQuestion,
    Zap,
    Server,
    AtSign,
    Ban,
    UserX,
    Radar,
} from "lucide-react";
import { cn } from "@/lib/utils";
import CrmDatabase from "./CrmDatabase";

import {
    saveProgress,
    loadProgress,
    listSavedRuns,
    loadSavedRun,
    deleteSavedRun,
    exportResultsCSV,
    type Lead,
    type SavedRun,
} from "@/app/actions/scraper-actions";
import { scrapeWebsiteEmails, type WebsiteScrapeResult } from "@/app/actions/scraper-actions";
import { verifyEmail, verifyEmailBatchFast, type VerificationResult } from "@/app/actions/email-verifier-actions";

// ── Worker API helper: submit job & poll until done ──
async function processLeadViaWorker(linkedinUrl: string): Promise<Lead> {
    const res = await fetch('/api/process-lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ linkedinUrl }),
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

import Papa from 'papaparse';

// ── Toast Notification System ──
type Toast = { id: number; message: string; type: 'success' | 'error' | 'info'; };
let toastId = 0;

function ToastContainer({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
    return (
        <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 max-w-sm">
            {toasts.map(t => (
                <div
                    key={t.id}
                    className={cn(
                        "flex items-center gap-3 px-4 py-3 rounded-xl border shadow-2xl backdrop-blur-sm animate-in slide-in-from-right fade-in duration-300",
                        t.type === 'success' && "bg-accent/10 border-accent/30 text-accent",
                        t.type === 'error' && "bg-red-500/10 border-red-500/30 text-red-400",
                        t.type === 'info' && "bg-blue-500/10 border-blue-500/30 text-blue-400",
                    )}
                >
                    {t.type === 'success' && <CheckCircle className="w-4 h-4 flex-shrink-0" />}
                    {t.type === 'error' && <XCircle className="w-4 h-4 flex-shrink-0" />}
                    {t.type === 'info' && <AlertCircle className="w-4 h-4 flex-shrink-0" />}
                    <span className="text-sm flex-1">{t.message}</span>
                    <button onClick={() => onDismiss(t.id)} className="text-zinc-500 hover:text-white flex-shrink-0">
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-[#111] border border-zinc-800 rounded-2xl p-6 max-w-sm mx-4 shadow-2xl animate-in zoom-in-95 duration-200">
                <p className="text-white mb-6">{message}</p>
                <div className="flex gap-3 justify-end">
                    <button onClick={onCancel} className="px-4 py-2 rounded-xl bg-zinc-800 text-zinc-400 hover:text-white hover:bg-zinc-700 transition-all">
                        Cancel
                    </button>
                    <button onClick={onConfirm} className="px-4 py-2 rounded-xl bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30 transition-all">
                        Delete
                    </button>
                </div>
            </div>
        </div>
    );
}

export default function Dashboard() {
    const [activeTab, setActiveTab] = useState<'engine' | 'cleaner' | 'hunter' | 'unbouncer' | 'finder' | 'crm'>('engine');
    const [progress, setProgress] = useState(0);
    const [isProcessing, setIsProcessing] = useState(false);
    const [rowLimit, setRowLimit] = useState(100);
    const [csvUrls, setCsvUrls] = useState<string[]>([]);
    const [leads, setLeads] = useState<Lead[]>([]);
    const [logs, setLogs] = useState<{ msg: string, time: string, type: 'info' | 'success' }[]>([]);
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
    const [unbouncerResults, setUnbouncerResults] = useState<VerificationResult[]>([]);
    const [unbouncerProcessing, setUnbouncerProcessing] = useState(false);
    const [unbouncerProgress, setUnbouncerProgress] = useState(0);
    const [unbouncerTotal, setUnbouncerTotal] = useState(0);
    const unbouncerCancelledRef = React.useRef(false);

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
            const savedLeads = sessionStorage.getItem('revlane_leads');
            const savedUrls = sessionStorage.getItem('revlane_urls');
            const savedProgress = sessionStorage.getItem('revlane_progress');
            if (savedLeads) setLeads(JSON.parse(savedLeads));
            if (savedUrls) setCsvUrls(JSON.parse(savedUrls));
            if (savedProgress) setProgress(parseInt(savedProgress));

            // Restore unbouncer results
            const savedUnbouncer = sessionStorage.getItem('revlane_unbouncer_results');
            const savedUnbouncerInput = sessionStorage.getItem('revlane_unbouncer_input');
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
            if (leads.length > 0) sessionStorage.setItem('revlane_leads', JSON.stringify(leads));
            if (csvUrls.length > 0) sessionStorage.setItem('revlane_urls', JSON.stringify(csvUrls));
            sessionStorage.setItem('revlane_progress', String(progress));
        } catch { /* ignore */ }
    }, [leads, csvUrls, progress]);

    // ── Persist unbouncer results to sessionStorage ──
    useEffect(() => {
        try {
            if (unbouncerResults.length > 0) {
                sessionStorage.setItem('revlane_unbouncer_results', JSON.stringify(unbouncerResults));
            }
            if (unbouncerInput.length > 0) {
                sessionStorage.setItem('revlane_unbouncer_input', unbouncerInput);
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

    const handleStartEngine = async (resumeFrom = 0, existingLeads: Lead[] = []) => {
        if (csvUrls.length === 0) {
            addToast('No URLs loaded. Upload a CSV first.', 'error');
            return;
        }

        // Check worker is alive
        try {
            const healthRes = await fetch('/api/process-lead');
            const health = await healthRes.json();
            if (health.worker?.stale || health.worker === 'unknown') {
                addToast('Worker is not running! Start it with: node worker.cjs', 'error');
                return;
            }
        } catch {
            addToast('Cannot reach API. Is the dev server running?', 'error');
            return;
        }

        isCancelledRef.current = false;
        setIsProcessing(true);
        const limit = Math.min(csvUrls.length, rowLimit);
        setProgress(resumeFrom > 0 ? Math.round((resumeFrom / limit) * 100) : 0);
        if (resumeFrom === 0) setLeads([]);
        else setLeads(existingLeads);

        const urlsToProcess = csvUrls.slice(0, limit);
        let processedCount = resumeFrom;
        const allLeads: Lead[] = [...existingLeads];

        setLogs(prev => [...prev, {
            msg: resumeFrom > 0
                ? `Resuming from lead ${resumeFrom + 1}/${limit}...`
                : `Engine Ignition: ${limit} leads via Worker pipeline...`,
            time: new Date().toLocaleTimeString(), type: 'info'
        }]);
        setBatchInfo(`Processing ${limit} leads via Worker`);

        for (let i = resumeFrom; i < limit; i++) {
            const url = urlsToProcess[i];
            setLogs(prev => [...prev, { msg: `[${processedCount + 1}/${limit}] Queuing ${url}...`, time: new Date().toLocaleTimeString(), type: 'info' }]);

            try {
                const workerPromise = processLeadViaWorker(url);
                const cancelPromise = new Promise((_, reject) => {
                    const int = setInterval(() => {
                        if (isCancelledRef.current) {
                            clearInterval(int);
                            reject(new Error("CANCELLED"));
                        }
                    }, 500);
                });
                const result = await Promise.race([workerPromise, cancelPromise]) as Lead;
                allLeads.push(result);
                setLeads([...allLeads]);

                const newLogs = (result.logs || []).map(logMsg => ({
                    msg: logMsg,
                    time: new Date().toLocaleTimeString(),
                    type: result.status === 'QUALIFIED' ? 'success' as const : 'info' as const
                }));
                setLogs(prev => [...prev, ...newLogs]);
            } catch (error: any) {
                if (error.message === "CANCELLED") {
                    // Loop will break below at the isCancelledRef check
                } else {
                    setLogs(prev => [...prev, { msg: `Error processing ${url}: ${error}`, time: new Date().toLocaleTimeString(), type: 'info' }]);
                    allLeads.push({ url, status: 'ERROR', websites: [], emails: [], logs: [`Error: ${error}`] });
                    setLeads([...allLeads]);
                }
            }

            processedCount++;
            setProgress(Math.round((processedCount / limit) * 100));

            if (processedCount % SAVE_INTERVAL === 0) {
                await saveProgress(allLeads, processedCount, limit);
                setLogs(prev => [...prev, { msg: `💾 Progress saved (${processedCount}/${limit})`, time: new Date().toLocaleTimeString(), type: 'info' }]);
            }

            if (isCancelledRef.current) {
                await saveProgress(allLeads, processedCount, limit);
                setLogs(prev => [...prev, { msg: `🛑 Processing cancelled at ${processedCount}/${limit}. Progress saved.`, time: new Date().toLocaleTimeString(), type: 'info' }]);
                addToast(`Cancelled. ${processedCount} leads processed so far.`, 'info');
                setBatchInfo('');
                setIsProcessing(false);
                return;
            }

            while (isPausedRef.current && !isCancelledRef.current) {
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }

        await saveProgress(allLeads, processedCount, limit);
        setBatchInfo('');
        setIsProcessing(false);
        setLogs(prev => [...prev, { msg: `✅ Mission Complete. ${processedCount} leads processed.`, time: new Date().toLocaleTimeString(), type: 'success' }]);
        addToast(`Processing complete! ${processedCount} leads processed.`, 'success');
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

    const handleCancel = () => {
        isCancelledRef.current = true;
        // Unpause so the pause-wait loop exits and sees the cancel flag
        isPausedRef.current = false;
        setIsPaused(false);
        setLogs(prev => [...prev, {
            msg: '🛑 Cancelling... will stop after the current lead finishes.',
            time: new Date().toLocaleTimeString(), type: 'info'
        }]);
        addToast('Cancelling after current lead...', 'info');
    };

    const handleRetryFailed = async () => {
        let failedLeads = leads.filter(l => l.status === 'ACTIVITY_FAILED');

        // If no failed leads in current session, pull from saved progress
        if (failedLeads.length === 0) {
            const saved = await loadProgress();
            if (saved && saved.leads.length > 0) {
                const savedFailed = saved.leads.filter(l => l.status === 'ACTIVITY_FAILED');
                if (savedFailed.length > 0) {
                    failedLeads = savedFailed;
                    // Load ALL saved leads into the UI so results table shows them
                    setLeads(saved.leads);
                    addToast(`Loaded ${savedFailed.length} failed lead(s) from saved progress`, 'info');
                    // Give React a tick to render the loaded leads
                    await new Promise(r => setTimeout(r, 100));
                }
            }
        }

        if (failedLeads.length === 0) {
            addToast('No failed leads to retry.', 'info');
            return;
        }

        setIsProcessing(true);
        setProgress(0);
        setLogs(prev => [...prev, {
            msg: `🔄 Retrying ${failedLeads.length} failed lead(s)...`,
            time: new Date().toLocaleTimeString(), type: 'info'
        }]);

        let retried = 0;

        for (const failedLead of failedLeads) {
            // Check cancel flag
            if (isCancelledRef.current) {
                setLogs(prev => [...prev, { msg: `🛑 Retry cancelled at ${retried}/${failedLeads.length}.`, time: new Date().toLocaleTimeString(), type: 'info' }]);
                addToast(`Retry cancelled. ${retried} lead(s) re-processed.`, 'info');
                break;
            }

            retried++;
            setLogs(prev => [...prev, {
                msg: `[Retry ${retried}/${failedLeads.length}] Re-processing ${failedLead.url}...`,
                time: new Date().toLocaleTimeString(), type: 'info'
            }]);

            try {
                const result = await processLeadViaWorker(failedLead.url);

                // Use functional update so we always work with latest state
                setLeads(prev => {
                    const updated = [...prev];
                    const idx = updated.findIndex(l => l.url === failedLead.url);
                    if (idx !== -1) updated[idx] = result;
                    else updated.push(result);
                    return updated;
                });

                const newLogs = result.logs.map(logMsg => ({
                    msg: logMsg,
                    time: new Date().toLocaleTimeString(),
                    type: result.status === 'QUALIFIED' ? 'success' as const : 'info' as const
                }));
                setLogs(prev => [...prev, ...newLogs]);
            } catch (error) {
                setLogs(prev => [...prev, {
                    msg: `Retry failed for ${failedLead.url}: ${error}`,
                    time: new Date().toLocaleTimeString(), type: 'info'
                }]);
            }

            setProgress(Math.round((retried / failedLeads.length) * 100));

            // Rate limiting between retries
            if (retried < failedLeads.length) {
                await new Promise(resolve => setTimeout(resolve, 3000 + Math.random() * 2000));
            }
        }

        // Get final leads state for saving
        setLeads(prev => {
            saveProgress(prev, prev.length, prev.length);
            return prev;
        });
        setIsProcessing(false);
        setProgress(100);
        addToast(`Retry complete. ${retried} lead(s) re-processed.`, 'success');
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
        a.setAttribute('download', `Revlane_Leads_${new Date().toISOString().slice(0, 10)}.csv`);
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
    const activityFailedCount = currentLeads.filter(l => l.status === 'ACTIVITY_FAILED').length;
    const emailsFound = currentLeads.reduce((acc, curr) => acc + (curr.emails?.length || 0), 0);
    const efficiency = currentLeads.length > 0 ? Math.round((qualifiedCount / currentLeads.length) * 100) : 0;

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

        // Deduplicate emails to avoid wasting SMTP connections
        const emails = [...new Set(rawEmails)];
        const dupeCount = rawEmails.length - emails.length;

        if (emails.length === 0) {
            addToast('Paste some emails first (one per line) or upload a CSV.', 'error');
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
        const BATCH_SIZE = 100; // Process 100 emails per server call

        for (let i = 0; i < emails.length; i += BATCH_SIZE) {
            if (unbouncerCancelledRef.current) {
                addToast(`Cancelled at ${allResults.length}/${emails.length}. Results preserved.`, 'info');
                break;
            }

            const batch = emails.slice(i, i + BATCH_SIZE);
            const batchNum = Math.floor(i / BATCH_SIZE) + 1;
            const totalBatches = Math.ceil(emails.length / BATCH_SIZE);

            try {
                addToast(`Processing batch ${batchNum}/${totalBatches} (${batch.length} emails)...`, 'info');
                
                const batchPromise = verifyEmailBatchFast(batch);
                const cancelPromise = new Promise((_, reject) => {
                    const int = setInterval(() => {
                        if (unbouncerCancelledRef.current) {
                            clearInterval(int);
                            reject(new Error("CANCELLED"));
                        }
                    }, 500);
                });
                
                const batchResults = await Promise.race([batchPromise, cancelPromise]) as VerificationResult[];
                allResults.push(...batchResults);
            } catch (err: any) {
                if (err.message === "CANCELLED") {
                    break;
                }
                // If the batch call fails, fall back to individual verification
                console.error(`Batch ${batchNum} failed, falling back to individual:`, err);
                for (const email of batch) {
                    if (unbouncerCancelledRef.current) break;
                    try {
                        const result = await verifyEmail(email);
                        allResults.push(result);
                    } catch {
                        allResults.push({
                            email,
                            status: 'UNKNOWN',
                            score: 0,
                            checks: { syntax: false, mxRecord: false, disposable: false, roleAccount: false, freeProvider: false, smtpValid: null, catchAll: null },
                            reason: 'Verification failed',
                        });
                    }
                }
            }

            // Update UI once per batch (not per email)
            setUnbouncerResults([...allResults]);
            setUnbouncerProgress(Math.min(allResults.length, emails.length));
        }

        setUnbouncerProcessing(false);
        const validCount = allResults.filter(r => r.status === 'VALID').length;
        addToast(`Done! ${validCount} valid out of ${allResults.length} emails verified.`, 'success');
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

                let emails: string[] = [];
                if (emailCol) {
                    emails = (results.data as any[])
                        .map((row: any) => String(row[emailCol] || '').trim().toLowerCase())
                        .filter((val: string) => val.length > 3 && val.includes('@'));
                } else {
                    addToast('No "email" column found in CSV. Expected: email, emails, e-mail, email_address, or mail.', 'error');
                    return;
                }

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
            'Email,Status,Score,Syntax,MX Record,Disposable,Role Account,Free Provider,SMTP Valid,Catch-All,Provider,Reason',
            ...unbouncerResults.map(r => [
                csvCell(r.email),
                csvCell(r.status),
                r.score,
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
        const rows = ['Email,Score,Provider,Reason', ...valid.map(r => [
            csvCell(r.email), r.score, csvCell(r.provider || ''), csvCell(r.reason),
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
            <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-4 p-4 max-w-7xl mx-auto">
                {/* Header Stat Card */}
                <div className="col-span-1 md:col-span-3 lg:col-span-4 bg-[#111] border border-zinc-800 rounded-2xl p-6 flex flex-col md:flex-row items-center justify-between gap-4">
                    <div>
                        <h1 className="text-3xl font-bold bg-gradient-to-r from-white to-zinc-500 bg-clip-text text-transparent">
                            Revlane Signal Engine
                        </h1>
                        <p className="text-zinc-500 mt-1">Real-time Lead Qualification & Signal Discovery</p>
                    </div>
                    <div className="flex gap-3 flex-wrap items-center">
                        <div className="bg-black/50 border border-zinc-800 p-1 rounded-xl flex">
                            <button
                                onClick={() => setActiveTab('engine')}
                                className={cn(
                                    "px-4 py-1.5 rounded-lg text-sm font-medium transition-all",
                                    activeTab === 'engine' ? "bg-white text-black shadow-lg" : "text-zinc-500 hover:text-white"
                                )}
                            >
                                Signal Engine
                            </button>
                            <button
                                onClick={() => setActiveTab('hunter')}
                                className={cn(
                                    "px-4 py-1.5 rounded-lg text-sm font-medium transition-all",
                                    activeTab === 'hunter' ? "bg-white text-black shadow-lg" : "text-zinc-500 hover:text-white"
                                )}
                            >
                                Email Hunter
                            </button>
                            <button
                                onClick={() => setActiveTab('finder')}
                                className={cn(
                                    "px-4 py-1.5 rounded-lg text-sm font-medium transition-all",
                                    activeTab === 'finder' ? "bg-blue-500 text-white shadow-lg shadow-blue-500/20" : "text-zinc-500 hover:text-white"
                                )}
                            >
                                <span className="flex items-center gap-1.5"><Radar className="w-3.5 h-3.5" />Finder</span>
                            </button>
                            <button
                                onClick={() => setActiveTab('unbouncer')}
                                className={cn(
                                    "px-4 py-1.5 rounded-lg text-sm font-medium transition-all",
                                    activeTab === 'unbouncer' ? "bg-accent text-black shadow-lg shadow-accent/20" : "text-zinc-500 hover:text-white"
                                )}
                            >
                                <span className="flex items-center gap-1.5"><ShieldCheck className="w-3.5 h-3.5" />Unbouncer</span>
                            </button>
                            <button
                                onClick={() => setActiveTab('cleaner')}
                                className={cn(
                                    "px-4 py-1.5 rounded-lg text-sm font-medium transition-all",
                                    activeTab === 'cleaner' ? "bg-white text-black shadow-lg" : "text-zinc-500 hover:text-white"
                                )}
                            >
                                URL Cleaner
                            </button>
                            <button
                                onClick={() => setActiveTab('crm')}
                                className={cn(
                                    "px-4 py-1.5 rounded-lg text-sm font-medium transition-all",
                                    activeTab === 'crm' ? "bg-accent text-black shadow-lg shadow-accent/20" : "text-zinc-500 hover:text-white"
                                )}
                            >
                                <span className="flex items-center gap-1.5"><Database className="w-3.5 h-3.5" />CRM Sync</span>
                            </button>
                        </div>
                        {activeTab === 'engine' && (
                            <div className="flex gap-2">
                                <button
                                    onClick={handleOpenHistory}
                                    className="bg-white/5 border border-zinc-800 text-zinc-400 px-3 py-2 rounded-xl hover:bg-zinc-800 hover:text-white transition-colors flex items-center gap-1.5"
                                    title="View saved runs"
                                >
                                    <History className="w-4 h-4" />
                                </button>
                                <button
                                    onClick={handleExport}
                                    disabled={leads.length === 0}
                                    className="bg-white/5 border border-zinc-800 text-white px-4 py-2 rounded-xl font-medium hover:bg-zinc-800 disabled:opacity-50 transition-colors flex items-center gap-2"
                                >
                                    <Download className="w-4 h-4" />
                                    CSV
                                </button>
                                {sheetsConfigured && (
                                    <button
                                        onClick={handleSheetsExport}
                                        disabled={leads.length === 0 || sheetsExporting}
                                        className="bg-accent/10 border border-accent/30 text-accent px-4 py-2 rounded-xl font-medium hover:bg-accent/20 disabled:opacity-50 transition-colors flex items-center gap-2"
                                    >
                                        {sheetsExporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sheet className="w-4 h-4" />}
                                        Sheets
                                    </button>
                                )}
                            </div>
                        )}
                    </div>
                </div>

                {activeTab === 'engine' ? (
                    <>
                        {/* Main Control Bento */}
                        <div className="col-span-1 md:col-span-2 bg-[#111] border border-zinc-800 rounded-3xl p-8 flex flex-col justify-between min-h-[400px]">
                            <div className="space-y-6">
                                <div className="flex items-center gap-3">
                                    <div className="bg-blue-500/10 p-3 rounded-2xl text-blue-500">
                                        <Upload className="w-6 h-6" />
                                    </div>
                                    <div>
                                        <h2 className="text-xl font-semibold">Source Acquisition</h2>
                                        <p className="text-zinc-500 text-sm">Upload LinkedIn URL list to begin batch processing</p>
                                    </div>
                                </div>

                                <div
                                    onDragOver={handleDragOver}
                                    onDragLeave={handleDragLeave}
                                    onDrop={handleDrop}
                                    className={cn(
                                        "group relative border-2 border-dashed rounded-2xl p-10 flex flex-col items-center justify-center cursor-pointer transition-all duration-300",
                                        isDragging ? "border-white bg-white/5" : "border-zinc-800 bg-black/30",
                                        csvUrls.length > 0 && !isDragging ? "border-accent/50" : ""
                                    )}
                                >
                                    <input
                                        type="file"
                                        accept=".csv"
                                        onChange={handleFileChange}
                                        className="absolute inset-0 opacity-0 cursor-pointer z-20"
                                    />
                                    <div className={cn(
                                        "mb-4 p-4 rounded-full transition-transform",
                                        isDragging ? "bg-white text-black scale-110" : "bg-zinc-800 text-zinc-400 group-hover:scale-110"
                                    )}>
                                        <Upload className="w-8 h-8" />
                                    </div>
                                    <p className={cn("font-medium", isDragging ? "text-white" : "text-zinc-400")}>
                                        {csvUrls.length > 0 ? `${csvUrls.length} leads loaded` : "Click to upload or drag and drop"}
                                    </p>
                                    <p className="text-zinc-600 text-sm mt-1">CSV files only • Up to 1000 rows</p>
                                </div>

                                <div className="flex items-center gap-4">
                                    <div className="flex-1">
                                        <label className="text-xs text-zinc-500 uppercase tracking-widest block mb-2 font-bold">Row Limit</label>
                                        <input
                                            type="number"
                                            value={rowLimit}
                                            onChange={(e) => setRowLimit(parseInt(e.target.value))}
                                            className="w-full bg-black/50 border border-zinc-800 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-1 focus:ring-white/20"
                                        />
                                    </div>
                                    {!isProcessing ? (
                                        <button
                                            onClick={() => handleStartEngine()}
                                            disabled={csvUrls.length === 0}
                                            className="flex-1 bg-white text-black h-[50px] mt-6 rounded-xl font-bold hover:bg-zinc-200 disabled:opacity-50 transition-all flex items-center justify-center gap-2"
                                        >
                                            Start Engine
                                        </button>
                                    ) : (
                                        <>
                                            <button
                                                onClick={handlePause}
                                                className={cn(
                                                    "flex-1 h-[50px] mt-6 rounded-xl font-bold transition-all flex items-center justify-center gap-2 border",
                                                    isPaused
                                                        ? "bg-accent/10 text-accent border-accent/30 hover:bg-accent/20"
                                                        : "bg-amber-500/10 text-amber-400 border-amber-500/30 hover:bg-amber-500/20"
                                                )}
                                            >
                                                {isPaused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
                                                {isPaused ? 'Resume' : 'Pause'}
                                            </button>
                                            <button
                                                onClick={handleCancel}
                                                className="h-[50px] mt-6 px-4 rounded-xl font-bold transition-all flex items-center justify-center gap-2 border bg-red-500/10 text-red-400 border-red-500/30 hover:bg-red-500/20"
                                                title="Cancel processing"
                                            >
                                                <StopCircle className="w-4 h-4" />
                                                Cancel
                                            </button>
                                        </>
                                    )}
                                    <button
                                        onClick={handleResumeFromSave}
                                        disabled={isProcessing || csvUrls.length === 0}
                                        className="flex-1 bg-zinc-800 text-white h-[50px] mt-6 rounded-xl font-bold hover:bg-zinc-700 disabled:opacity-50 transition-all flex items-center justify-center gap-2 border border-zinc-700"
                                    >
                                        {isProcessing ? "..." : "Resume"}
                                    </button>
                                    <button
                                        onClick={handleRetryFailed}
                                        disabled={isProcessing}
                                        className="flex-1 bg-orange-500/10 text-orange-400 h-[50px] mt-6 rounded-xl font-bold hover:bg-orange-500/20 disabled:opacity-50 transition-all flex items-center justify-center gap-2 border border-orange-500/30"
                                    >
                                        <RotateCcw className="w-4 h-4" />
                                        Retry Failed ({activityFailedCount})
                                    </button>
                                    <button
                                        onClick={handleClearQueue}
                                        disabled={isProcessing}
                                        className="flex-1 bg-red-500/10 text-red-400 h-[50px] mt-6 rounded-xl font-bold hover:bg-red-500/20 disabled:opacity-50 transition-all flex items-center justify-center gap-2 border border-red-500/30"
                                        title="Empty the processing queue"
                                    >
                                        <Trash2 className="w-4 h-4" />
                                        Clear Queue
                                    </button>
                                </div>
                            </div>
                        </div>

                        {/* Progress Bento */}
                        <div className="col-span-1 bg-[#111] border border-zinc-800 rounded-3xl p-8 flex flex-col justify-between overflow-hidden relative">
                            <div className="relative z-10">
                                <h3 className="text-zinc-500 text-xs uppercase tracking-[0.2em] font-bold mb-6">Processing Signal</h3>
                                <div className="space-y-8">
                                    <div className="flex items-center justify-between">
                                        <span className={cn("flex items-center gap-2", isProcessing && progress < 50 ? "text-accent" : "text-zinc-600")}>
                                            <div className={cn("w-2 h-2 rounded-full", isProcessing && progress < 50 ? "bg-accent animate-pulse" : "bg-zinc-800")}></div>
                                            Phase 1: Activity Gate
                                        </span>
                                        <span className={cn("font-mono transition-colors", isProcessing && progress < 50 ? "text-accent" : "text-zinc-600")}>
                                            {isProcessing && progress < 50 ? "Running" : "Idle"}
                                        </span>
                                    </div>
                                    <div className="flex items-center justify-between">
                                        <span className={cn("flex items-center gap-2", isProcessing && progress >= 50 ? "text-blue-500" : "text-zinc-600")}>
                                            <div className={cn("w-2 h-2 rounded-full", isProcessing && progress >= 50 ? "bg-blue-500 animate-pulse" : "bg-zinc-800")}></div>
                                            Phase 2: Smart Discovery
                                        </span>
                                        <span className={cn("font-mono transition-colors", isProcessing && progress >= 50 ? "text-blue-500" : "text-zinc-600")}>
                                            {isProcessing && progress >= 50 ? "Running" : "Idle"}
                                        </span>
                                    </div>

                                    <div className="pt-10">
                                        <div className="flex justify-between text-sm mb-3">
                                            <span className="text-zinc-400">Completion</span>
                                            <span className="text-white font-mono">{progress}%</span>
                                        </div>
                                        <div className="h-2 w-full bg-black/50 rounded-full overflow-hidden">
                                            <div
                                                className="h-full bg-white transition-all duration-500"
                                                style={{ width: `${progress}%` }}
                                            ></div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                            <BarChart3 className="absolute -bottom-10 -right-10 w-48 h-48 text-white/[0.02] -rotate-12" />
                        </div>

                        {/* Live Feed Bento */}
                        <div className="col-span-1 bg-[#111] border border-zinc-800 rounded-3xl p-6 flex flex-col max-h-[400px]">
                            <div className="flex items-center justify-between mb-4">
                                <div className="flex items-center gap-2">
                                    <Signal className={cn("w-4 h-4", isProcessing ? "text-accent animate-pulse" : "text-zinc-500")} />
                                    <h3 className="text-sm font-semibold uppercase tracking-wider">Live Signal Feed</h3>
                                </div>
                                {isProcessing && <span className="text-[10px] bg-accent/10 text-accent px-2 py-0.5 rounded-full border border-accent/20 animate-pulse">LIVE</span>}
                            </div>

                            <div className="flex-1 overflow-y-auto space-y-3 pr-2 custom-scrollbar">
                                {logs.map((log, i) => (
                                    <div key={i} className="bg-black/50 border border-zinc-800/50 p-3 rounded-xl flex items-start gap-3 animate-in fade-in slide-in-from-bottom-2 duration-500">
                                        <div className="mt-1">
                                            {log.type === 'success' ? <CheckCircle className="w-4 h-4 text-accent" /> : <Search className="w-4 h-4 text-blue-500" />}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-[11px] text-zinc-400 leading-tight">{log.msg}</p>
                                            <p className="text-[9px] text-zinc-600 mt-1 font-mono uppercase">{log.time}</p>
                                        </div>
                                    </div>
                                ))}
                                {logs.length === 0 && <p className="text-zinc-600 text-[11px] text-center mt-10 italic">Awaiting signal transmission...</p>}
                            </div>
                        </div>

                        {/* Statistics Row */}
                        <div className="col-span-1 bg-[#111] border border-zinc-800 rounded-2xl p-6">
                            <p className="text-zinc-500 text-xs uppercase font-bold tracking-widest mb-1">Total Leads</p>
                            <p className="text-2xl font-bold">{csvUrls.length || 0}</p>
                            <div className="mt-4 flex items-center gap-2 text-[10px] text-zinc-600">
                                <FileText className="w-3 h-3" />
                                <span>Active Dataset</span>
                            </div>
                        </div>
                        <div className="col-span-1 bg-[#111] border border-zinc-800 rounded-2xl p-6">
                            <p className="text-zinc-500 text-xs uppercase font-bold tracking-widest mb-1">Gate Passed</p>
                            <p className="text-2xl font-bold text-accent">{leads.filter(l => l.status !== 'REJECTED').length || 0}</p>
                            <div className="mt-4 flex items-center gap-2 text-[10px] text-zinc-600">
                                <CheckCircle className="w-3 h-3" />
                                <span>Post Filtered (60d)</span>
                            </div>
                        </div>
                        <div className="col-span-1 bg-[#111] border border-zinc-800 rounded-2xl p-6">
                            <p className="text-zinc-500 text-xs uppercase font-bold tracking-widest mb-1">Emails Found</p>
                            <p className="text-2xl font-bold text-blue-500">{emailsFound || 0}</p>
                            <div className="mt-4 flex items-center gap-2 text-[10px] text-zinc-600">
                                <Mail className="w-3 h-3" />
                                <span>Deep Discovery Active</span>
                            </div>
                        </div>
                        <div className="col-span-1 bg-[#111] border border-zinc-800 rounded-2xl p-6">
                            <p className="text-zinc-500 text-xs uppercase font-bold tracking-widest mb-1">Efficiency</p>
                            <p className="text-2xl font-bold">{efficiency}%</p>
                            <div className="mt-4 flex items-center gap-2 text-[10px] text-zinc-600">
                                <BarChart3 className="w-3 h-3" />
                                <span>Real-time Validation</span>
                            </div>
                        </div>
                        <div className="col-span-1 bg-[#111] border border-orange-500/20 rounded-2xl p-6">
                            <p className="text-zinc-500 text-xs uppercase font-bold tracking-widest mb-1">Activity Failed</p>
                            <p className="text-2xl font-bold text-orange-400">{activityFailedCount || 0}</p>
                            <div className="mt-4 flex items-center gap-2 text-[10px] text-zinc-600">
                                <AlertCircle className="w-3 h-3" />
                                <span>Phase 1 Failures</span>
                            </div>
                        </div>

                        {/* Real-Time Results Table */}
                        <div className="col-span-1 md:col-span-3 lg:col-span-4 bg-[#111] border border-zinc-800 rounded-3xl p-6 mt-2">
                            <div className="flex items-center justify-between mb-5">
                                <div className="flex items-center gap-3">
                                    <div className="bg-purple-500/10 p-2 rounded-xl text-purple-500">
                                        <BarChart3 className="w-5 h-5" />
                                    </div>
                                    <div>
                                        <h3 className="text-sm font-semibold uppercase tracking-wider">Live Results</h3>
                                        <p className="text-zinc-600 text-[10px]">Updates in real-time as leads are processed</p>
                                    </div>
                                </div>
                                {isProcessing && (
                                    <span className="text-[10px] bg-purple-500/10 text-purple-400 px-3 py-1 rounded-full border border-purple-500/20 flex items-center gap-1.5">
                                        <Loader2 className="w-3 h-3 animate-spin" />
                                        PROCESSING
                                    </span>
                                )}
                            </div>

                            <div className="overflow-x-auto rounded-xl border border-zinc-800">
                                <table className="w-full text-sm">
                                    <thead>
                                        <tr className="bg-black/80 border-b border-zinc-800">
                                            <th className="text-left text-[10px] text-zinc-500 uppercase tracking-wider font-bold px-4 py-3">#</th>
                                            <th className="text-left text-[10px] text-zinc-500 uppercase tracking-wider font-bold px-4 py-3">LinkedIn Profile</th>
                                            <th className="text-left text-[10px] text-zinc-500 uppercase tracking-wider font-bold px-4 py-3">First Name</th>
                                            <th className="text-left text-[10px] text-zinc-500 uppercase tracking-wider font-bold px-4 py-3">Status</th>
                                            <th className="text-left text-[10px] text-zinc-500 uppercase tracking-wider font-bold px-4 py-3">Websites</th>
                                            <th className="text-left text-[10px] text-zinc-500 uppercase tracking-wider font-bold px-4 py-3">Emails</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {currentLeads.length > 0 ? currentLeads.map((lead, i) => {
                                            const slug = lead.url.match(/linkedin\.com\/in\/([^\/]+)/)?.[1] || lead.url;
                                            return (
                                                <tr key={i} className={cn(
                                                    "border-b border-zinc-800/50 transition-all duration-300 animate-in fade-in slide-in-from-bottom-1",
                                                    i % 2 === 0 ? "bg-black/20" : "bg-transparent",
                                                    "hover:bg-zinc-800/30"
                                                )}>
                                                    <td className="px-4 py-3 text-zinc-600 font-mono text-xs">{i + 1}</td>
                                                    <td className="px-4 py-3">
                                                        <a
                                                            href={lead.url}
                                                            target="_blank"
                                                            rel="noopener noreferrer"
                                                            className="text-zinc-300 hover:text-white flex items-center gap-1.5 group transition-colors"
                                                        >
                                                            <span className="truncate max-w-[180px]">{slug}</span>
                                                            <ExternalLink className="w-3 h-3 text-zinc-600 group-hover:text-white flex-shrink-0" />
                                                        </a>
                                                    </td>
                                                    <td className="px-4 py-3">
                                                        <span className="text-zinc-300 text-xs">{lead.firstName || <span className="text-zinc-600 italic">—</span>}</span>
                                                    </td>
                                                    <td className="px-4 py-3">
                                                        <div className="flex items-center gap-1.5">
                                                            <span className={cn(
                                                                "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider",
                                                                lead.status === 'QUALIFIED' && "bg-accent/10 text-accent border border-accent/20",
                                                                lead.status === 'REJECTED' && "bg-red-500/10 text-red-400 border border-red-500/20",
                                                                lead.status === 'SCANNING' && "bg-blue-500/10 text-blue-400 border border-blue-500/20",
                                                                lead.status === 'PENDING' && "bg-zinc-500/10 text-zinc-400 border border-zinc-500/20",
                                                                lead.status === 'ACTIVITY_FAILED' && "bg-orange-500/10 text-orange-400 border border-orange-500/20"
                                                            )}>
                                                                {lead.status === 'QUALIFIED' && <CheckCircle className="w-3 h-3" />}
                                                                {lead.status === 'REJECTED' && <XCircle className="w-3 h-3" />}
                                                                {lead.status === 'SCANNING' && <Loader2 className="w-3 h-3 animate-spin" />}
                                                                {lead.status === 'ACTIVITY_FAILED' && <AlertCircle className="w-3 h-3" />}
                                                                {lead.status}
                                                            </span>
                                                            {lead.timedOut && (
                                                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider bg-amber-500/10 text-amber-400 border border-amber-500/20">
                                                                    TIMEOUT
                                                                </span>
                                                            )}
                                                        </div>
                                                    </td>
                                                    <td className="px-4 py-3">
                                                        <div className="flex flex-col gap-1">
                                                            {(lead.websites && lead.websites.length > 0) ? lead.websites.map((w, wi) => (
                                                                <a
                                                                    key={wi}
                                                                    href={w}
                                                                    target="_blank"
                                                                    rel="noopener noreferrer"
                                                                    className="text-blue-400 hover:text-blue-300 flex items-center gap-1 text-xs transition-colors truncate max-w-[200px]"
                                                                >
                                                                    <Globe className="w-3 h-3 flex-shrink-0" />
                                                                    {w.replace(/^https?:\/\/(www\.)?/, '')}
                                                                </a>
                                                            )) : lead.website ? (
                                                                <a
                                                                    href={lead.website}
                                                                    target="_blank"
                                                                    rel="noopener noreferrer"
                                                                    className="text-blue-400 hover:text-blue-300 flex items-center gap-1 text-xs transition-colors truncate max-w-[200px]"
                                                                >
                                                                    <Globe className="w-3 h-3 flex-shrink-0" />
                                                                    {lead.website.replace(/^https?:\/\/(www\.)?/, '')}
                                                                </a>
                                                            ) : (
                                                                <span className="text-zinc-600 text-xs italic">—</span>
                                                            )}
                                                        </div>
                                                    </td>
                                                    <td className="px-4 py-3">
                                                        <div className="flex flex-col gap-1">
                                                            {lead.emails.length > 0 ? lead.emails.map((email, ei) => (
                                                                <span key={ei} className="text-accent text-xs flex items-center gap-1">
                                                                    <Mail className="w-3 h-3 flex-shrink-0" />
                                                                    {email}
                                                                </span>
                                                            )) : (
                                                                <span className="text-zinc-600 text-xs italic">—</span>
                                                            )}
                                                        </div>
                                                    </td>
                                                </tr>
                                            );
                                        }) : (
                                            <tr>
                                                <td colSpan={6} className="px-4 py-12 text-center">
                                                    <div className="flex flex-col items-center gap-2">
                                                        <Search className="w-8 h-8 text-zinc-700" />
                                                        <p className="text-zinc-600 text-xs">No results yet. Start the engine to begin processing.</p>
                                                    </div>
                                                </td>
                                            </tr>
                                        )}
                                    </tbody>
                                </table>
                            </div>

                            {currentLeads.length > 0 && (
                                <div className="flex items-center justify-between mt-4 px-1">
                                    <p className="text-[10px] text-zinc-600">
                                        Showing {currentLeads.length} result{currentLeads.length !== 1 ? 's' : ''}
                                    </p>
                                    <p className="text-[10px] text-zinc-600">
                                        {qualifiedCount} qualified • {emailsFound} emails found
                                    </p>
                                </div>
                            )}
                        </div>
                    </>
                ) : activeTab === 'hunter' ? (
                    /* ── Email Hunter Tab ── */
                    <div className="col-span-1 md:col-span-3 lg:col-span-4 space-y-4">
                        <div className="bg-[#111] border border-zinc-800 rounded-3xl p-8">
                            <div className="flex items-center gap-3 mb-6">
                                <div className="bg-accent/10 p-3 rounded-2xl text-accent">
                                    <Globe className="w-6 h-6" />
                                </div>
                                <div>
                                    <h2 className="text-xl font-semibold">Email Hunter</h2>
                                    <p className="text-zinc-500 text-sm">Paste website URLs to extract emails — no LinkedIn needed</p>
                                </div>
                            </div>

                            <div className="space-y-4">
                                <div>
                                    <label className="text-xs text-zinc-500 uppercase tracking-widest block mb-2 font-bold">Website URLs (one per line)</label>
                                    <textarea
                                        value={hunterUrls}
                                        onChange={e => setHunterUrls(e.target.value)}
                                        placeholder={"https://www.example.com\nhttps://coaching-site.com\nwww.another-site.io"}
                                        className="w-full h-40 bg-black/50 border border-zinc-800 rounded-xl px-4 py-3 text-white text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent/30 resize-none placeholder:text-zinc-700"
                                        disabled={hunterProcessing}
                                    />
                                </div>

                                <div className="flex items-center gap-3">
                                    {!hunterProcessing ? (
                                        <button
                                            onClick={handleHunterStart}
                                            disabled={hunterProcessing || hunterUrls.trim().length === 0}
                                            className="bg-accent text-black px-6 py-3 rounded-xl font-bold hover:bg-accent disabled:opacity-50 transition-all flex items-center gap-2"
                                        >
                                            <Search className="w-4 h-4" />
                                            Hunt Emails
                                        </button>
                                    ) : (
                                        <button
                                            onClick={handleHunterCancel}
                                            className="bg-red-500/10 text-red-400 border border-red-500/30 px-6 py-3 rounded-xl font-bold hover:bg-red-500/20 transition-all flex items-center gap-2"
                                        >
                                            <StopCircle className="w-4 h-4" />
                                            Cancel
                                        </button>
                                    )}

                                    <label className="bg-zinc-800 text-zinc-300 px-4 py-3 rounded-xl font-medium hover:bg-zinc-700 transition-colors flex items-center gap-2 cursor-pointer border border-zinc-700">
                                        <Upload className="w-4 h-4" />
                                        Upload CSV
                                        <input type="file" accept=".csv" onChange={handleHunterCSV} className="hidden" />
                                    </label>

                                    {hunterResults.length > 0 && (
                                        <button
                                            onClick={handleHunterExport}
                                            className="bg-white/5 border border-zinc-800 text-white px-4 py-3 rounded-xl font-medium hover:bg-zinc-800 transition-colors flex items-center gap-2"
                                        >
                                            <Download className="w-4 h-4" />
                                            Export CSV
                                        </button>
                                    )}
                                </div>

                                {hunterProcessing && (
                                    <div className="mt-2">
                                        <div className="h-2 w-full bg-black/50 rounded-full overflow-hidden">
                                            <div
                                                className="h-full bg-accent transition-all duration-500"
                                                style={{ width: `${hunterTotal > 0 ? (hunterProgress / hunterTotal) * 100 : 0}%` }}
                                            />
                                        </div>
                                        <p className="text-xs text-zinc-500 mt-1">{hunterProgress} of {hunterTotal} websites scanned</p>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Results Table */}
                        {hunterResults.length > 0 && (
                            <div className="bg-[#111] border border-zinc-800 rounded-3xl p-6">
                                <div className="flex items-center justify-between mb-4">
                                    <div className="flex items-center gap-2">
                                        <Mail className="w-4 h-4 text-accent" />
                                        <h3 className="text-sm font-semibold uppercase tracking-wider">Results</h3>
                                        <span className="text-xs text-zinc-500">
                                            {hunterResults.filter(r => r.emails.length > 0).length}/{hunterResults.length} with emails •{" "}
                                            {hunterResults.reduce((a, r) => a + r.emails.length, 0)} total emails
                                        </span>
                                    </div>
                                </div>
                                <div className="overflow-x-auto rounded-xl border border-zinc-800">
                                    <table className="w-full text-sm">
                                        <thead>
                                            <tr className="bg-black/80 border-b border-zinc-800">
                                                <th className="text-left text-[10px] text-zinc-500 uppercase tracking-wider font-bold px-4 py-3">#</th>
                                                <th className="text-left text-[10px] text-zinc-500 uppercase tracking-wider font-bold px-4 py-3">Website</th>
                                                <th className="text-left text-[10px] text-zinc-500 uppercase tracking-wider font-bold px-4 py-3">Emails</th>
                                                <th className="text-left text-[10px] text-zinc-500 uppercase tracking-wider font-bold px-4 py-3">Status</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {hunterResults.map((r, i) => (
                                                <tr key={i} className={cn(
                                                    "border-b border-zinc-800/50 transition-all hover:bg-zinc-800/30",
                                                    i % 2 === 0 ? "bg-black/20" : "bg-transparent"
                                                )}>
                                                    <td className="px-4 py-3 text-zinc-600 font-mono text-xs">{i + 1}</td>
                                                    <td className="px-4 py-3">
                                                        <a href={r.website.startsWith('http') ? r.website : 'https://' + r.website} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 flex items-center gap-1.5 text-xs truncate max-w-[300px]">
                                                            <Globe className="w-3 h-3 flex-shrink-0" />
                                                            {r.website.replace(/^https?:\/\/(www\.)?/, '')}
                                                        </a>
                                                    </td>
                                                    <td className="px-4 py-3">
                                                        <div className="flex flex-col gap-1">
                                                            {r.emails.length > 0 ? r.emails.map((email, ei) => (
                                                                <span key={ei} className="text-accent text-xs flex items-center gap-1">
                                                                    <Mail className="w-3 h-3 flex-shrink-0" />
                                                                    {email}
                                                                </span>
                                                            )) : (
                                                                <span className="text-zinc-600 text-xs italic">—</span>
                                                            )}
                                                        </div>
                                                    </td>
                                                    <td className="px-4 py-3">
                                                        <span className={cn(
                                                            "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider",
                                                            r.status === 'SUCCESS' && "bg-accent/10 text-accent border border-accent/20",
                                                            r.status === 'NO_EMAILS' && "bg-zinc-500/10 text-zinc-400 border border-zinc-500/20",
                                                            r.status === 'ERROR' && "bg-red-500/10 text-red-400 border border-red-500/20",
                                                        )}>
                                                            {r.status === 'SUCCESS' && <CheckCircle className="w-3 h-3" />}
                                                            {r.status === 'NO_EMAILS' && <XCircle className="w-3 h-3" />}
                                                            {r.status === 'ERROR' && <AlertCircle className="w-3 h-3" />}
                                                            {r.status}
                                                        </span>
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        )}
                    </div>
                ) : activeTab === 'unbouncer' ? (
                    /* ── Email Unbouncer Tab ── */
                    <div className="col-span-1 md:col-span-3 lg:col-span-4 space-y-4">
                        {/* Input Card */}
                        <div className="bg-[#111] border border-zinc-800 rounded-3xl p-8">
                            <div className="flex items-center gap-3 mb-6">
                                <div className="bg-accent/10 p-3 rounded-2xl text-accent">
                                    <ShieldCheck className="w-6 h-6" />
                                </div>
                                <div>
                                    <h2 className="text-xl font-semibold">Email Unbouncer</h2>
                                    <p className="text-zinc-500 text-sm">Deep 7-layer verification — MX, SMTP handshake, disposable detection, catch-all & more</p>
                                </div>
                            </div>

                            <div className="space-y-4">
                                <div>
                                    <label className="text-xs text-zinc-500 uppercase tracking-widest block mb-2 font-bold">Email Addresses (one per line)</label>
                                    <textarea
                                        value={unbouncerInput}
                                        onChange={e => setUnbouncerInput(e.target.value)}
                                        placeholder={"john@example.com\njane.doe@company.io\nhello@startup.com"}
                                        className="w-full h-40 bg-black/50 border border-zinc-800 rounded-xl px-4 py-3 text-white text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent/30 resize-none placeholder:text-zinc-700"
                                        disabled={unbouncerProcessing}
                                    />
                                    {unbouncerInput.trim().length > 0 && (
                                        <p className="text-[10px] text-zinc-600 mt-1 font-mono">
                                            {unbouncerInput.split('\n').filter(e => e.trim().length > 3 && e.includes('@')).length} email(s) detected
                                        </p>
                                    )}
                                </div>

                                <div className="flex items-center gap-3 flex-wrap">
                                    {!unbouncerProcessing ? (
                                        <button
                                            onClick={handleUnbouncerStart}
                                            disabled={unbouncerInput.trim().length === 0}
                                            className="bg-accent text-black px-6 py-3 rounded-xl font-bold hover:bg-accent disabled:opacity-50 transition-all flex items-center gap-2 shadow-lg shadow-accent/10"
                                        >
                                            <Zap className="w-4 h-4" />
                                            Verify Emails
                                        </button>
                                    ) : (
                                        <button
                                            onClick={handleUnbouncerCancel}
                                            className="bg-red-500/10 text-red-400 border border-red-500/30 px-6 py-3 rounded-xl font-bold hover:bg-red-500/20 transition-all flex items-center gap-2"
                                        >
                                            <StopCircle className="w-4 h-4" />
                                            Cancel
                                        </button>
                                    )}

                                    <label className="bg-zinc-800 text-zinc-300 px-4 py-3 rounded-xl font-medium hover:bg-zinc-700 transition-colors flex items-center gap-2 cursor-pointer border border-zinc-700">
                                        <Upload className="w-4 h-4" />
                                        Upload CSV
                                        <input type="file" accept=".csv" onChange={handleUnbouncerCSV} className="hidden" />
                                    </label>

                                    {unbouncerResults.length > 0 && (
                                        <>
                                            <button
                                                onClick={handleUnbouncerExport}
                                                className="bg-white/5 border border-zinc-800 text-white px-4 py-3 rounded-xl font-medium hover:bg-zinc-800 transition-colors flex items-center gap-2"
                                            >
                                                <Download className="w-4 h-4" />
                                                Export All{unbouncerProcessing ? ` (${unbouncerResults.length})` : ''}
                                            </button>
                                            <button
                                                onClick={handleUnbouncerExportValid}
                                                className="bg-accent/10 border border-accent/30 text-accent px-4 py-3 rounded-xl font-medium hover:bg-accent/20 transition-colors flex items-center gap-2"
                                            >
                                                <ShieldCheck className="w-4 h-4" />
                                                Export Valid Only
                                            </button>
                                        </>
                                    )}
                                </div>

                                {/* Progress Bar */}
                                {unbouncerProcessing && (
                                    <div className="mt-2">
                                        <div className="h-2 w-full bg-black/50 rounded-full overflow-hidden">
                                            <div
                                                className="h-full bg-gradient-to-r from-accent to-teal-400 transition-all duration-500"
                                                style={{ width: `${unbouncerTotal > 0 ? (unbouncerProgress / unbouncerTotal) * 100 : 0}%` }}
                                            />
                                        </div>
                                        <div className="flex justify-between mt-1">
                                            <p className="text-xs text-zinc-500">{unbouncerProgress} of {unbouncerTotal} emails verified</p>
                                            <p className="text-xs text-accent font-mono">{unbouncerTotal > 0 ? Math.round((unbouncerProgress / unbouncerTotal) * 100) : 0}%</p>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Stats Cards */}
                        {unbouncerResults.length > 0 && (
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                                <div className="bg-[#111] border border-accent/20 rounded-2xl p-5">
                                    <div className="flex items-center gap-2 mb-2">
                                        <ShieldCheck className="w-4 h-4 text-accent" />
                                        <p className="text-zinc-500 text-xs uppercase font-bold tracking-widest">Valid</p>
                                    </div>
                                    <p className="text-3xl font-bold text-accent">{unbouncerResults.filter(r => r.status === 'VALID').length}</p>
                                    <p className="text-[10px] text-zinc-600 mt-1">Ready to send</p>
                                </div>
                                <div className="bg-[#111] border border-red-500/20 rounded-2xl p-5">
                                    <div className="flex items-center gap-2 mb-2">
                                        <ShieldX className="w-4 h-4 text-red-500" />
                                        <p className="text-zinc-500 text-xs uppercase font-bold tracking-widest">Invalid</p>
                                    </div>
                                    <p className="text-3xl font-bold text-red-500">{unbouncerResults.filter(r => r.status === 'INVALID').length}</p>
                                    <p className="text-[10px] text-zinc-600 mt-1">Will bounce</p>
                                </div>
                                <div className="bg-[#111] border border-amber-500/20 rounded-2xl p-5">
                                    <div className="flex items-center gap-2 mb-2">
                                        <ShieldAlert className="w-4 h-4 text-amber-500" />
                                        <p className="text-zinc-500 text-xs uppercase font-bold tracking-widest">Risky</p>
                                    </div>
                                    <p className="text-3xl font-bold text-amber-500">{unbouncerResults.filter(r => r.status === 'RISKY').length}</p>
                                    <p className="text-[10px] text-zinc-600 mt-1">Catch-all / disposable</p>
                                </div>
                                <div className="bg-[#111] border border-zinc-700 rounded-2xl p-5">
                                    <div className="flex items-center gap-2 mb-2">
                                        <ShieldQuestion className="w-4 h-4 text-zinc-400" />
                                        <p className="text-zinc-500 text-xs uppercase font-bold tracking-widest">Unknown</p>
                                    </div>
                                    <p className="text-3xl font-bold text-zinc-400">{unbouncerResults.filter(r => r.status === 'UNKNOWN').length}</p>
                                    <p className="text-[10px] text-zinc-600 mt-1">Could not verify</p>
                                </div>
                            </div>
                        )}

                        {/* Results Table */}
                        {unbouncerResults.length > 0 && (
                            <div className="bg-[#111] border border-zinc-800 rounded-3xl p-6">
                                <div className="flex items-center justify-between mb-4">
                                    <div className="flex items-center gap-2">
                                        <ShieldCheck className="w-4 h-4 text-accent" />
                                        <h3 className="text-sm font-semibold uppercase tracking-wider">Verification Results</h3>
                                        <span className="text-xs text-zinc-500">
                                            {unbouncerResults.filter(r => r.status === 'VALID').length}/{unbouncerResults.length} valid •{" "}
                                            Avg score: {Math.round(unbouncerResults.reduce((a, r) => a + r.score, 0) / unbouncerResults.length)}
                                        </span>
                                    </div>
                                    {unbouncerProcessing && (
                                        <span className="text-[10px] bg-accent/10 text-accent px-3 py-1 rounded-full border border-accent/20 flex items-center gap-1.5">
                                            <Loader2 className="w-3 h-3 animate-spin" />
                                            VERIFYING
                                        </span>
                                    )}
                                </div>
                                <div className="overflow-x-auto rounded-xl border border-zinc-800">
                                    <table className="w-full text-sm">
                                        <thead>
                                            <tr className="bg-black/80 border-b border-zinc-800">
                                                <th className="text-left text-[10px] text-zinc-500 uppercase tracking-wider font-bold px-4 py-3">#</th>
                                                <th className="text-left text-[10px] text-zinc-500 uppercase tracking-wider font-bold px-4 py-3">Email</th>
                                                <th className="text-left text-[10px] text-zinc-500 uppercase tracking-wider font-bold px-4 py-3">Status</th>
                                                <th className="text-left text-[10px] text-zinc-500 uppercase tracking-wider font-bold px-4 py-3">Score</th>
                                                <th className="text-left text-[10px] text-zinc-500 uppercase tracking-wider font-bold px-4 py-3">Checks</th>
                                                <th className="text-left text-[10px] text-zinc-500 uppercase tracking-wider font-bold px-4 py-3">Reason</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {unbouncerResults.map((r, i) => (
                                                <tr key={i} className={cn(
                                                    "border-b border-zinc-800/50 transition-all hover:bg-zinc-800/30 animate-in fade-in slide-in-from-bottom-1 duration-300",
                                                    i % 2 === 0 ? "bg-black/20" : "bg-transparent"
                                                )}>
                                                    <td className="px-4 py-3 text-zinc-600 font-mono text-xs">{i + 1}</td>
                                                    <td className="px-4 py-3">
                                                        <div className="flex items-center gap-1.5">
                                                            <AtSign className="w-3 h-3 text-zinc-600 flex-shrink-0" />
                                                            <span className="text-zinc-200 text-xs font-mono">{r.email}</span>
                                                            {r.provider && (
                                                                <span className="text-[9px] bg-zinc-800 text-zinc-500 px-1.5 py-0.5 rounded-md">{r.provider}</span>
                                                            )}
                                                        </div>
                                                    </td>
                                                    <td className="px-4 py-3">
                                                        <span className={cn(
                                                            "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider",
                                                            r.status === 'VALID' && "bg-accent/10 text-accent border border-accent/20",
                                                            r.status === 'INVALID' && "bg-red-500/10 text-red-400 border border-red-500/20",
                                                            r.status === 'RISKY' && "bg-amber-500/10 text-amber-400 border border-amber-500/20",
                                                            r.status === 'UNKNOWN' && "bg-zinc-500/10 text-zinc-400 border border-zinc-500/20",
                                                        )}>
                                                            {r.status === 'VALID' && <ShieldCheck className="w-3 h-3" />}
                                                            {r.status === 'INVALID' && <ShieldX className="w-3 h-3" />}
                                                            {r.status === 'RISKY' && <ShieldAlert className="w-3 h-3" />}
                                                            {r.status === 'UNKNOWN' && <ShieldQuestion className="w-3 h-3" />}
                                                            {r.status}
                                                        </span>
                                                    </td>
                                                    <td className="px-4 py-3">
                                                        <div className="flex items-center gap-2">
                                                            <div className="w-16 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                                                                <div
                                                                    className={cn(
                                                                        "h-full rounded-full transition-all",
                                                                        r.score >= 75 ? "bg-accent" :
                                                                        r.score >= 45 ? "bg-amber-500" :
                                                                        r.score >= 25 ? "bg-orange-500" : "bg-red-500"
                                                                    )}
                                                                    style={{ width: `${r.score}%` }}
                                                                />
                                                            </div>
                                                            <span className={cn(
                                                                "text-xs font-mono font-bold",
                                                                r.score >= 75 ? "text-accent" :
                                                                r.score >= 45 ? "text-amber-400" :
                                                                r.score >= 25 ? "text-orange-400" : "text-red-400"
                                                            )}>{r.score}</span>
                                                        </div>
                                                    </td>
                                                    <td className="px-4 py-3">
                                                        <div className="flex flex-wrap gap-1">
                                                            {r.checks.syntax && (
                                                                <span className="text-[9px] bg-accent/10 text-accent border border-accent/20 px-1.5 py-0.5 rounded-md">Syntax ✓</span>
                                                            )}
                                                            {r.checks.mxRecord && (
                                                                <span className="text-[9px] bg-accent/10 text-accent border border-accent/20 px-1.5 py-0.5 rounded-md">MX ✓</span>
                                                            )}
                                                            {!r.checks.mxRecord && r.checks.syntax && (
                                                                <span className="text-[9px] bg-red-500/10 text-red-400 border border-red-500/20 px-1.5 py-0.5 rounded-md">No MX ✗</span>
                                                            )}
                                                            {r.checks.smtpValid === true && (
                                                                <span className="text-[9px] bg-accent/10 text-accent border border-accent/20 px-1.5 py-0.5 rounded-md">SMTP ✓</span>
                                                            )}
                                                            {r.checks.smtpValid === false && (
                                                                <span className="text-[9px] bg-red-500/10 text-red-400 border border-red-500/20 px-1.5 py-0.5 rounded-md">SMTP ✗</span>
                                                            )}
                                                            {r.checks.disposable && (
                                                                <span className="text-[9px] bg-amber-500/10 text-amber-400 border border-amber-500/20 px-1.5 py-0.5 rounded-md flex items-center gap-0.5"><Ban className="w-2.5 h-2.5" />Disposable</span>
                                                            )}
                                                            {r.checks.catchAll === true && (
                                                                <span className="text-[9px] bg-amber-500/10 text-amber-400 border border-amber-500/20 px-1.5 py-0.5 rounded-md">Catch-All</span>
                                                            )}
                                                            {r.checks.roleAccount && (
                                                                <span className="text-[9px] bg-zinc-500/10 text-zinc-400 border border-zinc-500/20 px-1.5 py-0.5 rounded-md flex items-center gap-0.5"><UserX className="w-2.5 h-2.5" />Role</span>
                                                            )}
                                                            {r.checks.freeProvider && (
                                                                <span className="text-[9px] bg-blue-500/10 text-blue-400 border border-blue-500/20 px-1.5 py-0.5 rounded-md">Free</span>
                                                            )}
                                                        </div>
                                                    </td>
                                                    <td className="px-4 py-3">
                                                        <span className="text-[11px] text-zinc-400 max-w-[250px] truncate block">{r.reason}</span>
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>

                                {/* Summary Footer */}
                                <div className="flex items-center justify-between mt-4 px-1">
                                    <p className="text-[10px] text-zinc-600">
                                        Showing {unbouncerResults.length} result{unbouncerResults.length !== 1 ? 's' : ''}
                                    </p>
                                    <div className="flex items-center gap-3">
                                        <span className="text-[10px] text-accent">{unbouncerResults.filter(r => r.status === 'VALID').length} valid</span>
                                        <span className="text-[10px] text-red-500">{unbouncerResults.filter(r => r.status === 'INVALID').length} invalid</span>
                                        <span className="text-[10px] text-amber-500">{unbouncerResults.filter(r => r.status === 'RISKY').length} risky</span>
                                        <span className="text-[10px] text-zinc-500">{unbouncerResults.filter(r => r.status === 'UNKNOWN').length} unknown</span>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                ) : activeTab === 'cleaner' ? (
                    <div className="col-span-1 md:col-span-3 lg:col-span-4">
                        <UrlCleaner />
                    </div>
                ) : activeTab === 'finder' ? (
                    <div className="col-span-1 md:col-span-3 lg:col-span-4">
                        <FinderEngine />
                    </div>
                ) : activeTab === 'crm' ? (
                    <div className="col-span-1 md:col-span-3 lg:col-span-4">
                        <CrmDatabase />
                    </div>
                ) : null}
            </div>

            {/* Saved Runs History Modal */}
            {showHistory && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
                    <div className="bg-[#111] border border-zinc-800 rounded-2xl p-6 w-full max-w-xl mx-4 shadow-2xl animate-in zoom-in-95 duration-200 max-h-[80vh] overflow-hidden flex flex-col">
                        <div className="flex items-center justify-between mb-4">
                            <div className="flex items-center gap-2">
                                <Database className="w-5 h-5 text-purple-400" />
                                <h3 className="text-lg font-semibold">Saved Runs</h3>
                            </div>
                            <button onClick={() => setShowHistory(false)} className="text-zinc-500 hover:text-white p-1 rounded-lg hover:bg-zinc-800 transition-colors">
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        <div className="flex-1 overflow-y-auto space-y-2 pr-1">
                            {historyLoading ? (
                                <div className="flex items-center justify-center py-12">
                                    <Loader2 className="w-6 h-6 text-zinc-500 animate-spin" />
                                </div>
                            ) : savedRuns.length > 0 ? (
                                savedRuns.map((run) => (
                                    <div key={run.filename} className="bg-black/50 border border-zinc-800/50 p-4 rounded-xl flex items-center justify-between gap-3 hover:bg-zinc-800/30 transition-colors">
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm text-white font-medium truncate">{run.filename}</p>
                                            <div className="flex items-center gap-3 mt-1">
                                                <span className="text-[10px] text-zinc-500 flex items-center gap-1">
                                                    <Clock className="w-3 h-3" />
                                                    {new Date(run.savedAt).toLocaleString()}
                                                </span>
                                                <span className="text-[10px] text-accent">{run.qualifiedCount} qualified</span>
                                                <span className="text-[10px] text-blue-500">{run.emailsFound} emails</span>
                                                <span className="text-[10px] text-zinc-500">{run.processedCount}/{run.totalCount} processed</span>
                                            </div>
                                        </div>
                                        <div className="flex gap-1.5">
                                            <button
                                                onClick={() => handleLoadRun(run.filename)}
                                                className="p-2 rounded-lg bg-blue-500/10 text-blue-400 border border-blue-500/20 hover:bg-blue-500/20 transition-colors"
                                                title="Load this run"
                                            >
                                                <FolderOpen className="w-4 h-4" />
                                            </button>
                                            <button
                                                onClick={() => handleDeleteRun(run.filename)}
                                                className="p-2 rounded-lg bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-colors"
                                                title="Delete this run"
                                            >
                                                <Trash2 className="w-4 h-4" />
                                            </button>
                                        </div>
                                    </div>
                                ))
                            ) : (
                                <div className="flex flex-col items-center gap-2 py-12">
                                    <History className="w-8 h-8 text-zinc-700" />
                                    <p className="text-zinc-600 text-sm">No saved runs found</p>
                                    <p className="text-zinc-700 text-xs">Results will appear here after processing</p>
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
