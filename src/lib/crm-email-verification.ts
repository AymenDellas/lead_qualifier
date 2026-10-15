import type { VerificationResult } from '@/app/actions/email-verifier-actions';

type VerificationLead = {
    id: string;
    email?: string | null;
    email_status?: string | null;
    email_verification_reason?: string | null;
};

export type VerificationBatchReport<T extends VerificationLead = VerificationLead> = {
    updated: T[];
    skipped: { id: string; reason: 'NO_EMAIL' | 'NOT_FOUND' }[];
    failed: { id: string; reason: string }[];
    remainingCredits?: number | null;
    verificationProvider?: string;
    stopRun?: boolean;
};

/** Every requested row gets an outcome; a save failure cannot hide other saved results. */
export async function verifyCrmEmailBatch<T extends VerificationLead>(ids: string[], dependencies: {
    getLeads: (ids: string[]) => Promise<T[]>;
    verify: (emails: { address: string; source: string }[]) => Promise<VerificationResult[]>;
    save: (id: string, result: VerificationResult) => Promise<T>;
}): Promise<VerificationBatchReport<T>> {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length > 100) throw new Error('Verify up to 100 CRM leads at a time');
    const report: VerificationBatchReport<T> = { updated: [], skipped: [], failed: [] };
    if (!uniqueIds.length) return report;
    const byId = new Map((await dependencies.getLeads(uniqueIds)).map(lead => [lead.id, lead]));
    const candidates: T[] = [];
    for (const id of uniqueIds) {
        const lead = byId.get(id);
        if (!lead) report.skipped.push({ id, reason: 'NOT_FOUND' });
        else if (!lead.email?.trim()) report.skipped.push({ id, reason: 'NO_EMAIL' });
        else candidates.push(lead);
    }
    if (!candidates.length) return report;
    const results = await dependencies.verify(candidates.map(lead => ({ address: lead.email!.trim(), source: 'crm' })));
    const balances = results.flatMap(result => result.remainingCredits != null ? [result.remainingCredits] : []);
    report.remainingCredits = balances.length ? Math.min(...balances) : null;
    report.verificationProvider = results.find(result => result.verificationProvider)?.verificationProvider;
    report.stopRun = results.some(result => result.stopRun);
    for (let index = 0; index < candidates.length; index++) {
        const lead = candidates[index];
        const result = results[index];
        if (result?.error) {
            report.failed.push({ id: lead.id, reason: result.error });
            continue;
        }
        if (!result || result.email.toLowerCase().trim() !== lead.email!.toLowerCase().trim()) {
            report.failed.push({ id: lead.id, reason: 'No matching verification result was returned. Retry this lead.' });
            continue;
        }
        try {
            report.updated.push(await dependencies.save(lead.id, result));
        } catch {
            // Do not expose database errors or count a result that was not saved.
            report.failed.push({ id: lead.id, reason: 'Could not save verification, or the email changed during the check. Reload and retry this lead.' });
        }
    }
    return report;
}

export type UnknownCause = 'hostBlocked' | 'senderIdentity' | 'temporary' | 'connection' | 'dns' | 'other';

export function getUnknownCause(reason: string | null | undefined): UnknownCause {
    const text = reason || '';
    if (/spamhaus|blocklist|blacklist|barracuda|abusix|dynamic ip|sending ip|client host.*(?:blocked|rejected)|your ip/i.test(text)) return 'hostBlocked';
    if (/no ptr|ptr record|cannot find your hostname|reverse dns|helo|ehlo|spf|refused our probe/i.test(text)) return 'senderIdentity';
    if (/greylist|graylist|temporar|deferred|try again|rate limit|too many|\b4\d\d\b/i.test(text)) return 'temporary';
    if (/DNS.*(?:timeout|timed out|unavailable|failed)|ENOTFOUND|EAI_AGAIN/i.test(text)) return 'dns';
    if (/transport error|TLS|certificate|timeout|timed out|deadline|connection closed|ECONN/i.test(text)) return 'connection';
    return 'other';
}

export const UNKNOWN_CAUSE_LABELS: Record<UnknownCause, string> = {
    hostBlocked: 'probing IP blocked',
    senderIdentity: 'sender identity refused',
    temporary: 'server deferred the check',
    connection: 'connection or TLS failed',
    dns: 'DNS unavailable',
    other: 'no decisive mailbox reply',
};

export function getUnknownLabel(reason: string | null | undefined): string {
    const cause = getUnknownCause(reason);
    return { hostBlocked: 'IP BLOCKED', senderIdentity: 'SENDER REFUSED', temporary: 'RETRY LATER',
        connection: 'CONNECTION FAILED', dns: 'DNS UNAVAILABLE', other: 'UNKNOWN' }[cause];
}

export type VerificationRun = {
    total: number;
    processed: number;
    valid: number;
    invalid: number;
    risky: number;
    unknown: number;
    noEmail: number;
    missing: number;
    failed: number;
    causes: Record<UnknownCause, number>;
    phase: 'running' | 'complete' | 'stopped';
    remainingCredits?: number | null;
    verificationProvider?: string;
};

export function startVerificationRun(total: number): VerificationRun {
    return { total, processed: 0, valid: 0, invalid: 0, risky: 0, unknown: 0, noEmail: 0, missing: 0,
        failed: 0, causes: { hostBlocked: 0, senderIdentity: 0, temporary: 0, connection: 0, dns: 0, other: 0 }, phase: 'running' };
}

/** Count persisted verdicts, explicit skips and failures separately. */
export function addVerificationBatch(run: VerificationRun, report: VerificationBatchReport): VerificationRun {
    const next = { ...run, causes: { ...run.causes } };
    if (report.verificationProvider) {
        next.verificationProvider = report.verificationProvider;
        // A timed-out response has no balance header; retain the latest known balance.
        if (report.remainingCredits != null || next.remainingCredits == null) next.remainingCredits = report.remainingCredits;
    }
    next.processed += report.updated.length + report.skipped.length + report.failed.length;
    next.noEmail += report.skipped.filter(row => row.reason === 'NO_EMAIL').length;
    next.missing += report.skipped.filter(row => row.reason === 'NOT_FOUND').length;
    next.failed += report.failed.length;
    for (const lead of report.updated) {
        switch (lead.email_status) {
            case 'VALID': next.valid++; break;
            case 'INVALID': next.invalid++; break;
            case 'RISKY': next.risky++; break;
            case 'UNKNOWN': next.unknown++; next.causes[getUnknownCause(lead.email_verification_reason)]++; break;
            default: next.failed++; break;
        }
    }
    return next;
}
