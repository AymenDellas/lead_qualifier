import { z } from 'zod/v4';
import { onboardingBriefSchema } from '@/lib/copy-studio/shared/onboarding';
import {
  importResultSchema,
  resultSchema,
  revisionResultSchema,
  sourceSchema,
  generationPayload,
  type CopyInput,
  type RevisionInput,
} from '@/lib/copy-studio/shared/contracts';

const errorMessage = (value: unknown) => {
  const parsed = z.object({ error: z.string() }).safeParse(value);
  return parsed.success
    ? parsed.data.error
    : 'The server could not complete this request. Please try again.';
};
async function post(path: string, data: unknown, signal: AbortSignal): Promise<Response> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    signal,
  });
  if (!response.ok) throw new Error(errorMessage(await response.json().catch(() => null)));
  return response;
}
export async function generateCopy(
  input: CopyInput,
  signal: AbortSignal,
  progress: (stage: string) => void,
) {
  const response = await post(
    '/api/copy-studio/generate',
    generationPayload(input),
    signal,
  );
  if (!response.body) throw new Error('The response stream is unavailable. Please retry.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer = (buffer + decoder.decode(value, { stream: !done })).replace(/\r\n/g, '\n');
      let end: number;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n');
        if (!data) continue;
        let event: { type?: string; stage?: string; error?: string; result?: unknown };
        try {
          event = JSON.parse(data);
        } catch {
          throw new Error(
            'The response stream was interrupted. Your previous draft is safe. Please retry.',
          );
        }
        if (event.type === 'error')
          throw new Error(event.error || 'Generation failed. Please retry.');
        if (event.type === 'progress' && typeof event.stage === 'string') progress(event.stage);
        if (event.type === 'result') return resultSchema.parse(event.result);
      }
      if (done) break;
    }
    throw new Error(
      'The connection ended before the draft was complete. Your previous draft is safe. Please retry.',
    );
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function importSource(input: { url?: string; text?: string; targetOffer?: string }, signal: AbortSignal) {
  const response = await post('/api/copy-studio/import', input, signal);
  return importResultSchema.parse(await response.json());
}
export async function readReference(input: { url?: string; text?: string }, signal: AbortSignal) {
  const response = await post('/api/copy-studio/reference', input, signal);
  return sourceSchema.parse(await response.json());
}
export async function loadOnboardings(signal: AbortSignal) {
  const response = await fetch('/api/copy-studio/onboardings', { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(errorMessage(await response.json().catch(() => null)));
  return z.object({ onboardings: z.array(onboardingBriefSchema) }).parse(await response.json()).onboardings;
}
export async function testConnection(signal: AbortSignal) {
  const response = await post('/api/copy-studio/connection', {}, signal);
  return z.object({ connected: z.literal(true), model: z.string() }).parse(await response.json());
}
export async function reviseCopy(input: RevisionInput & CopyInput, signal: AbortSignal) {
  const response = await post(
    '/api/copy-studio/revise',
    {
      ...generationPayload(input),
      draft: input.draft,
      sectionId: input.sectionId,
      direction: input.direction,
    },
    signal,
  );
  return revisionResultSchema.parse(await response.json());
}
