import { z, ZodError } from 'zod/v4';
import { generationSchema, revisionSchema, MAX_SOURCE_CHARACTERS } from '../shared/contracts';
import { generate, extract, revise } from './engine';
import { createCompletion, type Completion } from './provider';
import { providerConfig, providerStatus } from './config';
import { readSource } from './source';
import { AppError, publicError } from './errors';

const operations = new Set(['generate', 'revise', 'import', 'reference', 'connection']);
const importSchema = z
  .object({
    url: z.string().trim().max(2000).optional(),
    text: z.string().trim().min(100).max(MAX_SOURCE_CHARACTERS).optional(),
    targetOffer: z.string().trim().max(200).optional(),
  })
  .refine(
    (value) => Boolean(value.url) !== Boolean(value.text),
    'Provide a URL or pasted text, not both.',
  );

type Limits = { active: number; requests: number[] };
const globalState = globalThis as typeof globalThis & { copyStudioLimits?: Limits };
const limits = (globalState.copyStudioLimits ||= { active: 0, requests: [] });
const safeError = (error: unknown) =>
  error instanceof ZodError
    ? {
        status: 400,
        message: error.issues
          .slice(0, 4)
          .map((issue) => `${issue.path.join('.') || 'Brief'}: ${issue.message}`)
          .join(' '),
      }
    : publicError(error);
const jsonError = (error: unknown) => {
  const safe = safeError(error);
  return Response.json(
    { error: safe.message },
    { status: safe.status, headers: { 'Cache-Control': 'no-store' } },
  );
};

async function readJson(request: Request): Promise<unknown> {
  const type = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new AppError(415, 'Send a JSON request.');
  if (Number(request.headers.get('content-length') || 0) > 2_000_000)
    throw new AppError(413, 'The request is too large. Shorten the brief or source text.');
  if (!request.body) throw new AppError(400, 'Send a JSON request body.');
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = '',
    bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2_000_000)
        throw new AppError(413, 'The request is too large. Shorten the brief or source text.');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError(400, 'The request was not valid JSON.');
  }
}

/** A same-origin, bounded API inside the dashboard. No second server is needed. */
export async function handleCopyStudio(
  request: Request,
  operation: string,
  completeOverride?: Completion,
): Promise<Response> {
  if (request.method === 'GET') {
    if (operation !== 'health')
      return Response.json({ error: 'Endpoint not found.' }, { status: 404 });
    try {
      return Response.json(providerStatus(), { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      return jsonError(error);
    }
  }
  if (!operations.has(operation))
    return Response.json({ error: 'Endpoint not found.' }, { status: 404 });
  let body: unknown;
  try {
    if (request.method !== 'POST') throw new AppError(405, 'Use POST for this operation.');
    const origin = request.headers.get('origin');
    if (request.headers.get('sec-fetch-site') === 'cross-site')
      throw new AppError(403, 'Cross-origin requests are not allowed.');
    if (origin) {
      let originHost: string;
      try {
        originHost = new URL(origin).host;
      } catch {
        throw new AppError(403, 'Invalid origin.');
      }
      if (originHost !== (request.headers.get('host') || new URL(request.url).host))
        throw new AppError(403, 'Cross-origin requests are not allowed.');
    }
    const now = Date.now();
    limits.requests = limits.requests.filter((time) => time > now - 60000);
    if (limits.requests.length >= 20)
      throw new AppError(429, 'Too many requests. Wait a minute, then try again.');
    limits.requests.push(now);
    body = await readJson(request);
    if (operation === 'generate') body = generationSchema.parse(body);
    if (operation === 'revise') body = revisionSchema.parse(body);
    if (operation === 'import' || operation === 'reference') body = importSchema.parse(body);
    if (limits.active >= 3)
      throw new AppError(429, 'Copy Studio is handling other requests. Try again in a moment.');
  } catch (error) {
    return jsonError(error);
  }

  const controller = new AbortController();
  const signal = AbortSignal.any([request.signal, controller.signal]);
  const deadline = setTimeout(
    () => controller.abort(new DOMException('Timed out', 'TimeoutError')),
    300000,
  );
  limits.active++;
  const finish = () => {
    clearTimeout(deadline);
    limits.active--;
  };
  const run = async (progress: (stage: string) => void) => {
    signal.throwIfAborted();
    if (operation === 'reference') {
      const input = importSchema.parse(body);
      return input.text
        ? { title: 'Pasted page copy', url: '', text: input.text, headings: [] }
        : readSource(input.url!, signal);
    }
    const complete = completeOverride || createCompletion(providerConfig());
    if (operation === 'generate')
      return generate(complete, generationSchema.parse(body), signal, progress);
    if (operation === 'revise') return revise(complete, revisionSchema.parse(body), signal);
    if (operation === 'import') {
      const input = importSchema.parse(body);
      const source = input.text
        ? { title: 'Pasted page copy', url: '', text: input.text, headings: [] }
        : await readSource(input.url!, signal);
      return extract(complete, source, signal, input.targetOffer);
    }
    await complete(
      'You are testing an API connection. Reply with OK only.',
      'Reply OK.',
      signal,
      32,
    );
    return { connected: true, model: providerConfig().model };
  };
  if (operation !== 'generate') {
    try {
      const result = await run(() => {});
      signal.throwIfAborted();
      return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      return jsonError(error);
    } finally {
      finish();
    }
  }
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      const send = (text: string) => {
        if (!signal.aborted) streamController.enqueue(encoder.encode(text));
      };
      const event = (value: unknown) => send(`data: ${JSON.stringify(value)}\n\n`);
      const heartbeat = setInterval(() => send(': keep-alive\n\n'), 10000);
      void run((stage) => event({ type: 'progress', stage }))
        .then((result) => {
          signal.throwIfAborted();
          event({ type: 'result', result });
        })
        .catch((error) => {
          if (!request.signal.aborted) {
            try {
              streamController.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: 'error', error: safeError(error).message })}\n\n`,
                ),
              );
            } catch {
              /* Browser cancelled its stream. */
            }
          }
        })
        .finally(() => {
          clearInterval(heartbeat);
          finish();
          try {
            streamController.close();
          } catch {
            /* Browser cancelled its stream. */
          }
        });
    },
    cancel() {
      controller.abort();
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
