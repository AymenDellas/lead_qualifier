'use strict';
// Add research storage only. Does not reclassify leads or alter existing fields.
require('@next/env').loadEnvConfig(process.cwd());
require('tsx/cjs/api').register();
const { ensureProspectSchema } = require('../src/lib/prospect-store.ts');
const { pool } = require('../src/lib/pg_setup.ts');
(async () => {
    if (!process.env.DATABASE_URL) throw new Error('Configure DATABASE_URL before applying the prospect schema.');
    await ensureProspectSchema();
    const result = await pool.query(`SELECT
        (SELECT COUNT(*)::int FROM information_schema.columns WHERE table_schema='public' AND table_name='leads'
            AND column_name IN ('prospect_assessment','prospect_review','prospect_researched_at')) AS columns,
        (SELECT COUNT(*)::int FROM pg_indexes WHERE schemaname='public' AND tablename='leads'
            AND indexname='idx_leads_prospect_priority') AS indexes`);
    if (result.rows[0].columns !== 3 || result.rows[0].indexes !== 1) throw new Error('The prospect schema could not be verified.');
    console.log('Prospect schema verified: 3 research/review columns and the priority index. Existing leads were not reclassified.');
})().catch(error => { console.error('Prospect migration failed:', error.message); process.exitCode = 1; }).finally(() => pool.end());
