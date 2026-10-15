'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Copy, FileText, Loader2, Plus, Save, Settings2 } from 'lucide-react';
import {
    createDiscoveryCallAction, loadDiscoveryCallsAction, saveDiscoveryCallAction,
    saveDiscoveryTemplateAction, startDiscoveryOnboardingAction,
} from '@/app/actions/discovery-call-actions';
import {
    CALL_OUTCOMES, CALL_OUTCOME_LABELS, blankDiscoveryCall, discoveryRecap, discoveryCallSchema, unwrapDiscoveryResult,
    type CallQuestion, type CallTemplateData, type DiscoveryCall, type DiscoveryCallData, type DiscoverySnapshot,
} from '@/lib/discovery-calls';
import { FUNNEL_LABELS, FUNNEL_TYPES } from '@/lib/business';
import { dateTime, Field, isoInput, LinkOut, localInput, Panel } from './BusinessUi';
import DiscoveryQuestionEditor from './DiscoveryQuestionEditor';
import './discovery-calls.css';

type Step = 'context' | 'questions' | 'offer' | 'notes' | 'outcome';
const STEPS: { id: Step; label: string }[] = [
    { id: 'context', label: 'Prospect context' }, { id: 'questions', label: 'Questions' },
    { id: 'offer', label: 'Explain your offer' }, { id: 'notes', label: 'Call notes' }, { id: 'outcome', label: 'Wrap-up' },
];
function errorText(error: unknown) {
    if (error && typeof error === 'object' && 'issues' in error && Array.isArray(error.issues))
        return error.issues.map((issue: { message: string }) => issue.message).join(' ');
    return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

export default function DiscoveryCallsWorkspace({ onOnboarding }: { onOnboarding: (projectId: string) => void }) {
    const [snapshot, setSnapshot] = useState<DiscoverySnapshot | null>(null);
    const [selected, setSelected] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    const [templates, setTemplates] = useState(false);
    const [questionsOnly, setQuestionsOnly] = useState(false);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [search, setSearch] = useState('');
    const [view, setView] = useState<'upcoming' | 'completed'>('upcoming');
    const refresh = useCallback(async () => {
        setError('');
        try { setSnapshot(await loadDiscoveryCallsAction()); }
        catch (e) { setError(errorText(e)); }
    }, []);
    useEffect(() => { void refresh(); }, [refresh]);
    const updateCall = useCallback((call: DiscoveryCall) => {
        setSnapshot(current => current && ({ ...current, calls: [call, ...current.calls.filter(item => item.id !== call.id)] }));
    }, []);
    const create = async (data: DiscoveryCallData, sourceId?: string) => {
        setBusy(true); setError('');
        try {
            const call = unwrapDiscoveryResult(await createDiscoveryCallAction(data, sourceId));
            updateCall(call); setCreating(false); setSelected(call.id);
        } catch (e) { setError(errorText(e)); }
        finally { setBusy(false); }
    };
    const call = snapshot?.calls.find(item => item.id === selected);
    return <div className="discovery-workspace space-y-5">
        {error && <div role="alert" className="panel panel-body text-[var(--bad)]">{error}<button className="btn btn-outline ml-3" onClick={() => void refresh()}>Reload</button></div>}
        {!snapshot ? !error && <p role="status" className="text-[var(--text-dim)]">Loading discovery calls…</p> :
            call ? <CallEditor key={call.id} initialCall={call} onSaved={updateCall} onBack={() => setSelected(null)} onOnboarding={onOnboarding} /> :
            templates ? <TemplateEditor key={snapshot.template.revision} template={snapshot.template} questionsOnly={questionsOnly} onBack={() => setTemplates(false)} onSaved={template => { setSnapshot({ ...snapshot, template }); setTemplates(false); }} /> :
            creating ? <CreateCall snapshot={snapshot} busy={busy} onCreate={create} onBack={() => setCreating(false)} /> : (() => {
                const matching = snapshot.calls.filter(item => (view === 'upcoming' ? item.data.outcome === 'PENDING' || item.data.outcome === 'FOLLOW_UP' : !['PENDING', 'FOLLOW_UP'].includes(item.data.outcome)) && `${item.data.name} ${item.data.businessName}`.toLowerCase().includes(search.toLowerCase()));
                matching.sort((a, b) => {
                    const time = (item: DiscoveryCall) => Date.parse(item.data.outcome === 'FOLLOW_UP' ? item.data.followUpAt || item.data.scheduledAt : item.data.scheduledAt) || Infinity;
                    return view === 'upcoming' ? time(a) - time(b) : Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
                });
                const unprepared = snapshot.sources.filter(source => source.stage === 'CALL_BOOKED' && !snapshot.calls.some(item => item.sourceProspectId === source.id));
                return <>
                    <div className="call-list-intro">
                        <div><p className="call-eyebrow">Before the conversation</p><h2>Know the person. Have the right questions ready.</h2><p>Keep your prep, pitch, and answers together, then carry the brief into onboarding.</p></div>
                        <div className="flex gap-2 flex-wrap"><button className="btn btn-outline" onClick={() => { setQuestionsOnly(true); setTemplates(true); }}><Settings2 className="w-4 h-4" /> Edit questions</button><button className="btn btn-outline" onClick={() => { setQuestionsOnly(false); setTemplates(true); }}><Settings2 className="w-4 h-4" /> Templates</button><button className="btn btn-primary" onClick={() => setCreating(true)}><Plus className="w-4 h-4" /> Prepare a call</button></div>
                    </div>
                    {unprepared.length > 0 && <Panel title="Booked prospects to prepare">
                        <div className="divide-y divide-[var(--line)]">{unprepared.map(source => <div key={source.id} className="call-list-row"><div><strong>{source.name || source.headline}</strong><p>{dateTime(source.scheduledAt)}</p></div><button disabled={busy} className="btn btn-outline" onClick={() => void create(blankDiscoveryCall(snapshot.template.data), source.id)}>Prepare call <ArrowRight className="w-4 h-4" /></button></div>)}</div>
                    </Panel>}
                    <div className="call-list-controls"><div className="seg" aria-label="Call list"><button className={`seg-item ${view === 'upcoming' ? 'seg-item-active' : ''}`} onClick={() => setView('upcoming')}>Upcoming & follow-ups</button><button className={`seg-item ${view === 'completed' ? 'seg-item-active' : ''}`} onClick={() => setView('completed')}>Completed</button></div><input className="field" aria-label="Search calls" placeholder="Search a prospect…" value={search} onChange={e => setSearch(e.target.value)} /></div>
                    <Panel title={view === 'upcoming' ? 'Your next conversations' : 'Past conversations'}>
                        {!matching.length ? <div className="call-empty"><FileText className="w-7 h-7" /><h3>{search ? 'No matching calls' : view === 'upcoming' ? 'Your next call starts here' : 'No completed calls yet'}</h3><p>{search ? 'Try another name.' : view === 'upcoming' ? 'Choose a prospect or add someone manually. Your questions and three-pillar pitch will be ready.' : 'Record the outcome after a call to keep its answers and next steps here.'}</p>{!search && view === 'upcoming' && <button className="btn btn-primary" onClick={() => setCreating(true)}>Prepare a call <ArrowRight className="w-4 h-4" /></button>}</div> :
                            <div className="divide-y divide-[var(--line)]">{matching.map(item => <button key={item.id} className="call-list-row call-list-button" onClick={() => setSelected(item.id)}><span className="min-w-0"><strong>{item.data.name}</strong><span className="call-row-detail">{item.data.projectType === 'CASE_STUDY' ? 'Case study' : 'Paid project'} · {item.data.outcome === 'FOLLOW_UP' ? `Follow-up: ${dateTime(item.data.followUpAt)}` : dateTime(item.data.scheduledAt)}</span></span><span className="call-row-status"><span className={`mark ${item.data.outcome === 'AGREED' ? 'mark-info' : 'mark-idle'}`}>{CALL_OUTCOME_LABELS[item.data.outcome]}</span><span>{item.data.questions.filter(q => q.answer.trim()).length}/{item.data.questions.length} answered</span></span><ArrowRight className="w-4 h-4 flex-none" /></button>)}</div>}
                    </Panel>
                </>;
            })()}
    </div>;
}

function CreateCall({ snapshot, busy, onCreate, onBack }: {
    snapshot: DiscoverySnapshot; busy: boolean; onCreate: (data: DiscoveryCallData, sourceId?: string) => Promise<void>; onBack: () => void;
}) {
    const [mode, setMode] = useState<'prospect' | 'manual'>(snapshot.sources.length ? 'prospect' : 'manual');
    const [search, setSearch] = useState('');
    const [draft, setDraft] = useState(() => blankDiscoveryCall(snapshot.template.data));
    const set = (key: keyof DiscoveryCallData, value: string) => setDraft(current => ({ ...current, [key]: value }));
    return <div className="space-y-4"><button className="btn btn-ghost" onClick={onBack}><ArrowLeft className="w-4 h-4" /> Back to calls</button><Panel title="Prepare a discovery call">
        <div className="seg"><button className={`seg-item ${mode === 'prospect' ? 'seg-item-active' : ''}`} onClick={() => setMode('prospect')}>Existing prospect</button><button className={`seg-item ${mode === 'manual' ? 'seg-item-active' : ''}`} onClick={() => setMode('manual')}>Add manually</button></div>
        {mode === 'prospect' ? <><input className="field w-full" aria-label="Search prospects" placeholder="Search by name or website…" value={search} onChange={e => setSearch(e.target.value)} /><div className="call-source-list">{snapshot.sources.filter(source => `${source.name} ${source.website} ${source.headline}`.toLowerCase().includes(search.toLowerCase())).map(source => {
            const existing = snapshot.calls.some(item => item.sourceProspectId === source.id);
            return <div className="call-list-row" key={source.id}><div className="min-w-0"><strong>{source.name || source.headline}</strong><p className="break-all">{source.website || source.headline}</p></div><button disabled={busy} className="btn btn-outline flex-none" onClick={() => void onCreate(draft, source.id)}>{existing ? 'Open prep' : 'Prepare'} <ArrowRight className="w-4 h-4" /></button></div>;
        })}{!snapshot.sources.length && <p className="text-[var(--text-dim)] py-5">No prospects yet. Use Add manually to prepare your first call.</p>}</div></> :
            <form onSubmit={e => { e.preventDefault(); void onCreate(draft); }}><fieldset disabled={busy} className="space-y-5"><div className="grid md:grid-cols-2 gap-4"><Field label="Prospect name" required value={draft.name} onChange={value => set('name', value)} /><Field label="Business name" value={draft.businessName} onChange={value => set('businessName', value)} /><Field label="Email" type="email" value={draft.email} onChange={value => set('email', value)} /><Field label="Website" type="url" value={draft.website} onChange={value => set('website', value)} /><Field label="Call date & time" type="datetime-local" value={localInput(draft.scheduledAt)} onChange={value => set('scheduledAt', isoInput(value))} /><Field label="Working relationship"><select aria-label="Working relationship" className="field w-full" value={draft.projectType} onChange={e => set('projectType', e.target.value)}><option value="CASE_STUDY">Free case study</option><option value="PAID">Paid project</option></select></Field></div><Field label="What do you already know?" hint="Paste your conversation or add context you want to remember." multiline value={draft.context} onChange={value => set('context', value)} /><button className="btn btn-primary" type="submit">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />} Create call prep</button></fieldset></form>}
    </Panel></div>;
}

function CallEditor({ initialCall, onSaved, onBack, onOnboarding }: {
    initialCall: DiscoveryCall; onSaved: (call: DiscoveryCall) => void; onBack: () => void; onOnboarding: (projectId: string) => void;
}) {
    const [draft, setDraft] = useState(initialCall.data);
    const [step, setStep] = useState<Step>('questions');
    const [questionId, setQuestionId] = useState(initialCall.data.questions[0]?.id || '');
    const [editingQuestion, setEditingQuestion] = useState(false);
    const [managingQuestions, setManagingQuestions] = useState(false);
    const [callMode, setCallMode] = useState(false);
    const [status, setStatus] = useState('All changes saved');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [copied, setCopied] = useState(false);
    const [restored, setRestored] = useState(false);
    const savedRef = useRef(initialCall);
    const draftRef = useRef(draft);
    const savingRef = useRef<Promise<DiscoveryCall | null> | null>(null);
    const blockedRef = useRef(false);
    const sectionNavRef = useRef<HTMLElement>(null);
    const [storageReady, setStorageReady] = useState(false);
    const storageKey = `compel-discovery-draft:${initialCall.id}`;
    draftRef.current = draft;
    const set = <K extends keyof DiscoveryCallData>(key: K, value: DiscoveryCallData[K]) => setDraft(current => ({ ...current, [key]: value }));
    useEffect(() => {
        const nav = sectionNavRef.current;
        if (!nav) return;
        const reveal = () => {
            const active = nav.querySelector<HTMLElement>('[aria-current="step"]');
            if (!active || nav.scrollWidth <= nav.clientWidth) return;
            nav.scrollLeft += active.getBoundingClientRect().left - nav.getBoundingClientRect().left - (nav.clientWidth - active.offsetWidth) / 2;
        };
        reveal();
        const observer = new ResizeObserver(reveal);
        observer.observe(nav);
        return () => observer.disconnect();
    }, [step]);
    useEffect(() => {
        try {
            const stored = localStorage.getItem(storageKey);
            if (stored) {
                const backup = JSON.parse(stored);
                const parsed = discoveryCallSchema.safeParse(backup.data);
                if (parsed.success && JSON.stringify(parsed.data) === JSON.stringify(initialCall.data)) {
                    localStorage.removeItem(storageKey);
                } else if (backup.revision === initialCall.revision && parsed.success) {
                    setDraft(parsed.data); setRestored(true);
                } else if (backup.revision !== initialCall.revision) {
                    setError('A local draft from an older revision is available. Copy it before replacing it with the saved call.');
                    blockedRef.current = true;
                }
            }
        } catch { /* Server persistence is still available when device storage is disabled. */ }
        setStorageReady(true);
    // The editor is keyed by call ID. Restore once, so later saves do not reset active notes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [storageKey]);
    const save = useCallback(async (): Promise<DiscoveryCall | null> => {
        if (savingRef.current) { await savingRef.current; return save(); }
        if (blockedRef.current) return null;
        const payload = draftRef.current;
        if (JSON.stringify(payload) === JSON.stringify(savedRef.current.data)) return savedRef.current;
        setStatus('Saving…'); setError('');
        const work = (async () => {
            try {
                const result = unwrapDiscoveryResult(await saveDiscoveryCallAction(savedRef.current.id, payload, savedRef.current.revision));
                savedRef.current = result; onSaved(result); setStatus(JSON.stringify(draftRef.current) === JSON.stringify(payload) ? 'All changes saved' : 'Unsaved changes'); setRestored(false);
                try {
                    if (JSON.stringify(draftRef.current) === JSON.stringify(payload)) localStorage.removeItem(storageKey);
                    else localStorage.setItem(storageKey, JSON.stringify({ revision: result.revision, data: draftRef.current }));
                } catch { /* Saving to the database succeeded. */ }
                return result;
            } catch (e) {
                const message = errorText(e);
                if (message.includes('another window')) blockedRef.current = true;
                setError(message); setStatus('Changes need saving'); return null;
            } finally { savingRef.current = null; }
        })();
        savingRef.current = work;
        return work;
    }, [onSaved, storageKey]);
    useEffect(() => {
        if (!storageReady || blockedRef.current) return;
        const dirty = JSON.stringify(draft) !== JSON.stringify(savedRef.current.data);
        if (!dirty) return;
        setStatus('Unsaved changes');
        try { localStorage.setItem(storageKey, JSON.stringify({ revision: savedRef.current.revision, data: draft })); } catch { /* Database save remains available. */ }
        const timer = setTimeout(() => void save(), 1200);
        return () => clearTimeout(timer);
    }, [draft, storageReady, storageKey, save]);
    useEffect(() => {
        const guard = (event: BeforeUnloadEvent) => {
            if (JSON.stringify(draftRef.current) !== JSON.stringify(savedRef.current.data)) { event.preventDefault(); }
        };
        window.addEventListener('beforeunload', guard);
        return () => window.removeEventListener('beforeunload', guard);
    }, []);
    const currentIndex = Math.max(0, draft.questions.findIndex(q => q.id === questionId));
    const question = draft.questions[currentIndex];
    const answered = draft.questions.filter(q => q.answer.trim()).length;
    const updateQuestion = (patch: Partial<CallQuestion>) => {
        if (question) set('questions', draft.questions.map(q => q.id === question.id ? { ...q, ...patch } : q));
    };
    const copy = async (value: string) => {
        try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 2000); }
        catch { setError('Could not access the clipboard. Select the text and copy it manually.'); }
    };
    const leave = async () => {
        setBusy(true);
        const saved = await save();
        setBusy(false);
        if (saved) onBack();
    };
    const startOnboarding = async () => {
        setBusy(true); setError('');
        try {
            const saved = await save();
            if (!saved) return;
            const project = unwrapDiscoveryResult(await startDiscoveryOnboardingAction(saved.id, saved.revision));
            try { localStorage.removeItem(storageKey); } catch { /* No draft to retain after handoff. */ }
            onOnboarding(project.id);
        } catch (e) { setError(errorText(e)); }
        finally { setBusy(false); }
    };
    return <div className={`call-editor ${callMode ? 'call-focus-mode' : ''}`}>
        <div className="call-toolbar"><button className="btn btn-ghost" disabled={busy} onClick={() => void leave()}><ArrowLeft className="w-4 h-4" /> All calls</button><div className="flex items-center gap-2 flex-wrap"><span role="status" className="call-save-status">{status === 'All changes saved' && <Check className="w-3.5 h-3.5" />}{status}</span><button className="btn btn-outline" aria-pressed={callMode} onClick={() => setCallMode(!callMode)}>{callMode ? 'Exit call mode' : 'Call mode'}</button><button className="btn btn-outline" disabled={busy || status === 'Saving…'} onClick={() => void save()}><Save className="w-3.5 h-3.5" /> Save</button></div></div>
        {restored && <p role="status" className="panel panel-body text-sm text-[var(--text-dim)]">Your unsaved notes from this device have been restored.</p>}
        {error && <div role="alert" className="panel panel-body text-[var(--bad)] space-y-3"><p>{error}</p>{blockedRef.current && <div className="flex gap-2 flex-wrap"><button className="btn btn-outline" onClick={() => { try { const backup = localStorage.getItem(storageKey); if (backup) void copy(discoveryRecap(JSON.parse(backup).data)); } catch { setError('Could not read the local draft.'); } }}>Copy local draft</button><button className="btn btn-outline" onClick={() => { try { localStorage.removeItem(storageKey); } catch { /* Continue with the server copy. */ } window.location.reload(); }}>Reload saved call</button></div>}</div>}
        <div className="call-editor-heading"><div><p className="call-eyebrow">Discovery call · {draft.projectType === 'CASE_STUDY' ? 'Case study' : 'Paid project'}</p><h2>{draft.name}</h2><p>{dateTime(draft.scheduledAt)}</p></div><span className="mark mark-idle">{CALL_OUTCOME_LABELS[draft.outcome]}</span></div>
        <nav ref={sectionNavRef} className="call-step-nav" aria-label="Discovery call sections">{STEPS.map(item => <button key={item.id} className={step === item.id ? 'active' : ''} aria-current={step === item.id ? 'step' : undefined} onClick={() => { setStep(item.id); setCopied(false); }}>{item.label}{item.id === 'questions' && <span>{answered}/{draft.questions.length}</span>}</button>)}</nav>
        <fieldset disabled={busy} className="min-w-0">
            {step === 'context' && <Panel title="What you know before the call"><div className="grid md:grid-cols-2 gap-4"><Field label="Prospect name" value={draft.name} onChange={value => set('name', value)} /><Field label="Business name" value={draft.businessName} onChange={value => set('businessName', value)} /><Field label="Email" type="email" value={draft.email} onChange={value => set('email', value)} /><Field label="Website" value={draft.website} onChange={value => set('website', value)} /><Field label="LinkedIn profile" value={draft.linkedinUrl} onChange={value => set('linkedinUrl', value)} /><Field label="Call date & time" type="datetime-local" value={localInput(draft.scheduledAt)} onChange={value => set('scheduledAt', isoInput(value))} /><Field label="Working relationship"><select className="field w-full" aria-label="Working relationship" value={draft.projectType} onChange={e => set('projectType', e.target.value as DiscoveryCallData['projectType'])}><option value="CASE_STUDY">Free case study</option><option value="PAID">Paid project</option></select></Field><Field label="Current offer" value={draft.currentOffer} onChange={value => set('currentOffer', value)} /></div><Field label="Previous conversation & prospect context" hint="Keep their actual messages and your observations here." multiline value={draft.context} onChange={value => set('context', value)} /><Field label="Funnel observations" hint="Paste relevant findings from your funnel analysis, and note what you still need to verify." multiline value={draft.funnelNotes} onChange={value => set('funnelNotes', value)} /><div className="flex gap-4 flex-wrap text-sm"><LinkOut url={draft.website}>Open website</LinkOut><LinkOut url={draft.linkedinUrl}>Open LinkedIn</LinkOut></div></Panel>}
            {step === 'questions' && <>
                <div className="call-questions-toolbar">
                    <p className="text-sm text-[var(--text-dim)]">{draft.questions.length} questions · {answered} answered</p>
                    <button className="btn btn-outline" aria-pressed={managingQuestions} onClick={() => { setManagingQuestions(!managingQuestions); setEditingQuestion(false); }}>
                        <Settings2 className="w-3.5 h-3.5" /> {managingQuestions ? 'Done editing questions' : 'Edit questions'}
                    </button>
                </div>
                {managingQuestions ? (
                    <DiscoveryQuestionEditor
                        questions={draft.questions}
                        onChange={questions => set('questions', questions)}
                        createQuestion={() => ({ id: crypto.randomUUID(), title: 'New question', prompt: '', answer: '' })}
                        hint="Edit the questions for this call. Changes save automatically; existing answers stay with their question."
                    />
                ) : (
                    <div className="call-question-layout">
                        <aside className="call-question-index">
                            <p className="call-eyebrow">Your conversation guide</p>
                            {draft.questions.map((q, index) => (
                                <button key={q.id} className={question?.id === q.id ? 'active' : ''} onClick={() => { setQuestionId(q.id); setEditingQuestion(false); }} aria-current={question?.id === q.id ? 'true' : undefined}>
                                    <span className="call-question-number">{q.answer.trim() ? <Check className="w-3.5 h-3.5" /> : String(index + 1).padStart(2, '0')}</span><span>{q.title}</span>
                                </button>
                            ))}
                            <button className="call-add-question" onClick={() => { const id = crypto.randomUUID(); set('questions', [...draft.questions, { id, title: 'New question', prompt: '', answer: '' }]); setQuestionId(id); setEditingQuestion(true); }} disabled={draft.questions.length >= 30}><Plus className="w-3.5 h-3.5" /> Add a question</button>
                        </aside>
                        {question ? (
                            <section className="panel call-question-main">
                                <div className="call-question-topline"><p className="call-eyebrow">Question {currentIndex + 1} of {draft.questions.length}</p><button className="btn btn-ghost" onClick={() => setEditingQuestion(!editingQuestion)}><Settings2 className="w-3.5 h-3.5" /> {editingQuestion ? 'Done editing' : 'Edit question'}</button></div>
                                {editingQuestion ? <div className="space-y-4"><Field label="Question title" value={question.title} onChange={title => updateQuestion({ title })} /><Field label="How you’ll ask it" multiline value={question.prompt} onChange={prompt => updateQuestion({ prompt })} /></div> : <><h3>{question.title}</h3><p className="call-question-prompt">{question.prompt || 'Ask this in your own words.'}</p></>}
                                <label className="call-answer-label" htmlFor="call-answer">Their answer / your notes</label><textarea id="call-answer" className="field call-answer" placeholder="Capture what matters, in their words…" value={question.answer} onChange={e => updateQuestion({ answer: e.target.value })} />
                                <div className="call-question-footer"><button className="btn btn-outline" disabled={currentIndex === 0} onClick={() => { setQuestionId(draft.questions[currentIndex - 1].id); setEditingQuestion(false); }}><ArrowLeft className="w-4 h-4" /> Previous</button><button className="btn btn-primary" onClick={() => { if (currentIndex + 1 < draft.questions.length) { setQuestionId(draft.questions[currentIndex + 1].id); setEditingQuestion(false); } else setStep('offer'); }}>{currentIndex + 1 < draft.questions.length ? 'Next question' : 'Explain your offer'} <ArrowRight className="w-4 h-4" /></button></div>
                            </section>
                        ) : (
                            <Panel title="No questions yet"><p className="text-sm text-[var(--text-dim)]">Add a question to start your conversation guide. Your other call notes are still saved.</p><button className="btn btn-primary" onClick={() => setManagingQuestions(true)}><Plus className="w-3.5 h-3.5" /> Add questions</button></Panel>
                        )}
                    </div>
                )}
            </>}
            {step === 'offer' && <Panel title="Your three-pillar explanation" action={<button className="btn btn-outline" onClick={() => void copy(draft.offerScript)}><Copy className="w-3.5 h-3.5" /> {copied ? 'Copied' : 'Copy pitch'}</button>}><p className="text-sm text-[var(--text-dim)]">Connect this to what they told you. Keep the wording comfortable to say out loud.</p><Field label="What you’ll say" multiline value={draft.offerScript} onChange={value => set('offerScript', value)} /><div className="call-script-preview">{draft.offerScript}</div></Panel>}
            {step === 'notes' && <Panel title="Capture the conversation"><Field label="Call notes" multiline value={draft.notes} onChange={value => set('notes', value)} /><Field label="Objections & open questions" multiline value={draft.objections} onChange={value => set('objections', value)} /><div className="grid md:grid-cols-2 gap-4"><Field label="Agreed scope" hint="What you actually agreed to deliver." multiline value={draft.agreedScope} onChange={value => set('agreedScope', value)} /><Field label="Outside scope" multiline value={draft.excludedScope} onChange={value => set('excludedScope', value)} /></div></Panel>}
            {step === 'outcome' && <div className="call-wrap-layout"><Panel title="Decide the next step"><Field label="Call outcome"><select className="field w-full" aria-label="Call outcome" value={draft.outcome} onChange={e => set('outcome', e.target.value as DiscoveryCallData['outcome'])}>{CALL_OUTCOMES.map(value => <option key={value} value={value}>{CALL_OUTCOME_LABELS[value]}</option>)}</select></Field><Field label="Next action" multiline value={draft.nextAction} onChange={value => set('nextAction', value)} /><Field label="Follow-up date & time" type="datetime-local" value={localInput(draft.followUpAt)} onChange={value => set('followUpAt', isoInput(value))} /><Field label="Funnel for onboarding"><select className="field w-full" aria-label="Funnel for onboarding" value={draft.funnel} onChange={e => set('funnel', e.target.value as DiscoveryCallData['funnel'])}>{FUNNEL_TYPES.map(value => <option key={value} value={value}>{FUNNEL_LABELS[value]}</option>)}</select></Field>{savedRef.current.projectId ? <button className="btn btn-primary" onClick={() => void startOnboarding()}>Open onboarding <ArrowRight className="w-4 h-4" /></button> : <><p className="text-sm text-[var(--text-dim)]">Review the recap, then create the onboarding draft with their answers and agreed scope.</p><button className="btn btn-primary" disabled={draft.outcome !== 'AGREED' || busy} onClick={() => void startOnboarding()}>Start onboarding <ArrowRight className="w-4 h-4" /></button>{draft.outcome !== 'AGREED' && <p className="text-xs text-[var(--text-faint)]">Available once they agree to proceed.</p>}</>}</Panel><Panel title="Call recap" action={<button className="btn btn-ghost" onClick={() => void copy(discoveryRecap(draft))}><Copy className="w-3.5 h-3.5" /> {copied ? 'Copied' : 'Copy'}</button>}><div className="call-recap">{discoveryRecap(draft)}</div></Panel></div>}
        </fieldset>
    </div>;
}

function TemplateEditor({ template, questionsOnly, onSaved, onBack }: {
    template: DiscoverySnapshot['template']; questionsOnly: boolean; onSaved: (template: DiscoverySnapshot['template']) => void; onBack: () => void;
}) {
    const [draft, setDraft] = useState<CallTemplateData>(template.data);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const save = async () => {
        setBusy(true); setError('');
        try { onSaved(unwrapDiscoveryResult(await saveDiscoveryTemplateAction(draft, template.revision))); }
        catch (e) { setError(errorText(e)); }
        finally { setBusy(false); }
    };
    return (
        <div className="space-y-4">
            <div className="call-toolbar">
                <button className="btn btn-ghost" disabled={busy} onClick={onBack}><ArrowLeft className="w-4 h-4" /> Back to calls</button>
                <button className="btn btn-primary" disabled={busy} onClick={() => void save()}><Save className="w-4 h-4" /> {busy ? 'Saving…' : questionsOnly ? 'Save questions' : 'Save templates'}</button>
            </div>
            {error && <p role="alert" className="text-[var(--bad)]">{error}</p>}
            <fieldset disabled={busy} className="space-y-5">
                <DiscoveryQuestionEditor
                    questions={draft.questions}
                    onChange={questions => setDraft(current => ({ ...current, questions }))}
                    createQuestion={() => ({ id: crypto.randomUUID(), title: 'New question', prompt: '' })}
                    hint="Set the default questions for new calls. Calls you already prepared keep their own questions and answers."
                />
                {!questionsOnly && <Panel title="Your three-pillar pitch"><Field label="Default offer explanation" multiline value={draft.offerScript} onChange={offerScript => setDraft(current => ({ ...current, offerScript }))} /></Panel>}
            </fieldset>
        </div>
    );
}
