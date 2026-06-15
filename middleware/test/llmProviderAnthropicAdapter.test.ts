/**
 * Phase-1 contract tests for `@omadia/llm-provider` (docs/plans/
 * llm-provider-interface-plan.md): the Anthropic adapter must translate
 * neutral DTOs to/from the vendor wire shapes, and the legacy plugin
 * wrapper (`src/platform/anthropicLlmProvider.ts`) must keep its exact
 * v1 behaviour on top of it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type Anthropic from '@anthropic-ai/sdk';

import {
  classifyAnthropicError,
  collectText,
  createAnthropicProvider,
  toolCalls,
  type LlmStreamEvent,
} from '@omadia/llm-provider';

import { createAnthropicLlmProvider } from '../src/platform/anthropicLlmProvider.js';

interface Captured {
  params?: Record<string, unknown>;
}

function textResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-8',
    content: [
      { type: 'text', text: 'Hallo ' },
      { type: 'text', text: 'Welt' },
    ],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 50,
      cache_read_input_tokens: 10,
    },
    ...overrides,
  };
}

function mockClient(
  captured: Captured,
  response: Record<string, unknown>,
): Anthropic {
  return {
    messages: {
      create: async (params: Record<string, unknown>) => {
        captured.params = params;
        return response;
      },
    },
  } as unknown as Anthropic;
}

test('complete() maps a text response to neutral content + usage', async () => {
  const captured: Captured = {};
  const provider = createAnthropicProvider({
    client: mockClient(captured, textResponse()),
  });

  const res = await provider.complete({
    model: 'claude-opus-4-8',
    maxTokens: 512,
    system: 'Sei knapp.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  });

  assert.equal(collectText(res.content), 'Hallo Welt');
  assert.equal(res.finishReason, 'stop');
  assert.equal(res.providerFinishReason, 'end_turn');
  assert.equal(res.model, 'claude-opus-4-8');
  assert.deepEqual(res.usage, {
    inputTokens: 100,
    outputTokens: 20,
    cacheWriteTokens: 50,
    cacheReadTokens: 10,
  });
  assert.equal(captured.params?.['model'], 'claude-opus-4-8');
  assert.equal(captured.params?.['max_tokens'], 512);
  assert.equal(captured.params?.['system'], 'Sei knapp.');
});

test('complete() maps tool_use blocks to tool_calls finishReason + ToolCallPart', async () => {
  const provider = createAnthropicProvider({
    client: mockClient(
      {},
      textResponse({
        content: [
          { type: 'text', text: 'Ich schaue nach.' },
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'lookup',
            input: { q: 'x' },
          },
        ],
        stop_reason: 'tool_use',
      }),
    ),
  });

  const res = await provider.complete({
    model: 'claude-opus-4-8',
    maxTokens: 512,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  });

  assert.equal(res.finishReason, 'tool_calls');
  const calls = toolCalls(res.content);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    type: 'tool_call',
    id: 'toolu_1',
    name: 'lookup',
    input: { q: 'x' },
  });
});

test('request mapping: image, tool_result, cacheHints, toolChoice', async () => {
  const captured: Captured = {};
  const provider = createAnthropicProvider({
    client: mockClient(captured, textResponse()),
  });

  await provider.complete({
    model: 'claude-sonnet-4-6',
    maxTokens: 256,
    system: 'System.',
    cacheHints: { system: true, tools: true },
    tools: [
      { name: 'a', description: 'A', inputSchema: { type: 'object' } },
      { name: 'b', description: 'B', inputSchema: { type: 'object' } },
    ],
    toolChoice: { type: 'required' },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Bild:' },
          { type: 'image', mediaType: 'image/png', data: 'aGk=' },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'tool_call', id: 'toolu_9', name: 'a', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolCallId: 'toolu_9', content: 'ok' },
        ],
      },
    ],
  });

  const p = captured.params as Record<string, unknown>;
  // cacheHints.system → system becomes a cache_control text block array
  assert.deepEqual(p['system'], [
    { type: 'text', text: 'System.', cache_control: { type: 'ephemeral' } },
  ]);
  // cacheHints.tools → cache_control only on the LAST tool
  const tools = p['tools'] as Array<Record<string, unknown>>;
  assert.equal(tools[0]?.['cache_control'], undefined);
  assert.deepEqual(tools[1]?.['cache_control'], { type: 'ephemeral' });
  // toolChoice required → Anthropic 'any'
  assert.deepEqual(p['tool_choice'], { type: 'any' });
  // content part mapping
  const messages = p['messages'] as Array<{
    role: string;
    content: Array<Record<string, unknown>>;
  }>;
  assert.deepEqual(messages[0]?.content[1], {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'aGk=' },
  });
  assert.deepEqual(messages[1]?.content[0], {
    type: 'tool_use',
    id: 'toolu_9',
    name: 'a',
    input: {},
  });
  assert.deepEqual(messages[2]?.content[0], {
    type: 'tool_result',
    tool_use_id: 'toolu_9',
    content: 'ok',
  });
});

test('request mapping: server tool (memory) emits {type,name}, no input_schema', async () => {
  // Regression for the live 400 `tools.0.custom.input_schema: Field required`:
  // a ToolSpec carrying `serverType` is a provider-native server tool whose
  // schema lives server side. It must be sent as `{ type, name }`, never as a
  // custom tool with an `input_schema`.
  const captured: Captured = {};
  const provider = createAnthropicProvider({
    client: mockClient(captured, textResponse()),
  });

  await provider.complete({
    model: 'claude-sonnet-4-6',
    maxTokens: 256,
    tools: [
      {
        name: 'memory',
        description: '',
        inputSchema: {},
        serverType: 'memory_20250818',
      },
      { name: 'a', description: 'A', inputSchema: { type: 'object' } },
    ],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  });

  const p = captured.params as Record<string, unknown>;
  const tools = p['tools'] as Array<Record<string, unknown>>;
  assert.deepEqual(tools[0], { type: 'memory_20250818', name: 'memory' });
  assert.equal('input_schema' in (tools[0] ?? {}), false);
  // the custom tool still carries its schema
  assert.deepEqual(tools[1]?.['input_schema'], { type: 'object' });
});

test('stream() yields text deltas then a final response', async () => {
  const events = [
    { type: 'message_start' },
    {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'Hal' },
    },
    {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'lo' },
    },
    { type: 'message_stop' },
  ];
  const fakeStream = {
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
    finalMessage: async () => textResponse({ content: [{ type: 'text', text: 'Hallo' }] }),
  };
  const client = {
    messages: { stream: () => fakeStream },
  } as unknown as Anthropic;

  const provider = createAnthropicProvider({ client });
  const seen: LlmStreamEvent[] = [];
  for await (const ev of provider.stream({
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 64,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  })) {
    seen.push(ev);
  }

  assert.deepEqual(seen.slice(0, 2), [
    { type: 'text_delta', text: 'Hal' },
    { type: 'text_delta', text: 'lo' },
  ]);
  const final = seen[2];
  assert.equal(final?.type, 'final');
  assert.equal(
    final?.type === 'final' ? collectText(final.response.content) : '',
    'Hallo',
  );
});

test('stream() final event normalizes tool_use finishReason', async () => {
  const fakeStream = {
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Moment.' },
      };
    },
    finalMessage: async () =>
      textResponse({
        content: [
          { type: 'tool_use', id: 'toolu_2', name: 'lookup', input: {} },
        ],
        stop_reason: 'tool_use',
      }),
  };
  const client = {
    messages: { stream: () => fakeStream },
  } as unknown as Anthropic;

  const provider = createAnthropicProvider({ client });
  const seen: LlmStreamEvent[] = [];
  for await (const ev of provider.stream({
    model: 'claude-sonnet-4-6',
    maxTokens: 64,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  })) {
    seen.push(ev);
  }
  const final = seen.at(-1);
  assert.equal(final?.type, 'final');
  assert.equal(
    final?.type === 'final' ? final.response.finishReason : undefined,
    'tool_calls',
  );
});

test('stream() rethrows mid-stream vendor errors to the caller', async () => {
  const midStreamError = Object.assign(
    new Error('{"type":"error","error":{"type":"overloaded_error"}}'),
    { error: { type: 'error', error: { type: 'overloaded_error' } } },
  );
  const fakeStream = {
    // Anthropic returns HTTP 200, streams a delta, THEN injects the error.
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Hal' },
      };
      throw midStreamError;
    },
    finalMessage: async () => textResponse(),
  };
  const client = {
    messages: { stream: () => fakeStream },
  } as unknown as Anthropic;

  const provider = createAnthropicProvider({ client });
  const seen: LlmStreamEvent[] = [];
  await assert.rejects(async () => {
    for await (const ev of provider.stream({
      model: 'claude-sonnet-4-6',
      maxTokens: 64,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    })) {
      seen.push(ev);
    }
  });
  // the delta before the error was delivered; the caller decides on retry
  assert.deepEqual(seen, [{ type: 'text_delta', text: 'Hal' }]);
  assert.deepEqual(provider.classifyError(midStreamError), {
    retryable: true,
    kind: 'overloaded',
  });
});

test('stream() maps tool_use block start + input_json deltas to neutral events', async () => {
  const fakeStream = {
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Moment.' },
      };
      // Anthropic opens a tool_use content block, then streams its args JSON.
      yield {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'lookup' },
      };
      yield {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '{"q":' },
      };
      yield {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '"x"}' },
      };
    },
    finalMessage: async () =>
      textResponse({
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'x' } },
        ],
        stop_reason: 'tool_use',
      }),
  };
  const client = {
    messages: { stream: () => fakeStream },
  } as unknown as Anthropic;

  const provider = createAnthropicProvider({ client });
  const seen: LlmStreamEvent[] = [];
  for await (const ev of provider.stream({
    model: 'claude-sonnet-4-6',
    maxTokens: 64,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  })) {
    seen.push(ev);
  }

  // text delta forwarded, tool block signalled, args deltas surfaced (not as
  // answer text), and exactly one terminal final carrying the tool call.
  assert.deepEqual(seen.slice(0, 4), [
    { type: 'text_delta', text: 'Moment.' },
    { type: 'tool_use_start' },
    { type: 'tool_input_delta', text: '{"q":' },
    { type: 'tool_input_delta', text: '"x"}' },
  ]);
  const final = seen.at(-1);
  assert.equal(final?.type, 'final');
  if (final?.type === 'final') {
    assert.equal(final.response.finishReason, 'tool_calls');
    const calls = toolCalls(final.response.content);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.name, 'lookup');
  }
});

test('toolChoice disableParallel maps to disable_parallel_tool_use', async () => {
  const captured: Captured = {};
  const provider = createAnthropicProvider({
    client: mockClient(captured, textResponse()),
  });
  await provider.complete({
    model: 'claude-opus-4-8',
    maxTokens: 64,
    tools: [{ name: 'a', description: 'A', inputSchema: { type: 'object' } }],
    toolChoice: { type: 'auto', disableParallel: true },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  });
  assert.deepEqual((captured.params as Record<string, unknown>)['tool_choice'], {
    type: 'auto',
    disable_parallel_tool_use: true,
  });
});

test('structured system blocks map to per-block cache_control', async () => {
  const captured: Captured = {};
  const provider = createAnthropicProvider({
    client: mockClient(captured, textResponse()),
  });
  await provider.complete({
    model: 'claude-opus-4-8',
    maxTokens: 64,
    system: [
      { text: 'stable domain prompt', cache: true },
      { text: 'per-turn date header' },
    ],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  });
  assert.deepEqual((captured.params as Record<string, unknown>)['system'], [
    {
      type: 'text',
      text: 'stable domain prompt',
      cache_control: { type: 'ephemeral' },
    },
    { type: 'text', text: 'per-turn date header' },
  ]);
});

test('betas map to the anthropic-beta header; absence sends no options', async () => {
  const calls: Array<{ params: unknown; options: unknown }> = [];
  const client = {
    messages: {
      create: async (params: unknown, options?: unknown) => {
        calls.push({ params, options });
        return textResponse();
      },
    },
  } as unknown as Anthropic;
  const provider = createAnthropicProvider({ client });

  await provider.complete({
    model: 'claude-opus-4-8',
    maxTokens: 64,
    betas: ['context-management-2025-06-27'],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  });
  assert.deepEqual(calls[0]?.options, {
    headers: { 'anthropic-beta': 'context-management-2025-06-27' },
  });

  await provider.complete({
    model: 'claude-opus-4-8',
    maxTokens: 64,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  });
  // No betas → second arg omitted entirely (preserves the historical
  // single-arg create() call shape).
  assert.equal(calls[1]?.options, undefined);
});

test('classifyAnthropicError covers the historical retry taxonomy', () => {
  assert.deepEqual(classifyAnthropicError({ status: 429 }), {
    retryable: true,
    kind: 'rate_limit',
  });
  assert.deepEqual(
    classifyAnthropicError({
      error: { type: 'error', error: { type: 'overloaded_error' } },
    }),
    { retryable: true, kind: 'overloaded' },
  );
  assert.deepEqual(classifyAnthropicError({ status: 401 }), {
    retryable: false,
    kind: 'auth',
  });
  assert.deepEqual(classifyAnthropicError({ status: 503 }), {
    retryable: true,
    kind: 'other',
  });
  assert.deepEqual(classifyAnthropicError(new Error('boom')), {
    retryable: false,
    kind: 'other',
  });
  assert.equal(
    classifyAnthropicError(new Error('upstream overloaded_error mid-stream'))
      .retryable,
    true,
  );
  // bare mid-stream api_error in raw message text — the case the
  // historical streaming.ts text-scan existed for (Forge finding #1)
  assert.equal(
    classifyAnthropicError(new Error('{"type":"api_error","message":"x"}'))
      .retryable,
    true,
  );
  // flattened error shape (no envelope)
  assert.deepEqual(classifyAnthropicError({ type: 'overloaded_error' }), {
    retryable: true,
    kind: 'overloaded',
  });
});

test('legacy plugin wrapper keeps the v1 contract shape', async () => {
  const captured: Captured = {};
  const provider = createAnthropicLlmProvider({
    client: mockClient(captured, textResponse()),
    log: () => {},
  });

  const res = await provider.complete({
    model: 'claude-haiku-4-5-20251001',
    system: 'knapp',
    messages: [{ role: 'user', content: 'Hi' }],
  });

  assert.deepEqual(res, {
    text: 'Hallo Welt',
    model: 'claude-opus-4-8',
    inputTokens: 100,
    outputTokens: 20,
    // phase-2 additive: neutral finishReason alongside the legacy stopReason
    finishReason: 'stop',
    stopReason: 'end_turn',
  });
  // v1 default max_tokens stays 4096
  assert.equal(
    (captured.params as Record<string, unknown>)['max_tokens'],
    4096,
  );
  // plain-string plugin messages become single text blocks
  const messages = (captured.params as Record<string, unknown>)[
    'messages'
  ] as Array<{ content: unknown }>;
  assert.deepEqual(messages[0]?.content, [{ type: 'text', text: 'Hi' }]);
});

test('legacy plugin wrapper preserves stop_sequence', async () => {
  const provider = createAnthropicLlmProvider({
    client: mockClient({}, textResponse({ stop_reason: 'stop_sequence' })),
    log: () => {},
  });
  const res = await provider.complete({
    model: 'claude-haiku-4-5-20251001',
    messages: [{ role: 'user', content: 'Hi' }],
  });
  assert.equal(res.stopReason, 'stop_sequence');
});
