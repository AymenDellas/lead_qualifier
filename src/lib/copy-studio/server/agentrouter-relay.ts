import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { normalizeStream } from './agentrouter-stream.mjs';
import type { ProviderConfig } from './provider';

/** A private, short-lived transport adapter for the actual supported client.
 * Authentication headers originate in that client; only its local bearer token is replaced.
 */
export async function startAgentRouterRelay(
  config: ProviderConfig,
  signal: AbortSignal,
  maxTokens: number,
) {
  const localToken = randomBytes(32).toString('hex');
  const server = createServer(async (req, res) => {
    if (
      req.method !== 'POST' ||
      req.url !== '/v1/chat/completions' ||
      req.headers.authorization !== `Bearer ${localToken}`
    ) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid local client request.' } }));
      return;
    }
    const disconnected = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) disconnected.abort();
    });
    const requestSignal = AbortSignal.any([signal, disconnected.signal]);
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 1_000_000) throw new Error('Request too large');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      // All tool execution is disabled. Retain the genuine client's messages and transport.
      delete body.tools;
      delete body.tool_choice;
      delete body.parallel_tool_calls;
      body.model = config.model;
      body.max_tokens = Math.max(maxTokens, 512);
      body.temperature = 0.55;
      const headers = new Headers();
      const hopHeaders = new Set([
        'host',
        'connection',
        'content-length',
        'transfer-encoding',
        'accept-encoding',
        'keep-alive',
        'upgrade',
        'proxy-authorization',
        'te',
        'trailer',
      ]);
      for (const [name, value] of Object.entries(req.headers)) {
        if (!hopHeaders.has(name) && value)
          headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      headers.set('Authorization', `Bearer ${config.apiKey}`);
      headers.set('Content-Type', 'application/json');
      const upstream = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: requestSignal,
      });
      if (process.env.COPY_STUDIO_DIAGNOSTIC === '1')
        console.error(
          'AgentRouter response:',
          JSON.stringify({
            status: upstream.status,
            contentType: upstream.headers.get('content-type'),
          }),
        );
      res.writeHead(upstream.status, {
        'Content-Type': upstream.headers.get('content-type') || 'application/json',
        'Cache-Control': 'no-store',
      });
      if (!upstream.body) {
        res.end();
        return;
      }
      const stream =
        upstream.ok && upstream.headers.get('content-type')?.includes('text/event-stream')
          ? normalizeStream(upstream.body)
          : upstream.body;
      const readable = Readable.fromWeb(stream as never);
      readable.on('error', () => res.destroy());
      readable.pipe(res);
    } catch {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'The upstream AI request could not finish.' } }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    localToken,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
