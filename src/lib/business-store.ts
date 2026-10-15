import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from './pg_setup';
import {
    DEFAULT_OFFER,
    type OfferVersion,
    type Opportunity,
    type ClientProject,
    type BusinessSnapshot,
} from './business';

// Additive schema: these tables never mutate the scraper's lead stages or send gate.
export const BUSINESS_SCHEMA = `
CREATE TABLE IF NOT EXISTS business_offer_versions (
    version SERIAL PRIMARY KEY, profile JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS business_opportunities (
    id UUID PRIMARY KEY, lead_id VARCHAR(255), offer_version INTEGER NOT NULL REFERENCES business_offer_versions(version),
    data JSONB NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS business_opportunity_lead ON business_opportunities(lead_id) WHERE lead_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS business_projects (
    id UUID PRIMARY KEY, opportunity_id UUID UNIQUE NOT NULL REFERENCES business_opportunities(id),
    offer_version INTEGER NOT NULL REFERENCES business_offer_versions(version), data JSONB NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS business_activities (
    id UUID PRIMARY KEY, opportunity_id UUID NOT NULL REFERENCES business_opportunities(id),
    kind TEXT NOT NULL, note TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS business_activity_opportunity ON business_activities(opportunity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS business_opportunity_stage ON business_opportunities((data->>'stage'));
`;

let schemaReady: Promise<void> | undefined;
export function ensureBusinessSchema(): Promise<void> {
    if (!schemaReady)
        schemaReady = (async () => {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query('SELECT pg_advisory_xact_lock(83472101)');
                await client.query(BUSINESS_SCHEMA);
                await client.query(
                    'INSERT INTO business_offer_versions(profile) SELECT $1::jsonb WHERE NOT EXISTS (SELECT 1 FROM business_offer_versions)',
                    [JSON.stringify(DEFAULT_OFFER)],
                );
                await client.query('COMMIT');
            } catch (e) {
                await client.query('ROLLBACK');
                throw e;
            } finally {
                client.release();
            }
        })().catch((e) => {
            schemaReady = undefined;
            throw e;
        });
    return schemaReady;
}

export async function businessTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    await ensureBusinessSchema();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}

const iso = (value: Date | string) => new Date(value).toISOString();
export const mapOffer = (r: any): OfferVersion => ({
    version: r.version,
    profile: r.profile,
    createdAt: iso(r.created_at),
});
export const mapOpportunity = (r: any): Opportunity => ({
    id: r.id,
    leadId: r.lead_id,
    offerVersion: r.offer_version,
    revision: r.revision,
    data: r.data,
    updatedAt: iso(r.updated_at),
});
export const mapProject = (r: any): ClientProject => ({
    id: r.id,
    opportunityId: r.opportunity_id,
    offerVersion: r.offer_version,
    revision: r.revision,
    data: r.data,
    updatedAt: iso(r.updated_at),
});
export async function recordActivity(
    client: PoolClient,
    opportunityId: string,
    kind: string,
    note: string,
): Promise<void> {
    await client.query('INSERT INTO business_activities(id,opportunity_id,kind,note) VALUES ($1,$2,$3,$4)', [
        randomUUID(),
        opportunityId,
        kind,
        note,
    ]);
}

export async function readBusinessSnapshot(): Promise<BusinessSnapshot> {
    return businessTransaction(async (client) => {
        const offer = await client.query(
            'SELECT * FROM business_offer_versions ORDER BY version DESC LIMIT 1',
        );
        const opportunities = await client.query(
            'SELECT o.* FROM business_opportunities o JOIN business_projects p ON p.opportunity_id=o.id ORDER BY o.updated_at DESC',
        );
        const projects = await client.query('SELECT * FROM business_projects ORDER BY updated_at DESC');
        return {
            offer: mapOffer(offer.rows[0]),
            opportunities: opportunities.rows.map(mapOpportunity),
            projects: projects.rows.map(mapProject),
        };
    });
}
