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
                hook TEXT,
                pipeline_status VARCHAR(50),
                location VARCHAR(255),
                contacted BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_leads_linkedin_url ON leads(linkedin_url);
            CREATE INDEX IF NOT EXISTS idx_leads_location ON leads(location);
            CREATE INDEX IF NOT EXISTS idx_leads_pipeline_status ON leads(pipeline_status);
        `);
        console.log('PostgreSQL Schema created successfully');
    } finally {
        client.release();
    }
}
