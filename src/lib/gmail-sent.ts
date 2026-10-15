import "server-only";

import dns from "dns/promises";
import fsSync from "fs";
import { ImapFlow } from "imapflow";

/**
 * Reads recipient addresses out of Gmail's Sent Mail over IMAP.
 *
 * IMAP + an App Password is used deliberately instead of OAuth: it needs no
 * Google Cloud project, no consent screen, and no app verification — and unlike
 * an unverified OAuth app in "Testing" mode, the credential doesn't silently
 * expire after 7 days. Access is inherently read-only here; nothing in this file
 * ever writes to, moves, or deletes a message.
 */

export type GmailAccount = {
    email: string;
    appPassword: string;
    /** Optional override. Left unset, the host is resolved from the domain's MX records. */
    host?: string;
    port?: number;
};

/**
 * Maps a domain's mail provider to its IMAP endpoint. A custom domain says nothing
 * about who actually hosts the mailbox — getcompel.co on Google Workspace still
 * uses imap.gmail.com — so the MX records are the authority, not the address.
 */
const IMAP_HOSTS: { match: RegExp; host: string; label: string }[] = [
    { match: /(^|\.)google(mail)?\.com$/, host: "imap.gmail.com", label: "Google Workspace / Gmail" },
    { match: /(^|\.)(outlook|office365)\.com$/, host: "outlook.office365.com", label: "Microsoft 365 / Outlook" },
    { match: /(^|\.)zoho\.(com|eu)$/, host: "imap.zoho.com", label: "Zoho" },
    { match: /(^|\.)titan\.email$/, host: "imap.titan.email", label: "Titan" },
    { match: /(^|\.)messagingengine\.com$/, host: "imap.fastmail.com", label: "Fastmail" },
    { match: /(^|\.)improvmx\.com$/, host: "imap.improvmx.com", label: "ImprovMX" },
    { match: /(^|\.)mail\.protonmail\.ch$/, host: "127.0.0.1", label: "Proton (needs Proton Mail Bridge)" },
];

export async function resolveImapHost(email: string): Promise<{ host: string; label: string } | null> {
    const domain = email.split("@")[1]?.toLowerCase();
    if (!domain) return null;

    try {
        const mx = await dns.resolveMx(domain);
        const exchanges = mx.sort((a, b) => a.priority - b.priority).map(m => m.exchange.toLowerCase().replace(/\.$/, ""));
        for (const exchange of exchanges) {
            const hit = IMAP_HOSTS.find(h => h.match.test(exchange));
            if (hit) return { host: hit.host, label: hit.label };
        }
        console.warn(`[GmailSync] Unrecognised mail provider for ${domain} (MX: ${exchanges.join(", ")})`);
    } catch (e: any) {
        console.warn(`[GmailSync] MX lookup failed for ${domain}: ${e?.message}`);
    }
    return null;
}

/** One outbound campaign, inferred by grouping sent mail on its subject line. */
export type SentCampaign = {
    /** Normalised subject, used as the grouping key. */
    key: string;
    /** A real subject from the group, for display. */
    sample: string;
    messages: number;
    recipients: Set<string>;
    firstSent: string;
    lastSent: string;
};

export type SentScanResult = {
    account: string;
    /** Lowercased recipient address → earliest send date seen (ISO). */
    recipients: Map<string, string>;
    messagesScanned: number;
    /** Sent mail grouped by subject — separates real outreach from warm-up traffic. */
    campaigns: Map<string, SentCampaign>;
    /** Which IMAP server was used, and how it was chosen. */
    provider?: string;
    error?: string;
};

/**
 * Groups subjects that belong to the same template. Personalisation (a first name,
 * a company, a URL) varies inside an otherwise identical subject, so punctuation and
 * digits are dropped and only the leading words are kept. A reply prefix is stripped
 * so follow-ups land in the same group as the original.
 */
export function campaignKey(subject: string): string {
    return (subject || "(no subject)")
        .replace(/^\s*(re|fwd?)\s*:\s*/i, "")
        .toLowerCase()
        .replace(/[^a-z\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .split(" ")
        .slice(0, 6)
        .join(" ") || "(no subject)";
}

/**
 * Accounts come from GMAIL_ACCOUNTS in .env.local, matching the shape
 * LINKEDIN_ACCOUNTS already uses:
 *   GMAIL_ACCOUNTS=[{"email":"you@gmail.com","appPassword":"abcd efgh ijkl mnop"}]
 */
export function getGmailAccounts(): GmailAccount[] {
    const raw = process.env.GMAIL_ACCOUNTS;
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .filter((a): a is GmailAccount => Boolean(a?.email && a?.appPassword))
            // Google displays App Passwords in groups of four; the spaces are cosmetic.
            .map(a => ({
                email: String(a.email).trim(),
                appPassword: String(a.appPassword).replace(/\s+/g, ""),
                host: a.host ? String(a.host).trim() : undefined,
                port: a.port ? Number(a.port) : undefined,
            }));
    } catch {
        console.error("GMAIL_ACCOUNTS is not valid JSON");
        return [];
    }
}

/** Whether this process is running inside a container. */
function runningInContainer(): boolean {
    // Compose sets no marker of its own, but Docker always creates this file.
    try { return fsSync.existsSync("/.dockerenv"); } catch { return false; }
}

/**
 * Why no usable accounts came back, phrased so it can be acted on. Returns null
 * when the config is fine.
 *
 * The distinction that matters is *which env file to edit*: the Next.js app reads
 * `.env.local`, but under Compose the container is given only `.env.docker`, so a
 * value added to `.env.local` never reaches it. Telling someone to edit a file the
 * process never loads sends them in circles.
 */
export function describeGmailAccountsProblem(): string | null {
    const raw = process.env.GMAIL_ACCOUNTS;
    const inContainer = runningInContainer();
    const file = inContainer ? ".env.docker" : ".env.local";
    const restart = inContainer
        ? "then rebuild/restart the containers (docker compose up -d --force-recreate)"
        : "then restart the dev server";
    const note = inContainer
        ? " Note: the container is only given .env.docker — anything added to .env.local is not visible inside it."
        : "";

    if (!raw) {
        return `GMAIL_ACCOUNTS is not set. Add it to ${file} — `
            + `GMAIL_ACCOUNTS=[{"email":"you@yourdomain.com","appPassword":"abcd efgh ijkl mnop"}] — ${restart}.${note}`;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return `GMAIL_ACCOUNTS in ${file} isn't valid JSON. It must be a single line, e.g. `
            + `GMAIL_ACCOUNTS=[{"email":"you@yourdomain.com","appPassword":"abcd efgh ijkl mnop"}] — no outer quotes, no line breaks.`;
    }
    if (!Array.isArray(parsed)) {
        return `GMAIL_ACCOUNTS in ${file} must be a JSON array, even for one account: [{"email":"…","appPassword":"…"}]`;
    }
    if (parsed.length === 0) {
        return `GMAIL_ACCOUNTS in ${file} is an empty array — add at least one { "email", "appPassword" } entry.`;
    }
    // Present and parseable, but no entry had both required fields.
    return `GMAIL_ACCOUNTS in ${file} has ${parsed.length} entr${parsed.length === 1 ? "y" : "ies"}, `
        + `but none has both "email" and "appPassword". Check the key spelling — it is appPassword, not app_password.`;
}

function collectAddresses(list: unknown, into: string[]) {
    if (!Array.isArray(list)) return;
    for (const entry of list) {
        const address = (entry as { address?: string })?.address;
        if (address && address.includes("@")) into.push(address.toLowerCase().trim());
    }
}

/** Scans one account's entire Sent Mail folder. */
export async function scanSentMail(account: GmailAccount): Promise<SentScanResult> {
    const recipients = new Map<string, string>();
    const campaigns = new Map<string, SentCampaign>();
    let messagesScanned = 0;

    // An explicit host always wins; otherwise ask the domain's MX records who
    // actually hosts this mailbox.
    let host = account.host;
    let provider = account.host ? `${account.host} (from config)` : undefined;
    if (!host) {
        const resolved = await resolveImapHost(account.email);
        if (!resolved) {
            return {
                account: account.email,
                recipients,
                campaigns,
                messagesScanned,
                error: `Couldn't work out the IMAP server for ${account.email.split("@")[1] || account.email}. Add "host" to this account in GMAIL_ACCOUNTS (e.g. "host":"imap.gmail.com").`,
            };
        }
        host = resolved.host;
        provider = `${resolved.host} (${resolved.label})`;
    }

    const client = new ImapFlow({
        host,
        port: account.port ?? 993,
        secure: true,
        auth: { user: account.email, pass: account.appPassword },
        logger: false,
        // Large mailboxes are slow to hand over; the defaults are stricter than that.
        greetingTimeout: 30_000,
        socketTimeout: 120_000,
    });

    try {
        await client.connect();

        // Resolve Sent by its IMAP special-use flag rather than by name — the
        // folder is localised ("[Gmail]/Enviados" and so on) but the flag is not.
        const mailboxes = await client.list();
        const sent =
            mailboxes.find(m => m.specialUse === "\\Sent") ??
            mailboxes.find(m => /sent/i.test(m.path));

        if (!sent) {
            return { account: account.email, recipients, campaigns, messagesScanned, provider, error: "Could not find a Sent folder on this account" };
        }

        const lock = await client.getMailboxLock(sent.path);
        try {
            // Envelope-only fetch: Gmail returns parsed addresses and the date
            // without transferring message bodies, so an all-time scan stays cheap.
            for await (const message of client.fetch("1:*", { envelope: true })) {
                messagesScanned++;
                const envelope = message.envelope;
                if (!envelope) continue;

                const addresses: string[] = [];
                collectAddresses(envelope.to, addresses);
                collectAddresses(envelope.cc, addresses);
                collectAddresses(envelope.bcc, addresses);
                if (addresses.length === 0) continue;

                const sentAt = envelope.date ? new Date(envelope.date).toISOString() : new Date().toISOString();
                for (const address of addresses) {
                    // Keep the earliest send — that's the date first contact happened.
                    const existing = recipients.get(address);
                    if (!existing || sentAt < existing) recipients.set(address, sentAt);
                }

                const key = campaignKey(envelope.subject || "");
                let campaign = campaigns.get(key);
                if (!campaign) {
                    campaign = { key, sample: envelope.subject || "(no subject)", messages: 0, recipients: new Set(), firstSent: sentAt, lastSent: sentAt };
                    campaigns.set(key, campaign);
                }
                campaign.messages++;
                for (const address of addresses) campaign.recipients.add(address);
                if (sentAt < campaign.firstSent) campaign.firstSent = sentAt;
                if (sentAt > campaign.lastSent) campaign.lastSent = sentAt;
            }
        } finally {
            lock.release();
        }

        await client.logout();
        return { account: account.email, recipients, campaigns, messagesScanned, provider };
    } catch (error: any) {
        try { client.close(); } catch { /* already down */ }
        const message: string = error?.message || String(error);
        // Auth failure text from these servers is opaque; point at the real cause.
        const friendly = /AUTHENTICATIONFAILED|Invalid credentials|Application-specific|LOGIN failed/i.test(message)
            ? `Login rejected for ${account.email} at ${host}. On Google Workspace this usually means 2-Step Verification isn't on for the account, or the admin console has App Passwords disabled.`
            : /ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(message)
                ? `Couldn't reach ${host} for ${account.email} — wrong IMAP host? Set "host" explicitly in GMAIL_ACCOUNTS. (${message})`
                : message;
        return { account: account.email, recipients, campaigns, messagesScanned, provider, error: friendly };
    }
}
