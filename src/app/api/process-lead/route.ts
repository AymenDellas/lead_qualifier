import { NextRequest, NextResponse } from "next/server";
import { processSingleLead } from "@/app/actions/scraper-actions";

// Extend the default route timeout — Render free tier still caps at 30s,
// but paid plans and other hosts respect this value.
export const maxDuration = 300; // 5 minutes

export async function GET() {
    return NextResponse.json({
        status: "ok",
        endpoint: "POST /api/process-lead",
        usage: {
            method: "POST",
            body: { linkedinUrl: "https://www.linkedin.com/in/some-profile" },
        },
    });
}

export async function POST(request: NextRequest) {
    const startTime = Date.now();
    try {
        const body = await request.json();
        const { linkedinUrl } = body;

        if (!linkedinUrl || typeof linkedinUrl !== "string") {
            return NextResponse.json(
                { error: "Missing or invalid 'linkedinUrl' field" },
                { status: 400 }
            );
        }

        console.log(`[API] Processing lead: ${linkedinUrl}`);
        const result = await processSingleLead(linkedinUrl);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[API] Done in ${elapsed}s — status: ${result.status}`);

        return NextResponse.json(result);
    } catch (error) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.error(`[API] Error after ${elapsed}s:`, error);
        return NextResponse.json(
            {
                error: error instanceof Error ? error.message : "Internal server error",
                elapsed: `${elapsed}s`,
            },
            { status: 500 }
        );
    }
}
