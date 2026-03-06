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
} from "lucide-react";
import { cn } from "@/lib/utils";

import {
    processLeads,
    processSingleLead,
    retrySingleLead,
    saveProgress,
    loadProgress,
    listSavedRuns,
    loadSavedRun,
    deleteSavedRun,
    exportResultsCSV,
    type Lead,
    type SavedRun,
} from "@/app/actions/scraper-actions";
import { exportToGoogleSheets, isGoogleSheetsConfigured } from "@/app/actions/google-sheets";
import UrlCleaner from "./UrlCleaner";

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
                        t.type === 'success' && "bg-emerald-500/10 border-emerald-500/30 text-emerald-400",
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
    const [activeTab, setActiveTab] = useState<'engine' | 'cleaner'>('engine');
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

    const BATCH_SIZE = 50;
    const SAVE_INTERVAL = 10;

    const handleStartEngine = async (resumeFrom = 0, existingLeads: Lead[] = []) => {
        if (csvUrls.length === 0) {
            addToast('No URLs loaded. Upload a CSV first.', 'error');
            return;
        }

        isCancelledRef.current = false;
        setIsProcessing(true);
        setProgress(resumeFrom > 0 ? Math.round((resumeFrom / Math.min(csvUrls.length, rowLimit)) * 100) : 0);
        if (resumeFrom === 0) setLeads([]);
        else setLeads(existingLeads);

        const limit = Math.min(csvUrls.length, rowLimit);
        const urlsToProcess = csvUrls.slice(0, limit);
        let processedCount = resumeFrom;
        const allLeads: Lead[] = [...existingLeads];
        const totalBatches = Math.ceil((limit - resumeFrom) / BATCH_SIZE);

        setLogs(prev => [...prev, {
            msg: resumeFrom > 0
                ? `Resuming from lead ${resumeFrom + 1}/${limit} (${totalBatches} batch${totalBatches > 1 ? 'es' : ''} remaining)...`
                : `Engine Ignition: ${limit} leads in ${totalBatches} batch${totalBatches > 1 ? 'es' : ''} of ${BATCH_SIZE}...`,
            time: new Date().toLocaleTimeString(), type: 'info'
        }]);

        for (let batchStart = resumeFrom; batchStart < limit; batchStart += BATCH_SIZE) {
            const batchEnd = Math.min(batchStart + BATCH_SIZE, limit);
            const batchNum = Math.floor((batchStart - resumeFrom) / BATCH_SIZE) + 1;
            const batchUrls = urlsToProcess.slice(batchStart, batchEnd);

            setBatchInfo(`Batch ${batchNum}/${totalBatches} (leads ${batchStart + 1}-${batchEnd})`);
            setLogs(prev => [...prev, {
                msg: `── Batch ${batchNum}/${totalBatches}: Processing leads ${batchStart + 1} to ${batchEnd} ──`,
                time: new Date().toLocaleTimeString(), type: 'info'
            }]);

            for (let i = 0; i < batchUrls.length; i++) {
                const url = batchUrls[i];
                setLogs(prev => [...prev, { msg: `[${processedCount + 1}/${limit}] Analyzing ${url}...`, time: new Date().toLocaleTimeString(), type: 'info' }]);

                try {
                    const result = await processSingleLead(url);
                    allLeads.push(result);
                    setLeads([...allLeads]);

                    const newLogs = result.logs.map(logMsg => ({
                        msg: logMsg,
                        time: new Date().toLocaleTimeString(),
                        type: result.status === 'QUALIFIED' ? 'success' as const : 'info' as const
                    }));
                    setLogs(prev => [...prev, ...newLogs]);
                } catch (error) {
                    setLogs(prev => [...prev, { msg: `Error processing ${url}: ${error}`, time: new Date().toLocaleTimeString(), type: 'info' }]);
                }

                processedCount++;
                setProgress(Math.round((processedCount / limit) * 100));

                // Auto-save every SAVE_INTERVAL leads
                if (processedCount % SAVE_INTERVAL === 0) {
                    await saveProgress(allLeads, processedCount, limit);
                    setLogs(prev => [...prev, { msg: `💾 Progress saved (${processedCount}/${limit})`, time: new Date().toLocaleTimeString(), type: 'info' }]);
                }

                // Check cancel flag
                if (isCancelledRef.current) {
                    await saveProgress(allLeads, processedCount, limit);
                    setLogs(prev => [...prev, { msg: `🛑 Processing cancelled at ${processedCount}/${limit}. Progress saved.`, time: new Date().toLocaleTimeString(), type: 'info' }]);
                    addToast(`Cancelled. ${processedCount} leads processed so far.`, 'info');
                    setBatchInfo('');
                    setIsProcessing(false);
                    return;
                }

                // Rate limiting: 3-5 second random delay between leads
                if (i < batchUrls.length - 1) {
                    const delay = 3000 + Math.random() * 2000;
                    await new Promise(resolve => setTimeout(resolve, delay));
                }

                // Check pause flag
                while (isPausedRef.current && !isCancelledRef.current) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }

            // Check cancel flag between batches
            if (isCancelledRef.current) {
                await saveProgress(allLeads, processedCount, limit);
                setLogs(prev => [...prev, { msg: `🛑 Processing cancelled at ${processedCount}/${limit}. Progress saved.`, time: new Date().toLocaleTimeString(), type: 'info' }]);
                addToast(`Cancelled. ${processedCount} leads processed so far.`, 'info');
                setBatchInfo('');
                setIsProcessing(false);
                return;
            }

            // Pause between batches (30 seconds) — skip after last batch
            if (batchEnd < limit) {
                // Save progress at end of each batch
                await saveProgress(allLeads, processedCount, limit);
                setLogs(prev => [...prev, {
                    msg: `⏸ Batch ${batchNum} complete. Cooling down 30s before next batch...`,
                    time: new Date().toLocaleTimeString(), type: 'info'
                }]);
                await new Promise(resolve => setTimeout(resolve, 30000));
            }
        }

        // Final save
        await saveProgress(allLeads, processedCount, limit);
        setBatchInfo('');
        setIsProcessing(false);
        setLogs(prev => [...prev, { msg: `✅ Mission Complete. ${processedCount} leads processed across ${totalBatches} batch${totalBatches > 1 ? 'es' : ''}.`, time: new Date().toLocaleTimeString(), type: 'success' }]);
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
                const result = await retrySingleLead(failedLead.url);

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
                        <div className="bg-zinc-900 border border-zinc-800 p-1 rounded-xl flex">
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
                                onClick={() => setActiveTab('cleaner')}
                                className={cn(
                                    "px-4 py-1.5 rounded-lg text-sm font-medium transition-all",
                                    activeTab === 'cleaner' ? "bg-white text-black shadow-lg" : "text-zinc-500 hover:text-white"
                                )}
                            >
                                URL Cleaner
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
                                        className="bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 px-4 py-2 rounded-xl font-medium hover:bg-emerald-500/20 disabled:opacity-50 transition-colors flex items-center gap-2"
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
                                        isDragging ? "border-white bg-white/5" : "border-zinc-800 bg-zinc-900/30",
                                        csvUrls.length > 0 && !isDragging ? "border-emerald-500/50" : ""
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
                                            className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-1 focus:ring-white/20"
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
                                                        ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/20"
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
                                </div>
                            </div>
                        </div>

                        {/* Progress Bento */}
                        <div className="col-span-1 bg-[#111] border border-zinc-800 rounded-3xl p-8 flex flex-col justify-between overflow-hidden relative">
                            <div className="relative z-10">
                                <h3 className="text-zinc-500 text-xs uppercase tracking-[0.2em] font-bold mb-6">Processing Signal</h3>
                                <div className="space-y-8">
                                    <div className="flex items-center justify-between">
                                        <span className={cn("flex items-center gap-2", isProcessing && progress < 50 ? "text-emerald-500" : "text-zinc-600")}>
                                            <div className={cn("w-2 h-2 rounded-full", isProcessing && progress < 50 ? "bg-emerald-500 animate-pulse" : "bg-zinc-800")}></div>
                                            Phase 1: Activity Gate
                                        </span>
                                        <span className={cn("font-mono transition-colors", isProcessing && progress < 50 ? "text-emerald-500" : "text-zinc-600")}>
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
                                        <div className="h-2 w-full bg-zinc-900 rounded-full overflow-hidden">
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
                                    <Signal className={cn("w-4 h-4", isProcessing ? "text-emerald-500 animate-pulse" : "text-zinc-500")} />
                                    <h3 className="text-sm font-semibold uppercase tracking-wider">Live Signal Feed</h3>
                                </div>
                                {isProcessing && <span className="text-[10px] bg-emerald-500/10 text-emerald-500 px-2 py-0.5 rounded-full border border-emerald-500/20 animate-pulse">LIVE</span>}
                            </div>

                            <div className="flex-1 overflow-y-auto space-y-3 pr-2 custom-scrollbar">
                                {logs.map((log, i) => (
                                    <div key={i} className="bg-zinc-900/50 border border-zinc-800/50 p-3 rounded-xl flex items-start gap-3 animate-in fade-in slide-in-from-bottom-2 duration-500">
                                        <div className="mt-1">
                                            {log.type === 'success' ? <CheckCircle className="w-4 h-4 text-emerald-500" /> : <Search className="w-4 h-4 text-blue-500" />}
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
                            <p className="text-2xl font-bold text-emerald-500">{leads.filter(l => l.status !== 'REJECTED').length || 0}</p>
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
                                        <tr className="bg-zinc-900/80 border-b border-zinc-800">
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
                                                    i % 2 === 0 ? "bg-zinc-900/20" : "bg-transparent",
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
                                                                lead.status === 'QUALIFIED' && "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20",
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
                                                                <span key={ei} className="text-emerald-400 text-xs flex items-center gap-1">
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
                ) : (
                    <div className="col-span-1 md:col-span-3 lg:col-span-4">
                        <UrlCleaner />
                    </div>
                )}
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
                                    <div key={run.filename} className="bg-zinc-900/50 border border-zinc-800/50 p-4 rounded-xl flex items-center justify-between gap-3 hover:bg-zinc-800/30 transition-colors">
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm text-white font-medium truncate">{run.filename}</p>
                                            <div className="flex items-center gap-3 mt-1">
                                                <span className="text-[10px] text-zinc-500 flex items-center gap-1">
                                                    <Clock className="w-3 h-3" />
                                                    {new Date(run.savedAt).toLocaleString()}
                                                </span>
                                                <span className="text-[10px] text-emerald-500">{run.qualifiedCount} qualified</span>
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
