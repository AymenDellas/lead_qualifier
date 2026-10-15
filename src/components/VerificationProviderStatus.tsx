'use client';
import { useEffect, useState } from 'react';
import { getVerificationReadiness } from '@/app/actions/email-verifier-actions';

export default function VerificationProviderStatus({ remainingCredits, provider }: {
    remainingCredits?: number | null; provider?: string;
}) {
    const [configuredProvider, setConfiguredProvider] = useState<string>();
    useEffect(() => {
        let active = true;
        getVerificationReadiness().then(value => { if (active) setConfiguredProvider(value.provider); }).catch(() => {});
        return () => { active = false; };
    }, []);
    const name = provider || configuredProvider;
    if (!name) return null;
    return <span className="text-[12px] text-[var(--text-dim)]">
        {name}{name === 'QuickEmailVerification' && <> · {remainingCredits === undefined ? 'Credits shown after verification'
            : remainingCredits === null ? 'Credit balance unavailable' : `${remainingCredits.toLocaleString()} credits remaining`}</>}
    </span>;
}
