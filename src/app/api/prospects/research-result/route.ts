import { NextResponse } from 'next/server';
import { saveProspectResearch, assessmentForLead } from '@/lib/prospect-store';
import { verifyEmail } from '@/app/actions/email-verifier-actions';
import { updateLeadEmailVerification } from '@/lib/db';
import { toPersistedVerification } from '@/lib/verification-persist';
import { isContactNow, validateResearch } from '@/lib/prospect-qualification.cjs';
import { hasFreshSmtpProof } from '@/lib/email-verification-proof';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const research = validateResearch(body.research);
        let lead = await saveProspectResearch({
            linkedinUrl: String(body.linkedinUrl || ''), research,
            firstName: String(body.firstName || '').slice(0, 255), lastName: String(body.lastName || '').slice(0, 255),
            email: String(body.email || '').slice(0, 320), emails: research.contacts.map(c => c.address),
            emailSource: String(body.emailSource || ''), websiteSource: String(body.websiteSource || ''),
        });
        // Business placement does not depend on a probe being available or successful.
        if (!hasFreshSmtpProof(lead) && isContactNow(lead.prospect_assessment) && lead.email && ['PUBLISHED', 'DOMAIN_MATCH', 'MANUAL_CONFIRMED'].includes(lead.prospect_assessment!.contact.ownership)) {
            try { lead = await updateLeadEmailVerification(lead.id, toPersistedVerification(await verifyEmail(lead.email, 'automation'))); }
            catch { /* contact verification remains unknown; commercial research is retained */ }
        }
        return NextResponse.json({ ok: true, id: lead.id, tier: lead.prospect_assessment?.tier, pipelineStatus: lead.pipeline_status, assessment: assessmentForLead(lead) });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Prospect research could not be saved.';
        console.error('[prospects] Save failed:', message);
        return NextResponse.json({ error: message }, { status: 400 });
    }
}
