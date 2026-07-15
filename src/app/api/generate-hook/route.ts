import { NextResponse } from 'next/server';
import { generateHook } from '@/lib/groqClient';
import { runDorkEngine } from '@/lib/dorkEngine'; // Just to ensure imports work, though not used here

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { websiteText, apiKeyIndex } = body;

        if (!websiteText) {
            return NextResponse.json({ error: 'Missing websiteText' }, { status: 400 });
        }

        const result = await generateHook(websiteText, apiKeyIndex || 0);

        return NextResponse.json({ success: true, result });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
