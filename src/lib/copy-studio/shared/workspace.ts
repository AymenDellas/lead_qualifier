import { briefSchema, copyContextSchema, type CopyContext, type Project } from './contracts';

export function changeOfferContext(project: Project, context: CopyContext): Project {
  const previous = copyContextSchema.parse(project.context || {});
  if (previous.mode === context.mode) return { ...project, context };
  const brief = project.offerBriefs?.[context.mode] || briefSchema.parse({ voice: project.brief.voice });
  return {
    ...project, context, brief,
    offerBriefs: { ...project.offerBriefs, [previous.mode]: project.brief },
    name: project.name === project.brief.offerName || project.name === 'Untitled project' ? brief.offerName || 'Untitled project' : project.name,
  };
}
