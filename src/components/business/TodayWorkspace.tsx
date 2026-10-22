'use client';

import { ArrowRight, ClipboardCheck, MessagesSquare, Radar, ScanSearch } from 'lucide-react';
import { normalizeOnboarding, onboardingBlockers, onboardingProgress, type BusinessSnapshot } from '@/lib/business';
import { Panel } from './BusinessUi';

export default function TodayWorkspace({ snapshot, onOnboarding, onNavigate }: {
    snapshot: BusinessSnapshot;
    onOnboarding: (id: string) => void;
    onNavigate: (view: 'today' | 'onboarding' | 'case-study' | 'discovery' | 'crm') => void;
}) {
    const rows = snapshot.projects.map(project => {
        const opportunity = snapshot.opportunities.find(item => item.id === project.opportunityId)?.data;
        const onboarding = normalizeOnboarding(project.data, opportunity, snapshot.offer.profile);
        const blockers = onboardingBlockers(onboarding);
        return { project, onboarding, blockers, progress: onboardingProgress(onboarding) };
    });
    const active = rows.filter(({ project, blockers }) => project.data.status === 'ONBOARDING' && blockers.length);
    const ready = rows.filter(({ project, blockers }) => project.data.status === 'ONBOARDING' && !blockers.length);
    const handedOff = rows.filter(({ project }) => project.data.status !== 'ONBOARDING');
    const attention = [...active, ...ready].sort((a, b) =>
        Number(!a.blockers.length) - Number(!b.blockers.length)
        || Date.parse(b.project.updatedAt) - Date.parse(a.project.updatedAt),
    ).slice(0, 6);
    const next = attention[0];

    return <div className="workspace-overview">
        <section className="workspace-brief" aria-label="Client readiness">
            <div className="workspace-brief-copy">
                <span className="workspace-kicker">Client readiness</span>
                <h2>{active.length
                    ? `${active.length} onboarding${active.length === 1 ? ' needs' : 's need'} attention.`
                    : 'No onboarding blockers right now.'}</h2>
                <p>{active.length
                    ? 'See what’s outstanding and take the next step with each client.'
                    : ready.length ? 'Your ready clients can move into the build. Keep their next steps together here.'
                    : 'Accepted clients and their next steps will appear here.'}</p>
            </div>
            <div className="workspace-brief-actions">
                <button className="btn btn-primary" onClick={() => next ? onOnboarding(next.project.id) : onNavigate('onboarding')}>
                    {next ? 'Open next onboarding' : 'Open onboarding'} <ArrowRight className="w-4 h-4" />
                </button>
            </div>
        </section>

        <section className="workspace-summary" aria-label="Onboarding summary">
            <Summary label="Needs attention" value={active.length} detail="Required steps remaining" tone="attention" />
            <Summary label="Ready to build" value={ready.length} detail="No remaining blockers" tone="ready" />
            <Summary label="Handed off" value={handedOff.length} detail="Moved beyond onboarding" />
        </section>

        <div className="workspace-overview-grid">
            <Panel title="Client next steps" action={<button className="btn btn-ghost" onClick={() => onNavigate('onboarding')}>View all <ArrowRight className="w-3.5 h-3.5" /></button>}>
                {!attention.length ? <div className="workspace-empty">
                    <span className="workspace-empty-symbol" aria-hidden><ClipboardCheck className="w-6 h-6" /></span>
                    <h3>Your next client starts here</h3>
                    <p>Once a client says yes, create their onboarding to keep the agreement, access, and build requirements together.</p>
                    <button className="btn btn-outline" onClick={() => onNavigate('onboarding')}>Go to onboarding <ArrowRight className="w-4 h-4" /></button>
                </div> : <div className="workspace-client-list">
                    {attention.map(({ project, onboarding, blockers, progress }) => <button key={project.id} className="workspace-client-row" onClick={() => onOnboarding(project.id)}>
                        <span className="workspace-client-avatar" aria-hidden>{onboarding.clientName.trim().split(/\s+/).slice(0, 2).map(name => name.charAt(0)).join('').toUpperCase() || 'C'}</span>
                        <span className="workspace-client-identity"><strong>{onboarding.clientName || 'Unnamed client'}</strong><span>{onboarding.projectName}</span></span>
                        <span className="workspace-client-next">
                            <span className={`workspace-row-status ${blockers.length ? 'is-waiting' : 'is-ready'}`}><span aria-hidden />{blockers.length ? `${blockers.length} open item${blockers.length === 1 ? '' : 's'}` : 'Ready to build'}</span>
                            <span className="workspace-next-label">{blockers[0]?.label || 'All required steps complete'}</span>
                        </span>
                        <span className="workspace-client-progress"><span className="workspace-progress-caption"><span>Complete</span><strong>{progress}%</strong></span><span className="bar-track"><span className="bar-fill" style={{ width: `${progress}%` }} /></span></span>
                        <ArrowRight className="workspace-client-arrow w-4 h-4" aria-hidden />
                    </button>)}
                </div>}
            </Panel>
            <Panel title="Continue working">
                <div className="workspace-shortcuts">
                    <QuickLink icon={ScanSearch} title="Find your next client" detail="Prospecting & outreach" onClick={() => onNavigate('case-study')} />
                    <QuickLink icon={Radar} title="Review your leads" detail="Saved prospects & contact status" onClick={() => onNavigate('crm')} />
                    <QuickLink icon={MessagesSquare} title="Prepare a conversation" detail="Discovery calls & follow-ups" onClick={() => onNavigate('discovery')} />
                    <QuickLink icon={ClipboardCheck} title="Move a client forward" detail="Agreements, access & readiness" onClick={() => onNavigate('onboarding')} />
                </div>
                <div className="workspace-context-note"><span aria-hidden />Your client work and prospecting stay connected in one workspace.</div>
            </Panel>
        </div>
    </div>;
}
function Summary({ label, value, detail, tone }: { label: string; value: number; detail: string; tone?: 'attention' | 'ready' }) {
    return <div className={`workspace-summary-item${tone ? ` is-${tone}` : ''}`}><span className="workspace-summary-label">{label}</span><strong className="num">{value}</strong><span className="workspace-summary-detail">{detail}</span></div>;
}
function QuickLink({ icon: Icon, title, detail, onClick }: { icon: typeof ClipboardCheck; title: string; detail: string; onClick: () => void }) {
    return <button className="workspace-shortcut" onClick={onClick}><Icon className="w-4 h-4" aria-hidden /><span><strong>{title}</strong><span>{detail}</span></span><ArrowRight className="w-3.5 h-3.5" aria-hidden /></button>;
}
