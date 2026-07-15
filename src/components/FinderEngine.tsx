"use client";

import React, { useState, useRef } from "react";
import { Radar, Search, MessageCircle, Play, Loader2, Copy, AlertCircle, Upload, CheckCircle, StopCircle, Download } from "lucide-react";
import { cn } from "@/lib/utils";
import Papa from "papaparse";

export default function FinderEngine() {
    // Discovery State
    const [niches, setNiches] = useState<string[]>(['Coach']);
    const [locations, setLocations] = useState<string[]>(['US']);
    const [target, setTarget] = useState(200);
    const [nicheInput, setNicheInput] = useState('');
    const [locInput, setLocInput] = useState('');
    const [discovering, setDiscovering] = useState(false);
    const [discoveryStatus, setDiscoveryStatus] = useState('');
    
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
                body: JSON.stringify({ job_titles: niches, locations, max_urls_target: target })
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            setDiscoveryStatus('Discovery launched. The background worker is running. Check queue-results folder.');
        } catch (e: any) {
            setDiscoveryStatus(`Error: ${e.message}`);
        } finally {
            setDiscovering(false);
        }
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

                    <button 
                        onClick={handleDiscover}
                        disabled={discovering || niches.length === 0 || locations.length === 0}
                        className="w-full py-3 bg-blue-600 hover:bg-blue-500 text-white rounded-xl font-medium flex items-center justify-center gap-2 transition-colors disabled:opacity-50"
                    >
                        {discovering ? <Loader2 className="w-5 h-5 animate-spin" /> : <Play className="w-5 h-5 fill-current" />}
                        {discovering ? 'Launching Discovery...' : 'Start Discovery Engine'}
                    </button>

                    {discoveryStatus && (
                        <div className="p-4 bg-black border border-zinc-800 rounded-xl text-sm font-mono text-zinc-400">
                            &gt; {discoveryStatus}
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
