import type { Project, Section } from '@/lib/copy-studio/shared/contracts';
import { templates } from '@/lib/copy-studio/shared/templates';

export function sectionText(section: Section): string {
  return [
    section.headline,
    section.body,
    section.bullets.map((b) => `• ${b}`).join('\n'),
    section.cta ? `[${section.cta}]` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}
export function exportMarkdown(project: Project): string {
  if (!project.result) return '';
  const { draft } = project.result;
  let template = templates[project.template];
  try {
    if (project.generatedFrom)
      template =
        templates[JSON.parse(project.generatedFrom).template as keyof typeof templates] || template;
  } catch {
    /* use project template */
  }
  return (
    [
      `# ${project.brief.offerName || project.name}`,
      '',
      ...draft.sections
        .filter((s) => sectionText(s).trim())
        .map((s) => {
          const name = template.sections.find((o) => o.id === s.id)?.name || s.id;
          return `## ${name}\n\n${s.headline ? `### ${s.headline}\n\n` : ''}${s.body}${s.bullets.length ? `\n\n${s.bullets.map((b) => `- ${b}`).join('\n')}` : ''}${s.cta ? `\n\n**Button:** ${s.cta}` : ''}`;
        }),
    ]
      .join('\n\n')
      .trim() + '\n'
  );
}
