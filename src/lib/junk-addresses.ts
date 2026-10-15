/**
 * Addresses that must never end up on a send list, however well they verify.
 *
 * The website crawler reads addresses out of a stranger's markup, and markup is
 * full of addresses that aren't the lead: placeholders left in a theme demo, the
 * payment widget's support desk, the registrar's privacy contact, the CMS vendor.
 * Several of these verify perfectly well over SMTP — they're real mailboxes, just
 * not the lead's — so verification can't catch them. Mailing one is a complaint
 * from a company with an abuse desk, not a wasted send.
 *
 * `rejectNonLeadEmails()` in worker.cjs applies the same idea at scrape time; this
 * is the equivalent for rows already sitting in the database.
 */

/** Local parts that only ever appear in placeholder markup. */
const PLACEHOLDER_LOCALS = new Set([
    "johndoe", "janedoe", "john.doe", "jane.doe", "youremail", "your.email",
    "yourname", "your.name", "email", "name", "user", "username", "someone",
    "firstname", "lastname", "test", "testing", "sample", "demo", "placeholder",
]);

/**
 * Domains that are never a coaching lead: placeholder domains, platform and CMS
 * vendors, registrars and privacy proxies, and social networks.
 */
const NON_LEAD_DOMAINS = new Set([
    // placeholders
    "example.com", "example.org", "example.net", "yourmail.com", "mysite.com",
    "yoursite.com", "domain.com", "yourdomain.com", "mydomain.com", "email.com",
    "yourcompany.com", "company.com", "website.com",
    // platforms, CMSes and site builders
    "wordpress.com", "wix.com", "squarespace.com", "weebly.com", "jouwweb.nl",
    "shopify.com", "godaddy.com", "surecart.com", "sentry.io", "meetfox.com",
    // registrars and privacy proxies
    "domainregistryinc.com", "domainsbyproxy.com", "whoisguard.com",
    "privacyprotect.org", "withheldforprivacy.com",
    // social networks — never a business contact address
    "facebook.com", "instagram.com", "linkedin.com", "twitter.com", "x.com",
    "youtube.com", "tiktok.com", "pinterest.com",
    // link shorteners and scheduling/newsletter hosts. The crawler picks these out
    // of a lead's own page — a Substack or Calendly URL parsed as an address — and
    // they are never a mailbox anyone reads.
    "bit.ly", "t.co", "wa.me", "linktr.ee", "lnkd.in", "tinyurl.com",
    "substack.com", "calendly.com", "mailchi.mp", "eepurl.com", "beehiiv.com",
    "medium.com", "gumroad.com", "skool.com",
    // membership bodies whose shared address leaks onto member sites
    "vistage.com",
]);

/** Why an address was rejected, for reporting. */
export type JunkReason =
    | "malformed"
    | "placeholder address"
    | "not a lead's domain"
    | "mangled by the crawler";

/**
 * Returns why this address can't be a lead's own mailbox, or null if it's fine.
 * Deliberately conservative: a role address like hello@ or info@ is usually the
 * real monitored inbox for a solo operator, so it is *not* junk.
 */
export function classifyJunkAddress(email: string): JunkReason | null {
    const address = (email || "").toLowerCase().trim();
    const at = address.lastIndexOf("@");
    if (at <= 0 || at === address.length - 1) return "malformed";

    const local = address.slice(0, at);
    const domain = address.slice(at + 1);

    if (!domain.includes(".") || domain.endsWith(".")) return "malformed";
    if (NON_LEAD_DOMAINS.has(domain)) return "not a lead's domain";
    if (PLACEHOLDER_LOCALS.has(local)) return "placeholder address";

    // Addresses stitched together out of adjacent page text — the crawler
    // occasionally swallows a phone number or a sentence into the local part.
    if (local.length > 40) return "mangled by the crawler";
    if (/\d{8,}/.test(local)) return "mangled by the crawler";

    // Escape sequences that leaked out of the page source instead of being decoded:
    // "u003ehelp@…" is a JSON-escaped ">" that was never unescaped, and "&amp;" and
    // friends arrive the same way from HTML attributes.
    if (/^u[0-9a-f]{4}/.test(local)) return "mangled by the crawler";
    if (/&(amp|quot|lt|gt|#\d+);/.test(local)) return "mangled by the crawler";

    return null;
}
