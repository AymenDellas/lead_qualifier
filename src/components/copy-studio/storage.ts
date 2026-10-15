import { briefSchema, librarySchema, type Project } from '@/lib/copy-studio/shared/contracts';

export const storageKey = 'compel:copy-studio:library:v2';
export function newProject(): Project {
  return {
    id: crypto.randomUUID(),
    name: 'Untitled project',
    updatedAt: new Date().toISOString(),
    brief: briefSchema.parse({}),
    template: 'direct_to_call',
    formula: 'recommended',
    result: null,
    source: null,
    onboarding: null,
    generatedFrom: null,
    history: [],
  };
}
export function loadProjects(): { projects: Project[]; error: string | null } {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return { projects: [newProject()], error: null };
    const data = librarySchema.parse(JSON.parse(raw));
    return { projects: data.projects.length ? data.projects : [newProject()], error: null };
  } catch {
    return {
      projects: [newProject()],
      error:
        'Saved projects could not be read. Automatic saving is paused to protect them. Download the saved data below before resetting storage.',
    };
  }
}
export function saveProjects(projects: Project[]): string | null {
  try {
    localStorage.setItem(storageKey, JSON.stringify({ version: 2, projects }));
    return null;
  } catch {
    return 'Browser storage is full or unavailable. Download a project backup to keep your work.';
  }
}
export function download(name: string, content: string, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function sampleProject(): Project {
  const project = newProject();
  project.name = 'The Clear Offer Sprint';
  project.brief = briefSchema.parse({
    offerName: 'The Clear Offer Sprint',
    description:
      'A two-week, one-to-one positioning sprint for independent business coaches. Together we clarify the audience, sharpen the offer, and write a usable messaging brief.',
    audience:
      'Independent business coaches with an established service who struggle to explain why clients should choose them.',
    problem:
      'Their website sounds like every other coach. Discovery calls begin with long explanations, and good-fit prospects hesitate because the value is unclear.',
    outcome:
      'Explain who the offer is for, the problem it solves, and why it is worth considering in clear, specific language.',
    mechanism:
      'Start with actual customer language, then connect the service deliverables to the buying decision. Test the positioning against real objections.',
    deliverables:
      'Two working sessions; a customer-language review; a one-page positioning brief; an offer messaging review.',
    objections: 'I have rewritten my website before. I do not want another vague brand exercise.',
    cta: 'Book a fit call',
    nextStep:
      'A 20-minute fit call to discuss the current offer and decide whether the sprint is appropriate.',
    price: '$750 for the two-week sprint',
    voice: 'Warm, practical, and straightforward. No hype or jargon.',
  });
  return project;
}
