import type { z } from 'zod/v4';
import { AppError } from './errors';
import { createAgentRouterCompletion } from './agentrouter-client';

export type Completion = (
  system: string,
  prompt: string,
  signal: AbortSignal,
  maxTokens?: number,
) => Promise<string>;
export type ProviderConfig = { apiKey: string; baseUrl: string; model: string; timeoutMs: number };

export function parseJson(text: string): unknown {
  const clean = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(clean);
  } catch {
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(clean.slice(start, end + 1));
    throw new Error('The response was not valid JSON.');
  }
}

export function createCompletion(config: ProviderConfig): Completion {
  const hostname = new URL(config.baseUrl).hostname;
  if (hostname === 'agentrouter.org' || hostname.endsWith('.agentrouter.org')) {
    return createAgentRouterCompletion(config);
  }
  return async (system, prompt, signal, maxTokens = 7000) => {
    if (!config.apiKey || /your.*key|placeholder/i.test(config.apiKey)) {
      throw new AppError(
        503,
        'Configure COPY_STUDIO_API_KEY in .env.local, then restart the dashboard.',
      );
    }
    const combinedSignal = AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]);
    let response: Response;
    try {
      response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        signal: combinedSignal,
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': 'CopyStudio/2.0',
        },
        body: JSON.stringify({
          model: config.model,
          stream: false,
          temperature: 0.55,
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
        }),
      });
    } catch (error) {
      if (combinedSignal.aborted) throw combinedSignal.reason;
      throw new AppError(
        502,
        'The AI provider could not be reached. Check your connection and COPY_STUDIO_BASE_URL, then retry.',
      );
    }
    if (!response.ok) {
      const failure = (await response.json().catch(() => null)) as {
        type?: string;
        error?: { message?: string };
      } | null;
      if (
        failure?.type === 'unauthorized_client_error' ||
        /unauthorized client/i.test(failure?.error?.message || '')
      ) {
        throw new AppError(
          502,
          'The AI provider rejected the client integration. This does not establish that the API key is invalid. Check the configured provider endpoint and supported client requirements.',
        );
      }
      if (/overdue|insufficient|quota|balance|credits/i.test(failure?.error?.message || ''))
        throw new AppError(
          502,
          'The AI provider reports an account balance or quota issue. Check your provider account before retrying.',
        );
      if (response.status === 401 || response.status === 403)
        throw new AppError(
          502,
          'The AI provider rejected the API key. Check your Copy Studio key and model access in the dashboard environment.',
        );
      if (response.status === 402)
        throw new AppError(
          502,
          'The AI provider reports insufficient credits. Check the balance on your provider account.',
        );
      if (response.status === 429)
        throw new AppError(
          429,
          'The AI provider is busy or its usage limit was reached. Wait a moment and retry.',
        );
      if (response.status === 404)
        throw new AppError(
          502,
          'The configured AI model or endpoint was not found. Check COPY_STUDIO_MODEL and COPY_STUDIO_BASE_URL in .env.',
        );
      throw new AppError(
        502,
        `The AI provider returned an error (${response.status}). Please retry in a moment.`,
      );
    }
    let data: { choices?: { finish_reason?: string; message?: { content?: string } }[] };
    try {
      data = (await response.json()) as typeof data;
    } catch {
      throw new AppError(502, 'The AI provider returned an unreadable response. Please retry.');
    }
    const choice = data.choices?.[0];
    if (choice?.finish_reason === 'length')
      throw new AppError(
        502,
        'The AI response was cut short. No partial draft was saved. Please try again.',
      );
    const content = choice?.message?.content;
    if (typeof content !== 'string' || !content.trim())
      throw new AppError(502, 'The AI provider returned an empty response. Please try again.');
    return content;
  };
}

export async function structured<T>(
  complete: Completion,
  schema: z.ZodType<T>,
  system: string,
  prompt: string,
  signal: AbortSignal,
  validate?: (value: T) => void,
): Promise<T> {
  let feedback = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    signal.throwIfAborted();
    const raw = await complete(system, prompt + feedback, signal);
    try {
      const parsed = schema.parse(parseJson(raw));
      validate?.(parsed);
      return parsed;
    } catch (error) {
      // Regenerate against the original brief. Never promote malformed output into source facts.
      const reason = error instanceof Error ? error.message.slice(0, 1600) : 'Schema mismatch';
      feedback = `\nYour previous response did not pass validation. Produce a fresh complete JSON object. Fix these validation issues: ${reason}`;
    }
  }
  throw new AppError(
    502,
    'The AI response did not match the required structure after a retry. Your previous draft is unchanged. Please try again.',
  );
}
