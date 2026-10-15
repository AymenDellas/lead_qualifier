'use client';

import { ArrowRight, CheckCircle2, ClipboardCheck, MessagesSquare, Radar, ScanSearch } from 'lucide-react';
import {
    normalizeOnboarding,
    onboardingBlockers,
    onboardingProgress,
    type BusinessSnapshot,
} from '@/lib/business';
import { Empty, Panel } from './BusinessUi';

export default function TodayWorkspace({
    snapshot,
    onOnboarding,
    onNavigate,
}: {
    snapshot: BusinessSnapshot;
    onOnboarding: (id: string) => void;
    onNavigate: (view: 'today' | 'onboarding' | 'case-study' | 'discovery' | 'crm') => void;
}) {
    const rows = snapshot.projects.map((project) => {
        const opportunity = snapshot.opportunities.find((item) => item.id === project.opportunityId)?.data;
        const onboarding = normalizeOnboarding(project.data, opportunity, snapshot.offer.profile);
        const blockers = onboardingBlockers(onboarding);
        return { project, onboarding, blockers, progress: onboardingProgress(onboarding) };
    });
    const active = rows.filter(({ project, blockers }) => project.data.status === 'ONBOARDING' && blockers.length);
    const ready = rows.filter(({ project, blockers }) => project.data.status === 'ONBOARDING' && !blockers.length);
    const handedOff = rows.filter(({ project }) => project.data.status !== 'ONBOARDING');
    const attention = [...active, ...ready].sort((a, b) =>
        Date.parse(b.project.updatedAt) - Date.parse(a.project.updatedAt),
    ).slice(0, 6);

    return (
        <div className="overview space-y-6">
            <section className="overview-hero">
                <div className="relative z-10 max-w-2xl">
                    <p className="overview-eyebrow">Your workspace</p>
                    <h2 className="text-[clamp(25px,3vw,34px)] font-semibold tracking-[-0.045em] leading-tight mt-3">
                        Make every next step clear.
                    </h2>
                    <p className="overview-hero-copy text-sm mt-3 max-w-xl leading-relaxed">
                        Find the right people, keep lead work moving, and bring accepted clients from agreement to ready-to-build in one place.
                    </p>
                    <button className="btn btn-primary mt-5" onClick={() => onNavigate('onboarding')}>
                        Open onboarding <ArrowRight className="w-4 h-4" />
                    </button>
                </div>
                <div className="overview-hero-orb" aria-hidden />
            </section>

            <section className="grid sm:grid-cols-3 gap-4" aria-label="Onboarding summary">
                <Metric icon={ClipboardCheck} label="Active onboardings" value={active.length} detail="Projects with items to finish" />
                <Metric icon={CheckCircle2} label="Ready to build" value={ready.length} detail="No remaining blockers" highlight />
                <Metric icon={ArrowRight} label="Handed off" value={handedOff.length} detail="Moved beyond onboarding" />
            </section>

            <div className="grid xl:grid-cols-[minmax(0,1.55fr)_minmax(280px,0.9fr)] gap-5 items-start">
                <Panel title="Onboarding activity" action={<button className="btn btn-ghost" onClick={() => onNavigate('onboarding')}>View all <ArrowRight className="w-3.5 h-3.5" /></button>}>
                    {!attention.length ? (
                        <div className="py-7 text-center">
                            <Empty>No active onboarding yet. Start one when a client says yes.</Empty>
                            <button className="btn btn-outline mt-3" onClick={() => onNavigate('onboarding')}>Go to onboarding</button>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {attention.map(({ project, onboarding, blockers, progress }) => (
                                <button key={project.id} className="work-row" onClick={() => onOnboarding(project.id)}>
                                    <span className="work-avatar" aria-hidden>{onboarding.clientName.trim().charAt(0).toUpperCase() || 'C'}</span>
                                    <span className="min-w-0 flex-1">
                                        <span className="block font-medium text-[var(--text)] truncate">{onboarding.clientName}</span>
                                        <span className="block text-xs text-[var(--text-dim)] truncate mt-0.5">{onboarding.projectName}</span>
                                    </span>
                                    <span className="min-w-0 hidden sm:block w-[min(38%,220px)]">
                                        <span className={`block text-xs truncate text-right ${blockers.length ? 'text-[var(--warn)]' : 'text-[var(--success)]'}`}>
                                            {blockers[0]?.label || 'Ready to build'}
                                        </span>
                                        <span className="bar-track block mt-2"><span className="bar-fill block" style={{ width: `${progress}%` }} /></span>
                                    </span>
                                    <ArrowRight className="w-4 h-4 text-[var(--text-faint)] flex-none" />
                                </button>
                            ))}
                        </div>
                    )}
                </Panel>

                <Panel title="Quick access">
                    <div className="space-y-2">
                        <QuickLink icon={ScanSearch} title="Case Study Hunter" detail="Find and qualify promising coaches" onClick={() => onNavigate('case-study')} />
                        <QuickLink icon={MessagesSquare} title="Discovery calls" detail="Prepare questions, pitch, and next steps" onClick={() => onNavigate('discovery')} />
                        <QuickLink icon={Radar} title="Leads database" detail="Review and organize discovered leads" onClick={() => onNavigate('crm')} />
                        <QuickLink icon={ClipboardCheck} title="Client onboarding" detail="Agreements, access, and readiness" onClick={() => onNavigate('onboarding')} />
                    </div>
                    <p className="text-xs text-[var(--text-faint)] border-t border-[var(--line)] pt-4 mt-4">
                        The workspace is organized around prospecting and getting new projects ready to build.
                    </p>
                </Panel>
            </div>
        </div>
    );
}

function Metric({ icon: Icon, label, value, detail, highlight = false }: {
    icon: typeof ClipboardCheck;
    label: string;
    value: number;
    detail: string;
    highlight?: boolean;
}) {
    return <div className={`metric-card ${highlight ? 'metric-card-highlight' : ''}`}>
        <span className="metric-icon"><Icon className="w-4 h-4" /></span>
        <p className="text-sm font-medium text-[var(--text-dim)] mt-5">{label}</p>
        <p className="text-[30px] leading-none font-semibold tracking-[-0.04em] num mt-2">{value}</p>
        <p className="text-xs text-[var(--text-faint)] mt-2">{detail}</p>
    </div>;
}

function QuickLink({ icon: Icon, title, detail, onClick }: {
    icon: typeof ClipboardCheck;
    title: string;
    detail: string;
    onClick: () => void;
}) {
    return <button className="quick-link" onClick={onClick}>
        <span className="quick-link-icon"><Icon className="w-4 h-4" /></span>
        <span className="min-w-0 flex-1 text-left">
            <span className="block text-sm font-medium text-[var(--text)]">{title}</span>
            <span className="block text-xs text-[var(--text-dim)] mt-0.5">{detail}</span>
        </span>
        <ArrowRight className="w-4 h-4 text-[var(--text-faint)]" />
    </button>;
}
