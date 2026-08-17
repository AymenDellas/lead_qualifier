"use client";

import React, { useState, useEffect, useRef } from "react";
import { Database, Filter, Loader2, Search, CheckCircle, AlertCircle, XCircle, Trash2, Download, ShieldCheck, RefreshCcw, Zap, Phone, Radar, Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import { verifyLeadEmailAction, bulkDeleteLeadsAction, toggleContactedAction, generateHookAction, importLeadsAction, pushLeadsToInboxAction, markLeadsContactedAction } from "@/app/actions/crm-actions";


interface LeadRecord {
    id: string;
    linkedin_url: string;
    first_name: string;
    last_name: string;
    company: string;
    website: string;
    website_source: string;
    email: string;
    all_emails: string;
    email_status: string;
    hook: string;
    pipeline_status: string;
    location: string;
    contacted: boolean;
    created_at: string;
}

const resolveCountry = (location: string | undefined): string => {
    if (!location) return 'OTHER';
    const loc = location.toUpperCase();
    
    // specific overrides
    if (loc.includes('LONDON, ON') || loc.includes('LONDON, ONTARIO')) return 'NA';
    if (loc.includes('VANCOUVER, WA') || loc.includes('VANCOUVER, WASHINGTON')) return 'NA';

    const ukKeywords = ['UK', 'UNITED KINGDOM', 'ENGLAND', 'SCOTLAND', 'WALES', 'NORTHERN IRELAND', 'LONDON', 'BIRMINGHAM', 'MANCHESTER', 'GLASGOW', 'NEWCASTLE', 'SHEFFIELD', 'LEEDS', 'LIVERPOOL', 'BRISTOL', 'EDINBURGH', 'CARDIFF', 'BELFAST', 'NOTTINGHAM', 'LEICESTER', 'COVENTRY', 'BRADFORD'];
    if (ukKeywords.some(kw => loc.includes(kw) || loc === kw)) return 'UK';

    const canadaKeywords = ['CANADA', 'TORONTO', 'MONTREAL', 'VANCOUVER', 'CALGARY', 'EDMONTON', 'OTTAWA', 'WINNIPEG', 'QUEBEC', 'HAMILTON', 'KITCHENER', 'VICTORIA', 'HALIFAX', 'OSHAWA', 'WINDSOR', 'SASKATOON', 'REGINA', 'KELOWNA', 'ON', 'BC', 'QC', 'AB', 'MB', 'SK', 'NS', 'NB', 'NL', 'PE', 'ONTARIO', 'BRITISH COLUMBIA', 'ALBERTA', 'NOVA SCOTIA', 'MANITOBA', 'SASKATCHEWAN'];
    if (canadaKeywords.some(kw => loc.includes(kw) || loc === kw)) return 'NA';

    const usKeywords = ['US', 'USA', 'AMERICA', 'UNITED STATES', 'NEW YORK', 'LOS ANGELES', 'CHICAGO', 'HOUSTON', 'PHOENIX', 'PHILADELPHIA', 'SAN ANTONIO', 'SAN DIEGO', 'DALLAS', 'SAN JOSE', 'AUSTIN', 'JACKSONVILLE', 'FORT WORTH', 'COLUMBUS', 'CHARLOTTE', 'SAN FRANCISCO', 'INDIANAPOLIS', 'SEATTLE', 'DENVER', 'WASHINGTON', 'BOSTON', 'EL PASO', 'NASHVILLE', 'DETROIT', 'OKLAHOMA CITY', 'PORTLAND', 'LAS VEGAS', 'MEMPHIS', 'LOUISVILLE', 'BALTIMORE', 'MILWAUKEE', 'ALBUQUERQUE', 'TUCSON', 'FRESNO', 'SACRAMENTO', 'ATLANTA', 'KANSAS CITY', 'MIAMI', 'RALEIGH', 'OMAHA', 'OAKLAND', 'MINNEAPOLIS', 'TULSA', 'TAMPA', 'NEW ORLEANS', 'WICHITA', 'CLEVELAND', 'HONOLULU', 'COLORADO', 'FLORIDA', 'TEXAS', 'CALIFORNIA', 'GREATER', 'AREA', 'CA', 'NY', 'TX', 'FL', 'IL', 'PA', 'OH', 'GA', 'NC', 'MI', 'WA', 'AZ', 'MA', 'TN', 'IN', 'MO', 'MD', 'WI', 'CO', 'MN', 'SC', 'AL', 'LA', 'KY', 'OR', 'OK', 'CT', 'IA', 'MS', 'AR', 'KS', 'UT', 'NV', 'NM', 'WV', 'NE', 'ID', 'HI', 'ME', 'NH', 'RI', 'MT', 'DE', 'SD', 'ND', 'AK', 'VT', 'WY'];
    const usRegex = new RegExp(`\\b(${usKeywords.join('|')})\\b`);
    if (usRegex.test(loc)) return 'NA';

    return 'OTHER';
}

export default function CrmDatabase({ onPushToEngine }: { onPushToEngine?: (urls: string[]) => void }) {
    const [leads, setLeads] = useState<LeadRecord[]>([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState<string>('ALL');
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [verifying, setVerifying] = useState(false);
    const [generatingHooks, setGeneratingHooks] = useState(false);
    const [currentPage, setCurrentPage] = useState(1);
    const itemsPerPage = 100;

    const [emailFilter, setEmailFilter] = useState<string>('ALL');
    const [hookFilter, setHookFilter] = useState<string>('ALL');

    // Reset page when filter changes
    useEffect(() => {
        setCurrentPage(1);
    }, [filter, emailFilter, hookFilter]);

    const fetchLeads = async () => {
        setLoading(true);
        try {
            const res = await fetch('/api/crm/leads');
            const data = await res.json();
            if (data.success) {
                setLeads(data.data);
            }
        } catch (error) {
            console.error("Failed to fetch leads:", error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchLeads();
    }, []);

    const filteredLeads = leads.filter(l => {
        let passesPrimary = false;
        if (filter === 'ALL') passesPrimary = true;
        else if (filter === 'CONTACTED') passesPrimary = l.contacted;
        
        // Exclude contacted leads from all active pipeline views
        else if (l.contacted) passesPrimary = false;
        
        // Raw location tabs (Inbox only)
        else if (['UK', 'NA'].includes(filter)) {
            passesPrimary = l.pipeline_status === 'INBOX' && resolveCountry(l.location) === filter;
        }
        
        else if (['UK_QUALIFIED', 'NA_QUALIFIED'].includes(filter)) {
            const loc = filter.split('_QUALIFIED')[0]; // UK, NA
            passesPrimary = l.pipeline_status === 'OUTREACH' && resolveCountry(l.location) === loc;
        }
        else {
            passesPrimary = l.pipeline_status === filter;
        }

        if (!passesPrimary) return false;

        if (emailFilter !== 'ALL' && l.email_status !== emailFilter) return false;

        if (hookFilter === 'HAS_HOOK' && (!l.hook || l.hook.trim() === '')) return false;
        if (hookFilter === 'NO_HOOK' && (l.hook && l.hook.trim() !== '')) return false;

        return true;
    });

    const totalPages = Math.max(1, Math.ceil(filteredLeads.length / itemsPerPage));
    const paginatedLeads = filteredLeads.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);

    const fileInputRef = useRef<HTMLInputElement>(null);
    const markContactedFileRef = useRef<HTMLInputElement>(null);

    const handleUploadClick = () => {
        fileInputRef.current?.click();
    };

    const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) {
            alert('No file selected');
            return;
        }

        try {
            setLoading(true);
            const text = await file.text();
            const lines = text.split(/\r?\n/).filter(line => line.trim() !== '');

            if (lines.length < 2) {
                alert('Upload Failed: CSV has no data rows.');
                setLoading(false);
                return;
            }

            // Parse headers - handle quoted fields
            const parseCSVLine = (line: string): string[] => {
                const result: string[] = [];
                let current = '';
                let inQuotes = false;
                for (let i = 0; i < line.length; i++) {
                    const ch = line[i];
                    if (ch === '"') {
                        inQuotes = !inQuotes;
                    } else if (ch === ',' && !inQuotes) {
                        result.push(current.trim());
                        current = '';
                    } else {
                        current += ch;
                    }
                }
                result.push(current.trim());
                return result;
            };

            const headers = parseCSVLine(lines[0]);
            const lowerHeaders = headers.map(h => String(h).toLowerCase().trim().replace(/^"|"$/g, ''));

            // Find column indices
            let urlIdx = -1;
            let locIdx = -1;
            let nameIdx = -1;

            for (let i = 0; i < lowerHeaders.length; i++) {
                const h = lowerHeaders[i];
                if (urlIdx === -1 && (h.includes('url') || h.includes('linkedin') || h.includes('profile') || h.includes('website') || h.includes('link'))) {
                    urlIdx = i;
                }
                if (locIdx === -1 && (h.includes('location') || h.includes('country') || h.includes('city') || h.includes('state') || h.includes('region'))) {
                    locIdx = i;
                }
                if (nameIdx === -1 && (h.includes('name') || h.includes('first'))) {
                    nameIdx = i;
                }
            }

            if (urlIdx === -1) {
                alert(`Upload Failed: No URL/LinkedIn column found.\nHeaders detected: ${lowerHeaders.join(', ')}`);
                setLoading(false);
                return;
            }

            const leadsToImport: any[] = [];
            for (let i = 1; i < lines.length; i++) {
                const cols = parseCSVLine(lines[i]);
                const url = (cols[urlIdx] || '').replace(/^"|"$/g, '').trim();
                if (!url) continue;

                const loc = locIdx >= 0 ? (cols[locIdx] || '').replace(/^"|"$/g, '').trim() || 'Unknown' : 'Unknown';
                const name = nameIdx >= 0 ? (cols[nameIdx] || '').replace(/^"|"$/g, '').trim() || 'Unknown' : 'Unknown';

                leadsToImport.push({
                    linkedin_url: url,
                    location: loc,
                    first_name: name,
                    pipeline_status: 'INBOX'
                });
            }

            if (leadsToImport.length === 0) {
                alert('Upload Failed: No valid rows found with URL data.');
                setLoading(false);
                return;
            }

            await importLeadsAction(leadsToImport);
            await fetchLeads();
            setLoading(false);
            alert(`Successfully imported ${leadsToImport.length} leads!`);
        } catch (err: any) {
            console.error('CSV Upload Error:', err);
            alert(`Upload Error: ${err?.message || 'Unknown error'}`);
            setLoading(false);
        }

        // Reset so same file can be re-uploaded
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    const handleMarkContactedUploadClick = () => {
        markContactedFileRef.current?.click();
    };

    const handleMarkContactedFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        try {
            setLoading(true);
            const text = await file.text();
            const lines = text.split(/\r?\n/).filter(line => line.trim() !== '');

            if (lines.length < 2) {
                alert('Upload Failed: CSV has no data rows.');
                setLoading(false);
                return;
            }

            const parseCSVLine = (line: string): string[] => {
                const result: string[] = [];
                let current = '';
                let inQuotes = false;
                for (let i = 0; i < line.length; i++) {
                    const ch = line[i];
                    if (ch === '"') inQuotes = !inQuotes;
                    else if (ch === ',' && !inQuotes) { result.push(current.trim()); current = ''; }
                    else current += ch;
                }
                result.push(current.trim());
                return result;
            };

            const headers = parseCSVLine(lines[0]);
            const lowerHeaders = headers.map(h => String(h).toLowerCase().trim().replace(/^"|"$/g, ''));

            let urlIdx = -1;
            let emailIdx = -1;

            for (let i = 0; i < lowerHeaders.length; i++) {
                const h = lowerHeaders[i];
                if (urlIdx === -1 && (h.includes('url') || h.includes('linkedin') || h.includes('profile') || h.includes('website') || h.includes('link'))) urlIdx = i;
                if (emailIdx === -1 && h.includes('email')) emailIdx = i;
            }

            if (urlIdx === -1 && emailIdx === -1) {
                alert(`Upload Failed: No URL or Email column found.\nHeaders detected: ${lowerHeaders.join(', ')}`);
                setLoading(false);
                return;
            }

            const identifiersToMark: string[] = [];
            for (let i = 1; i < lines.length; i++) {
                const cols = parseCSVLine(lines[i]);
                if (urlIdx >= 0) {
                    const url = (cols[urlIdx] || '').replace(/^"|"$/g, '').trim();
                    if (url) identifiersToMark.push(url);
                }
                if (emailIdx >= 0) {
                    const email = (cols[emailIdx] || '').replace(/^"|"$/g, '').trim();
                    if (email) identifiersToMark.push(email);
                }
            }

            if (identifiersToMark.length === 0) {
                alert('Upload Failed: No valid emails or URLs found in the data.');
                setLoading(false);
                return;
            }

            const updatedCount = await markLeadsContactedAction(identifiersToMark);
            await fetchLeads();
            setLoading(false);
            alert(`Successfully matched and marked ${updatedCount} leads as contacted!`);
        } catch (err: any) {
            console.error('CSV Upload Error:', err);
            alert(`Upload Error: ${err?.message || 'Unknown error'}`);
            setLoading(false);
        }

        if (markContactedFileRef.current) markContactedFileRef.current.value = '';
    };

    // Removed Push to All
    const toggleSelect = (id: string) => {
        const newSet = new Set(selectedIds);
        if (newSet.has(id)) newSet.delete(id);
        else newSet.add(id);
        setSelectedIds(newSet);
    };

    const toggleSelectAll = () => {
        if (selectedIds.size === filteredLeads.length && filteredLeads.length > 0) {
            setSelectedIds(new Set());
        } else {
            setSelectedIds(new Set(filteredLeads.map(l => l.id)));
        }
    };

    const handleVerifySelected = async () => {
        if (selectedIds.size === 0) return;
        setVerifying(true);
        
        const idsToVerify = Array.from(selectedIds);
        for (const id of idsToVerify) {
            try {
                const result = await verifyLeadEmailAction(id);
                if (result) {
                    // Optimistic: update just this one lead in local state
                    setLeads(prev => prev.map(l => l.id === id ? { ...l, email_status: result.email_status } : l));
                }
            } catch (err) {
                console.error("Failed to verify", id, err);
            }
        }
        
        setVerifying(false);
        setSelectedIds(new Set());
    };

    const handleGenerateHooksSelected = async () => {
        if (selectedIds.size === 0) return;
        setGeneratingHooks(true);
        
        const idsToGenerate = Array.from(selectedIds);
        for (const id of idsToGenerate) {
            try {
                const result = await generateHookAction(id);
                if (result) {
                    // Optimistic: update just this lead's hook
                    setLeads(prev => prev.map(l => l.id === id ? { ...l, hook: result.hook } : l));
                }
            } catch (err) {
                console.error("Failed to generate hook", id, err);
            }
        }
        
        setGeneratingHooks(false);
        setSelectedIds(new Set());
    };

    const handleAutoGenerateMissingHooks = async () => {
        const missingHookLeads = leads.filter(l => !l.hook || l.hook.trim() === '');
        if (missingHookLeads.length === 0) {
            alert("No leads are missing hooks!");
            return;
        }
        
        if (!confirm(`Auto-generate hooks for ${missingHookLeads.length} leads? This may take a while.`)) return;
        
        setGeneratingHooks(true);
        for (const lead of missingHookLeads) {
            try {
                const result = await generateHookAction(lead.id);
                if (result) {
                    setLeads(prev => prev.map(l => l.id === lead.id ? { ...l, hook: result.hook } : l));
                }
            } catch (err) {
                console.error("Failed to auto-generate hook", lead.id, err);
            }
        }
        setGeneratingHooks(false);
    };

    const handleToggleContacted = async (id: string, currentVal: boolean) => {
        // Optimistic: update UI instantly
        setLeads(prev => prev.map(l => l.id === id ? { ...l, contacted: !currentVal } : l));
        try {
            await toggleContactedAction(id, !currentVal);
        } catch {
            // Revert on failure
            setLeads(prev => prev.map(l => l.id === id ? { ...l, contacted: currentVal } : l));
        }
    };

    const handlePushToContacted = async () => {
        if (selectedIds.size === 0) return;
        if (!confirm(`Mark ${selectedIds.size} leads as contacted?`)) return;
        
        const ids = Array.from(selectedIds);
        // Optimistic: update UI instantly
        setLeads(prev => prev.map(l => ids.includes(l.id) ? { ...l, contacted: true } : l));
        setSelectedIds(new Set());

        // Fire all updates in parallel in the background
        Promise.allSettled(ids.map(id => toggleContactedAction(id, true))).catch(() => {
            // If it fails, re-fetch to get the truth
            fetchLeads();
        });
    };

    const handleDeleteSelected = async () => {
        if (selectedIds.size === 0) return;
        if (!confirm(`Are you sure you want to delete ${selectedIds.size} leads?`)) return;
        
        const ids = Array.from(selectedIds);
        // Optimistic: remove from UI instantly
        setLeads(prev => prev.filter(l => !ids.includes(l.id)));
        setSelectedIds(new Set());

        // Fire bulk delete in background
        bulkDeleteLeadsAction(ids).catch(() => {
            fetchLeads(); // Revert on failure
        });
    };

    const handlePushToEngineSelected = () => {
        if (!onPushToEngine) return;
        const urls = leads.filter(l => selectedIds.has(l.id)).map(l => l.linkedin_url).filter(Boolean);
        if (urls.length === 0) {
            alert('No valid LinkedIn URLs found in selected leads.');
            return;
        }
        onPushToEngine(urls);
    };

    const exportCsv = (toExport: LeadRecord[], filenamePrefix: string) => {
        if (toExport.length === 0) {
            alert(`No leads found for export.`);
            return;
        }
        const headers = ['First Name', 'Last Name', 'Company', 'Email', 'Hook', 'LinkedIn URL'];
        const csvRows = toExport.map(l => [
            `"${(l.first_name || '').replace(/"/g, '""')}"`,
            `"${(l.last_name || '').replace(/"/g, '""')}"`,
            `"${(l.company || '').replace(/"/g, '""')}"`,
            `"${(l.email || '').replace(/"/g, '""')}"`,
            `"${(l.hook || '').replace(/"/g, '""')}"`,
            `"${(l.linkedin_url || '').replace(/"/g, '""')}"`
        ].join(','));
        
        const csvContent = [headers.join(','), ...csvRows].join('\n');
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${filenamePrefix}_${new Date().toISOString().split('T')[0]}.csv`;
        link.click();
    };

    const handleExportValidAndRisky = () => {
        const toExport = filteredLeads.filter(l => l.email_status === 'VALID' || l.email_status === 'RISKY');
        exportCsv(toExport, 'Revlane_ValidAndRisky_Leads');
    };

    const handleExportValidOnly = () => {
        const toExport = filteredLeads.filter(l => l.email_status === 'VALID');
        exportCsv(toExport, 'Revlane_ValidOnly_Leads');
    };

    return (
        <div className="w-full flex flex-col h-[calc(100vh-200px)]">
            <div className="bg-[#111] border border-zinc-800 rounded-2xl flex-1 flex flex-col overflow-hidden">
                {/* Header & Controls */}
                <div className="p-4 border-b border-zinc-800 flex items-center justify-between bg-black/50 flex-wrap gap-4">
                    <div className="flex items-center gap-3">
                        <div className="bg-accent/10 p-2 rounded-xl text-accent">
                            <Database className="w-5 h-5" />
                        </div>
                        <div>
                            <h2 className="text-lg font-semibold text-white">CRM Database</h2>
                            <p className="text-zinc-500 text-xs">{leads.length} total leads connected to n8n</p>
                        </div>
                    </div>

                    {selectedIds.size > 0 ? (
                        <div className="flex items-center gap-2 animate-in fade-in zoom-in-95">
                            <span className="text-sm font-medium text-zinc-300 mr-2">{selectedIds.size} selected</span>
                            <button 
                                onClick={handleVerifySelected}
                                disabled={verifying}
                                className="bg-accent/20 text-accent border border-accent/30 px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-accent/30 transition-all flex items-center gap-2"
                            >
                                {verifying ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
                                Verify Emails
                            </button>
                            <button 
                                onClick={handleGenerateHooksSelected}
                                disabled={generatingHooks}
                                className="bg-amber-500/20 text-amber-400 border border-amber-500/30 px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-amber-500/30 transition-all flex items-center gap-2"
                            >
                                {generatingHooks ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                                Generate Hooks
                            </button>
                            <button 
                                onClick={handlePushToContacted}
                                className="bg-purple-500/20 text-purple-400 border border-purple-500/30 px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-purple-500/30 transition-all flex items-center gap-2"
                            >
                                <Phone className="w-4 h-4" />
                                Mark Contacted
                            </button>
                            <button 
                                onClick={handleDeleteSelected}
                                className="bg-danger/20 text-danger border border-danger/30 px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-danger/30 transition-all flex items-center gap-2"
                            >
                                <Trash2 className="w-4 h-4" />
                                Delete
                            </button>
                            {onPushToEngine && (
                                <button 
                                    onClick={handlePushToEngineSelected}
                                    className="bg-blue-500/20 text-blue-400 border border-blue-500/30 px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-blue-500/30 transition-all flex items-center gap-2 ml-4"
                                >
                                    <Radar className="w-4 h-4" />
                                    Process in Engine
                                </button>
                            )}
                        </div>
                    ) : (
                        <div className="flex items-center gap-2">
                            <button 
                                onClick={handleExportValidAndRisky}
                                className="bg-accent/80 text-black px-4 py-1.5 rounded-lg text-sm font-medium hover:bg-accent shadow-lg shadow-accent/20 transition-all flex items-center gap-2"
                            >
                                <Download className="w-4 h-4" />
                                Export Valid + Risky
                            </button>
                            <button 
                                onClick={handleExportValidOnly}
                                className="bg-accent text-black px-4 py-1.5 rounded-lg text-sm font-medium hover:bg-accent shadow-lg shadow-accent/20 transition-all flex items-center gap-2"
                            >
                                <Download className="w-4 h-4" />
                                Export Valid Only
                            </button>
                                <div className="bg-black/50 p-1 rounded-xl border border-zinc-800 flex items-center text-sm ml-2 overflow-x-auto max-w-[500px]">
                                <button onClick={() => setFilter('ALL')} className={cn("whitespace-nowrap px-3 py-1.5 rounded-lg transition-all", filter === 'ALL' ? "bg-zinc-800 text-white" : "text-zinc-500 hover:text-zinc-300")}>All</button>
                                <div className="w-px h-4 bg-zinc-800 mx-1"></div>
                                <button onClick={() => setFilter('UK')} className={cn("whitespace-nowrap px-3 py-1.5 rounded-lg transition-all", filter === 'UK' ? "bg-accent/20 text-accent" : "text-zinc-500 hover:text-zinc-300")}>UK</button>
                                <button onClick={() => setFilter('UK_QUALIFIED')} className={cn("whitespace-nowrap px-3 py-1.5 rounded-lg transition-all flex items-center gap-1", filter === 'UK_QUALIFIED' ? "bg-accent/20 text-accent" : "text-zinc-500 hover:text-zinc-300")}><Zap className="w-3 h-3"/> UK Qual</button>
                                <div className="w-px h-4 bg-zinc-800 mx-1"></div>
                                <button onClick={() => setFilter('NA')} className={cn("whitespace-nowrap px-3 py-1.5 rounded-lg transition-all", filter === 'NA' ? "bg-blue-500/20 text-blue-400" : "text-zinc-500 hover:text-zinc-300")}>NA</button>
                                <button onClick={() => setFilter('NA_QUALIFIED')} className={cn("whitespace-nowrap px-3 py-1.5 rounded-lg transition-all flex items-center gap-1", filter === 'NA_QUALIFIED' ? "bg-blue-500/20 text-blue-400" : "text-zinc-500 hover:text-zinc-300")}><Zap className="w-3 h-3"/> NA Qual</button>
                                <div className="w-px h-4 bg-zinc-800 mx-1"></div>
                                <button onClick={() => setFilter('OUTREACH')} className={cn("whitespace-nowrap px-3 py-1.5 rounded-lg transition-all", filter === 'OUTREACH' ? "bg-accent/20 text-accent" : "text-zinc-500 hover:text-zinc-300")}>Outreach</button>
                                <button onClick={() => setFilter('ENRICHMENT')} className={cn("whitespace-nowrap px-3 py-1.5 rounded-lg transition-all", filter === 'ENRICHMENT' ? "bg-amber-500/20 text-amber-400" : "text-zinc-500 hover:text-zinc-300")}>Enrichment</button>
                                <button onClick={() => setFilter('NOT_QUALIFIED')} className={cn("whitespace-nowrap px-3 py-1.5 rounded-lg transition-all flex items-center gap-1", filter === 'NOT_QUALIFIED' ? "bg-red-500/20 text-red-400" : "text-zinc-500 hover:text-zinc-300")}><XCircle className="w-3 h-3"/> Not Qual</button>
                                <button onClick={() => setFilter('CONTACTED')} className={cn("whitespace-nowrap px-3 py-1.5 rounded-lg transition-all flex items-center gap-1", filter === 'CONTACTED' ? "bg-purple-500/20 text-purple-400" : "text-zinc-500 hover:text-zinc-300")}><Phone className="w-3 h-3"/> Contacted</button>
                            </div>
                            
                            {filter === 'ALL' && (
                                <>
                                    <input
                                        ref={fileInputRef}
                                        type="file"
                                        accept=".csv"
                                        onChange={handleFileSelected}
                                        style={{ position: 'absolute', width: 0, height: 0, opacity: 0, overflow: 'hidden' }}
                                    />
                                    <button
                                        type="button"
                                        onClick={handleUploadClick}
                                        className="bg-zinc-800 text-zinc-300 border border-zinc-700 px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-zinc-700 transition-all flex items-center gap-2 ml-2 cursor-pointer whitespace-nowrap"
                                    >
                                        <Upload className="w-4 h-4" />
                                        Upload CSV
                                    </button>
                                </>  
                            )}

                            <input
                                ref={markContactedFileRef}
                                type="file"
                                accept=".csv"
                                onChange={handleMarkContactedFileSelected}
                                style={{ position: 'absolute', width: 0, height: 0, opacity: 0, overflow: 'hidden' }}
                            />
                            <button
                                type="button"
                                onClick={handleMarkContactedUploadClick}
                                className="bg-purple-500/20 text-purple-400 border border-purple-500/30 px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-purple-500/30 transition-all flex items-center gap-2 ml-2 whitespace-nowrap"
                            >
                                <Upload className="w-4 h-4" />
                                Mark Contacted List
                            </button>

                            <button 
                                onClick={handleAutoGenerateMissingHooks}
                                disabled={generatingHooks}
                                className="bg-amber-500/20 text-amber-400 border border-amber-500/30 px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-amber-500/30 transition-all flex items-center gap-2 ml-2 whitespace-nowrap"
                            >
                                {generatingHooks ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                                Auto-Gen Missing Hooks
                            </button>
                            <button onClick={fetchLeads} className="p-2 text-zinc-400 hover:text-white bg-zinc-800/50 hover:bg-zinc-800 rounded-xl transition-all border border-zinc-700/50 ml-1">
                                <RefreshCcw className={cn("w-4 h-4", loading && "animate-spin")} />
                            </button>
                        </div>
                    )}
                </div>

                {/* Secondary Filters Bar */}
                <div className="px-4 py-2 bg-black/30 border-b border-zinc-800 flex items-center gap-3">
                    <span className="text-xs text-zinc-500 font-medium uppercase tracking-wider">Sub-Filters:</span>
                    <select 
                        value={emailFilter} 
                        onChange={e => setEmailFilter(e.target.value)}
                        className="bg-zinc-800 text-zinc-300 border border-zinc-700 px-3 py-1 rounded-lg text-sm outline-none focus:border-accent cursor-pointer"
                    >
                        <option value="ALL">Any Email Status</option>
                        <option value="VALID">Valid Emails Only</option>
                        <option value="RISKY">Risky Emails Only</option>
                        <option value="INVALID">Invalid Emails</option>
                        <option value="UNVERIFIED">Unverified Emails</option>
                        <option value="GUESSED">Guessed Emails</option>
                    </select>

                    <select 
                        value={hookFilter} 
                        onChange={e => setHookFilter(e.target.value)}
                        className="bg-zinc-800 text-zinc-300 border border-zinc-700 px-3 py-1 rounded-lg text-sm outline-none focus:border-accent cursor-pointer"
                    >
                        <option value="ALL">Any Hook Status</option>
                        <option value="HAS_HOOK">Has Hook</option>
                        <option value="NO_HOOK">No Hook (Missing)</option>
                    </select>
                </div>

                {/* Table Area */}
                <div className="flex-1 overflow-auto">
                    <table className="w-full min-w-[1400px] text-sm text-left">
                        <thead className="bg-black/80 border-b border-zinc-800 sticky top-0 z-10">
                            <tr>
                                <th className="px-4 py-3 w-10 text-center">
                                    <input 
                                        type="checkbox" 
                                        className="rounded border-zinc-700 bg-zinc-800 checked:bg-accent focus:ring-accent focus:ring-offset-black/50"
                                        checked={filteredLeads.length > 0 && selectedIds.size === filteredLeads.length}
                                        onChange={toggleSelectAll}
                                    />
                                </th>
                                <th className="px-4 py-3 text-xs text-zinc-500 font-medium uppercase tracking-wider">Status</th>
                                <th className="px-4 py-3 text-xs text-zinc-500 font-medium uppercase tracking-wider">Name</th>
                                <th className="px-4 py-3 text-xs text-zinc-500 font-medium uppercase tracking-wider">LinkedIn URL</th>
                                <th className="px-4 py-3 text-xs text-zinc-500 font-medium uppercase tracking-wider">Website</th>
                                <th className="px-4 py-3 text-xs text-zinc-500 font-medium uppercase tracking-wider">Location</th>
                                <th className="px-4 py-3 text-xs text-zinc-500 font-medium uppercase tracking-wider">Email</th>
                                <th className="px-4 py-3 text-xs text-zinc-500 font-medium uppercase tracking-wider">Verification</th>
                                <th className="px-4 py-3 text-xs text-zinc-500 font-medium uppercase tracking-wider">Hook</th>
                                <th className="px-4 py-3 text-xs text-zinc-500 font-medium uppercase tracking-wider text-center">Contacted</th>
                            </tr>
                        </thead>
                        <tbody>
                            {loading && leads.length === 0 ? (
                                <tr>
                                    <td colSpan={9} className="px-4 py-12 text-center text-zinc-500">
                                        <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />
                                        Loading CRM data...
                                    </td>
                                </tr>
                            ) : filteredLeads.length === 0 ? (
                                <tr>
                                    <td colSpan={10} className="px-4 py-12 text-center text-zinc-500">
                                        <Search className="w-6 h-6 mx-auto mb-2 opacity-50" />
                                        No leads found
                                    </td>
                                </tr>
                            ) : (
                                paginatedLeads.map((lead) => (
                                    <tr 
                                        key={lead.id} 
                                        className={cn(
                                            "border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors group cursor-pointer",
                                            selectedIds.has(lead.id) && "bg-accent/5"
                                        )}
                                        onClick={() => toggleSelect(lead.id)}
                                    >
                                        <td className="px-4 py-3 text-center" onClick={e => e.stopPropagation()}>
                                            <input 
                                                type="checkbox" 
                                                className="rounded border-zinc-700 bg-zinc-800 checked:bg-accent focus:ring-accent focus:ring-offset-black/50"
                                                checked={selectedIds.has(lead.id)}
                                                onChange={() => toggleSelect(lead.id)}
                                            />
                                        </td>
                                        <td className="px-4 py-3">
                                            <span className={cn(
                                                "text-[10px] px-2 py-1 rounded-full font-bold tracking-wider",
                                                lead.pipeline_status === 'OUTREACH' && "bg-accent/10 text-accent",
                                                lead.pipeline_status === 'ENRICHMENT' && "bg-amber-500/10 text-amber-400",
                                                lead.pipeline_status === 'NOT_QUALIFIED' && "bg-red-500/10 text-red-400",
                                                lead.pipeline_status === 'INBOX' && "bg-zinc-800 text-zinc-400"
                                            )}>
                                                {lead.pipeline_status.replace('_', ' ')}
                                            </span>
                                        </td>
                                        <td className="px-4 py-3 font-medium text-zinc-300">
                                            {lead.first_name} {lead.last_name}
                                            {!lead.first_name && <span className="text-zinc-600 italic">Unknown</span>}
                                        </td>
                                        <td className="px-4 py-3 text-zinc-400 text-xs">
                                            {lead.linkedin_url ? (
                                                <a href={lead.linkedin_url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">
                                                    {lead.linkedin_url.includes('linkedin.com/in/') ? lead.linkedin_url.split('linkedin.com/in/')[1].replace(/\/$/, '') : 'Profile'}
                                                </a>
                                            ) : (
                                                <span className="text-zinc-600 italic">—</span>
                                            )}
                                        </td>
                                        <td className="px-4 py-3 text-zinc-400 text-xs truncate max-w-[150px]">
                                            {lead.website ? (
                                                <a href={lead.website} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline" title={lead.website}>
                                                    {lead.website.replace(/^https?:\/\/(www\.)?/, '').split('/')[0]}
                                                </a>
                                            ) : (
                                                <span className="text-zinc-600 italic">—</span>
                                            )}
                                        </td>
                                        <td className="px-4 py-3 text-zinc-400 text-xs">{lead.location || <span className="text-zinc-600 italic">—</span>}</td>
                                        <td className="px-4 py-3 text-accent font-mono text-xs">{lead.email || <span className="text-zinc-600 italic">—</span>}</td>
                                        <td className="px-4 py-3">
                                            <span className={cn(
                                                "text-[10px] px-2 py-1 rounded-full font-bold flex items-center gap-1 w-max",
                                                lead.email_status === 'VALID' ? "bg-accent/10 text-accent border border-accent/20" :
                                                lead.email_status === 'RISKY' ? "bg-amber-500/10 text-amber-400 border border-amber-500/20" :
                                                lead.email_status === 'INVALID' ? "bg-danger/10 text-danger border border-danger/20" :
                                                lead.email_status === 'GUESSED' ? "bg-orange-500/10 text-orange-400 border border-orange-500/20" :
                                                "bg-zinc-800 text-zinc-500"
                                            )}>
                                                {lead.email_status === 'VALID' && <CheckCircle className="w-3 h-3" />}
                                                {lead.email_status === 'RISKY' && <AlertCircle className="w-3 h-3" />}
                                                {lead.email_status === 'INVALID' && <XCircle className="w-3 h-3" />}
                                                {lead.email_status === 'GUESSED' && <AlertCircle className="w-3 h-3" />}
                                                {lead.email_status}
                                            </span>
                                        </td>
                                        <td className="px-4 py-3 text-zinc-400 max-w-[250px] truncate text-xs" title={lead.hook}>
                                            {lead.hook || <span className="text-zinc-600 italic">—</span>}
                                        </td>
                                        <td className="px-4 py-3 text-center" onClick={e => e.stopPropagation()}>
                                            <input 
                                                type="checkbox" 
                                                className="w-4 h-4 rounded border-zinc-700 bg-zinc-800 checked:bg-purple-500 focus:ring-purple-500 focus:ring-offset-black/50 cursor-pointer"
                                                checked={lead.contacted}
                                                onChange={() => handleToggleContacted(lead.id, lead.contacted)}
                                                title="Mark as contacted"
                                            />
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>

                {/* Pagination Controls */}
                {filteredLeads.length > 0 && (
                    <div className="p-4 border-t border-zinc-800 flex items-center justify-between bg-black/50">
                        <div className="text-sm text-zinc-500">
                            Showing {((currentPage - 1) * itemsPerPage) + 1} to {Math.min(currentPage * itemsPerPage, filteredLeads.length)} of {filteredLeads.length} leads
                        </div>
                        <div className="flex items-center gap-2">
                            <button 
                                disabled={currentPage === 1}
                                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                                className="px-3 py-1 bg-zinc-800 text-zinc-300 rounded-lg disabled:opacity-50 text-sm hover:bg-zinc-700 transition-colors"
                            >
                                Previous
                            </button>
                            <span className="text-sm text-zinc-400 px-2">Page {currentPage} of {totalPages}</span>
                            <button 
                                disabled={currentPage === totalPages}
                                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                                className="px-3 py-1 bg-zinc-800 text-zinc-300 rounded-lg disabled:opacity-50 text-sm hover:bg-zinc-700 transition-colors"
                            >
                                Next
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
