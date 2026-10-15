import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompletion } from '../../src/lib/copy-studio/server/provider';

const config = {
  apiKey: 'test-token-not-a-real-key',
  baseUrl: 'https://provider.invalid/v1',
  model: 'test-model',
  timeoutMs: 1000,
};
test('a client authorization rejection is not mislabeled as an invalid key', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      Response.json(
        { type: 'unauthorized_client_error', error: { message: 'unauthorized client detected' } },
        { status: 401 },
      );
    await assert.rejects(
      createCompletion(config)('', '', new AbortController().signal),
      /rejected the client integration/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
test('provider identifies the application and rejects truncated drafts', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, 'https://provider.invalid/v1/chat/completions');
      assert.equal((init?.headers as Record<string, string>)['User-Agent'], 'CopyStudio/2.0');
      assert.equal(JSON.parse(init?.body as string).stream, false);
      return Response.json({
        choices: [{ finish_reason: 'length', message: { content: '{"partial":true}' } }],
      });
    };
    await assert.rejects(
      createCompletion(config)('', '', new AbortController().signal),
      /cut short/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
test('network and balance errors are actionable without exposing provider internals', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      throw new Error('secret internal host');
    };
    await assert.rejects(
      createCompletion(config)('', '', new AbortController().signal),
      /could not be reached/,
    );
    globalThis.fetch = async () =>
      Response.json(
        { error: { message: 'Access denied due to overdue account' } },
        { status: 403 },
      );
    await assert.rejects(
      createCompletion(config)('', '', new AbortController().signal),
      /account balance or quota/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
