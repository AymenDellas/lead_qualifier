'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronDown, ExternalLink, Loader2, Pencil } from 'lucide-react';
import { CASE_STUDY_CONSENT_TEXT, CASE_STUDY_CONSENT_VERSION, CLIENT_AGREEMENT_LABELS, CLIENT_PAYMENT_LABELS, type OnboardingData } from '@/lib/business';
import { ACCESS_NEEDS, essentialsPresent, introductionDraft, introductionMailto, journeyFor, needsWebsiteIntroduction, publishingReady, clientJourneyStep, storedJourneyStep } from '@/lib/onboarding-journey';
import { proofPreview, reviewSummary, type ReviewKey } from '@/lib/onboarding-review';
import { ClientAccessRequests } from './ClientAccessRequests';
import { CompelLogo } from './CompelLogo';
import './client-onboarding.css';

export type ClientOnboardingDraft = Pick<OnboardingData, 'clientName' | 'projectName' | 'projectType' | 'website' | 'form' | 'journey' | 'scope' | 'access' | 'overrides'> & {
    agreement: Pick<OnboardingData['agreement'], 'status' | 'deliverables'>;
    payment: Pick<OnboardingData['payment'], 'structure' | 'status' | 'price' | 'currency' | 'deposit' | 'balance' | 'link'>;
};
type SaveResult = { ok: true; revision: number } | { ok: false; error: string };
const steps = ['Your offer', 'Story & proof', 'Going live', 'Scope & agreement'];
const titles = ['Your offer, in your words.', 'The experience behind your work.', 'Let’s arrange your launch.', 'A clear plan, before we begin.'];
const descriptions = ['Does this sound right? Edit anything that needs a change.', 'Review the highlights. The original details are here if you need them.', 'Tell us who can help. We’ll take care of the technical details.', 'Review what’s included and open your agreement before confirming the scope.'];
const essentials = [
    ['offerName', 'Your offer’s name'], ['offer', 'What do clients get?'], ['audience', 'Who is this for?'],
    ['customerProblem', 'What are they struggling with?'], ['desiredOutcome', 'What change do they want?'],
] as const;
const contextFields: [ReviewKey, string][] = [['coachBio', 'Your story & experience'], ['differentiation', 'What makes your work different']];

export function ClientOnboardingWizard({ initial, token, revision, save, briefReady = true }: {
    initial: ClientOnboardingDraft; token: string; revision: number; save: (data: FormData) => Promise<SaveResult>; briefReady?: boolean;
}) {
    const [step, setStep] = useState(() => {
        const job = journeyFor(initial);
        const saved = clientJourneyStep(job.step, job.flowVersion);
        return saved > 2 && needsWebsiteIntroduction(job) && !job.introductionSent && initial.form.status !== 'COMPLETE' ? 2 : saved;
    });
    const [draft, setDraft] = useState<ClientOnboardingDraft>(() => ({ ...initial, journey: { ...journeyFor(initial), flowVersion: 3, step: storedJourneyStep(step) } }));
    const [status, setStatus] = useState('Progress saved');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [scopeAccepted, setScopeAccepted] = useState(initial.scope.confirmed || initial.overrides.includes('scope'));
    const [submitted, setSubmitted] = useState(initial.form.status === 'COMPLETE' && (initial.scope.confirmed || initial.overrides.includes('scope')));
    const rev = useRef(revision);
    const current = useRef(draft);
    const changeId = useRef(0);
    const dirty = useRef(false);
    const consentTouched = useRef(false);
    const receipts = useRef(new Set<string>());
    const queue = useRef<Promise<boolean>>(Promise.resolve(true));
    const heading = useRef<HTMLHeadingElement>(null);
    const introduction = useRef<HTMLDetailsElement>(null);
    const previousStep = useRef(step);
    const j = journeyFor(draft);
    const proof = useMemo(() => proofPreview(draft.form.proof || ''), [draft.form.proof]);
    const needsContact = needsWebsiteIntroduction(j);
    const verified = publishingReady(draft);
    const agreementDone = ['FULLY_SIGNED', 'SIGNED_CLIENT'].includes(draft.agreement.status) || draft.overrides.includes('agreement');
    const paymentDone = draft.payment.status === 'FULLY_PAID' || (draft.payment.structure !== 'FULL' && draft.payment.status === 'DEPOSIT_PAID') || draft.overrides.includes('payment');

    function change(fn: (old: ClientOnboardingDraft) => ClientOnboardingDraft) {
        const next = fn(current.current); current.current = next; changeId.current++; dirty.current = true;
        setDraft(next); setStatus('Unsaved changes'); setSubmitted(false); setError('');
    }
    function field(key: keyof OnboardingData['form'], value: string | boolean) {
        if (key === 'caseStudyConsent') consentTouched.current = true;
        change(old => ({ ...old, form: { ...old.form, [key]: value }, journey: { ...journeyFor(old),
            ...(essentials.some(([k]) => k === key) ? { offerConfirmed: false, offerConfirmedAt: '' } : {}),
            ...(['domainProvider', 'websitePlatform', 'bookingPlatform', 'emailPlatform', 'analyticsPlatform'].includes(key) ? { responsibilityConfirmed: false, verifiedAt: '' } : {}),
        } }));
    }
    function journey(patch: Partial<typeof j>) {
        change(old => ({ ...old, journey: { ...journeyFor(old), ...patch,
            ...(['websiteManager', 'publisher', 'contactName', 'contactEmail'].some(key => Object.hasOwn(patch, key) && patch[key as keyof typeof patch] !== journeyFor(old)[key as keyof typeof patch]) ? { responsibilityConfirmed: false, verifiedAt: '', introductionSent: false } : {}),
        } }));
    }
    function summary(key: ReviewKey) { return j.reviewSummaries?.[key] ?? reviewSummary(draft.form[key] || '', key); }
    function updateSummary(key: ReviewKey, value: string) { journey({ reviewSummaries: { ...journeyFor(current.current).reviewSummaries, [key]: value } }); }
    function persist(snapshot = current.current, options: { confirmOffer?: boolean; complete?: boolean; confirmScope?: boolean } = {}): Promise<boolean> {
        const id = changeId.current;
        const received = [...receipts.current];
        const next = queue.current.then(async () => {
            setStatus('Saving…'); setError('');
            const form = new FormData();
            form.set('token', token); form.set('guidedVersion', '1'); form.set('revision', String(rev.current)); form.set('intent', options.complete ? 'complete' : 'save');
            const editable = ['offerName', 'offer', 'audience', 'customerProblem', 'desiredOutcome', 'differentiation', 'unsuitableClients', 'trafficSources', 'landingPageUrl', 'bookingUrl', 'qualification', 'nurture', 'domainProvider', 'websitePlatform', 'bookingPlatform', 'emailPlatform', 'analyticsPlatform', 'coachBio', 'proof', 'preferences', 'assets'] as const;
            for (const key of editable) if (snapshot.form[key] !== undefined) form.set(key, String(snapshot.form[key] || ''));
            const job = journeyFor(snapshot);
            form.set('journeyPatch', JSON.stringify({ step: job.step, flowVersion: job.flowVersion, reviewSummaries: job.reviewSummaries, websiteManager: job.websiteManager, publisher: job.publisher, contactName: job.contactName, contactEmail: job.contactEmail, introductionMessage: job.introductionMessage, introductionSent: job.introductionSent, requestedChanges: job.requestedChanges }));
            if (received.length) form.set('receivedAccessIds', JSON.stringify(received));
            if (options.confirmOffer) form.set('confirmOffer', 'yes');
            if (options.confirmScope) form.set('confirmScope', 'yes');
            if (options.complete || consentTouched.current) {
                form.set('caseStudyConsentPresent', 'yes'); form.set('caseStudyConsentVersion', CASE_STUDY_CONSENT_VERSION);
                if (snapshot.form.caseStudyConsent) form.set('caseStudyConsent', 'accepted');
            }
            try {
                const result = await save(form);
                if (!result.ok) throw new Error(result.error);
                rev.current = result.revision;
                received.forEach(value => receipts.current.delete(value));
                if (id === changeId.current) { dirty.current = false; setStatus('Progress saved'); } else setStatus('Unsaved changes');
                return true;
            } catch (e) { setError(e instanceof Error ? e.message : 'We couldn’t save your answers. Keep this page open and try again.'); setStatus('Not saved'); return false; }
        });
        queue.current = next; return next;
    }
    useEffect(() => {
        if (!dirty.current || busy) return;
        const timer = setTimeout(() => { void persist(); }, 900);
        return () => clearTimeout(timer);
        // Ordered snapshots and revisions live in refs.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [draft, busy]);
    useEffect(() => {
        const warn = (e: BeforeUnloadEvent) => { if (dirty.current) e.preventDefault(); };
        window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
    }, []);
    useEffect(() => {
        if (previousStep.current === step) return;
        previousStep.current = step; heading.current?.focus({ preventScroll: true }); window.scrollTo({ top: 0, behavior: 'instant' });
    }, [step]);
    useEffect(() => {
        if (error) document.querySelector<HTMLElement>('#onboarding-form [role="alert"]')?.scrollIntoView({ block: 'center' });
    }, [error]);
    async function go(next: number) {
        if (busy) return;
        setError('');
        if (next > step && step === 0 && !essentialsPresent(current.current)) {
            setError('Add the missing offer details before continuing. A short answer is enough.');
            const missing = essentials.find(([key]) => current.current.form[key].trim().length < 3);
            if (missing) document.getElementById(`journey-${missing[0]}`)?.focus();
            return;
        }
        if (next > step && step === 2) {
            const job = journeyFor(current.current);
            if (!job.websiteManager || !job.publisher) { setError('Choose who looks after your website and who should publish the page.'); return; }
            if ((job.websiteManager === 'OTHER' || job.publisher === 'DEVELOPER') && (!job.contactName.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(job.contactEmail))) { setError('Add the name and a valid email for your website contact.'); return; }
            if (needsWebsiteIntroduction(job) && !job.introductionSent) {
                if (introduction.current) introduction.current.open = true;
                setError('Send the introduction email, then tick “I’ve sent the introduction” to continue.');
                return;
            }
        }
        const confirming = step === 0 && next > step;
        const snapshot = { ...current.current, journey: { ...journeyFor(current.current), flowVersion: 3 as const, step: storedJourneyStep(next), ...(confirming ? { offerConfirmed: true, offerConfirmedAt: new Date().toISOString() } : {}) } };
        if (next < step) { change(() => snapshot); setStep(next); return; }
        setBusy(true);
        if (await persist(snapshot, { confirmOffer: confirming })) { current.current = snapshot; setDraft(snapshot); setStep(next); dirty.current = false; }
        setBusy(false);
    }
    async function finish() {
        if (!essentialsPresent(current.current) || !j.offerConfirmed) { setError('Return to Your offer and confirm the details first.'); return; }
        if (needsWebsiteIntroduction(j) && !j.introductionSent) { setError('Go back to Going live and confirm that you’ve sent the introduction email.'); return; }
        if (!scopeAccepted) { setError('Confirm that you’ve reviewed the project scope before submitting.'); return; }
        if (draft.projectType === 'CASE_STUDY' && !draft.form.caseStudyConsent) { setError('Review and accept the case-study permission before submitting.'); return; }
        setBusy(true);
        if (await persist(current.current, { complete: true, confirmScope: scopeAccepted })) { setSubmitted(true); setStatus('Brief submitted'); window.scrollTo({ top: 0, behavior: 'instant' }); }
        setBusy(false);
    }
    function input(key: keyof OnboardingData['form'], label: string, hint?: string, multiline = true) {
        return <WizardField name={key} label={label} hint={hint} value={String(draft.form[key] || '')} multiline={multiline} onChange={v => field(key, v)} />;
    }
    function original(key: ReviewKey, label = 'View original details') {
        return draft.form[key]?.trim() ? <details className="onboarding-source"><summary>{label}<ChevronDown size={14} aria-hidden /></summary><div className="onboarding-original">{draft.form[key]}</div></details> : null;
    }
    const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(j.contactEmail);
    const accessItems = draft.access.filter(item => !item.nonBlocking && !['VERIFIED', 'NOT_NEEDED'].includes(item.status) && (!item.generated || j.publisher === 'COMPEL'));

    return <main className="client-onboarding" data-screen={!briefReady ? 'preparing' : submitted ? 'complete' : step < 0 ? 'welcome' : steps[step]}>
        <div className="onboarding-brand"><CompelLogo /></div>
        {!briefReady ? <section className="onboarding-welcome"><p className="onboarding-kicker">{draft.projectName}</p><h1>We’re preparing<br />your brief.</h1><p>We’ll send you a summary to review as soon as it’s ready.</p><a className="onboarding-text-link" href="mailto:aymen@getcompel.co">Get in touch <ArrowRight size={15} /></a></section>
        : submitted ? <section className="onboarding-welcome onboarding-complete" aria-labelledby="complete-title"><span className="onboarding-complete-mark"><Check size={26} /></span><p className="onboarding-kicker">Brief submitted</p><h1 id="complete-title">You’re all set,<br />{draft.clientName.split(' ')[0]}.</h1><p>Your brief is with us. We’ll review the details and follow up on your publishing setup.</p>{!agreementDone && <p className="onboarding-completion-note">Your agreement is awaiting signature. Contact Aymen to arrange signing.</p>}<a className="btn btn-primary" href={`/portal/${token}/project`}>Open your project <ArrowRight size={17} /></a><button className="onboarding-text-link" onClick={() => { journey({ flowVersion: 3, step: storedJourneyStep(0) }); setStep(0); }}>Review my answers</button></section>
        : step < 0 ? <section className="onboarding-welcome" aria-labelledby="welcome-title"><p className="onboarding-kicker">{draft.projectName}</p><h1 id="welcome-title">Welcome, {draft.clientName.split(' ')[0]}.<br />Let’s make this yours.</h1><p>We’ve prepared your brief. Check the details, arrange your launch, and confirm the plan.</p><button type="button" className="btn btn-primary" disabled={busy} onClick={() => void go(0)}>{busy ? <Loader2 size={17} className="animate-spin" /> : null}Review my brief <ArrowRight size={17} /></button><span className="onboarding-welcome-note">4 short steps. Your progress saves as you go.</span>{error && <p className="onboarding-error" role="alert">{error}</p>}</section>
        : <section className="onboarding-shell" id="onboarding-form" aria-labelledby="journey-title">
            <div className="onboarding-step-meta"><span>Step {step + 1} of {steps.length} <span className="onboarding-meta-separator">/</span> {steps[step]}</span><span className="onboarding-save-status" role="status" aria-live="polite" data-error={status === 'Not saved'}>{status === 'Saving…' ? <Loader2 size={12} className="animate-spin" /> : status === 'Progress saved' ? <Check size={12} /> : null}{status}</span></div>
            <div className="onboarding-step-track" role="progressbar" aria-label="Onboarding steps" aria-valuenow={step + 1} aria-valuemin={0} aria-valuemax={steps.length}>{steps.map((label, i) => <span key={label} data-complete={i <= step} />)}</div>
            <header className="onboarding-step-heading"><h1 id="journey-title" ref={heading} tabIndex={-1}>{titles[step]}</h1><p>{descriptions[step]}</p></header>
            {error && <div className="onboarding-error" role="alert"><p>{error}</p>{status === 'Not saved' && <div className="onboarding-inline-actions"><button className="onboarding-text-link" onClick={() => void persist()}>Retry save</button><button className="onboarding-text-link" onClick={async () => { try { await navigator.clipboard.writeText(JSON.stringify({ form: current.current.form, reviewSummaries: journeyFor(current.current).reviewSummaries, requestedChanges: journeyFor(current.current).requestedChanges }, null, 2)); setStatus('Answers copied'); } catch { setError('Copy is unavailable. Your answers are still on this page.'); } }}>Copy my answers</button></div>}</div>}
            <div className="onboarding-step-body" inert={busy}>
                {step === 0 && <div className="onboarding-review-list">{essentials.map(([key, label]) => <ReviewItem key={key} name={key} label={label} value={draft.form[key]} required multiline={key !== 'offerName'} onChange={v => field(key, v)} />)}</div>}
                {step === 1 && <>
                    <div className="onboarding-review-list">{contextFields.map(([key, label]) => <ReviewItem key={key} name={`summary-${key}`} label={label} value={summary(key)} maxLength={2000} onChange={v => updateSummary(key, v)}>{original(key)}</ReviewItem>)}</div>
                    <ReviewItem name="summary-proof" label="Client experiences & results" value={summary('proof')} maxLength={2000} onChange={v => updateSummary('proof', v)} preview={j.reviewSummaries?.proof === undefined && proof.total > 0 ? <div className="onboarding-proof-preview">{proof.items.map((item, i) => <figure key={i}><blockquote>{item.excerpt}</blockquote>{item.attribution && <figcaption>{item.attribution}</figcaption>}</figure>)}{proof.total > 3 && <p className="onboarding-note">Showing 3 of {proof.total} accounts. All originals are retained.</p>}</div> : undefined}>{original('proof', 'View full testimonials')}</ReviewItem>
                    <details className="onboarding-disclosure"><summary>Audience details <span>Optional</span><ChevronDown size={16} aria-hidden /></summary><div>{(['unsuitableClients', 'trafficSources'] as const).map(key => <ReviewItem key={key} name={`summary-${key}`} label={key === 'unsuitableClients' ? 'Who isn’t this offer right for?' : 'How do people find you?'} value={summary(key)} maxLength={2000} onChange={v => updateSummary(key, v)}>{original(key)}</ReviewItem>)}</div></details>
                    <details className="onboarding-disclosure"><summary>Brand assets & preferences <span>Optional</span><ChevronDown size={16} aria-hidden /></summary><div className="onboarding-fields">{input('assets', 'Logo, photos, or brand documents', 'A shared folder link is enough.', false)}{input('preferences', 'Anything we should keep, change, or avoid?')}{input('landingPageUrl', 'Your current website or page', undefined, false)}</div></details>
                    <details className="onboarding-disclosure"><summary>Anything new or missing? <span>Optional</span><ChevronDown size={16} aria-hidden /></summary><div><WizardField name="requestedChanges" label="What should we know?" hint="For example, a new service or a change in audience." value={j.requestedChanges} onChange={v => journey({ requestedChanges: v })} /></div></details>
                </>}
                {step === 2 && <>
                    <ChoiceGroup name="websiteManager" label="Who looks after your website?" value={j.websiteManager} choices={[['SELF', 'I do'], ['OTHER', 'Someone helps me'], ['UNSURE', 'I’m not sure']]} onChange={value => journey({ websiteManager: value as typeof j.websiteManager, introductionSent: false })} />
                    <div className="onboarding-publishing"><ChoiceGroup name="publisher" label="Who should publish the finished page?" value={j.publisher} choices={[['COMPEL', 'Compel', 'We’ll arrange the access with you.'], ['DEVELOPER', 'My website person', 'We’ll coordinate the handoff together.']]} onChange={value => journey({ publisher: value as typeof j.publisher })} />
                    <div className="onboarding-contact-reveal" data-open={needsContact} inert={!needsContact} aria-hidden={!needsContact}><div className="onboarding-contact-clip"><div className="onboarding-contact"><h2>Your website contact</h2><div className="onboarding-contact-fields"><WizardField name="contactName" label="Their name" value={j.contactName} onChange={contactName => journey({ contactName, introductionMessage: '', introductionSent: false })} multiline={false} /><WizardField name="contactEmail" label="Their email" value={j.contactEmail} onChange={contactEmail => journey({ contactEmail, introductionSent: false })} multiline={false} type="email" /></div><details ref={introduction} className="onboarding-disclosure"><summary>View introduction <ChevronDown size={16} aria-hidden /></summary><div className="onboarding-fields"><WizardField name="introductionMessage" label="Your introduction" value={j.introductionMessage || introductionDraft(draft)} onChange={introductionMessage => journey({ introductionMessage })} /><div className="onboarding-inline-actions"><button type="button" className="btn btn-outline" onClick={async () => { try { await navigator.clipboard.writeText(j.introductionMessage || introductionDraft(draft)); setStatus('Introduction copied'); } catch { setError('Select and copy the introduction above.'); } }}>Copy message</button>{emailValid && <a className="btn btn-outline" href={introductionMailto(draft)}>Open in email <ExternalLink size={14} /></a>}</div><p className="onboarding-note">Check and send the message in your email app. Aymen is copied in.</p><label className="onboarding-check"><input type="checkbox" required={needsContact} checked={j.introductionSent} onChange={e => journey({ introductionSent: e.target.checked })} /><span>I’ve sent the introduction email and copied Aymen.</span></label></div></details></div></div></div></div>
                    {input('bookingUrl', 'Where can people book with you?', 'Your booking link, if you have one.', false)}
                    <details className="onboarding-disclosure"><summary>Booking questions & follow-up <span>Optional</span><ChevronDown size={16} aria-hidden /></summary><div className="onboarding-fields">{input('qualification', 'Questions people answer before booking')}{input('nurture', 'Emails or messages sent after booking')}</div></details>
                    {j.publisher === 'COMPEL' && j.accessNeeds.length > 0 && <details className="onboarding-disclosure"><summary>Your website tools <span>Optional</span><ChevronDown size={16} aria-hidden /></summary><div className="onboarding-fields"><p className="onboarding-note">Share what you know. We can help with the rest.</p>{j.accessNeeds.map(need => { const key = ({ domain: 'domainProvider', website: 'websitePlatform', booking: 'bookingPlatform', email: 'emailPlatform', tracking: 'analyticsPlatform' } as const)[need]; return <div key={need}>{input(key, ({ domain: 'Web address provider', website: 'Website platform', booking: 'Booking tool', email: 'Email tool', tracking: 'Website analytics' } as const)[need], ACCESS_NEEDS[need], false)}</div>; })}</div></details>}
                    {accessItems.length > 0 && <details className="onboarding-disclosure"><summary>Access instructions <span>{accessItems.length}</span><ChevronDown size={16} aria-hidden /></summary><div><ClientAccessRequests items={accessItems} receiptControl={item => item.status !== 'RECEIVED' && <button type="button" className="btn btn-outline" onClick={() => { receipts.current.add(item.id); change(old => ({ ...old, access: old.access.map(a => a.id === item.id ? { ...a, status: 'RECEIVED' } : a) })); }}>I granted this access</button>} /></div></details>}
                    <p className="onboarding-note onboarding-assurance"><Check size={14} aria-hidden />{verified ? 'Publishing setup verified by Compel.' : 'Your page goes live after you approve it. We’ll confirm the setup with you.'}</p>
                </>}
                {step === 3 && <>
                    <section className="onboarding-scope"><h2>What’s included</h2><ScopeLines value={draft.scope.included || draft.agreement.deliverables} empty="We’ll confirm the deliverables with you." /><h2>Outside this scope</h2><ScopeLines value={draft.scope.excluded} empty="We’ll confirm any exclusions with you." /><dl className="onboarding-scope-facts"><div><dt>Target launch</dt><dd>{draft.scope.targetLaunchDate || 'To be agreed together'}</dd></div><div><dt>Approval owner</dt><dd>{draft.scope.approvalOwner || draft.clientName}</dd></div></dl>{draft.scope.revisionProcess && <details className="onboarding-disclosure"><summary>Revisions & approvals<ChevronDown size={16} aria-hidden /></summary><p>{draft.scope.revisionProcess}</p></details>}</section>
                    <section className="onboarding-agreement" id="agreement"><div><h2>Your agreement</h2><p>{draft.overrides.includes('agreement') ? 'Complete' : CLIENT_AGREEMENT_LABELS[draft.agreement.status]}</p></div><a className="btn btn-outline" href={`/portal/${token}/agreement`} target="_blank" rel="noreferrer">Open agreement PDF <ExternalLink size={14} /></a></section>
                    {draft.projectType === 'PAID' && <section className="onboarding-payment" id="payment"><div><h2>Project payment</h2><p>{draft.payment.currency} {draft.payment.price ?? 'Price to be confirmed'}{draft.payment.structure === 'DEPOSIT' && draft.payment.deposit !== null ? ` · ${draft.payment.currency} ${draft.payment.deposit} deposit` : ''}</p><span className="onboarding-note">{CLIENT_PAYMENT_LABELS[draft.payment.status]}</span></div>{draft.payment.link && !paymentDone && <a className="btn btn-outline" href={draft.payment.link} target="_blank" rel="noreferrer">Open secure payment <ExternalLink size={14} /></a>}</section>}
                    <div className="onboarding-consents"><label className="onboarding-check"><input type="checkbox" checked={scopeAccepted} onChange={e => setScopeAccepted(e.target.checked)} /><span>I’ve reviewed and confirm the project scope above.</span></label>{draft.projectType === 'CASE_STUDY' && <label className="onboarding-check"><input type="checkbox" checked={Boolean(draft.form.caseStudyConsent)} onChange={e => field('caseStudyConsent', e.target.checked)} /><span>{CASE_STUDY_CONSENT_TEXT}</span></label>}<p className="onboarding-note">Confirming the scope doesn’t sign your agreement.{!agreementDone ? ' We’ll arrange signing with you.' : ''}</p></div>
                </>}
            </div>
            <div className="onboarding-actions"><button type="button" className="onboarding-back" disabled={busy} onClick={() => void go(step - 1)}><ArrowLeft size={16} />Back</button><button type="button" className="btn btn-primary" disabled={busy} onClick={() => void (step === 3 ? finish() : go(step + 1))}>{busy && <Loader2 size={16} className="animate-spin" />}{step === 0 ? 'Looks right, continue' : step === 2 ? 'Continue to agreement' : step === 3 ? 'Confirm scope & submit' : 'Continue'}{step < 3 && <ArrowRight size={16} />}</button></div>
            <button type="button" className="onboarding-save-later" disabled={busy} onClick={() => void persist()}>Save & finish later</button>
        </section>}
        <footer className="onboarding-footer"><span>Your project, thoughtfully prepared.</span><a href="mailto:aymen@getcompel.co">Questions? Ask Aymen <ArrowRight size={12} /></a></footer>
    </main>;
}

function ReviewItem({ name, label, value, onChange, children, preview, required = false, multiline = true, maxLength = 6000 }: { name: string; label: string; value: string; onChange: (value: string) => void; children?: ReactNode; preview?: ReactNode; required?: boolean; multiline?: boolean; maxLength?: number }) {
    const [editing, setEditing] = useState(false);
    const missing = required && value.trim().length < 3;
    return <section className="onboarding-review-item"><div className="onboarding-review-label"><h2>{label}</h2>{!missing && <button type="button" aria-label={`${editing ? 'Done editing' : 'Edit'} ${label}`} className="onboarding-edit" onClick={() => setEditing(v => !v)}>{editing ? <Check size={13} /> : <Pencil size={12} />}{editing ? 'Done' : value ? 'Edit' : 'Add'}</button>}</div>{editing || missing ? <WizardField name={name} label={label} hideLabel value={value} required={required} maxLength={maxLength} multiline={multiline} onChange={onChange} hint={missing ? 'Add a short answer to complete your offer.' : undefined} /> : preview || <p className={value ? 'onboarding-review-value' : 'onboarding-empty'}>{value || 'No details added yet.'}</p>}{children}</section>;
}
function WizardField({ name, label, value, onChange, hint, multiline = true, required = false, hideLabel = false, maxLength = 20000, type = 'text' }: { name: string; label: string; value: string; onChange: (value: string) => void; hint?: string; multiline?: boolean; required?: boolean; hideLabel?: boolean; maxLength?: number; type?: string }) {
    const id = `journey-${name}`;
    return <div className="onboarding-field"><label className={hideLabel ? 'sr-only' : undefined} htmlFor={id}>{label}{required && !hideLabel && <span> *</span>}</label>{multiline ? <textarea id={id} value={value} onChange={e => onChange(e.target.value)} maxLength={maxLength} required={required} aria-describedby={hint ? `${id}-hint` : undefined} /> : <input id={id} type={type} value={value} onChange={e => onChange(e.target.value)} required={required} maxLength={maxLength} aria-describedby={hint ? `${id}-hint` : undefined} />}{hint && <p id={`${id}-hint`}>{hint}</p>}</div>;
}
function ChoiceGroup({ name, label, value, choices, onChange }: { name: string; label: string; value: string; choices: [string, string, string?][]; onChange: (value: string) => void }) {
    return <fieldset className="onboarding-choice-group"><legend>{label}</legend><div>{choices.map(([key, title, description]) => <label className="onboarding-choice" key={key} data-selected={value === key}><input type="radio" name={name} value={key} checked={value === key} onChange={() => onChange(key)} /><span><strong>{title}</strong>{description && <small>{description}</small>}</span>{value === key && <Check size={16} aria-hidden />}</label>)}</div></fieldset>;
}
function ScopeLines({ value, empty }: { value: string; empty: string }) {
    const lines = value.split(/\n+/).map(line => line.replace(/^\s*[-*•]\s*/, '').trim()).filter(Boolean);
    return lines.length ? <ul>{lines.map((line, i) => <li key={i}>{line}</li>)}</ul> : <p className="onboarding-note">{empty}</p>;
}

