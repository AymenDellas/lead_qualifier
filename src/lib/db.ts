import path from 'path';
import fs from 'fs';

// Ensure data directory exists
const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'leads_db.json');
const sqliteBackupPath = path.join(dataDir, 'leads_db.sqlite');

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

// Helper to read DB synchronously (fine for local scale)
function readDb(): LeadRecord[] {
    if (!fs.existsSync(dbPath)) {
        fs.writeFileSync(dbPath, JSON.stringify([]));
        return [];
    }
    try {
        const data = fs.readFileSync(dbPath, 'utf8');
        return JSON.parse(data) as LeadRecord[];
    } catch {
        return [];
    }
}

// Helper to write DB
function writeDb(leads: LeadRecord[]) {
    fs.writeFileSync(dbPath, JSON.stringify(leads, null, 2));
}

export function generateId(): string {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

export function determinePipelineStatus(email: string, hook: string, currentStatus?: string): string {
    return currentStatus || 'INBOX';
}

export async function insertOrUpdateLead(lead: Partial<LeadRecord>): Promise<LeadRecord> {
    const leads = readDb();
    
    const email = lead.email || '';
    const hook = lead.hook || '';
    const pipelineStatus = lead.pipeline_status || 'INBOX';
    const linkedin_url = lead.linkedin_url || '';

    // Check if lead with this linkedin_url already exists
    let existingIndex = -1;
    if (linkedin_url && !lead.id) {
        existingIndex = leads.findIndex(l => l.linkedin_url === linkedin_url);
    } else if (lead.id) {
        existingIndex = leads.findIndex(l => l.id === lead.id);
    }

    if (existingIndex >= 0) {
        // Update existing
        const current = leads[existingIndex];
        const newEmail = lead.email !== undefined ? lead.email : current.email;
        const newHook = lead.hook !== undefined ? lead.hook : current.hook;
        const newStatus = lead.pipeline_status || current.pipeline_status || 'INBOX';
        
        leads[existingIndex] = {
            ...current,
            ...lead,
            pipeline_status: newStatus,
        };
        writeDb(leads);
        return leads[existingIndex];
    } else {
        // Insert new
        const newLead: LeadRecord = {
            id: lead.id || generateId(),
            linkedin_url,
            first_name: lead.first_name || '',
            last_name: lead.last_name || '',
            company: lead.company || '',
            website: lead.website || '',
            website_source: lead.website_source || '',
            email,
            all_emails: lead.all_emails || '',
            email_status: lead.email_status || 'UNVERIFIED',
            hook,
            pipeline_status: pipelineStatus,
            location: lead.location || '',
            contacted: lead.contacted || false,
            created_at: new Date().toISOString()
        };
        leads.push(newLead);
        writeDb(leads);
        return newLead;
    }
}

export async function bulkInsertOrUpdateLeads(newLeads: Partial<LeadRecord>[]): Promise<LeadRecord[]> {
    const leads = readDb();
    
    // Create a map for fast lookup by id or linkedin_url
    const urlMap = new Map<string, number>();
    const idMap = new Map<string, number>();
    
    leads.forEach((l, idx) => {
        if (l.linkedin_url) urlMap.set(l.linkedin_url, idx);
        if (l.id) idMap.set(l.id, idx);
    });

    const results: LeadRecord[] = [];
    let madeChanges = false;

    for (const lead of newLeads) {
        const email = lead.email || '';
        const hook = lead.hook || '';
        const pipelineStatus = lead.pipeline_status || 'INBOX';
        const linkedin_url = lead.linkedin_url || '';

        let existingIndex = -1;
        if (linkedin_url && !lead.id) {
            existingIndex = urlMap.get(linkedin_url) ?? -1;
        } else if (lead.id) {
            existingIndex = idMap.get(lead.id) ?? -1;
        }

        if (existingIndex >= 0) {
            // Update existing
            const current = leads[existingIndex];
            const newEmail = lead.email !== undefined ? lead.email : current.email;
            const newHook = lead.hook !== undefined ? lead.hook : current.hook;
            const newStatus = lead.pipeline_status || current.pipeline_status || 'INBOX';
            
            leads[existingIndex] = {
                ...current,
                ...lead,
                pipeline_status: newStatus,
            };
            results.push(leads[existingIndex]);
            madeChanges = true;
        } else {
            // Insert new
            const newLead: LeadRecord = {
                id: lead.id || generateId(),
                linkedin_url,
                first_name: lead.first_name || '',
                last_name: lead.last_name || '',
                company: lead.company || '',
                website: lead.website || '',
                website_source: lead.website_source || '',
                email,
                all_emails: lead.all_emails || '',
                email_status: lead.email_status || 'UNVERIFIED',
                hook,
                pipeline_status: pipelineStatus,
                location: lead.location || '',
                contacted: lead.contacted || false,
                created_at: new Date().toISOString()
            };
            leads.push(newLead);
            
            // Add to maps
            urlMap.set(newLead.linkedin_url, leads.length - 1);
            idMap.set(newLead.id, leads.length - 1);
            
            results.push(newLead);
            madeChanges = true;
        }
    }

    if (madeChanges) {
        writeDb(leads);
    }
    
    return results;
}

export async function updateLead(id: string, updates: Partial<LeadRecord>): Promise<LeadRecord> {
    const leads = readDb();
    const index = leads.findIndex(l => l.id === id);
    
    if (index >= 0) {
        const current = leads[index];
        const newEmail = updates.email !== undefined ? updates.email : current.email;
        const newHook = updates.hook !== undefined ? updates.hook : current.hook;
        const newStatus = updates.pipeline_status || current.pipeline_status || 'INBOX';
        
        leads[index] = {
            ...current,
            ...updates,
            id, // protect id
            created_at: current.created_at, // protect created_at
            pipeline_status: newStatus,
        };
        writeDb(leads);
        return leads[index];
    }
    throw new Error("Lead not found");
}

export async function getLead(id: string): Promise<LeadRecord | undefined> {
    const leads = readDb();
    return leads.find(l => l.id === id);
}

export async function getAllLeads(): Promise<LeadRecord[]> {
    const leads = readDb();
    // Sort descending by created_at
    return leads.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

export async function deleteLead(id: string): Promise<void> {
    const leads = readDb();
    const filtered = leads.filter(l => l.id !== id);
    if (filtered.length !== leads.length) {
        writeDb(filtered);
    }
}

export async function bulkDeleteLeads(ids: string[]): Promise<void> {
    const leads = readDb();
    const idSet = new Set(ids);
    const filtered = leads.filter(l => !idSet.has(l.id));
    if (filtered.length !== leads.length) {
        writeDb(filtered);
    }
}

// Restore JSON from backup if it was migrated
function restoreJsonBackup() {
    const backupPath = dbPath + '.backup';
    if (fs.existsSync(backupPath)) {
        if (!fs.existsSync(dbPath) || fs.readFileSync(dbPath, 'utf8') === '[]') {
            fs.copyFileSync(backupPath, dbPath);
            console.log('Restored leads_db.json from backup.');
        }
    }
}

restoreJsonBackup();
