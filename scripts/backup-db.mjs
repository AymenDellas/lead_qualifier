#!/usr/bin/env node
/**
 * Nightly-safe snapshot of the leads table to a timestamped JSON file.
 *
 *   node scripts/backup-db.mjs [outputDir]
 *
 * Deliberately does not shell out to pg_dump: this only needs the one table, and
 * a plain JSON array can be re-imported through the CRM's own CSV/import path or
 * read directly, without matching Postgres client versions on the machine.
 *
 * Backups older than KEEP_DAYS are pruned so this can run unattended.
 */

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const KEEP_DAYS = 30;

function loadEnvLocal() {
    // Same hand-rolled parse worker.cjs uses, so this runs without Next.js.
    const envPath = path.join(process.cwd(), '.env.local');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
        const match = line.replace(/\r/g, '').match(/^([^#=]+)=(.+)$/);
        if (!match) continue;
        // Strip surrounding quotes, as dotenv does — a quoted connection string
        // otherwise reaches pg with its quotes attached and fails to resolve.
        const value = match[2].trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
        process.env[match[1].trim()] ??= value;
    }
}

async function main() {
    loadEnvLocal();

    if (!process.env.DATABASE_URL) {
        console.error('DATABASE_URL is not set (checked environment and .env.local).');
        process.exit(1);
    }

    const outDir = path.resolve(process.argv[2] || path.join(process.cwd(), 'backups'));
    fs.mkdirSync(outDir, { recursive: true });

    const pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
    });

    try {
        const { rows } = await pool.query('SELECT * FROM leads ORDER BY created_at DESC');
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const outFile = path.join(outDir, `leads-${stamp}.json`);

        // Write to a temp file and rename, so an interrupted run can never leave a
        // truncated file that looks like a valid backup.
        const tmpFile = `${outFile}.tmp`;
        fs.writeFileSync(tmpFile, JSON.stringify(rows, null, 2));
        fs.renameSync(tmpFile, outFile);

        const sizeMb = (fs.statSync(outFile).size / 1024 / 1024).toFixed(2);
        console.log(`Backed up ${rows.length} leads → ${outFile} (${sizeMb} MB)`);

        const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
        let pruned = 0;
        for (const file of fs.readdirSync(outDir)) {
            if (!/^leads-.*\.json$/.test(file)) continue;
            const full = path.join(outDir, file);
            if (fs.statSync(full).mtimeMs < cutoff) { fs.unlinkSync(full); pruned++; }
        }
        if (pruned) console.log(`Pruned ${pruned} backup(s) older than ${KEEP_DAYS} days`);
    } finally {
        await pool.end();
    }
}

main().catch(err => {
    console.error('Backup failed:', err.message);
    process.exit(1);
});
