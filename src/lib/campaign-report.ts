/**
 * Parses campaign reports exported from a sending platform (automailer.io,
 * Instantly, and anything else that exports one row per recipient).
 *
 * This is the only *authoritative* record of what was actually sent. The CRM's
 * `contacted` flag is set when a lead is pushed to a platform, which is not the
 * same event: a platform routinely uploads a contact and never sends to it —
 * daily caps, its own verification rejecting the address, a paused sequence, a
 * step the lead never reached. Reading Gmail's Sent folder can't close that gap
 * either, because a platform may send through a mailbox that isn't connected here.
 *
 * So the distinction this parser exists to preserve is between *uploaded* and
 * *sent*. Collapsing them is what inflated the contacted count in the first place.
 */

/** One recipient row from a platform's campaign report. */
export type CampaignRow = {
    email: string;
    firstName?: string;
    lastName?: string;
    /** The platform confirms at least one message actually went out. */
    sent: boolean;
    replied: boolean;
    bounced: boolean;
    /** ISO date of the reply, when the report carries one. */
    repliedAt?: string;
    /** Which file this row came from, for reporting. */
    source: string;
};

export type ParsedCampaignReport = {
    source: string;
    rows: CampaignRow[];
    /** Rows the file had but we couldn't use (no email column, blank address). */
    skipped: number;
    error?: string;
};

/**
 * RFC 4180 CSV reader. Hand-rolled rather than pulled in as a dependency because
 * the input is small, trusted, and these files carry quoted commas inside job
 * titles ("Jerassy Isackson, ACC") which a naive split would tear apart.
 */
export function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let inQuotes = false;

    // Strip a UTF-8 BOM; Excel adds one and it corrupts the first header name.
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (inQuotes) {
            if (char === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; }   // escaped quote
                else inQuotes = false;
            } else field += char;
            continue;
        }
        if (char === '"') inQuotes = true;
        else if (char === ",") { row.push(field); field = ""; }
        else if (char === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
        else if (char !== "\r") field += char;
    }
    if (field || row.length) { row.push(field); rows.push(row); }

    return rows.filter(r => r.some(cell => cell.trim()));
}

const isYes = (value: string | undefined) => (value || "").trim().toLowerCase() === "yes";

/**
 * Reads one campaign report. Column names differ between platforms and even
 * between exports from the same one, so headers are matched loosely and every
 * "Step N Sent" column is honoured — a lead is sent-to if *any* step went out.
 */
export function parseCampaignReport(text: string, source: string): ParsedCampaignReport {
    const table = parseCsv(text);
    if (table.length < 2) return { source, rows: [], skipped: 0, error: "File is empty or has no data rows." };

    const header = table[0].map(h => h.trim().toLowerCase());
    const columnFor = (...names: string[]) => {
        for (const name of names) {
            const at = header.indexOf(name);
            if (at !== -1) return at;
        }
        return -1;
    };

    const emailAt = columnFor("email", "email address", "lead email", "recipient");
    if (emailAt === -1) {
        return { source, rows: [], skipped: table.length - 1, error: "No email column found — is this a campaign report?" };
    }

    const statusAt = columnFor("status", "lead status");
    const repliedAt = columnFor("replied", "has replied");
    const bouncedAt = columnFor("bounced", "is bounced", "hard bounce");
    const replyDateAt = columnFor("reply date", "replied at", "reply_date");
    const firstAt = columnFor("first name", "firstname", "first_name");
    const lastAt = columnFor("last name", "lastname", "last_name");

    // Any column that records a step going out. Reports vary in how many steps
    // they include, and a report trimmed to step 1 must still read correctly.
    const sentColumns = header
        .map((name, index) => ({ name, index }))
        .filter(c => /^step \d+ sent$/.test(c.name) || c.name === "sent" || c.name === "emails sent")
        .map(c => c.index);

    const rows: CampaignRow[] = [];
    let skipped = 0;

    for (const record of table.slice(1)) {
        const email = (record[emailAt] || "").toLowerCase().trim();
        if (!email.includes("@")) { skipped++; continue; }

        const status = (record[statusAt] || "").trim().toLowerCase();
        // "Contacted" is the platform's own summary; a step column is the evidence.
        // Either alone is enough, but neither present means it was never sent.
        const sent = sentColumns.some(index => isYes(record[index])) || status === "contacted";

        const rawReplyDate = replyDateAt === -1 ? "" : (record[replyDateAt] || "").trim();
        const parsedReplyDate = rawReplyDate ? new Date(rawReplyDate) : null;

        rows.push({
            email,
            firstName: firstAt === -1 ? undefined : (record[firstAt] || "").trim() || undefined,
            lastName: lastAt === -1 ? undefined : (record[lastAt] || "").trim() || undefined,
            sent,
            replied: isYes(record[repliedAt]) || status === "replied",
            bounced: isYes(record[bouncedAt]) || status === "bounced",
            repliedAt: parsedReplyDate && !Number.isNaN(parsedReplyDate.valueOf()) ? parsedReplyDate.toISOString() : undefined,
            source,
        });
    }

    return { source, rows, skipped };
}

export type MergedCampaignData = {
    /** Everyone the platform holds a record for, sent or not. */
    uploaded: Set<string>;
    /** Everyone the platform confirms a message went out to. */
    sent: Set<string>;
    replied: Map<string, string | undefined>;
    bounced: Set<string>;
    files: { source: string; rows: number; sent: number; skipped: number; error?: string }[];
};

/**
 * Folds many reports into one view. Reports overlap heavily — the same campaign
 * re-exported after more of it had run — so every signal is merged with OR:
 * once a platform has said a message went out, a later export that omits the row
 * can't take that back.
 */
export function mergeCampaignReports(reports: ParsedCampaignReport[]): MergedCampaignData {
    const merged: MergedCampaignData = {
        uploaded: new Set(), sent: new Set(), replied: new Map(), bounced: new Set(), files: [],
    };

    for (const report of reports) {
        merged.files.push({
            source: report.source,
            rows: report.rows.length,
            sent: report.rows.filter(r => r.sent).length,
            skipped: report.skipped,
            error: report.error,
        });
        for (const row of report.rows) {
            merged.uploaded.add(row.email);
            if (row.sent) merged.sent.add(row.email);
            if (row.bounced) merged.bounced.add(row.email);
            if (row.replied) {
                // Keep the earliest reply date we've seen for this address.
                const existing = merged.replied.get(row.email);
                if (!merged.replied.has(row.email) || (row.repliedAt && (!existing || row.repliedAt < existing))) {
                    merged.replied.set(row.email, row.repliedAt ?? existing);
                }
            }
        }
    }

    return merged;
}
