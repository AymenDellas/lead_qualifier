import type { FormulaId, GenerationInput, TemplateId } from './contracts';
import { formulas, templates } from './templates';

export type FrameworkId = Exclude<FormulaId, 'recommended'>;
export type FrameworkStage = { stage: string; sectionIds: string[]; instruction: string };
export function resolveFramework(input: Pick<GenerationInput, 'formula' | 'template' | 'brief'>) {
  const recommended: FrameworkId = input.template === 'direct_to_call' ? 'pas'
    : input.template === 'vsl' && input.brief.proof.trim() ? 'fourps' : 'aida';
  const id = input.formula === 'recommended' ? recommended : input.formula;
  const reason = input.template === 'direct_to_call'
    ? 'A direct-to-call page can name the visitor’s problem, show its practical cost, and introduce a credible next step.'
    : input.template === 'vsl' && recommended === 'fourps'
      ? 'The video can introduce the promise, make the outcome concrete, and use the supplied proof before inviting action.'
      : 'Build attention and interest, make the supplied value tangible, then ask for one clear action.';
  const ids = templates[input.template].sections.map(section => section.id);
  const stage = (name: string, sections: string[], instruction: string): FrameworkStage => ({
    stage: name, sectionIds: sections.filter(section => ids.includes(section)), instruction,
  });
  const action = input.template === 'lead_magnet' ? ['optin', 'next'] : ['cta'];
  const opening = input.template === 'vsl' ? ['hero', 'video'] : ['hero', 'problem'];
  const cost = input.template === 'vsl' ? ['video'] : input.template === 'lead_magnet' ? ['hero'] : ['problem'];
  const stages: FrameworkStage[] = id === 'pas' ? [
    stage('Problem', opening, 'Recognize the supplied audience and their present difficulty in their own terms.'),
    stage('Agitation', cost, 'Explain a practical consequence of the stated difficulty. No invented stakes, shame, fear or dramatic escalation.'),
    stage('Solution', ['approach', 'call', 'inside', 'outcomes', 'fit', 'about', 'proof', 'objections', 'video', ...action], 'Connect the known offer to that problem, support it with approved evidence, and make the next action concrete.'),
  ] : id === 'aida' ? [
    stage('Attention', ['hero', 'video'], 'Lead with the relevant desired outcome and identify who this is for.'),
    stage('Interest', ['problem', 'approach', 'inside', 'outcomes'], 'Explain the situation and useful specifics of the supplied offer.'),
    stage('Desire', ['call', 'fit', 'about', 'proof', 'objections'], 'Help the visitor picture the useful change, assess fit and trust the offer using approved evidence.'),
    stage('Action', action, 'Describe only the confirmed next step and use the same clear CTA.'),
  ] : id === 'bab' ? [
    stage('Before', opening, 'Make the supplied current situation recognizable.'),
    stage('After', ['hero', 'approach', 'inside', 'outcomes'], 'Describe the desired future as a goal, not a guaranteed result.'),
    stage('Bridge', ['approach', 'call', 'fit', 'about', 'proof', 'objections', 'video', ...action], 'Show how the stated mechanism and next step connect the present situation to that goal.'),
  ] : id === 'star' ? [
    stage('Situation', [...opening, 'fit'], 'Use a real supplied client situation. If there is no case study, state that limitation; never create a client story.'),
    stage('Task', ['approach', 'inside', 'outcomes'], 'Name the documented goal or task in that case.'),
    stage('Action', ['approach', 'call', 'about', 'video'], 'Describe the documented actions, not an invented intervention.'),
    stage('Result', ['proof', 'objections', ...action], 'Use only the documented result. An endorsement is not a quantified case study. Flag missing results rather than inventing them.'),
  ] : [
    stage('Promise', ['hero', 'video'], 'Present the supported desired outcome without guaranteeing it.'),
    stage('Picture', input.template === 'vsl' ? ['outcomes', 'approach'] : ['problem', 'approach', 'call', 'inside', 'fit', 'about'], 'Make the benefit and offer concrete with supplied details.'),
    stage('Proof', ['proof'], 'Use the approved evidence verbatim and within its actual scope. Flag missing evidence.'),
    stage('Push', ['fit', 'objections', ...action].filter(section => input.template === 'vsl' || section !== 'fit'), 'Resolve supported concerns and invite one clear next step, without fabricated urgency.'),
  ];
  return { id, name: formulas[id].name, description: formulas[id].description,
    recommended: input.formula === 'recommended', reason: input.formula === 'recommended' ? reason : 'Selected by you.', stages };
}

export function recommendedFramework(template: TemplateId, brief: GenerationInput['brief']) {
  return resolveFramework({ formula: 'recommended', template, brief });
}

const openings: Record<FrameworkId, string> = {
  pas: 'Make the supplied present difficulty recognizable in the headline or first supporting sentence. An outcome headline is valid only when the opening still names the actual problem. Avoid opening with only interchangeable benefits. Introduce a credible next step without cramming the entire PAS sequence into the hero.',
  aida: 'Earn attention with a relevant supported outcome or situation, identify the audience and make the offer worth exploring. Build interest with approved specifics rather than a generic aspiration.',
  bab: 'Connect the recognizable present situation to the desired future and hint at the approved bridge. Treat that future as a goal, never a guaranteed result.',
  star: 'Open with the actual documented situation when a case is supplied. Without one, use the known audience situation and disclose the missing case in notes; do not manufacture a client story.',
  fourps: 'Lead with the supported promise and its relevance to this audience. Keep it within the approved offer and distinguish the long-term goal from what the immediate action delivers.',
};

export function sectionWritingRole(input: Pick<GenerationInput, 'formula' | 'template' | 'brief'>, sectionId: string) {
  const framework = resolveFramework(input);
  const section = templates[input.template].sections.find(item => item.id === sectionId);
  return {
    sectionId, framework: framework.name,
    stages: framework.stages.filter(stage => stage.sectionIds.includes(sectionId)),
    purpose: section?.purpose || 'Support the known page goal using approved facts.',
    instruction: [section?.instruction, sectionId === 'hero' ? openings[framework.id] : 'Keep this section within its assigned role; do not restart the entire persuasion sequence.'].filter(Boolean).join(' '),
  };
}

// The full framework is supplied once beside these roles, avoiding repeated stage instructions.
export function sectionReviewRole(input: Pick<GenerationInput, 'formula' | 'template' | 'brief'>, sectionId: string) {
  const { framework: _framework, stages, ...role } = sectionWritingRole(input, sectionId);
  return { ...role, stages: stages.map(stage => stage.stage) };
}
