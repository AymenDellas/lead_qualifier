import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { importCampaignReportsAction } from '@/app/actions/campaign-import-actions';

export const dynamic = 'force-dynamic';
export const maxDuration = 800;

/**
 * Same import as the CRM's "Import Campaign Report" button, exposed as an endpoint
 * so a folder of exports can be reconciled without picking files by hand.
 *
 *   curl -X POST http://localhost:3000/api/admin/import-campaigns \
 *        -H 'Content-Type: application/json' \
 *        -d '{"dir":"C:/Users/me/Downloads"}'
 *
 * `dir` reads every .csv in that folder whose name looks like a campaign report.
 * Alternatively pass `files: [{name, content}]` directly. Lead exports living in
 * the same folder are skipped by name — importing one would tell us who was
 * *pushed*, which is the very thing that made the contacted flag wrong.
 */
export async function POST(request: Request) {
    try {
        const body = await request.json().catch(() => ({}));
        let files: { name: string; content: string }[] = body.files || [];

        if (!files.length && body.dir) {
            const dir = String(body.dir);
            const entries = await fs.readdir(dir);
            const candidates = entries.filter(name =>
                name.toLowerCase().endsWith('.csv') && /campaign|report/i.test(name)
            );
            files = await Promise.all(candidates.map(async name => ({
                name,
                content: await fs.readFile(path.join(dir, name), 'utf8'),
            })));
        }

        if (!files.length) {
            return NextResponse.json(
                { ok: false, error: 'Pass either { dir } or { files: [{name, content}] }. No campaign report CSVs found.' },
                { status: 400 },
            );
        }

        const report = await importCampaignReportsAction(files);
        return NextResponse.json(report, { status: report.ok ? 200 : 500 });
    } catch (error: any) {
        console.error('Campaign import failed:', error);
        return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
}
