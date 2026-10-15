import { Pool } from 'pg';

export const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Required for Supabase/Neon
});

export async function createSchema() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS leads (
                id VARCHAR(255) PRIMARY KEY,
                linkedin_url VARCHAR(1024),
                first_name VARCHAR(255),
                last_name VARCHAR(255),
                company VARCHAR(512),
                website VARCHAR(1024),
                website_source VARCHAR(255),
                email VARCHAR(255),
                all_emails TEXT,
                email_status VARCHAR(50),
                email_verification_method VARCHAR(50),
                email_verification_reason TEXT,
                email_verification_score INTEGER,
                email_verified_at TIMESTAMP WITH TIME ZONE,
                email_verification_expires_at TIMESTAMP WITH TIME ZONE,
                hook TEXT,
                hook_source VARCHAR(50),
                pipeline_status VARCHAR(50),
                location VARCHAR(255),
                contacted BOOLEAN DEFAULT FALSE,
                contacted_at TIMESTAMP WITH TIME ZONE,
                linkedin_dm_at TIMESTAMP WITH TIME ZONE,
                contacted_source VARCHAR(20),
                replied_at TIMESTAMP WITH TIME ZONE,
                booked_at TIMESTAMP WITH TIME ZONE,
                outcome VARCHAR(50),
                do_not_contact BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );

            -- Outcome tracking, added after the table already existed in production.
            ALTER TABLE leads ADD COLUMN IF NOT EXISTS hook_source VARCHAR(50);
            ALTER TABLE leads ADD COLUMN IF NOT EXISTS contacted_at TIMESTAMP WITH TIME ZONE;
            ALTER TABLE leads ADD COLUMN IF NOT EXISTS linkedin_dm_at TIMESTAMP WITH TIME ZONE;
            -- Where the contacted flag came from: PLATFORM (a sending platform's own
            -- campaign report — authoritative), GMAIL (found in Sent Mail), or NULL
            -- (set by a push or by hand, which proves only that a lead was queued).
            -- Without this the flag can't be trusted or safely corrected.
            ALTER TABLE leads ADD COLUMN IF NOT EXISTS contacted_source VARCHAR(20);
            ALTER TABLE leads ADD COLUMN IF NOT EXISTS replied_at TIMESTAMP WITH TIME ZONE;
            ALTER TABLE leads ADD COLUMN IF NOT EXISTS booked_at TIMESTAMP WITH TIME ZONE;
            ALTER TABLE leads ADD COLUMN IF NOT EXISTS outcome VARCHAR(50);
            ALTER TABLE leads ADD COLUMN IF NOT EXISTS do_not_contact BOOLEAN DEFAULT FALSE;

            -- These exist only in the CREATE TABLE above, so they were never applied
            -- to a database created before they were added — and the send gate reads
            -- three of them. On such a database every qualified lead fails the gate
            -- with a column-does-not-exist error rather than a verdict.
            ALTER TABLE leads ADD COLUMN IF NOT EXISTS website_source                VARCHAR(255);
            ALTER TABLE leads ADD COLUMN IF NOT EXISTS email_verification_method     VARCHAR(50);
            ALTER TABLE leads ADD COLUMN IF NOT EXISTS email_verification_reason     TEXT;
            ALTER TABLE leads ADD COLUMN IF NOT EXISTS email_verification_score      INTEGER;
            ALTER TABLE leads ADD COLUMN IF NOT EXISTS email_verified_at             TIMESTAMP WITH TIME ZONE;
            ALTER TABLE leads ADD COLUMN IF NOT EXISTS email_verification_expires_at TIMESTAMP WITH TIME ZONE;

            -- ── Discovery provenance ──
            -- Written on INSERT only: first-touch attribution. If a later template
            -- re-finds the same profile and overwrites, credit silently reassigns to
            -- whichever template happened to run last and every per-template number
            -- is wrong. A re-find increments discovery_seen_count instead, which is
            -- itself a signal — a profile many distinct dorks can reach is well
            -- indexed, and usually a real practitioner rather than a stub.
            ALTER TABLE leads ADD COLUMN IF NOT EXISTS discovery_query       TEXT;
            ALTER TABLE leads ADD COLUMN IF NOT EXISTS discovery_template_id VARCHAR(64);
            ALTER TABLE leads ADD COLUMN IF NOT EXISTS discovery_niche       VARCHAR(255);
            ALTER TABLE leads ADD COLUMN IF NOT EXISTS discovery_location    VARCHAR(255);
            ALTER TABLE leads ADD COLUMN IF NOT EXISTS discovery_page        SMALLINT;
            ALTER TABLE leads ADD COLUMN IF NOT EXISTS discovery_rank        SMALLINT;
            ALTER TABLE leads ADD COLUMN IF NOT EXISTS discovery_title       TEXT;
            ALTER TABLE leads ADD COLUMN IF NOT EXISTS discovery_snippet     TEXT;
            ALTER TABLE leads ADD COLUMN IF NOT EXISTS discovery_run_id      VARCHAR(64);
            ALTER TABLE leads ADD COLUMN IF NOT EXISTS discovered_at         TIMESTAMP WITH TIME ZONE;
            ALTER TABLE leads ADD COLUMN IF NOT EXISTS discovery_seen_count  INTEGER DEFAULT 1;

            -- ── Tier-A fit score ──
            -- Kept deliberately separate from the worker's lead_score: Tier A is a
            -- prediction made from a SERP, Tier B is the measurement of what it
            -- predicted. Averaging them into one number would permanently destroy
            -- the ability to ask whether fit_score predicts anything.
            ALTER TABLE leads ADD COLUMN IF NOT EXISTS fit_score   SMALLINT;
            ALTER TABLE leads ADD COLUMN IF NOT EXISTS fit_reasons JSONB;
            ALTER TABLE leads ADD COLUMN IF NOT EXISTS scored_at   TIMESTAMP WITH TIME ZONE;

            -- Business qualification is independent of reachability and outcomes.
            -- Existing rows remain unresearched; no legacy verdict is treated as commercial proof.
            ALTER TABLE leads ADD COLUMN IF NOT EXISTS prospect_assessment JSONB;
            ALTER TABLE leads ADD COLUMN IF NOT EXISTS prospect_review JSONB;
            ALTER TABLE leads ADD COLUMN IF NOT EXISTS prospect_researched_at TIMESTAMPTZ;
            CREATE INDEX IF NOT EXISTS idx_leads_prospect_priority
                ON leads ((prospect_assessment->>'tier'), (prospect_assessment->>'segment'), prospect_researched_at DESC);

            CREATE INDEX IF NOT EXISTS idx_leads_linkedin_url ON leads(linkedin_url);
            CREATE INDEX IF NOT EXISTS idx_leads_location ON leads(location);
            CREATE INDEX IF NOT EXISTS idx_leads_pipeline_status ON leads(pipeline_status);
            CREATE INDEX IF NOT EXISTS idx_leads_email_verification_expires_at ON leads(email_verification_expires_at);
            CREATE INDEX IF NOT EXISTS idx_leads_outcome ON leads(outcome);
            CREATE INDEX IF NOT EXISTS idx_leads_discovery_template ON leads(discovery_template_id);

            -- Serves the queue selection directly: the whole point of the score is
            -- "give me the best N leads still in the inbox", and this makes that an
            -- index scan over the INBOX slice rather than a sort of the whole table.
            CREATE INDEX IF NOT EXISTS idx_leads_queue ON leads(fit_score DESC NULLS LAST)
                WHERE pipeline_status = 'INBOX';
        `);

        // The OUTREACH stage was retired: a lead now lands in QUALIFIED and stays
        // there whether or not its email has been verified. Rows written under the
        // old model are carried across so they keep showing up in their region tab.
        const migrated = await client.query(
            `UPDATE leads SET pipeline_status = CASE WHEN NULLIF(trim(email),'') IS NULL THEN 'NOT_QUALIFIED' ELSE 'QUALIFIED' END WHERE pipeline_status = 'OUTREACH'`
        );
        if (migrated.rowCount) console.log(`Migrated ${migrated.rowCount} leads from OUTREACH to QUALIFIED`);

        // Best-effort: prevents two concurrent writers (e.g. a live dork-engine
        // insert racing a CSV import) from creating two rows for the same
        // LinkedIn profile. Wrapped so it never blocks schema setup — if the
        // table already has duplicate linkedin_url values, index creation fails
        // and is skipped; dedupe those rows manually, then rerun the migration.
        try {
            await client.query(`
                CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_linkedin_url_unique
                ON leads (linkedin_url)
                WHERE linkedin_url IS NOT NULL AND linkedin_url != '';
            `);
        } catch (e) {
            console.warn('Skipping unique linkedin_url index — likely duplicate rows exist. Dedupe leads.linkedin_url and rerun to close the race condition on concurrent inserts:', (e as Error).message);
        }

        console.log('PostgreSQL Schema created successfully');
    } finally {
        client.release();
    }
}

/**
 * Columns and indexes `createSchema()` is expected to have produced.
 *
 * Keep this list beside the DDL above and edit them together. It is not
 * decoration: `POST /api/admin/migrate` used to report "Schema is up to date"
 * purely because `createSchema()` returned without throwing, which is also exactly
 * what happens when the running server predates the schema change. A migration
 * that reports success for work it never did is worse than one that fails, because
 * the next thing to touch those columns is the failure you actually see.
 */
const REQUIRED_COLUMNS = [
    'linkedin_dm_at',
    'website_source', 'email_verification_method', 'email_verification_reason',
    'email_verification_score', 'email_verified_at', 'email_verification_expires_at',
    'discovery_query', 'discovery_template_id', 'discovery_niche', 'discovery_location',
    'discovery_page', 'discovery_rank', 'discovery_title', 'discovery_snippet',
    'discovery_run_id', 'discovered_at', 'discovery_seen_count',
    'fit_score', 'fit_reasons', 'scored_at',
    'prospect_assessment', 'prospect_review', 'prospect_researched_at',
];

const REQUIRED_INDEXES = [
    'idx_leads_queue', 'idx_leads_discovery_template', 'idx_leads_pipeline_status',
    'idx_leads_prospect_priority',
];

export type SchemaVerification = {
    ok: boolean;
    columnCount: number;
    missingColumns: string[];
    missingIndexes: string[];
    /** Present only when the race-guard index could not be created. */
    duplicateUrlGroups?: number;
};

/** Reads back what is actually in the database, so "migrated" is evidence, not a claim. */
export async function verifySchema(): Promise<SchemaVerification> {
    const client = await pool.connect();
    try {
        const cols = await client.query(
            `SELECT column_name FROM information_schema.columns WHERE table_name = 'leads'`,
        );
        const have = new Set(cols.rows.map(r => r.column_name as string));

        const idx = await client.query(
            `SELECT indexname FROM pg_indexes WHERE tablename = 'leads'`,
        );
        const haveIdx = new Set(idx.rows.map(r => r.indexname as string));

        const result: SchemaVerification = {
            ok: true,
            columnCount: have.size,
            missingColumns: REQUIRED_COLUMNS.filter(c => !have.has(c)),
            missingIndexes: REQUIRED_INDEXES.filter(i => !haveIdx.has(i)),
        };

        // The unique index is created best-effort and skipped when duplicates exist,
        // so report the count that would block it rather than leaving a console warning
        // as the only trace.
        if (!haveIdx.has('idx_leads_linkedin_url_unique')) {
            const dupes = await client.query(`
                SELECT COUNT(*) AS n FROM (
                    SELECT 1 FROM leads
                    WHERE linkedin_url IS NOT NULL AND linkedin_url <> ''
                    GROUP BY linkedin_url HAVING COUNT(*) > 1
                ) d
            `);
            result.duplicateUrlGroups = Number(dupes.rows[0]?.n || 0);
        }

        result.ok = result.missingColumns.length === 0 && result.missingIndexes.length === 0;
        return result;
    } finally {
        client.release();
    }
}
