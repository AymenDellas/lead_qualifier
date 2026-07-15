"use server";

import { updateLead, deleteLead, bulkDeleteLeads, getLead, LeadRecord } from "@/lib/db";
import { verifyEmail } from "@/app/actions/email-verifier-actions";
import { generateHook } from "@/lib/groqClient";

export async function updateLeadAction(id: string, updates: Partial<LeadRecord>) {
    return await updateLead(id, updates);
}

export async function deleteLeadAction(id: string) {
    return await deleteLead(id);
}

export async function bulkDeleteLeadsAction(ids: string[]) {
    return await bulkDeleteLeads(ids);
}

export async function verifyLeadEmailAction(id: string) {
    const lead = await getLead(id);
    if (!lead || !lead.email) return null;

    const result = await verifyEmail(lead.email);
    const newStatus = result.status === 'VALID' ? 'VALID' 
                    : result.status === 'RISKY' ? 'RISKY' 
                    : result.status === 'INVALID' ? 'INVALID' 
                    : 'UNVERIFIED';

    return await updateLead(id, { email_status: newStatus });
}

export async function toggleContactedAction(id: string, contacted: boolean) {
    return await updateLead(id, { contacted });
}

export async function generateHookAction(id: string) {
    const lead = await getLead(id);
    if (!lead) return null;

    // Use available data to generate a hook
    const context = `
        Name: ${lead.first_name} ${lead.last_name}
        Company: ${lead.company}
        LinkedIn URL: ${lead.linkedin_url}
        Website: ${lead.website || lead.website_source}
    `;

    try {
        const result = await generateHook(context, 0);
        if (result && result.hook) {
            return await updateLead(id, { hook: result.hook });
        }
        return lead;
    } catch (err) {
        console.error("Failed to generate hook", err);
        return lead;
    }
}
