import { pool } from './pg_setup';
import { ensureBusinessSchema, businessTransaction } from './business-store';
import { ensureCaseStudySchema } from './case-study-store';
import { DEFAULT_CALL_TEMPLATE, type DiscoveryCall, type DiscoverySnapshot } from './discovery-calls';

let schemaReady: Promise<void> | undefined;
export function ensureDiscoverySchema(): Promise<void> {
    if (!schemaReady) schemaReady = (async () => {
        await ensureBusinessSchema();
        await ensureCaseStudySchema();
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT pg_advisory_xact_lock(83472121)');
            await client.query(`
                CREATE TABLE IF NOT EXISTS discovery_call_templates (
                    id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(id), data JSONB NOT NULL,
                    revision INTEGER NOT NULL DEFAULT 1
                );
                CREATE TABLE IF NOT EXISTS discovery_calls (
                    id UUID PRIMARY KEY, source_prospect_id UUID REFERENCES case_study_prospects(id),
                    project_id UUID REFERENCES business_projects(id), data JSONB NOT NULL,
                    revision INTEGER NOT NULL DEFAULT 1,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
                CREATE UNIQUE INDEX IF NOT EXISTS discovery_call_source ON discovery_calls(source_prospect_id) WHERE source_prospect_id IS NOT NULL;
                CREATE INDEX IF NOT EXISTS discovery_call_updated ON discovery_calls(updated_at DESC);
            `);
            await client.query('INSERT INTO discovery_call_templates(id,data) VALUES(TRUE,$1) ON CONFLICT(id) DO NOTHING', [JSON.stringify(DEFAULT_CALL_TEMPLATE)]);
            await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    })().catch(error => { schemaReady = undefined; throw error; });
    return schemaReady;
}
export const mapDiscoveryCall = (row: any): DiscoveryCall => ({
    id: row.id, sourceProspectId: row.source_prospect_id, projectId: row.project_id,
    data: row.data, revision: row.revision,
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
});
export async function readDiscoverySnapshot(): Promise<DiscoverySnapshot> {
    await ensureDiscoverySchema();
    return businessTransaction(async client => {
        const calls = await client.query('SELECT * FROM discovery_calls ORDER BY updated_at DESC');
        const template = await client.query('SELECT data,revision FROM discovery_call_templates WHERE id=TRUE');
        const sources = await client.query(`SELECT id,
            data->>'name' AS name, data->>'email' AS email, data->>'website' AS website,
            data->>'linkedinUrl' AS "linkedinUrl", data->>'headline' AS headline, data->>'mode' AS mode,
            data->'delivery'->>'discoveryCallAt' AS "scheduledAt", data->>'notes' AS notes,
            data->>'warmthEvidence' AS "warmthEvidence", data->>'mainWeakness' AS "mainWeakness", data->>'stage' AS stage
            FROM case_study_prospects WHERE data->>'stage' <> 'DO_NOT_CONTACT' ORDER BY updated_at DESC`);
        return {
            calls: calls.rows.map(mapDiscoveryCall), template: template.rows[0],
            sources: sources.rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value ?? '']))) as DiscoverySnapshot['sources'],
        };
    });
}
