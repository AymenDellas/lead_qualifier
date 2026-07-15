"use client";

import React, { useState } from "react";
import { Upload, Database, Sheet, Loader2, CheckCircle, AlertCircle, ExternalLink } from "lucide-react";
import Papa from "papaparse";
import { exportToGoogleSheets } from "@/app/actions/google-sheets";
import { cn } from "@/lib/utils";

export default function CrmSync() {
    const [file, setFile] = useState<File | null>(null);
    const [syncing, setSyncing] = useState(false);
    const [result, setResult] = useState<{ success: boolean; url?: string; error?: string } | null>(null);

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files[0]) {
            setFile(e.target.files[0]);
            setResult(null);
        }
    };

    const handleSync = () => {
        if (!file) return;
        setSyncing(true);
        setResult(null);

        Papa.parse(file, {
            header: true,
            skipEmptyLines: true,
            complete: async (parsed) => {
                try {
                    const data = parsed.data as any[];
                    if (data.length === 0) throw new Error("CSV is empty");
                    
                    const res = await exportToGoogleSheets(data);
                    setResult(res);
                } catch (e: any) {
                    setResult({ success: false, error: e.message });
                } finally {
                    setSyncing(false);
                }
            },
            error: (error) => {
                setResult({ success: false, error: error.message });
                setSyncing(false);
            }
        });
    };

    return (
        <div className="w-full max-w-4xl mx-auto p-4 pt-0">
            <div className="bg-[#111] border border-zinc-800 rounded-2xl p-8">
                <div className="flex items-center gap-4 mb-8 pb-6 border-b border-zinc-800/50">
                    <div className="bg-emerald-500/10 p-3 rounded-2xl text-emerald-500">
                        <Database className="w-6 h-6" />
                    </div>
                    <div>
                        <h2 className="text-xl font-semibold text-white">Google Sheets CRM Sync</h2>
                        <p className="text-zinc-500 text-sm mt-1">Upload your qualified CSV to instantly orchestrate leads across the 3-Tab Pipeline.</p>
                    </div>
                </div>

                <div className="space-y-8">
                    <div className="border-2 border-dashed border-zinc-800 rounded-2xl p-10 flex flex-col items-center justify-center bg-black/30 transition-colors hover:border-emerald-500/30 hover:bg-emerald-500/5">
                        <Upload className="w-10 h-10 text-zinc-500 mb-4" />
                        <h3 className="text-white font-medium mb-2">Upload Qualified Leads CSV</h3>
                        <p className="text-sm text-zinc-500 mb-6 text-center max-w-sm">
                            Ensure your CSV contains columns like <code className="text-emerald-400 bg-emerald-400/10 px-1 py-0.5 rounded">email</code>, <code className="text-emerald-400 bg-emerald-400/10 px-1 py-0.5 rounded">hook</code>, <code className="text-emerald-400 bg-emerald-400/10 px-1 py-0.5 rounded">first_name</code>, etc.
                        </p>
                        
                        <label className="bg-white text-black px-6 py-2.5 rounded-xl font-medium hover:bg-zinc-200 transition-colors cursor-pointer inline-flex items-center gap-2 shadow-xl shadow-white/10">
                            {file ? file.name : "Select CSV File"}
                            <input type="file" accept=".csv" className="hidden" onChange={handleFileChange} />
                        </label>
                    </div>

                    <div className="flex justify-end">
                        <button
                            onClick={handleSync}
                            disabled={!file || syncing}
                            className={cn(
                                "px-8 py-3 rounded-xl font-medium flex items-center gap-2 transition-all",
                                !file ? "bg-zinc-800 text-zinc-500 cursor-not-allowed" 
                                : syncing ? "bg-emerald-500/20 text-emerald-500" 
                                : "bg-emerald-500 hover:bg-emerald-400 text-black shadow-lg shadow-emerald-500/20"
                            )}
                        >
                            {syncing ? <Loader2 className="w-5 h-5 animate-spin" /> : <Sheet className="w-5 h-5" />}
                            {syncing ? "Syncing to CRM..." : "Push to Google Sheets"}
                        </button>
                    </div>

                    {result && (
                        <div className={cn(
                            "p-5 rounded-xl border flex items-start gap-4 animate-in fade-in slide-in-from-bottom-2",
                            result.success ? "bg-emerald-500/10 border-emerald-500/20" : "bg-red-500/10 border-red-500/20"
                        )}>
                            {result.success ? <CheckCircle className="w-6 h-6 text-emerald-500 mt-0.5" /> : <AlertCircle className="w-6 h-6 text-red-500 mt-0.5" />}
                            <div className="flex-1">
                                <h4 className={cn("font-medium mb-1", result.success ? "text-emerald-400" : "text-red-400")}>
                                    {result.success ? "CRM Sync Complete!" : "Sync Failed"}
                                </h4>
                                <p className={cn("text-sm", result.success ? "text-emerald-500/80" : "text-red-400/80")}>
                                    {result.error || "Your leads have been successfully mapped into the Inbox, Enrichment, and Outreach Pipeline tabs."}
                                </p>
                                {result.success && result.url && (
                                    <a href={result.url} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex items-center gap-2 text-sm bg-emerald-500/20 text-emerald-400 px-4 py-2 rounded-lg hover:bg-emerald-500/30 transition-colors font-medium">
                                        Open CRM Spreadsheet <ExternalLink className="w-4 h-4" />
                                    </a>
                                )}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
