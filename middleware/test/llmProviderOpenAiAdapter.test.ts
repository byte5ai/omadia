/**
 * Contract tests for the OpenAI adapter of `@omadia/llm-provider`
 * (docs/plans/llm-provider-interface-plan.md, phase 3). The adapter must map the
 * neutral DTOs to/from the OpenAI Chat Completions wire shapes — the same neutral
 * contract the Anthropic adapter satisfies — covering tool round-trips,
 * finishReason normalisation, usage (incl. cached tokens), vision, the
 * tool_result → `role:'tool'` fan-out, structured-system join, streaming
 * (text + tool deltas), mid-stream throw, and the retry taxonomy.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type OpenAI from 'openai';
import { APIConnectionError, APIConnectionTimeoutError } from 'openai';

import {
  classifyOpenAiError,
  collectText,
  createOpenAiProvider,
  toolCalls,
  type LlmStreamEvent,
} from '@omadia/llm-provider';

interface Captured {
  params?: Record<string, unknown>;
}

function completion(overrides: Record<string, unknown> = {}) {
  return {
    id: 'chatcmpl_test',
    object: 'chat.completion',
    created: 0,
    model: 'gpt-4.1',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'Hallo Welt', refusal: null },
      },
    ],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 10 },
    },
    ...overrides,
  };
}

function mockClient(
  captured: Captured,
  response: Record<string, unknown>,
): OpenAI {
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

function streamClient(
  captured: Captured,
  makeChunks: () => AsyncGenerator<Record<string, unknown>>,
): OpenAI {
  return {
    chat: {
      completions: {
        create: async (params: Record<string, unknown>) => {
          captured.params = params;
          return {
            [Symbol.asyncIterator]: () => makeChunks(),
          };
        },
      },
    },
  } as unknown as OpenAI;
}

test('complete() maps a text response to neutral content + usage', async () => {
  const captured: Captured = {};
  const provider = createOpenAiProvider({
    client: mockClient(captured, completion()),
  });

  const res = await provider.complete({
    model: 'gpt-4.1',
    maxTokens: 512,
    system: 'Sei knapp.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  });

  assert.equal(collectText(res.content), 'Hallo Welt');
  assert.equal(res.finishReason, 'stop');
  assert.equal(res.providerFinishReason, 'stop');
  assert.equal(res.model, 'gpt-4.1');
  assert.deepEqual(res.usage, {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 10,
  });
  assert.equal(captured.params?.['model'], 'gpt-4.1');
  assert.equal(captured.params?.['max_tokens'], 512);
  const messages = captured.params?.['messages'] as Array<Record<string, unknown>>;
  assert.deepEqual(messages[0], { role: 'system', content: 'Sei knapp.' });
  assert.deepEqual(messages[1], { role: 'user', content: 'Hi' });
});

test('complete() maps tool_calls to tool_calls finishReason + parsed ToolCallPart', async () => {
  const provider = createOpenAiProvider({
    client: mockClient(
      {},
      completion({
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              refusal: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'lookup', arguments: '{"q":"x"}' },
                },
              ],
            },
          },
        ],
      }),
    ),
  });

  const res = await provider.complete({
    model: 'gpt-4.1',
    maxTokens: 512,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  });

  assert.equal(res.finishReason, 'tool_calls');
  const calls = toolCalls(res.content);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    type: 'tool_call',
    id: 'call_1',
    name: 'lookup',
    input: { q: 'x' },
  });
});

test('complete() forces tool_calls finishReason even if server reports stop', async () => {
  // Some OpenAI-compatible servers emit finish_reason:'stop' alongside tool
  // calls; the orchestrator loop keys off finishReason, so we normalise.
  const provider = createOpenAiProvider({
    client: mockClient(
      {},
      completion({
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: null,
              refusal: null,
              tool_calls: [
                {
                  id: 'call_9',
                  type: 'function',
                  function: { name: 'a', arguments: '{}' },
                },
              ],
            },
          },
        ],
      }),
    ),
  });
  const res = await provider.complete({
    model: 'gpt-4.1',
    maxTokens: 64,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  });
  assert.equal(res.finishReason, 'tool_calls');
  assert.equal(res.providerFinishReason, 'stop');
});

test('complete() maps finish_reason length to max_tokens (truncation)', async () => {
  const provider = createOpenAiProvider({
    client: mockClient(
      {},
      completion({
        choices: [
          {
            index: 0,
            finish_reason: 'length',
            message: { role: 'assistant', content: 'abrupt', refusal: null },
          },
        ],
      }),
    ),
  });
  const res = await provider.complete({
    model: 'gpt-4.1',
    maxTokens: 8,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  });
  assert.equal(res.finishReason, 'max_tokens');
  assert.equal(res.providerFinishReason, 'length');
});

test('request mapping: image (vision), tool_result → role:tool, system blocks, toolChoice, parallel', async () => {
  const captured: Captured = {};
  const provider = createOpenAiProvider({
    client: mockClient(captured, completion()),
  });

  await provider.complete({
    model: 'gpt-4.1',
    maxTokens: 256,
    // structured system blocks are joined into one system message
    system: [
      { text: 'stable domain prompt', cache: true },
      { text: 'per-turn date header' },
    ],
    cacheHints: { system: true, tools: true }, // ignored by OpenAI
    betas: ['context-management-2025-06-27'], // ignored by OpenAI
    tools: [
      { name: 'a', description: 'A', inputSchema: { type: 'object' } },
      { name: 'b', description: 'B', inputSchema: { type: 'object' } },
    ],
    toolChoice: { type: 'required', disableParallel: true },
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
        content: [{ type: 'tool_call', id: 'call_9', name: 'a', input: {} }],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolCallId: 'call_9', content: 'ok' },
        ],
      },
    ],
  });

  const p = captured.params as Record<string, unknown>;
  // betas / cacheHints never leak into OpenAI params
  assert.equal(p['betas'], undefined);
  assert.equal(p['cache_control'], undefined);
  const messages = p['messages'] as Array<Record<string, unknown>>;
  // system blocks joined with a blank line
  assert.deepEqual(messages[0], {
    role: 'system',
    content: 'stable domain prompt\n\nper-turn date header',
  });
  // user message with image → structured content with a data-URL image_url
  assert.deepEqual(messages[1], {
    role: 'user',
    content: [
      { type: 'text', text: 'Bild:' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aGk=' } },
    ],
  });
  // assistant tool_call → tool_calls with JSON-string arguments, content null
  assert.deepEqual(messages[2], {
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: 'call_9', type: 'function', function: { name: 'a', arguments: '{}' } },
    ],
  });
  // tool_result fans out to its own role:'tool' message
  assert.deepEqual(messages[3], {
    role: 'tool',
    tool_call_id: 'call_9',
    content: 'ok',
  });
  // tools → function specs (no strict by default)
  const tools = p['tools'] as Array<Record<string, unknown>>;
  assert.deepEqual(tools[0], {
    type: 'function',
    function: { name: 'a', description: 'A', parameters: { type: 'object' } },
  });
  // toolChoice required, disableParallel → top-level parallel_tool_calls:false
  assert.equal(p['tool_choice'], 'required');
  assert.equal(p['parallel_tool_calls'], false);
});

test('request mapping: forced single tool → named function tool_choice', async () => {
  const captured: Captured = {};
  const provider = createOpenAiProvider({
    client: mockClient(captured, completion()),
  });
  await provider.complete({
    model: 'gpt-4.1',
    maxTokens: 64,
    tools: [{ name: 'a', description: 'A', inputSchema: { type: 'object' } }],
    toolChoice: { type: 'tool', name: 'a' },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  });
  assert.deepEqual(
    (captured.params as Record<string, unknown>)['tool_choice'],
    { type: 'function', function: { name: 'a' } },
  );
});

test('tool_result with an image part is rejected, never silently dropped', async () => {
  const provider = createOpenAiProvider({ client: mockClient({}, completion()) });
  await assert.rejects(
    () =>
      provider.complete({
        model: 'gpt-4.1',
        maxTokens: 64,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                toolCallId: 'call_1',
                content: [
                  { type: 'text', text: 'see image' },
                  { type: 'image', mediaType: 'image/png', data: 'aGk=' },
                ],
              },
            ],
          },
        ],
      }),
    /text-only/,
  );
});

test('complete() omits system message when no system is given', async () => {
  const captured: Captured = {};
  const provider = createOpenAiProvider({ client: mockClient(captured, completion()) });
  await provider.complete({
    model: 'gpt-4.1',
    maxTokens: 64,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  });
  const messages = (captured.params as Record<string, unknown>)['messages'] as Array<
    Record<string, unknown>
  >;
  assert.equal(messages[0]?.['role'], 'user');
});

test('strictTools emits function.strict on tool schemas', async () => {
  const captured: Captured = {};
  const provider = createOpenAiProvider({
    client: mockClient(captured, completion()),
    strictTools: true,
  });
  await provider.complete({
    model: 'gpt-4.1',
    maxTokens: 64,
    tools: [{ name: 'a', description: 'A', inputSchema: { type: 'object' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  });
  const tools = (captured.params as Record<string, unknown>)['tools'] as Array<{
    function: Record<string, unknown>;
  }>;
  assert.equal(tools[0]?.function['strict'], true);
});

test('stream() yields text deltas, requests usage, then a final response', async () => {
  const captured: Captured = {};
  const provider = createOpenAiProvider({
    client: streamClient(captured, async function* () {
      yield {
        model: 'gpt-4.1',
        choices: [{ index: 0, delta: { content: 'Hal' }, finish_reason: null }],
      };
      yield {
        model: 'gpt-4.1',
        choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: 'stop' }],
      };
      // trailing usage-only chunk (stream_options.include_usage)
      yield {
        model: 'gpt-4.1',
        choices: [],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      };
    }),
  });

  const seen: LlmStreamEvent[] = [];
  for await (const ev of provider.stream({
    model: 'gpt-4.1',
    maxTokens: 64,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  })) {
    seen.push(ev);
  }

  assert.deepEqual(seen.slice(0, 2), [
    { type: 'text_delta', text: 'Hal' },
    { type: 'text_delta', text: 'lo' },
  ]);
  // include_usage was requested
  assert.deepEqual(
    (captured.params as Record<string, unknown>)['stream_options'],
    { include_usage: true },
  );
  const final = seen.at(-1);
  assert.equal(final?.type, 'final');
  if (final?.type === 'final') {
    assert.equal(collectText(final.response.content), 'Hallo');
    assert.equal(final.response.finishReason, 'stop');
    assert.deepEqual(final.response.usage, { inputTokens: 5, outputTokens: 2 });
  }
});

test('stream() accumulates tool-call deltas into a final ToolCallPart', async () => {
  const provider = createOpenAiProvider({
    client: streamClient({}, async function* () {
      yield {
        model: 'gpt-4.1',
        choices: [{ index: 0, delta: { content: 'Moment.' }, finish_reason: null }],
      };
      // tool call opens with id+name, then streams its JSON arguments
      yield {
        model: 'gpt-4.1',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '' } },
              ],
            },
            finish_reason: null,
          },
        ],
      };
      yield {
        model: 'gpt-4.1',
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] },
            finish_reason: null,
          },
        ],
      };
      yield {
        model: 'gpt-4.1',
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] },
            finish_reason: 'tool_calls',
          },
        ],
      };
    }),
  });

  const seen: LlmStreamEvent[] = [];
  for await (const ev of provider.stream({
    model: 'gpt-4.1',
    maxTokens: 64,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  })) {
    seen.push(ev);
  }

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
    assert.deepEqual(calls[0], {
      type: 'tool_call',
      id: 'call_1',
      name: 'lookup',
      input: { q: 'x' },
    });
  }
});

test('stream() rethrows mid-stream errors to the caller', async () => {
  const midStreamError = Object.assign(new Error('connection reset'), {
    status: 503,
  });
  const provider = createOpenAiProvider({
    client: streamClient({}, async function* () {
      yield {
        model: 'gpt-4.1',
        choices: [{ index: 0, delta: { content: 'Hal' }, finish_reason: null }],
      };
      throw midStreamError;
    }),
  });

  const seen: LlmStreamEvent[] = [];
  await assert.rejects(async () => {
    for await (const ev of provider.stream({
      model: 'gpt-4.1',
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
    kind: 'other',
  });
});

test('classifyOpenAiError covers the retry taxonomy', () => {
  assert.deepEqual(classifyOpenAiError({ status: 429 }), {
    retryable: true,
    kind: 'rate_limit',
  });
  assert.deepEqual(classifyOpenAiError({ code: 'rate_limit_exceeded' }), {
    retryable: true,
    kind: 'rate_limit',
  });
  assert.deepEqual(classifyOpenAiError({ status: 401 }), {
    retryable: false,
    kind: 'auth',
  });
  assert.deepEqual(classifyOpenAiError({ status: 403 }), {
    retryable: false,
    kind: 'auth',
  });
  assert.deepEqual(classifyOpenAiError({ status: 500 }), {
    retryable: true,
    kind: 'other',
  });
  assert.deepEqual(classifyOpenAiError({ status: 503 }), {
    retryable: true,
    kind: 'other',
  });
  assert.deepEqual(classifyOpenAiError(new Error('boom')), {
    retryable: false,
    kind: 'other',
  });
});

test('classifyOpenAiError treats real SDK connection/timeout errors as retryable', () => {
  // The OpenAI SDK leaves .name === 'Error' and status/code undefined on these,
  // stashing the underlying socket error on .cause — classify by instanceof + cause.
  const conn = new APIConnectionError({
    message: 'Connection error.',
    cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
  });
  assert.deepEqual(classifyOpenAiError(conn), { retryable: true, kind: 'other' });

  const timeout = new APIConnectionTimeoutError({ message: 'Request timed out.' });
  assert.equal(classifyOpenAiError(timeout).retryable, true);

  // a non-SDK error whose cause carries a retryable socket errno
  assert.equal(
    classifyOpenAiError({ cause: { code: 'ETIMEDOUT' } }).retryable,
    true,
  );
  // an unrelated cause errno is not retryable
  assert.equal(
    classifyOpenAiError({ cause: { code: 'ERR_INVALID_ARG' } }).retryable,
    false,
  );
});

test('id + capabilities: native default vs openai-compatible baseURL', () => {
  const native = createOpenAiProvider({ apiKey: 'sk-x' });
  assert.equal(native.id, 'openai');
  assert.equal(native.capabilities.promptCaching, false);
  assert.equal(native.capabilities.tools, true);

  const compat = createOpenAiProvider({
    apiKey: 'x',
    baseURL: 'http://localhost:11434/v1',
    capabilities: { vision: false, forcedToolChoice: false },
  });
  assert.equal(compat.id, 'openai-compatible');
  assert.equal(compat.capabilities.vision, false);
  assert.equal(compat.capabilities.forcedToolChoice, false);
  // unspecified capabilities fall back to the OpenAI defaults
  assert.equal(compat.capabilities.streaming, true);
});

test('complete() surfaces a refusal as text when content is null', async () => {
  const provider = createOpenAiProvider({
    client: mockClient(
      {},
      completion({
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: null,
              refusal: 'I cannot help with that.',
            },
          },
        ],
      }),
    ),
  });
  const res = await provider.complete({
    model: 'gpt-4.1',
    maxTokens: 64,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  });
  assert.equal(collectText(res.content), 'I cannot help with that.');
  assert.equal(res.finishReason, 'stop');
});

test('complete() preserves content_filter as providerFinishReason', async () => {
  const provider = createOpenAiProvider({
    client: mockClient(
      {},
      completion({
        choices: [
          {
            index: 0,
            finish_reason: 'content_filter',
            message: { role: 'assistant', content: 'partial', refusal: null },
          },
        ],
      }),
    ),
  });
  const res = await provider.complete({
    model: 'gpt-4.1',
    maxTokens: 64,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  });
  // the neutral enum has no 'content_filter'; it collapses to 'stop' but the
  // raw value survives for callers that need to detect the block.
  assert.equal(res.finishReason, 'stop');
  assert.equal(res.providerFinishReason, 'content_filter');
});

test('complete() throws on an empty choices array', async () => {
  const provider = createOpenAiProvider({
    client: mockClient({}, completion({ choices: [] })),
  });
  await assert.rejects(
    () =>
      provider.complete({
        model: 'gpt-4.1',
        maxTokens: 64,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      }),
    /no choices/,
  );
});

test('request mapping: tool_choice without tools is dropped (not forwarded as invalid)', async () => {
  const captured: Captured = {};
  const provider = createOpenAiProvider({ client: mockClient(captured, completion()) });
  await provider.complete({
    model: 'gpt-4.1',
    maxTokens: 64,
    toolChoice: { type: 'required' }, // no tools → OpenAI would reject this
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  });
  const p = captured.params as Record<string, unknown>;
  assert.equal(p['tool_choice'], undefined);
  assert.equal(p['parallel_tool_calls'], undefined);
});

test('stream() tolerates a trailing usage chunk with no choices key', async () => {
  const provider = createOpenAiProvider({
    client: streamClient({}, async function* () {
      yield {
        model: 'gpt-4.1',
        choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: 'stop' }],
      };
      // OpenAI-compatible servers often omit `choices` entirely on the usage chunk.
      yield { model: 'gpt-4.1', usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } };
    }),
  });
  const seen: LlmStreamEvent[] = [];
  for await (const ev of provider.stream({
    model: 'gpt-4.1',
    maxTokens: 64,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  })) {
    seen.push(ev);
  }
  const final = seen.at(-1);
  assert.equal(final?.type, 'final');
  if (final?.type === 'final') {
    assert.equal(collectText(final.response.content), 'Hi');
    assert.deepEqual(final.response.usage, { inputTokens: 3, outputTokens: 1 });
  }
});

test('stream() accumulates parallel tool calls (index 0 and 1)', async () => {
  const provider = createOpenAiProvider({
    client: streamClient({}, async function* () {
      yield {
        model: 'gpt-4.1',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'call_a', type: 'function', function: { name: 'a', arguments: '{}' } },
                { index: 1, id: 'call_b', type: 'function', function: { name: 'b', arguments: '{}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      };
    }),
  });
  const seen: LlmStreamEvent[] = [];
  for await (const ev of provider.stream({
    model: 'gpt-4.1',
    maxTokens: 64,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  })) {
    seen.push(ev);
  }
  // exactly one tool_use_start per distinct index
  assert.equal(seen.filter((e) => e.type === 'tool_use_start').length, 2);
  const final = seen.at(-1);
  if (final?.type === 'final') {
    const calls = toolCalls(final.response.content);
    assert.deepEqual(
      calls.map((c) => [c.id, c.name]),
      [
        ['call_a', 'a'],
        ['call_b', 'b'],
      ],
    );
  }
});

test('createOpenAiProvider requires a client or apiKey', () => {
  assert.throws(() => createOpenAiProvider({}), /client.*apiKey|apiKey.*client/);
});
