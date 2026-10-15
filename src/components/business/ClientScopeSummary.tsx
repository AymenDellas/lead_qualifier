import type { OnboardingData } from '@/lib/business';

/** The same client-readable scope is shown before the agreement and at confirmation. */
export function ClientScopeSummary({ data }: { data: OnboardingData }) {
    return <div className="space-y-4">
        <div className="grid sm:grid-cols-2 gap-5">
            <div><p className="field-label">Included</p><p className="text-sm text-[var(--text-dim)] whitespace-pre-wrap">{data.scope.included || data.agreement.deliverables || 'Please confirm the deliverables with Compel before signing.'}</p></div>
            <div><p className="field-label">Not included</p><p className="text-sm text-[var(--text-dim)] whitespace-pre-wrap">{data.scope.excluded || 'Please confirm any exclusions with Compel before signing.'}</p></div>
        </div>
        <div><p className="field-label">Before we start</p><p className="text-sm text-[var(--text-dim)] whitespace-pre-wrap">{data.scope.dependencies}</p></div>
    </div>;
}
