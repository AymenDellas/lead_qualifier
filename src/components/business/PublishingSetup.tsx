'use client';
import { ACCESS_NEEDS, journeyFor, publishingReady, type AccessNeed } from '@/lib/onboarding-journey';
import { reconcileOnboardingAccess, type OnboardingData } from '@/lib/business';
import { Field } from './BusinessUi';
import './onboarding-journey.css';
export function PublishingSetup({ data, update }: { data: OnboardingData; update: (fn: (d: OnboardingData) => OnboardingData) => void }) {
    const j = journeyFor(data);
    const change = (patch: Partial<typeof j>) => update(old => {
        const next = { ...old, journey: { ...journeyFor(old), ...patch, responsibilityConfirmed: false, verifiedAt: '' } };
        return { ...next, access: reconcileOnboardingAccess(next) };
    });
    const unverified = data.access.filter(a => a.required && !a.nonBlocking && !['VERIFIED', 'NOT_NEEDED'].includes(a.status));
    return <div className="onboarding-prep">
        <div><h3 className="font-medium">Publishing handoff</h3><p className="text-sm text-[var(--text-dim)] mt-2">Arrange this during onboarding. Publishing happens after client approval. A developer’s contact or an introduction does not confirm the handoff.</p></div>
        <fieldset className="space-y-2"><legend className="field-label">Access this project actually needs</legend>{Object.entries(ACCESS_NEEDS).map(([key, label]) => <label className="flex gap-2 text-sm" key={key}><input type="checkbox" checked={j.accessNeeds.includes(key as AccessNeed)} onChange={e => change({ accessNeeds: e.target.checked ? [...j.accessNeeds, key as AccessNeed] : j.accessNeeds.filter(k => k !== key) })} />{label}</label>)}</fieldset>
        <p className="text-sm text-[var(--text-dim)]">A booking link alone needs no calendar account access. Enable booking access only when changing questions, reminders, or integrations.</p>
        <Field label="Who will publish?" ><select className="field w-full" aria-label="Who will publish?" value={j.publisher} onChange={e => change({ publisher: e.target.value as typeof j.publisher })}><option value="">To be arranged</option><option value="COMPEL">Compel, with the necessary access</option><option value="DEVELOPER">The client’s website contact</option></select></Field>
        <div className="grid sm:grid-cols-2 gap-4"><Field label="Website contact" value={j.contactName} onChange={contactName => change({ contactName })} /><Field label="Contact email" type="email" value={j.contactEmail} onChange={contactEmail => change({ contactEmail })} /></div>
        <p className="text-sm">Introduction: {j.introductionSent ? 'Client reports it has been sent' : 'Not yet reported as sent'}</p>
        <span className={`mark ${publishingReady(data) ? 'mark-ok' : 'mark-warn'}`}>{publishingReady(data) ? 'Publishing arrangement verified' : 'Compel confirmation required'}</span>
        <button className="btn btn-outline" disabled={!j.publisher || (j.publisher === 'DEVELOPER' && (!j.contactEmail || !j.contactName)) || unverified.length > 0} onClick={() => update(old => ({ ...old, journey: { ...journeyFor(old), responsibilityConfirmed: !publishingReady(old), verifiedAt: publishingReady(old) ? '' : new Date().toISOString() } }))}>{publishingReady(data) ? 'Reopen publishing handoff' : 'Confirm responsibility and verify publishing arrangement'}</button>
        {unverified.length > 0 && <p className="text-xs text-[var(--warn)]">Verify or explicitly mark the access items below as not needed before confirming the publishing arrangement.</p>}
        <p className="text-xs text-[var(--text-faint)]">Save onboarding after changes. Only Compel can record this verification.</p>
    </div>;
}
