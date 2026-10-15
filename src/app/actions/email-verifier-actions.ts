"use server";
import { qevConfigured, verifyQevBatch, QEV_PROVIDER } from '@/lib/quickemailverification';

import dns from "dns";
import { resolveMailDomain } from '@/lib/email-dns';
import { runSmtpProbe, type SmtpResult, type RejectKind } from '@/lib/email-smtp';
import { randomBytes } from "crypto";
import { DISPOSABLE_DOMAINS, ROLE_ACCOUNTS, FREE_PROVIDERS } from "@/lib/email-constants";

// ── Configuration ──
// QuickEmailVerification is primary when configured; direct SMTP remains a local fallback.
// Use a real hostname and sender address that your server owns. The defaults
// preserve the existing Revlane deployment but can be overridden per runtime.
const SMTP_HELO = process.env.EMAIL_VERIFY_HELO || "verify.revlane.io";
const SMTP_MAIL_FROM = process.env.EMAIL_VERIFY_MAIL_FROM || "verify@revlane.io";
const VALID_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 5_000;

// ── SMTP pacing ──
// Probing is only diagnostic, but sustained bursts from one IP are what gets a
// sending host onto a provider blocklist — and a blocklisted host fails *quietly*
// (every mailbox starts looking rejected) rather than loudly. These two limits
// keep throughput well under the thresholds that trigger anti-abuse controls.
function boundedSetting(value: string | undefined, fallback: number, min: number, max: number) {
    const parsed = Number(value);
    return value && Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.floor(parsed))) : fallback;
}
const SMTP_GLOBAL_CONCURRENCY = boundedSetting(process.env.EMAIL_VERIFY_CONCURRENCY, 4, 1, 8);
const SMTP_MIN_HOST_INTERVAL_MS = boundedSetting(process.env.EMAIL_VERIFY_HOST_INTERVAL_MS, 2000, 0, 60000);

/**
 * Local-parts that are never a person and never worth sending to, even when the
 * mailbox demonstrably exists. Distinct from ROLE_ACCOUNTS: a solo operator's
 * hello@/info@/contact@ address usually *is* their real monitored inbox, so those
 * are penalised in scoring but no longer disqualified from VALID.
 */
const SYSTEM_ADDRESSES = new Set([
    "noreply", "no-reply", "donotreply", "do-not-reply", "mailer-daemon", "mailer",
    "postmaster", "hostmaster", "webmaster", "abuse", "root", "www", "ftp", "mail",
    "smtp", "imap", "pop", "newsletter", "notifications", "alerts", "updates",
    "bounce", "bounces", "spam", "security", "compliance",
]);

function isSystemAddress(local: string): boolean {
    return SYSTEM_ADDRESSES.has(local) || [...SYSTEM_ADDRESSES].some(s => local.startsWith(s + "."));
}

// ── Runtime state ──
type TimedValue<T> = { value: T; expiresAt: number };
const mxCache = new Map<string, TimedValue<dns.MxRecord[]>>();

/**
 * MX hosts that have refused *this sending host* on reputation grounds.
 *
 * A refusal like `550 5.7.1 Client host [x] blocked using Spamhaus` is a verdict
 * about our IP, so it is identical for every address behind that MX. Without this
 * cache, re-verifying 215 Microsoft-hosted leads opens 215 connections that are
 * each guaranteed to be refused, and burns a 30s timeout on many of them — the
 * run takes hours and ends exactly where it started.
 *
 * The TTL is deliberately much shorter than the MX/catch-all caches: a
 * reputation listing can lift, and a dynamic IP can be reassigned, so this is
 * "don't retry this host for a while", never "this host is permanently closed".
 */
const hostBlockCache = new Map<string, TimedValue<{ code: number; text: string }>>();
const HOST_BLOCK_TTL_MS = 30 * 60 * 1000;

/**
 * Phrases that make a policy refusal specifically about *who is connecting*
 * rather than about this transaction. Only these are worth caching per host —
 * "relay access denied" or a rate limit can differ by recipient or by minute.
 */
const REPUTATION_BLOCK_PHRASES = [
    "spamhaus", "blocklist", "blacklist", "rbl", "dnsbl", "barracuda",
    "spamcop", "sorbs", "uceprotect", "reputation", "poor reputation",
    "client host rejected", "client host [", "blocked using", "listed by",
    "your ip", "sending ip", "bad reputation",
];

function isReputationBlock(text: string): boolean {
    const body = text.toLowerCase();
    return REPUTATION_BLOCK_PHRASES.some(phrase => {
        if (phrase.endsWith('[')) return body.includes(phrase);
        const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp('\\b' + escaped + '\\b').test(body);
    });
}

function rememberHostBlock(host: string, code: number, text: string): void {
    if (hostBlockCache.size >= MAX_CACHE_ENTRIES) {
        hostBlockCache.delete(hostBlockCache.keys().next().value as string);
    }
    hostBlockCache.set(host, { value: { code, text }, expiresAt: Date.now() + HOST_BLOCK_TTL_MS });
    console.warn(`[VERIFIER] ${host} refused this sending host (${code}: ${text}) — skipping it for 30 minutes.`);
}

/** Reports which MX hosts are currently refusing this sender, for the UI/diagnostics. */
export async function getBlockedHosts(): Promise<{ host: string; code: number; text: string }[]> {
    const now = Date.now();
    return [...hostBlockCache.entries()]
        .filter(([, v]) => v.expiresAt > now)
        .map(([host, v]) => ({ host, code: v.value.code, text: v.value.text }));
}

/**
 * Compresses a multi-line SMTP reply into one short clause worth storing.
 * Keeps the human-meaningful part ("blocked using Spamhaus") and drops the
 * server-id noise that makes every reply unique and ungroupable.
 */
function summariseReply(text: string): string {
    return text
        .split(/\r?\n/)[0]
        .replace(/^\d{3}[ -]/, "")
        .replace(/\b\d\.\d{1,3}\.\d{1,3}\b/, "")
        .replace(/\[[^\]]*\]/g, "")
        .replace(/https?:\/\/\S+/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120);
}

/** Rolling counter so a blocklisted sending IP surfaces instead of failing silently. */
const blockSignal = { policyRejects: 0, decisiveAnswers: 0 };

// ── Types ──

export type EmailCheckResults = {
    syntax: boolean;
    mxRecord: boolean;
    disposable: boolean;
    roleAccount: boolean;
    freeProvider: boolean;
    smtpValid: boolean | null;
    catchAll: boolean | null;
    /** noreply@, postmaster@ and friends — a real mailbox, but never a person. */
    systemAddress?: boolean;
    smtpAttempted?: boolean;
    probeDetail?: string;
    dnsStatus?: 'OK' | 'NO_MAIL' | 'TEMP_ERROR';
    /** The recipient server refused us (IP/HELO/rate), not the mailbox. */
    policyBlocked?: boolean;
    /**
     * The refusal verbatim, so a stuck lead explains itself in the CRM.
     *
     * Without this, every unverifiable address reads "Server refused our probe"
     * and a reputation block is indistinguishable from a timeout — which is
     * exactly the state that made 388 UNKNOWN leads impossible to triage without
     * running a separate live probe by hand. The code and one clause of the
     * server's own text are enough to tell those apart at a glance.
     */
    refusalCode?: number;
    refusalText?: string;
};

export type VerificationResult = {
    email: string;
    status: "VALID" | "INVALID" | "RISKY" | "UNKNOWN";
    score: number;
    checks: EmailCheckResults;
    reason: string;
    provider?: string;
    method?: "SMTP_DIRECT" | "DNS_PREFILTER" | "LOCAL_PREFILTER" | "QUICKEMAILVERIFICATION";
    verificationProvider?: string;
    safeToSend?: boolean;
    remainingCredits?: number | null;
    /** Request failures are not mailbox verdicts and must not overwrite CRM results. */
    error?: string;
    stopRun?: boolean;
    checkedAt?: string;
    expiresAt?: string;
    source?: string;
};

/** Configuration readiness does not claim network reachability or reputation. */
export async function getVerificationReadiness() {
    if (qevConfigured()) return {
        ready: true, selfHostedReady: false, provider: QEV_PROVIDER,
        message: 'QuickEmailVerification is configured. Credits appear after each verification batch.',
    };
    const identityValid = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(SMTP_HELO)
        && isValidSyntax(SMTP_MAIL_FROM.toLowerCase());
    return {
        ready: identityValid,
        provider: 'Direct SMTP',
        selfHostedReady: identityValid,
        message: identityValid
            ? `Direct SMTP is configured (EHLO ${SMTP_HELO}); connectivity and sender reputation require the SMTP diagnostic.`
            : 'Set a valid EMAIL_VERIFY_HELO hostname and EMAIL_VERIFY_MAIL_FROM address.',
    };
}

/** Uses the production transport and records its dialogue without writing CRM data. */
export async function getSmtpDiagnostic(email: string, helo = SMTP_HELO, mailFrom = SMTP_MAIL_FROM) {
    const address = email.toLowerCase().trim();
    if (!isValidSyntax(address) || /[\r\n<>]/.test(helo + mailFrom)) throw new Error('Invalid diagnostic identity or recipient');
    const domain = address.split('@')[1];
    const destination = await resolveMailDomain(domain);
    if (destination.status !== 'OK') return { destination, dialogue: [], verdict: 'INCONCLUSIVE — ' + destination.reason };
    const host = destination.records[0].exchange;
    const control = probeAddress(domain);
    const dialogue: { command: string; reply: string; code: number }[] = [];
    const answers = await withSmtpSlot(host, () => runSmtpProbe({
        host, helo, mailFrom, emails: [address], control, timeoutMs: 30000,
        classify: classifyReject, reject: rejectToResult, summarize: summariseReply,
        noteHostBlock: (code, text) => {
            if (code < 400 || !isReputationBlock(text) || classifyReject(code, text) === 'MAILBOX_UNKNOWN') return false;
            rememberHostBlock(host, code, summariseReply(text)); return true;
        },
        onReply: (command, reply) => dialogue.push({ command, reply: reply.text, code: reply.code }),
    }));
    const result = answers.get(address)!;
    const verdict = result.valid === true && result.catchAll === false
        ? 'WORKING — real recipient accepted and randomized recipient explicitly rejected at mailbox level.'
        : result.valid === true && result.catchAll === true
            ? 'ACCEPTS RANDOM RECIPIENTS — this SMTP dialogue cannot prove individual mailbox existence.'
            : result.blocked ? 'HOST REFUSED — the server refused the probing sender; the mailbox remains unconfirmed.'
                : result.valid === false ? 'RECIPIENT REJECTED — confirm that the diagnostic address really exists.'
                    : 'INCONCLUSIVE — ' + (result.text || result.message || 'no decisive response');
    return { destination, mx: host, address, randomControl: control, dialogue, result, verdict };
}

function cacheSet<T>(cache: Map<string, TimedValue<T>>, key: string, value: T) {
    if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
    cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function cacheGet<T>(cache: Map<string, TimedValue<T>>, key: string): T | undefined {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
        cache.delete(key);
        return undefined;
    }
    return entry.value;
}

// ────────────────────────────────────────────────────────
// ── SMTP pacing scheduler ──
// ────────────────────────────────────────────────────────

const sleepMs = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

let activeSmtpConnections = 0;
const globalSlotWaiters: (() => void)[] = [];

async function acquireGlobalSlot(): Promise<void> {
    while (activeSmtpConnections >= SMTP_GLOBAL_CONCURRENCY) {
        await new Promise<void>(r => globalSlotWaiters.push(r));
    }
    activeSmtpConnections++;
}

function releaseGlobalSlot(): void {
    activeSmtpConnections = Math.max(0, activeSmtpConnections - 1);
    globalSlotWaiters.shift()?.();
}

/** Serialises connections per MX host and enforces a minimum gap between them. */
const hostChains = new Map<string, Promise<void>>();
const hostLastUsedAt = new Map<string, number>();

function withSmtpSlot<T>(host: string, fn: () => Promise<T>): Promise<T> {
    if (hostLastUsedAt.size > 500) {
        // These entries are settled promises once a host goes quiet; drop the
        // oldest so a long run over many domains can't grow the map unbounded.
        for (const key of [...hostLastUsedAt.keys()].filter(key => !hostChains.has(key)).slice(0, 250)) {
            hostLastUsedAt.delete(key);
        }
    }

    const previous = hostChains.get(host) ?? Promise.resolve();
    let releaseChain!: () => void;
    const chainGate = new Promise<void>(r => { releaseChain = r; });
    const current = previous.then(() => chainGate);
    hostChains.set(host, current);

    return previous.then(async () => {
        const sinceLast = Date.now() - (hostLastUsedAt.get(host) ?? 0);
        if (sinceLast < SMTP_MIN_HOST_INTERVAL_MS) await sleepMs(SMTP_MIN_HOST_INTERVAL_MS - sinceLast);

        await acquireGlobalSlot();
        try {
            return await fn();
        } finally {
            hostLastUsedAt.set(host, Date.now());
            releaseGlobalSlot();
            releaseChain();
            if (hostChains.get(host) === current) hostChains.delete(host);
        }
    });
}

/**
 * Copies an SMTP verdict onto the check record.
 *
 * One helper rather than five copies of the same four assignments: the batch
 * path alone applies a result in four places (first pass, greylist retry and its
 * failure branch, timeout retry), and each copy is an opportunity for one of
 * them to quietly stop carrying a field — which is how the refusal text would go
 * missing from exactly the paths that produce the most UNKNOWNs.
 */
function applySmtpResult(checks: EmailCheckResults, smtp: SmtpResult): void {
    checks.smtpValid = smtp.valid;
    checks.catchAll = smtp.catchAll;
    checks.policyBlocked = smtp.blocked === true;
    checks.smtpAttempted = true;
    checks.probeDetail = smtp.valid === null || smtp.catchAll === null ? smtp.message : undefined;
    checks.refusalCode = smtp.valid === null || smtp.catchAll === null ? smtp.code : undefined;
    checks.refusalText = smtp.text;
}

export async function verifyEmail(email: string, source?: string): Promise<VerificationResult> {
    if (qevConfigured()) return (await verifyQevBatch([{ address: email, source }]))[0];
    const e = email.toLowerCase().trim();

    const checks: EmailCheckResults = {
        syntax: false, mxRecord: false, disposable: false,
        roleAccount: false, freeProvider: false,
        smtpValid: null, catchAll: null,
    };

    // ── Layer 1: Syntax ──
    checks.syntax = isValidSyntax(e);
    if (!checks.syntax) {
        return buildResult(e, checks, "INVALID", 0, "Invalid email syntax");
    }

    const [local, domain] = e.split("@");
    checks.disposable = DISPOSABLE_DOMAINS.has(domain) || DISPOSABLE_DOMAINS.has(domain.replace(/^.*\./, ""));
    checks.roleAccount = ROLE_ACCOUNTS.some((r) => local === r || local.startsWith(r + ".") || local.startsWith(r + "+"));
    checks.systemAddress = isSystemAddress(local);
    checks.freeProvider = FREE_PROVIDERS.has(domain);

    // ── Layer 2: MX Lookup ──
    const dnsResult = await resolveMailDomain(domain);
    checks.dnsStatus = dnsResult.status;
    const mxResult = dnsResult.records;
    if (dnsResult.status === 'OK') cacheSet(mxCache, domain, mxResult);
    checks.mxRecord = mxResult.length > 0;

    if (!checks.mxRecord) {
        return buildResult(e, checks, dnsResult.status === 'TEMP_ERROR' ? 'UNKNOWN' : 'INVALID', 5, dnsResult.reason);
    }

    if (checks.disposable) {
        return buildResult(e, checks, "RISKY", 25, "Disposable/temporary email domain detected");
    }

    // ── Layer 3: Direct SMTP recipient + randomized catch-all test ──
    // There is intentionally no API or DNS-only fallback. If the recipient
    // server does not provide decisive evidence, the address remains UNKNOWN.
    const smtpResult = await smtpVerifyAcrossMx(e, mxResult, domain);
    applySmtpResult(checks, smtpResult);

    return await buildFinalResult(e, checks, domain, source);
}

// ────────────────────────────────────────────────────────
// ── HIGH-PERFORMANCE BATCH VERIFICATION ──
// ────────────────────────────────────────────────────────

export async function verifyEmailBatchFast(
    emails: (string | { address: string, source?: string })[]
): Promise<VerificationResult[]> {
    if (emails.length > 100) throw new Error("A verification request may contain at most 100 emails");
    if (qevConfigured()) return verifyQevBatch(emails);
    const results: VerificationResult[] = new Array(emails.length);

    // ── Phase 1: Pre-filter ──
    type PreFiltered = {
        email: string; index: number; domain: string; local: string;
        checks: EmailCheckResults;
        source?: string;
    };

    const candidates: PreFiltered[] = [];

    for (let i = 0; i < emails.length; i++) {
        const itemObj = typeof emails[i] === 'string' ? { address: emails[i] as string } : emails[i] as { address: string, source?: string };
        const e = itemObj.address.toLowerCase().trim();
        const source = itemObj.source;
        const checks: EmailCheckResults = {
            syntax: false, mxRecord: false, disposable: false,
            roleAccount: false, freeProvider: false,
            smtpValid: null, catchAll: null,
        };

        checks.syntax = isValidSyntax(e);
        if (!checks.syntax) {
            results[i] = buildResult(typeof emails[i] === "string" ? emails[i] as string : (emails[i] as any).address, checks, "INVALID", 0, "Invalid email syntax");
            continue;
        }

        const [local, domain] = e.split("@");
        checks.disposable = DISPOSABLE_DOMAINS.has(domain) || DISPOSABLE_DOMAINS.has(domain.replace(/^.*\./, ""));
        checks.roleAccount = ROLE_ACCOUNTS.some(r => local === r || local.startsWith(r + ".") || local.startsWith(r + "+"));
        checks.systemAddress = isSystemAddress(local);
        checks.freeProvider = FREE_PROVIDERS.has(domain);

        candidates.push({ email: e, index: i, domain, local, checks, source });
    }

    console.log(`[BATCH] ${emails.length} emails → ${candidates.length} passed syntax check`);

    // ── Phase 2: MX Resolution ──
    const uniqueDomains = [...new Set(candidates.map(p => p.domain))];
    const domainResults = new Map(await Promise.all(uniqueDomains.map(async domain => {
        const answer = await resolveMailDomain(domain);
        if (answer.status === 'OK') cacheSet(mxCache, domain, answer.records);
        return [domain, answer] as const;
    })));

    // ── Phase 3: Filter by MX & disposable ──
    const verified: PreFiltered[] = [];

    for (const item of candidates) {
        const answer = domainResults.get(item.domain)!;
        item.checks.dnsStatus = answer.status;
        const mx = answer.records;
        item.checks.mxRecord = mx.length > 0;

        if (!item.checks.mxRecord) {
            results[item.index] = buildResult(item.email, item.checks, answer.status === 'TEMP_ERROR' ? 'UNKNOWN' : 'INVALID', 5, answer.reason);
            continue;
        }

        if (item.checks.disposable) {
            results[item.index] = buildResult(item.email, item.checks, "RISKY", 25, "Disposable/temporary email domain detected");
            continue;
        }

        verified.push(item);
    }

    console.log(`[BATCH] ${verified.length} emails need direct SMTP verification`);

    // ── Phase 4: Direct SMTP only ──
    await batchSmtpVerify(verified, results);

    // ── Phase 5: Safety net ──
    for (let i = 0; i < results.length; i++) {
        if (!results[i]) {
            results[i] = {
                email: typeof emails[i] === 'string' ? (emails[i] as string) : (emails[i] as any).address, status: "UNKNOWN", score: 0,
                checks: { syntax: false, mxRecord: false, disposable: false, roleAccount: false, freeProvider: false, smtpValid: null, catchAll: null },
                reason: "Verification incomplete",
            };
        }
    }

    const valid = results.filter(r => r.status === "VALID").length;
    const invalid = results.filter(r => r.status === "INVALID").length;
    const risky = results.filter(r => r.status === "RISKY").length;
    const unknown = results.filter(r => r.status === "UNKNOWN").length;
    console.log(`[BATCH] ✅ Complete: ${valid} valid, ${invalid} invalid, ${risky} risky, ${unknown} unknown`);

    return results;
}

// ────────────────────────────────────────────────────────
// ── Batch Strategies ──
// ────────────────────────────────────────────────────────

type PreFiltered = {
        email: string; index: number; domain: string; local: string;
        checks: EmailCheckResults;
        source?: string;
    };

async function batchSmtpVerify(items: PreFiltered[], results: VerificationResult[]) {
    const groups = new Map<string, PreFiltered[]>();
    for (const item of items) groups.set(item.domain, [...(groups.get(item.domain) || []), item]);
    const entries = [...groups.entries()];
    for (let i = 0; i < entries.length; i += 3) {
        await Promise.all(entries.slice(i, i + 3).map(async ([domain, domainItems]) => {
            const mx = (cacheGet(mxCache, domain) || []).slice(0, 3);
            const best = new Map<string, SmtpResult>();
            const final = (result?: SmtpResult) => result && (result.valid === false || (result.valid === true && result.catchAll !== null));
            const merge = (answers: Map<string, SmtpResult>) => {
                for (const [email, answer] of answers) {
                    const previous = best.get(email);
                    if (!previous || evidenceRank(answer) > evidenceRank(previous) ||
                        (evidenceRank(answer) === evidenceRank(previous) && !previous.text && answer.text)) best.set(email, answer);
                }
            };
            const attempt = async (host: dns.MxRecord, selected: PreFiltered[], extended = false) => {
                if (!selected.length) return;
                try { merge(await (extended ? smtpVerifyBatchExtended : smtpVerifyBatch)(selected.map(item => item.email), host, domain)); }
                catch (error) {
                    merge(new Map(selected.map(item => [item.email, { valid: null, catchAll: null,
                        message: 'SMTP attempt failed', text: (error as Error).message }])));
                }
            };
            // Decide per address. One accepted recipient must not stop the rest.
            for (const host of mx) await attempt(host, domainItems.filter(item => !final(best.get(item.email))));
            const greylisted = domainItems.filter(item => best.get(item.email)?.message === 'GREYLISTED');
            if (greylisted.length && mx.length) {
                await sleepMs(boundedSetting(process.env.EMAIL_VERIFY_GREYLIST_WAIT_MS, 90000, 5000, 300000));
                for (const host of mx) await attempt(host, greylisted.filter(item => !final(best.get(item.email))));
            }
            // Refusals and rate limits need a later run, not a longer socket timeout.
            for (const host of mx.slice(0, 2)) {
                const unanswered = domainItems.filter(item => {
                    const answer = best.get(item.email);
                    return !answer || (answer.valid === null && !answer.blocked && !answer.rejectKind);
                });
                await attempt(host, unanswered, true);
            }
            for (const item of domainItems) {
                applySmtpResult(item.checks, best.get(item.email) || { valid: null, catchAll: null, text: 'No SMTP response' });
                results[item.index] = await buildFinalResult(item.email, item.checks, domain, item.source);
            }
        }));
        console.log('[BATCH SMTP] Domain batch ' + Math.min(i + 3, entries.length) + '/' + entries.length);
    }
}

// ────────────────────────────────────────────────────────
// ── SMTP Engine (used when port 25 is open) ──
// ────────────────────────────────────────────────────────

/**
 * Why a recipient was refused. The distinction matters more than anything else
 * in this file: a mailbox that does not exist is a verdict about the *lead*,
 * while a policy refusal is a verdict about *us* (our IP, HELO, or rate). Both
 * arrive as a 5xx, and conflating them means a blocklisted sending host silently
 * marks every good lead as dead.
 */


const MAILBOX_UNKNOWN_PHRASES = [
    "user unknown", "unknown user", "no such user", "user not found",
    "recipient not found", "no such recipient", "invalid recipient",
    "unrouteable address", "unrouteable",
    "does not exist", "doesn't exist", "no mailbox", "mailbox not found",
    "address unknown", "unknown address",
    "not our customer", "invalid mailbox", "no such address",
];

/**
 * Refusals that mean "not now", not "not ever".
 *
 * These must be tested before the policy phrases, because greylisters phrase their
 * deferral in words that look hostile — "not yet authorized to deliver mail",
 * "temporarily deferred", "try again later". Reading those as a policy block is
 * doubly wrong: the address never gets its retry, so a perfectly verifiable mailbox
 * ends up UNKNOWN, *and* every deferral is counted as evidence that this host is
 * being refused — which is what makes `blockSignal` scream that verification is
 * broken when the servers are merely asking us to come back in a few minutes.
 */
const TRANSIENT_PHRASES = [
    "greylist", "grey-list", "graylist", "gray-list",
    "not yet authorized", "not yet authorised", "try again", "try later",
    "temporarily deferred", "temporary failure", "temporarily unavailable",
    "temporarily rejected", "please retry", "come back later",
    "rate limit", "too many", "throttl", "service unavailable",
    "resources temporarily", "deferred",
];

const POLICY_BLOCK_PHRASES = [
    "blocked", "blacklist", "blocklist", "denied", "not allowed", "policy",
    "reputation", "spam", "rbl", "dnsbl",
    "spamhaus", "barracuda", "banned", "client host rejected", "unauthenticated",
    "authentication required", "not permitted", "refused", "access denied", "spf",
];

/**
 * Classifies a 4xx/5xx recipient refusal. The RFC 3463 enhanced status code is
 * the most trustworthy signal, so it wins when present; free-text phrases are
 * the fallback, and the numeric reply code is the last resort.
 */
function classifyReject(code: number, text: string): RejectKind {
    const body = text.toLowerCase();
    // Numeric 4xx takes precedence even over contradictory server wording.
    if (code >= 400 && code < 500) return "TRANSIENT";
    const enhanced = body.match(/\b([245])\.(\d{1,3})\.(\d{1,3})\b/);
    if (enhanced) {
        const [, cls, subject, detail] = enhanced;
        if (cls === "4") return "TRANSIENT";
        if (cls === "5") {
            if (subject === "7") return "POLICY_BLOCK";
            // Storage/disabled mailboxes exist; neither is a sender reputation verdict.
            if (subject === "2") return "AMBIGUOUS";
            if (subject === "1" && ["1", "2", "3", "6"].includes(detail)) return "MAILBOX_UNKNOWN";
        }
    }
    if (isReputationBlock(text)) return "POLICY_BLOCK";
    if (TRANSIENT_PHRASES.some(p => body.includes(p))) return "TRANSIENT";
    if (POLICY_BLOCK_PHRASES.some(phrase => new RegExp('\\b' + phrase + '\\b').test(body))) return "POLICY_BLOCK";
    if (code >= 500 && MAILBOX_UNKNOWN_PHRASES.some(p => body.includes(p))) return "MAILBOX_UNKNOWN";
    // Bare 550 has several meanings; 551 may forward elsewhere. Neither proves absence.
    return "AMBIGUOUS";
}

function recordRejectSignal(kind: RejectKind) {
    if (kind === "POLICY_BLOCK") blockSignal.policyRejects++;
    if (kind === "MAILBOX_UNKNOWN") blockSignal.decisiveAnswers++;
    const total = blockSignal.policyRejects + blockSignal.decisiveAnswers;
    if (total >= 20 && blockSignal.policyRejects / total > 0.5) {
        console.warn(
            `[VERIFIER] ⚠️ ${blockSignal.policyRejects}/${total} recent refusals were policy blocks, not missing mailboxes. ` +
            `This sending host's IP or HELO (${SMTP_HELO}) is likely being refused — treat today's results as unreliable.`
        );
        blockSignal.policyRejects = 0;
        blockSignal.decisiveAnswers = 0;
    }
}

/** Turns a RCPT refusal into a verdict, never guessing in the lead's disfavour. */
function rejectToResult(code: number, text: string): SmtpResult {
    const kind = classifyReject(code, text);
    recordRejectSignal(kind);
    const summary = summariseReply(text);
    switch (kind) {
        case "MAILBOX_UNKNOWN":
            return { valid: false, catchAll: false, code, rejectKind: kind, text: summary, message: "Mailbox does not exist" };
        case "TRANSIENT":
            return { valid: null, catchAll: null, code, rejectKind: kind, text: summary, message: /grey-?list|gray-?list|not yet authori[sz]ed/i.test(text) ? "GREYLISTED" : "SMTP temporarily deferred; retry later" };
        case "POLICY_BLOCK":
            return { valid: null, catchAll: null, code, rejectKind: kind, blocked: true, text: summary, message: `Server refused the probe, not the mailbox (${code})` };
        default:
            return { valid: null, catchAll: null, code, rejectKind: kind, text: summary, message: `Inconclusive refusal (${code})` };
    }
}

/**
 * The random address used to ask whether a server validates recipients at all.
 *
 * It has to look like an ordinary local part. The previous form,
 * `__revlane_probe_<24 hex>`, used a conspicuous fixed literal prefix that is a
 * signature any anti-harvesting appliance can match on, either to blocklist the
 * source or to accept it unconditionally and defeat the test it exists to run.
 *
 * Letters-then-digits keeps it syntactically boring; 8 letters + 4 digits is
 * ~2×10^15 combinations, so collision with a real mailbox is not a live concern.
 */
function probeAddress(domain: string) {
    const bytes = randomBytes(12);
    const letters = [...bytes.subarray(0, 8)].map(b => "abcdefghijklmnopqrstuvwxyz"[b % 26]).join("");
    const digits = [...bytes.subarray(8, 12)].map(b => String(b % 10)).join("");
    return `${letters}${digits}@${domain}`;
}

/** Ranks how much a result tells us, so a later unresponsive MX can't erase a good answer. */
function evidenceRank(r: SmtpResult): number {
    if (r.valid === true && r.catchAll === false) return 4;
    if (r.valid === true && r.catchAll === true) return 3;
    if (r.valid === true) return 2;
    if (r.valid === false) return 4; // a mailbox-unknown verdict is equally decisive
    if (r.rejectKind === "POLICY_BLOCK") return 1;
    return 0;
}

async function smtpVerifyAcrossMx(email: string, mxRecords: dns.MxRecord[], domain: string): Promise<SmtpResult> {
    // Multiple advertised MX hosts are still one direct verification path, not
    // a provider fallback. A transient failure at one authoritative host must
    // never turn into a positive result — and, equally, must not overwrite a
    // decisive answer another host already gave us.
    let best: SmtpResult = { valid: null, catchAll: null, message: "No decisive SMTP response" };

    for (const mxRecord of mxRecords.slice(0, 3)) {
        let result = await smtpVerifySingle(email, mxRecord, domain);
        if (result.message === "GREYLISTED") {
            // Same reasoning as the batch path: a five-second retry is refused by
            // design, because that is exactly what a greylister exists to filter out.
            await sleepMs(boundedSetting(process.env.EMAIL_VERIFY_GREYLIST_WAIT_MS, 90000, 5000, 300000));
            result = await smtpVerifySingle(email, mxRecord, domain);
        }

        if (evidenceRank(result) > evidenceRank(best) || (!best.text && result.text && evidenceRank(result) === evidenceRank(best))) best = result;

        // A mailbox-unknown verdict from an authoritative host is final. Policy
        // refusals are not — those mean try the next host, since a different
        // relay for the same domain may not be refusing this sender.
        if (result.valid === false) return result;
        if (result.valid === true && result.catchAll !== null) return result;
    }

    // ── Second pass, longer patience ──
    //
    // This path is what the worker calls as each lead arrives, and it used to get
    // exactly one 30s attempt per MX where the CRM's batch path got an extended
    // retry across every host. That asymmetry is why every UNKNOWN row in the
    // database was written here: slow-but-answering servers (shared hosting,
    // greylisters mid-delay) were being written off as unverifiable at the point
    // it mattered most, on first arrival.
    //
    // Skipped entirely when the answer was a refusal of *this host* — more
    // patience cannot change a reputation verdict, and re-asking is what earns
    // the next listing.
    const inconclusive = best.valid === null && !best.blocked && best.rejectKind !== "TRANSIENT";
    if (inconclusive && mxRecords.length > 0) {
        for (const mxRecord of mxRecords.slice(0, 2)) {
            if (cacheGet(hostBlockCache, mxRecord.exchange)) continue;
            const retry = await smtpVerifySingle(email, mxRecord, domain, 60_000);
            if (evidenceRank(retry) > evidenceRank(best)) best = retry;
            if (retry.valid === false) return retry;
            if (retry.valid === true && retry.catchAll !== null) return retry;
        }
    }

    return best;
}

function smtpVerifySingle(email: string, mxRecord: dns.MxRecord, domain: string, timeoutMs = 30000): Promise<SmtpResult> {
    return smtpVerifyBatchSingle([email], mxRecord, domain, timeoutMs).then(results => results.get(email)!);
}

async function smtpVerifyBatch(emails: string[], mxRecord: dns.MxRecord, domain: string, timeoutMs = 45000): Promise<Map<string, SmtpResult>> {
    emails = [...new Set(emails)];
    const all = new Map<string, SmtpResult>();
    for (let i = 0; i < emails.length; i += 10) {
        const batch = await smtpVerifyBatchSingle(emails.slice(i, i + 10), mxRecord, domain, timeoutMs);
        for (const [email, result] of batch) all.set(email, result);
    }
    return all;
}

function smtpVerifyBatchExtended(emails: string[], mxRecord: dns.MxRecord, domain: string) {
    // Extended patience still respects the ten-recipient envelope cap and pacing.
    return smtpVerifyBatch(emails, mxRecord, domain, 60000);
}

function smtpVerifyBatchSingle(emails: string[], mxRecord: dns.MxRecord, domain: string, timeoutMs = 45000): Promise<Map<string, SmtpResult>> {
    return withSmtpSlot(mxRecord.exchange, async () => {
        // Check inside the slot: another waiting conversation may have just blocked.
        const blocked = cacheGet(hostBlockCache, mxRecord.exchange);
        if (blocked) return new Map(emails.map(email => [email, {
            valid: null, catchAll: null, blocked: true, code: blocked.code,
            text: blocked.text, rejectKind: 'POLICY_BLOCK', message: 'Cached sending-host refusal',
        } as SmtpResult]));
        return runSmtpProbe({ host: mxRecord.exchange, helo: SMTP_HELO, mailFrom: SMTP_MAIL_FROM,
            emails, control: probeAddress(domain), timeoutMs,
            classify: classifyReject, reject: rejectToResult, summarize: summariseReply,
            noteHostBlock: (code, text) => {
                if (code < 400 || !isReputationBlock(text) || classifyReject(code, text) === 'MAILBOX_UNKNOWN') return false;
                rememberHostBlock(mxRecord.exchange, code, summariseReply(text));
                return true;
            },
        });
    });
}

// ────────────────────────────────────────────────────────
// ── Scoring & Result Building ──
// ────────────────────────────────────────────────────────

function isValidSyntax(email: string): boolean {
    if (email.length < 5 || email.length > 254) return false;
    const regex = /^[a-z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[a-z0-9!#$%&'*+\-/=?^_`{|}~]+)*@[a-z0-9.-]+$/i;
    if (!regex.test(email)) return false;
    const [local, domain] = email.split("@");
    if (!local || !domain) return false;
    if (local.length > 64) return false;
    if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
    const parts = domain.split(".");
    if (parts.length < 2 || parts.some(p => p.length === 0 || p.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(p))) return false;
    const tld = parts[parts.length - 1];
    if (tld.length < 2) return false;
    return true;
}

function detectProvider(domain: string, mxRecords?: dns.MxRecord[]): string | undefined {
    const p: Record<string, string[]> = {
        "Google": ["gmail.com", "googlemail.com"], "Microsoft": ["outlook.com", "hotmail.com", "live.com", "msn.com"],
        "Yahoo": ["yahoo.com", "yahoo.co.uk", "ymail.com"], "Apple": ["icloud.com", "me.com", "mac.com"],
        "ProtonMail": ["protonmail.com", "proton.me", "pm.me"], "Zoho": ["zoho.com", "zohomail.com"],
        "AOL": ["aol.com"], "FastMail": ["fastmail.com", "fastmail.fm"],
        "GMX": ["gmx.com", "gmx.net"], "Tutanota": ["tutanota.com", "tuta.io"],
    };
    for (const [name, domains] of Object.entries(p)) { if (domains.includes(domain)) return name; }
    
    if (mxRecords && mxRecords.length > 0) {
        const mxString = mxRecords.map(m => m.exchange.toLowerCase()).join(" ");
        if (mxString.includes("google.com") || mxString.includes("googlemail.com")) return "Google Workspace";
        if (mxString.includes("outlook.com") || mxString.includes("protection.outlook.com")) return "Office 365";
        if (mxString.includes("zoho.com")) return "Zoho";
        if (mxString.includes("mimecast.com")) return "Mimecast";
        if (mxString.includes("pphosted.com")) return "Proofpoint";
    }
    
    return undefined;
}

function buildResult(email: string, checks: EmailCheckResults, status: VerificationResult["status"], score: number, reason: string): VerificationResult {
    const [, domain] = email.split("@");
    return {
        email,
        status,
        score,
        checks,
        reason,
        provider: detectProvider(domain, cacheGet(mxCache, domain)),
        method: checks.syntax ? "DNS_PREFILTER" : "LOCAL_PREFILTER",
        checkedAt: new Date().toISOString(),
    };
}

async function buildFinalResult(email: string, checks: EmailCheckResults, domain: string, source?: string): Promise<VerificationResult> {
    let score = 0;
    const reasons: string[] = [];

    score += 10; // syntax passed
    if (checks.mxRecord) score += 20;
    if (checks.disposable) reasons.push("Disposable domain");

    if (checks.smtpValid === true) {
        if (checks.catchAll === false) {
            score += 65;
            reasons.push("Direct SMTP recipient accepted; randomized recipient rejected");
        } else if (checks.catchAll === true) {
            score += 15;
            reasons.push("Accepted by catch-all server");
        } else {
            score += 20;
            reasons.push("Direct SMTP accepted, but catch-all test was inconclusive");
        }
    } else if (checks.smtpValid === false) {
        reasons.push("Recipient server says this mailbox does not exist");
    } else {
        // A real mail domain is not evidence that this mailbox exists.
        if (checks.mxRecord) {
            score += 10;
            reasons.push("Domain accepts email, but mailbox was not confirmed");
        } else {
            score += 5;
            reasons.push("No mailbox verification evidence");
        }
    }

    // A solo operator's hello@/info@/contact@ address is usually the inbox they
    // actually read, so a shared-inbox local part costs score but no longer
    // disqualifies an address that direct SMTP proved deliverable. Only true
    // system addresses (noreply@, postmaster@…) stay out of the send list.
    if (checks.systemAddress) { score = Math.max(0, score - 40); reasons.push("System address — not a person"); }
    else if (checks.roleAccount) { score = Math.max(0, score - 15); reasons.push("Shared/role inbox"); }
    if (checks.freeProvider) { score = Math.max(0, score - 10); reasons.push("Free email provider"); }
    // Carry the server's own words through to the CRM. "Server refused our probe"
    // on its own is untriageable — a reputation block on this sending IP and a
    // one-off rate limit read identically, and the first is a host problem
    // affecting every lead behind that provider while the second clears by itself.
    if (checks.policyBlocked) {
        const detail = [checks.refusalCode, checks.refusalText].filter(Boolean).join(": ");
        reasons.push(detail
            ? `Server refused our probe, not the mailbox — ${detail}`
            : "Server refused our probe — this says nothing about the mailbox");
    }

    if (!checks.policyBlocked && (checks.probeDetail || checks.refusalText)) {
        const detail = [checks.refusalCode, checks.refusalText || checks.probeDetail].filter(Boolean).join(': ');
        reasons.push('Probe inconclusive — ' + detail);
    }
    const providerStr = detectProvider(domain, cacheGet(mxCache, domain));

    // ── The only route to VALID ──
    //
    // A mailbox is proven to exist when, and only when, the server accepted the
    // real address *and* refused a random one at mailbox level. There is no
    // provider-specific exemption, and there must never be one again:
    //
    // A previous revision promoted catch-all domains to VALID whenever the MX was
    // Google, on the reasoning that "a catch-all accepts email without bouncing".
    // That is false in the way that matters. Accepting at RCPT is not a promise to
    // deliver — Google evaluates routing rules, aliases, suspended and over-quota
    // mailboxes *after* the transaction, and returns an async NDR hours later. The
    // probe cannot see any of that. Worse, when a catch-all genuinely doesn't
    // bounce the mail lands in a bin nobody reads, and a stream of mail to
    // addresses that don't exist is precisely the pattern that costs a sending
    // domain its reputation. It also promoted `<anything>@bit.ly`, because bit.ly
    // is on Google's MX and accepts every recipient — verification proved nothing
    // and reported 95/100.
    //
    // A catch-all domain is not verifiable by SMTP. It belongs in RISKY, where it
    // can still be exported deliberately via `?include=risky`. See CLAUDE.md:
    // "The catch-all probe is only conclusive when the random address is refused
    // at mailbox level."
    const directNonCatchAll = checks.smtpValid === true && checks.catchAll === false;

    const strictValid = directNonCatchAll
        && !checks.disposable
        && !checks.systemAddress
        && !checks.freeProvider;

    let status: VerificationResult["status"];
    if (strictValid) {
        status = "VALID";
        score = Math.max(score, 95);
    } else if (checks.smtpValid === true) {
        // The mailbox accepted mail. A catch-all domain, a free provider, or an
        // unfinished catch-all test keeps it off the strict send list — but this
        // is a live address, not a dead one, so it belongs in RISKY where it can
        // still be exported deliberately.
        status = "RISKY";
        score = Math.min(Math.max(score, 30), 70);
    } else if (checks.smtpValid === false) {
        // Reached only via a mailbox-level refusal. Policy refusals are classified
        // as blocks upstream and fall through to UNKNOWN instead, so a blocklisted
        // sending host can no longer mass-mark good leads as dead.
        status = "INVALID";
        score = Math.min(score, 10);
    } else {
        status = "UNKNOWN";
        score = Math.min(score, 35);
    }

    score = Math.min(100, Math.max(0, score));
    return {
        email,
        status,
        score,
        checks,
        reason: reasons.join(" · ") || "Mailbox is unconfirmed",
        provider: providerStr,
        method: checks.smtpAttempted ? "SMTP_DIRECT" : "DNS_PREFILTER",
        checkedAt: new Date().toISOString(),
        expiresAt: strictValid ? new Date(Date.now() + VALID_TTL_MS).toISOString() : undefined,
        source,
    };
}
