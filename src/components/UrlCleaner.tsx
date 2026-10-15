"use client";

import React, { useState } from "react";
import { Upload, Download, Trash2 } from "lucide-react";
import { cn, extractLinkedInName } from "@/lib/utils";
import Papa from 'papaparse';

export default function UrlCleaner() {
    const [csvData, setCsvData] = useState<{ original: string, cleaned: string }[]>([]);
    const [isDragging, setIsDragging] = useState(false);
    const [isProcessing, setIsProcessing] = useState(false);

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
        if (file && (file.type === "text/csv" || file.name.endsWith('.csv'))) {
            processFile(file);
        }
    };

    const processFile = (file: File) => {
        setIsProcessing(true);
        Papa.parse(file, {
            complete: (results) => {
                const cleanedData = results.data
                    .map((row: any) => {
                        const original = row[0]?.trim();
                        return original ? { original, cleaned: extractLinkedInName(original) } : null;
                    })
                    .filter(Boolean) as { original: string, cleaned: string }[];

                setCsvData(cleanedData);
                setIsProcessing(false);
            },
            header: false
        });
    };

    const handleExport = () => {
        if (csvData.length === 0) return;

        const csvContent = csvData.map(d => `"${d.original}","${d.cleaned}"`).join("\n");
        const blob = new Blob([csvContent], { type: 'text/csv' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.setAttribute('hidden', '');
        a.setAttribute('href', url);
        a.setAttribute('download', 'Cleaned_LinkedIn_Names.csv');
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    };

    const clearData = () => {
        setCsvData([]);
    };

    return (
        <div className="space-y-4 max-w-[900px]">
            <section className="panel">
                <div className="panel-head">
                    Messy list in
                    {csvData.length > 0 && (
                        <span className="hint"><span className="num">{csvData.length.toLocaleString()}</span> cleaned</span>
                    )}
                </div>

                <div className="panel-body space-y-3">
                    <div
                        onDragOver={handleDragOver}
                        onDragLeave={handleDragLeave}
                        onDrop={handleDrop}
                        className={cn(
                            "drop px-5 py-6 flex items-center gap-4 cursor-pointer",
                            isDragging && "drop-active",
                            csvData.length > 0 && !isDragging && "drop-loaded",
                        )}
                    >
                        <input
                            type="file"
                            accept=".csv"
                            onChange={handleFileChange}
                            className="absolute inset-0 opacity-0 cursor-pointer z-20"
                            aria-label="Upload a CSV of LinkedIn URLs"
                        />
                        <Upload className={cn("w-5 h-5 flex-none", csvData.length > 0 ? "text-[var(--signal)]" : "text-[var(--text-faint)]")} />
                        <div className="min-w-0">
                            <p className="text-[13px] font-medium text-[var(--text)]">
                                {isProcessing
                                    ? "Cleaning…"
                                    : csvData.length > 0
                                        ? <><span className="num">{csvData.length.toLocaleString()}</span> URLs cleaned</>
                                        : "Drop a CSV here, or click to choose one"}
                            </p>
                            <p className="text-[11.5px] text-[var(--text-faint)] mt-0.5">
                                Tracking parameters and trailing junk are stripped
                            </p>
                        </div>
                    </div>

                    {csvData.length > 0 && (
                        <div className="flex gap-2">
                            <button onClick={handleExport} className="btn btn-primary">
                                <Download className="w-3.5 h-3.5" />
                                Download clean list
                            </button>
                            <button onClick={clearData} className="btn btn-ghost !text-[var(--bad)]" title="Clear">
                                <Trash2 className="w-3.5 h-3.5" />
                                Clear
                            </button>
                        </div>
                    )}
                </div>
            </section>

            {csvData.length > 0 && (
                <section className="panel">
                    <div className="panel-head">
                        Preview
                        <span className="hint">First {Math.min(50, csvData.length)}</span>
                    </div>
                    <div className="max-h-[420px] overflow-y-auto">
                        {csvData.slice(0, 50).map((item, i) => (
                            <div key={i} className="tbl-row px-4 py-2.5 flex items-center justify-between gap-4">
                                <span className="text-[11.5px] text-[var(--text-faint)] truncate max-w-[55%]">{item.original}</span>
                                <span className="text-[12.5px] font-[family-name:var(--font-mono)] text-[var(--text)]">{item.cleaned}</span>
                            </div>
                        ))}
                    </div>
                    {csvData.length > 50 && (
                        <div className="panel-note">
                            <span className="num">{(csvData.length - 50).toLocaleString()}</span>&nbsp;more rows are in the download.
                        </div>
                    )}
                </section>
            )}
        </div>
    );
}
