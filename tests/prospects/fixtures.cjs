'use strict';
const { emptyResearch, makeFact, FACT_KEYS, assessProspect } = require('../../src/lib/prospect-qualification.cjs');
const NOW = '2026-10-06T12:00:00.000Z';
function research(overrides = {}) {
    const value = emptyResearch({ linkedinUrl: 'https://www.linkedin.com/in/ava-morgan', headline: 'Independent Executive Coach | Founder', profileIdentityConfirmed: true }, NOW);
    value.website = 'https://avamorgan.test'; value.websiteStatus = 'OWNED';
    value.lastActivityAt = NOW; value.activityStatus = 'Active';
    const quote = { url: value.website, excerpt: 'I am Ava Morgan, an independent executive coach serving leaders in Canada.', source: 'WEBSITE', observedAt: NOW };
    for (const key of FACT_KEYS) {
        if (['economics', 'capacity'].includes(key)) continue;
        value.facts[key] = makeFact(['demandSignals', 'marketingControl'].includes(key) ? 'INDICATED' : 'OBSERVED', key === 'paidOffer' ? '12-week executive coaching programme' : 'Evidence for ' + key, 'Public evidence; confirm the operational details with the coach.', [quote]);
    }
    value.contacts = [{ address: 'ava@avamorgan.test', source: 'website', url: value.website, ownership: 'DOMAIN_MATCH' }];
    value.pages = [{ url: value.website, label: 'Ava Morgan executive coaching', status: 'inspected', note: 'Personal practice identity matched.' }];
    return { ...value, ...overrides };
}
function prospect(id, overrides = {}) {
    const r = research(); const a = assessProspect(r, { email: 'ava@avamorgan.test', emailProven: true, now: NOW });
    return { id, linkedin_url: r.linkedinUrl, first_name: 'TEST · Ava', last_name: 'Morgan', company: '', website: r.website,
        website_source: 'contact_modal', email: 'ava@avamorgan.test', all_emails: JSON.stringify(['ava@avamorgan.test']),
        email_status: 'VALID', email_verification_method: 'SMTP_DIRECT', email_verification_score: 98,
        email_verified_at: new Date().toISOString(), email_verification_expires_at: new Date(Date.now() + 86400000).toISOString(),
        hook: '', pipeline_status: 'QUALIFIED', location: 'Canada', contacted: false, do_not_contact: false,
        created_at: NOW, discovery_niche: 'Executive Coach', fit_score: 55, prospect_assessment: a,
        prospect_review: null, prospect_researched_at: NOW, ...overrides };
}
module.exports = { NOW, research, prospect };
