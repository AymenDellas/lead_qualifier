import type { Project } from './contracts';

const prefix = 'copy-studio-reference-v1:';
const marker = '$CURRENT_PROJECT_SOURCE';

// Fingerprints include the original capture. Store that large string once per project,
// then reconstruct the exact original fingerprint on load. No draft or history is removed.
function pack(value: string | null, source: string | undefined): string | null {
  if (!value || !source) return value;
  try {
    const parsed = JSON.parse(value);
    if (parsed.reference?.text !== source || JSON.stringify(parsed) !== value) return value;
    parsed.reference.text = marker;
    return prefix + JSON.stringify(parsed);
  } catch { return value; }
}

function unpack(value: string | null, source: string | undefined): string | null {
  if (!value?.startsWith(prefix)) return value;
  const parsed = JSON.parse(value.slice(prefix.length));
  if (typeof source !== 'string' || parsed.reference?.text !== marker)
    throw new Error('The saved original reference could not be restored.');
  parsed.reference.text = source;
  return JSON.stringify(parsed);
}

export function packSavedProject(project: Project): Project {
  const source = project.source?.source.text;
  const cache = new Map<string | null, string | null>();
  const compact = (value: string | null) => {
    if (!cache.has(value)) cache.set(value, pack(value, source));
    return cache.get(value)!;
  };
  return { ...project, generatedFrom: compact(project.generatedFrom),
    history: project.history.map(item => ({ ...item, generatedFrom: compact(item.generatedFrom) })) };
}

export function unpackSavedProject(project: Project): Project {
  const source = project.source?.source.text;
  return { ...project, generatedFrom: unpack(project.generatedFrom, source),
    history: project.history.map(item => ({ ...item, generatedFrom: unpack(item.generatedFrom, source) })) };
}
