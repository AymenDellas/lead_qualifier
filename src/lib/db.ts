import { pool } from './pg_setup';

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
    hook: string;
    pipeline_status: string;
    location: string;
    contacted: boolean;
    created_at: string;
}

export function generateId(): string {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

export function determinePipelineStatus(email: string, hook: string, currentStatus?: string): string {
    return currentStatus || 'INBOX';
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
            const newStatus = lead.pipeline_status || existing.pipeline_status || 'INBOX';

            const updateRes = await client.query(`
                UPDATE leads 
                SET linkedin_url = COALESCE($1, linkedin_url),
                    first_name = COALESCE($2, first_name),
                    last_name = COALESCE($3, last_name),
                    company = COALESCE($4, company),
                    website = COALESCE($5, website),
                    website_source = COALESCE($6, website_source),
                    email = $7,
                    all_emails = COALESCE($8, all_emails),
                    email_status = COALESCE($9, email_status),
                    hook = $10,
                    pipeline_status = $11,
                    location = COALESCE($12, location),
                    contacted = COALESCE($13, contacted)
                WHERE id = $14
                RETURNING *
            `, [
                lead.linkedin_url, lead.first_name, lead.last_name, lead.company,
                lead.website, lead.website_source, newEmail, lead.all_emails,
                lead.email_status, newHook, newStatus, lead.location, lead.contacted, existing.id
            ]);
            return updateRes.rows[0];
        } else {
            const insertRes = await client.query(`
                INSERT INTO leads (
                    id, linkedin_url, first_name, last_name, company, website, website_source,
                    email, all_emails, email_status, hook, pipeline_status, location, contacted
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
                RETURNING *
            `, [
                id, linkedin_url, lead.first_name || '', lead.last_name || '', lead.company || '',
                lead.website || '', lead.website_source || '', email, lead.all_emails || '',
                lead.email_status || 'UNVERIFIED', hook, pipelineStatus, lead.location || '', lead.contacted || false
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
                const newStatus = lead.pipeline_status || existing.pipeline_status || 'INBOX';

                const updateRes = await client.query(`
                    UPDATE leads 
                    SET linkedin_url = COALESCE($1, linkedin_url),
                        first_name = COALESCE($2, first_name),
                        last_name = COALESCE($3, last_name),
                        company = COALESCE($4, company),
                        website = COALESCE($5, website),
                        website_source = COALESCE($6, website_source),
                        email = $7,
                        all_emails = COALESCE($8, all_emails),
                        email_status = COALESCE($9, email_status),
                        hook = $10,
                        pipeline_status = $11,
                        location = COALESCE($12, location),
                        contacted = COALESCE($13, contacted)
                    WHERE id = $14
                    RETURNING *
                `, [
                    lead.linkedin_url, lead.first_name, lead.last_name, lead.company,
                    lead.website, lead.website_source, newEmail, lead.all_emails,
                    lead.email_status, newHook, newStatus, lead.location, lead.contacted, existing.id
                ]);
                results.push(updateRes.rows[0]);
            } else {
                const insertRes = await client.query(`
                    INSERT INTO leads (
                        id, linkedin_url, first_name, last_name, company, website, website_source,
                        email, all_emails, email_status, hook, pipeline_status, location, contacted
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
                    RETURNING *
                `, [
                    id, linkedin_url, lead.first_name || '', lead.last_name || '', lead.company || '',
                    lead.website || '', lead.website_source || '', email, lead.all_emails || '',
                    lead.email_status || 'UNVERIFIED', hook, pipelineStatus, lead.location || '', lead.contacted || false
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
        const res = await client.query('SELECT * FROM leads WHERE id = $1', [id]);
        const existing = res.rows[0];
        if (!existing) throw new Error("Lead not found");

        const newEmail = updates.email !== undefined ? updates.email : existing.email;
        const newHook = updates.hook !== undefined ? updates.hook : existing.hook;
        const newStatus = updates.pipeline_status || existing.pipeline_status || 'INBOX';

        const updateRes = await client.query(`
            UPDATE leads 
            SET linkedin_url = COALESCE($1, linkedin_url),
                first_name = COALESCE($2, first_name),
                last_name = COALESCE($3, last_name),
                company = COALESCE($4, company),
                website = COALESCE($5, website),
                website_source = COALESCE($6, website_source),
                email = $7,
                all_emails = COALESCE($8, all_emails),
                email_status = COALESCE($9, email_status),
                hook = $10,
                pipeline_status = $11,
                location = COALESCE($12, location),
                contacted = COALESCE($13, contacted)
            WHERE id = $14
            RETURNING *
        `, [
            updates.linkedin_url, updates.first_name, updates.last_name, updates.company,
            updates.website, updates.website_source, newEmail, updates.all_emails,
            updates.email_status, newHook, newStatus, updates.location, updates.contacted, id
        ]);
        return updateRes.rows[0];
    } finally {
        client.release();
    }
}

export async function getLead(id: string): Promise<LeadRecord | undefined> {
    const client = await pool.connect();
    try {
        const res = await client.query('SELECT * FROM leads WHERE id = $1', [id]);
        return res.rows[0];
    } finally {
        client.release();
    }
}

export async function getAllLeads(): Promise<LeadRecord[]> {
    const client = await pool.connect();
    try {
        const res = await client.query('SELECT * FROM leads ORDER BY created_at DESC');
        return res.rows;
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
            SET contacted = TRUE 
            WHERE email = ANY($1) 
               OR linkedin_url = ANY($1)
            RETURNING id
        `, [identifiers]);
        return res.rowCount || 0;
    } finally {
        client.release();
    }
}
