import { NextRequest, NextResponse } from 'next/server';
import { canonicalLinkedinUrl } from '@/lib/case-study';
import { findExistingCaseStudyLinkedinUrls } from '@/lib/case-study-store';

export const dynamic = 'force-dynamic';

const key = (value: string) => value.toLowerCase().replace(/\/+$/, '');

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        if (!Array.isArray(body?.urls) || !body.urls.length || body.urls.length > 100)
            return NextResponse.json({ error: 'Send from 1 to 100 LinkedIn profile URLs.' }, { status: 400 });
        const urls = [...new Set<string>((body.urls as unknown[]).map((value) => canonicalLinkedinUrl(String(value))))];
        const existingUrls = await findExistingCaseStudyLinkedinUrls(urls);
        const existingKeys = new Set(existingUrls.map(key));
        const newUrls = urls.filter((url) => !existingKeys.has(key(url)));
        return NextResponse.json({ existingUrls, newUrls });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Could not check the prospect pipeline.' },
            { status: 500 },
        );
    }
}
