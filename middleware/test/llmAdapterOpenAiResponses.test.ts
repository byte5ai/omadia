/**
 * OpenAI Responses (SSE) adapter (#294) — SSE parsing + stream/complete mapping,
 * tool calls, header/body invariants, error classification. No live network: an
 * injected fetch returns a canned SSE ReadableStream.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  createOpenAiResponsesProvider,
  ResponsesHttpError,
  SseParser,
} from '../packages/llm-adapter-openai-responses/dist/index.js';
import type { LlmRequest } from '@omadia/llm-provider-api';

/** Build a fetch double that streams the given raw SSE text, chunked at `every`
 *  characters to exercise the parser's cross-chunk frame handling. */
function sseFetch(
  raw: string,
  opts: { status?: number; every?: number; captured?: { init?: RequestInit } } = {},
): typeof fetch {
  const status = opts.status ?? 200;
  const every = opts.every ?? 7;
  return (async (_url: string, init: RequestInit) => {
    if (opts.captured) opts.captured.init = init;
    if (status >= 400) {
      return {
        ok: false,
        status,
        body: {},
        text: async () => 'boom',
      } as unknown as Response;
    }
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < raw.length; i += every) {
          controller.enqueue(encoder.encode(raw.slice(i, i + every)));
        }
        controller.close();
      },
    });
    return { ok: true, status, body: stream } as unknown as Response;
  }) as unknown as typeof fetch;
}

const REQ: LlmRequest = {
  model: 'gpt-5.4',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  maxTokens: 64,
};

describe('SseParser', () => {
  it('reassembles events split across chunks', () => {
    const p = new SseParser();
    const events = [
      ...p.push('event: a\ndata: {"x":'),
      ...p.push('1}\n\nevent: b\nda'),
      ...p.push('ta: hello\n\n'),
    ];
    assert.deepEqual(events, [
      { event: 'a', data: '{"x":1}' },
      { event: 'b', data: 'hello' },
    ]);
  });
});

describe('openai-responses provider — text', () => {
  it('streams text deltas and aggregates a final response with usage', async () => {
    const raw =
      'event: response.created\ndata: {}\n\n' +
      'event: response.output_text.delta\ndata: {"delta":"Hel"}\n\n' +
      'event: response.output_text.delta\ndata: {"delta":"lo"}\n\n' +
      'event: response.completed\ndata: {"response":{"status":"completed","model":"gpt-5.4","usage":{"input_tokens":3,"output_tokens":2},"output":[{"type":"message","content":[{"type":"output_text","text":"Hello"}]}]}}\n\n';
    const provider = createOpenAiResponsesProvider({
      baseURL: 'https://x/codex',
      apiKey: 'tok',
      fetchImpl: sseFetch(raw),
    });

    const deltas: string[] = [];
    let final;
    for await (const evt of provider.stream(REQ)) {
      if (evt.type === 'text_delta') deltas.push(evt.text);
      if (evt.type === 'final') final = evt.response;
    }
    assert.deepEqual(deltas, ['Hel', 'lo']);
    assert.equal(final?.finishReason, 'stop');
    assert.equal(final?.content[0]?.type, 'text');
    assert.equal(final?.usage.inputTokens, 3);
    assert.equal(final?.usage.outputTokens, 2);

    const completed = await provider.complete(REQ);
    assert.equal(completed.model, 'gpt-5.4');
  });
});

describe('openai-responses provider — tools', () => {
  it('maps a function call to a tool_call with parsed input and tool_calls finish', async () => {
    const raw =
      'event: response.output_item.added\ndata: {"item":{"type":"function_call"}}\n\n' +
      'event: response.function_call_arguments.delta\ndata: {"delta":"{\\"city\\":"}\n\n' +
      'event: response.completed\ndata: {"response":{"status":"completed","output":[{"type":"function_call","call_id":"c1","name":"get_weather","arguments":"{\\"city\\":\\"Berlin\\"}"}]}}\n\n';
    const provider = createOpenAiResponsesProvider({
      baseURL: 'https://x/codex',
      apiKey: 'tok',
      fetchImpl: sseFetch(raw),
    });
    let sawToolStart = false;
    let final;
    for await (const evt of provider.stream(REQ)) {
      if (evt.type === 'tool_use_start') sawToolStart = true;
      if (evt.type === 'final') final = evt.response;
    }
    assert.equal(sawToolStart, true);
    assert.equal(final?.finishReason, 'tool_calls');
    const call = final?.content.find((c) => c.type === 'tool_call');
    assert.ok(call && call.type === 'tool_call');
    assert.equal(call.name, 'get_weather');
    assert.deepEqual(call.input, { city: 'Berlin' });
  });
});

describe('openai-responses provider — request invariants', () => {
  it('forces stream+store and sends the experimental headers + bearer', async () => {
    const captured: { init?: RequestInit } = {};
    const raw =
      'event: response.completed\ndata: {"response":{"status":"completed","output":[]}}\n\n';
    const provider = createOpenAiResponsesProvider({
      baseURL: 'https://x/codex',
      bearerProvider: async () => 'live-bearer',
      fetchImpl: sseFetch(raw, { captured }),
    });
    await provider.complete({
      ...REQ,
      system: 'be terse',
      tools: [
        {
          name: 'get_weather',
          description: 'w',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      toolChoice: { type: 'tool', name: 'get_weather' },
    });
    const headers = captured.init?.headers as Record<string, string>;
    assert.equal(headers['authorization'], 'Bearer live-bearer');
    assert.equal(headers['openai-beta'], 'responses=experimental');
    assert.ok(headers['session_id']);
    const body = JSON.parse(captured.init?.body as string);
    assert.equal(body.stream, true);
    assert.equal(body.store, false);
    assert.equal(body.instructions, 'be terse');
    assert.deepEqual(body.tool_choice, { type: 'function', name: 'get_weather' });
    assert.equal(body.tools[0].name, 'get_weather');
  });
});

describe('openai-responses provider — errors', () => {
  it('throws ResponsesHttpError and classifies 401 as non-retryable auth', async () => {
    const provider = createOpenAiResponsesProvider({
      baseURL: 'https://x/codex',
      apiKey: 'tok',
      fetchImpl: sseFetch('', { status: 401 }),
    });
    await assert.rejects(() => provider.complete(REQ), ResponsesHttpError);
    assert.deepEqual(provider.classifyError(new ResponsesHttpError(401, '')), {
      retryable: false,
      kind: 'auth',
    });
    assert.deepEqual(provider.classifyError(new ResponsesHttpError(429, '')), {
      retryable: true,
      kind: 'rate_limit',
    });
  });

  it('throws when the stream ends without response.completed', async () => {
    const provider = createOpenAiResponsesProvider({
      baseURL: 'https://x/codex',
      apiKey: 'tok',
      fetchImpl: sseFetch('event: response.created\ndata: {}\n\n'),
    });
    await assert.rejects(() => provider.complete(REQ), /without response.completed/);
  });
});
