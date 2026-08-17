"use client";

import React, { useState, useRef } from "react";
import { Radar, Search, MessageCircle, Play, Loader2, Copy, AlertCircle, Upload, CheckCircle, StopCircle, Download } from "lucide-react";
import { cn } from "@/lib/utils";
import Papa from "papaparse";

export default function FinderEngine({ onPushToEngine }: { onPushToEngine?: (urls: string[]) => void }) {
    // Discovery State
    const [niches, setNiches] = useState<string[]>(['Coach']);
    const [locations, setLocations] = useState<string[]>(['US']);
    const [target, setTarget] = useState(200);
    const [maxPages, setMaxPages] = useState(20);
    const [nicheInput, setNicheInput] = useState('');
    const [locInput, setLocInput] = useState('');
    const [discovering, setDiscovering] = useState(false);
    const [discoveryStatus, setDiscoveryStatus] = useState('');
    const [discoveryJobId, setDiscoveryJobId] = useState<string | null>(null);
    const [discoveryProgress, setDiscoveryProgress] = useState<any>(null);
    
    // Auto-reconnect to running job on mount
    React.useEffect(() => {
        const savedJobId = localStorage.getItem('leadFinderJobId');
        if (savedJobId) {
            setDiscoveryJobId(savedJobId);
            setDiscovering(true);
            setDiscoveryStatus('Reconnecting to background discovery task...');
            pollDiscoveryStatus(savedJobId);
        }
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
        if (niches.length === 0 || locations.length === 0) return;
        setDiscovering(true);
        setDiscoveryStatus('Starting Dork Engine...');
        try {
            const res = await fetch('/api/find-leads', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ job_titles: niches, locations, max_urls_target: target, max_pages_per_dork: maxPages })
            });
            const data = await res.json();
            setDiscoveryJobId(data.jobId);
            localStorage.setItem('leadFinderJobId', data.jobId);
            setDiscoveryStatus('Discovery launched. The background worker is running. Leads are saving to the CRM live!');
            pollDiscoveryStatus(data.jobId);
        } catch (e: any) {
            setDiscoveryStatus(`Error: ${e.message}`);
            setDiscovering(false);
        }
    };

    const pollDiscoveryStatus = async (jobId: string) => {
        try {
            const res = await fetch(`/api/find-leads/status?jobId=${jobId}`);
            const data = await res.json();
            
            if (data && data.status) {
                setDiscoveryProgress(data);
                if (data.status === 'running') {
                    setTimeout(() => pollDiscoveryStatus(jobId), 3000);
                } else if (data.status === 'done') {
                    setDiscoveryStatus(`Discovery completed. Found ${data.found} leads.`);
                    setDiscovering(false);
                    localStorage.removeItem('leadFinderJobId');
                } else if (data.status === 'error') {
                    setDiscoveryStatus(`Discovery failed: ${data.error}`);
                    setDiscovering(false);
                    localStorage.removeItem('leadFinderJobId');
                } else {
                    setTimeout(() => pollDiscoveryStatus(jobId), 3000);
                }
            } else {
                setTimeout(() => pollDiscoveryStatus(jobId), 3000);
            }
        } catch (e) {
            setTimeout(() => pollDiscoveryStatus(jobId), 5000);
        }
    };

    const downloadDiscoveryCSV = () => {
        if (!discoveryProgress || !discoveryProgress.leads || discoveryProgress.leads.length === 0) return;
        const csvContent = "data:text/csv;charset=utf-8," 
            + "LinkedIn URL,Location\n"
            + discoveryProgress.leads.map((l: any) => `${l.url},${l.location}`).join("\n");
        const encodedUri = encodeURI(csvContent);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", `Leads_Discovery_${new Date().getTime()}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
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

    return (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 w-full max-w-7xl mx-auto p-4 pt-0">
            {/* LEAD FINDER */}
            <div className="bg-[#111] border border-zinc-800 rounded-2xl p-6">
                <div className="flex items-center gap-3 mb-6 pb-4 border-b border-zinc-800/50">
                    <Radar className="w-5 h-5 text-blue-500" />
                    <h2 className="text-xl font-semibold">Lead Discovery Engine</h2>
                </div>

                <div className="space-y-6">
                    <div>
                        <label className="block text-sm text-zinc-400 mb-2">Job Titles / Niches</label>
                        <div className="flex flex-wrap gap-2 mb-2">
                            {niches.map(n => (
                                <span key={n} className="px-3 py-1 bg-blue-500/10 text-blue-400 border border-blue-500/20 rounded-full text-sm flex items-center gap-2">
                                    {n}
                                    <button onClick={() => setNiches(niches.filter(x => x !== n))} className="hover:text-blue-200">×</button>
                                </span>
                            ))}
                        </div>
                        <input 
                            value={nicheInput} onChange={e => setNicheInput(e.target.value)} onKeyDown={handleAddNiche}
                            placeholder="Type niche and press Enter..."
                            className="w-full bg-black border border-zinc-800 rounded-xl px-4 py-2 focus:outline-none focus:border-blue-500/50"
                        />
                    </div>

                    <div>
                        <label className="block text-sm text-zinc-400 mb-2">Locations</label>
                        <div className="flex flex-wrap gap-2 mb-2">
                            {locations.map(l => (
                                <span key={l} className="px-3 py-1 bg-accent/10 text-accent border border-accent/20 rounded-full text-sm flex items-center gap-2">
                                    {l}
                                    <button onClick={() => setLocations(locations.filter(x => x !== l))} className="hover:text-accent">×</button>
                                </span>
                            ))}
                        </div>
                        <input 
                            value={locInput} onChange={e => setLocInput(e.target.value)} onKeyDown={handleAddLoc}
                            placeholder="Type location and press Enter..."
                            className="w-full bg-black border border-zinc-800 rounded-xl px-4 py-2 focus:outline-none focus:border-accent/50"
                        />
                    </div>

                    <div>
                        <label className="block text-sm text-zinc-400 mb-2">Target Volume</label>
                        <input 
                            type="number" value={target} onChange={e => setTarget(parseInt(e.target.value))}
                            className="w-full bg-black border border-zinc-800 rounded-xl px-4 py-2 focus:outline-none focus:border-zinc-700"
                        />
                    </div>

                    <div>
                        <label className="block text-sm text-zinc-400 mb-2">Max Pages per Query (Depth)</label>
                        <input 
                            type="number" value={maxPages} onChange={e => setMaxPages(parseInt(e.target.value))}
                            className="w-full bg-black border border-zinc-800 rounded-xl px-4 py-2 focus:outline-none focus:border-zinc-700"
                        />
                    </div>

                    <button 
                        onClick={handleDiscover}
                        disabled={discovering || niches.length === 0 || locations.length === 0}
                        className="w-full py-3 bg-blue-600 hover:bg-blue-500 text-white rounded-xl font-medium flex items-center justify-center gap-2 transition-colors disabled:opacity-50"
                    >
                        {discovering ? <Loader2 className="w-5 h-5 animate-spin" /> : <Play className="w-5 h-5 fill-current" />}
                        {discovering ? 'Launching Discovery...' : 'Start Discovery Engine'}
                    </button>

                    {discoveryStatus && (
                        <div className="p-4 bg-black border border-zinc-800 rounded-xl text-sm font-mono text-zinc-400 space-y-2">
                            <div>&gt; {discoveryStatus}</div>
                            {discoveryProgress && (
                                <div className="mt-4 p-3 bg-zinc-900 rounded-lg border border-zinc-800">
                                    <div className="flex justify-between items-center mb-2">
                                        <span className="text-zinc-300">Progress:</span>
                                        <span className="text-blue-400 font-bold">{discoveryProgress.found} Leads Found</span>
                                    </div>
                                    {discoveryProgress.status === 'running' && discoveryProgress.totalQueries > 0 && (
                                        <div className="text-xs text-zinc-500 mb-2">
                                            Currently querying: <span className="text-zinc-300">{discoveryProgress.currentQuery}</span>
                                        </div>
                                    )}
                                    {discoveryProgress.results && discoveryProgress.results.length > 0 && (
                                        <div className="mt-3 max-h-32 overflow-y-auto space-y-1">
                                            {discoveryProgress.results.map((r: any, idx: number) => (
                                                <div key={idx} className="text-xs flex gap-2">
                                                    <span className="text-zinc-500">[{r.location}]</span>
                                                    <a href={r.url} target="_blank" className="text-zinc-300 hover:text-white truncate">{r.url}</a>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                    <div className="mt-4 border-t border-zinc-800 pt-3 flex gap-2">
                                        <button 
                                            onClick={downloadDiscoveryCSV}
                                            className="px-4 py-2 bg-zinc-800 text-white rounded-xl text-sm hover:bg-zinc-700 transition-colors flex items-center gap-2"
                                        >
                                            <Download className="w-4 h-4" /> Export CSV
                                        </button>
                                        {onPushToEngine && (
                                            <button 
                                                onClick={() => {
                                                    const urls = discoveryProgress.results.map((r: any) => r.url).filter(Boolean);
                                                    onPushToEngine(urls);
                                                }}
                                                className="px-4 py-2 bg-blue-500/20 text-blue-400 border border-blue-500/30 rounded-xl text-sm hover:bg-blue-500/30 transition-colors flex items-center gap-2"
                                            >
                                                <Radar className="w-4 h-4" /> Process in Engine
                                            </button>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>

            {/* HOOK GENERATOR */}
            <div className="bg-[#111] border border-zinc-800 rounded-2xl p-6 h-fit">
                <div className="flex items-center justify-between mb-6 pb-4 border-b border-zinc-800/50">
                    <div className="flex items-center gap-3">
                        <MessageCircle className="w-5 h-5 text-purple-500" />
                        <h2 className="text-xl font-semibold">Hook Generator</h2>
                    </div>
                    <div className="flex bg-black rounded-lg p-1 border border-zinc-800">
                        <button onClick={() => setBulkMode(false)} className={cn("px-3 py-1 text-sm rounded-md transition-all", !bulkMode ? "bg-zinc-800 text-white" : "text-zinc-500 hover:text-zinc-300")}>Single</button>
                        <button onClick={() => setBulkMode(true)} className={cn("px-3 py-1 text-sm rounded-md transition-all", bulkMode ? "bg-zinc-800 text-white" : "text-zinc-500 hover:text-zinc-300")}>Bulk</button>
                    </div>
                </div>

                {!bulkMode ? (
                    <div className="space-y-6">
                        <div>
                            <label className="block text-sm text-zinc-400 mb-2">Target Website URL</label>
                            <input 
                                value={websiteUrl} onChange={e => setWebsiteUrl(e.target.value)}
                                placeholder="https://their-website.com"
                                className="w-full bg-black border border-zinc-800 rounded-xl px-4 py-3 focus:outline-none focus:border-purple-500/50"
                            />
                        </div>

                        <button 
                            onClick={handleGenerateHook}
                            disabled={generating || !websiteUrl}
                            className="w-full py-3 bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700 rounded-xl font-medium flex items-center justify-center gap-2 transition-colors disabled:opacity-50"
                        >
                            {generating ? <Loader2 className="w-5 h-5 animate-spin" /> : <Search className="w-5 h-5" />}
                            Generate Hook
                        </button>

                        {hookResult && !hookResult.error && (
                            <div className="p-5 bg-black border border-zinc-800 rounded-xl space-y-4">
                                <div className="flex justify-between items-start">
                                    <div className="text-sm font-medium text-purple-400">Generated Hook</div>
                                    <button onClick={() => navigator.clipboard.writeText(hookResult.hook)} className="text-zinc-500 hover:text-white"><Copy className="w-4 h-4" /></button>
                                </div>
                                <p className="text-zinc-100 font-medium">"{hookResult.hook}"</p>
                            </div>
                        )}

                        {hookResult?.error && (
                            <div className="p-4 bg-red-500/10 border border-red-500/20 text-red-400 rounded-xl text-sm flex gap-3">
                                <AlertCircle className="w-5 h-5 flex-shrink-0" />
                                {hookResult.error}
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="space-y-6">
                        <div className="p-6 border-2 border-dashed border-zinc-800 rounded-xl flex flex-col items-center justify-center bg-black/50">
                            <Upload className="w-8 h-8 text-zinc-500 mb-3" />
                            <input type="file" accept=".csv" onChange={handleBulkFile} className="mb-2 w-full max-w-[250px] text-sm text-zinc-400 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-zinc-800 file:text-white hover:file:bg-zinc-700" />
                            <p className="text-xs text-zinc-600 mt-2">Requires a column named "URL" or "Website"</p>
                        </div>
                        
                        <div className="flex gap-4">
                            <div className="flex-1">
                                <label className="block text-xs text-zinc-500 mb-1">Start Row</label>
                                <input type="number" min="1" value={startRow} onChange={e => setStartRow(e.target.value === '' ? '' : parseInt(e.target.value))} className="w-full bg-black border border-zinc-800 rounded-xl px-3 py-2 text-sm focus:border-purple-500/50" />
                            </div>
                            <div className="flex-1">
                                <label className="block text-xs text-zinc-500 mb-1">End Row (Optional)</label>
                                <input type="number" min="1" value={endRow} onChange={e => setEndRow(e.target.value === '' ? '' : parseInt(e.target.value))} placeholder="All" className="w-full bg-black border border-zinc-800 rounded-xl px-3 py-2 text-sm focus:border-purple-500/50" />
                            </div>
                        </div>

                        {!isBulkProcessing ? (
                            <button 
                                onClick={runBulkHooks}
                                disabled={!csvFile}
                                className="w-full py-3 bg-purple-600/20 text-purple-400 hover:bg-purple-600/30 border border-purple-500/30 rounded-xl font-medium flex items-center justify-center gap-2 transition-colors disabled:opacity-50"
                            >
                                <Play className="w-5 h-5" />
                                Start Bulk Generation
                            </button>
                        ) : (
                            <div className="space-y-4">
                                <div className="flex items-center justify-between text-sm">
                                    <span className="text-purple-400 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin"/> Processing...</span>
                                    <span>{bulkProgress}%</span>
                                </div>
                                <div className="w-full bg-black/50 rounded-full h-2">
                                    <div className="bg-purple-500 h-2 rounded-full transition-all" style={{ width: `${bulkProgress}%` }}></div>
                                </div>
                                <button onClick={() => { cancelBulkRef.current = true; setIsBulkProcessing(false); }} className="w-full py-2 bg-red-500/10 text-red-400 rounded-xl flex items-center justify-center gap-2 text-sm">
                                    <StopCircle className="w-4 h-4" /> Cancel Run
                                </button>
                            </div>
                        )}

                        {bulkResults.length > 0 && !isBulkProcessing && (
                            <div className="p-4 bg-accent/10 border border-accent/20 rounded-xl flex items-center justify-between">
                                <span className="text-accent text-sm flex items-center gap-2"><CheckCircle className="w-4 h-4"/> Finished {bulkResults.length} hooks</span>
                                <button onClick={downloadBulkCSV} className="px-3 py-1.5 bg-accent/20 text-accent rounded-lg text-sm flex items-center gap-2 hover:bg-accent/30">
                                    <Download className="w-4 h-4" /> Download
                                </button>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
