/**
 * Tests for the MiniMax-shaped OpenAI-adapter quirks (provider-plugin seam) and
 * resolving a catalog-contributed provider through the factory. MiniMax is
 * OpenAI-compatible but: uses `max_completion_tokens`, doesn't accept
 * `tool_choice`/`parallel_tool_calls`, wants vendor body fields (reasoning_split),
 * and can flag errors via `base_resp.status_code` on HTTP 200.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type OpenAI from 'openai';

import {
  classifyOpenAiError,
  createOpenAiProvider,
  LlmProviderCatalog,
  resolveLlmProvider,
  type LlmRequest,
} from '@omadia/llm-provider';

interface Captured {
  params?: Record<string, unknown>;
}

function mockClient(captured: Captured, response: Record<string, unknown>): OpenAI {
  return {
    chat: {
      completions: {
        create: async (params: Record<string, unknown>) => {
          captured.params = params;
          return response;
        },
      },
    },
  } as unknown as OpenAI;
}

function okCompletion(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    object: 'chat.completion',
    created: 0,
    model: 'MiniMax-M3',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'hi', refusal: null },
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    ...overrides,
  };
}

const toolReq: LlmRequest = {
  model: 'MiniMax-M3',
  maxTokens: 4096,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
  tools: [{ name: 'a', description: 'A', inputSchema: { type: 'object' } }],
  toolChoice: { type: 'required' },
};

test('quirks: max_completion_tokens replaces max_tokens, tool_choice dropped, extraBody merged', async () => {
  const captured: Captured = {};
  const provider = createOpenAiProvider({
    client: mockClient(captured, okCompletion()),
    id: 'minimax', // non-openai id → would default to legacy max_tokens
    maxTokensField: 'max_completion_tokens',
    dropToolChoice: true,
    extraBody: { reasoning_split: true },
  });

  await provider.complete(toolReq);

  const p = captured.params ?? {};
  assert.equal(p['max_completion_tokens'], 4096);
  assert.equal(p['max_tokens'], undefined);
  assert.equal(p['tool_choice'], undefined, 'tool_choice must be dropped');
  assert.equal(p['parallel_tool_calls'], undefined);
  assert.equal(p['reasoning_split'], true);
  // tools themselves are still forwarded
  assert.ok(Array.isArray(p['tools']) && (p['tools'] as unknown[]).length === 1);
});

test('without quirks a non-openai id keeps legacy max_tokens + tool_choice', async () => {
  const captured: Captured = {};
  const provider = createOpenAiProvider({
    client: mockClient(captured, okCompletion()),
    id: 'minimax',
  });
  await provider.complete(toolReq);
  const p = captured.params ?? {};
  assert.equal(p['max_tokens'], 4096);
  assert.equal(p['max_completion_tokens'], undefined);
  assert.ok(p['tool_choice'] !== undefined);
});

test('checkBaseResp throws on a non-zero base_resp, classified by mapped status', async () => {
  const captured: Captured = {};
  const provider = createOpenAiProvider({
    client: mockClient(
      captured,
      okCompletion({ base_resp: { status_code: 1004, status_msg: 'auth failed' } }),
    ),
    id: 'minimax',
    checkBaseResp: true,
  });

  await assert.rejects(
    () => provider.complete(toolReq),
    (err: unknown) => {
      assert.match(String(err), /base_resp error 1004/);
      assert.deepEqual(classifyOpenAiError(err), { retryable: false, kind: 'auth' });
      return true;
    },
  );
});

test('checkBaseResp: rate-limit code is classified retryable', async () => {
  const captured: Captured = {};
  const provider = createOpenAiProvider({
    client: mockClient(captured, okCompletion({ base_resp: { status_code: 1002 } })),
    id: 'minimax',
    checkBaseResp: true,
  });
  await assert.rejects(
    () => provider.complete(toolReq),
    (err: unknown) => {
      assert.deepEqual(classifyOpenAiError(err), { retryable: true, kind: 'rate_limit' });
      return true;
    },
  );
});

test('checkBaseResp: status_code 0 (success) does not throw', async () => {
  const captured: Captured = {};
  const provider = createOpenAiProvider({
    client: mockClient(captured, okCompletion({ base_resp: { status_code: 0 } })),
    id: 'minimax',
    checkBaseResp: true,
  });
  const res = await provider.complete(toolReq);
  assert.equal(res.finishReason, 'stop');
});

test('factory resolves a catalog provider with its baseURL + quirks', async () => {
  const catalog = new LlmProviderCatalog();
  catalog.register({
    id: 'minimax',
    label: 'MiniMax',
    wireFormat: 'openai-compatible',
    baseURL: 'https://api.minimax.io/v1',
    quirks: { maxTokensField: 'max_completion_tokens', dropToolChoice: true },
    models: [
      {
        id: 'minimax:MiniMax-M3',
        provider: 'minimax',
        modelId: 'MiniMax-M3',
        label: 'MiniMax M3',
        class: 'frontier',
        maxTokens: 131072,
        contextWindow: 1048576,
        vision: true,
      },
    ],
  });

  const provider = await resolveLlmProvider({
    providerId: 'minimax',
    getSecret: async () => 'sk-minimax-test',
    catalog,
  });
  assert.ok(provider !== undefined);
  assert.equal(provider?.id, 'minimax');
  catalog.unregister('minimax');
});

test('factory returns undefined when no key is configured', async () => {
  const catalog = new LlmProviderCatalog();
  catalog.register({
    id: 'minimax',
    label: 'MiniMax',
    wireFormat: 'openai-compatible',
    baseURL: 'https://api.minimax.io/v1',
    models: [
      {
        id: 'minimax:MiniMax-M3',
        provider: 'minimax',
        modelId: 'MiniMax-M3',
        label: 'MiniMax M3',
        class: 'frontier',
        maxTokens: 131072,
        contextWindow: 1048576,
        vision: true,
      },
    ],
  });
  const provider = await resolveLlmProvider({
    providerId: 'minimax',
    getSecret: async () => undefined,
    catalog,
  });
  assert.equal(provider, undefined);
  catalog.unregister('minimax');
});

test('factory throws for an unknown provider with no baseURL/catalog', async () => {
  await assert.rejects(
    () =>
      resolveLlmProvider({
        providerId: 'minimax',
        getSecret: async () => 'sk-test',
      }),
    /requires a baseURL/,
  );
});
