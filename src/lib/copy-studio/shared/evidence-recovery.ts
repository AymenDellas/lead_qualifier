import { EXTRACTION_VERSION, type ImportResult, type Project } from './contracts';

// This is a change detector for a review decision, not a security hash.
export function evidenceSignature(project: Project): string {
  const value = JSON.stringify([
    EXTRACTION_VERSION, project.context?.mode || 'current', project.onboarding?.id || '',
    project.brief.offerName, project.brief.description, project.brief.audience,
    project.source?.source.url, project.source?.source.text, project.source?.selectedOffer,
  ]);
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return `${value.length}:${hash >>> 0}`;
}

export function needsEvidenceReview(project: Project): boolean {
  return !project.brief.proof.trim() && project.referenceMode !== 'off'
    && project.context?.mode !== 'new'
    && Boolean(project.source?.source.url || project.source?.source.text.trim())
    && project.evidenceReview?.signature !== evidenceSignature(project);
}

export function recordEvidenceReview(project: Project, decision: 'included' | 'excluded'): Project {
  return { ...project, evidenceReview: { signature: evidenceSignature(project), decision } };
}

export function applyRecoveredEvidence(project: Project, result: ImportResult | null, include: boolean): Project {
  // Only the evidence field changes. The five essentials and previous draft stay intact.
  const proof = result?.extraction.fields.proof?.trim();
  if (include && !proof) throw new Error('No supported evidence is available to add.');
  const next = {
    ...project,
    source: result || project.source,
    brief: include ? { ...project.brief, proof: proof! } : project.brief,
  };
  return recordEvidenceReview(next, include ? 'included' : 'excluded');
}
