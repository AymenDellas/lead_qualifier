import { NextRequest, NextResponse } from "next/server";
import { processSingleLead } from "@/app/actions/scraper-actions";

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { linkedinUrl } = body;

        if (!linkedinUrl || typeof linkedinUrl !== "string") {
            return NextResponse.json(
                { error: "Missing or invalid 'linkedinUrl' field" },
                { status: 400 }
            );
        }

        const result = await processSingleLead(linkedinUrl);
        return NextResponse.json(result);
    } catch (error) {
        console.error("POST /api/process-lead error:", error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Internal server error" },
            { status: 500 }
        );
    }
}
