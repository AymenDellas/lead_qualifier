import { FREE_PROVIDERS } from "@/lib/email-constants";
import { classifyJunkAddress } from "@/lib/junk-addresses";

/**
 * The three fields these rules read, described structurally rather than as a
 * `Pick<LeadRecord>`.
 *
 * `LeadRecord` is declared twice — once in `lib/db.ts` and once, divergently,
 * inside `CrmDatabase.tsx` — and a `Pick` of the server type refuses the client
 * copy over fields these functions never look at. Naming only what is actually
 * read lets one implementation serve both callers, which is the entire reason
 * this module exists.
 */
type VerifiedAddress = {
    email: string;
    email_status?: string | null;
    email_verification_reason?: string | null;
};

/**
 * How much is actually proven about an address on the send list.
 *
 * Three tiers, in descending order of evidence. They are named rather than
 * collapsed into a boolean because the whole failure this codebase keeps
 * relearning is that "verified" stops meaning anything the moment two different
 * levels of proof share one label.
 */
export type SendTier = "PROVEN" | "RISKY" | "UNVERIFIABLE";

/**
 * Can this address go out in the "we were never able to check it" tier?
 *
 * UNKNOWN means the probe produced no verdict about the mailbox — most often
 * because the recipient server refused *this sending host* instead of judging the
 * address. That is not evidence against the lead, and it is not something the
 * lead can fix. On the current deployment 215 of 388 UNKNOWN leads sit on
 * Microsoft-hosted domains that answer every probe from this IP with
 * `550 5.7.1 ... blocked using Spamhaus` — identically for a real address and for
 * a random control, which is exactly why nothing can be concluded.
 *
 * These are real leads held hostage by an infrastructure problem. But they are
 * still *unproven*, and unproven addresses exported as VALID are what caused the
 * bounce that started all of this. So they are never promoted, never included by
 * default, and never exported without the tier written onto the row — the point
 * is to hand them to a sending platform that verifies from its own clean IPs,
 * not to pretend they were checked here.
 *
 * The exclusions below stay disqualifying even when nothing could be proven,
 * because each is a judgement about the *address* rather than about whether our
 * probe got through.
 *
 * This lives in `lib` because the export exists twice — the API route at
 * `/api/crm/leads/qualified` and the CRM's own client-side CSV button. The
 * `resolveCountry` duplication in this repo already shows what happens when two
 * copies of one rule drift: client and server quietly disagree about which leads
 * exist.
 */
export function isExportableUnverifiable(lead: VerifiedAddress): boolean {
    if (lead.email_status !== "UNKNOWN") return false;
    if (!lead.email) return false;

    const email = lead.email.toLowerCase().trim();
    const domain = email.split("@")[1] ?? "";
    if (!domain) return false;

    // Free providers all validate recipients properly. Failing to get an answer
    // from one means the probe was refused, not that the address is plausible —
    // and a guessed gmail.com address is a guess whatever the server said.
    if (FREE_PROVIDERS.has(domain)) return false;

    // Never a person, whatever the server said.
    if (classifyJunkAddress(email)) return false;

    // "No MX records" and "Invalid email syntax" resolve to INVALID, so anything
    // still UNKNOWN did reach a mail server. Guarded anyway, so a row written
    // before that classification existed cannot slip through.
    const reason = lead.email_verification_reason ?? "";
    if (/no MX records|Invalid email syntax|System address/i.test(reason)) return false;

    return true;
}

/** True when the server refused this host rather than judging the mailbox. */
export function wasRefusedByHost(lead: VerifiedAddress): boolean {
    return /refused our probe/i.test(lead.email_verification_reason ?? "");
}
