import fs from 'fs';
import path from 'path';
import { pool, createSchema } from './pg_setup';

async function migrate() {
    await createSchema();

    const dbPath = path.join(process.cwd(), 'data', 'leads_db.json');
    if (!fs.existsSync(dbPath)) {
        console.log("No JSON database found to migrate.");
        process.exit(0);
    }

    const data = fs.readFileSync(dbPath, 'utf8');
    const leads = JSON.parse(data);

    if (leads.length === 0) {
        console.log("JSON database is empty.");
        process.exit(0);
    }

    console.log(`Migrating ${leads.length} leads to PostgreSQL...`);
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        let count = 0;
        for (const lead of leads) {
            await client.query(`
                INSERT INTO leads (
                    id, linkedin_url, first_name, last_name, company, website, website_source,
                    email, all_emails, email_status, hook, pipeline_status, location, contacted, created_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
                ON CONFLICT (id) DO NOTHING
            `, [
                lead.id, lead.linkedin_url, lead.first_name, lead.last_name, lead.company,
                lead.website, lead.website_source, lead.email, lead.all_emails, lead.email_status,
                lead.hook, lead.pipeline_status, lead.location, lead.contacted, new Date(lead.created_at)
            ]);
            count++;
            if (count % 1000 === 0) console.log(`Migrated ${count} leads...`);
        }
        
        await client.query('COMMIT');
        console.log(`Successfully migrated ${count} leads!`);
        
        fs.renameSync(dbPath, dbPath + '.migrated.backup');
        console.log("Renamed leads_db.json to leads_db.json.migrated.backup");
    } catch (e) {
        await client.query('ROLLBACK');
        console.error("Migration failed:", e);
    } finally {
        client.release();
        await pool.end();
    }
}

migrate().catch(console.error);
