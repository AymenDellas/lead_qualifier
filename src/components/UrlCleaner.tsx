"use client";

import React, { useState } from "react";
import { Upload, Download, Trash2, CheckCircle, Link2 } from "lucide-react";
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
        <div className="space-y-6 animate-in fade-in duration-500">
            {/* Control Bento */}
            <div className="bg-[#111] border border-zinc-800 rounded-3xl p-8">
                <div className="flex items-center gap-3 mb-6">
                    <div className="bg-purple-500/10 p-3 rounded-2xl text-purple-500">
                        <Link2 className="w-6 h-6" />
                    </div>
                    <div>
                        <h2 className="text-xl font-semibold">URL Cleaner</h2>
                        <p className="text-zinc-500 text-sm">Upload a CSV to clean LinkedIn URLs to their canonical form</p>
                    </div>
                </div>

                <div
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    className={cn(
                        "group relative border-2 border-dashed rounded-2xl p-10 flex flex-col items-center justify-center cursor-pointer transition-all duration-300",
                        isDragging ? "border-white bg-white/5" : "border-zinc-800 bg-zinc-900/30",
                        csvData.length > 0 && !isDragging ? "border-purple-500/50" : ""
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
                        {isProcessing ? "Cleaning URLs..." : csvData.length > 0 ? `${csvData.length} URLs cleaned` : "Drop LinkedIn CSV here"}
                    </p>
                    <p className="text-zinc-600 text-sm mt-1">LinkedIn URLs will be stripped of tracking and trailing junk</p>
                </div>

                {csvData.length > 0 && (
                    <div className="flex gap-4 mt-6 animate-in slide-in-from-bottom-2">
                        <button
                            onClick={handleExport}
                            className="flex-1 bg-white text-black h-[50px] rounded-xl font-bold hover:bg-zinc-200 transition-all flex items-center justify-center gap-2"
                        >
                            <Download className="w-4 h-4" />
                            Export Cleaned CSV
                        </button>
                        <button
                            onClick={clearData}
                            className="bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-white px-6 rounded-xl transition-all"
                        >
                            <Trash2 className="w-5 h-5" />
                        </button>
                    </div>
                )}
            </div>

            {/* Results Preview Bento */}
            {csvData.length > 0 && (
                <div className="bg-[#111] border border-zinc-800 rounded-3xl p-6 overflow-hidden">
                    <h3 className="text-sm font-semibold uppercase tracking-wider mb-4 flex items-center gap-2">
                        <CheckCircle className="w-4 h-4 text-emerald-500" />
                        Preview Results
                    </h3>
                    <div className="max-h-[400px] overflow-y-auto space-y-2 pr-2 custom-scrollbar">
                        {csvData.slice(0, 50).map((item, i) => (
                            <div key={i} className="bg-zinc-900/50 border border-zinc-800/50 p-3 rounded-xl flex items-center justify-between gap-4">
                                <span className="text-xs text-zinc-500 truncate max-w-[50%]">{item.original}</span>
                                <span className="text-sm font-mono text-purple-400 font-medium">{item.cleaned}</span>
                            </div>
                        ))}
                        {csvData.length > 50 && (
                            <p className="text-center text-zinc-600 text-xs py-2 italic font-mono uppercase tracking-widest">
                                + {csvData.length - 50} more records in export
                            </p>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
