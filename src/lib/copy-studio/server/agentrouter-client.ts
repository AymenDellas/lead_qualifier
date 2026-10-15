import { spawn } from 'node:child_process';
import { mkdtemp, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { z } from 'zod/v4';
import type { Completion, ProviderConfig } from './provider';
import { AppError } from './errors';
import { startAgentRouterRelay } from './agentrouter-relay';

const resultSchema = z.object({
  type: z.literal('result'),
  is_error: z.boolean(),
  result: z.string().optional(),
  error: z.object({ message: z.string().optional() }).optional(),
  stats: z.object({ tools: z.object({ totalCalls: z.number() }).optional() }).optional(),
});

export function clientResult(output: string): string {
  let messages: unknown;
  try {
    messages = JSON.parse(output);
  } catch {
    throw new AppError(
      502,
      'The AI client returned an unreadable response. Your previous draft is safe. Please retry.',
    );
  }
  if (!Array.isArray(messages))
    throw new AppError(502, 'The AI client returned an unexpected response. Please retry.');
  const parsed = resultSchema.safeParse(
    messages.filter((message) => message?.type === 'result').at(-1),
  );
  if (!parsed.success)
    throw new AppError(
      502,
      'The AI client ended before returning a complete response. Please retry.',
    );
  const result = parsed.data;
  if (result.stats?.tools?.totalCalls)
    throw new AppError(
      502,
      'The AI response requested an unsupported tool. No draft was saved. Please retry.',
    );
  if (result.is_error) {
    const message = result.error?.message || '';
    if (/quota|overdue|balance|credits|insufficient/i.test(message))
      throw new AppError(
        502,
        'AgentRouter reports an account balance or quota issue. Check your account before retrying.',
      );
    if (/unauthorized.client/i.test(message))
      throw new AppError(
        502,
        'AgentRouter rejected the client request. Please retry or check AgentRouter service status.',
      );
    if (/invalid.*(?:key|token)|authentication/i.test(message))
      throw new AppError(
        502,
        'AgentRouter rejected the credentials. Check the Copy Studio token in the dashboard environment.',
      );
    if (/429|rate.limit/i.test(message))
      throw new AppError(
        429,
        'AgentRouter is busy or rate limited. Please wait a moment and retry.',
      );
    if (/timed?.?out|deadline|wall.clock|wall.time/i.test(message))
      throw new AppError(
        504,
        'The AI request timed out. Your previous draft is safe. Please retry.',
      );
    throw new AppError(
      502,
      'AgentRouter could not finish this response. Your previous draft is safe. Please retry.',
    );
  }
  if (!result.result?.trim())
    throw new AppError(502, 'AgentRouter returned an empty response. Please retry.');
  return result.result;
}

/** Use AgentRouter's documented client, preserving its real authentication headers.
 * The child is restricted to one text response, with tools and customizations disabled.
 */
export function createAgentRouterCompletion(config: ProviderConfig): Completion {
  return async (system, prompt, signal, maxTokens = 7000) => {
    if (!config.apiKey || /your.*key|placeholder/i.test(config.apiKey))
      throw new AppError(
        503,
        'Configure COPY_STUDIO_API_KEY in .env.local, then restart the dashboard.',
      );
    const combinedSignal = AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]);
    combinedSignal.throwIfAborted();
    const workspace = await mkdtemp(join(tmpdir(), 'copy-studio-ai-'));
    let closeRelay: (() => Promise<void>) | undefined;
    try {
      const relay = await startAgentRouterRelay(config, combinedSignal, maxTokens);
      closeRelay = relay.close;
      const args = [
        '--expose-gc',
        createRequire(join(process.cwd(), 'package.json')).resolve('@qwen-code/qwen-code/cli.js'),
        '--bare',
        '--safe-mode',
        '--auth-type',
        'openai',
        '--output-format',
        'json',
        '--chat-recording=false',
        '--telemetry=false',
        '--openai-logging=false',
        '--max-tool-calls',
        '0',
        '--max-session-turns',
        '1',
        '--max-wall-time',
        `${Math.ceil(config.timeoutMs / 1000)}s`,
        '--system-prompt',
        system,
      ];
      return await new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, args, {
          cwd: workspace,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          signal: combinedSignal,
          env: {
            ...process.env,
            OPENAI_API_KEY: relay.localToken,
            OPENAI_BASE_URL: relay.baseUrl,
            OPENAI_MODEL: config.model,
            QWEN_CODE_API_TIMEOUT_MS: String(config.timeoutMs),
            QWEN_STREAM_MAX_LIFETIME_MS: String(config.timeoutMs),
          },
        });
        let output = '';
        let diagnosticStderr = '';
        let tooLarge = false;
        let launchFailed = false;
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          output += chunk;
          if (output.length > 2_000_000) {
            tooLarge = true;
            child.kill();
          }
        });
        // Drain diagnostics, but never expose the CLI's environment or provider internals.
        child.stderr.on('data', (chunk: Buffer) => {
          if (process.env.COPY_STUDIO_DIAGNOSTIC === '1')
            diagnosticStderr = (diagnosticStderr + chunk.toString('utf8')).slice(-5000);
        });
        child.stdin.on('error', () => {
          /* The close event reports early process failures. */
        });
        child.on('error', () => {
          launchFailed = true;
        });
        child.on('close', (exitCode, exitSignal) => {
          if (combinedSignal.aborted) return reject(combinedSignal.reason);
          if (launchFailed)
            return reject(
              new AppError(
                502,
                'The AI client could not start. Run npm install and restart Copy Studio.',
              ),
            );
          if (tooLarge)
            return reject(
              new AppError(502, 'The AI response exceeded the size limit. No draft was saved.'),
            );
          try {
            resolve(clientResult(output));
          } catch (error) {
            if (process.env.COPY_STUDIO_DIAGNOSTIC === '1') {
              try {
                const messages = JSON.parse(output);
                const failure = Array.isArray(messages)
                  ? messages.filter((message) => message?.type === 'result').at(-1)
                  : null;
                console.error(
                  'AgentRouter diagnostic:',
                  JSON.stringify({ subtype: failure?.subtype, error: failure?.error })
                    .replaceAll(config.apiKey, '[redacted]')
                    .replaceAll(relay.localToken, '[redacted]')
                    .slice(0, 1500),
                );
              } catch {
                console.error(
                  'AgentRouter diagnostic:',
                  JSON.stringify({
                    exitCode,
                    exitSignal,
                    outputLength: output.length,
                    prefix: output.slice(0, 500),
                    suffix: output.slice(-500),
                    stderr: diagnosticStderr,
                  })
                    .replaceAll(config.apiKey, '[redacted]')
                    .replaceAll(relay.localToken, '[redacted]'),
                );
              }
            }
            reject(error);
          }
        });
        // Source fields are JSON data. Escape @ to prevent the CLI's file-mention expansion.
        child.stdin.end(prompt.replaceAll('@', '\\u0040'));
      });
    } finally {
      await closeRelay?.();
      // Remove only the empty directory we created. Never recursively delete unexpected files.
      await rmdir(workspace).catch(() => {});
    }
  };
}
