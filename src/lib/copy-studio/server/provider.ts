import type { z } from 'zod/v4';
import { AppError } from './errors';
import { createAgentRouterCompletion } from './agentrouter-client';
import { setTimeout as delay } from 'node:timers/promises';

export type Completion = ((
  system: string,
  prompt: string,
  signal: AbortSignal,
  maxTokens?: number,
) => Promise<string>) & { inputByteLimit?: number };
export type ProviderConfig = { apiKey: string; baseUrl: string; model: string; timeoutMs: number; inputByteLimit?: number };

/** Bound an optional multi-call stage without aborting the enclosing generation. */
export function completionDeadline(complete: Completion, deadline: number): Completion {
  const bounded: Completion = async (system, prompt, signal, maxTokens) => {
    signal.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new DOMException('Editorial review time budget exhausted', 'TimeoutError');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('Editorial review time budget exhausted', 'TimeoutError')), remaining);
    const cancel = () => controller.abort(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const result = await complete(system, prompt, controller.signal, maxTokens);
      controller.signal.throwIfAborted();
      if (Date.now() >= deadline) throw new DOMException('Editorial review time budget exhausted', 'TimeoutError');
      return result;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
    }
  };
  Object.defineProperty(bounded, 'inputByteLimit', {
    get: () => complete.inputByteLimit, set: value => { complete.inputByteLimit = value; },
  });
  return bounded;
}

export class ProviderSizeError extends AppError {
  constructor() {
    super(502, 'The source exceeds the AI provider’s request limit. Use a more specific page or pasted excerpt, or increase the provider’s input allowance. Retrying the same request will not resolve it.');
  }
}

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
    return Object.assign(createAgentRouterCompletion(config), { inputByteLimit: config.inputByteLimit || 80_000 });
  }
  const complete: Completion = async (system, prompt, signal, maxTokens = 7000) => {
    if (!config.apiKey || /your.*key|placeholder/i.test(config.apiKey)) {
      throw new AppError(
        503,
        'Configure COPY_STUDIO_API_KEY in .env.local, then restart the dashboard.',
      );
    }
    const combinedSignal = AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]);
    let response: Response;
    try {
      let waited = 0;
      for (let attempt = 0; ; attempt++) {
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
            ...(hostname === 'api.groq.com' && /^openai\/gpt-oss-(?:20|120)b$/.test(config.model)
              ? { reasoning_effort: 'low' } : {}),
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: prompt },
            ],
          }),
        });
        const retryAfter = response.headers.get('retry-after');
        let waitMs = retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter) ? Math.ceil(Number(retryAfter) * 1000) : NaN;
        if (response.status === 429 && !Number.isFinite(waitMs)) {
          const failure = await response.clone().json().catch(() => null) as { error?: { message?: string } } | null;
          const duration = failure?.error?.message?.match(/try again in ((?:\d+(?:\.\d+)?(?:ms|s|m|h|d))+)/i)?.[1];
          if (duration) waitMs = Math.ceil([...duration.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)]
            .reduce((total, part) => total + Number(part[1]) * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[part[2]] || 0), 0));
        }
        if (response.status !== 429 || attempt >= 2 || !Number.isFinite(waitMs) || waitMs < 0 || waited + waitMs > 60_000) break;
        await response.body?.cancel();
        await delay(waitMs, undefined, { signal: combinedSignal });
        waited += waitMs;
      }
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
        code?: string;
        message?: string;
        error?: { message?: string; type?: string; code?: string };
      } | null;
      // Classify the refusal without returning raw provider details or credentials.
      const message = failure?.error?.message || failure?.message || '';
      const codes = [failure?.type, failure?.code, failure?.error?.type, failure?.error?.code].filter(Boolean).join(' ');
      if (response.status === 413) {
        // The caller can rebuild source context once against this smaller allowance.
        complete.inputByteLimit = Math.min(complete.inputByteLimit!, Math.floor(Buffer.byteLength(system + prompt, 'utf8') * 0.6));
        throw new ProviderSizeError();
      }
      if (
        /unauthorized_client_error/i.test(codes) ||
        /unauthorized client/i.test(message)
      ) {
        throw new AppError(
          502,
          'The AI provider rejected the client integration. This does not establish that the API key is invalid. Check the configured provider endpoint and supported client requirements.',
        );
      }
      if (response.status === 429) {
        const duration = message.match(/try again in ((?:\d+(?:\.\d+)?(?:ms|s|m|h|d))+)/i)?.[1];
        const retrySeconds = response.headers.get('retry-after');
        const wait = duration ? ` The provider suggests waiting ${duration}.`
          : retrySeconds && /^\d+(?:\.\d+)?$/.test(retrySeconds) ? ` Try again in ${Math.ceil(Number(retrySeconds))} seconds.` : '';
        if (/tokens per day|\bTPD\b|daily (?:token|usage|quota)/i.test(message))
          throw new AppError(429, `The AI provider’s daily token allowance has been reached. Retry after its daily reset.${wait}`);
        throw new AppError(429, `The AI provider is busy or its temporary usage limit was reached.${wait || ' Wait a moment and retry.'}`);
      }
      if (/overdue|insufficient (?:funds|credits|balance|quota)|quota|balance|credits/i.test(message))
        throw new AppError(
          502,
          'The AI provider reports an account balance or quota issue. Check your provider account before retrying.',
        );
      if (/model_(?:access_denied|permission_denied)/i.test(codes) ||
          /(?:access|permission).{0,50}model|model.{0,50}(?:not permitted|not allowed|access denied|no access)/i.test(message))
        throw new AppError(
          502,
          'The AI provider denied access to the configured model. Check COPY_STUDIO_MODEL and your account’s model permissions. This does not establish that the API key is invalid.',
        );
      if (/invalid_api_key|invalid_token|key_expired|key_revoked/i.test(codes) ||
          /(?:invalid|incorrect|expired|revoked).{0,25}(?:api key|api token)|(?:api key|api token).{0,25}(?:invalid|incorrect|expired|revoked)/i.test(message))
        throw new AppError(
          502,
          'The AI provider reports an invalid or expired API key. Check that COPY_STUDIO_API_KEY belongs to COPY_STUDIO_BASE_URL in the deployed dashboard environment.',
        );
      if (response.status === 401)
        throw new AppError(
          502,
          'The AI provider could not authenticate this request. Check that the deployed Copy Studio key and provider endpoint belong together.',
        );
      if (response.status === 403)
        throw new AppError(
          502,
          'The AI provider refused access to this request. Check model permissions and provider access restrictions. A forbidden response does not establish that the API key is invalid.',
        );
      if (response.status === 402)
        throw new AppError(
          502,
          'The AI provider reports insufficient credits. Check the balance on your provider account.',
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
  // Groq's free-tier token allowance is smaller than its advertised context window.
  complete.inputByteLimit = config.inputByteLimit || (hostname === 'api.groq.com' ? 20_000 : 80_000);
  return complete;
}

export async function structured<T>(
  complete: Completion,
  schema: z.ZodType<T>,
  system: string,
  prompt: string | (() => string),
  signal: AbortSignal,
  validate?: (value: T) => void,
): Promise<T> {
  let feedback = '';
  let resized = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    signal.throwIfAborted();
    let raw: string;
    const requestPrompt = (typeof prompt === 'function' ? prompt() : prompt) + feedback;
    try {
      raw = await complete(system, requestPrompt, signal);
    } catch (error) {
      if (error instanceof ProviderSizeError && typeof prompt === 'function' && !resized) {
        if (Buffer.byteLength(prompt() + feedback, 'utf8') >= Buffer.byteLength(requestPrompt, 'utf8')) throw error;
        resized = true;
        attempt--;
        continue;
      }
      throw error;
    }
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
