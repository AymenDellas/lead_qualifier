/**
 * Environment variable validation.
 * Call validateEnv() on server startup to ensure all required vars are present.
 */

type EnvVar = {
    name: string;
    required: boolean;
    description: string;
};

const ENV_VARS: EnvVar[] = [
    { name: 'BRIGHT_DATA_API_KEY', required: true, description: 'Bright Data API authentication key' },
    { name: 'BD_DATASET_ACTIVITY', required: true, description: 'Bright Data dataset ID for activity checks' },
    { name: 'BD_DATASET_PROFILES', required: true, description: 'Bright Data dataset ID for profile scraping' },
    { name: 'BD_DATASET_WEB_SCRAPER', required: true, description: 'Bright Data dataset ID for web scraping' },
    { name: 'LINKEDIN_LI_AT', required: true, description: 'LinkedIn li_at session cookie' },
    { name: 'BD_PROXY_URL', required: false, description: 'Bright Data residential proxy URL' },
    { name: 'GOOGLE_SHEETS_CREDENTIALS_BASE64', required: false, description: 'Base64-encoded Google service account credentials JSON' },
    { name: 'GOOGLE_SHEETS_SPREADSHEET_ID', required: false, description: 'Default Google Sheets spreadsheet ID' },
];

export function validateEnv(): { valid: boolean; missing: string[]; warnings: string[] } {
    const missing: string[] = [];
    const warnings: string[] = [];

    for (const v of ENV_VARS) {
        const value = process.env[v.name];
        if (!value || value.trim() === '') {
            if (v.required) {
                missing.push(`❌ ${v.name} — ${v.description}`);
            } else {
                warnings.push(`⚠️  ${v.name} — ${v.description} (optional, feature disabled)`);
            }
        }
    }

    if (missing.length > 0) {
        console.error('\n╔══════════════════════════════════════════╗');
        console.error('║  MISSING REQUIRED ENVIRONMENT VARIABLES  ║');
        console.error('╚══════════════════════════════════════════╝\n');
        missing.forEach(m => console.error(m));
        console.error('\n→ Copy .env.example to .env.local and fill in the values.\n');
    }

    if (warnings.length > 0) {
        console.warn('\n── Optional Variables Not Set ──');
        warnings.forEach(w => console.warn(w));
        console.warn('');
    }

    return { valid: missing.length === 0, missing, warnings };
}

export function getEnvStatus(): { configured: Record<string, boolean> } {
    const configured: Record<string, boolean> = {};
    for (const v of ENV_VARS) {
        const value = process.env[v.name];
        configured[v.name] = !!(value && value.trim() !== '');
    }
    return { configured };
}
