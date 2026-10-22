import { z } from 'zod/v4';
import { OFFER_ESSENTIAL_KEYS, OFFER_ESSENTIAL_LABELS } from '../../offer-essentials';

export const MAX_SOURCE_CHARACTERS = 240_000;
export const MAX_PROOF_CHARACTERS = MAX_SOURCE_CHARACTERS * 2;
export const EXTRACTION_VERSION = 3;

const text = z.string().trim().max(6000);
export const briefSchema = z.object({
  offerName: text.default(''),
  description: text.default(''),
  audience: text.default(''),
  problem: text.default(''),
  outcome: text.default(''),
  mechanism: text.default(''),
  deliverables: text.default(''),
  proof: z.string().trim().max(MAX_PROOF_CHARACTERS).default(''),
  coachBio: text.default(''),
  objections: text.default(''),
  price: text.default(''),
  guarantee: text.default(''),
  urgency: text.default(''),
  cta: text.default(''),
  voice: text.default('Clear, warm, and direct'),
  customerLanguage: text.default(''),
  nextStep: text.default(''),
});
export type Brief = z.infer<typeof briefSchema>;
export type BriefKey = keyof Brief;
export const templateIdSchema = z.enum(['direct_to_call', 'lead_magnet', 'vsl']);
export type TemplateId = z.infer<typeof templateIdSchema>;
export const formulaSchema = z.enum(['recommended', 'pas', 'aida', 'bab', 'star', 'fourps']);
export type FormulaId = z.infer<typeof formulaSchema>;
export const copyContextSchema = z.object({
  mode: z.enum(['current', 'focused', 'new']).default('current'),
  direction: text.default(''),
  background: text.default(''),
  mustKeep: text.default(''),
  avoid: text.default(''),
});
export type CopyContext = z.infer<typeof copyContextSchema>;
export const referenceModeSchema = z.enum(['preserve_voice', 'rework_voice', 'off']);
export type ReferenceMode = z.infer<typeof referenceModeSchema>;
export const referenceSchema = z.object({
  title: z.string().max(500),
  url: z.string().max(2000),
  text: z.string().min(1).max(MAX_SOURCE_CHARACTERS),
  headings: z.array(z.string().max(500)).max(60),
  selectedOffer: z.string().max(200).default(''),
  tone: z.enum(['preserve', 'rework']).default('preserve'),
});
export const onboardingLinkSchema = z.object({
  id: z.string().max(100),
  revision: z.number().int().positive(),
  clientName: z.string().max(200),
  projectName: z.string().max(200),
  updatedAt: z.string(),
});
export const requiredKeys = OFFER_ESSENTIAL_KEYS;
export const fieldLabels: Record<BriefKey, string> = {
  ...OFFER_ESSENTIAL_LABELS,
  mechanism: 'Why does your approach work?',
  deliverables: 'What is included?',
  proof: 'Evidence & testimonials',
  coachBio: 'Coach background & credentials',
  objections: 'Reasons they might hesitate',
  price: 'Price & payment terms',
  guarantee: 'Guarantee or refund terms',
  urgency: 'Real deadlines or capacity limits',
  cta: 'Primary button label',
  voice: 'Brand voice',
  customerLanguage: 'Words your customers use',
  nextStep: 'What happens after they click?',
};
export const generationSchema = z.object({
  brief: briefSchema.refine(
    (b) => requiredKeys.every((k) => b[k].length >= 3),
    'Complete all five essential brief fields (at least 3 characters each).',
  ),
  template: templateIdSchema,
  formula: formulaSchema.default('recommended'),
  context: copyContextSchema.optional(),
  reference: referenceSchema.optional(),
});
export type GenerationInput = z.infer<typeof generationSchema>;
export const sectionSchema = z.object({
  id: z.string().min(1).max(80),
  headline: z.string().max(250),
  body: z.string().max(MAX_PROOF_CHARACTERS),
  bullets: z.array(z.string().max(800)).max(8),
  cta: z.string().max(120),
  proofFraming: z.object({
    introduction: z.string().max(500),
    items: z.array(z.object({ id: z.string().max(20), heading: z.string().max(150) })).max(8),
  }).optional(),
}).superRefine((section, ctx) => {
  if (section.id !== 'proof' && section.body.length > 6000)
    ctx.addIssue({ code: 'custom', path: ['body'], message: 'Keep ordinary section copy within 6,000 characters. Only full social proof has the larger allowance.' });
});
export type Section = z.infer<typeof sectionSchema>;
export const strategySchema = z.object({
  angle: z.string().min(5).max(1200),
  promise: z.string().min(5).max(1200),
  objection: z.string().max(1200),
  action: z.string().min(2).max(400),
  missingEvidence: z.array(z.string().max(500)).max(10),
  framework: z.object({
    id: z.enum(['pas', 'aida', 'bab', 'star', 'fourps']),
    name: z.string().max(100), recommended: z.boolean(), reason: z.string().max(1000),
  }).optional(),
  frameworkPlan: z.array(z.object({
    stage: z.string().max(80), application: z.string().max(600),
    sectionIds: z.array(z.string().max(80)).max(15),
  })).max(4).optional(),
});
export type Strategy = z.infer<typeof strategySchema>;
export const draftSchema = z.object({
  strategy: strategySchema,
  sections: z.array(sectionSchema).min(1).max(15),
  notes: z.array(z.string().max(1000)).max(12),
});
export type Draft = z.infer<typeof draftSchema>;
export const issueSchema = z.object({
  sectionId: z.string(),
  severity: z.enum(['review', 'warning']),
  message: z.string(),
});
export type Issue = z.infer<typeof issueSchema>;
export const resultSchema = z.object({ draft: draftSchema, issues: z.array(issueSchema) });
export type GenerationResult = z.infer<typeof resultSchema>;
export const extractionSchema = z.object({
  offers: z.array(z.object({
    name: z.string().min(1).max(200),
    summary: z.string().max(1200),
    quote: z.string().min(1).max(1200),
  })).max(12).optional(),
  fields: z.partialRecord(z.enum(Object.keys(fieldLabels) as [BriefKey, ...BriefKey[]]), z.string().trim().max(MAX_PROOF_CHARACTERS))
    .superRefine((fields, ctx) => {
      for (const [key, value] of Object.entries(fields)) if (key !== 'proof' && value && value.length > 6000)
        ctx.addIssue({ code: 'custom', path: [key], message: 'Keep ordinary brief fields within 6,000 characters.' });
    }),
  evidence: z
    .array(
      z.object({
        field: z.enum(Object.keys(fieldLabels) as [BriefKey, ...BriefKey[]]),
        quote: z.string().min(1).max(3000),
      }),
    )
    .max(24),
  warnings: z.array(z.string().max(500)).max(10),
});
export type Extraction = z.infer<typeof extractionSchema>;
export const sourceSchema = z.object({
  title: z.string(),
  url: z.string(),
  text: z.string(),
  headings: z.array(z.string()),
  crawl: z.object({
    pages: z.array(z.object({
      url: z.string(), title: z.string(),
      status: z.enum(['read', 'failed', 'unreadable', 'duplicate']),
      detail: z.string().optional(),
      truncated: z.boolean().optional(),
    })),
    discovered: z.number().int().nonnegative(),
    pending: z.array(z.string()),
    complete: z.boolean(),
    warnings: z.array(z.string()),
  }).optional(),
});
export type Source = z.infer<typeof sourceSchema>;
export const importResultSchema = z.object({ source: sourceSchema, extraction: extractionSchema, selectedOffer: z.string().max(200).optional(), extractionVersion: z.number().int().optional() });
export type ImportResult = z.infer<typeof importResultSchema>;
export const revisionSchema = generationSchema.extend({
  draft: draftSchema,
  sectionId: z.string().max(80),
  direction: z.enum(['clearer', 'shorter', 'stronger', 'alternative', 'problem_led', 'outcome_led', 'objection_led', 'difference_led']),
});
export type RevisionInput = z.infer<typeof revisionSchema>;
export const revisionResultSchema = z.object({
  section: sectionSchema,
  issues: z.array(issueSchema),
});
export const projectSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().max(200),
  updatedAt: z.string(),
  brief: briefSchema,
  template: templateIdSchema,
  formula: formulaSchema,
  result: resultSchema.nullable(),
  source: importResultSchema.nullable(),
  referenceMode: referenceModeSchema.optional(),
  evidenceReview: z.object({ signature: z.string().max(100), decision: z.enum(['included', 'excluded']) }).optional(),
  context: copyContextSchema.optional(),
  onboarding: onboardingLinkSchema.nullable().default(null),
  offerBriefs: z.object({ current: briefSchema.optional(), focused: briefSchema.optional(), new: briefSchema.optional() }).optional(),
  generatedFrom: z.string().nullable(),
  history: z.array(z.object({ result: resultSchema, generatedFrom: z.string().nullable() })).max(8),
});
export type Project = z.infer<typeof projectSchema>;
export const librarySchema = z.object({
  version: z.literal(2),
  projects: z.array(projectSchema).max(100),
});
export type CopyInput = GenerationInput & { source?: ImportResult | null; referenceMode?: ReferenceMode };
export function generationPayload(input: CopyInput): GenerationInput {
  const source = input.source?.source;
  const reference = input.referenceMode === 'off' ? undefined : input.reference || (source?.text.trim() ? {
    title: source.title.slice(0, 500),
    url: source.url.slice(0, 2000),
    text: source.text.slice(0, MAX_SOURCE_CHARACTERS),
    headings: source.headings.slice(0, 60).map((heading) => heading.slice(0, 500)),
    selectedOffer: input.source?.selectedOffer || '',
    tone: input.referenceMode === 'rework_voice' ? 'rework' as const : 'preserve' as const,
  } : undefined);
  return {
    brief: input.brief, template: input.template, formula: input.formula,
    context: input.context,
    ...(reference ? { reference: referenceSchema.parse(reference) } : {}),
  };
}
export function fingerprint(input: CopyInput): string {
  const context = copyContextSchema.parse(input.context || {});
  const { reference } = generationPayload(input);
  const { coachBio, ...existingBrief } = briefSchema.parse(input.brief);
  return JSON.stringify({
    // A new empty optional field must not invalidate unrelated saved templates.
    brief: coachBio ? { ...existingBrief, coachBio } : existingBrief,
    template: input.template,
    formula: input.formula,
    ...(context.mode !== 'current' || context.direction || context.background || context.mustKeep || context.avoid
      ? { context } : {}),
    ...(reference ? { reference } : {}),
  });
}
