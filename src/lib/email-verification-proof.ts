type StoredProof = {
    email_status?: string | null;
    email_verification_method?: string | null;
    email_verification_score?: number | null;
    email_verified_at?: string | null;
    email_verification_expires_at?: string | null;
};

/** Same freshness gate in the CRM and API; oversized legacy expiries are not proof. */
export function hasFreshEmailVerification(lead: StoredProof, now = Date.now()): boolean {
    const checked = Date.parse(lead.email_verified_at || '');
    const expires = Date.parse(lead.email_verification_expires_at || '');
    return lead.email_status === 'VALID' && ['SMTP_DIRECT', 'QUICKEMAILVERIFICATION'].includes(lead.email_verification_method || '')
        && lead.email_verification_score != null && lead.email_verification_score >= 95
        && Number.isFinite(checked) && checked <= now + 5 * 60000
        && Number.isFinite(expires) && expires > now && expires > checked
        && expires <= checked + 7 * 86400000 + 60000;
}

export function hasExpiredEmailVerification(lead: StoredProof, now = Date.now()): boolean {
    return lead.email_status === 'VALID' && ['SMTP_DIRECT', 'QUICKEMAILVERIFICATION'].includes(lead.email_verification_method || '')
        && Boolean(lead.email_verification_expires_at)
        && Date.parse(lead.email_verification_expires_at!) <= now;
}

// Compatibility for older callers; both trusted verification methods share the same freshness gate.
export const hasFreshSmtpProof = hasFreshEmailVerification;
export const hasExpiredSmtpProof = hasExpiredEmailVerification;
