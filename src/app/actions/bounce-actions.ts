"use server";

import { getAllLeads, setLeadOutcome, updateLead } from "@/lib/db";
import { getGmailAccounts, describeGmailAccountsProblem } from "@/lib/gmail-sent";
import { scanBounces } from "@/lib/gmail-bounces";

export type BounceSyncReport = {
    ok: boolean;
    accounts: { email: string; messagesExamined: number; bounces: number; error?: string }[];
    /** Mailboxes confirmed not to exist. Only these are suppressed. */
    deadMailboxes: number;
    /**
     * The recipient refused *us* â€” spam scoring, blocklist, sender policy. These
     * leads are alive and must not be suppressed; a rising count here is a
     * deliverability problem with the sending domain, not a list-quality problem.
     */
    policyBlocked: number;
    /** Real mailbox, temporarily full. */
    mailboxFull: number;
    /** Deferrals â€” the platform retries these itself. */
    softFound: number;
    /** Addresses refused on policy grounds, for inspection. */
    policyExamples: { email: string; status?: string; diagnostic?: string }[];
    /** Bounced addresses that match a lead, now suppressed. */
    suppressed: number;
    /** Already suppressed before this run. */
    alreadySuppressed: number;
    /** Bounced addresses with no matching lead â€” sent from a list built elsewhere. */
    unmatched: number;
    examples: { email: string; status?: string; diagnostic?: string }[];
    /** Leads previously written off as bounced whose report was actually a policy refusal. */
    restored: number;
    restoredExamples: string[];
    error?: string;
};

function leadAddresses(lead: { email?: string; all_emails?: string }): string[] {
    const out: string[] = [];
    if (lead.email?.includes("@")) out.push(lead.email.toLowerCase().trim());
    if (lead.all_emails) {
        try {
            const parsed = JSON.parse(lead.all_emails);
            if (Array.isArray(parsed)) for (const e of parsed) out.push(String(e).toLowerCase().trim());
        } catch {
            for (const e of lead.all_emails.split(/[,;\s]+/)) {
                const trimmed = e.toLowerCase().trim();
                if (trimmed.includes("@")) out.push(trimmed);
            }
        }
    }
    return [...new Set(out)];
}

/**
 * Reads delivery-failure reports out of the connected inboxes and suppresses the
 * leads they name.
 *
 * Only permanent failures suppress. A 4.x.x status is a deferral the sending
 * platform will retry on its own, and treating it as a dead mailbox would throw
 * away a live lead over a temporary greylist.
 */
export async function syncBouncesAction(): Promise<BounceSyncReport> {
    const empty: BounceSyncReport = {
        ok: false, accounts: [], deadMailboxes: 0, policyBlocked: 0, mailboxFull: 0, softFound: 0,
        suppressed: 0, alreadySuppressed: 0, unmatched: 0, examples: [], policyExamples: [], restored: 0, restoredExamples: [],
    };

    const accounts = getGmailAccounts();
    if (accounts.length === 0) {
        return { ...empty, error: describeGmailAccountsProblem() ?? "No mailboxes configured." };
    }

    let leads;
    try {
        leads = await getAllLeads();
    } catch (e: any) {
        return { ...empty, error: `Couldn't read leads: ${e?.message || e}. Nothing was scanned.` };
    }

    // Sequential, like the sent-mail scan: providers throttle parallel full scans.
    const scans = [];
    for (const account of accounts) scans.push(await scanBounces(account));

    // Only confirmed-missing mailboxes are suppressed. A spam refusal means the
    // person is real and the sending domain has a problem â€” suppressing them would
    // delete a live lead and bury the actual signal.
    const dead = new Map<string, { status?: string; diagnostic?: string }>();
    const policyExamples: BounceSyncReport["policyExamples"] = [];
    let policyBlocked = 0;
    let mailboxFull = 0;
    let softFound = 0;

    for (const scan of scans) {
        for (const [address, bounce] of scan.bounces) {
            switch (bounce.kind) {
                case "MAILBOX_UNKNOWN":
                    dead.set(address, { status: bounce.status, diagnostic: bounce.diagnostic });
                    break;
                case "POLICY_BLOCK":
                    policyBlocked++;
                    if (policyExamples.length < 15) {
                        policyExamples.push({ email: address, status: bounce.status, diagnostic: bounce.diagnostic });
                    }
                    break;
                case "MAILBOX_FULL": mailboxFull++; break;
                default: softFound++;
            }
        }
    }

    const accountReports = scans.map(s => ({
        email: s.account,
        messagesExamined: s.messagesExamined,
        bounces: s.bounces.size,
        error: s.error,
    }));

    let suppressed = 0;
    let alreadySuppressed = 0;
    const matchedAddresses = new Set<string>();
    const examples: BounceSyncReport["examples"] = [];

    for (const lead of leads) {
        const hit = leadAddresses(lead).find(a => dead.has(a));
        if (!hit) continue;
        matchedAddresses.add(hit);

        if (lead.do_not_contact && lead.outcome === "BOUNCED") { alreadySuppressed++; continue; }
        try {
            await setLeadOutcome(lead.id, "BOUNCED");   // also sets do_not_contact
            suppressed++;
            if (examples.length < 25) examples.push({ email: hit, ...dead.get(hit) });
        } catch (e) {
            console.error("[BounceSync] failed to suppress", lead.id, e);
        }
    }

    // Give back leads that were suppressed as bounced but whose actual delivery
    // report says the recipient refused *us*, not that the mailbox is missing. The
    // inbox carries the server's own diagnostic text, which is more precise than a
    // platform's summary â€” and a lead wrongly written off is invisible forever
    // unless something looks for it.
    const policyAddresses = new Set(policyExamples.map(p => p.email));
    for (const scan of scans) {
        for (const [address, bounce] of scan.bounces) {
            if (bounce.kind === "POLICY_BLOCK") policyAddresses.add(address);
        }
    }

    let restored = 0;
    const restoredExamples: string[] = [];
    for (const lead of leads) {
        if (lead.outcome !== "BOUNCED") continue;
        const addresses = leadAddresses(lead);
        if (addresses.some(a => dead.has(a))) continue;          // genuinely dead, leave it
        if (!addresses.some(a => policyAddresses.has(a))) continue;
        try {
            await updateLead(lead.id, { outcome: null, do_not_contact: false });
            restored++;
            if (restoredExamples.length < 15) restoredExamples.push(String(lead.email));
        } catch (e) {
            console.error("[BounceSync] failed to restore", lead.id, e);
        }
    }

    return {
        ok: true,
        accounts: accountReports,
        restored,
        restoredExamples,
        deadMailboxes: dead.size,
        policyBlocked,
        mailboxFull,
        softFound,
        suppressed,
        alreadySuppressed,
        unmatched: [...dead.keys()].filter(a => !matchedAddresses.has(a)).length,
        examples,
        policyExamples,
    };
}
