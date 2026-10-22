import { z } from 'zod/v4';
import type { ClientProject } from '../../business';
import { legacyOfferName } from '../../offer-essentials';
import { briefSchema, copyContextSchema, onboardingLinkSchema, templateIdSchema, importResultSchema } from './contracts';

export const onboardingBriefSchema = onboardingLinkSchema.extend({
  businessName: z.string(),
  website: z.string(),
  landingPageUrl: z.string(),
  formStatus: z.string(),
  template: templateIdSchema,
  brief: briefSchema,
  context: copyContextSchema,
  source: importResultSchema.nullable().default(null),
});
export type OnboardingBrief = z.infer<typeof onboardingBriefSchema>;

const bounded = (value?: string) => (value || '').trim().slice(0, 6000);
/** Client answers only. Agency pricing, delivery scope and permissions are not offer facts. */
export function toOnboardingBrief(project: ClientProject): OnboardingBrief | null {
  const data = project.data.onboarding;
  if (!data) return null;
  const form = data.form;
    const reviewed = data.journey?.reviewSummaries || {};
  const offer = bounded(form.offer);
  return {
    id: project.id,
    revision: project.revision,
    clientName: data.clientName.slice(0, 200),
    businessName: data.businessName,
    projectName: (data.projectName || project.data.name).slice(0, 200),
    updatedAt: project.updatedAt,
    website: data.website,
    landingPageUrl: form.landingPageUrl,
    formStatus: form.status,
    template: project.data.funnel === 'VSL' ? 'vsl' : project.data.funnel === 'LEAD_MAGNET' ? 'lead_magnet' : 'direct_to_call',
    brief: briefSchema.parse({
      offerName: bounded(form.offerName ?? legacyOfferName(form.offer)),
      description: offer,
      audience: bounded(form.audience),
      problem: bounded(form.customerProblem),
      outcome: bounded(form.desiredOutcome),
      mechanism: bounded(reviewed.differentiation ?? form.differentiation),
      coachBio: bounded(reviewed.coachBio ?? form.coachBio),
      proof: (form.proof || '').trim().slice(0, 480000),
    }),
    source: data.journey?.reference || null,
    context: copyContextSchema.parse({
      mustKeep: bounded(form.mustStay), avoid: bounded(form.avoid),
      background: bounded([
        reviewed.proof !== undefined && `Client-reviewed proof: ${reviewed.proof || 'The client removed this detail.'} Treat these corrections as authoritative over conflicting original context; do not rewrite testimonial quotations.`,
        data.journey?.requestedChanges && `Changes requested by the client: ${data.journey.requestedChanges.slice(0, 2000)}`,
        (reviewed.unsuitableClients ?? form.unsuitableClients) && `Unsuitable clients (use for audience fit and booking qualification): ${bounded(reviewed.unsuitableClients ?? form.unsuitableClients).slice(0, 2500)}`,
        (reviewed.trafficSources ?? form.trafficSources) && `Traffic sources: ${reviewed.trafficSources ?? form.trafficSources}`,
        form.qualification && `Buyer qualification: ${form.qualification}`,
        form.importantContext && `Additional client context: ${form.importantContext}`,
        form.preferences && `Client preferences: ${form.preferences}`,
      ].filter(Boolean).join('\n\n')),
    }),
  };
}

function pageIdentity(value: string) {
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return { host: url.hostname.toLowerCase().replace(/^www\./, ''), path: url.pathname.replace(/\/+$/, '') || '/' };
  } catch { return null; }
}
/** Prefer an exact landing page; same-domain projects remain visible for operator review. */
export function matchOnboardings(records: OnboardingBrief[], url: string): OnboardingBrief[] {
  const page = pageIdentity(url);
  if (!page) return [];
  return records.map((record) => {
    const identities = [record.landingPageUrl, record.website].map(pageIdentity).filter((item) => item !== null);
    const score = Math.max(0, ...identities.map((item) => item.host === page.host ? (item.path === page.path ? 2 : 1) : 0));
    return { record, score };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).map((item) => item.record);
}
