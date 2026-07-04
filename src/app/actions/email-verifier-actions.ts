"use server";

import dns from "dns";
import net from "net";
import { DISPOSABLE_DOMAINS, ROLE_ACCOUNTS, FREE_PROVIDERS } from "@/lib/email-constants";

// ── Configuration ──
// Set your free API key in .env.local: EMAIL_VERIFY_API_KEY=your_key_here
// Get a free key (100/day, no CC): https://quickemailverification.com
const QEV_API_KEY = process.env.EMAIL_VERIFY_API_KEY || "";
const QEV_BASE = "https://api.quickemailverification.com/v1/verify";

// ── Runtime state ──
const mxCache = new Map<string, dns.MxRecord[]>();
const catchAllCache = new Map<string, boolean | null>();
let smtpAvailable: boolean | null = null; // Auto-detected at first use

// ── Types ──

export type EmailCheckResults = {
    syntax: boolean;
    mxRecord: boolean;
    disposable: boolean;
    roleAccount: boolean;
    freeProvider: boolean;
    smtpValid: boolean | null;
    catchAll: boolean | null;
};

export type VerificationResult = {
    email: string;
    status: "VALID" | "INVALID" | "RISKY" | "UNKNOWN";
    score: number;
    checks: EmailCheckResults;
    reason: string;
    provider?: string;
};

// ────────────────────────────────────────────────────────
// ── Auto-detect SMTP availability (port 25) ──
// ────────────────────────────────────────────────────────

async function detectSmtp(): Promise<boolean> {
    if (smtpAvailable !== null) return smtpAvailable;

    return new Promise((resolve) => {
        const socket = net.createConnection({
            port: 25,
            host: "gmail-smtp-in.l.google.com",
            family: 4,
        });
        socket.setTimeout(6000);

        socket.on("data", () => {
            console.log("[SMTP] ✅ Port 25 is OPEN — using direct SMTP verification");
            smtpAvailable = true;
            socket.destroy();
            resolve(true);
        });

        socket.on("timeout", () => {
            console.log("[SMTP] ❌ Port 25 is BLOCKED — using API/DNS fallback");
            smtpAvailable = false;
            socket.destroy();
            resolve(false);
        });

        socket.on("error", () => {
            smtpAvailable = false;
            socket.destroy();
            resolve(false);
        });
    });
}

// ────────────────────────────────────────────────────────
// ── QuickEmailVerification API ──
// ────────────────────────────────────────────────────────

type QEVResponse = {
    result: "valid" | "invalid" | "risky" | "unknown";
    reason: string;
    disposable: boolean;
    accept_all: boolean;
    role: boolean;
    free: boolean;
    email: string;
    domain: string;
    mx_record: string;
    safe_to_send: boolean;
    did_you_mean: string;
    success: boolean;
    message: string;
};

async function verifyViaAPI(email: string): Promise<VerificationResult | null> {
    if (!QEV_API_KEY) return null;

    try {
        const url = `${QEV_BASE}?email=${encodeURIComponent(email)}&apikey=${QEV_API_KEY}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(15000) });

        if (!res.ok) {
            if (res.status === 429) {
                console.log("[API] Rate limit reached (100/day). Falling back to DNS.");
                return null;
            }
            console.log(`[API] HTTP ${res.status} for ${email}`);
            return null;
        }

        const data = (await res.json()) as QEVResponse;

        if (!data.success) {
            console.log(`[API] Error for ${email}: ${data.message}`);
            return null;
        }

        const [local, domain] = email.split("@");

        const checks: EmailCheckResults = {
            syntax: true,
            mxRecord: !!data.mx_record,
            disposable: data.disposable || DISPOSABLE_DOMAINS.has(domain),
            roleAccount: data.role || ROLE_ACCOUNTS.some(r => local === r || local.startsWith(r + ".") || local.startsWith(r + "+")),
            freeProvider: data.free || FREE_PROVIDERS.has(domain),
            smtpValid: data.result === "valid" ? true : data.result === "invalid" ? false : null,
            catchAll: data.accept_all || null,
        };

        let status: VerificationResult["status"];
        let score: number;

        switch (data.result) {
            case "valid":
                if (data.accept_all) {
                    status = "RISKY";
                    score = 55;
                } else {
                    status = "VALID";
                    score = data.safe_to_send ? 95 : 80;
                }
                break;
            case "invalid":
                status = "INVALID";
                score = 10;
                break;
            case "risky":
                status = "RISKY";
                score = 40;
                break;
            default:
                status = "UNKNOWN";
                score = 35;
        }

        if (checks.disposable && status === "VALID") {
            status = "RISKY";
            score = Math.min(score, 30);
        }

        const reasons: string[] = [];
        if (data.reason) reasons.push(data.reason.replace(/_/g, " "));
        if (checks.disposable) reasons.push("Disposable domain");
        if (checks.roleAccount) reasons.push("Role-based address");
        if (checks.freeProvider) reasons.push("Free email provider");
        if (data.accept_all) reasons.push("Catch-all server");
        if (data.did_you_mean) reasons.push(`Did you mean: ${data.did_you_mean}`);

        return {
            email,
            status,
            score,
            checks,
            reason: reasons.join(" · ") || data.reason || "Verified via API",
            provider: detectProvider(domain),
        };
    } catch (err) {
        console.error(`[API] Error verifying ${email}:`, err);
        return null;
    }
}

// ────────────────────────────────────────────────────────
// ── Single Email Verification ──
// ────────────────────────────────────────────────────────

export async function verifyEmail(email: string): Promise<VerificationResult> {
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
    checks.freeProvider = FREE_PROVIDERS.has(domain);

    // ── Layer 2: MX Lookup ──
    const mxResult = await resolveMX(domain);
    checks.mxRecord = mxResult.length > 0;

    if (!checks.mxRecord) {
        return buildResult(e, checks, "INVALID", 5, "Domain has no MX records — cannot receive email");
    }

    if (checks.disposable) {
        return buildResult(e, checks, "RISKY", 25, "Disposable/temporary email domain detected");
    }

    // ── Layer 3: SMTP or API verification ──
    const canSmtp = await detectSmtp();

    if (canSmtp) {
        // Direct SMTP verification (port 25 is open)
        const primaryMx = mxResult[0];
        try {
            let smtpResult = await smtpVerifySingle(e, primaryMx, domain);
            if (smtpResult.message === "GREYLISTED") {
                await new Promise(r => setTimeout(r, 5000));
                smtpResult = await smtpVerifySingle(e, primaryMx, domain);
                if (smtpResult.message === "GREYLISTED") {
                    smtpResult = { valid: null, catchAll: null, message: "Greylisted after retry" };
                }
            }
            checks.smtpValid = smtpResult.valid;
            checks.catchAll = smtpResult.catchAll;
            if (smtpResult.catchAll !== null) catchAllCache.set(domain, smtpResult.catchAll);
        } catch {
            checks.smtpValid = null;
            checks.catchAll = catchAllCache.get(domain) ?? null;
        }
    } else if (QEV_API_KEY) {
        // API-based verification
        const apiResult = await verifyViaAPI(e);
        if (apiResult) return apiResult;
    }
    // else: DNS-only fallback (no SMTP, no API key)

    return buildFinalResult(e, checks, domain);
}

// ────────────────────────────────────────────────────────
// ── HIGH-PERFORMANCE BATCH VERIFICATION ──
// ────────────────────────────────────────────────────────

export async function verifyEmailBatchFast(
    emails: string[]
): Promise<VerificationResult[]> {
    const results: VerificationResult[] = new Array(emails.length);

    // ── Phase 1: Pre-filter ──
    type PreFiltered = {
        email: string; index: number; domain: string; local: string;
        checks: EmailCheckResults;
    };

    const candidates: PreFiltered[] = [];

    for (let i = 0; i < emails.length; i++) {
        const e = emails[i].toLowerCase().trim();
        const checks: EmailCheckResults = {
            syntax: false, mxRecord: false, disposable: false,
            roleAccount: false, freeProvider: false,
            smtpValid: null, catchAll: null,
        };

        checks.syntax = isValidSyntax(e);
        if (!checks.syntax) {
            results[i] = buildResult(e, checks, "INVALID", 0, "Invalid email syntax");
            continue;
        }

        const [local, domain] = e.split("@");
        checks.disposable = DISPOSABLE_DOMAINS.has(domain) || DISPOSABLE_DOMAINS.has(domain.replace(/^.*\./, ""));
        checks.roleAccount = ROLE_ACCOUNTS.some(r => local === r || local.startsWith(r + ".") || local.startsWith(r + "+"));
        checks.freeProvider = FREE_PROVIDERS.has(domain);

        candidates.push({ email: e, index: i, domain, local, checks });
    }

    console.log(`[BATCH] ${emails.length} emails → ${candidates.length} passed syntax check`);

    // ── Phase 2: MX Resolution ──
    const uniqueDomains = [...new Set(candidates.map(p => p.domain))];
    await Promise.all(uniqueDomains.map(d => resolveMX(d)));

    // ── Phase 3: Filter by MX & disposable ──
    const verified: PreFiltered[] = [];

    for (const item of candidates) {
        const mx = mxCache.get(item.domain) || [];
        item.checks.mxRecord = mx.length > 0;

        if (!item.checks.mxRecord) {
            results[item.index] = buildResult(item.email, item.checks, "INVALID", 5, "Domain has no MX records — cannot receive email");
            continue;
        }

        if (item.checks.disposable) {
            results[item.index] = buildResult(item.email, item.checks, "RISKY", 25, "Disposable/temporary email domain detected");
            continue;
        }

        verified.push(item);
    }

    console.log(`[BATCH] ${verified.length} emails need SMTP/API verification`);

    // ── Phase 4: Choose verification strategy ──
    const canSmtp = await detectSmtp();

    if (canSmtp) {
        // ── Strategy A: Direct SMTP (port 25 open — unlimited, free) ──
        console.log(`[BATCH] Using DIRECT SMTP verification (port 25 open)`);
        await batchSmtpVerify(verified, results);
    } else if (QEV_API_KEY) {
        // ── Strategy B: API verification (100/day free tier) ──
        console.log(`[BATCH] Using API verification (QuickEmailVerification)`);
        await batchApiVerify(verified, results);
    } else {
        // ── Strategy C: DNS-only heuristics ──
        console.log(`[BATCH] ⚠️ No SMTP access and no API key configured.`);
        console.log(`[BATCH] Set EMAIL_VERIFY_API_KEY in .env.local for accurate results.`);
        console.log(`[BATCH] Free key (100/day): https://quickemailverification.com`);

        for (const item of verified) {
            results[item.index] = buildFinalResult(item.email, item.checks, item.domain);
        }
    }

    // ── Phase 5: Safety net ──
    for (let i = 0; i < results.length; i++) {
        if (!results[i]) {
            results[i] = {
                email: emails[i], status: "UNKNOWN", score: 0,
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
};

async function batchApiVerify(items: PreFiltered[], results: VerificationResult[]) {
    const CONCURRENCY = 5; // Be nice to the free API

    for (let i = 0; i < items.length; i += CONCURRENCY) {
        const chunk = items.slice(i, i + CONCURRENCY);

        await Promise.allSettled(chunk.map(async (item) => {
            const apiResult = await verifyViaAPI(item.email);
            if (apiResult) {
                results[item.index] = apiResult;
            } else {
                // API failed or rate-limited — fall back to DNS-only
                results[item.index] = buildFinalResult(item.email, item.checks, item.domain);
            }
        }));

        const processed = Math.min(i + CONCURRENCY, items.length);
        console.log(`[BATCH API] ${processed}/${items.length} (${Math.round(processed / items.length * 100)}%)`);

        // Small delay between chunks to respect rate limits
        if (i + CONCURRENCY < items.length) {
            await new Promise(r => setTimeout(r, 200));
        }
    }
}

async function batchSmtpVerify(items: PreFiltered[], results: VerificationResult[]) {
    const domainGroups = new Map<string, PreFiltered[]>();
    for (const item of items) {
        const group = domainGroups.get(item.domain) || [];
        group.push(item);
        domainGroups.set(item.domain, group);
    }

    const DOMAIN_CONCURRENCY = 15;
    const domainEntries = [...domainGroups.entries()];
    const greylisted: PreFiltered[] = [];

    for (let i = 0; i < domainEntries.length; i += DOMAIN_CONCURRENCY) {
        const chunk = domainEntries.slice(i, i + DOMAIN_CONCURRENCY);

        await Promise.allSettled(chunk.map(async ([domain, domainItems]) => {
            const mx = mxCache.get(domain);
            if (!mx || mx.length === 0) return;

            // Try up to 3 MX servers
            const mxToTry = mx.slice(0, 3);
            let smtpResults: Map<string, SmtpResult> | null = null;

            for (const mxRecord of mxToTry) {
                try {
                    const emailList = domainItems.map(it => it.email);
                    smtpResults = await smtpVerifyBatch(emailList, mxRecord, domain);
                    const hasReal = [...smtpResults.values()].some(r => r.valid !== null);
                    if (hasReal) break;
                } catch {
                    smtpResults = null;
                }
            }

            for (const item of domainItems) {
                const smtp = smtpResults?.get(item.email);
                if (!smtp) {
                    item.checks.smtpValid = null;
                    item.checks.catchAll = catchAllCache.get(domain) ?? null;
                    results[item.index] = buildFinalResult(item.email, item.checks, item.domain);
                } else if (smtp.message === "GREYLISTED") {
                    greylisted.push(item);
                } else {
                    item.checks.smtpValid = smtp.valid;
                    item.checks.catchAll = smtp.catchAll;
                    if (smtp.catchAll !== null) catchAllCache.set(domain, smtp.catchAll);
                    results[item.index] = buildFinalResult(item.email, item.checks, item.domain);
                }
            }
        }));

        const processed = Math.min(i + DOMAIN_CONCURRENCY, domainEntries.length);
        console.log(`[BATCH SMTP] Domain batch ${processed}/${domainEntries.length}`);
    }

    // ── Greylisting retry ──
    if (greylisted.length > 0) {
        console.log(`[BATCH SMTP] ${greylisted.length} greylisted — retrying in 5s...`);
        await new Promise(r => setTimeout(r, 5000));

        const greyGroups = new Map<string, PreFiltered[]>();
        for (const item of greylisted) {
            const group = greyGroups.get(item.domain) || [];
            group.push(item);
            greyGroups.set(item.domain, group);
        }

        await Promise.allSettled([...greyGroups.entries()].map(async ([domain, domainItems]) => {
            const mx = mxCache.get(domain);
            if (!mx || mx.length === 0) return;

            try {
                const emailList = domainItems.map(it => it.email);
                const smtpResults = await smtpVerifyBatch(emailList, mx[0], domain);
                for (const item of domainItems) {
                    const smtp = smtpResults.get(item.email);
                    if (smtp && smtp.valid !== null) {
                        item.checks.smtpValid = smtp.valid;
                        item.checks.catchAll = smtp.catchAll;
                        if (smtp.catchAll !== null) catchAllCache.set(domain, smtp.catchAll);
                    } else {
                        item.checks.smtpValid = null;
                        item.checks.catchAll = catchAllCache.get(domain) ?? null;
                    }
                    results[item.index] = buildFinalResult(item.email, item.checks, item.domain);
                }
            } catch {
                for (const item of domainItems) {
                    item.checks.smtpValid = null;
                    item.checks.catchAll = catchAllCache.get(domain) ?? null;
                    results[item.index] = buildFinalResult(item.email, item.checks, item.domain);
                }
            }
        }));
    }

    // ── Timeout retry phase: retry all UNKNOWN results with alternate MX + longer timeout ──
    const unknowns = items.filter(item => {
        const r = results[item.index];
        return r && r.status === "UNKNOWN" && r.checks.smtpValid === null;
    });

    if (unknowns.length > 0) {
        console.log(`[BATCH SMTP] ⚡ ${unknowns.length} timed out — retrying with extended timeout...`);

        const retryGroups = new Map<string, PreFiltered[]>();
        for (const item of unknowns) {
            const group = retryGroups.get(item.domain) || [];
            group.push(item);
            retryGroups.set(item.domain, group);
        }

        // Retry with lower concurrency (5 at a time) and longer timeout
        const retryEntries = [...retryGroups.entries()];
        for (let i = 0; i < retryEntries.length; i += 5) {
            const chunk = retryEntries.slice(i, i + 5);

            await Promise.allSettled(chunk.map(async ([domain, domainItems]) => {
                const mx = mxCache.get(domain);
                if (!mx || mx.length === 0) return;

                // Try ALL available MX servers (not just first 3)
                for (const mxRecord of mx) {
                    try {
                        const emailList = domainItems.map(it => it.email);
                        const smtpResults = await smtpVerifyBatchExtended(emailList, mxRecord, domain);
                        let resolved = false;

                        for (const item of domainItems) {
                            const smtp = smtpResults.get(item.email);
                            if (smtp && smtp.valid !== null) {
                                item.checks.smtpValid = smtp.valid;
                                item.checks.catchAll = smtp.catchAll;
                                if (smtp.catchAll !== null) catchAllCache.set(domain, smtp.catchAll);
                                results[item.index] = buildFinalResult(item.email, item.checks, item.domain);
                                resolved = true;
                            }
                        }

                        if (resolved) break; // Got real results, stop trying MX servers
                    } catch {
                        continue; // Try next MX
                    }
                }
            }));
        }

        const stillUnknown = items.filter(item => results[item.index]?.status === "UNKNOWN").length;
        const recovered = unknowns.length - stillUnknown;
        if (recovered > 0) {
            console.log(`[BATCH SMTP] ✅ Recovered ${recovered}/${unknowns.length} from timeout retry`);
        }
        if (stillUnknown > 0) {
            console.log(`[BATCH SMTP] ⚠️ ${stillUnknown} emails remain UNKNOWN (servers unresponsive)`);
        }
    }
}

// ────────────────────────────────────────────────────────
// ── SMTP Engine (used when port 25 is open) ──
// ────────────────────────────────────────────────────────

type SmtpResult = {
    valid: boolean | null;
    catchAll: boolean | null;
    code?: number;
    message?: string;
};

function smtpVerifySingle(email: string, mxRecord: dns.MxRecord, domain: string): Promise<SmtpResult> {
    return new Promise((resolve) => {
        const TIMEOUT = 30000;
        let isResolved = false;
        let dataBuffer = "";
        let step = 0;

        const done = (result: SmtpResult) => {
            if (isResolved) return;
            isResolved = true;
            try { socket.destroy(); } catch { /* ignore */ }
            resolve(result);
        };

        const socket = net.createConnection({ port: 25, host: mxRecord.exchange, family: 4 });
        socket.setTimeout(TIMEOUT);

        socket.on("timeout", () => done({ valid: null, catchAll: null, message: "SMTP timeout" }));
        socket.on("error", (err) => done({ valid: null, catchAll: null, message: `SMTP error: ${err.message}` }));
        socket.on("close", () => done({ valid: null, catchAll: null, message: "Connection closed" }));

        socket.on("data", (data) => {
            dataBuffer += data.toString();
            if (!dataBuffer.endsWith('\n')) return;
            const lines = dataBuffer.trim().split('\n');
            const lastLine = lines[lines.length - 1].trim();
            if (!lastLine.match(/^\d{3}\s/)) return;

            const response = dataBuffer.trim();
            dataBuffer = "";
            const code = parseInt(response.substring(0, 3), 10);

            if (step === 0) {
                if (code >= 200 && code < 400) { step = 1; socket.write(`EHLO verify.revlane.io\r\n`); }
                else done({ valid: null, catchAll: null, code, message: "Server rejected" });
            } else if (step === 1) {
                if (code === 250) { step = 2; socket.write(`MAIL FROM:<verify@revlane.io>\r\n`); }
                else done({ valid: null, catchAll: null, code, message: "EHLO rejected" });
            } else if (step === 2) {
                if (code === 250) { step = 3; socket.write(`RCPT TO:<${email}>\r\n`); }
                else done({ valid: null, catchAll: null, code, message: "MAIL FROM rejected" });
            } else if (step === 3) {
                if (code === 250) {
                    step = 4;
                    socket.write(`RCPT TO:<xq7z9k${Date.now()}@${domain}>\r\n`);
                } else if (code >= 550 && code <= 554) {
                    socket.write("QUIT\r\n");
                    done({ valid: false, catchAll: false, code, message: "Mailbox does not exist" });
                } else if (code >= 450 && code <= 452) {
                    socket.write("QUIT\r\n");
                    done({ valid: null, catchAll: null, code, message: "GREYLISTED" });
                } else {
                    socket.write("QUIT\r\n");
                    done({ valid: null, catchAll: null, code, message: `Unexpected: ${code}` });
                }
            } else if (step === 4) {
                socket.write("QUIT\r\n");
                if (code === 250) done({ valid: true, catchAll: true, code: 250, message: "Catch-all" });
                else done({ valid: true, catchAll: false, code: 250, message: "Mailbox verified" });
            }
        });
    });
}

function smtpVerifyBatch(emails: string[], mxRecord: dns.MxRecord, domain: string): Promise<Map<string, SmtpResult>> {
    const MAX_RCPT = 50;
    if (emails.length > MAX_RCPT) {
        return (async () => {
            const all = new Map<string, SmtpResult>();
            for (let i = 0; i < emails.length; i += MAX_RCPT) {
                const sub = emails.slice(i, i + MAX_RCPT);
                const subR = await smtpVerifyBatchSingle(sub, mxRecord, domain);
                for (const [e, r] of subR) all.set(e, r);
                if (i + MAX_RCPT < emails.length) await new Promise(r => setTimeout(r, 500));
            }
            return all;
        })();
    }
    return smtpVerifyBatchSingle(emails, mxRecord, domain);
}

// Extended timeout version for retry phase (60s timeout)
function smtpVerifyBatchExtended(emails: string[], mxRecord: dns.MxRecord, domain: string): Promise<Map<string, SmtpResult>> {
    return smtpVerifyBatchSingle(emails, mxRecord, domain, 60000);
}

function smtpVerifyBatchSingle(emails: string[], mxRecord: dns.MxRecord, domain: string, timeout: number = 45000): Promise<Map<string, SmtpResult>> {
    return new Promise((resolve) => {
        const results = new Map<string, SmtpResult>();
        const TIMEOUT = timeout;
        let isResolved = false;
        let dataBuffer = "";
        let emailIndex = 0;
        let catchAllTested = false;
        let step = 0;

        const done = () => {
            if (isResolved) return;
            isResolved = true;
            try { socket.destroy(); } catch { /* */ }
            for (const email of emails) {
                if (!results.has(email)) results.set(email, { valid: null, catchAll: null, message: "Connection lost" });
            }
            resolve(results);
        };

        const socket = net.createConnection({ port: 25, host: mxRecord.exchange, family: 4 });
        socket.setTimeout(TIMEOUT);

        socket.on("timeout", () => done());
        socket.on("error", () => done());
        socket.on("close", () => done());

        socket.on("data", (data) => {
            dataBuffer += data.toString();
            if (!dataBuffer.endsWith('\n')) return;
            const lines = dataBuffer.trim().split('\n');
            const lastLine = lines[lines.length - 1].trim();
            if (!lastLine.match(/^\d{3}\s/)) return;

            const response = dataBuffer.trim();
            dataBuffer = "";
            const code = parseInt(response.substring(0, 3), 10);

            if (step === 0) {
                if (code >= 200 && code < 400) { step = 1; socket.write(`EHLO verify.revlane.io\r\n`); }
                else done();
            } else if (step === 1) {
                if (code === 250) { step = 2; socket.write(`MAIL FROM:<verify@revlane.io>\r\n`); }
                else done();
            } else if (step === 2) {
                if (code === 250 && emails.length > 0) { step = 3; socket.write(`RCPT TO:<${emails[0]}>\r\n`); }
                else { socket.write("QUIT\r\n"); done(); }
            } else if (step === 3) {
                const cur = emails[emailIndex];
                if (code === 250) results.set(cur, { valid: true, catchAll: null, code: 250, message: "Accepted" });
                else if (code >= 550 && code <= 554) results.set(cur, { valid: false, catchAll: false, code, message: "Mailbox does not exist" });
                else if (code >= 450 && code <= 452) results.set(cur, { valid: null, catchAll: null, code, message: "GREYLISTED" });
                else results.set(cur, { valid: null, catchAll: null, code, message: `Unexpected: ${code}` });

                emailIndex++;
                if (emailIndex < emails.length) socket.write(`RCPT TO:<${emails[emailIndex]}>\r\n`);
                else if (!catchAllTested) { catchAllTested = true; step = 4; socket.write(`RCPT TO:<xq7z9k${Date.now()}@${domain}>\r\n`); }
                else { socket.write("QUIT\r\n"); done(); }
            } else if (step === 4) {
                const isCatchAll = code === 250;
                for (const [, r] of results) {
                    if (r.valid === true) { r.catchAll = isCatchAll; r.message = isCatchAll ? "Catch-all" : "Verified"; }
                }
                catchAllCache.set(domain, isCatchAll);
                socket.write("QUIT\r\n");
                done();
            }
        });
    });
}

// ────────────────────────────────────────────────────────
// ── Scoring & Result Building ──
// ────────────────────────────────────────────────────────

function isValidSyntax(email: string): boolean {
    if (email.length < 5 || email.length > 254) return false;
    const regex = /^[a-z0-9][a-z0-9._%+\-]*@[a-z0-9][a-z0-9.\-]*\.[a-z]{2,63}$/;
    if (!regex.test(email)) return false;
    const [local, domain] = email.split("@");
    if (!local || !domain) return false;
    if (local.length > 64) return false;
    if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
    const parts = domain.split(".");
    if (parts.length < 2 || parts.some(p => p.length === 0)) return false;
    const tld = parts[parts.length - 1];
    if (tld.length < 2) return false;
    const badTlds = ["js", "ts", "css", "png", "jpg", "gif", "svg", "woff", "woff2", "ttf", "map", "json", "xml", "html", "htm", "jsx", "tsx", "mjs", "cjs"];
    if (badTlds.includes(tld)) return false;
    return true;
}

function resolveMX(domain: string): Promise<dns.MxRecord[]> {
    const cached = mxCache.get(domain);
    if (cached !== undefined) return Promise.resolve(cached);
    return new Promise((resolve) => {
        dns.resolveMx(domain, (err, addresses) => {
            if (err || !addresses || addresses.length === 0) {
                dns.resolve4(domain, (err2, addrs) => {
                    if (err2 || !addrs || addrs.length === 0) { mxCache.set(domain, []); resolve([]); }
                    else { const result = [{ exchange: addrs[0], priority: 0 }]; mxCache.set(domain, result); resolve(result); }
                });
            } else {
                const sorted = addresses.sort((a, b) => a.priority - b.priority);
                mxCache.set(domain, sorted);
                resolve(sorted);
            }
        });
    });
}

function detectProvider(domain: string): string | undefined {
    const p: Record<string, string[]> = {
        "Google": ["gmail.com", "googlemail.com"], "Microsoft": ["outlook.com", "hotmail.com", "live.com", "msn.com"],
        "Yahoo": ["yahoo.com", "yahoo.co.uk", "ymail.com"], "Apple": ["icloud.com", "me.com", "mac.com"],
        "ProtonMail": ["protonmail.com", "proton.me", "pm.me"], "Zoho": ["zoho.com", "zohomail.com"],
        "AOL": ["aol.com"], "FastMail": ["fastmail.com", "fastmail.fm"],
        "GMX": ["gmx.com", "gmx.net"], "Tutanota": ["tutanota.com", "tuta.io"],
    };
    for (const [name, domains] of Object.entries(p)) { if (domains.includes(domain)) return name; }
    return undefined;
}

function buildResult(email: string, checks: EmailCheckResults, status: VerificationResult["status"], score: number, reason: string): VerificationResult {
    const [, domain] = email.split("@");
    return { email, status, score, checks, reason, provider: detectProvider(domain) };
}

function buildFinalResult(email: string, checks: EmailCheckResults, domain: string): VerificationResult {
    let score = 0;
    const reasons: string[] = [];

    score += 10; // syntax passed
    if (checks.mxRecord) score += 20;
    if (!checks.disposable) score += 10; else reasons.push("Disposable domain");

    if (checks.smtpValid === true) {
        if (checks.catchAll === false) { score += 50; reasons.push("Mailbox verified via SMTP"); }
        else if (checks.catchAll === true) { score += 25; reasons.push("Accepted by catch-all server"); }
        else { score += 35; reasons.push("SMTP accepted"); }
    } else if (checks.smtpValid === false) {
        reasons.push("Mailbox rejected by mail server");
    } else {
        // SMTP unavailable — but if domain has valid MX, it's still likely valid
        if (checks.mxRecord) {
            score += 20; // Domain is real and accepts email
            reasons.push("DNS verified, mailbox unconfirmed (server unresponsive)");
        } else {
            score += 5;
            reasons.push("SMTP check unavailable");
        }
    }

    if (checks.roleAccount) { score = Math.max(0, score - 5); reasons.push("Role-based address"); }
    if (checks.freeProvider) reasons.push("Free email provider");

    let status: VerificationResult["status"];
    if (checks.smtpValid === false) { status = "INVALID"; score = Math.min(score, 15); }
    else if (checks.smtpValid === true && checks.catchAll === false) { status = "VALID"; score = Math.max(score, 80); }
    else if (checks.smtpValid === true && checks.catchAll === true) { status = "RISKY"; }
    else if (checks.smtpValid === null && checks.mxRecord) {
        // Server didn't respond but domain is real — don't lose this lead
        status = "RISKY";
        score = Math.max(score, 55);
    }
    else if (checks.smtpValid === null) { status = "UNKNOWN"; }
    else if (score >= 75) { status = "VALID"; }
    else if (score >= 45) { status = checks.catchAll ? "RISKY" : "VALID"; }
    else if (score >= 25 || checks.disposable) { status = "RISKY"; }
    else { status = "UNKNOWN"; }

    score = Math.min(100, Math.max(0, score));
    return { email, status, score, checks, reason: reasons.join(" · ") || "Verified", provider: detectProvider(domain) };
}
