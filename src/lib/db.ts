import { pool } from './pg_setup';
import { syncHunterContacted } from './hunter-contact-sync';
import type { ScoreReason } from './discovery-score';
import { extractDiscoveryName } from './discovery-name';
import type { ProspectAssessment, ProspectReview } from './prospect-qualification.cjs';

/**
 * Evidence behind a `contacted` flag. PLATFORM = a sending platform's own campaign
 * report confirmed the send; GMAIL = the address was found in a connected mailbox's
 * Sent folder; MANUAL = a person ticked the box for this one lead; LINKEDIN =
 * the operator recorded a DM after sending it; HUNTER = the lead is already
 * managed in Hunter and reserved against new outreach, without asserting a send.
 *
 * A NULL source means the flag came from a *bulk push* — the lead was queued to a
 * sending platform and flagged on the way out. That proves nothing about whether a
 * message ever went, and treating it as contact is what silently buried hundreds of
 * qualified leads.
 */
export type ContactedSource = 'PLATFORM' | 'GMAIL' | 'MANUAL' | 'LINKEDIN' | 'HUNTER';

/**
 * Whether a lead has contact evidence or is reserved in Hunter. Both exclude a
 * lead from new outreach; a bulk sending-platform queue flag alone does not.
 */
export function isProvenContacted(lead: Pick<LeadRecord, 'contacted' | 'contacted_source'>): boolean {
    return Boolean(lead.contacted && lead.contacted_source);
}

export interface LeadRecord {
    id: string;
    linkedin_url: string;
    first_name: string;
    last_name: string;
    company: string;
    website: string;
    website_source: string;
    email: string;
    all_emails: string;
    email_status: string;
    email_verification_method?: string | null;
    email_verification_reason?: string | null;
    email_verification_score?: number | null;
    email_verified_at?: string | null;
    email_verification_expires_at?: string | null;
    hook: string;
    /** Where the hook came from — 'website' | 'linkedin_post' | 'manual'. Lets you
     *  compare reply rates per hook style instead of guessing. */
    hook_source?: string | null;
    pipeline_status: string;
    location: string;
    contacted: boolean;
    /** Already managed in Hunter; excludes fresh outreach even before a DM. */
    in_hunter?: boolean;
    contacted_at?: string | null;
    linkedin_dm_at?: string | null;
    /**
     * Why this lead counts as contacted. PLATFORM = a sending platform's campaign
     * report confirmed the send (authoritative). GMAIL = found in Sent Mail.
     * LINKEDIN = a manually recorded DM. NULL = queued to a sending platform.
     */
    contacted_source?: ContactedSource | null;
    replied_at?: string | null;
    booked_at?: string | null;
    /** Terminal result of the outreach: REPLIED | BOOKED | NOT_INTERESTED | BOUNCED | NO_REPLY. */
    outcome?: string | null;
    /** Suppression flag. Never exported to a send list, whatever else is true. */
    do_not_contact?: boolean;
    created_at: string;

    // ── Discovery provenance (first-touch; see insertDiscoveryProvenance) ──
    /** The exact dork that surfaced this profile first. */
    discovery_query?: string | null;
    /** Stable template id, e.g. 'id-founder'. Never an array index. */
    discovery_template_id?: string | null;
    /** The job title the query was built from. */
    discovery_niche?: string | null;
    /** The location the query was built from — distinct from `location`, which is free text. */
    discovery_location?: string | null;
    discovery_page?: number | null;
    discovery_rank?: number | null;
    discovery_title?: string | null;
    discovery_snippet?: string | null;
    discovery_run_id?: string | null;
    discovered_at?: string | null;
    /** Times a distinct template has re-found this profile. Well-indexed ⇒ probably real. */
    discovery_seen_count?: number | null;

    // ── Tier-A fit score ──
    /** 0-100 SERP-time prediction. Ranks the queue; never gates the send list. */
    fit_score?: number | null;
    /** `[{id:'A1',w:25,hit:'business coach'}, …]` — a score you can't explain can't be tuned. */
    fit_reasons?: ScoreReason[] | null;
    scored_at?: string | null;
    /** Business evidence; independent of mailbox verification and sales outcomes. */
    prospect_assessment?: ProspectAssessment | null;
    prospect_review?: ProspectReview | null;
    prospect_researched_at?: string | null;
}

/** Pipeline stages. A lead is placed by the scraper and stays put; email
 *  verification annotates it rather than moving it. */
export const PIPELINE_STATUSES = ['INBOX', 'QUALIFIED', 'REVIEW', 'NURTURE', 'NOT_QUALIFIED'] as const;

/** Rows written before the OUTREACH stage was retired still carry it. */
export const LEGACY_QUALIFIED_STATUS = 'OUTREACH';

export function isQualifiedStage(status: string | undefined | null): boolean {
    return status === 'QUALIFIED' || status === LEGACY_QUALIFIED_STATUS;
}

/**
 * Which stage an upsert should land on. Stage placement is *monotonic on the
 * discovery path*: finding a profile again is not new information about where it
 * belongs, so an incoming 'INBOX' never overwrites a stage the scraper already
 * decided.
 *
 * Without this rule, re-finding a lead demotes it. The dork engine writes an
 * explicit `pipeline_status: 'INBOX'` on every hit, and since discovery rebuilds
 * the same query bank and restarts at page 1 on every run, it re-finds a large
 * share of the same profiles each time. A qualified, hooked, verified lead would
 * silently drop back to INBOX — vanishing from its region tab, failing the send
 * gate, and re-entering the scrape pool to burn worker budget on work already
 * done. Nothing records that the row was ever QUALIFIED, so the loss is invisible
 * and unrecoverable.
 *
 * This is deliberately *not* applied in `updateLead`: pushing a lead back to the
 * inbox by hand (`pushLeadsToInboxAction`) is an explicit operator decision, and
 * an operator is allowed to move a lead backwards. Only the automated upsert path
 * is constrained — the same asymmetry as `toggleContactedAction` stamping MANUAL
 * while `bulkMarkContacted` deliberately stamps nothing.
 */
export function resolvePipelineStatus(
    incoming: string | undefined | null,
    existing: string | undefined | null,
): string {
    if (!incoming) return existing || 'INBOX';
    if (incoming === 'INBOX' && existing && existing !== 'INBOX') return existing;
    return incoming;
}

export type EmailVerificationUpdate = {
    expectedEmail?: string;
    status: "VALID" | "INVALID" | "RISKY" | "UNKNOWN";
    method?: string;
    reason: string;
    score: number;
    checkedAt?: string;
    expiresAt?: string;
};

export function generateId(): string {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

export function determinePipelineStatus(email: string, hook: string, currentStatus?: string): string {
    return currentStatus || 'INBOX';
}

const OPTIONAL_LEAD_FIELDS = [
    'linkedin_url', 'first_name', 'last_name', 'company', 'website',
    'website_source', 'all_emails', 'email_status', 'location', 'contacted',
    'hook_source', 'outcome', 'do_not_contact', 'replied_at', 'booked_at',
    'contacted_source',
] as const;

/**
 * Builds `field = $n` clauses only for keys actually present on `source`. A plain
 * COALESCE($n, column) can't tell "caller omitted this field" apart from "caller
 * explicitly wants it cleared to null" — both arrive as SQL NULL — so it silently
 * keeps the old value either way. Building the SET list from the keys that were
 * actually passed in fixes that: omit a field to leave it alone, pass null to clear it.
 */
function buildOptionalSet(source: Partial<LeadRecord>, startIndex: number): { sql: string; values: unknown[] } {
    const clauses: string[] = [];
    const values: unknown[] = [];
    let i = startIndex;
    for (const field of OPTIONAL_LEAD_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(source, field)) {
            if (field === 'contacted') {
                // Stamp the first time a lead is marked contacted, so reply/booking
                // rates can be measured against a real send date later. Re-marking
                // an already-contacted lead must not move the original timestamp.
                clauses.push(`contacted = $${i}`);
                clauses.push(`contacted_at = CASE WHEN $${i}::boolean AND contacted_at IS NULL THEN CURRENT_TIMESTAMP ELSE contacted_at END`);
                // Un-marking a lead must drop the evidence with it, or a later sync
                // would read stale provenance for a flag that no longer exists.
                if (!Object.prototype.hasOwnProperty.call(source, 'contacted_source'))
                    clauses.push(`contacted_source = CASE WHEN $${i}::boolean THEN contacted_source ELSE NULL END`);
            } else {
                clauses.push(`${field} = $${i}`);
            }
            values.push((source as Record<string, unknown>)[field]);
            i++;
        }
    }
    return { sql: clauses.join(', '), values };
}

/** Proof belongs to an address, and must be revoked atomically when it changes. */
function protectEmailProof(optionalSql: string, emailIndex: number): string {
    const changed = `LOWER(TRIM(COALESCE(email,''))) IS DISTINCT FROM LOWER(TRIM(COALESCE($${emailIndex}::text,'')))`;
    const status = optionalSql.match(/email_status = (\$\d+)/);
    const clauses = status
        ? [optionalSql.replace(status[0], `email_status = CASE WHEN ${changed} THEN 'UNVERIFIED' ELSE ${status[1]} END`)]
        : [optionalSql, `email_status = CASE WHEN ${changed} THEN 'UNVERIFIED' ELSE email_status END`];
    for (const field of ['email_verification_method', 'email_verification_reason', 'email_verification_score', 'email_verified_at', 'email_verification_expires_at']) {
        clauses.push(`${field} = CASE WHEN ${changed} THEN NULL ELSE ${field} END`);
    }
    return clauses.filter(Boolean).join(', ');
}

/** Unsupported legacy labels must not claim a positive or negative verdict. */
export async function revokeUnprovenEmailLabels(client: Pick<import('pg').PoolClient, 'query'> = pool): Promise<number> {
    const legacy = await client.query(`UPDATE leads SET email_status='UNVERIFIED',
        email_verification_expires_at=NULL, email_verification_score=NULL,
        email_verification_reason='Label reset: legacy verdict had no verification evidence'
        WHERE email_status IN ('INVALID','RISKY') AND email_verification_method IS NULL
            AND NULLIF(TRIM(email_verification_reason),'') IS NULL
            AND COALESCE(outcome,'')<>'BOUNCED' AND do_not_contact IS NOT TRUE RETURNING id`);
    const result = await client.query(`UPDATE leads SET email_status='UNVERIFIED',
        email_verification_expires_at=NULL, email_verification_score=NULL,
        email_verification_reason=CONCAT_WS(' · ',NULLIF(email_verification_reason,''),'Label reset: no stored verification proof')
        WHERE email_status='VALID' AND (COALESCE(email_verification_method,'') NOT IN ('SMTP_DIRECT','QUICKEMAILVERIFICATION')
            OR email_verified_at IS NULL OR email_verification_expires_at IS NULL)
        RETURNING id`);
    return (result.rowCount || 0) + (legacy.rowCount || 0);
}

export async function insertOrUpdateLead(lead: Partial<LeadRecord>): Promise<LeadRecord> {
    const email = lead.email || '';
    const hook = lead.hook || '';
    const pipelineStatus = lead.pipeline_status || 'INBOX';
    const linkedin_url = lead.linkedin_url || '';
    const id = lead.id || generateId();

    const client = await pool.connect();
    try {
        let existing;
        if (linkedin_url) {
            const res = await client.query('SELECT * FROM leads WHERE linkedin_url = $1', [linkedin_url]);
            existing = res.rows[0];
        } else if (lead.id) {
            const res = await client.query('SELECT * FROM leads WHERE id = $1', [lead.id]);
            existing = res.rows[0];
        }

        if (existing) {
            const newEmail = lead.email !== undefined ? lead.email : existing.email;
            const newHook = lead.hook !== undefined ? lead.hook : existing.hook;
            // Never demote on a re-find — see resolvePipelineStatus.
            const newStatus = resolvePipelineStatus(lead.pipeline_status, existing.pipeline_status);

            const { sql: optionalSql, values: optionalValues } = buildOptionalSet(lead, 1);
            const n = optionalValues.length;
            const setClauses = [protectEmailProof(optionalSql, n + 1), `email = $${n + 1}`, `hook = $${n + 2}`, `pipeline_status = $${n + 3}`]
                .filter(Boolean)
                .join(', ');

            const updateRes = await client.query(`
                UPDATE leads
                SET ${setClauses}
                WHERE id = $${n + 4}
                RETURNING *
            `, [...optionalValues, newEmail, newHook, newStatus, existing.id]);
            return updateRes.rows[0];
        } else {
            const insertRes = await client.query(`
                INSERT INTO leads (
                    id, linkedin_url, first_name, last_name, company, website, website_source,
                    email, all_emails, email_status, hook, hook_source, pipeline_status, location, contacted
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
                RETURNING *
            `, [
                id, linkedin_url, lead.first_name || '', lead.last_name || '', lead.company || '',
                lead.website || '', lead.website_source || '', email, lead.all_emails || '',
                lead.email_status || 'UNVERIFIED', hook, lead.hook_source || null, pipelineStatus,
                lead.location || '', lead.contacted || false
            ]);
            return insertRes.rows[0];
        }
    } finally {
        client.release();
    }
}

export async function bulkInsertOrUpdateLeads(newLeads: Partial<LeadRecord>[]): Promise<LeadRecord[]> {
    const results: LeadRecord[] = [];
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const lead of newLeads) {
            // Simplified logic: reuse insertOrUpdateLead logic but inside transaction
            // To properly do this, we'll execute queries individually. For thousands of rows this is ok if pooled.
            const email = lead.email || '';
            const hook = lead.hook || '';
            const pipelineStatus = lead.pipeline_status || 'INBOX';
            const linkedin_url = lead.linkedin_url || '';
            const id = lead.id || generateId();

            let existing;
            if (linkedin_url) {
                const res = await client.query('SELECT * FROM leads WHERE linkedin_url = $1', [linkedin_url]);
                existing = res.rows[0];
            } else if (lead.id) {
                const res = await client.query('SELECT * FROM leads WHERE id = $1', [lead.id]);
                existing = res.rows[0];
            }

            if (existing) {
                const newEmail = lead.email !== undefined ? lead.email : existing.email;
                const newHook = lead.hook !== undefined ? lead.hook : existing.hook;
                // Never demote on a re-find — see resolvePipelineStatus.
                const newStatus = resolvePipelineStatus(lead.pipeline_status, existing.pipeline_status);

                const { sql: optionalSql, values: optionalValues } = buildOptionalSet(lead, 1);
                const n = optionalValues.length;
                const setClauses = [protectEmailProof(optionalSql, n + 1), `email = $${n + 1}`, `hook = $${n + 2}`, `pipeline_status = $${n + 3}`]
                    .filter(Boolean)
                    .join(', ');

                const updateRes = await client.query(`
                    UPDATE leads
                    SET ${setClauses}
                    WHERE id = $${n + 4}
                    RETURNING *
                `, [...optionalValues, newEmail, newHook, newStatus, existing.id]);
                results.push(updateRes.rows[0]);
            } else {
                const insertRes = await client.query(`
                    INSERT INTO leads (
                        id, linkedin_url, first_name, last_name, company, website, website_source,
                        email, all_emails, email_status, hook, hook_source, pipeline_status, location, contacted
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
                    RETURNING *
                `, [
                    id, linkedin_url, lead.first_name || '', lead.last_name || '', lead.company || '',
                    lead.website || '', lead.website_source || '', email, lead.all_emails || '',
                    lead.email_status || 'UNVERIFIED', hook, lead.hook_source || null, pipelineStatus,
                    lead.location || '', lead.contacted || false
                ]);
                results.push(insertRes.rows[0]);
            }
        }
        await client.query('COMMIT');
        return results;
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}

export async function updateLead(id: string, updates: Partial<LeadRecord>): Promise<LeadRecord> {
    const client = await pool.connect();
    try {
        const membership = await syncHunterContacted(client, [id]);
        if (updates.contacted === false && membership.memberIds.has(id))
            throw new Error('This lead is already managed in Case Study Hunter and remains marked contacted here.');
        const res = await client.query('SELECT * FROM leads WHERE id = $1', [id]);
        const existing = res.rows[0];
        if (!existing) throw new Error("Lead not found");

        const newEmail = updates.email !== undefined ? updates.email : existing.email;
        const newHook = updates.hook !== undefined ? updates.hook : existing.hook;
        const newStatus = updates.pipeline_status || existing.pipeline_status || 'INBOX';

        const { sql: optionalSql, values: optionalValues } = buildOptionalSet(updates, 1);
        const n = optionalValues.length;
        const setClauses = [protectEmailProof(optionalSql, n + 1), `email = $${n + 1}`, `hook = $${n + 2}`, `pipeline_status = $${n + 3}`]
            .filter(Boolean)
            .join(', ');

        const updateRes = await client.query(`
            UPDATE leads
            SET ${setClauses}
            WHERE id = $${n + 4}
            RETURNING *
        `, [...optionalValues, newEmail, newHook, newStatus, id]);
        return { ...updateRes.rows[0], in_hunter: membership.memberIds.has(id) };
    } finally {
        client.release();
    }
}

/** The provenance and score recorded when a discovery run first surfaces a profile. */
export type DiscoveryProvenance = {
    linkedin_url: string;
    location: string;
    query: string;
    templateId: string;
    niche: string;
    discoveryLocation: string;
    page: number;
    rank: number;
    title: string;
    snippet: string;
    runId: string;
    fitScore: number;
    fitReasons: ScoreReason[];
};

/**
 * Records a discovered profile with first-touch attribution.
 *
 * Provenance is written **once**, on insert. If a second template re-finds the
 * same profile and overwrites, credit reassigns to whichever template happened to
 * run last, and every per-template number — qualified-per-credit above all —
 * becomes meaningless. A re-find increments `discovery_seen_count` instead, which
 * is a signal in its own right (feeds weight A8).
 *
 * Additive exceptions to "write once":
 *
 *  - `fit_score`/`fit_reasons` are backfilled when the existing row has none. That
 *    is how the pre-existing backlog acquires scores at all: those rows were
 *    written before scoring existed and would otherwise sort last forever under
 *    `NULLS LAST`, so re-finding one is the only chance to rank it.
 *  - A *higher* score from a later sighting wins. The score is a property of the
 *    profile, not of the query, so the best evidence seen should stand — while the
 *    provenance columns still credit the template that found it first.
 *  - Missing names are filled from the displayed search title. Existing names
 *    from scraping or manual edits are preserved.
 *
 * Uses the codebase's existing read-then-write shape rather than ON CONFLICT: the
 * partial unique index on `linkedin_url` is created best-effort in `createSchema`
 * and is skipped whenever duplicates exist, so it cannot be relied on as a
 * conflict target.
 */
export async function insertDiscoveryProvenance(p: DiscoveryProvenance): Promise<{ inserted: boolean }> {
    const name = extractDiscoveryName(p.title);
    const client = await pool.connect();
    try {
        const existing = await client.query(
            'SELECT id, fit_score FROM leads WHERE linkedin_url = $1 LIMIT 1',
            [p.linkedin_url],
        );

        if (existing.rows[0]) {
            const row = existing.rows[0];
            const better = row.fit_score == null || p.fitScore > row.fit_score;
            await client.query(`
                UPDATE leads
                SET discovery_seen_count = COALESCE(discovery_seen_count, 1) + 1,
                    fit_score   = CASE WHEN $2::boolean THEN $3::smallint ELSE fit_score END,
                    fit_reasons = CASE WHEN $2::boolean THEN $4::jsonb    ELSE fit_reasons END,
                    scored_at   = CASE WHEN $2::boolean THEN CURRENT_TIMESTAMP ELSE scored_at END,
                    first_name = CASE WHEN LOWER(BTRIM(COALESCE(first_name, ''))) IN ('', 'unknown')
                        AND $5::text <> '' THEN $5 ELSE first_name END,
                    last_name = CASE WHEN LOWER(BTRIM(COALESCE(first_name, ''))) IN ('', 'unknown')
                        AND LOWER(BTRIM(COALESCE(last_name, ''))) IN ('', 'unknown')
                        AND $5::text <> '' THEN $6 ELSE last_name END
                WHERE id = $1
            `, [row.id, better, p.fitScore, JSON.stringify(p.fitReasons), name.firstName, name.lastName]);
            return { inserted: false };
        }

        await client.query(`
            INSERT INTO leads (
                id, linkedin_url, location, pipeline_status, email_status,
                first_name, last_name, company, website, website_source, email, all_emails, hook,
                discovery_query, discovery_template_id, discovery_niche, discovery_location,
                discovery_page, discovery_rank, discovery_title, discovery_snippet,
                discovery_run_id, discovered_at, discovery_seen_count,
                fit_score, fit_reasons, scored_at
            ) VALUES (
                $1, $2, $3, 'INBOX', 'UNVERIFIED',
                $15, $16, '', '', '', '', '', '',
                $4, $5, $6, $7,
                $8, $9, $10, $11,
                $12, CURRENT_TIMESTAMP, 1,
                $13, $14, CURRENT_TIMESTAMP
            )
        `, [
            generateId(), p.linkedin_url, p.location,
            p.query, p.templateId, p.niche, p.discoveryLocation,
            p.page, p.rank, p.title, p.snippet,
            p.runId, p.fitScore, JSON.stringify(p.fitReasons), name.firstName, name.lastName,
        ]);
        return { inserted: true };
    } finally {
        client.release();
    }
}

/** The four columns the scrape queue actually needs. */
export type QueueCandidate = Pick<LeadRecord, 'id' | 'linkedin_url' | 'location' | 'fit_score'>;

/**
 * INBOX leads ranked best-first, with an explicit column list.
 *
 * The column list is the point. `getAllLeads` does `SELECT *` over every row on
 * every CRM load, sync and import; the discovery and scoring columns added ~14
 * fields to that, two of them JSONB and three TEXT. Feeding the scrape queue
 * through the same query would have made a hot path materially slower to deliver
 * data it never reads.
 *
 * Deliberately unlimited: the caller filters by region *after* this returns, and
 * a LIMIT applied before that filter would silently starve every region but the
 * one that happens to score highest.
 *
 * `NULLS LAST` puts unscored legacy rows behind every scored one, which is the
 * right default — an unknown score is not a good score.
 */
export async function getQueueCandidates(): Promise<QueueCandidate[]> {
    const client = await pool.connect();
    try {
        const res = await client.query(`
            SELECT id, linkedin_url, location, fit_score
            FROM leads
            WHERE pipeline_status = 'INBOX'
              AND linkedin_url IS NOT NULL AND linkedin_url <> ''
            ORDER BY fit_score DESC NULLS LAST, created_at ASC
        `);
        return res.rows;
    } finally {
        client.release();
    }
}

export async function getLead(id: string): Promise<LeadRecord | undefined> {
    const client = await pool.connect();
    try {
        const membership = await syncHunterContacted(client, [id]);
        const res = await client.query('SELECT * FROM leads WHERE id = $1', [id]);
        return res.rows[0] ? { ...res.rows[0], in_hunter: membership.memberIds.has(id) } : undefined;
    } finally {
        client.release();
    }
}

export async function getAllLeads(): Promise<LeadRecord[]> {
    const client = await pool.connect();
    try {
        await revokeUnprovenEmailLabels(client);
        const membership = await syncHunterContacted(client);
        const res = await client.query('SELECT * FROM leads ORDER BY created_at DESC');
        return res.rows.map((row) => ({ ...row, in_hunter: membership.memberIds.has(row.id) }));
    } finally {
        client.release();
    }
}

export async function deleteLead(id: string): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query('DELETE FROM leads WHERE id = $1', [id]);
    } finally {
        client.release();
    }
}

export async function bulkDeleteLeads(ids: string[]): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query('DELETE FROM leads WHERE id = ANY($1)', [ids]);
    } finally {
        client.release();
    }
}

export async function bulkMarkContacted(identifiers: string[]): Promise<number> {
    if (identifiers.length === 0) return 0;
    const client = await pool.connect();
    try {
        // Find matching leads by either exact email or exact linkedin_url
        // Update their contacted status to true
        // We use ANY($1) for efficient bulk matching against an array of strings
        const res = await client.query(`
            UPDATE leads
            SET contacted = TRUE,
                contacted_at = COALESCE(contacted_at, CURRENT_TIMESTAMP)
            WHERE email = ANY($1)
               OR linkedin_url = ANY($1)
            RETURNING id
        `, [identifiers]);
        return res.rowCount || 0;
    } finally {
        client.release();
    }
}

/**
 * Records what actually happened after outreach. This is the only data that can
 * tell you which regions, hook styles, and search queries are worth repeating —
 * every other number in the CRM measures activity, not results.
 */
export async function setLeadOutcome(id: string, outcome: string): Promise<LeadRecord> {
    const client = await pool.connect();
    try {
        // Every use of $1 is cast to text explicitly. Without the casts Postgres has
        // to infer one type for the parameter from an assignment to a varchar column
        // *and* from comparisons against text literals, which it refuses to do
        // (42P08, "inconsistent types deduced") — so every outcome write failed.
        const res = await client.query(`
            UPDATE leads
            SET outcome = $1::text,
                replied_at = CASE
                    WHEN $1::text IN ('REPLIED', 'BOOKED', 'NOT_INTERESTED') THEN COALESCE(replied_at, CURRENT_TIMESTAMP)
                    ELSE replied_at
                END,
                booked_at = CASE
                    WHEN $1::text = 'BOOKED' THEN COALESCE(booked_at, CURRENT_TIMESTAMP)
                    ELSE booked_at
                END,
                do_not_contact = CASE WHEN $1::text IN ('NOT_INTERESTED', 'BOUNCED') THEN TRUE ELSE do_not_contact END
            WHERE id = $2::text
            RETURNING *
        `, [outcome, id]);
        if (!res.rows[0]) throw new Error('Lead not found');
        return res.rows[0];
    } finally {
        client.release();
    }
}

/**
 * Marks leads contacted using the real date the mail was sent, rather than "now".
 * Used by the Gmail reconcile — without true send dates the outcome columns have
 * nothing to measure against.
 *
 * `LEAST` keeps the earliest known contact date: re-running the sync, or finding
 * the same lead in a second mailbox, must never push the date forward.
 */
export async function bulkMarkContactedWithDates(
    entries: { id: string; sentAt: string }[],
    source: ContactedSource = 'GMAIL',
): Promise<number> {
    if (entries.length === 0) return 0;
    const client = await pool.connect();
    try {
        const res = await client.query(`
            UPDATE leads l
            SET contacted = TRUE,
                contacted_at = LEAST(COALESCE(l.contacted_at, v.sent_at), v.sent_at),
                -- Provenance only ever strengthens. A platform's own campaign report
                -- is authoritative about what it sent; a Gmail match must not
                -- downgrade that to the weaker evidence.
                contacted_source = CASE
                    WHEN l.contacted_source = 'PLATFORM' THEN 'PLATFORM'
                    ELSE $3::text
                END
            FROM (
                SELECT unnest($1::text[]) AS id, unnest($2::timestamptz[]) AS sent_at
            ) v
            WHERE l.id = v.id
            RETURNING l.id
        `, [entries.map(e => e.id), entries.map(e => e.sentAt), source]);
        return res.rowCount || 0;
    } finally {
        client.release();
    }
}

/**
 * Stamps provenance on leads already flagged contacted, without touching the flag
 * or the date. Used when a campaign report confirms a send for a lead the CRM had
 * already marked — the flag was right, but until now nothing recorded *why*.
 */
export async function setContactedSource(ids: string[], source: ContactedSource): Promise<number> {
    if (ids.length === 0) return 0;
    const client = await pool.connect();
    try {
        const res = await client.query(`
            UPDATE leads
            SET contacted_source = $2::text
            WHERE id = ANY($1::text[])
              AND (contacted_source IS DISTINCT FROM 'PLATFORM' OR $2::text = 'PLATFORM')
            RETURNING id
        `, [ids, source]);
        return res.rowCount || 0;
    } finally {
        client.release();
    }
}

/** Suppression list. A suppressed lead never appears in a send-list export again. */
export async function setDoNotContact(ids: string[], flag: boolean): Promise<number> {
    if (ids.length === 0) return 0;
    const client = await pool.connect();
    try {
        const res = await client.query(
            'UPDATE leads SET do_not_contact = $1 WHERE id = ANY($2) RETURNING id',
            [flag, ids],
        );
        return res.rowCount || 0;
    } finally {
        client.release();
    }
}

export async function updateLeadEmailVerification(id: string, update: EmailVerificationUpdate): Promise<LeadRecord> {
    const client = await pool.connect();
    try {
        const membership = await syncHunterContacted(client, [id]);
        const res = await client.query('SELECT * FROM leads WHERE id = $1', [id]);
        const existing = res.rows[0];
        if (!existing) throw new Error("Lead not found");

        // Verification annotates a lead; it never moves it between stages. A lead
        // that reached QUALIFIED did so by passing the scraper's own bar, and it
        // stays there whether or not its email has been checked yet — so a failed
        // or not-yet-run verification can't make a lead vanish from its tab. The
        // strict send gate lives in /api/crm/leads/qualified, which reads
        // email_status + method + expiry directly.
        const updateRes = await client.query(`
            UPDATE leads
            SET email_status = $1,
                email_verification_method = $2,
                email_verification_reason = $3,
                email_verification_score = $4,
                email_verified_at = $5,
                email_verification_expires_at = $6
            WHERE id = $7 AND ($8::text IS NULL OR LOWER(TRIM(email)) = LOWER(TRIM($8::text)))
            RETURNING *
        `, [
            update.status,
            update.method || null,
            update.reason,
            update.score,
            update.checkedAt || new Date().toISOString(),
            update.expiresAt || null,
            id,
            update.expectedEmail || null
        ]);
        if (!updateRes.rows[0]) throw new Error('Email changed while verification was running; verify the current address again.');
        return { ...updateRes.rows[0], in_hunter: membership.memberIds.has(id) };
    } finally {
        client.release();
    }
}

export async function getLeadsByIds(ids: string[]): Promise<LeadRecord[]> {
    if (ids.length === 0) return [];
    const client = await pool.connect();
    try {
        const membership = await syncHunterContacted(client, ids);
        const res = await client.query('SELECT * FROM leads WHERE id = ANY($1)', [ids]);
        return res.rows.map((row) => ({ ...row, in_hunter: membership.memberIds.has(row.id) }));
    } finally {
        client.release();
    }
}
