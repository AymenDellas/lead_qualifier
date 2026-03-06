"use server";

/**
 * Google Sheets Export — uses the Google Sheets REST API directly via fetch.
 * No additional npm packages required.
 *
 * Setup:
 * 1. Create a Google Cloud project & enable the Google Sheets API
 * 2. Create a service account & download the JSON key
 * 3. Base64-encode the JSON key: base64 -w0 credentials.json
 * 4. Set GOOGLE_SHEETS_CREDENTIALS_BASE64 in .env.local
 * 5. Optionally set GOOGLE_SHEETS_SPREADSHEET_ID to append to an existing sheet
 */

import crypto from 'crypto';
import type { Lead } from './scraper-actions';

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

async function createSpreadsheet(token: string, title: string): Promise<string> {
    const response = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            properties: { title },
            sheets: [{
                properties: {
                    title: 'Qualified Leads',
                    gridProperties: { frozenRowCount: 1 },
                },
            }],
        }),
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Failed to create spreadsheet: ${response.status} — ${err}`);
    }

    const data = await response.json();
    return data.spreadsheetId;
}

async function clearAndWriteSheet(token: string, spreadsheetId: string, rows: string[][]): Promise<void> {
    // Clear existing data
    await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/A:Z?key=`,
        {
            method: 'PUT' as string,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                range: 'A:Z',
                majorDimension: 'ROWS',
                values: [],
            }),
        }
    ).catch(() => { }); // Ignore errors on clear

    // Write the data
    const response = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/A1?valueInputOption=USER_ENTERED`,
        {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                range: 'A1',
                majorDimension: 'ROWS',
                values: rows,
            }),
        }
    );

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Failed to write data: ${response.status} — ${err}`);
    }
}

async function formatSheet(token: string, spreadsheetId: string, sheetId: number, rowCount: number): Promise<void> {
    const requests = [
        // Bold header row
        {
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
        },
        // Auto-resize columns
        { autoResizeDimensions: { dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 6 } } },
        // Conditional format: green for QUALIFIED
        {
            addConditionalFormatRule: {
                rule: {
                    ranges: [{ sheetId, startRowIndex: 1, endRowIndex: rowCount + 1, startColumnIndex: 3, endColumnIndex: 4 }],
                    booleanRule: {
                        condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'QUALIFIED' }] },
                        format: {
                            backgroundColor: { red: 0.85, green: 0.95, blue: 0.85 },
                            textFormat: { foregroundColor: { red: 0.1, green: 0.5, blue: 0.1 }, bold: true },
                        },
                    },
                },
                index: 0,
            },
        },
        // Conditional format: red for REJECTED
        {
            addConditionalFormatRule: {
                rule: {
                    ranges: [{ sheetId, startRowIndex: 1, endRowIndex: rowCount + 1, startColumnIndex: 3, endColumnIndex: 4 }],
                    booleanRule: {
                        condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'REJECTED' }] },
                        format: {
                            backgroundColor: { red: 0.95, green: 0.85, blue: 0.85 },
                            textFormat: { foregroundColor: { red: 0.7, green: 0.1, blue: 0.1 }, bold: true },
                        },
                    },
                },
                index: 1,
            },
        },
        // Conditional format: orange for ACTIVITY_FAILED
        {
            addConditionalFormatRule: {
                rule: {
                    ranges: [{ sheetId, startRowIndex: 1, endRowIndex: rowCount + 1, startColumnIndex: 3, endColumnIndex: 4 }],
                    booleanRule: {
                        condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'ACTIVITY_FAILED' }] },
                        format: {
                            backgroundColor: { red: 1.0, green: 0.93, blue: 0.8 },
                            textFormat: { foregroundColor: { red: 0.8, green: 0.5, blue: 0.0 }, bold: true },
                        },
                    },
                },
                index: 2,
            },
        },
    ];

    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ requests }),
    }).catch(() => { }); // Best-effort formatting
}

// ── Public Export Function ──

export async function exportToGoogleSheets(leads: Lead[]): Promise<{ success: boolean; url?: string; error?: string }> {
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

        // Build rows
        const headers = ['LinkedIn URL', 'First Name', 'Status', 'Activity Status', 'Websites', 'Emails'];
        const dataRows = leads.map(l => [
            l.url,
            l.firstName || '',
            l.status,
            l.activityStatus || '',
            (l.websites || []).join('; ') || l.website || '',
            l.emails.join('; '),
        ]);
        const allRows = [headers, ...dataRows];

        // Use existing spreadsheet or create new one
        let spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
        let isNew = false;

        if (!spreadsheetId) {
            const title = `Revlane Leads — ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}`;
            console.log(`Google Sheets: Creating new spreadsheet "${title}"...`);
            spreadsheetId = await createSpreadsheet(token, title);
            isNew = true;
        }

        console.log(`Google Sheets: Writing ${leads.length} leads to spreadsheet ${spreadsheetId}...`);
        await clearAndWriteSheet(token, spreadsheetId, allRows);

        // Apply formatting (best-effort)
        await formatSheet(token, spreadsheetId, 0, leads.length);

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
