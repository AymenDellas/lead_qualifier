'use client';

import { useMemo, useState } from 'react';
import {
    Check,
    ChevronRight,
    CircleAlert,
    ClipboardCheck,
    Copy,
    Download,
    ExternalLink,
    FileSignature,
    FileText,
    LockKeyhole,
    Plus,
    Send,
    Settings2,
    Upload,
    UserRound,
    X,
} from 'lucide-react';
import {
    createOnboardingAction,
    saveClientProjectAction,
    saveOfferAction,
    type CreateOnboardingInput,
} from '@/app/actions/business-actions';
import {
    AGREEMENT_STATUSES,
    CASE_STUDY_CONSENT_TEXT,
    CLIENT_AGREEMENT_LABELS,
    CLIENT_PAYMENT_LABELS,
    clientFormStatus,
    DEPLOYMENT_TOOL_FIELDS,
    DEPLOYMENT_TOOL_HINT,
    currentFreeAgreementIntro,
    DEFAULT_ONBOARDING_TEMPLATES,
    FUNNEL_OFFER_HINT,
    FUNNEL_OFFER_QUESTION,
    DIFFERENTIATION_QUESTION,
    UNSUITABLE_CLIENTS_QUESTION,
    FUNNEL_LABELS,
    FUNNEL_TYPES,
    PAYMENT_STATUSES,
    REQUIRED_ONBOARDING_FORM_FIELDS,
    generateAccessChecklist,
    mergeAccessChecklist,
    missingOnboardingFormFields,
    normalizeOnboarding,
    onboardingBlockers,
    onboardingAccessComplete,
    onboardingFormComplete,
    onboardingProgress,
    type AccessItem,
    type BusinessSnapshot,
    type ClientProject,
    type OnboardingData,
    type OnboardingTemplates,
    type ProjectData,
} from '@/lib/business';
import { agreementPdf } from '@/lib/agreement-pdf';
import { ClientScopeSummary } from './ClientScopeSummary';
import { Empty, Field, LinkOut, Panel, type RunAction } from './BusinessUi';
import { CompelLogo } from './CompelLogo';
import './compel-onboarding.css';

const STEPS = [
    ['agreement', 'Agreement'],
    ['payment', 'Payment'],
    ['form', 'Form'],
    ['access', 'Access'],
    ['baseline', 'Baseline'],
    ['scope', 'Scope'],
    ['ready', 'Ready'],
] as const;
type Step = (typeof STEPS)[number][0];

const AGREEMENT_LABELS: Record<(typeof AGREEMENT_STATUSES)[number], string> = {
    DRAFT: 'Draft',
    SENT: 'Sent',
    VIEWED: 'Viewed',
    SIGNED_CLIENT: 'Signed by client',
    FULLY_SIGNED: 'Fully signed',
};
const PAYMENT_LABELS: Record<(typeof PAYMENT_STATUSES)[number], string> = {
    NOT_SENT: 'Not sent',
    LINK_SENT: 'Payment link sent',
    DEPOSIT_PAID: 'Deposit paid',
    FULLY_PAID: 'Fully paid',
    OVERDUE: 'Overdue',
};
const ACCESS_LABELS = {
    NOT_REQUESTED: 'Not requested',
    REQUESTED: 'Requested',
    RECEIVED: 'Received',
    VERIFIED: 'Verified',
    NOT_NEEDED: 'Not needed',
} as const;

const inputDefault: CreateOnboardingInput = {
    clientName: '',
    businessName: '',
    email: '',
    website: '',
    projectName: '',
    funnel: 'DIRECT_TO_CALL',
    projectType: 'PAID',
};

export default function OnboardingWorkspace({
    snapshot,
    busy,
    run,
    focusId,
}: {
    snapshot: BusinessSnapshot;
    busy: boolean;
    run: RunAction;
    focusId?: string;
}) {
    const [selected, setSelected] = useState<string | null>(focusId || null);
    const [creating, setCreating] = useState(false);
    const [templates, setTemplates] = useState(false);
    const project = snapshot.projects.find((item) => item.id === selected);
    const opportunity = project
        ? snapshot.opportunities.find((item) => item.id === project.opportunityId)
        : undefined;

    if (project)
        return (
            <OnboardingSurface>
                <OnboardingEditor
                    key={`${project.id}-${project.revision}`}
                    project={project}
                    opportunity={opportunity?.data}
                    profile={snapshot.offer.profile}
                    busy={busy}
                    run={run}
                    onBack={() => setSelected(null)}
                />
            </OnboardingSurface>
        );
    if (templates)
        return (
            <OnboardingSurface>
                <TemplateEditor
                    templates={{
                        ...(snapshot.offer.profile.onboardingTemplates || DEFAULT_ONBOARDING_TEMPLATES),
                        freeAgreement: currentFreeAgreementIntro((snapshot.offer.profile.onboardingTemplates || DEFAULT_ONBOARDING_TEMPLATES).freeAgreement),
                    }}
                    profile={snapshot.offer.profile}
                    version={snapshot.offer.version}
                    busy={busy}
                    run={run}
                    onBack={() => setTemplates(false)}
                />
            </OnboardingSurface>
        );
    if (creating)
        return (
            <OnboardingSurface>
                <CreateOnboarding
                    busy={busy}
                    run={run}
                    onCancel={() => setCreating(false)}
                    onCreated={(id) => {
                        setCreating(false);
                        setSelected(id);
                    }}
                />
            </OnboardingSurface>
        );

    return (
        <OnboardingSurface>
            <OnboardingDashboard
                snapshot={snapshot}
                onOpen={setSelected}
                onCreate={() => setCreating(true)}
                onTemplates={() => setTemplates(true)}
            />
        </OnboardingSurface>
    );
}

function OnboardingSurface({ children }: { children: React.ReactNode }) {
    return <div className="compel-onboarding compel-onboarding-workspace"><div className="compel-onboarding-heading"><CompelLogo /><span className="label-micro">Client onboarding</span></div>{children}</div>;
}

function OnboardingDashboard({
    snapshot,
    onOpen,
    onCreate,
    onTemplates,
}: {
    snapshot: BusinessSnapshot;
    onOpen: (id: string) => void;
    onCreate: () => void;
    onTemplates: () => void;
}) {
    const [view, setView] = useState<'ACTIVE' | 'READY' | 'COMPLETED'>('ACTIVE');
    const rows = snapshot.projects.map((project) => {
        const opportunity = snapshot.opportunities.find((item) => item.id === project.opportunityId)?.data;
        const onboarding = normalizeOnboarding(project.data, opportunity, snapshot.offer.profile);
        const blockers = onboardingBlockers(onboarding);
        const state = project.data.status !== 'ONBOARDING' ? 'COMPLETED' : blockers.length ? 'ACTIVE' : 'READY';
        return { project, onboarding, blockers, state, progress: onboardingProgress(onboarding) };
    });
    const visible = rows.filter((row) => row.state === view);
    const active = rows.filter((row) => row.state === 'ACTIVE').length;
    const ready = rows.filter((row) => row.state === 'READY').length;
    const completed = rows.filter((row) => row.state === 'COMPLETED').length;
    return (
        <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-3">
                <div className="seg" aria-label="Onboarding status">
                    <button className={`seg-item ${view === 'ACTIVE' ? 'seg-item-active' : ''}`} onClick={() => setView('ACTIVE')}>
                        Active · {active}
                    </button>
                    <button className={`seg-item ${view === 'READY' ? 'seg-item-active' : ''}`} onClick={() => setView('READY')}>
                        Ready to build · {ready}
                    </button>
                    <button className={`seg-item ${view === 'COMPLETED' ? 'seg-item-active' : ''}`} onClick={() => setView('COMPLETED')}>
                        Completed · {completed}
                    </button>
                </div>
                <div className="ml-auto flex gap-2">
                    <button className="btn btn-outline" onClick={onTemplates}>
                        <Settings2 className="w-3.5 h-3.5" /> Templates
                    </button>
                    <button className="btn btn-primary" onClick={onCreate}>
                        <Plus className="w-3.5 h-3.5" /> Start onboarding
                    </button>
                </div>
            </div>
            <div className="figures">
                <div className="fig">
                    <p className="fig-value">{active}</p>
                    <p className="fig-label">Active onboardings</p>
                    <p className="fig-sub">Waiting on agreement, information, access, or scope.</p>
                </div>
                <div className="fig">
                    <p className="fig-value fig-value-signal">{ready}</p>
                    <p className="fig-label">Ready to build</p>
                    <p className="fig-sub">No required onboarding blockers remain.</p>
                </div>
                <div className="fig">
                    <p className="fig-value">{completed}</p>
                    <p className="fig-label">Handed to delivery</p>
                    <p className="fig-sub">Onboarding is preserved with the client record.</p>
                </div>
            </div>
            <Panel title={view === 'ACTIVE' ? 'Active onboardings' : view === 'READY' ? 'Ready to build' : 'Completed'}>
                {!visible.length ? (
                    <Empty>{view === 'ACTIVE' ? 'No clients are currently blocked in onboarding.' : `No ${view.toLowerCase()} onboardings yet.`}</Empty>
                ) : (
                    <div className="divide-y divide-[var(--line)]">
                        {visible.map(({ project, onboarding, blockers, progress }) => (
                            <button
                                key={project.id}
                                className="w-full text-left grid md:grid-cols-[1.25fr_0.8fr_1.4fr_auto] gap-4 py-4 px-2 rounded hover:bg-[var(--surface-2)] items-center"
                                onClick={() => onOpen(project.id)}
                            >
                                <span>
                                    <span className="block font-medium">{onboarding.clientName}</span>
                                    <span className="block text-xs text-[var(--text-faint)] mt-0.5">{onboarding.projectName}</span>
                                </span>
                                <span>
                                    <span className={`mark ${onboarding.projectType === 'CASE_STUDY' ? 'mark-info' : 'mark-idle'}`}>
                                        {onboarding.projectType === 'CASE_STUDY' ? 'Free case study' : 'Paid client'}
                                    </span>
                                </span>
                                <span className="min-w-0">
                                    <span className="flex items-center justify-between text-xs mb-1.5">
                                        <span className="text-[var(--text-dim)]">{progress}% complete</span>
                                        <span className={blockers.length ? 'text-[var(--warn)]' : 'text-[var(--signal)]'}>
                                            {blockers[0]?.label || (project.data.status === 'ONBOARDING' ? 'Ready to build' : 'In delivery')}
                                        </span>
                                    </span>
                                    <span className="bar-track block">
                                        <span className="bar-fill block" style={{ width: `${progress}%` }} />
                                    </span>
                                </span>
                                <ChevronRight className="w-4 h-4 text-[var(--text-faint)]" />
                            </button>
                        ))}
                    </div>
                )}
            </Panel>
        </div>
    );
}

function CreateOnboarding({
    busy,
    run,
    onCancel,
    onCreated,
}: {
    busy: boolean;
    run: RunAction;
    onCancel: () => void;
    onCreated: (id: string) => void;
}) {
    const [draft, setDraft] = useState<CreateOnboardingInput>(inputDefault);
    const set = <K extends keyof CreateOnboardingInput>(key: K, value: CreateOnboardingInput[K]) =>
        setDraft((current) => ({ ...current, [key]: value }));
    return (
        <div className="space-y-5 max-w-4xl">
            <button className="btn btn-ghost" onClick={onCancel}>← Onboarding</button>
            <Panel title="Create client onboarding">
                <p className="text-sm text-[var(--text-dim)]">
                    Start after the client says yes. The correct agreement and payment path are generated from this information.
                </p>
                <div className="grid sm:grid-cols-2 gap-4">
                    <Field label="Client name" required value={draft.clientName} onChange={(value) => set('clientName', value)} />
                    <Field label="Business name" value={draft.businessName} onChange={(value) => set('businessName', value)} />
                    <Field label="Email" hint="Optional." type="email" value={draft.email} onChange={(value) => set('email', value)} />
                    <Field label="Website" value={draft.website} onChange={(value) => set('website', value)} />
                    <Field label="Project name" required value={draft.projectName} onChange={(value) => set('projectName', value)} />
                    <Field label="Project type">
                        <select className="field w-full" value={draft.projectType} onChange={(e) => set('projectType', e.target.value as CreateOnboardingInput['projectType'])}>
                            <option value="PAID">Paid client</option>
                            <option value="CASE_STUDY">Free case study</option>
                        </select>
                    </Field>
                    <Field label="Funnel type">
                        <select className="field w-full" value={draft.funnel} onChange={(e) => set('funnel', e.target.value as CreateOnboardingInput['funnel'])}>
                            {FUNNEL_TYPES.map((funnel) => <option key={funnel} value={funnel}>{FUNNEL_LABELS[funnel]}</option>)}
                        </select>
                    </Field>
                </div>
                <div className="flex justify-end gap-2 pt-2">
                    <button className="btn btn-outline" onClick={onCancel}>Cancel</button>
                    <button
                        className="btn btn-primary"
                        disabled={busy || !draft.clientName.trim() || !draft.projectName.trim()}
                        onClick={async () => {
                            const project = await run(() => createOnboardingAction(draft), 'Client onboarding created.');
                            if (project) onCreated(project.id);
                        }}
                    >
                        Start onboarding <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                </div>
            </Panel>
        </div>
    );
}

function TemplateEditor({
    templates,
    profile,
    version,
    busy,
    run,
    onBack,
}: {
    templates: OnboardingTemplates;
    profile: BusinessSnapshot['offer']['profile'];
    version: number;
    busy: boolean;
    run: RunAction;
    onBack: () => void;
}) {
    const [draft, setDraft] = useState({ ...templates });
    const labels: Record<keyof OnboardingTemplates, string> = {
        freeAgreement: 'Free case-study agreement opening',
        paidAgreement: 'Paid-client agreement opening',
        welcome: 'Onboarding welcome message',
        paymentRequest: 'Payment request',
        accessRequest: 'Access request',
        reminder: 'Reminder message',
        scopeConfirmation: 'Scope confirmation',
        projectReady: 'Project-ready notification',
    };
    return (
        <div className="space-y-5 max-w-5xl">
            <button className="btn btn-ghost" onClick={onBack}>← Onboarding</button>
            <Panel title="Onboarding templates">
                <p className="text-sm text-[var(--text-dim)]">
                    Changes apply to future projects. Existing project agreements and signed documents keep their saved wording.
                </p>
                <div className="grid md:grid-cols-2 gap-4">
                    {(Object.keys(labels) as Array<keyof OnboardingTemplates>).map((key) => (
                        <Field key={key} label={labels[key]} multiline value={draft[key]} onChange={(value) => setDraft((current) => ({ ...current, [key]: value }))} />
                    ))}
                </div>
                <div className="flex justify-end">
                    <button className="btn btn-primary" disabled={busy} onClick={() => void run(() => saveOfferAction({ ...profile, onboardingTemplates: draft }, version), 'Future onboarding templates updated.')}>
                        Save templates
                    </button>
                </div>
            </Panel>
        </div>
    );
}

function OnboardingEditor({
    project,
    opportunity,
    profile,
    busy,
    run,
    onBack,
}: {
    project: ClientProject;
    opportunity?: BusinessSnapshot['opportunities'][number]['data'];
    profile: BusinessSnapshot['offer']['profile'];
    busy: boolean;
    run: RunAction;
    onBack: () => void;
}) {
    const onboarding = normalizeOnboarding(project.data, opportunity, profile);
    const [draft, setDraft] = useState<ProjectData>({ ...project.data, onboarding });
    const [step, setStep] = useState<Step>('agreement');
    const [portal, setPortal] = useState(false);
    const [copied, setCopied] = useState(false);
    const [portalCopied, setPortalCopied] = useState(false);
    const data = draft.onboarding!;
    const portalOrigin = (process.env.NEXT_PUBLIC_CLIENT_PORTAL_URL || '').trim().replace(/\/$/, '');
    const savedPortalToken = data.portalToken && project.data.onboarding?.portalToken === data.portalToken;
    const portalHref = data.portalToken ? `${portalOrigin}/portal/${data.portalToken}` : '';
    const blockers = onboardingBlockers(data);
    const progress = onboardingProgress(data);
    const ready = blockers.length === 0;
    const update = (fn: (current: OnboardingData) => OnboardingData) =>
        setDraft((current) => ({ ...current, onboarding: fn(current.onboarding!) }));
    const save = (message = 'Onboarding saved.') => run(() => saveClientProjectAction(project.id, draft, project.revision), message);
    const override = (key: string) =>
        update((current) => ({
            ...current,
            overrides: current.overrides.includes(key)
                ? current.overrides.filter((item) => item !== key)
                : [...current.overrides, key],
        }));
    const reminder = (profile.onboardingTemplates || DEFAULT_ONBOARDING_TEMPLATES).reminder
        .replace('{{project_name}}', data.projectName)
        .replace('{{outstanding_items}}', blockers.map((item) => item.label.toLowerCase()).join(', '));

    if (portal)
        return <PortalPreview data={data} blockers={blockers} onClose={() => setPortal(false)} />;

    return (
        <div className="space-y-5 max-w-[1400px]">
            <div className="flex flex-wrap items-center gap-3">
                <button className="btn btn-ghost" onClick={onBack}>← Onboarding</button>
                <div className="min-w-0">
                    <p className="font-medium truncate">{data.clientName} · {data.projectName}</p>
                    <p className="text-xs text-[var(--text-faint)]">{data.projectType === 'CASE_STUDY' ? 'Free case study' : 'Paid client'} · {progress}% complete</p>
                </div>
                <div className="ml-auto flex flex-wrap gap-2">
                    <button className="btn btn-outline" onClick={() => setPortal(true)}><UserRound className="w-3.5 h-3.5" /> Client view</button>
                    {data.portalToken ? (
                        savedPortalToken ? <>
                            <a className="btn btn-outline" href={portalHref} target="_blank" rel="noreferrer"><ExternalLink className="w-3.5 h-3.5" /> Open portal</a>
                            {portalOrigin && <button className="btn btn-outline" onClick={async () => { await navigator.clipboard.writeText(portalHref); setPortalCopied(true); }}><Copy className="w-3.5 h-3.5" /> {portalCopied ? 'Link copied' : 'Copy client link'}</button>}
                        </> : <span className="text-xs text-[var(--text-faint)]">Save onboarding to activate the portal link.</span>
                    ) : (
                        <button className="btn btn-outline" onClick={() => update((current) => ({ ...current, portalToken: crypto.randomUUID() }))}><ExternalLink className="w-3.5 h-3.5" /> Create portal link</button>
                    )}
                    <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>Save onboarding</button>
                </div>
            </div>
            {savedPortalToken && !portalOrigin && <p className="text-xs text-[var(--text-faint)]">The client portal domain is not configured yet. Open portal works locally; client links will be available once hosting is connected.</p>}

            <div className="panel overflow-x-auto">
                <div className="min-w-[760px] grid grid-cols-7">
                    {STEPS.map(([id, label], index) => {
                        const skipped = id === 'payment' && data.projectType === 'CASE_STUDY';
                        const complete = stepComplete(id, data, ready);
                        return (
                            <button key={id} className={`px-3 py-3 text-left border-r last:border-r-0 border-[var(--line)] ${step === id ? 'bg-[var(--surface-3)]' : ''}`} onClick={() => setStep(id)}>
                                <span className={`flex items-center gap-2 text-xs ${complete ? 'text-[var(--signal)]' : step === id ? 'text-[var(--text)]' : 'text-[var(--text-faint)]'}`}>
                                    <span className={`num text-[10px] w-5 h-5 rounded-full border flex items-center justify-center ${complete ? 'border-[var(--signal-line)] bg-[var(--signal-dim)]' : 'border-[var(--line-strong)]'}`}>
                                        {complete ? <Check className="w-3 h-3" /> : index + 1}
                                    </span>
                                    {label}{skipped ? ' · skipped' : ''}
                                </span>
                            </button>
                        );
                    })}
                </div>
            </div>

            <div className="grid xl:grid-cols-[minmax(0,1fr)_320px] gap-5 items-start">
                <div className="min-w-0">
                    {step === 'agreement' && <AgreementStep data={data} update={update} />}
                    {step === 'payment' && <PaymentStep data={data} update={update} />}
                    {step === 'form' && <FormStep data={data} update={update} />}
                    {step === 'access' && <AccessStep data={data} update={update} />}
                    {step === 'baseline' && <BaselineStep data={data} update={update} />}
                    {step === 'scope' && <ScopeStep data={data} update={update} />}
                    {step === 'ready' && (
                        <ReadyStep
                            project={draft}
                            data={data}
                            ready={ready}
                            blockers={blockers}
                            busy={busy}
                            onStart={async () => {
                                const saved = await run(
                                    () => saveClientProjectAction(project.id, { ...draft, status: 'BUILDING' }, project.revision),
                                    'Onboarding complete. Project handed off.',
                                );
                                if (saved) onBack();
                            }}
                        />
                    )}
                </div>
                <aside className="space-y-4 xl:sticky xl:top-[72px]">
                    <Panel title={ready ? 'Ready to build' : 'Project blockers'}>
                        {ready ? (
                            <div className="flex gap-3 text-[var(--signal)]"><ClipboardCheck className="w-5 h-5 flex-none" /><p>No required onboarding items remain.</p></div>
                        ) : (
                            <div className="space-y-3">
                                {blockers.map((blocker) => (
                                    <div key={blocker.key} className="border-l-2 border-[var(--warn)] pl-3">
                                        <p className="text-sm">{blocker.label}</p>
                                        <p className="text-xs text-[var(--text-faint)] mt-0.5">{blocker.detail}</p>
                                        {blocker.key !== 'access' && (
                                            <button className="text-xs text-[var(--text-dim)] underline underline-offset-4 mt-1.5" onClick={() => override(blocker.key)}>Mark non-blocking</button>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                    </Panel>
                    {!ready && (
                        <Panel title="Polite follow-up" action={<button className="btn btn-ghost !p-1" title="Copy reminder" onClick={async () => { await navigator.clipboard.writeText(reminder); setCopied(true); }}><Copy className="w-3.5 h-3.5" /></button>}>
                            <p className="text-sm text-[var(--text-dim)] whitespace-pre-wrap">{reminder}</p>
                            {copied && <p className="text-xs text-[var(--signal)]">Copied for review. Nothing was sent.</p>}
                        </Panel>
                    )}
                    <Panel title="Discovery call agenda">
                        <ul className="space-y-2 text-sm text-[var(--text-dim)] list-disc pl-4">
                            <li>Which offer should this funnel focus on?</li>
                            <li>What would make this rebuild successful?</li>
                            <li>What is not obvious about the audience or business?</li>
                            <li>What must be preserved or avoided?</li>
                            <li>Confirm freedom to rebuild messaging, structure, booking, and nurture.</li>
                            {data.projectType === 'CASE_STUDY' && <li>Confirm case-study permission.</li>}
                        </ul>
                        <p className="text-xs text-[var(--text-faint)] pt-2">Use the form for structured details, assets, access, and metrics—not the call.</p>
                    </Panel>
                </aside>
            </div>
        </div>
    );
}

function AgreementStep({ data, update }: StepProps) {
    const setAgreement = (key: keyof OnboardingData['agreement'], value: string) =>
        update((current) => ({ ...current, agreement: { ...current.agreement, [key]: value },
            ...(key === 'deliverables' ? { scope: { ...current.scope, included: value, confirmed: false, confirmedAt: '' } } : {}),
        }));
    const pdf = async (mode: 'preview' | 'download') => {
        const preview = mode === 'preview' ? window.open('', '_blank') : null;
        if (preview) preview.opener = null;
        const blob = data.agreement.signedPdfData
            ? await (await fetch(data.agreement.signedPdfData)).blob()
            : agreementPdf(data);
        const url = URL.createObjectURL(blob);
        if (mode === 'preview') {
            if (preview) preview.location.href = url;
            else window.open(url, '_blank', 'noopener,noreferrer');
        }
        else {
            const link = document.createElement('a');
            link.href = url;
            link.download = data.agreement.signedPdfName || `${data.projectName.replace(/[^a-z0-9]+/gi, '-')}-agreement.pdf`;
            link.click();
        }
        window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    };
    const fields: Array<[keyof OnboardingData['agreement'], string]> = [
        ['intro', 'Agreement opening'], ['scope', 'Project scope'], ['deliverables', 'Expected deliverables'],
        ['timeline', 'Approximate timeline'], ['revisions', 'Revision terms'],
        ['clientResponsibilities', 'Client responsibilities'], ['compelResponsibilities', 'Compel responsibilities'],
        ['ownership', 'Ownership'], ['caseStudyRights', 'Portfolio / case-study rights'],
        ['confidentiality', 'Confidentiality'], ['termination', 'Cancellation or termination'],
    ];
    return (
        <Panel title={data.projectType === 'CASE_STUDY' ? 'Free case-study agreement' : 'Paid-client agreement'} action={<span className="mark mark-info">{AGREEMENT_LABELS[data.agreement.status]}</span>}>
            <div className="flex flex-wrap gap-2">
                <button className="btn btn-outline" onClick={() => void pdf('preview')}><FileText className="w-3.5 h-3.5" /> Preview PDF</button>
                <button className="btn btn-outline" onClick={() => void pdf('download')}><Download className="w-3.5 h-3.5" /> Download PDF</button>
                {!data.agreement.clientSignature && <button className="btn btn-outline" onClick={() => update((current) => ({ ...current, agreement: { ...current.agreement, status: 'SENT', sentAt: new Date().toISOString() } }))}><Send className="w-3.5 h-3.5" /> Mark sent for signature</button>}
                <label className="btn btn-outline cursor-pointer"><Upload className="w-3.5 h-3.5" /> {data.agreement.clientSignature ? 'Upload countersigned PDF' : 'Upload signed PDF'}<input className="hidden" type="file" accept="application/pdf" onChange={(event) => void uploadSignedAgreement(event.currentTarget.files?.[0], data, update)} /></label>
            </div>
            {data.agreement.clientSignature && <p className="text-sm text-[var(--text-dim)]">Client signed electronically on {new Date(data.agreement.clientSignature.signedAt).toLocaleDateString('en-US')} as {data.agreement.clientSignature.name} ({data.agreement.clientSignature.email}). The signed PDF is saved here. Download it, countersign, upload the final copy, then save onboarding. Editing draft terms does not change the signed copy.</p>}
            <div className="grid sm:grid-cols-2 gap-4">
                <Field label="Agreement status">
                    <select className="field w-full" value={data.agreement.status} onChange={(e) => setAgreement('status', e.target.value)}>
                        {AGREEMENT_STATUSES.map((status) => <option key={status} value={status}>{AGREEMENT_LABELS[status]}</option>)}
                    </select>
                </Field>
                <Field label="Signed agreement file" value={data.agreement.signedPdfName || 'No signed PDF stored'} onChange={() => undefined} />
            </div>
            <div className="space-y-4 pt-1">
                {fields.filter(([key]) => data.projectType === 'PAID' || key !== 'revisions').map(([key, label]) => (
                    <Field key={key} label={label} multiline value={String(data.agreement[key] || '')} onChange={(value) => setAgreement(key, value)} />
                ))}
            </div>
            <p className="text-xs text-[var(--text-faint)]">Finalize the agreement before sharing the portal. The client can review and sign there. “Mark sent” only records status; it does not email a link.</p>
        </Panel>
    );
}

async function uploadSignedAgreement(file: File | undefined, data: OnboardingData, update: StepProps['update']) {
    if (!file) return;
    if (file.size > 5_000_000) return window.alert('Choose a signed PDF smaller than 5 MB.');
    const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
    update((current) => ({
        ...current,
        agreement: { ...current.agreement, status: 'FULLY_SIGNED', signedPdfName: file.name, signedPdfData: dataUrl },
        documents: [
            ...current.documents.filter((item) => item.kind !== 'AGREEMENT' || item.name !== 'Signed agreement'),
            { id: `signed-${Date.now()}`, name: 'Signed agreement', kind: 'AGREEMENT', url: '', fileName: file.name, dataUrl, createdAt: new Date().toISOString() },
        ],
    }));
}

type StepProps = { data: OnboardingData; update: (fn: (current: OnboardingData) => OnboardingData) => void };

function PaymentStep({ data, update }: StepProps) {
    if (data.projectType === 'CASE_STUDY')
        return <Panel title="Payment"><div className="py-8 text-center"><p className="text-[var(--signal)] text-lg font-medium">Free Case Study — No Payment Required</p><p className="text-sm text-[var(--text-dim)] mt-2">This stage is complete automatically.</p></div></Panel>;
    const set = (key: keyof OnboardingData['payment'], value: string | number | null) =>
        update((current) => ({ ...current, payment: { ...current.payment, [key]: value } }));
    return (
        <Panel title="Payment" action={<span className={`mark ${data.payment.status === 'OVERDUE' ? 'mark-bad' : data.payment.status === 'FULLY_PAID' ? 'mark-ok' : 'mark-idle'}`}>{PAYMENT_LABELS[data.payment.status]}</span>}>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                <Field label="Payment structure"><select className="field w-full" value={data.payment.structure} onChange={(e) => set('structure', e.target.value)}><option value="FULL">Full payment</option><option value="DEPOSIT">Deposit + balance</option><option value="CUSTOM">Custom</option></select></Field>
                <Field label="Currency" value={data.payment.currency} onChange={(value) => set('currency', value.toUpperCase())} />
                <Field label="Project price" type="number" value={data.payment.price ?? ''} onChange={(value) => set('price', value === '' ? null : Number(value))} />
                {data.payment.structure !== 'FULL' && <Field label="Deposit amount" type="number" value={data.payment.deposit ?? ''} onChange={(value) => set('deposit', value === '' ? null : Number(value))} />}
                {data.payment.structure !== 'FULL' && <Field label="Remaining balance" type="number" value={data.payment.balance ?? ''} onChange={(value) => set('balance', value === '' ? null : Number(value))} />}
                <Field label="Due date" type="date" value={data.payment.dueDate} onChange={(value) => set('dueDate', value)} />
                <Field label="Payment status"><select className="field w-full" value={data.payment.status} onChange={(e) => set('status', e.target.value)}>{PAYMENT_STATUSES.map((status) => <option key={status} value={status}>{PAYMENT_LABELS[status]}</option>)}</select></Field>
                <Field label="Secure payment link" value={data.payment.link} onChange={(value) => set('link', value)} />
            </div>
            <Field label="Payment terms or custom structure" multiline value={data.payment.notes} onChange={(value) => set('notes', value)} />
            <div className="flex gap-2"><LinkOut url={data.payment.link}>Open payment link</LinkOut>{data.payment.link && <button className="btn btn-outline" onClick={() => set('status', 'LINK_SENT')}><Send className="w-3.5 h-3.5" /> Mark link sent</button>}</div>
            <p className="text-xs text-[var(--text-faint)]">Payment status is recorded here; Compel does not charge the client automatically.</p>
        </Panel>
    );
}

function FormStep({ data, update }: StepProps) {
    const set = (key: keyof OnboardingData['form'], value: string | boolean) =>
        update((current) => ({ ...current, form: { ...current.form, [key]: value } }));
    type FormTextKey = Exclude<keyof OnboardingData['form'], 'status' | 'caseStudyConsent' | 'testimonialCommitment' | 'deploymentAccessConsent'>;
    const requiredKeys: readonly string[] = REQUIRED_ONBOARDING_FORM_FIELDS.map(([key]) => key);
    const missing = missingOnboardingFormFields(data);
    const group = (title: string, fields: Array<[FormTextKey, string, boolean?]>, hint?: string) => (
        <div className="space-y-4">
            <h3 className="label-micro border-b border-[var(--line)] pb-2">{title}</h3>
            {hint && <p className="text-sm text-[var(--text-dim)]">{hint}</p>}
            <div className="grid sm:grid-cols-2 gap-4">{fields.map(([key, label, multiline]) => {
                const required = requiredKeys.includes(key);
                return <div key={key} className={['offer', 'differentiation', 'unsuitableClients'].includes(key) ? 'sm:col-span-2' : undefined}><Field label={required ? label : `${label} · Optional`} hint={key === 'offer' ? FUNNEL_OFFER_HINT : undefined} required={required} multiline={multiline} value={data.form[key]} onChange={(value) => set(key, value)} /></div>;
            })}</div>
        </div>
    );
    return (
        <Panel title="Client onboarding form" action={<select className="field" aria-label="Form status" value={data.form.status} onChange={(e) => set('status', e.target.value)}><option value="NOT_SENT">Not sent</option><option value="SENT">Sent</option><option value="IN_PROGRESS">In progress</option><option value="COMPLETE">Complete</option></select>}>
            <p className="text-sm text-[var(--text-dim)]">Collect structured information here. Keep strategy and context for the short discovery call.</p>
            {group('Offer and business', [['offer', FUNNEL_OFFER_QUESTION], ['audience', 'Target audience'], ['customerProblem', 'Main customer problem', true], ['desiredOutcome', 'Desired outcome', true], ['differentiation', DIFFERENTIATION_QUESTION, true], ['unsuitableClients', UNSUITABLE_CLIENTS_QUESTION, true], ['trafficSources', 'Current traffic sources']])}
            {group('Funnel information', [['landingPageUrl', 'Current landing page URL'], ['bookingUrl', 'Booking URL'], ['qualification', 'Current qualification'], ['nurture', 'Current nurture / follow-up'], ['traffic', 'Approximate traffic'], ['bookings', 'Approximate bookings'], ['showRate', 'Approximate show rate'], ['closeRate', 'Approximate clients / close rate']])}
            {group('Existing tools', [['bookingPlatform', 'Booking platform'], ['crm', 'CRM'], ['emailPlatform', 'Email platform'], ['analyticsPlatform', 'Analytics platform']])}
            {group('Deployment tools and access · Optional', DEPLOYMENT_TOOL_FIELDS.map(([key, label]) => [key, label]), DEPLOYMENT_TOOL_HINT)}
            {group('Brand, assets, and preferences', [['assets', 'Logo, colors, fonts, photos, testimonials, case studies, certifications, and copy links', true], ['mustStay', 'Anything that must stay', true], ['avoid', 'Anything the client does not want changed', true], ['importantContext', 'Anything important that is not obvious', true]])}
            {data.projectType === 'CASE_STUDY' && <div className="rounded-md border border-[var(--line-strong)] p-4 space-y-3">
                <p className="text-sm font-medium">Case-study permission <span className="text-[var(--bad)]">*</span></p>
                <label className="flex items-start gap-3 text-sm text-[var(--text-dim)]">
                    <input type="checkbox" className="mt-1" checked={data.form.caseStudyConsent && data.form.testimonialCommitment} onChange={(e) => update((current) => ({ ...current, form: { ...current.form, caseStudyConsent: e.target.checked, testimonialCommitment: e.target.checked } }))} />
                    <span>{CASE_STUDY_CONSENT_TEXT}</span>
                </label>
            </div>}
            {missing.length > 0 && <p className="text-xs text-[var(--warn)]">Required before completion: {missing.join(', ')}.</p>}
            <div className="flex flex-wrap gap-2">
                <button className="btn btn-outline" onClick={() => set('status', data.form.status === 'NOT_SENT' ? 'SENT' : data.form.status)}><Send className="w-3.5 h-3.5" /> Mark form sent</button>
                <button className="btn btn-primary" disabled={missing.length > 0} onClick={() => update((current) => ({ ...current, form: { ...current.form, status: 'COMPLETE' }, access: mergeAccessChecklist(current.access, generateAccessChecklist(current.form)) }))}>Complete form & generate access list</button>
            </div>
        </Panel>
    );
}

function AccessStep({ data, update }: StepProps) {
    const change = (id: string, patch: Partial<AccessItem>) => update((current) => ({ ...current, access: current.access.map((item) => item.id === id ? { ...item, ...patch } : item) }));
    const add = () => update((current) => ({ ...current, access: [...current.access, { id: `access-${Date.now()}`, platform: 'New access item', reason: '', permission: '', instructions: '', status: 'NOT_REQUESTED', required: true, nonBlocking: false }] }));
    return (
        <Panel title="Access center" action={<button className="btn btn-outline" onClick={add}><Plus className="w-3.5 h-3.5" /> Add item</button>}>
            <div className="flex gap-3 p-3 bg-[var(--surface-2)] border border-[var(--line)] rounded-md text-sm text-[var(--text-dim)]"><LockKeyhole className="w-4 h-4 flex-none mt-0.5 text-[var(--signal)]" /><p>Request the minimum collaborator or team access. Never ask the client to share a password when safer delegated access exists.</p></div>
            {!data.access.length ? <Empty>Complete the onboarding form to generate only the access this project needs.</Empty> : (
                <div className="space-y-3">{data.access.map((item) => (
                    <div key={item.id} className="border border-[var(--line)] rounded-md p-4 space-y-3">
                        <div className="flex flex-wrap items-start gap-3">
                            <input className="field flex-1 min-w-48 font-medium" value={item.platform} onChange={(e) => change(item.id, { platform: e.target.value })} />
                            <select className="field" value={item.status} onChange={(e) => change(item.id, { status: e.target.value as AccessItem['status'] })}>{Object.entries(ACCESS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
                        </div>
                        <div className="grid md:grid-cols-2 gap-3">
                            <Field label="Why it is needed" value={item.reason} onChange={(value) => change(item.id, { reason: value })} />
                            <Field label="Requested permission" value={item.permission} onChange={(value) => change(item.id, { permission: value })} />
                        </div>
                        <Field label="Client-friendly instructions" multiline value={item.instructions} onChange={(value) => change(item.id, { instructions: value })} />
                        <div className="flex flex-wrap gap-4 text-xs text-[var(--text-dim)]">
                            <label className="flex items-center gap-2"><input type="checkbox" checked={item.required} onChange={(e) => change(item.id, { required: e.target.checked })} /> Required</label>
                            <label className="flex items-center gap-2"><input type="checkbox" checked={item.nonBlocking} onChange={(e) => change(item.id, { nonBlocking: e.target.checked })} /> Non-blocking override</label>
                            <button className="text-[var(--bad)] ml-auto" onClick={() => update((current) => ({ ...current, access: current.access.filter((saved) => saved.id !== item.id) }))}>Remove</button>
                        </div>
                    </div>
                ))}</div>
            )}
        </Panel>
    );
}

function BaselineStep({ data, update }: StepProps) {
    const set = (key: keyof OnboardingData['baseline'], value: string | boolean) => update((current) => ({ ...current, baseline: { ...current.baseline, [key]: value } }));
    return (
        <Panel title="Baseline capture" action={<span className={`mark ${data.baseline.captured ? 'mark-ok' : data.projectType === 'CASE_STUDY' ? 'mark-warn' : 'mark-idle'}`}>{data.baseline.captured ? 'Captured' : 'Required before build'}</span>}>
            <p className="text-sm text-[var(--text-dim)]">Preserve the current state before anything changes. Enter “Unknown / not tracked” for missing metrics—never estimate them.</p>
            <div className="grid sm:grid-cols-2 gap-4">
                <Field label="Current landing page screenshots / link" value={data.baseline.landingPage} onChange={(value) => set('landingPage', value)} />
                <Field label="Current hero screenshot / copy" value={data.baseline.hero} onChange={(value) => set('hero', value)} />
                <Field label="Booking flow screenshots / link" value={data.baseline.bookingFlow} onChange={(value) => set('bookingFlow', value)} />
                <Field label="Current copy document" value={data.baseline.currentCopy} onChange={(value) => set('currentCopy', value)} />
                <Field label="Current CTA wording" value={data.baseline.cta} onChange={(value) => set('cta', value)} />
                <Field label="Nurture emails" value={data.baseline.nurtureEmails} onChange={(value) => set('nurtureEmails', value)} />
                <Field label="Traffic data" hint="Known value or Unknown / not tracked" value={data.baseline.traffic} onChange={(value) => set('traffic', value)} />
                <Field label="Booking data" hint="Known value or Unknown / not tracked" value={data.baseline.bookings} onChange={(value) => set('bookings', value)} />
                <Field label="Show-rate data" hint="Known value or Unknown / not tracked" value={data.baseline.showRate} onChange={(value) => set('showRate', value)} />
                <Field label="Client / close-rate data" hint="Known value or Unknown / not tracked" value={data.baseline.closeRate} onChange={(value) => set('closeRate', value)} />
                <Field label="Analytics screenshots / evidence" value={data.baseline.analyticsEvidence} onChange={(value) => set('analyticsEvidence', value)} />
                <Field label="Baseline date" type="date" value={data.baseline.capturedAt} onChange={(value) => set('capturedAt', value)} />
            </div>
            <Field label="Baseline notes" multiline value={data.baseline.notes} onChange={(value) => set('notes', value)} />
            <button className={data.baseline.captured ? 'btn btn-outline' : 'btn btn-primary'} onClick={() => update((current) => ({ ...current, baseline: { ...current.baseline, captured: !current.baseline.captured, capturedAt: current.baseline.captured ? current.baseline.capturedAt : current.baseline.capturedAt || new Date().toISOString().slice(0, 10) } }))}>
                <Check className="w-3.5 h-3.5" /> {data.baseline.captured ? 'Reopen baseline' : 'Mark baseline captured'}
            </button>
        </Panel>
    );
}

function ScopeStep({ data, update }: StepProps) {
    const set = (key: keyof OnboardingData['scope'], value: string | boolean) => update((current) => ({ ...current,
        scope: { ...current.scope, [key]: value, confirmed: false, confirmedAt: '' },
        ...(key === 'included' ? { agreement: { ...current.agreement, deliverables: String(value) } } : {}),
    }));
    return (
        <div className="space-y-4">
            <Panel title="Scope confirmation" action={<span className={`mark ${data.scope.confirmed ? 'mark-ok' : 'mark-idle'}`}>{data.scope.confirmed ? 'Client confirmed' : 'Waiting for confirmation'}</span>}>
                <div className="grid md:grid-cols-2 gap-4">
                    <Field label="Included" multiline value={data.scope.included} onChange={(value) => set('included', value)} />
                    <Field label="Not included" multiline value={data.scope.excluded} onChange={(value) => set('excluded', value)} />
                    <Field label="Target launch date" type="date" value={data.scope.targetLaunchDate} onChange={(value) => set('targetLaunchDate', value)} />
                    <Field label="Person responsible for approvals" value={data.scope.approvalOwner} onChange={(value) => set('approvalOwner', value)} />
                    <Field label="Expected revision process" multiline value={data.scope.revisionProcess} onChange={(value) => set('revisionProcess', value)} />
                    <Field label="Key dependencies" multiline value={data.scope.dependencies} onChange={(value) => set('dependencies', value)} />
                </div>
                <button className={data.scope.confirmed ? 'btn btn-outline' : 'btn btn-primary'} onClick={() => update((current) => ({ ...current, scope: { ...current.scope, confirmed: !current.scope.confirmed, confirmedAt: current.scope.confirmed ? '' : new Date().toISOString() } }))}>
                    <FileSignature className="w-3.5 h-3.5" /> {data.scope.confirmed ? 'Reopen scope' : 'Record client confirmation'}
                </button>
            </Panel>
        </div>
    );
}

function ReadyStep({ project, data, ready, blockers, busy, onStart }: { project: ProjectData; data: OnboardingData; ready: boolean; blockers: ReturnType<typeof onboardingBlockers>; busy: boolean; onStart: () => void }) {
    return (
        <div className="space-y-4">
            <Panel title={ready ? 'Ready to build' : 'Not ready to build'}>
                <div className={`rounded-md border p-5 ${ready ? 'border-[var(--signal-line)] bg-[var(--signal-dim)]' : 'border-[rgba(232,177,76,.25)] bg-[var(--warn-dim)]'}`}>
                    <div className="flex gap-3">
                        {ready ? <ClipboardCheck className="w-6 h-6 text-[var(--signal)] flex-none" /> : <CircleAlert className="w-6 h-6 text-[var(--warn)] flex-none" />}
                        <div><h3 className="font-medium">{ready ? 'Everything needed to start is organized.' : `${blockers.length} blocker${blockers.length === 1 ? '' : 's'} remain.`}</h3><p className="text-sm text-[var(--text-dim)] mt-1">{ready ? 'Review the handoff, then complete onboarding.' : blockers.map((item) => item.label).join(' · ')}</p></div>
                    </div>
                </div>
                <div className="grid sm:grid-cols-2 gap-4 text-sm">
                    <Summary label="Project" value={data.projectName} />
                    <Summary label="Funnel" value={FUNNEL_LABELS[project.funnel]} />
                    <Summary label="Target launch" value={data.scope.targetLaunchDate || 'Not set'} />
                    <Summary label="Approval owner" value={data.scope.approvalOwner || 'Not set'} />
                    <Summary label="Available access" value={data.access.filter((item) => item.status === 'VERIFIED').map((item) => item.platform).join(', ') || 'None verified'} />
                    <Summary label="Baseline" value={data.baseline.captured ? `Captured ${data.baseline.capturedAt || ''}` : 'Not captured'} />
                </div>
                <div><p className="field-label">Final scope</p><p className="text-sm text-[var(--text-dim)] whitespace-pre-wrap">{data.scope.included || 'No included work recorded.'}</p></div>
                <button className="btn btn-primary btn-lg" disabled={!ready || busy || project.status !== 'ONBOARDING'} onClick={onStart}>{project.status === 'ONBOARDING' ? 'Complete onboarding' : 'Already handed off'} <ChevronRight className="w-4 h-4" /></button>
            </Panel>
            <Documents data={data} />
        </div>
    );
}

function Documents({ data }: { data: OnboardingData }) {
    const docs: Array<{ name: string; kind: string; action?: () => void }> = [
        { name: 'Agreement draft', kind: 'Generated PDF', action: () => downloadBlob(agreementPdf(data), `${data.projectName}-agreement.pdf`) },
        ...data.documents.map((document) => ({ name: document.name, kind: document.fileName || document.kind, action: document.dataUrl ? () => downloadDataUrl(document.dataUrl!, document.fileName) : undefined })),
        { name: 'Onboarding responses', kind: data.form.status === 'COMPLETE' ? 'Complete' : 'In progress' },
        { name: 'Scope confirmation', kind: data.scope.confirmed ? 'Confirmed' : 'Waiting' },
        { name: 'Access records', kind: `${data.access.length} items` },
        { name: 'Baseline record', kind: data.baseline.captured ? 'Captured' : 'Waiting' },
        ...(data.projectType === 'CASE_STUDY' ? [{ name: 'Case-study permission', kind: data.form.caseStudyConsent ? 'Accepted' : 'Awaiting acceptance' }] : []),
    ];
    return <Panel title="Documents"><div className="divide-y divide-[var(--line)]">{docs.map((doc, index) => <div key={`${doc.name}-${index}`} className="flex items-center gap-3 py-3"><FileText className="w-4 h-4 text-[var(--text-faint)]" /><span className="flex-1 text-sm">{doc.name}</span><span className="text-xs text-[var(--text-faint)]">{doc.kind}</span>{doc.action && <button className="btn btn-ghost !p-1" title="Download" onClick={doc.action}><Download className="w-3.5 h-3.5" /></button>}</div>)}</div></Panel>;
}

function PortalPreview({ data, blockers, onClose }: { data: OnboardingData; blockers: ReturnType<typeof onboardingBlockers>; onClose: () => void }) {
    const outstanding = onboardingBlockers(data, 'client').map((item) => item.label);
    return (
        <div className="compel-portal fixed inset-0 z-50 overflow-y-auto">
            <header className="compel-portal-header"><CompelLogo /><span className="compel-portal-header-label">Client portal preview</span><button className="btn btn-outline ml-auto" onClick={onClose}><X className="w-3.5 h-3.5" /> Close preview</button></header>
            <main className="max-w-3xl mx-auto p-5 md:p-10 space-y-6">
                <div><p className="label-micro">{data.businessName || data.clientName}</p><h1 className="text-2xl font-semibold mt-2">Welcome, {data.clientName.split(' ')[0]}</h1><p className="text-[var(--text-dim)] mt-2">Everything needed to prepare {data.projectName}, in one place.</p></div>
                <section className="panel p-5 space-y-4"><h2 className="font-medium">Review your scope before signing</h2><ClientScopeSummary data={data} /></section>
                <div className={`panel p-5 ${outstanding.length ? 'border-[rgba(232,177,76,.25)]' : 'border-[var(--signal-line)]'}`}>
                    <h2 className="font-medium">{outstanding.length ? "Here's what we still need from you before the project can start." : 'You are all set. This project is ready to start.'}</h2>
                    {outstanding.length > 0 && <ul className="mt-4 space-y-2">{outstanding.map((item) => <li key={item} className="flex items-center gap-2 text-sm text-[var(--text-dim)]"><CircleAlert className="w-4 h-4 text-[var(--warn)]" />{item}</li>)}</ul>}
                </div>
                <div className="space-y-2">{[
                    ['Agreement', CLIENT_AGREEMENT_LABELS[data.agreement.status], data.agreement.status === 'FULLY_SIGNED'],
                    ...(data.projectType === 'PAID' ? [['Payment', CLIENT_PAYMENT_LABELS[data.payment.status], ['FULLY_PAID', 'DEPOSIT_PAID'].includes(data.payment.status)]] : []),
                    ['Onboarding form', clientFormStatus(data), onboardingFormComplete(data)],
                    ['Access requests', data.access.length ? `${data.access.filter((item) => item.status === 'VERIFIED').length} of ${data.access.filter((item) => item.required && !item.nonBlocking).length} verified` : onboardingFormComplete(data) ? 'Not needed' : 'Optional · share if applicable', onboardingAccessComplete(data)],
                    ['Assets', data.form.assets ? 'Received' : 'Waiting', Boolean(data.form.assets)],
                    ['Scope confirmation', data.scope.confirmed ? 'Confirmed' : 'Waiting', data.scope.confirmed],
                ].map(([label, status, done]) => <div key={String(label)} className="panel px-4 py-4 flex items-center gap-3"><span className={`w-6 h-6 rounded-full flex items-center justify-center border ${done ? 'text-[var(--signal)] border-[var(--signal-line)] bg-[var(--signal-dim)]' : 'text-[var(--text-faint)] border-[var(--line-strong)]'}`}>{done ? <Check className="w-3.5 h-3.5" /> : <span className="w-1.5 h-1.5 bg-current rounded-full" />}</span><span className="font-medium flex-1">{label}</span><span className="text-sm text-[var(--text-dim)] capitalize">{status}</span></div>)}</div>
                <p className="text-xs text-center text-[var(--text-faint)]">This preview intentionally excludes the full Compel workspace.</p>
            </main>
        </div>
    );
}

function Summary({ label, value }: { label: string; value: string }) {
    return <div className="border border-[var(--line)] rounded-md p-3"><p className="label-micro">{label}</p><p className="mt-1.5 text-[var(--text-dim)] whitespace-pre-wrap">{value}</p></div>;
}

function stepComplete(step: Step, data: OnboardingData, ready: boolean) {
    if (step === 'agreement') return data.agreement.status === 'FULLY_SIGNED' || data.overrides.includes('agreement');
    if (step === 'payment') return data.projectType === 'CASE_STUDY' || data.payment.status === 'FULLY_PAID' || (data.payment.structure !== 'FULL' && data.payment.status === 'DEPOSIT_PAID') || data.overrides.includes('payment');
    if (step === 'form') return onboardingFormComplete(data) || data.overrides.includes('form');
    if (step === 'access') return !onboardingBlockers(data).some((item) => item.key === 'access');
    if (step === 'baseline') return data.baseline.captured || data.overrides.includes('baseline');
    if (step === 'scope') return data.scope.confirmed || data.overrides.includes('scope');
    return ready;
}

function downloadBlob(blob: Blob, fileName: string) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function downloadDataUrl(dataUrl: string, fileName: string) {
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = fileName;
    link.click();
}

