"use client";

import React, { useState, useEffect } from "react";
import { Database, Filter, Loader2, Search, CheckCircle, AlertCircle, XCircle, Trash2, Download, ShieldCheck, RefreshCcw, Zap, Phone, Radar, Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import { verifyLeadEmailAction, bulkDeleteLeadsAction, toggleContactedAction, generateHookAction, importLeadsAction, pushLeadsToInboxAction } from "@/app/actions/crm-actions";
import Papa from "papaparse";

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

export default function CrmDatabase() {
    const [leads, setLeads] = useState<LeadRecord[]>([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState<string>('ALL');
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [verifying, setVerifying] = useState(false);
    const [generatingHooks, setGeneratingHooks] = useState(false);
    const [currentPage, setCurrentPage] = useState(1);
    const itemsPerPage = 100;

    // Reset page when filter changes
    useEffect(() => {
        setCurrentPage(1);
    }, [filter]);

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
        if (filter === 'ALL') return true;
        if (filter === 'CONTACTED') return l.contacted;
        
        // Raw location tabs (Inbox only)
        if (['UK', 'USA', 'CANADA'].includes(filter)) {
            return l.pipeline_status === 'INBOX' && l.location?.toUpperCase() === filter;
        }
        
        // Qualified location tabs
        if (['UK_QUALIFIED', 'USA_QUALIFIED', 'CANADA_QUALIFIED'].includes(filter)) {
            const loc = filter.split('_')[0]; // UK, USA, CANADA
            return l.pipeline_status === 'OUTREACH' && (l.email_status === 'VALID' || l.email_status === 'RISKY') && !!l.hook && l.location?.toUpperCase() === loc;
        }

        return l.pipeline_status === filter;
    });

    const totalPages = Math.max(1, Math.ceil(filteredLeads.length / itemsPerPage));
    const paginatedLeads = filteredLeads.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);

    const handleUploadCsv = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        Papa.parse(file, {
            complete: async (results) => {
                const headers = results.meta?.fields?.map(h => h.toLowerCase().trim()) || [];
                const urlCol = results.meta?.fields?.find((_, i) => ['url', 'linkedin', 'linkedin url', 'linkedin_url', 'profile'].includes(headers[i]));
                const locCol = results.meta?.fields?.find((_, i) => ['location', 'country'].includes(headers[i]));
                const nameCol = results.meta?.fields?.find((_, i) => ['name', 'first name'].includes(headers[i]));
                
                if (!urlCol) {
                    alert("Could not find a URL column in the CSV.");
                    return;
                }

                setLoading(true);
                const leadsToImport = (results.data as any[])
                    .filter(row => row[urlCol] && row[urlCol].trim() !== '')
                    .map(row => ({
                        linkedin_url: row[urlCol],
                        location: locCol ? row[locCol] : 'Unknown',
                        first_name: nameCol ? row[nameCol] : 'Unknown',
                        pipeline_status: 'INBOX'
                    }));
                
                await importLeadsAction(leadsToImport);
                await fetchLeads();
                setLoading(false);
                alert(`Imported ${leadsToImport.length} leads successfully!`);
            },
            header: true,
            skipEmptyLines: true
        });
        e.target.value = '';
    };

    const handlePushToAll = async () => {
        if (filteredLeads.length === 0) return;
        const idsToPush = selectedIds.size > 0 ? Array.from(selectedIds) : filteredLeads.map(l => l.id);
        if (!confirm(`Are you sure you want to push ${idsToPush.length} leads to All (INBOX)?`)) return;
        
        setLoading(true);
        await pushLeadsToInboxAction(idsToPush);
        await fetchLeads();
        setSelectedIds(new Set());
        setLoading(false);
    };

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
        
        for (const id of Array.from(selectedIds)) {
            try {
                await verifyLeadEmailAction(id);
                // Update local state for immediate feedback
                const updatedLead = await (await fetch('/api/crm/leads')).json();
                if(updatedLead.success) {
                     setLeads(updatedLead.data);
                }
            } catch (err) {
                console.error("Failed to verify", id, err);
            }
        }
        
        setVerifying(false);
        setSelectedIds(new Set()); // Clear selection
    };

    const handleGenerateHooksSelected = async () => {
        if (selectedIds.size === 0) return;
        setGeneratingHooks(true);
        
        for (const id of Array.from(selectedIds)) {
            try {
                await generateHookAction(id);
                const updatedLead = await (await fetch('/api/crm/leads')).json();
                if(updatedLead.success) {
                     setLeads(updatedLead.data);
                }
            } catch (err) {
                console.error("Failed to generate hook", id, err);
            }
        }
        
        setGeneratingHooks(false);
        setSelectedIds(new Set());
    };

    const handleAutoGenerateMissingHooks = async () => {
        // Find leads with no hook
        const missingHookLeads = leads.filter(l => !l.hook || l.hook.trim() === '');
        if (missingHookLeads.length === 0) {
            alert("No leads are missing hooks!");
            return;
        }
        
        if (!confirm(`Auto-generate hooks for ${missingHookLeads.length} leads? This may take a while.`)) return;
        
        setGeneratingHooks(true);
        for (const lead of missingHookLeads) {
            try {
                await generateHookAction(lead.id);
            } catch (err) {
                console.error("Failed to auto-generate hook", lead.id, err);
            }
        }
        // Refetch after all done
        await fetchLeads();
        setGeneratingHooks(false);
    };

    const handleToggleContacted = async (id: string, currentVal: boolean) => {
        await toggleContactedAction(id, !currentVal);
        const updatedLead = await (await fetch('/api/crm/leads')).json();
        if(updatedLead.success) setLeads(updatedLead.data);
    };

    const handleDeleteSelected = async () => {
        if (selectedIds.size === 0) return;
        if (!confirm(`Are you sure you want to delete ${selectedIds.size} leads?`)) return;
        
        const ids = Array.from(selectedIds);
        await bulkDeleteLeadsAction(ids);
        setLeads(leads.filter(l => !ids.includes(l.id)));
        setSelectedIds(new Set());
    };

    const handleExportValid = () => {
        // Export only VALID and RISKY leads
        const toExport = filteredLeads.filter(l => l.email_status === 'VALID' || l.email_status === 'RISKY');
        if (toExport.length === 0) {
            alert("No valid or risky leads found to export.");
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
        link.download = `Revlane_Verified_Leads_${new Date().toISOString().split('T')[0]}.csv`;
        link.click();
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
                                onClick={handleDeleteSelected}
                                className="bg-danger/20 text-danger border border-danger/30 px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-danger/30 transition-all flex items-center gap-2"
                            >
                                <Trash2 className="w-4 h-4" />
                                Delete
                            </button>
                        </div>
                    ) : (
                        <div className="flex items-center gap-2">
                            <button 
                                onClick={handleExportValid}
                                className="bg-accent text-black px-4 py-1.5 rounded-lg text-sm font-medium hover:bg-accent shadow-lg shadow-accent/20 transition-all flex items-center gap-2"
                            >
                                <Download className="w-4 h-4" />
                                Export Verified
                            </button>
                                <div className="bg-black/50 p-1 rounded-xl border border-zinc-800 flex items-center text-sm ml-2 overflow-x-auto max-w-[500px]">
                                <button onClick={() => setFilter('ALL')} className={cn("whitespace-nowrap px-3 py-1.5 rounded-lg transition-all", filter === 'ALL' ? "bg-zinc-800 text-white" : "text-zinc-500 hover:text-zinc-300")}>All</button>
                                <div className="w-px h-4 bg-zinc-800 mx-1"></div>
                                <button onClick={() => setFilter('LEADS')} className={cn("whitespace-nowrap px-3 py-1.5 rounded-lg transition-all flex items-center gap-1", filter === 'LEADS' ? "bg-blue-500/20 text-blue-400" : "text-zinc-500 hover:text-zinc-300")}><Radar className="w-3 h-3"/> Leads</button>
                                <div className="w-px h-4 bg-zinc-800 mx-1"></div>
                                <button onClick={() => setFilter('UK')} className={cn("whitespace-nowrap px-3 py-1.5 rounded-lg transition-all", filter === 'UK' ? "bg-accent/20 text-accent" : "text-zinc-500 hover:text-zinc-300")}>UK</button>
                                <button onClick={() => setFilter('UK_QUALIFIED')} className={cn("whitespace-nowrap px-3 py-1.5 rounded-lg transition-all flex items-center gap-1", filter === 'UK_QUALIFIED' ? "bg-accent/20 text-accent" : "text-zinc-500 hover:text-zinc-300")}><Zap className="w-3 h-3"/> UK Qual</button>
                                <div className="w-px h-4 bg-zinc-800 mx-1"></div>
                                <button onClick={() => setFilter('USA')} className={cn("whitespace-nowrap px-3 py-1.5 rounded-lg transition-all", filter === 'USA' ? "bg-accent/20 text-accent" : "text-zinc-500 hover:text-zinc-300")}>USA</button>
                                <button onClick={() => setFilter('USA_QUALIFIED')} className={cn("whitespace-nowrap px-3 py-1.5 rounded-lg transition-all flex items-center gap-1", filter === 'USA_QUALIFIED' ? "bg-accent/20 text-accent" : "text-zinc-500 hover:text-zinc-300")}><Zap className="w-3 h-3"/> USA Qual</button>
                                <div className="w-px h-4 bg-zinc-800 mx-1"></div>
                                <button onClick={() => setFilter('CANADA')} className={cn("whitespace-nowrap px-3 py-1.5 rounded-lg transition-all", filter === 'CANADA' ? "bg-accent/20 text-accent" : "text-zinc-500 hover:text-zinc-300")}>Canada</button>
                                <button onClick={() => setFilter('CANADA_QUALIFIED')} className={cn("whitespace-nowrap px-3 py-1.5 rounded-lg transition-all flex items-center gap-1", filter === 'CANADA_QUALIFIED' ? "bg-accent/20 text-accent" : "text-zinc-500 hover:text-zinc-300")}><Zap className="w-3 h-3"/> Canada Qual</button>
                                <div className="w-px h-4 bg-zinc-800 mx-1"></div>
                                <button onClick={() => setFilter('OUTREACH')} className={cn("whitespace-nowrap px-3 py-1.5 rounded-lg transition-all", filter === 'OUTREACH' ? "bg-accent/20 text-accent" : "text-zinc-500 hover:text-zinc-300")}>Outreach</button>
                                <button onClick={() => setFilter('ENRICHMENT')} className={cn("whitespace-nowrap px-3 py-1.5 rounded-lg transition-all", filter === 'ENRICHMENT' ? "bg-amber-500/20 text-amber-400" : "text-zinc-500 hover:text-zinc-300")}>Enrichment</button>
                                <button onClick={() => setFilter('CONTACTED')} className={cn("whitespace-nowrap px-3 py-1.5 rounded-lg transition-all flex items-center gap-1", filter === 'CONTACTED' ? "bg-purple-500/20 text-purple-400" : "text-zinc-500 hover:text-zinc-300")}><Phone className="w-3 h-3"/> Contacted</button>
                            </div>
                            
                            {filter === 'ALL' && (
                                <div>
                                    <input type="file" id="upload-csv" className="hidden" accept=".csv" onChange={handleUploadCsv} />
                                    <label htmlFor="upload-csv" className="bg-zinc-800 text-zinc-300 border border-zinc-700 px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-zinc-700 transition-all flex items-center gap-2 ml-2 cursor-pointer whitespace-nowrap">
                                        <Upload className="w-4 h-4" />
                                        Upload CSV
                                    </label>
                                </div>
                            )}

                            {filter === 'LEADS' && (
                                <button 
                                    onClick={handlePushToAll}
                                    className="bg-blue-500/20 text-blue-400 border border-blue-500/30 px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-blue-500/30 transition-all flex items-center gap-2 ml-2 whitespace-nowrap"
                                >
                                    Push to All
                                </button>
                            )}
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

                {/* Table Area */}
                <div className="flex-1 overflow-auto">
                    <table className="w-full text-sm text-left">
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
                                    <td colSpan={8} className="px-4 py-12 text-center text-zinc-500">
                                        <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />
                                        Loading CRM data...
                                    </td>
                                </tr>
                            ) : filteredLeads.length === 0 ? (
                                <tr>
                                    <td colSpan={9} className="px-4 py-12 text-center text-zinc-500">
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
                                                lead.pipeline_status === 'INBOX' && "bg-zinc-800 text-zinc-400"
                                            )}>
                                                {lead.pipeline_status}
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
                                        <td className="px-4 py-3 text-zinc-400 text-xs">{lead.location || <span className="text-zinc-600 italic">—</span>}</td>
                                        <td className="px-4 py-3 text-accent font-mono text-xs">{lead.email || <span className="text-zinc-600 italic">—</span>}</td>
                                        <td className="px-4 py-3">
                                            <span className={cn(
                                                "text-[10px] px-2 py-1 rounded-full font-bold flex items-center gap-1 w-max",
                                                lead.email_status === 'VALID' ? "bg-accent/10 text-accent border border-accent/20" :
                                                lead.email_status === 'RISKY' ? "bg-amber-500/10 text-amber-400 border border-amber-500/20" :
                                                lead.email_status === 'INVALID' ? "bg-danger/10 text-danger border border-danger/20" :
                                                "bg-zinc-800 text-zinc-500"
                                            )}>
                                                {lead.email_status === 'VALID' && <CheckCircle className="w-3 h-3" />}
                                                {lead.email_status === 'RISKY' && <AlertCircle className="w-3 h-3" />}
                                                {lead.email_status === 'INVALID' && <XCircle className="w-3 h-3" />}
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
