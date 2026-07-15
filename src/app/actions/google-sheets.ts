"use server";

/**
 * Google Sheets Export — uses the Google Sheets REST API directly via fetch.
 * 3-Tab CRM Architecture: Inbox, Enrichment, Outreach Pipeline
 */

import crypto from 'crypto';

// ── Google Auth via Service Account JWT ──

interface ServiceAccountKey {
    client_email: string;
    private_key: string;
    project_id: string;
}

function getCredentials(): ServiceAccountKey | null {
    const b64 = process.env.GOOGLE_SHEETS_CREDENTIALS_BASE64;
    if (!b64) return null;
    try {
        const json = Buffer.from(b64, 'base64').toString('utf-8');
        return JSON.parse(json);
    } catch {
        console.error('Failed to parse GOOGLE_SHEETS_CREDENTIALS_BASE64');
        return null;
    }
}

function base64url(data: string | Buffer): string {
    const buf = typeof data === 'string' ? Buffer.from(data) : data;
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getAccessToken(creds: ServiceAccountKey): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64url(JSON.stringify({
        iss: creds.client_email,
        scope: 'https://www.googleapis.com/auth/spreadsheets',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
    }));

    const signatureInput = `${header}.${payload}`;
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(signatureInput);
    const signature = base64url(sign.sign(creds.private_key));
    const jwt = `${signatureInput}.${signature}`;

    const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Google OAuth failed: ${response.status} — ${err}`);
    }

    const data = await response.json();
    return data.access_token;
}

// ── Sheets API Helpers ──

async function getSpreadsheetDetails(token: string, spreadsheetId: string): Promise<any> {
    const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!response.ok) return null;
    return await response.json();
}

async function createSpreadsheet(token: string, title: string): Promise<string> {
    const response = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            properties: { title },
            sheets: [
                { properties: { title: 'Outreach Pipeline (CRM)', gridProperties: { frozenRowCount: 1 } } },
                { properties: { title: 'Enrichment (Processing)', gridProperties: { frozenRowCount: 1 } } },
                { properties: { title: 'Inbox (Raw Leads)', gridProperties: { frozenRowCount: 1 } } },
            ],
        }),
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Failed to create spreadsheet: ${response.status} — ${err}`);
    }

    const data = await response.json();
    return data.spreadsheetId;
}

async function ensureSheetsExist(token: string, spreadsheetId: string, requiredTitles: string[]): Promise<number[]> {
    const details = await getSpreadsheetDetails(token, spreadsheetId);
    if (!details) throw new Error("Could not fetch spreadsheet details");

    const existingSheets = details.sheets.map((s: any) => ({
        title: s.properties.title,
        sheetId: s.properties.sheetId
    }));
    
    const existingTitles = existingSheets.map((s: any) => s.title);
    const missingTitles = requiredTitles.filter(t => !existingTitles.includes(t));
    
    if (missingTitles.length > 0) {
        const requests = missingTitles.map(title => ({
            addSheet: {
                properties: { title, gridProperties: { frozenRowCount: 1 } }
            }
        }));
        
        await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ requests }),
        });
        
        const newDetails = await getSpreadsheetDetails(token, spreadsheetId);
        return requiredTitles.map(t => newDetails.sheets.find((s: any) => s.properties.title === t).properties.sheetId);
    }
    
    return requiredTitles.map(t => existingSheets.find((s: any) => s.title === t).sheetId);
}

async function clearAndWriteSheet(token: string, spreadsheetId: string, sheetName: string, rows: string[][]): Promise<void> {
    const encodedSheetName = encodeURIComponent(sheetName);
    const range = `'${encodedSheetName}'!A:Z`;
    
    await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?key=`,
        {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ range: `'${sheetName}'!A:Z`, majorDimension: 'ROWS', values: [] }),
        }
    ).catch(() => { });

    const writeRange = `'${sheetName}'!A1`;
    const writeRangeEncoded = `'${encodedSheetName}'!A1`;
    const response = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${writeRangeEncoded}?valueInputOption=USER_ENTERED`,
        {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ range: writeRange, majorDimension: 'ROWS', values: rows }),
        }
    );

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Failed to write data to ${sheetName}: ${response.status} — ${err}`);
    }
}

async function formatSheets(token: string, spreadsheetId: string, sheetIds: number[]): Promise<void> {
    const requests: any[] = [];
    for (const sheetId of sheetIds) {
        requests.push({
            repeatCell: {
                range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
                cell: {
                    userEnteredFormat: {
                        textFormat: { bold: true, fontSize: 11 },
                        backgroundColor: { red: 0.15, green: 0.15, blue: 0.15 },
                        horizontalAlignment: 'CENTER',
                    },
                },
                fields: 'userEnteredFormat(textFormat,backgroundColor,horizontalAlignment)',
            },
        });
        requests.push({
            autoResizeDimensions: { dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 10 } }
        });
    }

    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests }),
    }).catch(() => { });
}

// ── Public Export Function ──

export async function exportToGoogleSheets(leads: any[]): Promise<{ success: boolean; url?: string; error?: string }> {
    try {
        const creds = getCredentials();
        if (!creds) {
            return {
                success: false,
                error: 'Google Sheets credentials not configured. Set GOOGLE_SHEETS_CREDENTIALS_BASE64 in .env.local (see .env.example).',
            };
        }

        console.log('Google Sheets: Authenticating...');
        const token = await getAccessToken(creds);

        // 3-Tab Architecture setup
        const outreachHeaders = ['First Name', 'Last Name', 'Company', 'Website', 'Email', 'All Emails', 'Hook', 'Website Source', 'LinkedIn URL'];
        const enrichmentHeaders = ['First Name', 'Last Name', 'Company', 'Website', 'Email', 'All Emails', 'Hook', 'Website Source', 'LinkedIn URL', 'Verification Status', 'Enrichment Status'];
        const inboxHeaders = ['Date Added', 'LinkedIn URL', 'Niche/Job Title', 'Status', 'Website Source'];
        
        const outreachRows: string[][] = [outreachHeaders];
        const enrichmentRows: string[][] = [enrichmentHeaders];
        const inboxRows: string[][] = [inboxHeaders];

        leads.forEach((lead) => {
            const linkedinUrl = lead.linkedin_url || lead.url || '';
            const firstName = lead.first_name || lead.firstName || '';
            const lastName = lead.last_name || lead.lastName || '';
            const company = lead.company || lead.company_name || '';
            const website = lead.website || (lead.websites ? lead.websites.join('; ') : '') || '';
            const email = lead.email || (lead.emails && lead.emails.length > 0 ? lead.emails[0] : '') || '';
            const allEmails = lead.all_emails || (lead.emails ? lead.emails.join('; ') : '') || '';
            const hook = lead.hook || '';
            const websiteSource = lead.website_source || '';
            const status = lead.status || '';

            const hasValidEmail = !!email;
            const hasHook = !!hook;

            if (hasValidEmail && hasHook) {
                // Fully qualified
                outreachRows.push([firstName, lastName, company, website, email, allEmails, hook, websiteSource, linkedinUrl]);
            } else if (firstName || website || email || hook || allEmails) {
                // Needs work / missing components
                const vStatus = hasValidEmail ? 'Valid' : 'Missing Email';
                const eStatus = hasHook ? 'Has Hook' : 'Missing Hook';
                enrichmentRows.push([firstName, lastName, company, website, email, allEmails, hook, websiteSource, linkedinUrl, vStatus, eStatus]);
            } else {
                // Raw lead
                inboxRows.push([new Date().toISOString().split('T')[0], linkedinUrl, '', status, websiteSource]);
            }
        });

        const sheetNames = ['Outreach Pipeline (CRM)', 'Enrichment (Processing)', 'Inbox (Raw Leads)'];
        let spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

        if (!spreadsheetId) {
            const title = `Revlane CRM — ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}`;
            console.log(`Google Sheets: Creating new spreadsheet "${title}"...`);
            spreadsheetId = await createSpreadsheet(token, title);
        }

        console.log(`Google Sheets: Ensuring 3-tab structure exists in spreadsheet ${spreadsheetId}...`);
        const sheetIds = await ensureSheetsExist(token, spreadsheetId, sheetNames);

        console.log(`Google Sheets: Writing data...`);
        if (outreachRows.length > 1) await clearAndWriteSheet(token, spreadsheetId, sheetNames[0], outreachRows);
        if (enrichmentRows.length > 1) await clearAndWriteSheet(token, spreadsheetId, sheetNames[1], enrichmentRows);
        if (inboxRows.length > 1) await clearAndWriteSheet(token, spreadsheetId, sheetNames[2], inboxRows);

        await formatSheets(token, spreadsheetId, sheetIds);

        const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
        console.log(`Google Sheets: Export complete → ${url}`);

        return { success: true, url };
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error('Google Sheets export error:', message);
        return { success: false, error: message };
    }
}

export async function isGoogleSheetsConfigured(): Promise<boolean> {
    return !!getCredentials();
}
