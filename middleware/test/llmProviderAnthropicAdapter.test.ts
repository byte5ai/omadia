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
  createAnthropicProvider,
  requiresEffortBeta,
  supportsForcedToolChoice,
  EFFORT_BETA,
  THINKING_BINDING_BETA,
} from '@omadia/llm-adapter-anthropic';
import {
  collectText,
  toolCalls,
  type LlmStreamEvent,
  type ToolChoice,
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

test('#1211 declares toolChoiceNone and sends tool_choice none with the tools intact', async () => {
  // The orchestrator's finalize pass only keeps the tool list (and with it the
  // cached prefix) for providers that opt in; without the flag it sends none.
  const captured: Captured = {};
  const provider = createAnthropicProvider({
    client: mockClient(captured, textResponse()),
  });
  assert.equal(provider.capabilities.toolChoiceNone, true);
  await provider.complete({
    model: 'claude-opus-4-8',
    maxTokens: 64,
    tools: [{ name: 'a', description: 'A', inputSchema: { type: 'object' } }],
    toolChoice: { type: 'none' },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  });
  const params = captured.params as Record<string, unknown>;
  assert.deepEqual(params['tool_choice'], { type: 'none' });
  assert.equal((params['tools'] as unknown[]).length, 1);
});

/**
 * `claude-opus-5-5` and `claude-fable-5-1` 400 on a forced `tool_choice`
 * (measured 2026-09-23), and so does `claude-sonnet-5-5`. Opus 5.5 was already
 * selectable, so every forced path — card router, claim extractor, evidence
 * judge, sub-agent turn obligation — threw on it and fell back silently.
 */
test('forced toolChoice degrades to auto on models that reject it', async () => {
  const cases: ReadonlyArray<[ToolChoice, Record<string, unknown>]> = [
    [{ type: 'required' }, { type: 'auto' }],
    [{ type: 'tool', name: 'a' }, { type: 'auto' }],
    [
      { type: 'tool', name: 'a', disableParallel: true },
      { type: 'auto', disable_parallel_tool_use: true },
    ],
    [{ type: 'none' }, { type: 'none' }],
  ];
  for (const model of [
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'claude-fable-5-1',
    'claude-mythos-5-1',
  ]) {
    assert.equal(supportsForcedToolChoice(model), false, model);
    for (const [choice, expected] of cases) {
      const captured: Captured = {};
      const provider = createAnthropicProvider({
        client: mockClient(captured, textResponse()),
      });
      await provider.complete({
        model,
        maxTokens: 64,
        tools: [{ name: 'a', description: 'A', inputSchema: { type: 'object' } }],
        toolChoice: choice,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      });
      assert.deepEqual(
        captured.params?.['tool_choice'],
        expected,
        `${model} ${choice.type}`,
      );
    }
  }
});

test('forced toolChoice is still sent to models that honour it', async () => {
  // The other direction: a gate that downgraded everywhere would pass the
  // test above while removing forcing from Opus 5 / Sonnet 5 / Fable 5 / Haiku.
  // `claude-sonnet-5` also pins the substring match: `claude-sonnet-5-5` must
  // not swallow its predecessor.
  for (const model of [
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-fable-5',
    'claude-haiku-4-5-20251001',
  ]) {
    assert.equal(supportsForcedToolChoice(model), true, model);
    const captured: Captured = {};
    const provider = createAnthropicProvider({
      client: mockClient(captured, textResponse()),
    });
    await provider.complete({
      model,
      maxTokens: 64,
      tools: [{ name: 'a', description: 'A', inputSchema: { type: 'object' } }],
      toolChoice: { type: 'tool', name: 'a' },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    });
    assert.deepEqual(captured.params?.['tool_choice'], { type: 'tool', name: 'a' });
  }
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

test('legacy plugin wrapper reports a refusal as refusal, with its category only (#1219)', async () => {
  const lines: string[] = [];
  const provider = createAnthropicLlmProvider({
    client: mockClient(
      {},
      textResponse({
        content: [],
        stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: 'cyber', explanation: 'vendor prose' },
      }),
    ),
    log: (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    },
  });
  const res = await provider.complete({
    model: 'claude-haiku-4-5-20251001',
    messages: [{ role: 'user', content: 'Hi' }],
  });
  // Was `end_turn`: a decline reported as a normal turn end.
  assert.equal(res.stopReason, 'refusal');
  assert.equal(res.finishReason, 'stop');
  assert.equal(res.text, '');
  // Only the category crosses the plugin contract — not the explanation.
  assert.deepEqual(res.refusal, { category: 'cyber' });
  assert.ok(lines.some((l) => l.includes('category=cyber')), lines.join('\n'));

  // No category: the object is still there, because its presence is the signal.
  const bare = await createAnthropicLlmProvider({
    client: mockClient(
      {},
      textResponse({ content: [], stop_reason: 'refusal', stop_details: null }),
    ),
    log: () => {},
  }).complete({ model: 'claude-haiku-4-5-20251001', messages: [{ role: 'user', content: 'Hi' }] });
  assert.equal(bare.stopReason, 'refusal');
  assert.deepEqual(bare.refusal, {});

  // An ordinary turn carries no `refusal` key at all.
  const normal = await createAnthropicLlmProvider({
    client: mockClient({}, textResponse()),
    log: () => {},
  }).complete({ model: 'claude-haiku-4-5-20251001', messages: [{ role: 'user', content: 'Hi' }] });
  assert.equal('refusal' in normal, false);
});

/**
 * Regression: `temperature` is a hard 400 on some models, and the adapter is
 * the layer that knows the wire contract.
 *
 * Found when the adversarial eval ran for the first time (its API key had only
 * just been set) and crashed with "`temperature` is deprecated for this
 * model". The eval was the loud symptom; the quiet one is
 * `LlmScreener.screen()`, which sends `temperature: 0` on every inbound turn
 * and whose caller turns any exception into `unscreenable` — fail-open. With
 * the repo's own `DEFAULT_ORCHESTRATOR_MODEL` (`claude-opus-4-8`), #579's
 * inbound screening was therefore a no-op that reported no error.
 *
 * The table in `supportsTemperature` is measured, not inferred: `opus-4-6`
 * accepts the parameter and `opus-4-7` rejects it, so "newer than X" is a
 * plausible and wrong rule.
 */
test('complete() drops temperature for models that reject it', async () => {
  for (const model of [
    'claude-opus-4-7',
    'claude-opus-4-8',
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-sonnet-5-20260101',
  ]) {
    const captured: Captured = {};
    const provider = createAnthropicProvider({
      client: mockClient(captured, textResponse()),
    });

    await provider.complete({
      model,
      maxTokens: 16,
      temperature: 0,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    });

    assert.equal(
      captured.params?.['temperature'],
      undefined,
      `${model} must not receive a temperature`,
    );
  }
});

test('complete() still sends temperature for models that honour it', async () => {
  // The other direction: a gate that dropped the parameter everywhere would
  // pass the test above while silently removing determinism from the models
  // that still support it.
  for (const model of [
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-haiku-4-5-20251001',
  ]) {
    const captured: Captured = {};
    const provider = createAnthropicProvider({
      client: mockClient(captured, textResponse()),
    });

    await provider.complete({
      model,
      maxTokens: 16,
      temperature: 0,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    });

    assert.equal(captured.params?.['temperature'], 0, `${model} lost its temperature`);
  }
});

// ---------------------------------------------------------------------------
// #1033 — effort
// ---------------------------------------------------------------------------

test('effort maps to output_config.effort on every model, beta only where needed', async () => {
  const calls: Array<{ params: Record<string, unknown>; options: unknown }> = [];
  const client = {
    messages: {
      create: async (params: Record<string, unknown>, options?: unknown) => {
        calls.push({ params, options });
        return textResponse();
      },
    },
  } as unknown as Anthropic;
  const provider = createAnthropicProvider({ client });

  // Effort is GA from 4.6 on: the mapping happens, the beta does not ride
  // along, and the caller's own betas are the only header content.
  await provider.complete({
    model: 'claude-opus-4-8',
    maxTokens: 64,
    effort: 'xhigh',
    betas: ['context-management-2025-06-27'],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  });
  assert.deepEqual(calls[0]?.params['output_config'], { effort: 'xhigh' });
  assert.deepEqual(calls[0]?.options, {
    headers: { 'anthropic-beta': 'context-management-2025-06-27' },
  });

  // Opus 4.5 still needs the opt-in: appended to the caller's betas, not
  // replacing them.
  await provider.complete({
    model: 'claude-opus-4-5-20251101',
    maxTokens: 64,
    effort: 'high',
    betas: ['context-management-2025-06-27'],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  });
  assert.deepEqual(calls[1]?.params['output_config'], { effort: 'high' });
  assert.deepEqual(calls[1]?.options, {
    headers: { 'anthropic-beta': `context-management-2025-06-27,${EFFORT_BETA}` },
  });

  // A GA model carrying effort and nothing else sends no request options at
  // all — not an empty beta header.
  await provider.complete({
    model: 'claude-opus-5-5',
    maxTokens: 64,
    effort: 'low',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  });
  assert.deepEqual(calls[2]?.params['output_config'], { effort: 'low' });
  assert.equal(calls[2]?.options, undefined);

  // A caller that opts in explicitly is honoured on any model, exactly once.
  await provider.complete({
    model: 'claude-opus-4-5',
    maxTokens: 64,
    effort: 'medium',
    betas: [EFFORT_BETA],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  });
  assert.deepEqual(calls[3]?.options, {
    headers: { 'anthropic-beta': EFFORT_BETA },
  });

  // No effort → no output_config, no effort beta: the common path is untouched.
  await provider.complete({
    model: 'claude-opus-4-5',
    maxTokens: 64,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  });
  assert.equal(calls[4]?.params['output_config'], undefined);
  assert.equal(calls[4]?.options, undefined);
});

// ---------------------------------------------------------------------------
// #1219 — structured outputs
// ---------------------------------------------------------------------------

test('outputFormat maps to output_config.format and shares the object with effort', async () => {
  const calls: Array<{ params: Record<string, unknown>; options: unknown }> = [];
  const client = {
    messages: {
      create: async (params: Record<string, unknown>, options?: unknown) => {
        calls.push({ params, options });
        return textResponse();
      },
    },
  } as unknown as Anthropic;
  const provider = createAnthropicProvider({ client });
  const schema = {
    type: 'object',
    properties: { entities: { type: 'array', items: { type: 'string' } } },
    required: ['entities'],
    additionalProperties: false,
  };

  // Format alone: the current `output_config.format` shape, no beta header —
  // structured outputs is GA, unlike effort on Opus 4.5.
  await provider.complete({
    model: 'claude-haiku-4-5',
    maxTokens: 64,
    outputFormat: { type: 'json_schema', schema },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  });
  assert.deepEqual(calls[0]?.params['output_config'], {
    format: { type: 'json_schema', schema },
  });
  assert.equal(calls[0]?.options, undefined);
  // NOT the deprecated top-level parameter.
  assert.equal(calls[0]?.params['output_format'], undefined);

  // Effort + format share one object. Two independent spreads would have made
  // the second silently drop the first.
  await provider.complete({
    model: 'claude-opus-5-5',
    maxTokens: 64,
    effort: 'low',
    outputFormat: { type: 'json_schema', schema },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  });
  assert.deepEqual(calls[1]?.params['output_config'], {
    effort: 'low',
    format: { type: 'json_schema', schema },
  });
  // The format object carries exactly `type` + `schema`. Anthropic rejects
  // unknown nested body fields with a 400, so an extra key here would be a
  // hard failure on the first caller that set it — not a dropped field.
  assert.deepEqual(
    Object.keys(
      (calls[1]?.params['output_config'] as { format: object }).format,
    ).sort(),
    ['schema', 'type'],
  );

  // Neither → no `output_config` key at all, so the common path is unchanged.
  await provider.complete({
    model: 'claude-opus-5-5',
    maxTokens: 64,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  });
  assert.equal('output_config' in (calls[2]?.params ?? {}), false);
});

test('the plugin wrapper forwards outputFormat to output_config.format (#1219)', async () => {
  const schema = {
    type: 'object',
    properties: { entities: { type: 'array', items: { type: 'string' } } },
    required: ['entities'],
    additionalProperties: false,
  };
  const captured: Captured = {};
  const provider = createAnthropicLlmProvider({
    client: mockClient(captured, textResponse()),
    log: () => {},
  });
  await provider.complete({
    model: 'claude-haiku-4-5-20251001',
    outputFormat: { type: 'json_schema', schema },
    messages: [{ role: 'user', content: 'Hi' }],
  });
  // `ctx.llm.complete` → neutral `outputFormat` → the adapter's current shape,
  // carrying exactly `type` + `schema`.
  assert.deepEqual(captured.params?.['output_config'], {
    format: { type: 'json_schema', schema },
  });
  assert.equal(captured.params?.['output_format'], undefined);

  // Not asked for → no `output_config` at all.
  const plain: Captured = {};
  await createAnthropicLlmProvider({
    client: mockClient(plain, textResponse()),
    log: () => {},
  }).complete({
    model: 'claude-haiku-4-5-20251001',
    messages: [{ role: 'user', content: 'Hi' }],
  });
  assert.equal('output_config' in (plain.params ?? {}), false);
});

// ---------------------------------------------------------------------------
// #1219 — refusals
// ---------------------------------------------------------------------------

test('a refusal surfaces stop_details; every other stop reason carries none', async () => {
  const replies: Array<Record<string, unknown>> = [
    // Declined with a category — the shape Opus 5.5 returns.
    {
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'bio', explanation: 'declined' },
      content: [],
    },
    // Declined with no details at all: presence is still the signal.
    { stop_reason: 'refusal', stop_details: null, content: [] },
    // A normal turn. stop_details is null here, and reading it unguarded on
    // every response is the bug this guards against.
    { stop_reason: 'end_turn', stop_details: null },
  ];
  let i = 0;
  const client = {
    messages: {
      create: async () => textResponse(replies[i++]!),
    },
  } as unknown as Anthropic;
  const provider = createAnthropicProvider({ client });
  const ask = () =>
    provider.complete({
      model: 'claude-opus-5-5',
      maxTokens: 64,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    });

  const declined = await ask();
  assert.deepEqual(declined.refusal, { category: 'bio', explanation: 'declined' });
  // It is NOT an error and NOT a distinct finishReason — a caller that only
  // looks at finishReason sees a normal stop with empty content.
  assert.equal(declined.finishReason, 'stop');
  assert.equal(declined.providerFinishReason, 'refusal');

  const bare = await ask();
  assert.deepEqual(bare.refusal, {});
  assert.notEqual(bare.refusal, undefined);

  const normal = await ask();
  assert.equal(normal.refusal, undefined);
});

test('requiresEffortBeta matches only the Opus 4.5 family', () => {
  for (const model of ['claude-opus-4-5', 'claude-opus-4-5-20251101']) {
    assert.equal(requiresEffortBeta(model), true, `${model} lost its effort beta`);
  }
  for (const model of [
    'claude-opus-4-6',
    'claude-opus-4-8',
    'claude-opus-5',
    'claude-opus-5-5',
    'claude-sonnet-5',
    'claude-haiku-4-5',
    'claude-fable-5-1',
  ]) {
    assert.equal(requiresEffortBeta(model), false, `${model} gained a stale beta`);
  }
});

// ---------------------------------------------------------------------------
// #1207 — thinking blocks survive a tool loop
// ---------------------------------------------------------------------------

/** The two block shapes an always-thinking model emits. `signature` is what
 *  must arrive back unchanged, so the test compares by identity, not shape. */
const THINKING_BLOCK = {
  type: 'thinking',
  thinking: 'Erst die Rechnung prüfen, dann antworten.',
  signature: 'sig-abc',
};
const REDACTED_BLOCK = { type: 'redacted_thinking', data: 'enc-xyz' };

test('thinking/redacted blocks survive the neutral view and replay verbatim', async () => {
  const calls: Array<{ params: Record<string, unknown>; options: unknown }> = [];
  const client = {
    messages: {
      create: async (params: Record<string, unknown>, options?: unknown) => {
        calls.push({ params, options });
        return textResponse({
          model: 'claude-opus-5-5',
          content: [
            THINKING_BLOCK,
            REDACTED_BLOCK,
            { type: 'text', text: 'Jetzt der Toolaufruf' },
            { type: 'tool_use', id: 'tu_1', name: 'lookup', input: { q: 'x' } },
          ],
          stop_reason: 'tool_use',
        });
      },
    },
  } as unknown as Anthropic;
  const provider = createAnthropicProvider({ client });

  // Iteration 1: the model answers with thinking + text + a tool call.
  const first = await provider.complete({
    model: 'claude-opus-5-5',
    maxTokens: 1024,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Rechne' }] }],
  });
  assert.deepEqual(
    first.content.map((p) => p.type),
    ['reasoning', 'reasoning', 'text', 'tool_call'],
  );
  // The neutral view carries the block OPAQUELY — same object, not a copy with
  // a re-serialised signature.
  assert.equal(
    (first.content[0] as { raw: unknown }).raw,
    THINKING_BLOCK,
  );
  assert.equal((first.content[1] as { raw: unknown }).raw, REDACTED_BLOCK);
  // The first request carried no reasoning, so no thinking field and no beta.
  assert.equal(calls[0]?.params['thinking'], undefined);
  assert.equal(calls[0]?.options, undefined);

  // Iteration 2: the loop replays the assistant turn with its tool result.
  await provider.complete({
    model: 'claude-opus-5-5',
    maxTokens: 1024,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Rechne' }] },
      { role: 'assistant', content: first.content },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolCallId: 'tu_1', content: '42' },
          // A foreign provider's reasoning must never reach the Anthropic
          // wire — a replayed OpenAI block is not a valid Anthropic block.
          { type: 'reasoning', provider: 'openai', raw: { foreign: true } },
        ],
      },
    ],
  });
  const messages = calls[1]?.params['messages'] as Array<{
    content: Array<Record<string, unknown>>;
  }>;
  // Byte-for-byte, in the original order, ahead of the text and tool_use.
  assert.deepEqual(messages[1]?.content, [
    THINKING_BLOCK,
    REDACTED_BLOCK,
    { type: 'text', text: 'Jetzt der Toolaufruf' },
    { type: 'tool_use', id: 'tu_1', name: 'lookup', input: { q: 'x' } },
  ]);
  assert.equal(messages[1]?.content[0], THINKING_BLOCK);
  // The foreign reasoning part is gone, the tool_result is not.
  assert.deepEqual(messages[2]?.content, [
    { type: 'tool_result', tool_use_id: 'tu_1', content: '42' },
  ]);
  // Replaying blocks opts the request into the binding controls — and the
  // field is a 400 without its beta header, so the two go together.
  assert.deepEqual(calls[1]?.params['thinking'], {
    type: 'adaptive',
    block_binding: { prefix_mismatch_behavior: 'drop_block' },
  });
  assert.deepEqual(calls[1]?.options, {
    headers: { 'anthropic-beta': THINKING_BINDING_BETA },
  });
});

test('the thinking-binding beta is appended to a caller\'s betas exactly once', async () => {
  const calls: Array<{ params: Record<string, unknown>; options: unknown }> = [];
  const client = {
    messages: {
      create: async (params: Record<string, unknown>, options?: unknown) => {
        calls.push({ params, options });
        return textResponse();
      },
    },
  } as unknown as Anthropic;
  const provider = createAnthropicProvider({ client });
  const replay = (betas?: string[]) =>
    provider.complete({
      model: 'claude-opus-5-5',
      maxTokens: 64,
      ...(betas !== undefined ? { betas } : {}),
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', provider: 'anthropic', raw: THINKING_BLOCK },
          ],
        },
      ],
    });

  await replay(['context-management-2025-06-27']);
  assert.deepEqual(calls[0]?.options, {
    headers: {
      'anthropic-beta': `context-management-2025-06-27,${THINKING_BINDING_BETA}`,
    },
  });

  await replay([THINKING_BINDING_BETA]);
  assert.deepEqual(calls[1]?.options, {
    headers: { 'anthropic-beta': THINKING_BINDING_BETA },
  });

  // A request with no Anthropic reasoning keeps the untouched common path:
  // no thinking field (which would turn thinking ON for a model where it is
  // off by default) and no beta header.
  await provider.complete({
    model: 'claude-opus-4-8',
    maxTokens: 64,
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'reasoning', provider: 'openai', raw: { x: 1 } }],
      },
    ],
  });
  assert.equal(calls[2]?.params['thinking'], undefined);
  assert.equal(calls[2]?.options, undefined);
});

/** A response reporting that the API dropped a block it was sent. */
const DROPPED = {
  input_transformations: [
    {
      type: 'thinking_block_dropped',
      path: 'messages.1.content.0',
      reason: 'prefix_binding_mismatch',
    },
    { type: 'thinking_block_dropped', path: 'messages.3.content.0', reason: 'model_binding_mismatch' },
  ],
};

/** Both request paths must report a drop — a replay runs through whichever of
 *  the two the caller picked, and a silent drop is reasoning lost for good. */
for (const path of ['complete', 'stream'] as const) {
  test(`a dropped replayed block is logged on the ${path} path`, async () => {
    const logged: string[] = [];
    const final = textResponse(DROPPED);
    const fakeStream = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'message_stop' };
      },
      finalMessage: async () => final,
    };
    const client = {
      messages: {
        create: async () => final,
        stream: () => fakeStream,
      },
    } as unknown as Anthropic;
    const provider = createAnthropicProvider({
      client,
      log: (...args: unknown[]) => logged.push(args.map(String).join(' ')),
    });
    const req = {
      model: 'claude-opus-5-5',
      maxTokens: 64,
      messages: [
        {
          role: 'assistant' as const,
          content: [
            { type: 'reasoning' as const, provider: 'anthropic', raw: THINKING_BLOCK },
          ],
        },
      ],
    };

    if (path === 'complete') {
      await provider.complete(req);
    } else {
      for await (const _ of provider.stream(req)) {
        // drain
      }
    }

    assert.ok(
      logged.some(
        (line) =>
          // Reported, not interpreted: the count and the vendor's own reasons,
          // with no claim about WHAT was dropped (later checks add types).
          line.includes('dropped 2 replayed block(s)') &&
          line.includes('prefix_binding_mismatch,model_binding_mismatch'),
      ),
      `no drop logged on ${path}: ${logged.join(' | ')}`,
    );
  });
}
