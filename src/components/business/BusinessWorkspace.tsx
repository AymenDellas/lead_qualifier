'use client';
import { useCallback, useEffect, useState } from 'react';
import { loadBusinessAction } from '@/app/actions/business-actions';
import type { BusinessSnapshot, BusinessView } from '@/lib/business';
import TodayWorkspace from './TodayWorkspace';
import OnboardingWorkspace from './OnboardingWorkspace';
import type { RunAction } from './BusinessUi';

export default function BusinessWorkspace({
    view,
    onNavigate,
    initialProjectId,
}: {
    view: BusinessView;
    onNavigate: (view: BusinessView | 'case-study' | 'discovery' | 'crm') => void;
    initialProjectId?: string;
}) {
    const [snapshot, setSnapshot] = useState<BusinessSnapshot | null>(null);
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');
    const [busy, setBusy] = useState(false);
    const [stale, setStale] = useState(false);
    const [onboardingFocus, setOnboardingFocus] = useState<string | undefined>(initialProjectId);
    const refresh = useCallback(async () => {
        try {
            setError('');
            setSnapshot(await loadBusinessAction());
            setStale(false);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not load the business workspace.');
        }
    }, []);
    useEffect(() => {
        void refresh();
    }, [refresh]);
    const run: RunAction = async (work, success = 'Saved.') => {
        if (stale) {
            setError('Reload saved data before making another change.');
            return null;
        }
        setBusy(true);
        setError('');
        setMessage('');
        try {
            const result = await work();
            try {
                setSnapshot(await loadBusinessAction());
                setMessage(success);
            } catch {
                setStale(true);
                setError(
                    'Your change was saved, but the refreshed data could not be loaded. Reload saved data before editing again.',
                );
            }
            return result;
        } catch (e) {
            setError(
                e instanceof Error ? e.message : 'Could not save. Your changes are still in the editor.',
            );
            return null;
        } finally {
            setBusy(false);
        }
    };
    const openOnboarding = (id: string) => {
        setOnboardingFocus(id);
        onNavigate('onboarding');
    };
    return (
        <div className="space-y-4">
            {error && (
                <div role="alert" className="panel p-4 text-[var(--bad)]">
                    {error}
                    <button className="btn btn-outline ml-3" onClick={() => void refresh()}>
                        Reload saved data
                    </button>
                </div>
            )}
            {message && (
                <p role="status" className="text-[var(--signal)]">
                    {message}
                </p>
            )}
            {!snapshot ? (
                !error && (
                    <p role="status" className="text-[var(--text-dim)]">
                        Loading business workspace…
                    </p>
                )
            ) : (
                <>
                    {view === 'today' && (
                        <TodayWorkspace snapshot={snapshot} onOnboarding={openOnboarding} onNavigate={onNavigate} />
                    )}
                    {view === 'onboarding' && (
                        <OnboardingWorkspace
                            snapshot={snapshot}
                            busy={busy || stale}
                            run={run}
                            focusId={onboardingFocus}
                        />
                    )}
                </>
            )}
        </div>
    );
}
