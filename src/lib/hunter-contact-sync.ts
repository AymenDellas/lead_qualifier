import { pool } from './pg_setup';
import type { PoolClient } from 'pg';

type QueryClient = Pick<PoolClient, 'query'>;

/** Match the person, ignoring URL scheme, subdomain, case, tracking, and suffixes. */
export function hunterProfileKeySql(column: string): string {
    if (!/^[a-z_]+\.[a-z_]+$/.test(column)) throw new Error('Invalid LinkedIn column');
    return `LOWER(SUBSTRING(TRIM(${column}) FROM '(?i)^(?:https?://)?(?:[a-z0-9-]+\\.)?linkedin\\.com/in/([^/?#]+)'))`;
}

/** Hunter membership is an outreach reservation, never evidence of a sent DM. */
export async function syncHunterContacted(client: QueryClient = pool, ids?: string[]) {
    if (ids && !ids.length) return { memberIds: new Set<string>(), updated: 0 };
    const exists = await client.query("SELECT to_regclass('public.case_study_prospects') AS table_name, to_regclass('public.leads') AS lead_table");
    if (!exists.rows[0]?.table_name || !exists.rows[0]?.lead_table) return { memberIds: new Set<string>(), updated: 0 };
    const result = await client.query(`
        WITH lead_keys AS MATERIALIZED (
            SELECT l.id, ${hunterProfileKeySql('l.linkedin_url')} AS profile_key
            FROM leads l ${ids ? 'WHERE l.id=ANY($1::text[])' : ''}
        ), hunter_keys AS MATERIALIZED (
            SELECT p.data->>'crmLeadId' AS lead_id,
                   ${hunterProfileKeySql('p.linkedin_url')} AS profile_key
            FROM case_study_prospects p
        ), members AS (
            SELECT l.id FROM lead_keys l JOIN hunter_keys p ON p.lead_id=l.id
            UNION
            SELECT l.id FROM lead_keys l JOIN hunter_keys p ON p.profile_key=l.profile_key
            WHERE l.profile_key IS NOT NULL
        ), changed AS (
            UPDATE leads l SET contacted=TRUE,
                contacted_source=COALESCE(NULLIF(l.contacted_source,''),'HUNTER')
            FROM members m WHERE l.id=m.id
              AND (l.contacted IS DISTINCT FROM TRUE OR NULLIF(l.contacted_source,'') IS NULL)
            RETURNING l.id
        )
        SELECT m.id, EXISTS(SELECT 1 FROM changed c WHERE c.id=m.id) AS updated
        FROM members m
    `, ids ? [ids] : []);
    return {
        memberIds: new Set<string>(result.rows.map((row) => row.id)),
        updated: result.rows.filter((row) => row.updated).length,
    };
}
