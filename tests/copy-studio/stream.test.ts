import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCopy } from '../../src/components/copy-studio/api';
import { draft, input } from './fixtures';

test('client parses events split across arbitrary chunks including unicode', async () => {
  const original = globalThis.fetch;
  try {
    const content = `: heartbeat\n\ndata: {"type":"progress","stage":"Writing…"}\n\ndata: ${JSON.stringify({ type: 'result', result: { draft, issues: [] } })}\n\n`;
    const bytes = new TextEncoder().encode(content);
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
            controller.close();
          },
        }),
      );
    const progress: string[] = [];
    const result = await generateCopy(input, new AbortController().signal, (stage) =>
      progress.push(stage),
    );
    assert.deepEqual(progress, ['Writing…']);
    assert.equal(result.draft.sections.length, 9);
  } finally {
    globalThis.fetch = original;
  }
});
test('client rejects a disconnected stream instead of accepting a partial draft', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('data: {"type":"progress","stage":"Writing"}\n\n');
    await assert.rejects(
      generateCopy(input, new AbortController().signal, () => {}),
      /connection ended/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
