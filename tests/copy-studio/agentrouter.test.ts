import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeFrame,
  normalizeStream,
} from '../../src/lib/copy-studio/server/agentrouter-stream.mjs';
import {
  clientResult,
  createAgentRouterCompletion,
  retryClientOutput,
} from '../../src/lib/copy-studio/server/agentrouter-client';
import { startAgentRouterRelay } from '../../src/lib/copy-studio/server/agentrouter-relay';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

test('AgentRouter null and billing frames are removed, while completion and error frames survive', () => {
  assert.equal(normalizeFrame('data: null'), '');
  assert.equal(normalizeFrame('data: {"object":"billing.summary","cost":1}'), '');
  assert.equal(normalizeFrame('data: [DONE]'), 'data: [DONE]\n\n');
  for (const frame of [
    'data: {"choices":[]}',
    'event: error\ndata: {"error":"limit reached"}',
    'data: invalid',
  ]) {
    assert.equal(normalizeFrame(frame), frame + '\n\n');
  }
});

test(
  'cancelling the supported client stops its active upstream request',
  { timeout: 60000 },
  async () => {
    let received!: () => void;
    let disconnected!: () => void;
    const requestReceived = new Promise<void>((resolve) => {
      received = resolve;
    });
    const requestClosed = new Promise<void>((resolve) => {
      disconnected = resolve;
    });
    const upstream = createServer((_req, res) => {
      res.on('close', disconnected);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.flushHeaders();
      received();
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const controller = new AbortController();
    const complete = createAgentRouterCompletion({
      apiKey: 'upstream-test-token',
      baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`,
      model: 'test-model',
      timeoutMs: 45000,
    });
    const response = complete(
      'Return only the requested text. Do not use tools.',
      'Say OK.',
      controller.signal,
    );
    // Observe rejection immediately so a startup failure cannot become an unhandled rejection.
    const outcome = response.then(
      () => null,
      (error) => error,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        requestReceived,
        outcome.then((error) => {
          throw error || new Error('The test response ended before cancellation.');
        }),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('The client never reached the test upstream.')),
            30000,
          );
        }),
      ]);
      const started = Date.now();
      controller.abort();
      const error = await outcome;
      assert.equal(error?.name, 'AbortError');
      await requestClosed;
      assert.ok(
        Date.now() - started < 3000,
        'Cancellation must promptly terminate the client and upstream request.',
      );
    } finally {
      clearTimeout(timer);
      controller.abort();
      await outcome;
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  },
);

test('AgentRouter stream normalization handles fragmented CRLF and multibyte content', async () => {
  const raw =
    'data: null\r\n\r\ndata: {"choices":[{"delta":{"content":"Café ✓"}}]}\r\n\r\ndata: {"object":"billing.summary"}\r\n\r\ndata: [DONE]\r\n\r\n';
  const bytes = new TextEncoder().encode(raw);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  });
  const output = await new Response(normalizeStream(stream)).text();
  assert.equal(output, 'data: {"choices":[{"delta":{"content":"Café ✓"}}]}\n\ndata: [DONE]\n\n');
});

test('a completed supported-client response is required before accepting text', () => {
  const success = [
    { type: 'result', is_error: false, result: 'OK', stats: { tools: { totalCalls: 0 } } },
  ];
  assert.equal(clientResult(JSON.stringify(success)), 'OK');
  assert.throws(() => clientResult('[]'), /before returning a complete response/);
  assert.throws(() => clientResult('not json'), /unreadable response/);
  assert.throws(
    () => clientResult(JSON.stringify([{ ...success[0], stats: { tools: { totalCalls: 1 } } }])),
    /unsupported tool/,
  );
  assert.throws(
    () =>
      clientResult(
        JSON.stringify([{ type: 'result', is_error: true, error: { message: 'quota exhausted' } }]),
      ),
    /balance or quota/,
  );
  assert.throws(
    () =>
      clientResult(
        JSON.stringify([
          { type: 'result', is_error: true, error: { message: 'max wall-time exceeded' } },
        ]),
      ),
    /timed out/,
  );
});

test('an unreadable or incomplete client envelope is retried once and only a complete result is accepted', async () => {
  const complete = JSON.stringify([{type:'result', is_error:false, result:'{"offerName":"Coaching & Mentoring"}'}]);
  for (const broken of ['', '[{"type":"result","is_error":false,"result":"cut off', '[]']) {
    let calls = 0;
    const result = await retryClientOutput(async () => clientResult(++calls === 1 ? broken : complete), new AbortController().signal);
    assert.equal(result, '{"offerName":"Coaching & Mentoring"}');
    assert.equal(calls, 2);
  }
  let calls = 0;
  await assert.rejects(retryClientOutput(async () => {calls++; return clientResult('truncated');}, new AbortController().signal), /unreadable response/);
  assert.equal(calls, 2, 'Repeated bad output must stop after one retry.');
});

test('client recovery does not retry provider refusals, tool requests, or cancelled operations', async () => {
  for (const message of ['Invalid API key', 'quota exhausted', 'unauthorized client detected', 'aliyun_waf_aa', 'rate limit 429']) {
    let calls = 0;
    await assert.rejects(retryClientOutput(async () => {calls++; return clientResult(JSON.stringify([{type:'result',is_error:true,error:{message}}]));}, new AbortController().signal));
    assert.equal(calls, 1, message);
  }
  let calls = 0;
  const controller = new AbortController();
  await assert.rejects(retryClientOutput(async () => {calls++; controller.abort(); return clientResult('broken');}, controller.signal), {name:'AbortError'});
  assert.equal(calls, 1);
  const tools = JSON.stringify([{type:'result', is_error:false, result:'Do not accept', stats:{tools:{totalCalls:1}}}]);
  calls = 0;
  await assert.rejects(retryClientOutput(async () => {calls++; return clientResult(tools);}, new AbortController().signal), /unsupported tool/);
  assert.equal(calls, 1);
});

test('hosted HTML security challenges and endpoint authentication failures are classified without exposing their contents', () => {
  const failure = (message: string) => JSON.stringify([{type: 'result', is_error: true, error: {message}}]);
  assert.throws(() => clientResult(failure('[API Error: Streaming request received a non-SSE response (HTTP 200, Content-Type: text/html). Body prefix: <!doctype html> <meta name="aliyun_waf_aa" content="private-challenge-token">]')), error => {
    assert.match((error as Error).message, /security gateway blocked the hosted request/);
    assert.doesNotMatch((error as Error).message, /private-challenge-token|rejected the credentials/);
    return true;
  });
  assert.throws(() => clientResult(failure('[API Error: non-SSE response (HTTP 200, Content-Type: text/html)]')), /HTML page instead of AI data/);
  assert.throws(() => clientResult(failure('[API Error: 401 status code (no body)]')), /could not authenticate.*configured AgentRouter endpoint/);
  assert.throws(() => clientResult(failure('Invalid API key')), /rejected the credentials/);
});

test('private relay preserves genuine client identity and normalizes only provider bookkeeping', async () => {
  let called = false;
  const upstream = createServer(async (req, res) => {
    called = true;
    assert.equal(req.headers['user-agent'], 'ActualTestClient/1.0');
    assert.equal(req.headers.authorization, 'Bearer upstream-test-token');
    let input = '';
    for await (const chunk of req) input += chunk;
    const body = JSON.parse(input);
    assert.equal(body.model, 'chosen-model');
    assert.equal(body.max_tokens, 7000);
    assert.equal(body.tools, undefined);
    assert.equal(body.tool_choice, undefined);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(
      'data: null\n\ndata: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: {"object":"billing.summary"}\n\ndata: [DONE]\n\n',
    );
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const relay = await startAgentRouterRelay(
    {
      apiKey: 'upstream-test-token',
      baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`,
      model: 'chosen-model',
      timeoutMs: 1000,
    },
    new AbortController().signal,
    7000,
  );
  try {
    const denied = await fetch(`${relay.baseUrl}/chat/completions`, { method: 'POST', body: '{}' });
    assert.equal(denied.status, 403);
    assert.equal(called, false);
    const response = await fetch(`${relay.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${relay.localToken}`,
        'User-Agent': 'ActualTestClient/1.0',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'untrusted-override',
        tools: [{ type: 'function' }],
        tool_choice: 'auto',
        stream: true,
        messages: [],
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(
      await response.text(),
      'data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n',
    );
  } finally {
    await relay.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
