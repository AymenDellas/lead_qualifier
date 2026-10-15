import "server-only";

import { ImapFlow } from "imapflow";
import { getGmailAccounts, resolveImapHost, type GmailAccount } from "./gmail-sent";

/**
 * Reads bounce notifications (NDRs) out of a mailbox's INBOX.
 *
 * This exists because SMTP verification is not always available. A verifier needs
 * to connect from a host with a static IP, a resolvable HELO hostname, and a
 * matching PTR record; run it from a consumer connection and every recipient server
 * refuses the probe on policy grounds, so nothing can be proven either way. When
 * that is the situation, the mail you actually send is the only reliable signal —
 * and a bounce is the mailbox telling you directly that it doesn't exist.
 *
 * Acting on that automatically matters more than it looks. Repeatedly mailing dead
 * addresses is the fastest way to wreck a sending domain's reputation, and the
 * damage is cumulative and slow to undo. One pass over the inbox after each send
 * keeps the list clean without any verification infrastructure at all.
 */

/**
 * Why a message came back. A 5.x.x status is *not* enough to conclude the mailbox
 * is dead — the same permanent class covers "no such user" and "we think you are a
 * spammer", and those demand opposite responses. Suppressing on a spam refusal
 * deletes a perfectly live lead and hides the deliverability problem that caused
 * it; the verifier draws this same line in `classifyReject`.
 */
export type BounceKind =
    /** The mailbox does not exist. The only kind that justifies suppression. */
    | "MAILBOX_UNKNOWN"
    /** The recipient refused *us* — spam scoring, blocklist, sender policy. */
    | "POLICY_BLOCK"
    /** Real mailbox, temporarily unable to accept. Retry later. */
    | "MAILBOX_FULL"
    /** Deferral; the sending platform retries on its own. */
    | "TRANSIENT";

/** A recipient a mail server refused, with the reason it gave. */
export type BouncedRecipient = {
    address: string;
    /** RFC 3463 enhanced status code (e.g. "5.1.1"), when the report carries one. */
    status?: string;
    kind: BounceKind;
    diagnostic?: string;
    seenAt: string;
};

/**
 * Separates "this mailbox doesn't exist" from "this server refused us". Both
 * arrive as 5.x.x, and telling them apart is the whole value of reading bounces.
 */
export function classifyBounce(status: string | undefined, diagnostic: string | undefined): BounceKind {
    const text = (diagnostic || "").toLowerCase();

    // The diagnostic text is read before the status code, because plenty of servers
    // use 5.7.0 as a catch-all for everything they refuse — including "no mailbox by
    // that name". Where the text says plainly what happened, it is the better source;
    // only unambiguous phrases are trusted here.
    if (/(user unknown|no such user|no such address|no such recipient|does not exist|doesn't exist|recipient not found|unknown recipient|invalid recipient|unrouteable address|no mailbox by that name|mailbox not found|recipient address rejected)/.test(text)) {
        return "MAILBOX_UNKNOWN";
    }
    // Rate limits and full mailboxes are temporary, whatever code they arrive under —
    // the mailbox is real and will accept mail again later.
    if (/(exceeded .*limit|rate limit|too many messages|try again later|temporarily (deferred|rejected|unavailable)|over quota|quota exceeded|mailbox full|insufficient system storage)/.test(text)) {
        return "MAILBOX_FULL";
    }
    if (/(spam|blocked|blacklist|blocklist|reputation|bulk mail|not authori[sz]ed|access denied|policy reasons|rejected for policy)/.test(text)) {
        return "POLICY_BLOCK";
    }

    if (status) {
        if (status.startsWith("4")) return "TRANSIENT";
        // 5.1.x is the recipient-address family; 5.5.1 is "unknown user".
        if (/^5\.1\.(1|2|3|6|10)$/.test(status) || status === "5.5.1") return "MAILBOX_UNKNOWN";
        if (status === "5.2.2" || status === "5.2.122") return "MAILBOX_FULL";
        // 5.7.x is the security/policy family; 5.3.x is system/message limits.
        if (status.startsWith("5.7") || status.startsWith("5.3")) return "POLICY_BLOCK";
    }

    // Unrecognised failure: report it, never suppress a lead on a guess.
    return "POLICY_BLOCK";
}

export type BounceScanResult = {
    account: string;
    bounces: Map<string, BouncedRecipient>;
    messagesExamined: number;
    error?: string;
};

/** Senders that generate delivery reports. Matched loosely — the local part varies. */
const BOUNCE_SENDERS = /(mailer-daemon|postmaster|mail-daemon|mailerdaemon)@/i;

const BOUNCE_SUBJECTS = /(undeliverable|undelivered|delivery status|delivery failure|returned mail|failure notice|mail delivery|could not be delivered|delivery has failed)/i;

/**
 * Pulls the failed recipient out of a delivery report. RFC 3464 reports carry
 * `Final-Recipient:` and `Status:` fields, which is the only part of a bounce with
 * a defined shape — subject lines and human-readable text vary by provider.
 */
export function parseDeliveryReport(source: string, seenAt: string): BouncedRecipient[] {
    const found = new Map<string, BouncedRecipient>();

    // Split into per-recipient blocks so a status is attributed to the right address.
    const blocks = source.split(/\n\s*\n/);
    for (const block of blocks) {
        const recipient = block.match(/^(?:Final|Original)-Recipient:\s*(?:rfc822;)?\s*([^\s<>]+@[^\s<>]+)/im);
        if (!recipient) continue;

        const address = recipient[1].toLowerCase().replace(/[.,;]+$/, "");
        const status = block.match(/^Status:\s*([245]\.\d+\.\d+)/im)?.[1];
        const action = block.match(/^Action:\s*(\w+)/im)?.[1]?.toLowerCase();
        const diagnostic = block.match(/^Diagnostic-Code:\s*(.+)$/im)?.[1]?.trim();

        // "delayed" is explicitly a deferral regardless of what else the block says.
        const kind = action === "delayed" ? "TRANSIENT" : classifyBounce(status, diagnostic);

        found.set(address, { address, status, kind, diagnostic, seenAt });
    }

    return [...found.values()];
}

/** Scans one mailbox's INBOX for delivery reports. */
export async function scanBounces(account: GmailAccount, sinceDays = 90): Promise<BounceScanResult> {
    const bounces = new Map<string, BouncedRecipient>();
    let messagesExamined = 0;

    let host = account.host;
    if (!host) {
        const resolved = await resolveImapHost(account.email);
        if (!resolved) {
            return { account: account.email, bounces, messagesExamined, error: `Couldn't work out the IMAP server for ${account.email}.` };
        }
        host = resolved.host;
    }

    const client = new ImapFlow({
        host,
        port: account.port ?? 993,
        secure: true,
        auth: { user: account.email, pass: account.appPassword },
        logger: false,
        greetingTimeout: 30_000,
        socketTimeout: 120_000,
    });

    try {
        await client.connect();
        const lock = await client.getMailboxLock("INBOX");
        try {
            const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);

            // Ask the server to find the candidates rather than pulling the whole
            // inbox down — a bounce is a tiny fraction of the mail in there.
            const candidates = new Set<number>();
            for (const term of [{ since, from: "mailer-daemon" }, { since, from: "postmaster" }]) {
                try {
                    for (const uid of await client.search(term, { uid: true }) || []) candidates.add(uid);
                } catch { /* server may reject a term; the others still apply */ }
            }

            if (candidates.size === 0) {
                lock.release();
                await client.logout();
                return { account: account.email, bounces, messagesExamined };
            }

            for await (const message of client.fetch(
                [...candidates].join(","),
                { envelope: true, source: true },
                { uid: true },
            )) {
                messagesExamined++;
                const envelope = message.envelope;
                const from = envelope?.from?.[0]?.address || "";
                const subject = envelope?.subject || "";

                // Belt and braces: the search already filtered by sender, but a
                // forwarded or quoted message could slip through.
                if (!BOUNCE_SENDERS.test(from) && !BOUNCE_SUBJECTS.test(subject)) continue;

                const source = message.source?.toString("utf8");
                if (!source) continue;

                const seenAt = envelope?.date ? new Date(envelope.date).toISOString() : new Date().toISOString();
                for (const bounce of parseDeliveryReport(source, seenAt)) {
                    // The sender's own address appears in every report; never suppress it.
                    if (bounce.address === account.email.toLowerCase()) continue;
                    const existing = bounces.get(bounce.address);
                    // A confirmed missing mailbox outranks any other verdict; anything
                    // else is only recorded if we had nothing for this address yet.
                    if (!existing || (bounce.kind === "MAILBOX_UNKNOWN" && existing.kind !== "MAILBOX_UNKNOWN")) {
                        bounces.set(bounce.address, bounce);
                    }
                }
            }
        } finally {
            lock.release();
        }

        await client.logout();
        return { account: account.email, bounces, messagesExamined };
    } catch (error: any) {
        try { client.close(); } catch { /* already down */ }
        return { account: account.email, bounces, messagesExamined, error: error?.message || String(error) };
    }
}

export { getGmailAccounts };
