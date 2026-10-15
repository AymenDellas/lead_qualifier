"use client";

import React, { useState } from "react";
import { Upload, Sheet, Loader2, ExternalLink } from "lucide-react";
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
        <div className="max-w-[720px]">
            <section className="panel">
                <div className="panel-head">
                    Send to Google Sheets
                    <span className="hint">{file ? file.name : 'No file chosen'}</span>
                </div>

                <div className="panel-body space-y-3">
                    <label className="drop px-5 py-6 flex items-center gap-4 cursor-pointer block">
                        <input type="file" accept=".csv" className="hidden" onChange={handleFileChange} />
                        <Upload className={cn("w-5 h-5 flex-none", file ? "text-[var(--signal)]" : "text-[var(--text-faint)]")} />
                        <div className="min-w-0">
                            <p className="text-[13px] font-medium text-[var(--text)]">
                                {file ? file.name : 'Choose a CSV of leads'}
                            </p>
                            <p className="text-[11.5px] text-[var(--text-faint)] mt-0.5">
                                Include an address, an opening line and a name where you have them
                            </p>
                        </div>
                    </label>

                    <button onClick={handleSync} disabled={!file || syncing} className="btn btn-primary">
                        {syncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sheet className="w-3.5 h-3.5" />}
                        {syncing ? 'Sending' : 'Send to Sheets'}
                    </button>

                    {result && (
                        <div
                            className={cn(
                                "rounded-[var(--radius-sm)] border p-3.5",
                                result.success
                                    ? "border-[var(--signal-line)] bg-[var(--signal-dim)]"
                                    : "border-[rgba(229,107,107,0.3)] bg-[var(--bad-dim)]",
                            )}
                        >
                            <p className={cn("mark", result.success ? "mark-ok" : "mark-bad")}>
                                {result.success ? 'Sent' : 'Failed'}
                            </p>
                            <p className="text-[12.5px] text-[var(--text-dim)] mt-2 leading-relaxed">
                                {result.error || 'Only addresses proven by a direct check reach the send list — the rest go to enrichment.'}
                            </p>
                            {result.success && result.url && (
                                <a
                                    href={result.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="btn btn-outline mt-3"
                                >
                                    Open the spreadsheet <ExternalLink className="w-3.5 h-3.5" />
                                </a>
                            )}
                        </div>
                    )}
                </div>
            </section>
        </div>
    );
}
