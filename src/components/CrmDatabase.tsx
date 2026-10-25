"use client";
import { AI_HOOK_GENERATION_ENABLED } from "@/lib/hook-settings";

import React, { useState, useEffect, useRef } from "react";
import { Loader2, Search, AlertCircle, XCircle, Trash2, Download, ShieldCheck, RefreshCcw, Zap, Phone, Radar, Upload, Mail, ChevronDown, Settings2, Ban, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { hasFreshSmtpProof, hasExpiredSmtpProof } from '@/lib/email-verification-proof';
import VerificationProviderStatus from '@/components/VerificationProviderStatus';
import { verifyLeadEmailsAction, bulkDeleteLeadsAction, toggleContactedAction, generateHookAction, importLeadsAction, markLeadsContactedAction, setLeadOutcomeAction, setDoNotContactAction, suppressJunkAddressesAction } from "@/app/actions/crm-actions";
import { syncContactedFromGmailAction, clearUnconfirmedContactedAction, type GmailSyncReport } from "@/app/actions/gmail-actions";
import { importCampaignReportsAction } from "@/app/actions/campaign-import-actions";
import { syncBouncesAction } from "@/app/actions/bounce-actions";
import { isExportableUnverifiable, wasRefusedByHost } from "@/lib/send-tiers";
import { startVerificationRun, addVerificationBatch, getUnknownLabel, UNKNOWN_CAUSE_LABELS, type VerificationRun, type UnknownCause } from '@/lib/crm-email-verification';
import { importCrmLeadsToHunterAction, markCrmLeadLinkedinDmSentAction } from "@/app/actions/linkedin-outreach-actions";
import FollowerEvidence from './FollowerEvidence';
import { isQualifiedRecord, hasQualifiedEmail, type ProspectAssessment } from '@/lib/prospect-qualification.cjs';
import './acquisition-workspace.css';


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
    email_verification_method?: string | null;
    email_verification_expires_at?: string | null;
    /** Only a real verification run writes this. A backfill leaves it null. */
    email_verification_score?: number | null;
    /**
     * The verifier's own words, including the server's refusal text when there was
     * one. This is what separates "the mailbox is gone" from "the recipient server
     * refused this computer" — the two look identical without it.
     */
    email_verification_reason?: string | null;
    hook: string;
    hook_source?: string | null;
    pipeline_status: string;
    location: string;
    contacted: boolean;
    in_hunter?: boolean;
    /** PLATFORM = the sending platform confirmed it, GMAIL = found in Sent Mail. */
    contacted_source?: string | null;
    linkedin_dm_at?: string | null;
    outcome?: string | null;
    do_not_contact?: boolean;
    created_at: string;
    prospect_assessment?: ProspectAssessment | null;
}

/** Leads written before the OUTREACH stage was retired still carry it. */
const isQualifiedStage = (status: string) => status === 'QUALIFIED' || status === 'OUTREACH';

/**
 * A VALID label is only trustworthy if an actual safe verification produced it and
 * that check hasn't expired.
 *
 * The score is part of the test, not decoration. A past data-recovery script
 * backfilled `email_status='VALID'` *and* `email_verification_method='SMTP_DIRECT'`
 * *and* a year-long expiry on 935 rows without ever opening a socket — forging every
 * field this gate used to check. It left `email_verification_score` null, because
 * only a real run computes one. Requiring it is what separates a measurement from
 * a label someone wrote.
 */
const isProvenValid = hasFreshSmtpProof;

/** Labelled VALID with nothing behind it — needs re-verifying before it's used. */
const isUnprovenValid = (l: LeadRecord) => l.email_status === 'VALID' && !isProvenValid(l);

/**
 * Really reached, as opposed to merely queued once. A `contacted` flag with no
 * source behind it was set when the lead was pushed to a sending platform, which
 * says nothing about whether a message went out.
 */
const isProvenContacted = (l: LeadRecord) => Boolean(l.contacted && l.contacted_source);

/**
 * The one question the CRM exists to answer: who can I email right now. Qualified,
 * a mailbox proven to exist, not suppressed, and not already reached.
 */
const isReadyToSend = (l: LeadRecord) =>
    isQualifiedStage(l.pipeline_status)
    && hasQualifiedEmail(l)
    && isProvenValid(l)
    && !l.do_not_contact
    && !isProvenContacted(l);

const isLinkedinProspect = (l: LeadRecord) =>
    isQualifiedStage(l.pipeline_status)
    && isQualifiedRecord(l)
    && /^https?:\/\/(?:www\.)?linkedin\.com\/in\/[^/?#]+/i.test(l.linkedin_url || '')
    && !l.do_not_contact
    && !isProvenContacted(l);

const OUTCOMES = [
    { value: '', label: '—' },
    { value: 'NO_REPLY', label: 'No reply' },
    { value: 'REPLIED', label: 'Replied' },
    { value: 'BOOKED', label: 'Booked' },
    { value: 'NOT_INTERESTED', label: 'Not interested' },
    { value: 'BOUNCED', label: 'Bounced' },
];

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
    if (usKeywords.some(kw => loc.includes(kw) || loc === kw)) return 'NA';

    return 'OTHER';
}

export default function CrmDatabase({ onPushToEngine, onOpenCaseStudy }: { onPushToEngine?: (urls: string[]) => void; onOpenCaseStudy?: () => void }) {
    const [leads, setLeads] = useState<LeadRecord[]>([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState<string>('ALL');
    const [leadSearch, setLeadSearch] = useState('');
    const [recheckingFollowers,setRecheckingFollowers]=useState(false);
    const [followerNotice,setFollowerNotice]=useState('');
    async function recheckSelectedFollowers(){
        setRecheckingFollowers(true);setFollowerNotice('');
        try{const response=await fetch('/api/crm/follower-recheck',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:[...selectedIds]})});const value=await response.json();if(!response.ok)throw Error(value.error);setFollowerNotice(`${value.queuedCount} follower rechecks queued. ${value.skipped.length} already queued or unavailable. Each fresh profile counts toward its account’s daily limit.`);}
        catch(error){setFollowerNotice(error instanceof Error?error.message:'Could not queue follower rechecks.');}finally{setRecheckingFollowers(false);}
    }
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [hunterImporting, setHunterImporting] = useState(false);
    const [dmPendingId, setDmPendingId] = useState<string | null>(null);
    const [outreachMessage, setOutreachMessage] = useState('');
    const [outreachError, setOutreachError] = useState('');
    /**
     * Verification is slow in a way that has nothing to do with this code: most of
     * the wall clock is spent waiting on recipient servers that tarpit probes on
     * purpose (see the anti-harvesting note in CLAUDE.md). A 100-address run
     * measured at ~14 minutes. A bare spinner over that is indistinguishable from a
     * hang, which is exactly how it got reported — so the run publishes its progress
     * as it goes rather than only at the end.
     */
    const [verifyRun, setVerifyRun] = useState<VerificationRun | null>(null);
    const [verifyError, setVerifyError] = useState<string | null>(null);
    /** Set by the Stop button; read between chunks so a long run can be abandoned. */
    const cancelVerifyRef = useRef(false);
    const verifyActiveRef = useRef(false);
    const verifying = verifyRun?.phase === 'running';
    const [generatingHooks, setGeneratingHooks] = useState(false);
    const [currentPage, setCurrentPage] = useState(1);
    const itemsPerPage = 100;

    const [emailFilter, setEmailFilter] = useState<string>('ALL');
    const [hookFilter, setHookFilter] = useState<string>('ALL');

    const [gmailSyncing, setGmailSyncing] = useState(false);
    // Leads flagged contacted that the last Gmail scan couldn't find in sent mail.
    const [unconfirmedIds, setUnconfirmedIds] = useState<Set<string>>(new Set());
    // Unconfirmed leads with no trace at all — the only ones bulk-clearing may touch.
    const [safeToClearIds, setSafeToClearIds] = useState<Set<string>>(new Set());
    // Unconfirmed, but something suggests they were reached anyway.
    const [nearMissIds, setNearMissIds] = useState<Set<string>>(new Set());
    const [importingCampaigns, setImportingCampaigns] = useState(false);
    const [syncingBounces, setSyncingBounces] = useState(false);
    const campaignFileRef = useRef<HTMLInputElement>(null);
    // Maintenance actions live behind one menu. Nine buttons in a row is how the
    // toolbar came to overflow its container and hide half of itself off-screen.
    const [toolsOpen, setToolsOpen] = useState(false);
    const toolsRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!toolsOpen) return;
        const onPointerDown = (e: MouseEvent) => {
            if (toolsRef.current && !toolsRef.current.contains(e.target as Node)) setToolsOpen(false);
        };
        const onEscape = (e: KeyboardEvent) => { if (e.key === 'Escape') setToolsOpen(false); };
        document.addEventListener('mousedown', onPointerDown);
        document.addEventListener('keydown', onEscape);
        return () => {
            document.removeEventListener('mousedown', onPointerDown);
            document.removeEventListener('keydown', onEscape);
        };
    }, [toolsOpen]);
    // What was actually sent, grouped by subject, from the last Gmail scan.
    const [campaigns, setCampaigns] = useState<GmailSyncReport['campaigns']>([]);
    const [showCampaigns, setShowCampaigns] = useState(false);
    /** Set when the table couldn't be loaded, so an outage never reads as "no leads". */
    const [loadError, setLoadError] = useState<string | null>(null);

    // Reset page when filter changes
    useEffect(() => {
        setCurrentPage(1);
    }, [filter, emailFilter, hookFilter]);

    /**
     * Loads the whole table. Hosted Postgres occasionally times out on the first
     * connection after an idle spell, which used to surface as an empty grid — a
     * failed load and a genuinely empty database looked identical. One retry
     * absorbs the cold-start case; anything past that is reported rather than
     * silently swallowed.
     */
    const fetchLeads = async () => {
        setLoading(true);
        setLoadError(null);

        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const res = await fetch('/api/crm/leads');
                const data = await res.json();
                if (data.success) {
                    setLeads(data.data);
                    setLoading(false);
                    return;
                }
                if (attempt === 2) setLoadError(data.error || `Request failed (${res.status}).`);
            } catch (error: any) {
                console.error(`Failed to fetch leads (attempt ${attempt}):`, error);
                if (attempt === 2) setLoadError(error?.message || 'Could not reach the server.');
            }
        }
        setLoading(false);
    };

    useEffect(() => {
        fetchLeads();
    }, []);

    const leadQuery = leadSearch.trim().toLocaleLowerCase();
    const filteredLeads = leads.filter(l => {
        let passesPrimary = false;
        if (filter === 'ALL') passesPrimary = true;
        // Confirmed contact or reserved for outreach in Hunter.
        else if (filter === 'CONTACTED') passesPrimary = isProvenContacted(l);
        else if (filter === 'HUNTER') passesPrimary = Boolean(l.in_hunter);
        // The whole point of the CRM in one tab: qualified, provably deliverable,
        // not suppressed, not already reached.
        else if (filter === 'READY') passesPrimary = isReadyToSend(l);
        else if (filter === 'LINKEDIN') passesPrimary = isLinkedinProspect(l);
        // Flagged contacted, but the last Gmail scan found no sent mail to them.
        else if (filter === 'UNCONFIRMED') passesPrimary = unconfirmedIds.has(l.id);

        // Hide contacted leads and Hunter reservations from active pipeline views. A
        // lead merely queued to a sending platform stays visible — it still needs
        // an email, and hiding it is what made hundreds of them disappear.
        else if (isProvenContacted(l)) passesPrimary = false;
        
        // Raw location tabs (Inbox only)
        else if (['UK', 'NA'].includes(filter)) {
            passesPrimary = l.pipeline_status === 'INBOX' && resolveCountry(l.location) === filter;
        }
        
        // Qualified tabs hold every lead the scraper cleared, verified or not.
        // Email status is a column you filter on, not a reason to disappear.
        else if (['UK_QUALIFIED', 'NA_QUALIFIED'].includes(filter)) {
            const loc = filter.split('_QUALIFIED')[0]; // UK, NA
            passesPrimary = isQualifiedStage(l.pipeline_status) && resolveCountry(l.location) === loc;
        }
        else {
            passesPrimary = l.pipeline_status === filter;
        }

        if (!passesPrimary) return false;
        if (leadQuery && ![l.first_name, l.last_name, `${l.first_name || ''} ${l.last_name || ''}`, l.company, l.email, l.website, l.linkedin_url]
            .some(value => String(value || '').toLocaleLowerCase().includes(leadQuery))) return false;

        if (emailFilter === 'PROVEN_VALID') { if (!isProvenValid(l)) return false; }
        else if (emailFilter === 'UNPROVEN_VALID') { if (!isUnprovenValid(l)) return false; }
        else if (emailFilter !== 'ALL' && l.email_status !== emailFilter) return false;

        if (hookFilter === 'HAS_HOOK' && (!l.hook || l.hook.trim() === '')) return false;
        if (hookFilter === 'NO_HOOK' && (l.hook && l.hook.trim() !== '')) return false;

        return true;
    });

    // Surface the strongest researched practices in the existing outreach views.
    // Missing testimonials/activity can lower priority without hiding a match.
    if (['READY', 'UK_QUALIFIED', 'NA_QUALIFIED', 'LINKEDIN'].includes(filter)) {
        filteredLeads.sort((a, b) => (b.prospect_assessment?.score || 0) - (a.prospect_assessment?.score || 0));
    }

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

    // Small batches expose saved results and the latest provider credit balance quickly.
    // Two concurrent provider checks, each with one retry, fit within the hosted action budget.
    const VERIFY_CHUNK = 4;

    const handleVerifySelected = async () => {
        if (selectedIds.size === 0 || verifyActiveRef.current) return;

        const idsToVerify = Array.from(selectedIds);

        cancelVerifyRef.current = false;
        verifyActiveRef.current = true;
        setVerifyError(null);
        setVerifyRun(startVerificationRun(idsToVerify.length));

        for (let i = 0; i < idsToVerify.length; i += VERIFY_CHUNK) {
            if (cancelVerifyRef.current) break;
            const chunk = idsToVerify.slice(i, i + VERIFY_CHUNK);
            try {
                const report = await verifyLeadEmailsAction(chunk);
                if (report.updated.length) {
                    // Merge the whole updated row, not just the status: the method and
                    // expiry are what decide whether this lead can be exported.
                    const byId = new Map(report.updated.map(u => [u.id, u]));
                    setLeads(prev => prev.map(l => byId.has(l.id) ? { ...l, ...byId.get(l.id)! } : l));
                }
                setVerifyRun(prev => prev && addVerificationBatch(prev, report));
                if (report.failed.length) {
                    setVerifyError(report.failed[0].reason + ' Unfinished rows remain selected for retry.');
                }
                // Only saved results and explicit skips are cleared. Failures remain retryable.
                const settledIds = new Set([...report.updated, ...report.skipped].map(row => row.id));
                setSelectedIds(prev => new Set([...prev].filter(id => !settledIds.has(id))));
                if (report.stopRun) { cancelVerifyRef.current = true; break; }
            } catch (err) {
                // A failed chunk used to vanish into the browser console, which is why
                // a broken run and a slow one looked identical from the table.
                console.error("Failed to verify batch", err);
                setVerifyError(err instanceof Error ? err.message : String(err));
                setVerifyRun(prev => prev && ({ ...prev, processed: prev.processed + chunk.length, failed: prev.failed + chunk.length }));
                // A failed request is not a mailbox verdict. Retain selection and stop
                // instead of repeating an infrastructure/configuration failure.
                cancelVerifyRef.current = true;
                break;
            }
        }

        const stopped = cancelVerifyRef.current;
        setVerifyRun(prev => prev && ({ ...prev, phase: stopped ? 'stopped' : 'complete' }));
        cancelVerifyRef.current = false;
        verifyActiveRef.current = false;
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
            const saved = await toggleContactedAction(id, !currentVal);
            if (saved) setLeads(prev => prev.map(l => l.id === id ? saved : l));
        } catch (error: any) {
            // Revert on failure
            setLeads(prev => prev.map(l => l.id === id ? { ...l, contacted: currentVal } : l));
            setOutreachError(error.message || 'Could not update contact status');
        }
    };

    const handleGmailSync = async () => {
        if (gmailSyncing) return;
        if (!confirm('Scan your Gmail Sent Mail and reconcile the Contacted flag?\n\nRead-only — nothing in Gmail is changed. Leads found in sent mail are marked contacted with their real send date. Nothing is ever un-marked automatically.')) return;

        setGmailSyncing(true);
        try {
            const report = await syncContactedFromGmailAction();

            const accountLines = report.accounts
                .map(a => a.error
                    ? `  ${a.email}: FAILED — ${a.error}`
                    : `  ${a.email} via ${a.provider || 'IMAP'}: ${a.messagesScanned} sent messages, ${a.recipients} unique recipients`)
                .join('\n');

            if (!report.ok) {
                alert(`Gmail sync failed.\n\n${accountLines}\n\n${report.error || ''}`);
                return;
            }

            setUnconfirmedIds(new Set(report.unconfirmed.ids));
            setSafeToClearIds(new Set(report.unconfirmed.safeIds));
            setNearMissIds(new Set(report.unconfirmed.nearMiss.ids));
            setCampaigns(report.campaigns);
            await fetchLeads();

            alert(
                `Gmail sync complete.\n\n${accountLines}\n\n` +
                `COVERAGE\n` +
                `  Leads with an email: ${report.coverage.leadsWithEmail}\n` +
                `  Outbound recipients found in Gmail: ${report.coverage.outboundRecipients}\n` +
                `  Leads matched exactly: ${report.coverage.exactMatches}\n` +
                (report.sameCompany.count ? `  Different person emailed at the same company: ${report.sameCompany.count}\n` : '') +
                `\nQUALIFIED LEADS — ${report.qualified.total} total\n` +
                `  Actually emailed: ${report.qualified.confirmedContacted}\n` +
                `  Not confirmed emailed (includes LinkedIn-only outreach): ${report.qualified.notContacted}\n\n` +
                `CHANGES\n` +
                `  Newly marked contacted: ${report.newlyMarked}\n` +
                `  Already marked: ${report.alreadyMarked}\n` +
                `  Real send dates recorded: ${report.datesRecorded}\n\n` +
                (report.scanComplete ? '' :
                    `\n⚠ A mailbox failed to scan, so this run is incomplete. Clearing is disabled — ` +
                    `a partial scan finds fewer sends and would offer up leads you really did contact. Re-run it.\n`) +
                `\nMARKED CONTACTED BUT NOT FOUND IN SENT MAIL — ${report.unconfirmed.total}` +
                (report.unconfirmed.inQualifiedStage ? ` (${report.unconfirmed.inQualifiedStage} in a qualified tab)` : '') +
                (report.unconfirmed.total
                    ? `\n  No trace of any kind — safe to clear: ${report.scanComplete ? report.unconfirmed.safeIds.length : 'withheld (partial scan)'}\n` +
                      `  Possibly already reached — leave alone: ${report.unconfirmed.nearMiss.count}\n` +
                      (report.unconfirmed.nearMiss.examples.length
                          ? `\n  e.g. ${report.unconfirmed.nearMiss.examples.slice(0, 3).map(x => `${x.lead} — ${x.reason} (${x.emailedInstead})`).join('\n       ')}\n`
                          : '') +
                      `\nShown under the "Unconfirmed" tab. Nothing was un-marked — a lead may still have been reached on LinkedIn or from a mailbox that isn't connected here.`
                    : '')
            );
        } catch (err: any) {
            alert(`Gmail sync error: ${err?.message || 'Unknown error'}`);
        } finally {
            setGmailSyncing(false);
        }
    };

    const handleClearUnconfirmed = async () => {
        // Only the leads with no trace at all. Near misses — where a colleague or a
        // name-alike address was emailed — stay flagged: clearing those would send a
        // second cold email to someone who already received one.
        const ids = [...safeToClearIds];
        if (ids.length === 0) return;
        const held = nearMissIds.size;
        if (!confirm(
            `Clear the Contacted flag on ${ids.length} leads with no trace in your sent mail?` +
            (held ? `\n\n${held} other unconfirmed leads will be left flagged — a colleague at their company, or an address matching their name, was emailed.` : '') +
            `\n\nThey may still have been reached on LinkedIn or from a mailbox that isn't connected here.`
        )) return;

        const clearing = new Set(ids);
        setLeads(prev => prev.map(l => clearing.has(l.id) ? { ...l, contacted: false } : l));
        setUnconfirmedIds(prev => new Set([...prev].filter(id => !clearing.has(id))));
        setSafeToClearIds(new Set());
        setFilter('ALL');
        clearUnconfirmedContactedAction(ids).catch(() => fetchLeads());
    };

    /**
     * Imports campaign reports from the sending platform. This is the authoritative
     * record — it knows both who was sent to and who was only uploaded — so unlike
     * the Gmail sync it is allowed to correct a wrong `contacted` flag downward.
     */
    const handleImportCampaignReports = async (fileList: FileList | null) => {
        if (!fileList?.length) return;
        setImportingCampaigns(true);
        try {
            const files = await Promise.all(
                [...fileList].map(async f => ({ name: f.name, content: await f.text() }))
            );
            const report = await importCampaignReportsAction(files);

            if (!report.ok) {
                alert(`Campaign import failed.\n\n${report.error || ''}`);
                return;
            }

            await fetchLeads();
            // These flags came from the old state; a fresh Gmail sync recomputes them.
            setUnconfirmedIds(new Set());
            setSafeToClearIds(new Set());
            setNearMissIds(new Set());

            const fileLines = report.files
                .map(f => `  ${f.error ? `${f.source}: ${f.error}` : `${f.source}: ${f.rows} rows, ${f.sent} sent`}`)
                .join('\n');

            alert(
                `Campaign reports imported.\n\n${fileLines}\n\n` +
                `PLATFORM RECORD\n` +
                `  People uploaded: ${report.platform.uploaded}\n` +
                `  Actually sent to: ${report.platform.sent}\n` +
                `  Uploaded but never sent: ${report.platform.uploaded - report.platform.sent}\n` +
                `  Replied: ${report.platform.replied}   Bounced: ${report.platform.bounced}\n\n` +
                `MATCHED TO THIS CRM\n` +
                `  Confirmed sent: ${report.matched.sent}\n` +
                `  Proven never sent: ${report.matched.uploadedNotSent}\n` +
                `  Replies: ${report.matched.replied}   Bounces: ${report.matched.bounced}\n\n` +
                `APPLIED\n` +
                `  Newly marked contacted: ${report.applied.markedContacted}\n` +
                `  Existing flags confirmed by the platform: ${report.applied.sendsConfirmed}\n` +
                `  Contacted flag corrected (never sent): ${report.applied.clearedContacted}\n` +
                `  Replies recorded: ${report.applied.repliesRecorded}\n` +
                `  Bounces suppressed (do-not-contact): ${report.applied.bouncesSuppressed}` +
                (report.replierExamples.length
                    ? `\n\nREPLIES — follow these up:\n  ${report.replierExamples.map(r => `${r.name} <${r.email}>`).join('\n  ')}`
                    : '')
            );
        } catch (err: any) {
            alert(`Campaign import error: ${err?.message || 'Unknown error'}`);
        } finally {
            setImportingCampaigns(false);
            if (campaignFileRef.current) campaignFileRef.current.value = '';
        }
    };

    /**
     * Suppresses addresses that can't be a lead's own mailbox. These verify fine —
     * they're real mailboxes, just someone else's — so only a name check catches them.
     */
    const handleSuppressJunk = async () => {
        if (!confirm("Scan every lead for addresses that can't belong to them — website placeholders, vendor and registrar contacts, mangled crawler output — and add them to do-not-contact?\n\nNothing is deleted; the LinkedIn URL stays re-scrapeable.")) return;
        try {
            const report = await suppressJunkAddressesAction();
            await fetchLeads();
            const reasons = Object.entries(report.byReason).map(([reason, n]) => `  ${reason}: ${n}`).join('\n');
            alert(
                report.suppressed === 0
                    ? 'No junk addresses found — the list is clean.'
                    : `Suppressed ${report.suppressed} addresses.\n\n${reasons}\n\n` +
                      `e.g. ${report.examples.slice(0, 6).map(e => e.email).join('\n     ')}`
            );
        } catch (err: any) {
            alert(`Junk scan failed: ${err?.message || 'Unknown error'}`);
        }
    };

    /**
     * Reads delivery-failure reports out of the inbox and suppresses the leads they
     * name. Worth running after every send — repeatedly mailing dead addresses is
     * what damages a sending domain, and the harm accumulates quietly.
     */
    const handleSyncBounces = async () => {
        if (syncingBounces) return;
        setSyncingBounces(true);
        try {
            const report = await syncBouncesAction();
            if (!report.ok) {
                alert(`Bounce scan failed.\n\n${report.error || ''}`);
                return;
            }
            await fetchLeads();
            const accountLines = report.accounts
                .map(a => a.error ? `  ${a.email}: ${a.error}` : `  ${a.email}: ${a.messagesExamined} reports read, ${a.bounces} addresses`)
                .join('\n');
            alert(
                `Bounce scan complete.\n\n${accountLines}\n\n` +
                `DEAD MAILBOXES — these do not exist: ${report.deadMailboxes}\n` +
                `  Newly suppressed: ${report.suppressed}\n` +
                `  Already suppressed: ${report.alreadySuppressed}\n` +
                `  Not in this CRM: ${report.unmatched}\n` +
                (report.policyBlocked
                    ? `\n⚠ REFUSED ON POLICY — ${report.policyBlocked} (NOT suppressed, these people are real)\n` +
                      `  The recipient rejected your mail as spam or blocklisted your sender.\n` +
                      `  This is a deliverability problem with your sending domain, not a bad list.\n` +
                      (report.policyExamples.length
                          ? `  ${report.policyExamples.slice(0, 5).map(e => `${e.email} — ${(e.diagnostic || e.status || '').slice(0, 70)}`).join('\n  ')}\n`
                          : '')
                    : '') +
                (report.mailboxFull ? `\nMailbox full (real, retry later): ${report.mailboxFull}\n` : '') +
                (report.softFound ? `Temporary deferrals (platform retries these): ${report.softFound}\n` : '') +
                (report.examples.length
                    ? `\nSuppressed:\n  ${report.examples.slice(0, 10).map(e => `${e.email}${e.status ? ` (${e.status})` : ''}`).join('\n  ')}`
                    : '')
            );
        } catch (err: any) {
            alert(`Bounce scan error: ${err?.message || 'Unknown error'}`);
        } finally {
            setSyncingBounces(false);
        }
    };

    const handleSetOutcome = async (id: string, outcome: string) => {
        const previous = leads.find(l => l.id === id);
        // A negative outcome also suppresses the lead, so mirror that locally.
        const suppresses = outcome === 'NOT_INTERESTED' || outcome === 'BOUNCED';
        setLeads(prev => prev.map(l => l.id === id
            ? { ...l, outcome, do_not_contact: suppresses ? true : l.do_not_contact }
            : l));
        try {
            await setLeadOutcomeAction(id, outcome);
        } catch {
            setLeads(prev => prev.map(l => l.id === id ? { ...l, outcome: previous?.outcome ?? null, do_not_contact: previous?.do_not_contact } : l));
        }
    };

    const handleSuppressSelected = async () => {
        if (selectedIds.size === 0) return;
        if (!confirm(`Add ${selectedIds.size} leads to the do-not-contact list? They'll be excluded from every send-list export.`)) return;

        const ids = Array.from(selectedIds);
        setLeads(prev => prev.map(l => ids.includes(l.id) ? { ...l, do_not_contact: true } : l));
        setSelectedIds(new Set());
        setDoNotContactAction(ids, true).catch(() => fetchLeads());
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

    const handleImportToHunter = async () => {
        const ids = [...selectedIds];
        if (!ids.length || hunterImporting) return;
        setHunterImporting(true);
        setOutreachError('');
        setOutreachMessage('');
        try {
            const result = await importCrmLeadsToHunterAction(ids);
            const added = new Map(result.added.map((item) => [item.leadId, item]));
            if (added.size) setLeads((current) => current.map((lead) => added.has(lead.id) ? {
                ...lead,
                contacted: true,
                in_hunter: true,
                contacted_source: lead.contacted_source || (added.get(lead.id)?.sentAt ? 'LINKEDIN' : 'HUNTER'),
                linkedin_dm_at: added.get(lead.id)?.sentAt || lead.linkedin_dm_at || null,
            } : lead));
            const imported = result.added.filter((item) => !item.existing).length;
            const linked = result.added.length - imported;
            setOutreachMessage(`${imported} added to CRM outreach, ${linked} already there${result.skipped.length ? `, ${result.skipped.length} skipped (${[...new Set(result.skipped.map((item) => item.reason))].join('; ')})` : ''}. No scan or DM was started.`);
            setSelectedIds(new Set());
        } catch (error) {
            setOutreachError(error instanceof Error ? error.message : 'Could not add the selected leads to CRM outreach.');
        } finally {
            setHunterImporting(false);
        }
    };

    const handleMarkLinkedinDmSent = async (id: string) => {
        if (dmPendingId) return;
        setDmPendingId(id);
        setOutreachError('');
        setOutreachMessage('');
        try {
            const result = await markCrmLeadLinkedinDmSentAction(id);
            setLeads((current) => current.map((lead) => lead.id === id ? {
                ...lead,
                contacted: true,
                contacted_source: lead.contacted_source || 'LINKEDIN',
                linkedin_dm_at: result.sentAt,
            } : lead));
            setOutreachMessage(result.alreadyRecorded
                ? 'That LinkedIn DM was already recorded.'
                : result.stage === 'MESSAGED'
                    ? 'LinkedIn DM recorded in the Lead CRM and Hunter. Follow-up is due in 48 hours.'
                    : 'LinkedIn DM recorded in the Lead CRM and Hunter. The Hunter kept its current stage.');
        } catch (error) {
            setOutreachError(error instanceof Error ? error.message : 'Could not record the LinkedIn DM.');
        } finally {
            setDmPendingId(null);
        }
    };

    const exportCsv = (toExport: LeadRecord[], filenamePrefix: string) => {
        if (toExport.length === 0) {
            alert(`No leads found for export.`);
            return;
        }
        const headers = ['First Name', 'Last Name', 'Company', 'Email', 'Email Status', 'Location', 'Pipeline Status', 'Hook', 'Hook Source', 'Outcome', 'LinkedIn URL', 'Website', 'Contacted', 'Created At'];
        const csvRows = toExport.map(l => [
            `"${(l.first_name || '').replace(/"/g, '""')}"`,
            `"${(l.last_name || '').replace(/"/g, '""')}"`,
            `"${(l.company || '').replace(/"/g, '""')}"`,
            `"${(l.email || '').replace(/"/g, '""')}"`,
            `"${(l.email_status || '').replace(/"/g, '""')}"`,
            `"${(l.location || '').replace(/"/g, '""')}"`,
            `"${(l.pipeline_status || '').replace(/"/g, '""')}"`,
            `"${(l.hook || '').replace(/"/g, '""')}"`,
            `"${(l.hook_source || '').replace(/"/g, '""')}"`,
            `"${(l.outcome || '').replace(/"/g, '""')}"`,
            `"${(l.linkedin_url || '').replace(/"/g, '""')}"`,
            `"${(l.website || '').replace(/"/g, '""')}"`,
            `"${l.contacted ? 'Yes' : 'No'}"`,
            `"${l.created_at || ''}"`
        ].join(','));
        
        const csvContent = [headers.join(','), ...csvRows].join('\n');
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${filenamePrefix}_${new Date().toISOString().split('T')[0]}.csv`;
        link.click();
    };

    const tabLabel: Record<string, string> = {
        ALL: 'All', UK: 'UK_Inbox', UK_QUALIFIED: 'UK_Qual', NA: 'NA_Inbox', NA_QUALIFIED: 'NA_Qual',
        NOT_QUALIFIED: 'Not_Qualified', CONTACTED: 'Contacted', HUNTER: 'In_Hunter', UNCONFIRMED: 'Unconfirmed',
        READY: 'Ready_To_Send'
    };

    const handleDownloadTab = () => {
        exportCsv(filteredLeads, `Compel_${tabLabel[filter] || filter}`);
    };

    /** Status exports exclude suppressed and contacted leads. Risky and unknown
     * addresses remain separate from the verified send list. */
    const sendable = (l: LeadRecord) => hasQualifiedEmail(l) && !l.do_not_contact && !isProvenContacted(l);

    /**
     * One address, one row. Franchise networks and shared company inboxes repeat the
     * same address across many leads, and a send list that repeats it mails the same
     * person several times — which reads as spam to them and to their provider.
     * Prefer the practice with stronger business evidence.
     */
    const dedupeByAddress = (list: LeadRecord[]) => {
        const best = new Map<string, LeadRecord>();
        for (const lead of list) {
            const key = lead.email.toLowerCase().trim();
            const existing = best.get(key);
            if (!existing || (lead.prospect_assessment?.score || 0) > (existing.prospect_assessment?.score || 0)) best.set(key, lead);
        }
        return [...best.values()];
    };

    const handleExportValid = () => {
        exportCsv(
            dedupeByAddress(filteredLeads.filter(l => sendable(l) && isProvenValid(l))),
            `Compel_${tabLabel[filter] || filter}_VALID`
        );
    };

    const handleExportValidAndRisky = () => {
        exportCsv(
            dedupeByAddress(filteredLeads.filter(l => sendable(l) && (isProvenValid(l) || l.email_status === 'RISKY'))),
            `Compel_${tabLabel[filter] || filter}_VALID_RISKY`
        );
    };

    const riskyLeads = dedupeByAddress(filteredLeads.filter(l => sendable(l) && l.email_status === 'RISKY'));
    const unknownLeads = dedupeByAddress(filteredLeads.filter(l => sendable(l) && l.email_status === 'UNKNOWN'));

    const handleExportRisky = () => {
        exportCsv(riskyLeads, `Compel_${tabLabel[filter] || filter}_RISKY_ONLY`);
    };

    const handleExportUnknown = () => {
        exportCsv(unknownLeads, `Compel_${tabLabel[filter] || filter}_UNKNOWN_ONLY`);
    };

    /**
     * The third tier: addresses the verifier could never get a verdict on, almost
     * always because the recipient server refused this machine's IP rather than
     * judging the mailbox. Exported on its own, never mixed into the send list,
     * and named UNVERIFIED in the filename so it cannot be mistaken for one.
     * These are meant to go to a platform that verifies from its own IPs.
     */
    const handleExportUnverifiable = () => {
        exportCsv(
            dedupeByAddress(filteredLeads.filter(l => sendable(l) && isExportableUnverifiable(l))),
            `Compel_${tabLabel[filter] || filter}_UNVERIFIED_NOT_CHECKED`
        );
    };

    const validCount = dedupeByAddress(filteredLeads.filter(l => sendable(l) && isProvenValid(l))).length;
    const riskyCount = riskyLeads.length;
    const unknownCount = unknownLeads.length;
    const unverifiableCount = dedupeByAddress(filteredLeads.filter(l => sendable(l) && isExportableUnverifiable(l))).length;
    /** Of those, the ones where a server explicitly refused this host. */
    const hostRefusedCount = filteredLeads.filter(l => sendable(l) && isExportableUnverifiable(l) && wasRefusedByHost(l)).length;
    const unprovenCount = filteredLeads.filter(l => isUnprovenValid(l)).length;
    /** The send list, counted across the whole database rather than the current tab. */
    const readyCount = dedupeByAddress(leads.filter(isReadyToSend)).length;
    const linkedinProspectCount = leads.filter(isLinkedinProspect).length;
    /** Flagged contacted by a bulk push, with nothing to show a message ever went. */
    const queuedOnlyCount = leads.filter(l => l.contacted && !l.contacted_source).length;

    return (
        // Keep the record grid in its own scroll area beneath the view controls.
        <div className="acquisition-workspace crm-workspace">
            <div className="panel crm-database-panel" aria-busy={loading}>
                {(outreachMessage || outreachError) && (
                    <div className={cn('px-4 py-2 text-sm flex items-center gap-3', outreachError ? 'text-[var(--bad)]' : 'text-[var(--signal)]')} role={outreachError ? 'alert' : 'status'}>
                        <span className="flex-1">{outreachError || outreachMessage}</span>
                    </div>
                )}
                {/* Rail 1 — the live readout and the single primary action. The
                    screen's name lives in the app header now; repeating it here
                    just pushed the numbers that matter further to the right. */}
                <div className="crm-command-bar">
                    <div className="crm-summary" aria-label="Lead database summary">
                        {/* The readout. Ready is the number the whole tool exists to produce. */}
                        <div className="crm-summary-values">
                            <div className="stat">
                                <span className="stat-value stat-value-signal">{loading ? '—' : readyCount.toLocaleString()}</span>
                                <span className="label-micro">Ready to send</span>
                            </div>
                            <div className="stat">
                                <span className="stat-value">{loading ? '—' : leads.filter(l => isQualifiedStage(l.pipeline_status)).length.toLocaleString()}</span>
                                <span className="label-micro">Qualified</span>
                            </div>
                            <div className="stat">
                                <span className="stat-value">{loading ? '—' : leads.length.toLocaleString()}</span>
                                <span className="label-micro">Total leads</span>
                            </div>
                        </div>
                    </div>

                    {selectedIds.size > 0 ? (
                        <div className="crm-commands crm-selection-actions" aria-label="Selected lead actions">
                            <span className="num text-[13px] text-[var(--signal)] mr-1">{selectedIds.size} selected</span>
                            <button type="button" className="btn btn-outline" disabled={recheckingFollowers||selectedIds.size>500} onClick={recheckSelectedFollowers}> {recheckingFollowers?'Queueing…':'Recheck followers'}</button>
                            {followerNotice&&<p role="status" className="text-xs text-[var(--text-dim)]">{followerNotice}</p>}
                            <button
                                onClick={handleVerifySelected}
                                disabled={verifying}
                                title="Verify selected emails with the configured provider. Saved results and remaining credits appear as batches finish."
                                className="btn btn-outline"
                            >
                                {verifying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
                                Verify
                            </button>
                            <button onClick={handleGenerateHooksSelected} disabled={!AI_HOOK_GENERATION_ENABLED || generatingHooks} title="AI hook generation is disabled" className="btn btn-outline">
                                {generatingHooks ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
                                {AI_HOOK_GENERATION_ENABLED ? 'Hooks' : 'AI hooks disabled'}
                            </button>
                            <button onClick={handlePushToContacted} className="btn btn-outline">
                                <Phone className="w-3.5 h-3.5" />
                                Mark contacted
                            </button>
                            <button onClick={handleSuppressSelected} title="Add to the do-not-contact list — excluded from every export, kept in the CRM" className="btn btn-outline">
                                <Ban className="w-3.5 h-3.5" />
                                Suppress
                            </button>
                            {onPushToEngine && (
                                <button onClick={handlePushToEngineSelected} className="btn btn-outline">
                                    <Radar className="w-3.5 h-3.5" />
                                    To engine
                                </button>
                            )}
                            <button onClick={handleDeleteSelected} className="btn btn-danger">
                                <Trash2 className="w-3.5 h-3.5" />
                                Delete
                            </button>
                        </div>
                    ) : (
                        <div className="crm-commands" aria-label="Lead database actions">
                            <button
                                onClick={handleExportValid}
                                disabled={validCount === 0}
                                title="Only fresh, safe-to-send verification results. Excludes do-not-contact and duplicate addresses."
                                className="btn btn-primary"
                            >
                                <Send className="w-3.5 h-3.5" />
                                Export send list
                                <span className="num opacity-70">{validCount}</span>
                            </button>

                            <button
                                onClick={handleExportRisky}
                                disabled={riskyCount === 0}
                                title="Downloads only Risky addresses in the current view. Deliverability is uncertain. Excludes contacted, suppressed and duplicate addresses."
                                className="btn btn-outline"
                            >
                                <Download className="w-3.5 h-3.5" />
                                Download Risky <span className="num">{riskyCount}</span>
                            </button>

                            <button
                                onClick={handleExportUnknown}
                                disabled={unknownCount === 0}
                                title="Downloads only Unknown addresses in the current view. These need verification before sending. Excludes contacted, suppressed and duplicate addresses."
                                className="btn btn-outline"
                            >
                                <Download className="w-3.5 h-3.5" />
                                Download Unknown <span className="num">{unknownCount}</span>
                            </button>

                            {/* Hidden pickers for the menu items below. */}
                            <input ref={fileInputRef} type="file" accept=".csv" onChange={handleFileSelected} className="hidden" />
                            <input ref={markContactedFileRef} type="file" accept=".csv" onChange={handleMarkContactedFileSelected} className="hidden" />
                            <input ref={campaignFileRef} type="file" accept=".csv" multiple className="hidden" onChange={e => handleImportCampaignReports(e.target.files)} />

                            <div className="relative" ref={toolsRef}>
                                <button
                                    type="button"
                                    onClick={() => setToolsOpen(v => !v)}
                                    aria-expanded={toolsOpen}
                                    onKeyDown={event => { if (event.key === 'Escape') setToolsOpen(false); }}
                                    className={cn("btn btn-outline", toolsOpen && "bg-[var(--surface-3)] text-[var(--text)]")}
                                >
                                    {gmailSyncing || importingCampaigns || syncingBounces
                                        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                        : <Settings2 className="w-3.5 h-3.5" />}
                                    Tools
                                    <ChevronDown className={cn("w-3 h-3 transition-transform", toolsOpen && "rotate-180")} />
                                </button>

                                {toolsOpen && (
                                    <div className="menu absolute right-0 top-full mt-1.5 z-50">
                                        <div className="label-micro px-2.5 pt-1.5 pb-1">Reconcile</div>
                                        <button
                                            className="menu-item"
                                            onClick={() => { setToolsOpen(false); handleGmailSync(); }}
                                            disabled={gmailSyncing}
                                        >
                                            <Mail className="w-3.5 h-3.5 flex-none" />
                                            <span className="flex-1">{gmailSyncing ? 'Scanning Gmail…' : 'Sync Gmail sent mail'}</span>
                                        </button>
                                        <button
                                            className="menu-item"
                                            onClick={() => { setToolsOpen(false); campaignFileRef.current?.click(); }}
                                            disabled={importingCampaigns}
                                        >
                                            <Upload className="w-3.5 h-3.5 flex-none" />
                                            <span className="flex-1">{importingCampaigns ? 'Importing…' : 'Import campaign report'}</span>
                                        </button>
                                        <button
                                            className="menu-item"
                                            onClick={() => { setToolsOpen(false); handleSyncBounces(); }}
                                            disabled={syncingBounces}
                                            title="Read delivery-failure reports from your inbox and suppress the addresses that bounced. Run this after every send."
                                        >
                                            <Ban className="w-3.5 h-3.5 flex-none" />
                                            <span className="flex-1">{syncingBounces ? 'Reading bounces…' : 'Scan inbox for bounces'}</span>
                                        </button>

                                        <div className="menu-sep" />
                                        <div className="label-micro px-2.5 pt-1 pb-1">Hygiene</div>
                                        <button className="menu-item" onClick={() => { setToolsOpen(false); handleSuppressJunk(); }}>
                                            <Ban className="w-3.5 h-3.5 flex-none" />
                                            <span className="flex-1">Scan for junk addresses</span>
                                        </button>
                                        <button className="menu-item" onClick={() => { setToolsOpen(false); handleAutoGenerateMissingHooks(); }} disabled={!AI_HOOK_GENERATION_ENABLED || generatingHooks} title="AI hook generation is disabled">
                                            <Zap className="w-3.5 h-3.5 flex-none" />
                                            <span className="flex-1">Write missing hooks</span>
                                        </button>
                                        {filter === 'UNCONFIRMED' && safeToClearIds.size > 0 && (
                                            <button className="menu-item !text-[var(--bad)]" onClick={() => { setToolsOpen(false); handleClearUnconfirmed(); }}>
                                                <XCircle className="w-3.5 h-3.5 flex-none" />
                                                <span className="flex-1">
                                                    Clear contacted on {safeToClearIds.size}
                                                    {nearMissIds.size > 0 && <span className="opacity-50"> · {nearMissIds.size} held</span>}
                                                </span>
                                            </button>
                                        )}

                                        <div className="menu-sep" />
                                        <div className="label-micro px-2.5 pt-1 pb-1">Data</div>
                                        <button
                                            className="menu-item"
                                            onClick={() => { setToolsOpen(false); handleExportValidAndRisky(); }}
                                            disabled={validCount + riskyCount === 0}
                                            title="Combined export includes unconfirmed Risky addresses."
                                        >
                                            <Download className="w-3.5 h-3.5 flex-none" />
                                            <span className="flex-1">Download Valid + Risky</span>
                                            <span className="num">{validCount + riskyCount}</span>
                                        </button>
                                        <button
                                            className="menu-item"
                                            onClick={() => { setToolsOpen(false); handleExportUnverifiable(); }}
                                            disabled={unverifiableCount === 0}
                                            title={`${unverifiableCount} unchecked business addresses, including ${hostRefusedCount} with a recorded host refusal. These need verification before sending.`}
                                        >
                                            <Download className="w-3.5 h-3.5 flex-none" />
                                            <span className="flex-1">Download unchecked business emails</span>
                                            <span className="num">{unverifiableCount}</span>
                                        </button>
                                        <button className="menu-item" onClick={() => { setToolsOpen(false); handleDownloadTab(); }}>
                                            <Download className="w-3.5 h-3.5 flex-none" />
                                            <span className="flex-1">Download this tab</span>
                                        </button>
                                        <button className="menu-item" onClick={() => { setToolsOpen(false); handleUploadClick(); }}>
                                            <Upload className="w-3.5 h-3.5 flex-none" />
                                            <span className="flex-1">Upload leads CSV</span>
                                        </button>
                                        <button className="menu-item" onClick={() => { setToolsOpen(false); handleMarkContactedUploadClick(); }}>
                                            <Phone className="w-3.5 h-3.5 flex-none" />
                                            <span className="flex-1">Mark contacted from list</span>
                                        </button>
                                    </div>
                                )}
                            </div>

                            <button onClick={fetchLeads} title="Reload" className="btn btn-outline !px-2">
                                <RefreshCcw className={cn("w-3.5 h-3.5", loading && "animate-spin")} />
                            </button>
                        </div>
                    )}
                </div>

                {/* Verification progress. Lives outside the selection toolbar on purpose:
                    each finished chunk deselects its rows, so a readout inside that block
                    would disappear on the final chunk — exactly when the totals matter. */}
                {(verifyRun || verifyError) && (
                    <div className="px-4 py-2 border-b border-[var(--line)] flex items-center gap-3 flex-wrap bg-[var(--surface-0)]">
                        {verifyRun && (
                            <>
                                {verifying ? <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--signal)] flex-none" />
                                    : <ShieldCheck className="w-3.5 h-3.5 text-[var(--text-dim)] flex-none" />}
                                <span className="text-[12px]">
                                    {verifying ? 'Processed' : verifyRun.phase === 'stopped' ? 'Stopped at' : 'Finished'} <span className="num">{verifyRun.processed}</span>
                                    <span className="text-[var(--text-faint)]"> / </span>
                                    <span className="num">{verifyRun.total}</span>
                                </span>
                                <div className="h-1 w-32 rounded-full bg-[var(--surface-3)] overflow-hidden flex-none">
                                    <div
                                        className="h-full bg-[var(--signal)] transition-all duration-500"
                                        style={{ width: `${Math.round((verifyRun.processed / Math.max(1, verifyRun.total)) * 100)}%` }}
                                    />
                                </div>
                                {verifyRun.processed > 0 && (
                                    <span className="text-[12px] text-[var(--text-dim)]">
                                        <span className="num text-[var(--signal)]">{verifyRun.valid}</span> valid
                                        <span className="text-[var(--text-faint)]"> · </span>
                                        <span className="num">{verifyRun.invalid}</span> invalid
                                        <span className="text-[var(--text-faint)]"> · </span>
                                        <span className="num">{verifyRun.risky}</span> risky
                                        <span className="text-[var(--text-faint)]"> · </span>
                                        <span className="num">{verifyRun.unknown}</span> unknown
                                        {verifyRun.noEmail > 0 && <> · <span className="num">{verifyRun.noEmail}</span> skipped (no email)</>}
                                        {verifyRun.missing > 0 && <> · <span className="num">{verifyRun.missing}</span> skipped (removed)</>}
                                        {verifyRun.failed > 0 && <> · <span className="num">{verifyRun.failed}</span> failed (retry)</>}
                                    </span>
                                )}
                                <VerificationProviderStatus provider={verifyRun.verificationProvider} remainingCredits={verifyRun.remainingCredits} />
                                <span className="label-micro">
                                    {!verifying ? 'saved results stay in the CRM' : verifyRun.processed === 0
                                        ? 'verifying selected emails'
                                        : 'results land as each batch completes'}
                                </span>
                                {verifying ? <button
                                    onClick={() => { cancelVerifyRef.current = true; }}
                                    title="Finishes the batch in flight, then stops. Everything already verified is saved, and the rest stay selected."
                                    className="btn btn-outline ml-auto flex-none"
                                >
                                    <XCircle className="w-3.5 h-3.5" />
                                    Stop
                                </button> : <button
                                    onClick={() => { setVerifyRun(null); setVerifyError(null); }}
                                    aria-label="Dismiss verification summary"
                                    className="btn btn-ghost ml-auto !px-2"
                                ><XCircle className="w-3.5 h-3.5" /></button>}
                                {verifyRun.unknown > 0 && (
                                    <div className="w-full text-[12px] text-[var(--text-dim)] leading-relaxed">
                                        <span className="text-[var(--text)]">Why unknown: </span>
                                        {(Object.keys(UNKNOWN_CAUSE_LABELS) as UnknownCause[])
                                            .filter(cause => verifyRun.causes[cause] > 0)
                                            .map(cause => `${verifyRun.causes[cause]} ${UNKNOWN_CAUSE_LABELS[cause]}`).join(' · ')}.
                                        {(verifyRun.causes.hostBlocked + verifyRun.causes.senderIdentity > 0) && (
                                            <span className="block">The receiving servers refused this probing host. Those mailboxes remain unconfirmed; resolving the IP or sender identity is needed before retrying.</span>
                                        )}
                                    </div>
                                )}
                            </>
                        )}
                        {verifyError && (
                            <span className={cn("mark mark-bad", verifyRun && "w-full")}>
                                <AlertCircle className="w-3.5 h-3.5" />
                                <span className="font-normal">Verification error: {verifyError}</span>
                            </span>
                        )}
                    </div>
                )}

                {/* Rail 2 — where you are, and how the view is narrowed. */}
                <div className="crm-view-controls">
                    <div className="crm-view-row">
                    <div className="tabs crm-view-tabs" aria-label="Lead views">
                        <button
                            onClick={() => setFilter('READY')}
                            aria-pressed={filter === 'READY'}
                            title="Qualified, mailbox proven to exist, not suppressed, not already reached. This is your send list."
                            className={cn("tab tab-signal", filter === 'READY' && "tab-active")}
                        >
                            <ShieldCheck className="w-3.5 h-3.5" /> Ready <span className="num">{readyCount}</span>
                        </button>
                        <button onClick={() => setFilter('LINKEDIN')} aria-pressed={filter === 'LINKEDIN'} title="Qualified leads with a LinkedIn profile who have not been contacted or suppressed. Email verification is not required for manual DMs." className={cn('tab', filter === 'LINKEDIN' && 'tab-active')}>
                            LinkedIn prospects <span className="num">{linkedinProspectCount}</span>
                        </button>
                        <button onClick={() => setFilter('ALL')} aria-pressed={filter === 'ALL'} className={cn("tab", filter === 'ALL' && "tab-active")}>All</button>
                        <button onClick={() => setFilter('HUNTER')} aria-pressed={filter === 'HUNTER'} title="Already managed in Case Study Hunter; kept out of new outreach lists" className={cn("tab", filter === 'HUNTER' && "tab-active")}>In Hunter <span className="num">{leads.filter((lead) => lead.in_hunter).length}</span></button>
                        <button onClick={() => setFilter('CONTACTED')} aria-pressed={filter === 'CONTACTED'} title="Contacted leads and leads reserved in Hunter" className={cn("tab", filter === 'CONTACTED' && "tab-active")}>Contacted</button>
                        <button onClick={() => setFilter('NOT_QUALIFIED')} aria-pressed={filter === 'NOT_QUALIFIED'} className={cn("tab", filter === 'NOT_QUALIFIED' && "tab-active")}>Not qualified</button>
                        {unconfirmedIds.size > 0 && (
                            <button onClick={() => setFilter('UNCONFIRMED')} aria-pressed={filter === 'UNCONFIRMED'} title="Marked contacted, but the last Gmail scan found no sent mail to them" className={cn("tab", filter === 'UNCONFIRMED' && "tab-active")}>
                                <AlertCircle className="w-3.5 h-3.5" /> Unconfirmed <span className="num">{unconfirmedIds.size}</span>
                            </button>
                        )}
                    </div>
                    <label className="crm-regional-view">
                        <span className="sr-only">Regional lead view</span>
                        <select className="field" value={['UK', 'UK_QUALIFIED', 'NA', 'NA_QUALIFIED'].includes(filter) ? filter : ''} onChange={event => setFilter(event.target.value || 'ALL')}>
                            <option value="">Regional views</option>
                            <option value="UK">UK inbox</option>
                            <option value="UK_QUALIFIED">UK qualified</option>
                            <option value="NA">NA inbox</option>
                            <option value="NA_QUALIFIED">NA qualified</option>
                        </select>
                    </label>
                    </div>
                    <div className="crm-filter-row">
                        <label className="crm-search">
                            <Search className="w-4 h-4" aria-hidden />
                            <span className="sr-only">Search leads</span>
                            <input className="field" type="search" placeholder="Search name, company or email…" value={leadSearch} onChange={event => { setLeadSearch(event.target.value); setCurrentPage(1); }} />
                        </label>
                        <div className="crm-filter-options">
                            <select aria-label="Email status" value={emailFilter} onChange={e => setEmailFilter(e.target.value)} className="field cursor-pointer">
                                <option value="ALL">Any email status</option>
                                <option value="PROVEN_VALID">Valid — safe to send</option>
                                <option value="UNPROVEN_VALID">Valid label, no proof</option>
                                <option value="VALID">Valid — any</option>
                                <option value="RISKY">Risky</option>
                                <option value="INVALID">Invalid</option>
                                <option value="UNKNOWN">Unknown</option>
                                <option value="UNVERIFIED">Unverified</option>
                                <option value="GUESSED">Guessed</option>
                            </select>
                            <select aria-label="Hook status" value={hookFilter} onChange={e => setHookFilter(e.target.value)} className="field cursor-pointer">
                                <option value="ALL">Any hook</option>
                                <option value="HAS_HOOK">Has hook</option>
                                <option value="NO_HOOK">Missing hook</option>
                            </select>
                        </div>
                        <span className="crm-result-count num" role="status">{loading ? 'Loading leads…' : `${filteredLeads.length.toLocaleString()} leads shown`}</span>
                    </div>
                    <div className="crm-outreach-row">
                        <div className="flex flex-wrap items-center gap-2">
                            <button
                                className="btn btn-outline"
                                disabled={hunterImporting || selectedIds.size === 0 || selectedIds.size > 25}
                                title={selectedIds.size > 25 ? 'Select at most 25 leads at a time.' : 'Add selected qualified leads to Case Study Hunter → CRM outreach. No scan or DM is started.'}
                                onClick={() => void handleImportToHunter()}
                            >
                                {hunterImporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Radar className="w-3.5 h-3.5" />}
                                {selectedIds.size > 25 ? `Select up to 25 (${selectedIds.size})` : `Add selected to CRM outreach (${selectedIds.size})`}
                            </button>
                            {onOpenCaseStudy && <button className="btn btn-ghost" onClick={onOpenCaseStudy}>Open CRM outreach</button>}
                        </div>

                    </div>
                </div>

                {/* Standing notices — conditions worth acting on, not decoration. */}
                {(unprovenCount > 0 || queuedOnlyCount > 0) && (
                    <div className="px-4 py-1.5 border-b border-[var(--line)] flex items-center gap-4 flex-wrap bg-[var(--surface-0)]">
                        {queuedOnlyCount > 0 && (
                            <button
                                onClick={() => setFilter('READY')}
                                title="Flagged contacted when pushed to a sending platform. Nothing shows a message ever went out, so they count as reachable."
                                className="mark mark-ok hover:opacity-80 transition-opacity"
                            >
                                <span className="num">{queuedOnlyCount}</span>
                                <span className="font-normal text-[var(--text-dim)]">contact flags without send evidence — review before outreach</span>
                            </button>
                        )}
                        {unprovenCount > 0 && (
                            <button
                                onClick={() => setEmailFilter('UNPROVEN_VALID')}
                                title="These carry a VALID label without fresh verification evidence. They're excluded from exports until re-verified."
                                className="mark mark-warn hover:opacity-80 transition-opacity"
                            >
                                <span className="num">{unprovenCount}</span>
                                <span className="font-normal text-[var(--text-dim)]">email proof expired or missing — reverify before export</span>
                            </button>
                        )}
                    </div>
                )}

                {/* What was actually sent, from the last Gmail scan */}
                {campaigns.length > 0 && (
                    <div className="border-b border-[var(--line)] bg-[var(--surface-0)]">
                        <button
                            onClick={() => setShowCampaigns(v => !v)}
                            className="w-full px-4 py-2 flex items-center justify-between text-left hover:bg-[var(--surface-2)] transition-colors"
                        >
                            <span className="label-micro flex items-center gap-2">
                                <Mail className="w-3.5 h-3.5" />
                                Sent campaigns
                                <span className="num text-[var(--text-dim)]">{campaigns.length}</span>
                                <span className="text-[var(--text-faint)] normal-case tracking-normal font-normal">
                                    · <span className="num">{campaigns.reduce((n, c) => n + c.messages, 0).toLocaleString()}</span> messages,
                                    {' '}<span className="num text-[var(--signal)]">{campaigns.reduce((n, c) => n + c.leadsMatched, 0).toLocaleString()}</span> to CRM leads
                                </span>
                            </span>
                            <ChevronDown className={cn("w-3.5 h-3.5 text-[var(--text-faint)] transition-transform", showCampaigns && "rotate-180")} />
                        </button>
                        {showCampaigns && (
                            <div className="max-h-64 overflow-auto border-t border-[var(--line)]">
                                <table className="w-full text-xs">
                                    <thead className="tbl-head sticky top-0">
                                        <tr>
                                            <th className="px-4 py-2 text-left">Subject</th>
                                            <th className="px-3 py-2 text-right">Sent</th>
                                            <th className="px-3 py-2 text-right">People</th>
                                            <th className="px-3 py-2 text-right">In CRM</th>
                                            <th className="px-3 py-2 text-right">Match</th>
                                            <th className="px-4 py-2 text-left">Period</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {campaigns.map((c, i) => {
                                            const pct = c.recipients ? Math.round((c.leadsMatched / c.recipients) * 100) : 0;
                                            return (
                                                <tr key={i} className="tbl-row">
                                                    <td className="px-4 py-1.5 text-[var(--text-dim)] max-w-[380px] truncate" title={c.subject}>{c.subject}</td>
                                                    <td className="px-3 py-1.5 text-right num text-[var(--text-faint)]">{c.messages}</td>
                                                    <td className="px-3 py-1.5 text-right num text-[var(--text-faint)]">{c.recipients}</td>
                                                    <td className="px-3 py-1.5 text-right num text-[var(--text)]">{c.leadsMatched}</td>
                                                    {/* A campaign that barely matches was sent to a list built elsewhere. */}
                                                    <td className={cn("px-3 py-1.5 text-right num", pct >= 50 ? "text-[var(--signal)]" : pct >= 10 ? "text-[var(--warn)]" : "text-[var(--bad)]")}>{pct}%</td>
                                                    <td className="px-4 py-1.5 num text-[var(--text-faint)]">{c.firstSent.slice(0, 7)} → {c.lastSent.slice(0, 7)}</td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>
                )}

                {/* Table Area */}
                <div className="crm-table-scroll" tabIndex={0} aria-label="Lead records, scroll horizontally for all columns">
                    <table className="crm-leads-table w-full min-w-[1400px] text-sm text-left">
                        <thead className="tbl-head sticky top-0 z-10">
                            <tr>
                                <th className="px-4 py-2.5 w-10 text-center">
                                    <input
                                        type="checkbox"
                                        aria-label="Select all filtered leads"
                                        className="rounded-sm border-[var(--line-strong)] bg-[var(--surface-3)] checked:bg-[var(--signal)] focus:ring-[var(--signal)]"
                                        checked={filteredLeads.length > 0 && selectedIds.size === filteredLeads.length}
                                        onChange={toggleSelectAll}
                                    />
                                </th>
                                <th className="px-4 py-2.5">Stage</th>
                                <th className="px-4 py-2.5">Name</th>
                                <th className="px-4 py-2.5">LinkedIn</th>
                                <th className="px-4 py-2.5">Website</th>
                                <th className="px-4 py-2.5">Location</th>
                                <th className="px-4 py-2.5">Email</th>
                                <th className="px-4 py-2.5">Verification</th>
                                <th className="px-4 py-2.5">Hook</th>
                                <th className="px-4 py-2.5 text-center">Contacted</th>
                                <th className="px-4 py-2.5">Outcome</th>
                            </tr>
                        </thead>
                        <tbody>
                            {loading && leads.length === 0 ? (
                                <tr>
                                    <td colSpan={11} className="px-4 py-12 text-center text-[var(--text-faint)] text-[13px]">
                                        <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />
                                        Loading leads
                                    </td>
                                </tr>
                            ) : loadError ? (
                                <tr>
                                    <td colSpan={11} className="px-4 py-12 text-center">
                                        <AlertCircle className="w-6 h-6 mx-auto mb-3 text-[var(--bad)]" />
                                        <div className="text-[var(--text)] text-sm font-medium">Couldn&apos;t load the lead database</div>
                                        <div className="text-[var(--text-faint)] text-xs mt-1 max-w-md mx-auto">{loadError}</div>
                                        <button onClick={fetchLeads} className="btn btn-outline mx-auto mt-4">
                                            <RefreshCcw className="w-3.5 h-3.5" /> Try again
                                        </button>
                                    </td>
                                </tr>
                            ) : filteredLeads.length === 0 ? (
                                <tr>
                                    <td colSpan={11} className="px-4 py-12 text-center text-[var(--text-faint)]">
                                        <Search className="w-6 h-6 mx-auto mb-2 opacity-50" />
                                        No leads match this view
                                    </td>
                                </tr>
                            ) : (
                                paginatedLeads.map((lead) => (
                                    <tr
                                        key={lead.id}
                                        className={cn(
                                            "tbl-row group cursor-pointer",
                                            selectedIds.has(lead.id) && "tbl-row-selected"
                                        )}
                                        onClick={() => toggleSelect(lead.id)}
                                    >
                                        <td className="px-4 py-2.5 text-center" onClick={e => e.stopPropagation()}>
                                            <input
                                                type="checkbox"
                                                className="rounded-sm border-[var(--line-strong)] bg-[var(--surface-3)] checked:bg-[var(--signal)] focus:ring-[var(--signal)]"
                                                checked={selectedIds.has(lead.id)}
                                                onChange={() => toggleSelect(lead.id)}
                                            />
                                        </td>
                                        <td className="px-4 py-2.5 whitespace-nowrap">
                                            {/* A scannable mark, not a filled lozenge — a column of pills is confetti. */}
                                            <span className={cn("mark",
                                                isReadyToSend(lead) ? "mark-ok"
                                                    : isQualifiedStage(lead.pipeline_status) ? "mark-info"
                                                        : lead.pipeline_status === 'NOT_QUALIFIED' ? "mark-bad"
                                                            : "mark-idle"
                                            )}>
                                                {isReadyToSend(lead) ? 'READY'
                                                    : isQualifiedStage(lead.pipeline_status) ? 'QUALIFIED'
                                                        : lead.pipeline_status.replace('_', ' ')}
                                            </span>
                                            {lead.do_not_contact && (
                                                <span className="badge badge-bad ml-1.5" title="On the do-not-contact list — excluded from every export">DNC</span>
                                            )}
                                            {nearMissIds.has(lead.id) && (
                                                <span className="badge badge-warn ml-1.5" title="Not found in sent mail under this address, but a colleague at the same company — or an address matching this person's name — was emailed. Check before contacting.">NEAR MISS</span>
                                            )}
                                        </td>
                                        <td className="px-4 py-2.5 font-medium text-[var(--text)]">
                                            {lead.first_name} {lead.last_name}
                                            {!lead.first_name && <span className="text-[var(--text-faint)] italic">Unknown</span>}
                                            <FollowerEvidence followers={lead.prospect_assessment?.research.followers} connections={lead.prospect_assessment?.research.connections}/>
                                        </td>
                                        <td className="px-4 py-2.5 text-xs">
                                            {lead.linkedin_url ? (
                                                <div className="flex flex-col items-start gap-1">
                                                    <a href={lead.linkedin_url} target="_blank" rel="noopener noreferrer" className="text-[var(--info)] hover:underline" onClick={(event) => event.stopPropagation()}>
                                                        {lead.linkedin_url.includes('linkedin.com/in/') ? lead.linkedin_url.split('linkedin.com/in/')[1].replace(/\/$/, '') : 'Profile'}
                                                    </a>
                                                    {lead.linkedin_dm_at ? <span className="badge badge-info" title={`LinkedIn DM recorded ${new Date(lead.linkedin_dm_at).toLocaleString()}`}>DM sent</span> : lead.in_hunter ? <span className="badge badge-info" title="Already managed in Hunter; reserved for outreach, with no DM recorded here">In Hunter</span> : isLinkedinProspect(lead) && (
                                                        <button type="button" className="text-[11px] text-[var(--text-dim)] hover:text-[var(--signal)] underline" disabled={dmPendingId !== null} onClick={(event) => { event.stopPropagation(); void handleMarkLinkedinDmSent(lead.id); }}>
                                                            {dmPendingId === lead.id ? 'Saving…' : 'Mark DM sent'}
                                                        </button>
                                                    )}
                                                </div>
                                            ) : (
                                                <span className="text-[var(--text-faint)]">—</span>
                                            )}
                                        </td>
                                        <td className="px-4 py-2.5 text-xs truncate max-w-[150px]">
                                            {lead.website ? (
                                                <a href={lead.website} target="_blank" rel="noopener noreferrer" className="text-[var(--info)] hover:underline" title={lead.website}>
                                                    {lead.website.replace(/^https?:\/\/(www\.)?/, '').split('/')[0]}
                                                </a>
                                            ) : (
                                                <span className="text-[var(--text-faint)]">—</span>
                                            )}
                                        </td>
                                        <td className="px-4 py-2.5 text-xs text-[var(--text-dim)]">{lead.location || <span className="text-[var(--text-faint)]">—</span>}</td>
                                        <td className="px-4 py-2.5 num text-xs text-[var(--text)]">{lead.email || <span className="text-[var(--text-faint)]">—</span>}</td>
                                        <td className="px-4 py-2.5 whitespace-nowrap">
                                            <span
                                                className={cn("mark",
                                                    isProvenValid(lead) ? "mark-ok"
                                                        : isUnprovenValid(lead) ? "mark-warn"
                                                            : lead.email_status === 'RISKY' ? "mark-warn"
                                                                : lead.email_status === 'INVALID' ? "mark-bad"
                                                                    : lead.email_status === 'GUESSED' ? "mark-warn"
                                                                        : "mark-idle"
                                                )}
                                                title={isUnprovenValid(lead)
                                                    ? hasExpiredSmtpProof(lead) ? `Verification expired ${new Date(lead.email_verification_expires_at!).toLocaleString()}; reverify before sending`
                                                        : 'Verification evidence is missing or incomplete; reverify before sending'
                                                    : lead.email_verification_reason || lead.email_status}
                                            >
                                                {isProvenValid(lead) ? 'VALID' : hasExpiredSmtpProof(lead) ? 'EXPIRED' : isUnprovenValid(lead) ? 'REVERIFY' : lead.email_status === 'UNKNOWN' ? getUnknownLabel(lead.email_verification_reason) : (lead.email_status || 'UNVERIFIED')}
                                            </span>
                                        </td>
                                        <td className="px-4 py-2.5 text-[var(--text-dim)] max-w-[250px] truncate text-xs" title={lead.hook}>
                                            {lead.hook || <span className="text-[var(--text-faint)]">—</span>}
                                        </td>
                                        <td className="px-4 py-2.5 text-center" onClick={e => e.stopPropagation()}>
                                            <div className="flex flex-col items-center gap-1">
                                                <input
                                                    type="checkbox"
                                                    className="w-4 h-4 rounded-sm border-[var(--line-strong)] bg-[var(--surface-3)] checked:bg-[var(--signal)] focus:ring-[var(--signal)] cursor-pointer"
                                                    checked={lead.contacted}
                                                    disabled={lead.in_hunter || lead.contacted_source === 'HUNTER' || lead.contacted_source === 'LINKEDIN' || Boolean(lead.linkedin_dm_at)}
                                                    onChange={() => handleToggleContacted(lead.id, lead.contacted)}
                                                    title={lead.in_hunter ? 'Already managed in Case Study Hunter. Contacted stays checked here to prevent repeat outreach.' : lead.linkedin_dm_at || lead.contacted_source === 'LINKEDIN' ? 'LinkedIn DM is tracked in Hunter' : 'Mark as contacted'}
                                                />
                                                {/* Why this counts as contacted. No source means a bulk push set it,
                                                    which proves the lead was queued, not that a message went out. */}
                                                {lead.contacted && (
                                                    <span
                                                        className={cn("badge",
                                                            lead.in_hunter ? "badge-info" : lead.contacted_source === 'PLATFORM' ? "badge-ok"
                                                                : lead.contacted_source === 'GMAIL' ? "badge-info"
                                                            : lead.contacted_source === 'MANUAL' || lead.contacted_source === 'LINKEDIN' ? "badge-info"
                                                                        : "badge-idle")}
                                                        title={
                                                            lead.in_hunter ? 'Managed in Case Study Hunter. Membership reserves this lead; it does not record an email or DM send.' : lead.contacted_source === 'PLATFORM'
                                                                ? "Confirmed by the sending platform's own campaign report — a message definitely went out."
                                                                : lead.contacted_source === 'GMAIL'
                                                                    ? "Found in Gmail Sent Mail."
                                                                : lead.contacted_source === 'LINKEDIN'
                                                                    ? "LinkedIn DM recorded manually in Hunter."
                                                                    : lead.contacted_source === 'MANUAL'
                                                                        ? "You ticked this box yourself."
                                                                        : "Queued only — set when this lead was pushed to a sending platform. Nothing shows a message was sent, so it still counts as reachable. Import a campaign report to confirm."
                                                        }
                                                    >
                                                        {lead.in_hunter ? 'IN HUNTER' : lead.contacted_source === 'PLATFORM' ? 'SENT'
                                                            : lead.contacted_source === 'GMAIL' ? 'GMAIL'
                                                                : lead.contacted_source === 'MANUAL' ? 'BY HAND'
                                                                    : lead.contacted_source === 'LINKEDIN' ? 'LINKEDIN' : 'QUEUED ONLY'}
                                                    </span>
                                                )}
                                            </div>
                                        </td>
                                        <td className="px-4 py-2.5" onClick={e => e.stopPropagation()}>
                                            <select
                                                value={lead.outcome || ''}
                                                onChange={e => handleSetOutcome(lead.id, e.target.value)}
                                                title="What happened after you reached out"
                                                className={cn("field cursor-pointer !text-xs !py-1",
                                                    lead.outcome === 'BOOKED' ? "!text-[var(--signal)]" :
                                                    lead.outcome === 'REPLIED' ? "!text-[var(--info)]" :
                                                    lead.outcome === 'NOT_INTERESTED' || lead.outcome === 'BOUNCED' ? "!text-[var(--bad)]" :
                                                    "!text-[var(--text-dim)]"
                                                )}
                                            >
                                                {OUTCOMES.map(o => (
                                                    <option key={o.value} value={o.value}>{o.label}</option>
                                                ))}
                                            </select>
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>

                {/* Pagination Controls */}
                {filteredLeads.length > 0 && (
                    <div className="crm-pagination rail">
                        <div className="text-xs text-[var(--text-faint)]">
                            <span className="num text-[var(--text-dim)]">{((currentPage - 1) * itemsPerPage) + 1}–{Math.min(currentPage * itemsPerPage, filteredLeads.length)}</span>
                            {' of '}
                            <span className="num text-[var(--text-dim)]">{filteredLeads.length.toLocaleString()}</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                            <button disabled={currentPage === 1} onClick={() => setCurrentPage(p => Math.max(1, p - 1))} className="btn btn-outline">
                                Previous
                            </button>
                            <span className="num text-xs text-[var(--text-faint)] px-2">{currentPage} / {totalPages}</span>
                            <button disabled={currentPage === totalPages} onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} className="btn btn-outline">
                                Next
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
