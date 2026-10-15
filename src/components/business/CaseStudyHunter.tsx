'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    addCaseStudyNoteAction,
    loadCaseStudyAction,
    queueCaseStudyProspectsAction,
    queueCaseStudySourceScanAction,
    queueMissedCoachProfilesAction,
    retryCaseStudyProspectAction,
    saveCaseStudyProspectAction,
    stopCaseStudyRunAction,
} from '@/app/actions/case-study-actions';
import {
    buildHunterDailyPlan,
    CASE_STUDY_STAGES,
    CASE_STUDY_STAGE_LABELS,
    crmOutreachStatus as crmContactStatus,
    isDeliveryStage,
    MAX_SOURCE_SCAN_PROFILES,
    WARMTH_LABELS,
    WARMTH_SOURCES,
    type CaseStudyActivity,
    type CaseStudyProspect,
    type CaseStudyProspectData,
    type CaseStudySnapshot,
    type CrmOutreachStatus,
    type HunterMode,
    type WarmthSource,
} from '@/lib/case-study';
import { dateTime, Empty, Field, isoInput, LinkOut, localInput, Panel } from './BusinessUi';
import { markHunterProspectLinkedinDmSentAction, setCrmOutreachStatusesAction, undoHunterProspectLinkedinDmAction } from '@/app/actions/linkedin-outreach-actions';
import { DEFAULT_TARGET_TITLES, isMissedCoachCandidate } from '@/lib/case-study-qualification.cjs';

type WorkerLog = { at?: string; phase?: string; message?: string };
type WorkerState = {
    status?: string;
    phase?: string;
    message?: string;
    currentProfile?: string;
    stale?: boolean;
    updatedAt?: string;
    activeJob?: string;
    activeJobType?: string;
    lastCompletedJobId?: string;
    lastCompletedJobType?: string;
    lastCompletedAt?: string;
    lastCompletionStatus?: string;
    lastSourceScanResult?: { discovered?: number; skipped?: number; queued?: number };
    recentLogs?: WorkerLog[];
};
type WorkerStatus = {
    queueSize: number;
    workerStatus: WorkerState | null;
    dailyStats: { count: number; limit: number };
    recentLogs?: WorkerLog[];
};
type View = 'TODAY' | 'PIPELINE' | 'CRM_OUTREACH' | 'SCANNER';
type Run = <T>(work: () => Promise<T>, success: string | ((result: T) => string)) => Promise<T | null>;
type CrmStatusResult = Awaited<ReturnType<typeof setCrmOutreachStatusesAction>>;
type ChangeCrmStatuses = (ids: string[], status: CrmOutreachStatus) => Promise<CrmStatusResult | null>;
type ChangeStage = (prospect: CaseStudyProspect, stage: CaseStudyProspectData['stage']) => Promise<void>;

const humanPhase = (phase?: string) => (phase || 'NOT_STARTED').toLowerCase().replaceAll('_', ' ').replace(/^\w/, (value) => value.toUpperCase());
type CrmContactFilter = 'ALL' | CrmOutreachStatus;
const contactedBeforeExclusion = (data: CaseStudyProspectData) => Boolean(data.lastContactedAt) ||
    Boolean(data.doNotContactPreviousStage && CASE_STUDY_STAGES.indexOf(data.doNotContactPreviousStage) >= CASE_STUDY_STAGES.indexOf('MESSAGED'));

export default function CaseStudyHunter({ initialView = 'TODAY' }: { initialView?: View }) {
    const [snapshot, setSnapshot] = useState<CaseStudySnapshot | null>(null);
    const [worker, setWorker] = useState<WorkerStatus | null>(null);
    const [view, setView] = useState<View>(initialView);
    const [mode, setMode] = useState<HunterMode>('CASE_STUDY');
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');
    const [busy, setBusy] = useState(false);
    const workerCompletionRef = useRef('');
    const workerStatusInitializedRef = useRef(false);

    const refresh = useCallback(async (quiet = false) => {
        try {
            if (!quiet) setError('');
            setSnapshot(await loadCaseStudyAction());
        } catch (cause) {
            if (!quiet) setError(cause instanceof Error ? cause.message : 'Could not load the Case Study Hunter.');
        }
    }, []);
    const refreshWorker = useCallback(async () => {
        try {
            const response = await fetch('/api/case-study/queue-status', { cache: 'no-store' });
            if (response.ok) setWorker(await response.json());
        } catch { /* the CRM remains usable while the worker is offline */ }
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    useEffect(() => {
        if (view === 'CRM_OUTREACH') return;
        void refreshWorker();
        const workerTimer = window.setInterval(() => void refreshWorker(), 3000);
        return () => window.clearInterval(workerTimer);
    }, [refreshWorker, view]);

    useEffect(() => {
        if (!worker) return;
        const completedJobId = worker.workerStatus?.lastCompletedJobId || '';
        if (!workerStatusInitializedRef.current) {
            workerStatusInitializedRef.current = true;
            workerCompletionRef.current = completedJobId;
            return;
        }
        if (completedJobId && completedJobId !== workerCompletionRef.current) {
            workerCompletionRef.current = completedJobId;
            void refresh(true);
        }
    }, [refresh, worker]);

    const run: Run = async (work, success) => {
        setBusy(true);
        setError('');
        setMessage('');
        try {
            const result = await work();
            await Promise.all([refresh(true), refreshWorker()]);
            setMessage(typeof success === 'function' ? success(result) : success);
            return result;
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'The change could not be saved.');
            return null;
        } finally {
            setBusy(false);
        }
    };

    const changeCrmStatuses: ChangeCrmStatuses = async (ids, status) => {
        if (busy) return null;
        setBusy(true);
        setError('');
        setMessage('');
        try {
            const result = await setCrmOutreachStatusesAction(ids, status);
            const changed = new Map(result.updated.map((prospect) => [prospect.id, prospect]));
            setSnapshot((current) => current ? {
                prospects: current.prospects.map((prospect) => changed.get(prospect.id) || prospect),
                activities: [...result.activities, ...current.activities],
            } : current);
            const summary = `${result.updated.length} status${result.updated.length === 1 ? '' : 'es'} changed` +
                (result.unchangedIds.length ? `, ${result.unchangedIds.length} already set` : '') +
                (result.skipped.length ? `, ${result.skipped.length} skipped: ${[...new Set(result.skipped.map((item) => item.reason))].join('; ')}` : '') + '.';
            setMessage(summary);
            return result;
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'The status change could not be saved.');
            return null;
        } finally {
            setBusy(false);
        }
    };

    const changeStage: ChangeStage = async (prospect, stage) => {
        if (busy || stage === prospect.data.stage) return;
        setBusy(true);
        setError('');
        setMessage('');
        try {
            const { activity, ...updated } = await saveCaseStudyProspectAction(
                prospect.id, { ...prospect.data, stage }, prospect.revision,
            );
            setSnapshot((current) => current ? {
                prospects: current.prospects.map((row) => row.id === updated.id ? updated : row),
                activities: [activity, ...current.activities],
            } : current);
            setMessage(`Status changed to ${CASE_STUDY_STAGE_LABELS[stage]}.`);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'The status could not be saved.');
        } finally {
            setBusy(false);
        }
    };

    const selected = snapshot?.prospects.find((prospect) => prospect.id === selectedId);
    if (selected && snapshot) {
        const workspaceProps = {
            key: `${selected.id}-${selected.revision}`,
            prospect: selected,
            activities: snapshot.activities.filter((activity) => activity.prospectId === selected.id),
            busy,
            error,
            message,
            run,
            onBack: () => setSelectedId(null),
        };
        if (selected.data.crmLeadId) return <CrmOutreachWorkspace {...workspaceProps} />;
        return (
            <ProspectWorkspace {...workspaceProps} />
        );
    }

    const prospects = snapshot?.prospects || [];
    const crmProspects = prospects.filter((prospect) => Boolean(prospect.data.crmLeadId));
    const hunterProspects = prospects.filter((prospect) => !prospect.data.crmLeadId && prospect.data.mode === mode);
    const plan = buildHunterDailyPlan(hunterProspects);
    return (
        <div className="space-y-5 max-w-7xl" data-testid="case-study-hunter">
            {view !== 'CRM_OUTREACH' && <WorkerStrip worker={worker} refresh={refreshWorker} />}
            {error && <p role="alert" className="panel-note text-[var(--bad)]">{error}</p>}
            {message && <p role="status" className="panel-note text-[var(--signal)]">{message}</p>}

            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="seg" aria-label="Case Study Hunter view">
                    {([['TODAY', 'Today'], ['PIPELINE', 'Pipeline'], ['CRM_OUTREACH', `CRM outreach (${crmProspects.length})`], ['SCANNER', 'Scanner']] as const).map(([value, label]) => (
                        <button key={value} className={`seg-item ${view === value ? 'seg-active' : ''}`} onClick={() => setView(value)}>{label}</button>
                    ))}
                </div>
                {view === 'CRM_OUTREACH' ? (
                    <p className="text-xs text-[var(--text-dim)]">Qualified CRM imports and manual LinkedIn follow-ups live here.</p>
                ) : (
                    <div className="flex items-center gap-3">
                        <span className="text-xs text-[var(--text-dim)]">Hunter mode</span>
                        <div className="seg" aria-label="Hunter mode">
                            <button className={`seg-item ${mode === 'CASE_STUDY' ? 'seg-active' : ''}`} onClick={() => setMode('CASE_STUDY')}>Case Study ({prospects.filter((p) => !p.data.crmLeadId && p.data.mode === 'CASE_STUDY').length})</button>
                            <button className={`seg-item ${mode === 'CLIENT' ? 'seg-active' : ''}`} onClick={() => setMode('CLIENT')}>Client ({prospects.filter((p) => !p.data.crmLeadId && p.data.mode === 'CLIENT').length})</button>
                        </div>
                    </div>
                )}
            </div>

            {view === 'TODAY' && <TodayView plan={plan} open={setSelectedId} />}
            {view === 'PIPELINE' && <PipelineView key={mode} prospects={hunterProspects} mode={mode} open={setSelectedId} busy={busy} changeStage={changeStage} />}
            {view === 'CRM_OUTREACH' && <CrmOutreachView prospects={crmProspects} open={setSelectedId} busy={busy} changeStatuses={changeCrmStatuses} />}
            {view === 'SCANNER' && <ScannerView busy={busy} run={run} worker={worker} mode={mode} prospects={snapshot?.prospects || []} />}
            {view !== 'CRM_OUTREACH' && <WorkerActivity worker={worker} />}
        </div>
    );
}

function WorkerStrip({ worker, refresh }: { worker: WorkerStatus | null; refresh: () => Promise<void> }) {
    const status = worker?.workerStatus;
    const offline = !status || status.stale;
    const working = status?.status === 'WORKING';
    const dot = offline ? 'var(--bad)' : working ? 'var(--signal)' : 'var(--text-faint)';
    return (
        <div className="panel px-4 py-3 flex flex-wrap items-center gap-x-5 gap-y-2">
            <span className="flex items-center gap-2 font-medium">
                <span className="w-2 h-2 rounded-full" style={{ background: dot, boxShadow: working ? `0 0 12px ${dot}` : undefined }} />
                {offline ? 'Worker offline' : humanPhase(status.phase)}
            </span>
            <span className="text-sm text-[var(--text-dim)] flex-1 min-w-[260px] truncate">
                {offline ? 'Start npm run case-study-worker to scan profiles.' : status.message || 'Waiting for work'}
            </span>
            <span className="text-xs text-[var(--text-dim)]">Queue <b className="num text-[var(--text)]">{worker?.queueSize || 0}</b></span>
            <span className="text-xs text-[var(--text-dim)]">Today <b className="num text-[var(--text)]">{worker?.dailyStats.count || 0}/{worker?.dailyStats.limit || 20}</b></span>
            <button className="btn btn-ghost" onClick={() => void refresh()}>Refresh</button>
        </div>
    );
}

function WorkerActivity({ worker }: { worker: WorkerStatus | null }) {
    const logs = worker?.recentLogs || worker?.workerStatus?.recentLogs || [];
    return (
        <details className="panel" open={Boolean(worker?.workerStatus?.status === 'WORKING')}>
            <summary className="px-4 py-3 cursor-pointer font-medium">Live worker activity <span className="text-xs text-[var(--text-dim)]">({logs.length} recent events)</span></summary>
            <div className="border-t border-[var(--line)] p-3 max-h-64 overflow-auto font-mono text-xs space-y-1" aria-label="Case Study worker logs">
                {!logs.length && <p className="text-[var(--text-dim)]">No Case Study worker activity has been recorded yet.</p>}
                {logs.slice().reverse().map((entry, index) => (
                    <div key={`${entry.at}-${index}`} className="grid grid-cols-[78px_150px_1fr] gap-3 py-1">
                        <span className="text-[var(--text-faint)]">{entry.at ? new Date(entry.at).toLocaleTimeString() : '—'}</span>
                        <span className="text-[var(--info)]">{humanPhase(entry.phase)}</span>
                        <span>{entry.message}</span>
                    </div>
                ))}
            </div>
        </details>
    );
}

function TodayView({ plan, open }: { plan: ReturnType<typeof buildHunterDailyPlan>; open: (id: string) => void }) {
    return (
        <div className="grid xl:grid-cols-3 gap-4">
            <DailyColumn title="Message today" count={`${plan.message.length}/5`} hint="Qualified profiles ready for manual review and outreach" rows={plan.message} open={open} />
            <DailyColumn title="Follow up" count={`${plan.followUp.length}/3`} hint="Due actions, including immediate Loom delivery after a reply" rows={plan.followUp} open={open} />
            <DailyColumn title="Engage first" count={`${plan.engage.length}/5`} hint="Warm fits worth one thoughtful interaction" rows={plan.engage} open={open} />
        </div>
    );
}

function DailyColumn({ title, count, hint, rows, open }: { title: string; count: string; hint: string; rows: CaseStudyProspect[]; open: (id: string) => void }) {
    return (
        <Panel title={title} action={<span className="badge badge-idle num">{count}</span>}>
            <p className="text-xs text-[var(--text-dim)] -mt-2">{hint}</p>
            {!rows.length ? <Empty>Nothing is due here.</Empty> : rows.map((prospect) => (
                <button key={prospect.id} className="feed-row text-left w-full hover:border-[var(--text-faint)]" onClick={() => open(prospect.id)}>
                    <span className="flex justify-between gap-3">
                        <b className="truncate">{prospect.data.name || 'Pending profile'}</b>
                        <span className="badge badge-idle">{WARMTH_LABELS[prospect.data.source]}</span>
                    </span>
                    <span className="block text-xs text-[var(--text-dim)] mt-1 line-clamp-2">{prospect.data.nextAction}</span>
                </button>
            ))}
        </Panel>
    );
}

function PipelineView({ prospects, mode, open, busy, changeStage }: { prospects: CaseStudyProspect[]; mode: HunterMode; open: (id: string) => void; busy: boolean; changeStage: ChangeStage }) {
    const [query, setQuery] = useState('');
    const [stage, setStage] = useState('ALL');
    const [pendingId, setPendingId] = useState<string | null>(null);
    const rows = useMemo(() => prospects.filter((prospect) => {
        const matchesStage = stage === 'ALL' || prospect.data.stage === stage;
        const haystack = `${prospect.data.name} ${prospect.data.headline} ${prospect.data.website} ${prospect.data.linkedinUrl}`.toLowerCase();
        return matchesStage && haystack.includes(query.toLowerCase());
    }), [prospects, query, stage]);
    return (
        <Panel title={`${mode === 'CASE_STUDY' ? 'Case Study' : 'Client'} Hunter pipeline`} action={<span className="text-xs text-[var(--text-dim)]">{rows.length} shown</span>}>
            <div className="grid sm:grid-cols-[1fr_220px] gap-3">
                <input className="field" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name, headline, website, or LinkedIn URL" aria-label="Search Hunter pipeline" />
                <select className="field" value={stage} onChange={(event) => setStage(event.target.value)}>
                    <option value="ALL">All stages</option>
                    {CASE_STUDY_STAGES.map((value) => <option key={value} value={value}>{CASE_STUDY_STAGE_LABELS[value]}</option>)}
                </select>
            </div>
            {!rows.length ? <Empty>{prospects.length ? 'No prospects match this view.' : 'No Hunter prospects in this mode yet. CRM imports are in CRM outreach.'}</Empty> : (
                <div className="overflow-x-auto border border-[var(--line)] rounded-lg">
                    <table className="w-full text-sm" style={{ tableLayout: 'fixed', minWidth: 940 }}>
                        <colgroup><col style={{ width: '27%' }} /><col style={{ width: '20%' }} /><col style={{ width: '22%' }} /><col style={{ width: '19%' }} /><col style={{ width: '12%' }} /></colgroup>
                        <thead className="text-left text-xs text-[var(--text-dim)] bg-[var(--surface-2)]">
                            <tr><th className="p-3">Prospect</th><th className="p-3">Website</th><th className="p-3">LinkedIn URL</th><th className="p-3">Status</th><th className="p-3">Qualification</th></tr>
                        </thead>
                        <tbody>
                            {rows.map((prospect) => (
                                <tr key={prospect.id} className="border-t border-[var(--line)] cursor-pointer hover:bg-[var(--surface-2)]" onClick={() => open(prospect.id)}>
                                    <td className="p-3"><b className="block truncate">{prospect.data.name || 'Pending profile'}</b><span className="block text-xs text-[var(--text-dim)] truncate">{prospect.data.headline || prospect.data.linkedinUrl}</span></td>
                                    <ProspectUrlCell url={prospect.data.website} />
                                    <ProspectUrlCell url={prospect.data.linkedinUrl} />
                                    <td className="p-3" onClick={(event) => event.stopPropagation()}>
                                        <select className="field min-w-40" value={prospect.data.stage} aria-label={`Change status for ${prospect.data.name || 'prospect'}`} disabled={busy || pendingId !== null} onChange={async (event) => {
                                            const next = event.target.value as CaseStudyProspectData['stage'];
                                            setPendingId(prospect.id);
                                            try { await changeStage(prospect, next); } finally { setPendingId(null); }
                                        }}>
                                            {CASE_STUDY_STAGES.map((value) => <option key={value} value={value}>{CASE_STUDY_STAGE_LABELS[value]}</option>)}
                                        </select>
                                        {pendingId === prospect.id && <span className="block mt-1 text-xs text-[var(--text-dim)]">Saving…</span>}
                                    </td>
                                    <td className="p-3"><ScanBadge prospect={prospect} /></td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </Panel>
    );
}

function ProspectUrlCell({ url }: { url: string }) {
    return <td className="p-3" onClick={(event) => event.stopPropagation()}>
        {url ? <span className="block max-w-52 min-w-28 truncate" title={url}><LinkOut url={url}>{url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '')}</LinkOut></span> : <span className="text-[var(--text-faint)]">—</span>}
    </td>;
}

function CrmOutreachView({ prospects, open, busy, changeStatuses }: { prospects: CaseStudyProspect[]; open: (id: string) => void; busy: boolean; changeStatuses: ChangeCrmStatuses }) {
    const [query, setQuery] = useState('');
    const [contactFilter, setContactFilter] = useState<CrmContactFilter>('ALL');
    const [pendingId, setPendingId] = useState<string | null>(null);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
    const [bulkStatus, setBulkStatus] = useState<CrmOutreachStatus | ''>('');
    const rows = useMemo(() => prospects.filter((prospect) => {
        const data = prospect.data;
        return (contactFilter === 'ALL' || crmContactStatus(data) === contactFilter)
            && `${data.name} ${data.headline} ${data.website} ${data.crmHook}`.toLowerCase().includes(query.toLowerCase());
    }).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)), [prospects, query, contactFilter]);
    const notContacted = prospects.filter((prospect) => crmContactStatus(prospect.data) === 'NOT_CONTACTED').length;
    const messaged = prospects.filter((prospect) => crmContactStatus(prospect.data) === 'MESSAGED').length;
    const doNotContact = prospects.filter((prospect) => crmContactStatus(prospect.data) === 'DO_NOT_CONTACT').length;
    const visibleIds = rows.map((prospect) => prospect.id);
    const selectedVisibleCount = visibleIds.filter((id) => selectedIds.has(id)).length;
    const allVisibleSelected = visibleIds.length > 0 && selectedVisibleCount === visibleIds.length;
    const changeFilter = (value: CrmContactFilter) => {
        setContactFilter(value);
        setSelectedIds(new Set());
    };
    const changeQuery = (value: string) => {
        setQuery(value);
        setSelectedIds(new Set());
    };
    const applyBulkStatus = async () => {
        if (!bulkStatus || !selectedIds.size || busy) return;
        const result = await changeStatuses([...selectedIds], bulkStatus);
        if (result) {
            setSelectedIds(new Set(result.skipped.map((item) => item.id)));
            setBulkStatus('');
        }
    };
    return (
        <Panel title="CRM LinkedIn outreach" action={<span className="text-xs text-[var(--text-dim)]">{prospects.length} imported</span>}>
            <p className="text-sm text-[var(--text-dim)]">Qualified leads selected in Leads appear here for manual LinkedIn outreach. This queue is separate from the Hunter scanner pipeline.</p>
            <div className="seg w-fit" aria-label="CRM outreach contact status">
                {([
                    ['ALL', `All (${prospects.length})`],
                    ['NOT_CONTACTED', `Not contacted (${notContacted})`],
                    ['MESSAGED', `Messaged (${messaged})`],
                    ['DO_NOT_CONTACT', `Don't contact (${doNotContact})`],
                ] as const).map(([value, label]) => (
                    <button key={value} className={`seg-item ${contactFilter === value ? 'seg-active' : ''}`} disabled={busy} onClick={() => changeFilter(value)}>{label}</button>
                ))}
            </div>
            <div>
                <input className="field" value={query} onChange={(event) => changeQuery(event.target.value)} placeholder="Search name, website, or CRM hook" aria-label="Search CRM outreach" disabled={busy} />
            </div>
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--line)] p-3">
                <span className="text-sm min-w-24">{selectedIds.size} selected</span>
                <select className="field max-w-52" value={bulkStatus} onChange={(event) => setBulkStatus(event.target.value as CrmOutreachStatus | '')} aria-label="Bulk contact status" disabled={busy || !selectedIds.size}>
                    <option value="">Choose status</option>
                    <option value="NOT_CONTACTED">Not contacted</option>
                    <option value="MESSAGED">Messaged</option>
                    <option value="DO_NOT_CONTACT">Don&apos;t contact</option>
                </select>
                <button className="btn btn-outline" disabled={busy || !selectedIds.size || selectedIds.size > 150 || !bulkStatus} onClick={() => void applyBulkStatus()}>
                    {busy ? 'Saving…' : `Apply to ${selectedIds.size}`}
                </button>
                {selectedIds.size > 0 && <button className="btn btn-ghost" disabled={busy} onClick={() => setSelectedIds(new Set())}>Clear selection</button>}
                <span className="text-xs text-[var(--text-dim)]">Status changes record manual outreach; they never send a DM.</span>
            </div>
            {!rows.length ? <Empty>{prospects.length ? 'No CRM leads match these filters.' : 'Select qualified leads in Leads and choose “Add selected to CRM outreach” to add them here.'}</Empty> : (
                <div className="overflow-x-auto border border-[var(--line)] rounded-lg">
                    <table className="w-full text-sm">
                        <thead className="text-left text-xs text-[var(--text-dim)] bg-[var(--surface-2)]">
                            <tr><th className="p-3"><input type="checkbox" className="rounded-sm border-[var(--line-strong)] accent-[var(--signal)]" aria-label="Select all visible CRM outreach leads" checked={allVisibleSelected} disabled={busy} ref={(node) => { if (node) node.indeterminate = selectedVisibleCount > 0 && !allVisibleSelected; }} onChange={() => setSelectedIds((current) => {
                                const next = new Set(current);
                                if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id));
                                else visibleIds.forEach((id) => next.add(id));
                                return next;
                            })} /></th><th className="p-3">Lead</th><th className="p-3">Website</th><th className="p-3">LinkedIn URL</th><th className="p-3">CRM hook</th><th className="p-3">Contact status</th><th className="p-3">Change status</th><th className="p-3">Stage</th><th className="p-3">Next action</th></tr>
                        </thead>
                        <tbody>
                            {rows.map((prospect) => (
                                <tr key={prospect.id} className="border-t border-[var(--line)] cursor-pointer hover:bg-[var(--surface-2)]" onClick={() => open(prospect.id)}>
                                    <td className="p-3" onClick={(event) => event.stopPropagation()}><input type="checkbox" className="rounded-sm border-[var(--line-strong)] accent-[var(--signal)]" aria-label={`Select ${prospect.data.name || 'qualified lead'}`} checked={selectedIds.has(prospect.id)} disabled={busy} onChange={() => setSelectedIds((current) => {
                                        const next = new Set(current);
                                        if (next.has(prospect.id)) next.delete(prospect.id);
                                        else next.add(prospect.id);
                                        return next;
                                    })} /></td>
                                    <td className="p-3"><b>{prospect.data.name || 'Qualified lead'}</b><span className="block text-xs text-[var(--text-dim)] max-w-xs truncate">{prospect.data.headline || prospect.data.linkedinUrl}</span></td>
                                    <ProspectUrlCell url={prospect.data.website} />
                                    <ProspectUrlCell url={prospect.data.linkedinUrl} />
                                    <td className="p-3 max-w-xs"><span className="block line-clamp-2">{prospect.data.crmHook || 'Review site before messaging'}</span></td>
                                    <td className="p-3"><span className={`badge ${crmContactStatus(prospect.data) === 'DO_NOT_CONTACT' ? 'badge-bad' : crmContactStatus(prospect.data) === 'MESSAGED' ? 'badge-info' : 'badge-idle'}`}>{crmContactStatus(prospect.data) === 'DO_NOT_CONTACT' ? "Don't contact" : crmContactStatus(prospect.data) === 'MESSAGED' ? 'Messaged' : 'Not contacted'}</span></td>
                                    <td className="p-3" onClick={(event) => event.stopPropagation()}>
                                        <select
                                            className="field min-w-36"
                                            value={crmContactStatus(prospect.data)}
                                            aria-label={`Change contact status for ${prospect.data.name || 'qualified lead'}`}
                                            title="Change contact status. Don't contact also suppresses the linked Lead CRM row."
                                            disabled={busy || pendingId !== null}
                                            onChange={async (event) => {
                                                const next = event.target.value as Exclude<CrmContactFilter, 'ALL'>;
                                                if (next === crmContactStatus(prospect.data)) return;
                                                setPendingId(prospect.id);
                                                try {
                                                    const result = await changeStatuses([prospect.id], next);
                                                    if (result && !result.skipped.some((item) => item.id === prospect.id))
                                                        setSelectedIds((current) => {
                                                            if (!current.has(prospect.id)) return current;
                                                            const remaining = new Set(current);
                                                            remaining.delete(prospect.id);
                                                            return remaining;
                                                        });
                                                } finally {
                                                    setPendingId(null);
                                                }
                                            }}
                                        >
                                            <option value="NOT_CONTACTED" disabled={(prospect.data.stage === 'DO_NOT_CONTACT' && contactedBeforeExclusion(prospect.data)) || (prospect.data.stage !== 'DO_NOT_CONTACT' && CASE_STUDY_STAGES.indexOf(prospect.data.stage) > CASE_STUDY_STAGES.indexOf('MESSAGED'))}>Not contacted</option>
                                            <option value="MESSAGED" disabled={prospect.data.stage === 'DO_NOT_CONTACT' && !contactedBeforeExclusion(prospect.data)}>Messaged</option>
                                            <option value="DO_NOT_CONTACT">Don&apos;t contact</option>
                                        </select>
                                        {pendingId === prospect.id && <span className="block text-xs text-[var(--text-dim)] mt-1">Saving…</span>}
                                    </td>
                                    <td className="p-3">{CASE_STUDY_STAGE_LABELS[prospect.data.stage]}</td>
                                    <td className="p-3 max-w-xs"><span className="block line-clamp-2">{prospect.data.nextAction || 'Review and message'}</span></td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </Panel>
    );
}

function ScanBadge({ prospect }: { prospect: CaseStudyProspect }) {
    if (prospect.data.scanStatus === 'NOT_RUN') return <span className="badge badge-idle">Not scanned</span>;
    if (prospect.data.scanStatus === 'QUEUED') return <span className="badge badge-idle">Queued</span>;
    if (prospect.data.scanStatus === 'ERROR') return <span className="badge badge-bad">Error</span>;
    if (!prospect.data.headlineQualification.qualified) return <span className="badge badge-idle">Headline rejected</span>;
    return <span className="badge badge-ok">Title matched</span>;
}

function ScannerView({ busy, run, worker, mode, prospects }: { busy: boolean; run: Run; worker: WorkerStatus | null; mode: HunterMode; prospects: CaseStudyProspect[] }) {
    const [source, setSource] = useState<WarmthSource>('CONNECTION');
    const [warmthEvidence, setWarmthEvidence] = useState('');
    const [sourcePageUrl, setSourcePageUrl] = useState('');
    const [targetTitles, setTargetTitles] = useState(DEFAULT_TARGET_TITLES.join('\n'));
    const [limit, setLimit] = useState(25);
    const [urls, setUrls] = useState('');
    const [scanSubmitting, setScanSubmitting] = useState(false);
    const [pendingScanId, setPendingScanId] = useState('');
    const titles = targetTitles.split(/\r?\n|,/).map((value) => value.trim()).filter(Boolean);
    const missedCoachCount = titles.length
        ? prospects.filter(prospect => prospect.data.mode === mode && isMissedCoachCandidate(prospect.data, titles)).length
        : 0;
    const workerActive = worker?.workerStatus?.status === 'WORKING' || Boolean(worker?.queueSize);
    const scanLocked = scanSubmitting || Boolean(pendingScanId) || workerActive;
    useEffect(() => {
        if (pendingScanId && worker?.workerStatus?.lastCompletedJobId === pendingScanId) setPendingScanId('');
    }, [pendingScanId, worker?.workerStatus?.lastCompletedJobId]);
    return (
        <div className="grid xl:grid-cols-[1.25fr_.75fr] gap-5">
            <Panel title="Scan a warm LinkedIn source" action={<span className="badge badge-info">No outreach is sent</span>}>
                <p className="text-xs text-[var(--text-dim)]">New profiles will enter the {mode === 'CASE_STUDY' ? 'Case Study' : 'Client'} Hunter pipeline. Change mode above before scanning.</p>
                <div className="grid sm:grid-cols-2 gap-4">
                    <Field label="Warm source">
                        <select className="field w-full" value={source} onChange={(event) => setSource(event.target.value as WarmthSource)}>
                            {WARMTH_SOURCES.filter((value) => value !== 'REPLIED' && value !== 'MANUAL').map((value) => <option key={value} value={value}>{WARMTH_LABELS[value]}</option>)}
                        </select>
                    </Field>
                    <Field label="New profiles to collect" hint="Pipeline duplicates do not count toward this target. The scanner keeps looking until it reaches the target or the source stops loading new profiles.">
                        <input className="field w-full" type="number" min={1} max={MAX_SOURCE_SCAN_PROFILES} step={1} value={limit} onChange={(event) => setLimit(Number(event.target.value))} />
                    </Field>
                </div>
                {source === 'ENGAGER' && <Field label="LinkedIn post URL" value={sourcePageUrl} onChange={setSourcePageUrl} hint="Paste a full LinkedIn post URL or an lnkd.in post link." />}
                <Field label="Warmth evidence" value={warmthEvidence} onChange={setWarmthEvidence} multiline hint="Example: Existing first-degree connection. This becomes part of the prospect record." />
                <Field label="Target job titles" value={targetTitles} onChange={setTargetTitles} multiline hint="One title per line. Matches Coach/Coaching wording, compound titles and declared coach roles with relevant context. Founder, CEO or Consultant alone does not qualify under the defaults." />
                <div className="flex flex-wrap gap-2">
                    <button
                        className="btn btn-primary"
                        disabled={busy || scanLocked || !titles.length || !Number.isInteger(limit) || limit < 1 || limit > MAX_SOURCE_SCAN_PROFILES || (source === 'ENGAGER' && !sourcePageUrl.trim())}
                        onClick={async () => {
                            if (scanLocked) return;
                            setScanSubmitting(true);
                            try {
                                const result = await run(
                                    () => queueCaseStudySourceScanAction({ source, mode, warmthEvidence, sourcePageUrl, targetTitles: titles, limit }),
                                    'Source scan added to the Case Study worker.',
                                );
                                if (result) setPendingScanId(result.jobId);
                            } finally {
                                setScanSubmitting(false);
                            }
                        }}
                    >{scanLocked ? 'Scan running…' : 'Scan visible profiles'}</button>
                    <button
                        className="btn btn-danger"
                        disabled={busy || (!scanLocked && !workerActive)}
                        onClick={async () => {
                            const result = await run(
                                () => stopCaseStudyRunAction(),
                                (outcome) => `Stop requested. ${outcome.removed} pending job${outcome.removed === 1 ? '' : 's'} cleared.`,
                            );
                            if (result) setPendingScanId('');
                        }}
                    >Stop run</button>
                    <button
                        className="btn btn-outline"
                        disabled={busy || scanLocked || !titles.length || missedCoachCount === 0}
                        onClick={async () => {
                            if (scanLocked) return;
                            setScanSubmitting(true);
                            try {
                                const result = await run(
                                    () => queueMissedCoachProfilesAction({ mode, targetTitles: titles }),
                                    outcome => `${outcome.queued} previously rejected coach profile${outcome.queued === 1 ? '' : 's'} queued for fresh headline and website discovery.${outcome.remaining ? ` ${outcome.remaining} remain for another run.` : ''}`,
                                );
                                if (result?.jobIds.length) setPendingScanId(result.jobIds[result.jobIds.length - 1]);
                            } finally {
                                setScanSubmitting(false);
                            }
                        }}
                    >Recheck missed coaches ({missedCoachCount})</button>
                </div>
                <p className="text-xs text-[var(--text-dim)]">Stop cancels the active scan and clears its pending profiles. The worker stays online for the next run.</p>
                <p className="text-xs text-[var(--text-dim)]">Recheck reviews existing headline rejections that match these titles. It reuses their pipeline records and leaves CRM outreach and contacted prospects separate.</p>
            </Panel>

            <div className="space-y-5">
                <Panel title="How this run works">
                    {[
                        ['1', 'Read headline', 'The worker opens each LinkedIn profile and reads its current headline.'],
                        ['2', 'Apply title gate', 'Title variants and declared coach roles are matched against your selected titles before website discovery.'],
                        ['3', 'Find website', 'Qualified profiles use LinkedIn contact, About, Featured, and visible links.'],
                        ['4', 'Save to pipeline', 'Review the website and LinkedIn links, then update outreach status directly in the table.'],
                    ].map(([number, title, copy]) => (
                        <div key={number} className="flex gap-3 py-2">
                            <span className="badge badge-idle num self-start">{number}</span>
                            <div><b className="text-sm">{title}</b><p className="text-xs text-[var(--text-dim)] mt-1">{copy}</p></div>
                        </div>
                    ))}
                </Panel>
                <details className="panel">
                    <summary className="px-4 py-3 cursor-pointer font-medium">Add specific profile URLs</summary>
                    <div className="border-t border-[var(--line)] p-4 space-y-4">
                        <Field label="LinkedIn profile URLs" value={urls} onChange={setUrls} multiline hint="One /in/ URL per line." />
                        <button
                            className="btn btn-outline"
                            disabled={busy || !urls.trim() || !titles.length}
                            onClick={async () => {
                                const parsed = urls.split(/[\n,]+/).map((value) => value.trim()).filter(Boolean);
                                const result = await run(
                                    () => queueCaseStudyProspectsAction({ urls: parsed, source, mode, warmthEvidence, targetTitles: titles }),
                                    (outcome) => `${outcome.queued.length} new profile${outcome.queued.length === 1 ? '' : 's'} queued; ${outcome.skipped.length} already in the prospect pipeline skipped.`,
                                );
                                if (result) setUrls('');
                            }}
                        >Queue profile URLs</button>
                    </div>
                </details>
            </div>
        </div>
    );
}

function CrmOutreachWorkspace({ prospect, activities, busy, error, message, run, onBack }: {
    prospect: CaseStudyProspect;
    activities: CaseStudyActivity[];
    busy: boolean;
    error: string;
    message: string;
    run: Run;
    onBack: () => void;
}) {
    const [draft, setDraft] = useState<CaseStudyProspectData>(() => structuredClone(prospect.data));
    const [note, setNote] = useState('');
    const set = <K extends keyof CaseStudyProspectData>(key: K, value: CaseStudyProspectData[K]) => setDraft((current) => ({ ...current, [key]: value }));
    const dmNotSent = crmContactStatus(draft) === 'NOT_CONTACTED';
    return (
        <div className="space-y-5 max-w-5xl">
            <div className="flex flex-wrap items-center gap-3">
                <button className="btn btn-ghost" onClick={onBack}>← CRM outreach</button>
                <h2 className="text-xl font-semibold flex-1">{draft.name || 'Qualified lead'}</h2>
                <span className={`badge ${draft.stage === 'DO_NOT_CONTACT' ? 'badge-bad' : dmNotSent ? 'badge-idle' : 'badge-info'}`}>{draft.stage === 'DO_NOT_CONTACT' ? "Don't contact" : dmNotSent ? 'Not contacted' : 'Messaged'}</span>
                <span className="text-xs text-[var(--text-dim)]">{CASE_STUDY_STAGE_LABELS[draft.stage]}</span>
            </div>
            {error && <p role="alert" className="panel-note text-[var(--bad)]">{error}</p>}
            {message && <p role="status" className="panel-note text-[var(--signal)]">{message}</p>}
            <div className="grid lg:grid-cols-2 gap-5">
                <Panel title="Lead from CRM">
                    {draft.headline && <p className="font-medium">{draft.headline}</p>}
                    <p className="text-sm text-[var(--text-dim)]">{draft.location || 'Location not recorded'}</p>
                    <div className="flex flex-wrap gap-3 text-sm">
                        <LinkOut url={draft.linkedinUrl}>Open LinkedIn profile</LinkOut>
                        {draft.website && <LinkOut url={draft.website}>Open website</LinkOut>}
                    </div>
                    <div className="panel-note">
                        <p className="label-micro">Existing CRM hook</p>
                        <p className="whitespace-pre-wrap">{draft.crmHook || 'No hook saved in the Lead CRM.'}</p>
                    </div>
                    <p className="text-xs text-[var(--text-dim)]">Review this hook against the live site before writing your DM.</p>
                </Panel>
                <Panel title="Manual LinkedIn outreach">
                    <div className="flex flex-wrap items-center gap-3">
                        {prospect.data.stage === 'DO_NOT_CONTACT' && draft.stage !== 'DO_NOT_CONTACT' ? <span className="text-xs text-[var(--text-dim)]">Save changes to resume outreach.</span> : draft.stage === 'DO_NOT_CONTACT' ? <span className="badge badge-bad">{prospect.data.stage === 'DO_NOT_CONTACT' ? 'Lead CRM suppressed' : 'Save changes to suppress Lead CRM'}</span> : dmNotSent ? (
                            <button className="btn btn-primary" disabled={busy} onClick={() => void run(
                                () => markHunterProspectLinkedinDmSentAction(prospect.id),
                                'LinkedIn DM recorded in this queue and the Lead CRM. Follow-up is due in 48 hours.',
                            )}>Mark DM sent</button>
                        ) : draft.stage === 'MESSAGED' ? (
                            <><span className="badge badge-info">DM sent</span><button className="btn btn-ghost" disabled={busy} onClick={() => void run(
                                () => undoHunterProspectLinkedinDmAction(prospect.id),
                                'DM mark removed from this queue and the Lead CRM.',
                            )}>Undo DM</button></>
                        ) : <span className="badge badge-info">Outreach recorded</span>}
                    </div>
                    <Field label="Stage">
                        <select className="field w-full" value={draft.stage} onChange={(event) => set('stage', event.target.value as CaseStudyProspectData['stage'])}>
                            {CASE_STUDY_STAGES.map((value) => <option key={value} value={value}>{CASE_STUDY_STAGE_LABELS[value]}</option>)}
                        </select>
                    </Field>
                    {(draft.stage === 'DO_NOT_CONTACT' || prospect.data.stage === 'DO_NOT_CONTACT') && draft.stage !== prospect.data.stage &&
                        <p className="text-xs text-[var(--text-dim)]">Save this stage change to update the linked Lead CRM suppression.</p>}
                    <Field label="Next action" value={draft.nextAction} onChange={(value) => set('nextAction', value)} />
                    <Field label="Due" type="datetime-local" value={localInput(draft.nextActionDueAt)} onChange={(value) => set('nextActionDueAt', isoInput(value))} />
                    <p className="text-xs text-[var(--text-dim)]">After a reply, send the specific Loom or audit. There is no qualifying-question step.</p>
                </Panel>
            </div>
            <Panel title="Notes and activity">
                <Field label="Notes" value={draft.notes} multiline onChange={(value) => set('notes', value)} />
                <div className="space-y-2">
                    {activities.slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).map((activity) => (
                        <div key={activity.id} className="text-sm flex gap-3"><span className="text-xs text-[var(--text-faint)] min-w-36">{dateTime(activity.createdAt)}</span><span>{activity.note}</span></div>
                    ))}
                </div>
                <div className="grid sm:grid-cols-[1fr_auto] gap-3">
                    <input className="field" value={note} onChange={(event) => setNote(event.target.value)} placeholder="Add an activity note" />
                    <button className="btn btn-outline" disabled={busy || !note.trim()} onClick={async () => {
                        const saved = await run(() => addCaseStudyNoteAction(prospect.id, note), 'Activity note added.');
                        if (saved !== null) setNote('');
                    }}>Add note</button>
                </div>
            </Panel>
            <div className="flex justify-end">
                <button className="btn btn-primary" disabled={busy} onClick={() => void run(
                    () => saveCaseStudyProspectAction(prospect.id, draft, prospect.revision),
                    'CRM outreach record saved.',
                )}>{busy ? 'Saving…' : 'Save changes'}</button>
            </div>
        </div>
    );
}

function ProspectWorkspace({ prospect, activities, busy, error, message, run, onBack }: {
    prospect: CaseStudyProspect;
    activities: CaseStudyActivity[];
    busy: boolean;
    error: string;
    message: string;
    run: Run;
    onBack: () => void;
}) {
    const [draft, setDraft] = useState<CaseStudyProspectData>(() => structuredClone(prospect.data));
    const [note, setNote] = useState('');
    const set = <K extends keyof CaseStudyProspectData>(key: K, value: CaseStudyProspectData[K]) => setDraft((current) => ({ ...current, [key]: value }));
    const setDelivery = <K extends keyof CaseStudyProspectData['delivery']>(key: K, value: CaseStudyProspectData['delivery'][K]) =>
        setDraft((current) => ({ ...current, delivery: { ...current.delivery, [key]: value } }));
    return (
        <div className="space-y-5 max-w-7xl">
            <div className="flex flex-wrap items-center gap-3">
                <button className="btn btn-ghost" onClick={onBack}>← Case Study Hunter</button>
                <h2 className="text-xl font-semibold flex-1">{draft.name || 'Prospect review'}</h2>
                <ScanBadge prospect={{ ...prospect, data: draft }} />
            </div>
            {error && <p role="alert" className="panel-note text-[var(--bad)]">{error}</p>}
            {message && <p role="status" className="panel-note text-[var(--signal)]">{message}</p>}

            <div className="grid lg:grid-cols-2 gap-5">
                <Panel title="Profile and website" action={<button className="btn btn-ghost" disabled={busy || draft.stage === 'DO_NOT_CONTACT'} onClick={() => void run(
                    () => retryCaseStudyProspectAction(prospect.id),
                    'Headline qualification and website discovery queued.',
                )}>Refresh profile</button>}>
                    <p className="font-medium">{draft.headline || 'No headline captured'}</p>
                    <p className="text-sm text-[var(--text-dim)]">{draft.headlineQualification.reason || 'The headline gate has not run yet.'}</p>
                    <span className="badge badge-idle">{WARMTH_LABELS[draft.source]}</span>
                    {draft.warmthEvidence && <p className="text-sm text-[var(--text-dim)]">{draft.warmthEvidence}</p>}
                    <div className="space-y-3">
                        <div><p className="label-micro mb-1">LinkedIn</p><LinkOut url={draft.linkedinUrl}>{draft.linkedinUrl}</LinkOut></div>
                        <div><p className="label-micro mb-1">Website</p>{draft.website ? <LinkOut url={draft.website}>{draft.website}</LinkOut> : <p className="text-sm text-[var(--text-dim)]">No public website found.</p>}</div>
                    </div>
                </Panel>
                <Panel title="Outreach and next action">
                    <Field label="Status">
                        <select className="field w-full" value={draft.stage} onChange={(event) => set('stage', event.target.value as CaseStudyProspectData['stage'])}>
                            {CASE_STUDY_STAGES.map((stage) => <option key={stage} value={stage}>{CASE_STUDY_STAGE_LABELS[stage]}</option>)}
                        </select>
                    </Field>
                    <div className="flex flex-wrap items-center gap-3">
                        {draft.stage === 'DO_NOT_CONTACT' ? <span className="badge badge-bad">Don&apos;t contact</span> : CASE_STUDY_STAGES.indexOf(draft.stage) < CASE_STUDY_STAGES.indexOf('MESSAGED') ? (
                            <button className="btn btn-outline" disabled={busy} onClick={() => void run(
                                () => markHunterProspectLinkedinDmSentAction(prospect.id),
                                'LinkedIn DM recorded. Follow-up is due in 48 hours.',
                            )}>Mark DM sent</button>
                        ) : draft.stage === 'MESSAGED' ? (
                            <button className="btn btn-ghost" disabled={busy} onClick={() => void run(
                                () => undoHunterProspectLinkedinDmAction(prospect.id),
                                'DM mark removed.',
                            )}>Undo DM</button>
                        ) : <span className="badge badge-info">Outreach recorded</span>}
                    </div>
                    <Field label="Next action" value={draft.nextAction} onChange={(value) => set('nextAction', value)} />
                    <Field label="Due" type="datetime-local" value={localInput(draft.nextActionDueAt)} onChange={(value) => set('nextActionDueAt', isoInput(value))} />
                    <Field label="Loom / audit URL" value={draft.delivery.auditUrl} onChange={(value) => setDelivery('auditUrl', value)} />
                    <Field label="Discovery call" type="datetime-local" value={localInput(draft.delivery.discoveryCallAt)} onChange={(value) => setDelivery('discoveryCallAt', isoInput(value))} />
                    <p className="text-xs text-[var(--text-dim)]">A reply moves directly to sending the specific Loom or audit. There is no qualifying-question step.</p>
                </Panel>
            </div>

            {isDeliveryStage(draft.stage) && (
                <details className="panel" open>
                    <summary className="px-4 py-3 cursor-pointer font-medium">Case study delivery archive</summary>
                    <div className="border-t border-[var(--line)] p-4 grid lg:grid-cols-2 gap-4">
                        <Field label="Three strongest leaks" value={draft.delivery.strongestLeaks.join('\n')} multiline onChange={(value) => setDelivery('strongestLeaks', [...value.split(/\r?\n/).slice(0, 3), '', '', ''].slice(0, 3))} />
                        <Field label="Loom / audit URL" value={draft.delivery.auditUrl} onChange={(value) => setDelivery('auditUrl', value)} />
                        <Field label="Discovery call" type="datetime-local" value={localInput(draft.delivery.discoveryCallAt)} onChange={(value) => setDelivery('discoveryCallAt', isoInput(value))} />
                        <Field label="Final case study URL" value={draft.delivery.caseStudyUrl} onChange={(value) => setDelivery('caseStudyUrl', value)} />
                        <Field label="Before screenshot URLs" value={draft.delivery.beforeScreenshots.join('\n')} multiline onChange={(value) => setDelivery('beforeScreenshots', value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))} />
                        <Field label="After screenshot URLs" value={draft.delivery.afterScreenshots.join('\n')} multiline onChange={(value) => setDelivery('afterScreenshots', value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))} />
                        <Field label="Old copy" value={draft.delivery.oldCopy} multiline onChange={(value) => setDelivery('oldCopy', value)} />
                        <Field label="New copy" value={draft.delivery.newCopy} multiline onChange={(value) => setDelivery('newCopy', value)} />
                        <Field label="Rationale" value={draft.delivery.rationale} multiline onChange={(value) => setDelivery('rationale', value)} />
                        <Field label="Metrics / results" value={draft.delivery.metrics} multiline onChange={(value) => setDelivery('metrics', value)} />
                        <Field label="Testimonial" value={draft.delivery.testimonial} multiline onChange={(value) => setDelivery('testimonial', value)} />
                    </div>
                </details>
            )}

            <details className="panel">
                <summary className="px-4 py-3 cursor-pointer font-medium">Record details and activity</summary>
                <div className="border-t border-[var(--line)] p-4 space-y-5">
                    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                        <Field label="Name" value={draft.name} onChange={(value) => set('name', value)} />
                        <Field label="Location" value={draft.location} onChange={(value) => set('location', value)} />
                        <Field label="Email" value={draft.email} onChange={(value) => set('email', value)} />
                        <Field label="LinkedIn URL" value={draft.linkedinUrl} onChange={(value) => set('linkedinUrl', value)} />
                        <Field label="Website" value={draft.website} onChange={(value) => set('website', value)} />
                        <Field label="Mode">
                            <select className="field w-full" value={draft.mode} onChange={(event) => set('mode', event.target.value as HunterMode)}><option value="CASE_STUDY">Case Study</option><option value="CLIENT">Client</option></select>
                        </Field>
                    </div>
                    <Field label="Notes" value={draft.notes} multiline onChange={(value) => set('notes', value)} />
                    <div className="space-y-2">
                        {activities.slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).map((activity) => (
                            <div key={activity.id} className="text-sm flex gap-3"><span className="text-xs text-[var(--text-faint)] min-w-36">{dateTime(activity.createdAt)}</span><span>{activity.note}</span></div>
                        ))}
                    </div>
                    <div className="grid sm:grid-cols-[1fr_auto] gap-3">
                        <input className="field" value={note} onChange={(event) => setNote(event.target.value)} placeholder="Add an activity note" />
                        <button className="btn btn-outline" disabled={busy || !note.trim()} onClick={async () => {
                            const saved = await run(() => addCaseStudyNoteAction(prospect.id, note), 'Activity note added.');
                            if (saved !== null) setNote('');
                        }}>Add note</button>
                    </div>
                </div>
            </details>

            <div className="flex justify-end">
                <button className="btn btn-primary btn-lg" disabled={busy} onClick={() => void run(
                    () => saveCaseStudyProspectAction(prospect.id, draft, prospect.revision),
                    'Prospect record saved.',
                )}>{busy ? 'Saving…' : 'Save prospect'}</button>
            </div>
        </div>
    );
}

