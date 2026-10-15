"use server";

import { updateLead, updateLeadEmailVerification, deleteLead, bulkDeleteLeads, getLead, getLeadsByIds, getAllLeads, type EmailVerificationUpdate, LeadRecord, insertOrUpdateLead, bulkInsertOrUpdateLeads, bulkMarkContacted, setLeadOutcome, setDoNotContact } from "@/lib/db";
import { classifyJunkAddress } from "@/lib/junk-addresses";
import { getVerificationReadiness, verifyEmail, verifyEmailBatchFast } from "@/app/actions/email-verifier-actions";
import { toPersistedVerification } from "@/lib/verification-persist";
import { verifyCrmEmailBatch } from '@/lib/crm-email-verification';

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
    const readiness = await getVerificationReadiness();
    if (!readiness.ready) throw new Error(readiness.message);
    const result = await verifyEmail(lead.email, "crm");
    return await updateLeadEmailVerification(id, toPersistedVerification(result));
}

/** Batch verification through the configured primary provider. */
export async function verifyLeadEmailsAction(ids: string[]) {
    return verifyCrmEmailBatch(ids, {
        getLeads: getLeadsByIds,
        verify: async emails => {
            const readiness = await getVerificationReadiness();
            if (!readiness.ready) throw new Error(readiness.message);
            return verifyEmailBatchFast(emails);
        },
        save: (id, result) => updateLeadEmailVerification(id, toPersistedVerification(result)),
    });
}

/**
 * Ticking the box for a single lead is a deliberate claim that this person was
 * reached, so it's stamped MANUAL and trusted like any other evidence. Bulk pushes
 * deliberately don't do this — see `ContactedSource`.
 */
export async function toggleContactedAction(id: string, contacted: boolean) {
    const existing = await getLead(id);
    if (!existing) throw new Error('Lead not found.');
    if (existing.in_hunter && !contacted)
        throw new Error('This lead is already managed in Case Study Hunter and remains marked contacted here.');
    if (existing.contacted_source === 'LINKEDIN' || existing.linkedin_dm_at) {
        if (!contacted) throw new Error('This DM is tracked in the Hunter. Update its outreach record there.');
        return existing;
    }
    return await updateLead(id, { contacted, contacted_source: contacted ? 'MANUAL' : null });
}

/** Records the result of outreach. NOT_INTERESTED and BOUNCED also suppress the lead. */
export async function setLeadOutcomeAction(id: string, outcome: string) {
    return await setLeadOutcome(id, outcome);
}

export async function setDoNotContactAction(ids: string[], flag: boolean) {
    return await setDoNotContact(ids, flag);
}

/**
 * Suppresses addresses that can't belong to a lead — placeholders left in website
 * markup, vendor and registrar contacts the crawler picked up, mangled fragments.
 * Several of these verify fine over SMTP because they are real mailboxes, just not
 * the lead's, so verification never catches them. Suppression rather than deletion:
 * the lead row still carries a LinkedIn URL worth re-scraping.
 */
export async function suppressJunkAddressesAction(): Promise<{
    suppressed: number;
    byReason: Record<string, number>;
    examples: { email: string; reason: string }[];
}> {
    const leads = await getAllLeads();
    const byReason: Record<string, number> = {};
    const examples: { email: string; reason: string }[] = [];
    const ids: string[] = [];

    for (const lead of leads) {
        if (!lead.email || lead.do_not_contact) continue;
        const reason = classifyJunkAddress(lead.email);
        if (!reason) continue;
        ids.push(lead.id);
        byReason[reason] = (byReason[reason] || 0) + 1;
        if (examples.length < 30) examples.push({ email: lead.email, reason });
    }

    const suppressed = ids.length ? await setDoNotContact(ids, true) : 0;
    return { suppressed, byReason, examples };
}

export async function generateHookAction(_id: string): Promise<LeadRecord | null> {
    throw new Error('AI hook generation is disabled.');
}

export async function pushLeadsToInboxAction(ids: string[]) {
    const results = [];
    for (const id of ids) {
        try {
            results.push(await updateLead(id, { pipeline_status: 'INBOX' }));
        } catch (e) {
            console.error("Failed to push lead to inbox", id, e);
        }
    }
    return results;
}

export async function importLeadsAction(leads: Partial<LeadRecord>[]) {
    try {
        // Imports are leads to be verified, never a bypass around the strict
        // send gate. Existing SMTP evidence is retained only when the
        // incoming email has not changed (enforced again in the DB layer).
        const importedLeads = leads;
        return await bulkInsertOrUpdateLeads(importedLeads);
    } catch (e) {
        console.error("Failed to bulk import leads", e);
        return [];
    }
}

export async function markLeadsContactedAction(identifiers: string[]) {
    try {
        return await bulkMarkContacted(identifiers);
    } catch (e) {
        console.error("Failed to bulk mark contacted", e);
        return 0;
    }
}
