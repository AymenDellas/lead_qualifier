import { notFound } from 'next/navigation';
import { ArrowUpRight, Check, FileText, KeyRound, LayoutList, UserRound } from 'lucide-react';
import { CompelLogo } from '@/components/business/CompelLogo';
import { ClientScopeSummary } from '@/components/business/ClientScopeSummary';
import '@/components/business/compel-onboarding.css';
import {
    confirmClientScopeAction,
    markPortalAccessReceivedAction,
    saveClientPortalFormAction,
} from '@/app/actions/business-actions';
import { ensureBusinessSchema } from '@/lib/business-store';
import { pool } from '@/lib/pg_setup';
import {
    CASE_STUDY_CONSENT_TEXT,
    CASE_STUDY_CONSENT_VERSION,
    DEPLOYMENT_TOOL_FIELDS,
    DEPLOYMENT_TOOL_HINT,
    FUNNEL_OFFER_HINT,
    FUNNEL_OFFER_QUESTION,
    DIFFERENTIATION_QUESTION,
    UNSUITABLE_CLIENTS_QUESTION,
    CLIENT_AGREEMENT_LABELS,
    CLIENT_PAYMENT_LABELS,
    clientFormStatus,
    normalizeOnboarding,
    onboardingAccessComplete,
    onboardingBlockers,
    onboardingFormComplete,
    onboardingProgress,
    type OfferProfile,
    type OpportunityData,
    type ProjectData,
} from '@/lib/business';

export const dynamic = 'force-dynamic';

export default async function ClientPortalPage({ params }: { params: Promise<{ token: string }> }) {
    const { token } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(token)) notFound();
    await ensureBusinessSchema();
    const result = await pool.query(
        `SELECT p.data AS project, o.data AS opportunity, v.profile
         FROM business_projects p
         JOIN business_opportunities o ON o.id=p.opportunity_id
         JOIN business_offer_versions v ON v.version=p.offer_version
         WHERE p.data->'onboarding'->>'portalToken'=$1
         LIMIT 1`,
        [token],
    );
    if (!result.rows[0]) notFound();
    const project = result.rows[0].project as ProjectData;
    const data = normalizeOnboarding(
        project,
        result.rows[0].opportunity as OpportunityData,
        result.rows[0].profile as OfferProfile,
    );
    const blockers = onboardingBlockers(data, 'client');
    const progress = onboardingProgress(data);
    const requiredAccess = data.access.filter((item) => item.required && !item.nonBlocking);
    const tasks = [
        {
            label: 'Scope and agreement',
            href: '#agreement',
            detail: data.overrides.includes('agreement') ? 'Complete' : CLIENT_AGREEMENT_LABELS[data.agreement.status],
            done: data.agreement.status === 'FULLY_SIGNED' || data.overrides.includes('agreement'),
            icon: FileText,
        },
        ...(data.projectType === 'PAID'
            ? [
                  {
                      label: 'Payment',
                      href: '#payment',
                      detail: data.overrides.includes('payment') ? 'Complete' : CLIENT_PAYMENT_LABELS[data.payment.status],
                      done:
                          data.payment.status === 'FULLY_PAID' ||
                          (data.payment.structure !== 'FULL' && data.payment.status === 'DEPOSIT_PAID') ||
                          data.overrides.includes('payment'),
                      icon: FileText,
                  },
              ]
            : []),
        {
            label: 'Onboarding form',
            href: '#onboarding-form',
            detail: data.overrides.includes('form') ? 'Complete' : clientFormStatus(data),
            done: onboardingFormComplete(data) || data.overrides.includes('form'),
            icon: LayoutList,
        },
        {
            label: 'Access requests',
            href: data.access.some((item) => !['VERIFIED', 'NOT_NEEDED'].includes(item.status)) ? '#access-instructions' : '#onboarding-form',
            detail: requiredAccess.length
                ? `${requiredAccess.filter((item) => ['VERIFIED', 'NOT_NEEDED'].includes(item.status)).length} of ${requiredAccess.length} cleared`
                : onboardingFormComplete(data) ? 'Not needed' : 'Optional · share if applicable',
            done: onboardingAccessComplete(data),
            icon: KeyRound,
        },
        {
            label: 'Assets',
            href: '#portal-assets',
            detail: data.form.assets ? 'Received' : 'Optional',
            done: Boolean(data.form.assets),
            icon: FileText,
        },
        {
            label: 'Scope confirmation',
            href: '#scope-confirmation',
            detail: data.scope.confirmed ? 'Confirmed' : 'Review required',
            done: data.scope.confirmed || data.overrides.includes('scope'),
            icon: Check,
        },
    ];
    return (
        <main className="compel-onboarding compel-portal">
            <header className="compel-portal-header">
                <CompelLogo />
                <span className="compel-portal-header-label">Client portal</span>
                <a href="#portal-help" className="compel-portal-help">Need a hand? <ArrowUpRight className="w-4 h-4" aria-hidden /></a>
            </header>
            <div className="compel-portal-wrap">
                <section className="compel-portal-hero">
                    <div>
                        <p className="label-micro compel-portal-eyebrow">{data.businessName || data.clientName} / Onboarding</p>
                        <h1 className="compel-portal-title">Welcome, <em>{data.clientName.split(' ')[0]}.</em></h1>
                        <p className="compel-portal-intro">Everything needed to prepare {data.projectName}, in one place. Review your agreement, share your details, and we’ll take it from there.</p>
                    </div>
                    <div className="compel-portal-progress">
                        <p className="label-micro">Your progress</p>
                        <p className="compel-portal-progress-value num">{progress}<span>%</span></p>
                        <div className="bar-track" role="progressbar" aria-label="Onboarding progress" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}><div className="bar-fill" style={{ width: `${progress}%` }} /></div>
                        <p>{blockers.length ? `${blockers.length} item${blockers.length === 1 ? '' : 's'} before we start` : 'All set. Ready to build.'}</p>
                    </div>
                </section>
                <div className="compel-portal-layout">
                    <div className="compel-portal-content">
                        <section id="agreement" className="panel">
                            <div className="panel-head compel-portal-section-head"><span>01</span><h2>Your scope and agreement</h2></div>
                            <div className="panel-body space-y-5">
                                <p className="text-sm text-[var(--text-dim)]">Review the deliverables and exclusions before opening and signing your agreement.</p>
                                <ClientScopeSummary data={data} />
                                <div className="flex flex-wrap items-center gap-3 border-t border-[var(--line)] pt-5"><div className="flex-1 min-w-48">
                                    <p className="text-sm">{data.projectType === 'CASE_STUDY' ? 'Free case-study agreement' : 'Paid-client agreement'}</p>
                                    <p className="text-xs text-[var(--text-faint)] mt-1">{data.overrides.includes('agreement') ? 'Complete' : CLIENT_AGREEMENT_LABELS[data.agreement.status]}</p>
                                </div>
                                <a className="btn btn-outline" href={`/portal/${token}/agreement`} target="_blank" rel="noreferrer">Preview agreement PDF</a>
                                </div>
                            </div>
                        </section>
                        {data.projectType === 'PAID' && (
                            <section id="payment" className="panel">
                                <div className="panel-head compel-portal-section-head"><span>02</span><h2>Payment</h2></div>
                                <div className="panel-body flex flex-wrap items-center gap-3">
                                    <div className="flex-1 min-w-48">
                                        <p className="text-sm">{data.payment.currency} {data.payment.price ?? 'Price to be confirmed'} · {data.payment.structure.replaceAll('_', ' ').toLowerCase()}</p>
                                        <p className="text-xs text-[var(--text-faint)] mt-1">{CLIENT_PAYMENT_LABELS[data.payment.status]}</p>
                                    </div>
                                    {data.payment.link && <a className="btn btn-primary" href={data.payment.link} target="_blank" rel="noreferrer">Open secure payment link</a>}
                                </div>
                            </section>
                        )}
                        <section id="onboarding-form" className="panel">
                            <div className="panel-head compel-portal-section-head"><span>{data.projectType === 'PAID' ? '03' : '02'}</span><h2>Tell us about your business</h2><span className="hint">Save and return anytime</span></div>
                            <form action={saveClientPortalFormAction} className="panel-body flex flex-col compel-portal-form">
                                <input type="hidden" name="token" value={token} />
                                <PortalGroup number="01" title="Offer and business">
                                    <PortalField name="offer" label={FUNNEL_OFFER_QUESTION} hint={FUNNEL_OFFER_HINT} value={data.form.offer} required />
                                    <PortalField name="audience" label="Target audience" value={data.form.audience} required />
                                    <PortalField name="trafficSources" label="Current traffic sources" value={data.form.trafficSources} />
                                    <PortalField name="customerProblem" label="Main customer problem" value={data.form.customerProblem} multiline required />
                                    <PortalField name="desiredOutcome" label="Desired outcome" value={data.form.desiredOutcome} multiline required />
                                    <PortalField name="differentiation" label={DIFFERENTIATION_QUESTION} value={data.form.differentiation} multiline />
                                    <PortalField name="unsuitableClients" label={UNSUITABLE_CLIENTS_QUESTION} value={data.form.unsuitableClients} multiline />
                                </PortalGroup>
                                <PortalGroup number="02" title="Current funnel">
                                    <PortalField name="landingPageUrl" label="Landing page URL" value={data.form.landingPageUrl} />
                                    <PortalField name="bookingUrl" label="Booking URL" value={data.form.bookingUrl} />
                                    <PortalField name="qualification" label="Current qualification" value={data.form.qualification} />
                                    <PortalField name="nurture" label="Current nurture / follow-up" value={data.form.nurture} />
                                    <PortalField name="traffic" label="Approximate traffic" value={data.form.traffic} />
                                    <PortalField name="bookings" label="Approximate bookings" value={data.form.bookings} />
                                    <PortalField name="showRate" label="Approximate show rate" value={data.form.showRate} />
                                    <PortalField name="closeRate" label="Approximate clients / close rate" value={data.form.closeRate} />
                                </PortalGroup>
                                <PortalGroup number="03" title="Tools in use">
                                    <PortalField name="bookingPlatform" label="Booking platform" value={data.form.bookingPlatform} />
                                    <PortalField name="crm" label="CRM" value={data.form.crm} />
                                    <PortalField name="emailPlatform" label="Email platform" value={data.form.emailPlatform} />
                                    <PortalField name="analyticsPlatform" label="Analytics platform" value={data.form.analyticsPlatform} />
                                </PortalGroup>
                                <PortalGroup number="04" title="Deployment tools and access · Optional">
                                    <p className="sm:col-span-2 text-sm text-[var(--text-dim)]">{DEPLOYMENT_TOOL_HINT}</p>
                                    {DEPLOYMENT_TOOL_FIELDS.map(([key, label]) => <PortalField key={key} name={key} label={label} value={data.form[key]} />)}
                                </PortalGroup>
                                <PortalGroup number="05" title="Assets and preferences">
                                    <PortalField name="assets" label="Links to logos, photos, testimonials, case studies, certifications, and copy" value={data.form.assets} multiline />
                                    <PortalField name="mustStay" label="Anything that must stay" value={data.form.mustStay} multiline />
                                    <PortalField name="avoid" label="Anything you do not want changed" value={data.form.avoid} multiline />
                                    <PortalField name="importantContext" label="Anything important that is not obvious" value={data.form.importantContext} multiline />
                                </PortalGroup>
                                {data.projectType === 'CASE_STUDY' && <fieldset className="rounded-md border border-[var(--line-strong)] p-4 space-y-3">
                                    <legend className="text-sm font-medium px-1">Case-study permission <span className="text-[var(--bad)]">*</span></legend>
                                    <input type="hidden" name="caseStudyConsentVersion" value={CASE_STUDY_CONSENT_VERSION} />
                                    <label className="flex items-start gap-3 text-sm text-[var(--text-dim)]">
                                        <input className="mt-1" type="checkbox" name="caseStudyConsent" value="accepted" defaultChecked={data.form.caseStudyConsent && data.form.testimonialCommitment} required />
                                        <span>{CASE_STUDY_CONSENT_TEXT}</span>
                                    </label>
                                </fieldset>}
                                <div className="compel-portal-form-footer">
                                    <p>You can save your answers and finish later.</p>
                                    <button className="btn btn-outline" type="submit" name="intent" value="save" formNoValidate>Save progress</button>
                                    <button className="btn btn-primary" type="submit" name="intent" value="complete">Submit onboarding form</button>
                                </div>
                            </form>
                        </section>
                        {data.access.some((item) => item.status !== 'VERIFIED' && item.status !== 'NOT_NEEDED') && (
                            <section id="access-instructions" className="panel">
                                <div className="panel-head compel-portal-section-head"><KeyRound className="w-4 h-4 text-[var(--text-faint)]" aria-hidden /><h2>Access instructions</h2></div>
                                <div className="panel-body divide-y divide-[var(--line)]">
                                    {data.access.filter((item) => item.status !== 'VERIFIED' && item.status !== 'NOT_NEEDED').map((item) => (
                                        <div key={item.id} className="py-4 first:pt-0 last:pb-0">
                                            <div className="flex items-center gap-2"><UserRound className="w-4 h-4 text-[var(--text-faint)]" /><p className="font-medium">{item.platform}</p><span className="ml-auto text-xs text-[var(--text-faint)] capitalize">{item.status.replaceAll('_', ' ').toLowerCase()}</span></div>
                                            <p className="text-sm text-[var(--text-dim)] mt-2">{item.reason}</p>
                                            <p className="text-sm mt-2">{item.instructions}</p>
                                            <div className="flex flex-wrap items-center gap-3 mt-3">
                                                <p className="text-xs text-[var(--text-faint)] flex-1">Requested permission: {item.permission}</p>
                                                {item.status !== 'RECEIVED' && <form action={markPortalAccessReceivedAction}><input type="hidden" name="token" value={token} /><input type="hidden" name="itemId" value={item.id} /><button className="btn btn-outline" type="submit">I granted this access</button></form>}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </section>
                        )}
                        <section id="scope-confirmation" className="panel">
                            <div className="panel-head compel-portal-section-head"><span>{data.projectType === 'PAID' ? '04' : '03'}</span><h2>Confirm the scope</h2></div>
                            <div className="panel-body space-y-4">
                                <ClientScopeSummary data={data} />
                                <div className="grid sm:grid-cols-2 gap-4">
                                    <div><p className="field-label">Target launch</p><p className="text-sm">{data.scope.targetLaunchDate || 'Not set'}</p></div>
                                    <div><p className="field-label">Approval owner</p><p className="text-sm">{data.scope.approvalOwner || 'Not set'}</p></div>
                                </div>
                                <div><p className="field-label">Revision process</p><p className="text-sm text-[var(--text-dim)]">{data.scope.revisionProcess}</p></div>
                                {data.scope.confirmed ? <p className="mark mark-ok">Scope confirmed</p> : <form action={confirmClientScopeAction}><input type="hidden" name="token" value={token} /><button className="btn btn-primary" type="submit">Confirm this scope</button></form>}
                            </div>
                        </section>
                    </div>
                    <aside className="compel-portal-sidebar">
                        <p className="label-micro">Your next steps</p>
                        <nav aria-label="Onboarding steps">
                            {tasks.map((task) => <a key={task.label} href={task.href} className="compel-portal-step"><span className="compel-portal-step-icon" data-done={task.done}>{task.done ? <Check className="w-4 h-4" aria-hidden /> : <task.icon className="w-4 h-4" aria-hidden />}</span><span><span className="compel-portal-step-name">{task.label}</span><span className="compel-portal-step-detail">{task.detail}</span></span></a>)}
                        </nav>
                        <details className="compel-portal-start">
                            <summary>{blockers.length ? `Before we start · ${blockers.length} remaining` : 'Ready to start'}</summary>
                            {blockers.length ? <ul>{blockers.map((item) => <li key={item.key}><p>{item.label}</p><p>{item.detail}</p></li>)}</ul> : <p className="text-sm text-[var(--text-dim)] mt-3">You are all set. This project is ready to start.</p>}
                        </details>
                        <div className="compel-portal-support">
                            <h2 className="font-medium">We’re here to help.</h2>
                            <p>Unsure about an answer or need a hand with access? Reply to your Compel project contact.</p>
                            <a href="mailto:aymen@getcompel.co">Ask Aymen <ArrowUpRight className="w-3.5 h-3.5 inline-block" aria-hidden /></a>
                        </div>
                    </aside>
                </div>
                <footer id="portal-help" className="compel-portal-footer"><span>Made for you, by Compel.</span><span>Need help? <a className="underline underline-offset-4" href="mailto:aymen@getcompel.co">Reply to your project contact.</a> Never send passwords by email.</span></footer>
            </div>
        </main>
    );
}

function PortalGroup({ number, title, children }: { number: string; title: string; children: React.ReactNode }) {
    return <fieldset className="compel-portal-group"><legend className="label-micro"><span>{number} /</span>{title}</legend><div className="grid sm:grid-cols-2 gap-x-5 gap-y-6">{children}</div></fieldset>;
}

function PortalField({ name, label, value, hint, multiline = false, required = false }: { name: string; label: string; value: string; hint?: string; multiline?: boolean; required?: boolean }) {
    const id = `portal-${name}`;
    const hintId = hint ? `${id}-hint` : undefined;
    return (
        <div className={`space-y-2 min-w-0 ${['offer', 'differentiation', 'unsuitableClients', 'assets', 'importantContext'].includes(name) ? 'sm:col-span-2' : ''}`}>
            <label htmlFor={id} className="flex items-baseline justify-between gap-2 text-sm text-[var(--text-dim)]">
                <span>{label}{required ? ' *' : ''}</span>
                {!required && <span className="text-xs text-[var(--text-faint)]">Optional</span>}
            </label>
            {multiline
                ? <textarea id={id} className="field w-full min-h-24" name={name} defaultValue={value} required={required} aria-describedby={hintId} />
                : <input id={id} className="field w-full" name={name} defaultValue={value} required={required} aria-describedby={hintId} />}
            {hint && <p id={hintId} className="text-xs text-[var(--text-faint)]">{hint}</p>}
        </div>
    );
}
