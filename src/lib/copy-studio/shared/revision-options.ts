import type { RevisionInput } from './contracts';

type Direction = RevisionInput['direction'];
export const wordingOptions: { direction: Direction; label: string }[] = [
  { direction: 'clearer', label: 'Make it clearer' },
  { direction: 'shorter', label: 'Make it shorter' },
  { direction: 'stronger', label: 'Sharpen the benefit' },
  { direction: 'alternative', label: 'Try another angle' },
];
const angles: Partial<Record<string, Direction[]>> = {
  hero: ['problem_led', 'outcome_led', 'objection_led', 'difference_led'],
  problem: ['problem_led'],
  approach: ['outcome_led', 'objection_led', 'difference_led'],
  call: ['outcome_led', 'objection_led'],
  inside: ['outcome_led', 'difference_led'],
  outcomes: ['outcome_led', 'difference_led'],
  fit: ['problem_led', 'outcome_led'],
  about: ['difference_led'],
  objections: ['objection_led'],
  cta: ['outcome_led', 'objection_led'],
  optin: ['outcome_led', 'objection_led'],
  video: ['problem_led', 'outcome_led'],
};
const labels: Partial<Record<Direction, string>> = {
  problem_led: 'Lead with their problem', outcome_led: 'Lead with the outcome',
  objection_led: 'Address a hesitation', difference_led: 'Emphasize the approach',
};
export const revisionInstructions: Record<Direction, string> = {
  clearer: 'Make the language clearer and more specific.',
  shorter: 'Reduce the word count while retaining facts and useful meaning.',
  stronger: 'Sharpen the supported benefit and relevance without adding claims or pressure.',
  alternative: 'Create a distinct alternative angle while keeping the same facts, assigned section role and conversion goal.',
  problem_led: 'Emphasize a recognizable situation or difficulty from the approved problem and customer language. Retain this section’s role in the page; do not repeat a complete PAS sequence or invent stakes.',
  outcome_led: 'Emphasize the specific supported change relevant to this section. In a PAS opening, still make the current difficulty recognizable. Separate the desired program outcome from the confirmed next-step outcome.',
  objection_led: 'Address a supplied hesitation or a factual question about the known next step. Use only approved answers. Do not invent fears, guarantees, free services, no-pressure policies or objections merely to create drama.',
  difference_led: 'Emphasize relevant specifics of the approved mechanism, delivery or coach background. Explain why those specifics matter to this audience. Do not claim uniqueness, superiority, a proprietary method or competitor shortcomings without evidence. If a useful difference is not supplied, flag that limitation rather than inventing one.',
};
export function sectionAngleOptions(sectionId: string) {
  return (angles[sectionId] || []).map(direction => ({ direction, label: labels[direction]! }));
}
export function supportsRevision(sectionId: string, direction: Direction) {
  return wordingOptions.some(item => item.direction === direction) || (angles[sectionId] || []).includes(direction);
}
