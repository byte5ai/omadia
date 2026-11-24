/**
 * SDK 1.x sends the API key as `Authorization: Bearer` instead of `X-Api-Key`.
 * `createAnthropicClient` keeps the SDK default for api.anthropic.com and the
 * legacy `X-Api-Key` header (and no `Authorization`) for every custom base
 * URL, so an Anthropic-compatible gateway sees what SDK 0.x sent it.
 *
 * Asserted against a real loopback server: the headers are what the SDK puts
 * on the wire, not what our options object looks like.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

import {
  createAnthropicClient,
  usesLegacyApiKeyHeader,
} from '@omadia/llm-adapter-anthropic';

const MESSAGE_BODY = JSON.stringify({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-test',
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
});

async function captureHeaders(
  build: (baseURL: string) => ReturnType<typeof createAnthropicClient>,
): Promise<IncomingHttpHeaders> {
  let seen: IncomingHttpHeaders | undefined;
  const server = createServer((req, res) => {
    seen = req.headers;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(MESSAGE_BODY);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const client = build(`http://127.0.0.1:${String(port)}`);
    await client.messages.create({
      model: 'claude-test',
      max_tokens: 8,
      messages: [{ role: 'user', content: 'hi' }],
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assert.ok(seen, 'request reached the server');
  return seen;
}

test('custom baseURL keeps X-Api-Key and sends no Authorization', async () => {
  const headers = await captureHeaders((baseURL) =>
    createAnthropicClient({ apiKey: 'sk-test-key', baseURL, maxRetries: 0 }),
  );
  assert.equal(headers['x-api-key'], 'sk-test-key');
  assert.equal(headers['authorization'], undefined);
  assert.equal(headers['anthropic-version'], '2026-10-21');
});

test('usesLegacyApiKeyHeader: only api.anthropic.com gets the SDK bearer default', () => {
  assert.equal(usesLegacyApiKeyHeader('https://api.anthropic.com'), false);
  assert.equal(usesLegacyApiKeyHeader('https://api.anthropic.com/'), false);
  assert.equal(usesLegacyApiKeyHeader('https://gateway.example.com/anthropic'), true);
  assert.equal(usesLegacyApiKeyHeader('http://127.0.0.1:4000'), true);
  assert.equal(usesLegacyApiKeyHeader('not a url'), true);
});

test('first-party client sends the key as Authorization: Bearer', async () => {
  const client = createAnthropicClient({ apiKey: 'sk-test-key', maxRetries: 0 });
  assert.equal(client.baseURL, 'https://api.anthropic.com');
  // Point the first-party client at the loopback server per request, so the
  // header decision (made from the client's own baseURL) stays first-party.
  const headers = await captureHeaders((baseURL) =>
    client.withOptions({ baseURL }),
  );
  assert.equal(headers['authorization'], 'Bearer sk-test-key');
  assert.equal(headers['x-api-key'], undefined);
});
