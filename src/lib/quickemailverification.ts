import 'server-only';
import type { VerificationResult } from '@/app/actions/email-verifier-actions';

export const QEV_PROVIDER = 'QuickEmailVerification';
type Input = string | { address: string; source?: string };
type Payload = Record<string, unknown>;
type Runtime = {
    fetch?: typeof fetch;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
};
const REQUEST_TIMEOUT_MS = 45000;
const BATCH_TIMEOUT_MS = 240000;
const MAX_ATTEMPTS = 2;
const MAX_RETRY_DELAY_MS = 10000;
const flag = (value: unknown): boolean | null => value === true || value === 'true' ? true
    : value === false || value === 'false' ? false : null;
const REASONS: Record<string, string> = {
    accepted_email: 'Mailbox accepted', invalid_email: 'Invalid email syntax', invalid_domain: 'Invalid domain',
    rejected_email: 'Mailbox rejected', no_mx_record: 'Domain has no mail server',
    no_connect: 'Could not connect to the mail server', timeout: 'Mail server timed out',
    unavailable_smtp: 'Mail server unavailable', unexpected_error: 'No decisive mailbox reply',
    temporarily_blocked: 'Mail server temporarily blocked the check', exceeded_storage: 'Mailbox storage is full',
};

export function qevConfigured(): boolean {
    return Boolean(process.env.QUICKEMAILVERIFICATION_API_KEY?.trim());
}

export function readQevCredits(headers: Headers): number | null {
    const value = headers.get('x-qev-remaining-credits');
    return value !== null && /^\d+$/.test(value.trim()) ? Number(value) : null;
}

function failed(email: string, reason: string, credits: number | null, source?: string, stopRun = true): VerificationResult {
    return {
        email, status: 'UNKNOWN', score: 0, method: 'QUICKEMAILVERIFICATION', verificationProvider: QEV_PROVIDER,
        remainingCredits: credits, safeToSend: false, error: reason, stopRun, reason, source,
        checks: { syntax: true, mxRecord: false, disposable: false, roleAccount: false,
            freeProvider: false, smtpValid: null, catchAll: null },
    };
}

/** Provider validity and safe-to-send are different verdicts. Never infer safe from valid. */
export function mapQevResult(email: string, data: Payload, credits: number | null, source?: string): VerificationResult {
    const address = email.trim().toLowerCase();
    const returnedEmail = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
    if (flag(data.success) !== true || returnedEmail !== address || !['valid', 'invalid', 'unknown'].includes(String(data.result))) {
        return failed(address, 'QuickEmailVerification returned no matching verification result. Retry later.', credits, source);
    }
    const disposable = flag(data.disposable), catchAll = flag(data.accept_all), role = flag(data.role);
    const local = address.split('@')[0];
    const system = /^(?:no-?reply|do-?not-?reply|mailer-daemon|postmaster|abuse|bounce|bounces)(?:[.+]|$)/i.test(local);
    const safe = data.result === 'valid' && flag(data.safe_to_send) === true
        && disposable === false && catchAll === false && role === false && !system;
    // A full mailbox can recover; it is not a permanent nonexistent-address verdict.
    const status = safe ? 'VALID' : data.result === 'invalid'
        ? data.reason === 'exceeded_storage' ? 'RISKY' : 'INVALID'
        : data.result === 'valid' ? 'RISKY' : 'UNKNOWN';
    const details = [catchAll === true && 'catch-all domain', disposable === true && 'disposable address',
        role === true && 'role address', system && 'system address',
        data.result === 'valid' && !safe && 'not marked safe to send'].filter(Boolean);
    const checkedAt = new Date().toISOString();
    const reason = REASONS[String(data.reason)] || 'No decisive mailbox reply';
    return {
        email: address, status, score: safe ? 100 : status === 'RISKY' ? 50 : 0,
        provider: typeof data.mx_domain === 'string' ? data.mx_domain : undefined,
        verificationProvider: QEV_PROVIDER, method: 'QUICKEMAILVERIFICATION', safeToSend: safe,
        remainingCredits: credits, checkedAt,
        expiresAt: safe ? new Date(Date.parse(checkedAt) + 7 * 86400000).toISOString() : undefined,
        reason: `${QEV_PROVIDER}: ${safe ? 'Safe to send' : reason}${details.length ? ' · ' + details.join(' · ') : ''}`,
        source,
        checks: {
            syntax: data.reason !== 'invalid_email', mxRecord: Boolean(data.mx_record),
            disposable: disposable === true, roleAccount: role === true, freeProvider: flag(data.free) === true,
            systemAddress: system, smtpValid: data.result === 'valid' ? true : data.reason === 'rejected_email' ? false : null,
            catchAll, smtpAttempted: false,
            dnsStatus: ['invalid_domain', 'no_mx_record'].includes(String(data.reason)) ? 'NO_MAIL' : undefined,
        },
    };
}

function retryDelay(headers: Headers, now: number): number {
    const value = headers.get('retry-after');
    if (!value) return 1000;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, date - now) : 1000;
}

async function checkAddress(email: string, context: {
    request: typeof fetch; now: () => number; sleep: (ms: number) => Promise<void>;
    deadline: number; stopped: () => VerificationResult | undefined;
}): Promise<VerificationResult> {
    const key = process.env.QUICKEMAILVERIFICATION_API_KEY?.trim();
    if (!key) return failed(email, 'QuickEmailVerification is not configured on the server.', null);
    let credits: number | null = null;
    const url = new URL('https://api.quickemailverification.com/v1/verify');
    url.searchParams.set('apikey', key);
    url.searchParams.set('email', email);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const stopped = context.stopped();
        if (stopped) return failed(email, stopped.reason, credits);
        const remaining = context.deadline - context.now();
        if (remaining <= 0) return failed(email, `${QEV_PROVIDER}: This batch reached its time limit. Retry the unfinished rows.`, credits);
        let delay = 1000;
        let failure: VerificationResult;
        try {
            // All requests stay on the server. Never log this URL: it contains the API key.
            const response = await context.request(url, { cache: 'no-store',
                signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remaining)) });
            credits = readQevCredits(response.headers) ?? credits;
            if (!response.ok) {
                const message = response.status === 401 ? 'API key was rejected. Check the server configuration.'
                    : response.status === 403 ? 'Account access was refused. Check your provider account and allowed IP settings.'
                    : response.status === 402 ? 'No verification credits available. Top up or wait for the daily reset.'
                    : response.status === 429 ? 'API rate limit reached. Wait briefly before retrying.'
                    : `Provider request failed (HTTP ${response.status}). Retry later.`;
                const transient = response.status === 408 || response.status === 429 || response.status >= 500;
                failure = failed(email, `${QEV_PROVIDER}: ${message}`, credits, undefined,
                    !transient || response.status === 429);
                await response.body?.cancel().catch(() => {});
                if (!transient) return failure;
                delay = retryDelay(response.headers, context.now());
                // Respect long provider cooldowns rather than retrying early or exhausting the function.
                if (delay > MAX_RETRY_DELAY_MS) return { ...failure, stopRun: true };
            } else {
                const data = await response.json() as Payload;
                if (flag(data.success) !== true) {
                    const exhausted = credits === 0 || /credit|quota|balance|limit/i.test(String(data.message));
                    return failed(email, exhausted ? `${QEV_PROVIDER}: No verification credits available. Top up or wait for the daily reset.`
                        : `${QEV_PROVIDER}: The request was rejected. Check your API key and account.`, credits);
                }
                return mapQevResult(email, data, credits);
            }
        } catch {
            // Transport errors are not mailbox verdicts. Never expose secret-bearing fetch errors.
            failure = failed(email, `${QEV_PROVIDER}: This email's check timed out or the service was unavailable. Retry this row.`, credits, undefined, false);
        }
        if (attempt + 1 === MAX_ATTEMPTS) return failure;
        if (context.now() + delay >= context.deadline) return { ...failure, stopRun: true };
        await context.sleep(delay);
    }
    throw new Error('Verification attempt limit exceeded');
}

/** Two requests at a time; duplicates consume one check and retain their original order. */
export async function verifyQevBatch(inputs: Input[], runtime: Runtime = {}): Promise<VerificationResult[]> {
    const items = inputs.map(input => typeof input === 'string' ? { address: input } : input);
    const addresses = [...new Set(items.map(item => item.address.trim().toLowerCase()))];
    const results = new Map<string, VerificationResult>();
    let cursor = 0;
    let failure: VerificationResult | undefined;
    let consecutiveFailures = 0;
    const now = runtime.now || Date.now;
    const context = { request: runtime.fetch || fetch, now,
        sleep: runtime.sleep || ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))),
        deadline: now() + BATCH_TIMEOUT_MS, stopped: () => failure };
    async function consume() {
        while (cursor < addresses.length && !failure) {
            const email = addresses[cursor++];
            const result = await checkAddress(email, context);
            if (result.error) consecutiveFailures++;
            else consecutiveFailures = 0;
            // One slow address must not stop an entire list. Repeated request failures
            // indicate a broader outage and pause new calls to avoid wasting credits.
            if (!result.stopRun && consecutiveFailures >= 3) {
                result.stopRun = true;
                result.error = result.reason = `${QEV_PROVIDER}: Several checks failed after retrying. The run is paused; retry the unfinished rows later.`;
            }
            results.set(email, result);
            if (result.stopRun) failure = result;
        }
    }
    await Promise.all([consume(), consume()]);
    const balances = [...results.values()].flatMap(result => result.remainingCredits != null ? [result.remainingCredits] : []);
    const remainingCredits = balances.length ? Math.min(...balances) : null;
    return items.map(item => {
        const email = item.address.trim().toLowerCase();
        const result = results.get(email) || failed(email, failure?.reason || `${QEV_PROVIDER}: Check was not completed.`, remainingCredits);
        return { ...result, remainingCredits, source: item.source };
    });
}
