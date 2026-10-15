"use client";
import { AI_HOOK_GENERATION_ENABLED } from "@/lib/hook-settings";

import React, { useState, useRef } from "react";
import { Radar, Search, MessageCircle, Play, Loader2, Copy, AlertCircle, Upload, StopCircle, Download } from "lucide-react";
import { cn } from "@/lib/utils";
import Papa from "papaparse";

export default function FinderEngine({ onPushToEngine }: { onPushToEngine?: (urls: string[]) => void }) {
    // Discovery State
    const [niches, setNiches] = useState<string[]>(['Executive Coach', 'Career Coach', 'Business Coach']);
    const [locations, setLocations] = useState<string[]>(['US', 'UK', 'Canada']);
    const [target, setTarget] = useState(200);
    // Google's index for one dork runs out around page 3-5; deeper paging mostly
    // re-serves profiles already seen and costs a Serper credit each time.
    const [maxPages, setMaxPages] = useState(4);
    // Rows below this fit score are not written at all. 20 admits "matched a role
    // word and nothing else"; raising it trades volume for precision, and because
    // the score is stored, the real selectivity is the queue order, not this.
    const [minFitScore, setMinFitScore] = useState(20);
    const [cancelling, setCancelling] = useState(false);
    const [nicheInput, setNicheInput] = useState('');
    const [locInput, setLocInput] = useState('');
    const [discovering, setDiscovering] = useState(false);
    const [discoveryStatus, setDiscoveryStatus] = useState('');
    const [discoveryError, setDiscoveryError] = useState('');
    const [discoveryJobId, setDiscoveryJobId] = useState<string | null>(null);
    const [discoveryProgress, setDiscoveryProgress] = useState<any>(null);
    const keptTarget = discoveryProgress?.target;
    const hasKeptTarget = Number.isSafeInteger(keptTarget) && keptTarget > 0;
    const launchingRef = useRef(false);
    const pollingGenerationRef = useRef(0);
    const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    
    // Auto-reconnect to running job on mount
    React.useEffect(() => {
        const generation = ++pollingGenerationRef.current;
        let savedJobId: string | null = null;
        try { savedJobId = localStorage.getItem('leadFinderJobId'); } catch { /* Storage is optional. */ }
        if (savedJobId) {
            setDiscoveryJobId(savedJobId);
            setDiscovering(true);
            setDiscoveryStatus('Reconnecting to background discovery task...');
            pollDiscoveryStatus(savedJobId, true, generation);
        }
        return () => {
            pollingGenerationRef.current++;
            if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
        };
    }, []);

    // Single Hook State
    const [websiteUrl, setWebsiteUrl] = useState('');
    const [generating, setGenerating] = useState(false);
    const [hookResult, setHookResult] = useState<any>(null);

    // Bulk Hook State
    const [bulkMode, setBulkMode] = useState(false);
    const [csvFile, setCsvFile] = useState<File | null>(null);
    const [startRow, setStartRow] = useState<number | string>(1);
    const [endRow, setEndRow] = useState<number | string>('');
    const [bulkResults, setBulkResults] = useState<{url: string, hook: string, status: string}[]>([]);
    const [bulkProgress, setBulkProgress] = useState(0);
    const [isBulkProcessing, setIsBulkProcessing] = useState(false);
    const cancelBulkRef = useRef(false);

    // Discovery Handlers
    const handleAddNiche = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && nicheInput.trim()) {
            if (!niches.includes(nicheInput.trim())) setNiches([...niches, nicheInput.trim()]);
            setNicheInput('');
        }
    };

    const handleAddLoc = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && locInput.trim()) {
            if (!locations.includes(locInput.trim())) setLocations([...locations, locInput.trim()]);
            setLocInput('');
        }
    };

    const handleDiscover = async () => {
        if (launchingRef.current || discovering) return;
        if (niches.length === 0 || locations.length === 0) return;
        if (!Number.isSafeInteger(target) || target < 1) {
            setDiscoveryError('Enter a positive whole number for the kept leads target.');
            return;
        }
        launchingRef.current = true;
        const generation = ++pollingGenerationRef.current;
        if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
        setDiscovering(true);
        setDiscoveryError('');
        setDiscoveryJobId(null);
        setCancelling(false);
        setDiscoveryProgress(null);
        setDiscoveryStatus('Starting Dork Engine...');
        try {
            const res = await fetch('/api/find-leads', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    job_titles: niches, locations,
                    kept_leads_target: target, max_pages_per_dork: maxPages,
                    min_fit_score: minFitScore,
                })
            });
            const data = await res.json().catch(() => ({ error: `The server returned an unreadable response (HTTP ${res.status}).` }));
            if (!res.ok || data.error) throw new Error(data.error || `Search could not start (HTTP ${res.status}).`);
            if (typeof data.jobId !== 'string') throw new Error('The server did not return a search job. Try again.');
            try { localStorage.setItem('leadFinderJobId', data.jobId); } catch { /* Do not stop an accepted search when storage is unavailable. */ }
            if (generation !== pollingGenerationRef.current) return;
            setDiscoveryJobId(data.jobId);
            setDiscoveryStatus(`Searching for ${(data.target ?? target).toLocaleString()} kept leads. Country searches expand into states and provinces when needed. Leads save to the CRM live.`);
            pollDiscoveryStatus(data.jobId, false, generation);
        } catch (e: any) {
            if (generation !== pollingGenerationRef.current) return;
            setDiscoveryError(`Search could not start: ${e.message}`);
            setDiscoveryStatus('');
            setDiscovering(false);
        } finally {
            launchingRef.current = false;
        }
    };

    /**
     * Stops a running discovery. Previously the only way to stop one was to kill the
     * process — the engine had no cancel path at all, so a mis-typed niche burned the
     * whole Serper budget for the run.
     */
    const handleCancelDiscovery = async () => {
        if (!discoveryJobId) return;
        setCancelling(true);
        try {
            const response = await fetch(`/api/find-leads?jobId=${encodeURIComponent(discoveryJobId)}`, { method: 'DELETE' });
            if (!response.ok) throw new Error(`The server returned HTTP ${response.status}.`);
            setDiscoveryStatus('Cancelling — the engine stops after the page in flight.');
        } catch (e: any) {
            setDiscoveryError(`Cancel failed: ${e.message}`);
            setCancelling(false);
        }
    };

    const pollDiscoveryStatus = async (jobId: string, restoreSettings = false, generation = pollingGenerationRef.current) => {
        if (generation !== pollingGenerationRef.current) return;
        const schedule = (delay: number) => {
            pollTimerRef.current = setTimeout(() => pollDiscoveryStatus(jobId, false, generation), delay);
        };
        const clearSavedJob = () => {
            try { localStorage.removeItem('leadFinderJobId'); } catch { /* Storage is optional. */ }
            setDiscoveryJobId(null);
        };
        try {
            const res = await fetch(`/api/find-leads/status?jobId=${encodeURIComponent(jobId)}`);
            const data = await res.json();
            if (generation !== pollingGenerationRef.current) return;
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
            
            if (data && data.status) {
                setDiscoveryProgress(data);
                if (restoreSettings && data.config) {
                    if (Array.isArray(data.config.job_titles)) setNiches(data.config.job_titles);
                    if (Array.isArray(data.config.locations)) setLocations(data.config.locations);
                    if (Number.isSafeInteger(data.target) && data.target > 0) setTarget(data.target);
                    if (Number.isSafeInteger(data.config.max_pages_per_dork)) setMaxPages(data.config.max_pages_per_dork);
                    if (typeof data.config.min_fit_score === 'number') setMinFitScore(data.config.min_fit_score);
                }
                if (data.status === 'running') {
                    setDiscoveryError('');
                    schedule(3000);
                } else if (data.status === 'done' || data.status === 'cancelled') {
                    // "Found 180" on its own says nothing about whether the floor is
                    // set right; the denominator is what makes it actionable.
                    const verb = data.status === 'cancelled' ? 'Stopped'
                        : data.stopReason === 'search_exhausted' ? 'Available searches exhausted'
                        : data.targetReached ? 'Kept target reached' : 'Available searches finished';
                    setDiscoveryStatus(
                        `${verb}. Kept ${(data.found ?? 0).toLocaleString()}${data.target ? ` / ${data.target.toLocaleString()}` : ''}, scored ${data.scored ?? 0}, ` +
                        `rejected ${data.rejected ?? 0} · ${data.creditsSpent ?? 0} Serper credits.`
                    );
                    setDiscovering(false);
                    setDiscoveryError('');
                    setCancelling(false);
                    clearSavedJob();
                } else if (data.status === 'error') {
                    setDiscoveryError(`Search stopped: ${data.error || 'The search could not continue.'}`);
                    setDiscoveryStatus('');
                    setDiscovering(false);
                    setCancelling(false);
                    clearSavedJob();
                } else if (data.status === 'unknown') {
                    setDiscoveryError('The saved search could not be found. You can start a new search.');
                    setDiscoveryStatus('');
                    setDiscovering(false);
                    setCancelling(false);
                    clearSavedJob();
                } else {
                    schedule(3000);
                }
            } else {
                throw new Error('The server did not return a search status.');
            }
        } catch (e) {
            if (generation !== pollingGenerationRef.current) return;
            setDiscoveryError('Could not read the search status. Retrying automatically.');
            schedule(5000);
        }
    };

    const downloadDiscoveryCSV = () => {
        // The progress file writes `results`, never `leads` — reading the wrong key
        // made this button a silent no-op on every run since it was added.
        const rows = discoveryProgress?.results;
        if (!rows || rows.length === 0) return;
        // Provenance travels with the export, so a spot-check outside the app can
        // still answer "which dork found this, and why did it score that?".
        const csv = Papa.unparse(rows.map((l: any) => ({
            linkedin_url: l.url,
            location: l.location,
            fit_score: l.fitScore ?? '',
            reasons: (l.fitReasons || []).map((r: any) => `${r.id}:${r.w}`).join(' '),
            template_id: l.templateId ?? '',
            niche: l.niche ?? '',
            page: l.page ?? '',
            rank: l.rank ?? '',
            headline: l.title ?? '',
        })));
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `Leads_Discovery_${new Date().getTime()}.csv`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    };

    // Single Hook Handler
    const handleGenerateHook = async () => {
        if (!websiteUrl) return;
        setGenerating(true);
        setHookResult(null);
        try {
            const res = await fetch('/api/generate-hook', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ websiteText: `Target URL: ${websiteUrl}. Generate a hook.` })
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            setHookResult(data.result);
        } catch (e: any) {
            setHookResult({ error: e.message });
        } finally {
            setGenerating(false);
        }
    };

    // Bulk Hook Handlers
    const handleBulkFile = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files[0]) {
            setCsvFile(e.target.files[0]);
        }
    };

    const runBulkHooks = () => {
        if (!csvFile) return;
        cancelBulkRef.current = false;
        setIsBulkProcessing(true);
        setBulkResults([]);
        setBulkProgress(0);

        Papa.parse(csvFile, {
            header: true,
            skipEmptyLines: true,
            complete: async (results) => {
                const headers = results.meta.fields?.map(h => h.toLowerCase().trim()) || [];
                const urlCol = results.meta.fields?.find((_, i) => ['url', 'website', 'domain', 'link'].includes(headers[i]));
                
                if (!urlCol) {
                    alert("No 'URL' or 'Website' column found in CSV.");
                    setIsBulkProcessing(false);
                    return;
                }

                const rows = results.data as any[];
                let startIdx = Math.max(0, (typeof startRow === 'number' ? startRow : parseInt(startRow) || 1) - 1);
                let endIdx = endRow ? Math.min(rows.length, typeof endRow === 'number' ? endRow : parseInt(endRow)) : rows.length;
                
                const targetRows = rows.slice(startIdx, endIdx);
                const resultsArr: {url: string, hook: string, status: string}[] = [];

                for (let i = 0; i < targetRows.length; i++) {
                    if (cancelBulkRef.current) break;
                    
                    const url = targetRows[i][urlCol];
                    if (!url) {
                        setBulkProgress(Math.floor(((i + 1) / targetRows.length) * 100));
                        continue;
                    }

                    try {
                        const res = await fetch('/api/generate-hook', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ websiteText: `Target URL: ${url}. Generate a hook.` })
                        });
                        const data = await res.json();
                        if (data.error) throw new Error(data.error);
                        
                        resultsArr.push({ url, hook: data.result.hook, status: 'Success' });
                    } catch (e: any) {
                        resultsArr.push({ url, hook: '', status: `Error: ${e.message}` });
                    }
                    
                    setBulkResults([...resultsArr]);
                    setBulkProgress(Math.floor(((i + 1) / targetRows.length) * 100));
                }
                
                setIsBulkProcessing(false);
            }
        });
    };

    const downloadBulkCSV = () => {
        const csv = Papa.unparse(bulkResults);
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `Bulk_Hooks_${new Date().getTime()}.csv`;
        a.click();
    };

    /*
     * A one-word niche can never earn the exact-phrase weight, because the scorer
     * skips a single-word phrase that is also a role stem ("coach" appears in half
     * of LinkedIn). It also stays low-confidence, which leaves the employer-shape
     * penalty switched on. The same profile therefore scores up to 25 points lower
     * under "Coach" than under "Business Coach" — against an observed ceiling
     * around 55, that is the difference between a usable ranking and a flat one.
     * Saying so at the input is the only place it can change the outcome.
     */
    const weakNiches = niches.filter(n => n.trim().split(/\s+/).length === 1);

    return (
        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4 items-start">
            {/* ── Search ─────────────────────────────────────────────────── */}
            <section className="panel">
                <div className="panel-head">
                    <Radar className="w-3.5 h-3.5 text-[var(--text-faint)]" />
                    Search
                    <span className="hint">Google, not LinkedIn</span>
                </div>

                <div className="panel-body space-y-4">
                    <div>
                        <label className="field-label" htmlFor="finder-niche">Niche</label>
                        <div className="flex flex-wrap gap-1.5 mb-3" aria-label="Coaching search presets">
                            {[
                                { label: 'All three segments', titles: ['Executive Coach', 'Career Coach', 'Business Coach'] },
                                { label: 'Executive', titles: ['Executive Coach', 'Leadership Coach'] },
                                { label: 'Career', titles: ['Career Coach', 'Career Transition Coach'] },
                                { label: 'Business', titles: ['Business Coach', 'Entrepreneur Coach'] },
                            ].map(preset => <button key={preset.label} className="btn btn-ghost !text-xs" disabled={discovering} onClick={() => setNiches(preset.titles)}>{preset.label}</button>)}
                        </div>
                        {niches.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 mb-2">
                                {niches.map(n => (
                                    <span key={n} className="badge badge-idle !text-[11px] !py-1 !px-2 gap-1.5">
                                        {n}
                                        <button
                                            onClick={() => setNiches(niches.filter(x => x !== n))}
                                            className="text-[var(--text-faint)] hover:text-[var(--text)] transition-colors"
                                            aria-label={`Remove ${n}`}
                                        >×</button>
                                    </span>
                                ))}
                            </div>
                        )}
                        <input
                            id="finder-niche"
                            value={nicheInput} onChange={e => setNicheInput(e.target.value)} onKeyDown={handleAddNiche}
                            placeholder="Business Coach — then press Enter"
                            className="field w-full"
                        />
                        {weakNiches.length > 0 ? (
                            <p className="field-hint !text-[var(--warn)]">
                                {weakNiches.map(n => `"${n}"`).join(', ')} {weakNiches.length === 1 ? 'is' : 'are'} a single word.
                                Two words score the same person up to 25 points higher and make the ranking
                                usable — try &ldquo;Business Coach&rdquo; or &ldquo;Executive Coach&rdquo;.
                            </p>
                        ) : (
                            <p className="field-hint">Search results are candidates. Independent ownership, a paid offer and client evidence are checked during qualification.</p>
                        )}
                    </div>

                    <div>
                        <label className="field-label" htmlFor="finder-loc">Location</label>
                        {locations.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 mb-2">
                                {locations.map(l => (
                                    <span key={l} className="badge badge-idle !text-[11px] !py-1 !px-2 gap-1.5">
                                        {l}
                                        <button
                                            onClick={() => setLocations(locations.filter(x => x !== l))}
                                            className="text-[var(--text-faint)] hover:text-[var(--text)] transition-colors"
                                            aria-label={`Remove ${l}`}
                                        >×</button>
                                    </span>
                                ))}
                            </div>
                        )}
                        <input
                            id="finder-loc"
                            value={locInput} onChange={e => setLocInput(e.target.value)} onKeyDown={handleAddLoc}
                            placeholder="US — then press Enter"
                            className="field w-full"
                        />
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div>
                            <label className="field-label" htmlFor="finder-target">Kept leads target</label>
                            <input
                                id="finder-target"
                                type="number" min="1" step="1" value={target} onChange={e => setTarget(parseInt(e.target.value) || 0)}
                                className="field w-full num"
                            />
                        </div>
                        <div>
                            <label className="field-label" htmlFor="finder-pages">Pages per query</label>
                            <input
                                id="finder-pages"
                                type="number" min="1" max="10" value={maxPages} onChange={e => setMaxPages(parseInt(e.target.value) || 1)}
                                className="field w-full num"
                            />
                        </div>
                        <div>
                            <label className="field-label" htmlFor="finder-floor">Min score</label>
                            <input
                                id="finder-floor"
                                type="number" min="0" max="100" value={minFitScore} onChange={e => setMinFitScore(parseInt(e.target.value) || 0)}
                                className="field w-full num"
                            />
                        </div>
                    </div>
                    <p className="field-hint !mt-0">
                        The target counts unique kept profiles after scoring. Rejected profiles and
                        repeated results do not count. Each query uses your page limit; US and Canada
                        searches expand into states and provinces if needed. Profiles below the minimum
                        score are not kept. Expansion uses additional search credits.
                    </p>

                    {discoveryError && (
                        <div role="alert" className="flex items-start gap-2 rounded-lg border border-[var(--bad)] bg-[var(--bad-dim)] p-3 text-sm text-[var(--bad)]">
                            <AlertCircle className="w-4 h-4 flex-none mt-0.5" />
                            <span className="break-words">{discoveryError}</span>
                        </div>
                    )}
                    {!discovering ? (
                        <button
                            onClick={handleDiscover}
                            disabled={niches.length === 0 || locations.length === 0 || !Number.isSafeInteger(target) || target < 1}
                            className="btn btn-primary btn-lg w-full"
                        >
                            <Play className="w-3.5 h-3.5" />
                            Start searching
                        </button>
                    ) : (
                        <div className="flex gap-2">
                            <div className="btn btn-outline btn-lg flex-1 !cursor-default">
                                <Loader2 className="w-3.5 h-3.5 animate-spin" /> {discoveryJobId ? 'Searching' : 'Starting…'}
                            </div>
                            <button
                                onClick={handleCancelDiscovery}
                                disabled={cancelling || !discoveryJobId}
                                className="btn btn-danger btn-lg"
                            >
                                <StopCircle className="w-3.5 h-3.5" /> {cancelling ? 'Stopping' : 'Stop'}
                            </button>
                        </div>
                    )}
                </div>

                {discoveryStatus && (
                    <div className="panel-note !text-[var(--text-dim)]">{discoveryStatus}</div>
                )}
            </section>

            {/* ── Progress ───────────────────────────────────────────────── */}
            {discoveryProgress && (
                <section className={cn("panel", discovering && "rail-live")}>
                    <div className="panel-head">
                        Found so far
                        {discovering && (
                            <span className="hint flex items-center gap-1.5">
                                <span className="dot-live" aria-hidden />
                                Running
                            </span>
                        )}
                    </div>

                    <div className="panel-body space-y-4">
                        {/* Kept, scored and rejected together. "Found 180" on its own
                            can't tell you whether the score floor is doing anything. */}
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                            <div>
                                <p className="num text-[20px] text-[var(--signal)]">{discoveryProgress.found ?? 0}</p>
                                <p className="label-micro mt-1">Kept</p>
                                {hasKeptTarget && <p className="text-[11.5px] text-[var(--text-faint)] mt-1 num">of {keptTarget.toLocaleString()}</p>}
                            </div>
                            <div>
                                <p className="num text-[20px] text-[var(--text)]">{discoveryProgress.scored ?? 0}</p>
                                <p className="label-micro mt-1">Scored</p>
                            </div>
                            <div>
                                <p className="num text-[20px] text-[var(--text-dim)]">{discoveryProgress.rejected ?? 0}</p>
                                <p className="label-micro mt-1">Rejected</p>
                            </div>
                            <div>
                                <p className="num text-[20px] text-[var(--warn)]">{discoveryProgress.creditsSpent ?? 0}</p>
                                <p className="label-micro mt-1">Credits</p>
                            </div>
                        </div>

                        {hasKeptTarget && (
                            <div>
                                <div className="bar-track">
                                    <div
                                        className="bar-fill"
                                        style={{ width: `${Math.min(100, Math.round(((discoveryProgress.found ?? 0) / keptTarget) * 100))}%` }}
                                    />
                                </div>
                                <p className="text-[11.5px] text-[var(--text-dim)] mt-2 num">
                                    {(discoveryProgress.found ?? 0).toLocaleString()} of {keptTarget.toLocaleString()} kept
                                    {' · '}{Math.max(0, keptTarget - (discoveryProgress.found ?? 0)).toLocaleString()} remaining
                                </p>
                                {discoveryProgress.status === 'running' && (
                                    <p className="text-[11.5px] text-[var(--text-faint)] mt-1 break-words">
                                        {discoveryProgress.searchPhase === 'regional' ? 'Searching states and provinces' : 'Searching countries'}
                                        {discoveryProgress.searchArea && <> · {discoveryProgress.searchArea}</>}
                                        {' · Query '}<span className="num">{discoveryProgress.queryIndex ?? 0}</span>
                                        {' of up to '}<span className="num">{discoveryProgress.totalQueries}</span>
                                    </p>
                                )}
                                {discoveryProgress.stopReason === 'search_exhausted' && <p className="text-[11.5px] text-[var(--warn)] mt-1">Available searches exhausted before reaching the kept target.</p>}
                            </div>
                        )}

                        {discoveryProgress.results && discoveryProgress.results.length > 0 && (
                            <div className="max-h-56 overflow-y-auto -mx-1 px-1">
                                {discoveryProgress.results.slice(0, 50).map((r: any, idx: number) => (
                                    <div key={idx} className="flex gap-2.5 items-center py-1 text-[12px]">
                                        <span
                                            className={cn(
                                                "num w-6 text-right font-semibold flex-none",
                                                (r.fitScore ?? 0) >= 45 ? "text-[var(--signal)]"
                                                    : (r.fitScore ?? 0) >= 30 ? "text-[var(--text)]"
                                                        : "text-[var(--text-faint)]",
                                            )}
                                            title={(r.fitReasons || []).map((x: any) => `${x.id} ${x.w >= 0 ? '+' : ''}${x.w}${x.hit ? ` (${x.hit})` : ''}`).join('\n')}
                                        >
                                            {r.fitScore ?? '—'}
                                        </span>
                                        <span className="text-[var(--text-faint)] flex-none">{r.location}</span>
                                        <a
                                            href={r.url}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="text-[var(--text-dim)] hover:text-[var(--text)] transition-colors truncate"
                                        >
                                            {r.url.replace(/^https?:\/\/(www\.)?linkedin\.com\/in\//, '')}
                                        </a>
                                    </div>
                                ))}
                            </div>
                        )}

                        <div className="flex flex-wrap gap-2 pt-1">
                            <button onClick={downloadDiscoveryCSV} className="btn btn-outline">
                                <Download className="w-3.5 h-3.5" /> {['done', 'cancelled'].includes(discoveryProgress.status) ? 'Export all kept' : 'Export shown'}
                            </button>
                            {onPushToEngine && (
                                <button
                                    onClick={() => {
                                        const urls = discoveryProgress.results.map((r: any) => r.url).filter(Boolean);
                                        onPushToEngine(urls);
                                    }}
                                    className="btn btn-outline"
                                >
                                    <Radar className="w-3.5 h-3.5" /> Scrape these now
                                </button>
                            )}
                        </div>
                    </div>

                    <div className="panel-note">
                        Everything found is saved to Leads as it arrives — you don&apos;t have to
                        wait here or export anything.
                    </div>
                </section>
            )}

            {/* ── Opening lines ──────────────────────────────────────────── */}
            <section className={cn("panel", discoveryProgress && "xl:col-start-2")}>
                <div className="panel-head">
                    <MessageCircle className="w-3.5 h-3.5 text-[var(--text-faint)]" />
                    Opening lines
                    <div className="seg ml-auto">
                        <button onClick={() => setBulkMode(false)} className={cn("seg-item", !bulkMode && "seg-item-active")}>One</button>
                        <button onClick={() => setBulkMode(true)} className={cn("seg-item", bulkMode && "seg-item-active")}>Many</button>
                    </div>
                </div>

                {!bulkMode ? (
                    <div className="panel-body space-y-3">
                        <div>
                            <label className="field-label" htmlFor="hook-url">Their website</label>
                            <input
                                id="hook-url"
                                value={websiteUrl} onChange={e => setWebsiteUrl(e.target.value)}
                                placeholder="https://their-website.com"
                                className="field w-full"
                            />
                        </div>

                        <button
                            onClick={handleGenerateHook}
                            disabled={!AI_HOOK_GENERATION_ENABLED || generating || !websiteUrl}
                            className="btn btn-outline w-full"
                        >
                            {generating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                            {AI_HOOK_GENERATION_ENABLED ? 'Write an opening line' : 'AI hooks disabled'}
                        </button>

                        {hookResult && !hookResult.error && (
                            <div className="rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--surface-2)] p-4">
                                <div className="flex items-start justify-between gap-3">
                                    <p className="text-[14px] text-[var(--text)] leading-relaxed">&ldquo;{hookResult.hook}&rdquo;</p>
                                    <button
                                        onClick={() => navigator.clipboard.writeText(hookResult.hook)}
                                        className="btn btn-ghost !p-1.5 flex-none"
                                        title="Copy"
                                    >
                                        <Copy className="w-3.5 h-3.5" />
                                    </button>
                                </div>
                            </div>
                        )}

                        {hookResult?.error && (
                            <div className="rounded-[var(--radius-sm)] border border-[rgba(229,107,107,0.3)] bg-[var(--bad-dim)] p-3 flex gap-2.5 text-[12.5px] text-[var(--bad)]">
                                <AlertCircle className="w-4 h-4 flex-none mt-px" />
                                {hookResult.error}
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="panel-body space-y-3">
                        <div className="drop px-5 py-6 text-center">
                            <Upload className="w-5 h-5 text-[var(--text-faint)] mx-auto mb-2.5" />
                            <input
                                type="file"
                                accept=".csv"
                                onChange={handleBulkFile}
                                className="block mx-auto text-[12px] text-[var(--text-dim)] file:mr-3 file:py-1.5 file:px-3 file:rounded-[var(--radius-sm)] file:border file:border-[var(--line-strong)] file:text-[12px] file:font-medium file:bg-transparent file:text-[var(--text-dim)] file:cursor-pointer hover:file:bg-[var(--surface-3)]"
                            />
                            <p className="text-[11.5px] text-[var(--text-faint)] mt-2.5">
                                Needs a column called URL or Website
                            </p>
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className="field-label" htmlFor="bulk-start">From row</label>
                                <input
                                    id="bulk-start"
                                    type="number" min="1" value={startRow}
                                    onChange={e => setStartRow(e.target.value === '' ? '' : parseInt(e.target.value))}
                                    className="field w-full num"
                                />
                            </div>
                            <div>
                                <label className="field-label" htmlFor="bulk-end">To row</label>
                                <input
                                    id="bulk-end"
                                    type="number" min="1" value={endRow}
                                    onChange={e => setEndRow(e.target.value === '' ? '' : parseInt(e.target.value))}
                                    placeholder="All"
                                    className="field w-full num"
                                />
                            </div>
                        </div>

                        {!isBulkProcessing ? (
                            <button onClick={runBulkHooks} disabled={!AI_HOOK_GENERATION_ENABLED || !csvFile} title="AI hook generation is disabled" className="btn btn-outline w-full">
                                <Play className="w-3.5 h-3.5" />
                                Write them all
                            </button>
                        ) : (
                            <div className="space-y-2.5">
                                <div className="bar-track">
                                    <div className="bar-fill" style={{ width: `${bulkProgress}%` }} />
                                </div>
                                <div className="flex items-center justify-between text-[11.5px] text-[var(--text-faint)]">
                                    <span className="flex items-center gap-1.5">
                                        <Loader2 className="w-3 h-3 animate-spin" /> Writing
                                    </span>
                                    <span className="num">{bulkProgress}%</span>
                                </div>
                                <button
                                    onClick={() => { cancelBulkRef.current = true; setIsBulkProcessing(false); }}
                                    className="btn btn-danger w-full"
                                >
                                    <StopCircle className="w-3.5 h-3.5" /> Stop
                                </button>
                            </div>
                        )}

                        {bulkResults.length > 0 && !isBulkProcessing && (
                            <div className="flex items-center justify-between gap-3 pt-1">
                                <span className="mark mark-ok">
                                    <span className="num">{bulkResults.length}</span>&nbsp;written
                                </span>
                                <button onClick={downloadBulkCSV} className="btn btn-outline">
                                    <Download className="w-3.5 h-3.5" /> Download
                                </button>
                            </div>
                        )}
                    </div>
                )}
            </section>
        </div>
    );
}
