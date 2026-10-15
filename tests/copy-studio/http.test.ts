import test from 'node:test';
import assert from 'node:assert/strict';
import { handleCopyStudio } from '../../src/lib/copy-studio/server/http';
import { input, draft, strategy } from './fixtures';

const request = (operation: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost:3000/api/copy-studio/${operation}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000', ...headers },
    body: JSON.stringify(body),
  });

test('dashboard API validates before calling AI and preserves the streaming contract', async () => {
  let calls = 0;
  const complete = async () => JSON.stringify(++calls % 2 ? strategy : draft);
  const invalid = await handleCopyStudio(request('generate', {}), 'generate', complete);
  assert.equal(invalid.status, 400);
  assert.equal(calls, 0);
  const response = await handleCopyStudio(request('generate', input), 'generate', complete);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const events = await response.text();
  assert.match(events, /"type":"progress"/);
  assert.match(events, /"type":"result"/);
  assert.equal(calls, 2);
});

test('dashboard API rejects foreign origins, oversized bodies, private URLs, and removed features', async () => {
  const complete = async () => {
    throw new Error('Must not reach AI');
  };
  assert.equal(
    (
      await handleCopyStudio(
        request('generate', input, { Origin: 'https://foreign.example' }),
        'generate',
        complete,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await handleCopyStudio(
        request('generate', input, { 'Sec-Fetch-Site': 'cross-site' }),
        'generate',
        complete,
      )
    ).status,
    403,
  );
  assert.equal(
    (await handleCopyStudio(request('import', { text: 'a'.repeat(2_000_001) }), 'import', complete))
      .status,
    413,
  );
  assert.equal(
    (await handleCopyStudio(request('import', { url: 'http://localhost' }), 'import', complete))
      .status,
    400,
  );
  assert.equal(
    (await handleCopyStudio(request('custom-prompt', {}), 'custom-prompt', complete)).status,
    404,
  );
});

test('cancelling the dashboard response cancels generation', async () => {
  let signalSeen: AbortSignal | undefined;
  const complete = async (_system: string, _prompt: string, signal: AbortSignal) => {
    signalSeen = signal;
    return new Promise<string>((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
    );
  };
  const response = await handleCopyStudio(request('generate', input), 'generate', complete);
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  assert.equal(signalSeen?.aborted, true);
});
