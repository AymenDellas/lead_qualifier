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

        let finalContext = websiteText;

        // If the user passes a raw URL from n8n, fetch and parse the text automatically
        if (websiteText.startsWith('http://') || websiteText.startsWith('https://')) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 10000);
                const res = await fetch(websiteText, {
                    signal: controller.signal,
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
                });
                clearTimeout(timeoutId);
                
                if (res.ok) {
                    const html = await res.text();
                    // Basic regex to strip script/style tags and then all other HTML tags
                    const text = html
                        .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
                        .replace(/<[^>]+>/g, ' ')
                        .replace(/\s+/g, ' ')
                        .trim();
                    if (text.length > 200) {
                        finalContext = text;
                    }
                }
            } catch (fetchErr) {
                console.error("Failed to scrape URL for hook generation, falling back to URL string:", fetchErr);
            }
        }

        const result = await generateHook(finalContext, apiKeyIndex || 0);

        return NextResponse.json({ success: true, result });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
