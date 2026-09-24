import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { LlmProvider, LlmRequest, LlmResponse, LlmStreamEvent } from '@omadia/llm-provider';
import type { ChatStreamEvent } from '@omadia/channel-sdk';
import { NativeToolRegistry, Orchestrator } from '@omadia/orchestrator';

/**
 * Issue #1095 — a REJECTED tool dispatch must settle its slot, not kill the turn.
 *
 * The two tool-loop paths used to disagree. The non-streaming path folds a
 * rejection into a normal `Error: <message>` tool result via `Promise.allSettled`,
 * so the model sees the error and the turn continues. The streaming path put the
 * bare dispatch promise on the slot and awaited `Promise.race([...slots, tick])`,
 * so the FIRST rejection escaped the async generator and aborted the whole turn:
 * sibling tools never settled, their already-streamed `tool_use` never got a
 * `tool_result`, and — when an earlier tool had committed — issue #506's
 * emergency branch reported the dead turn to the caller as a SUCCESS.
 *
 * These are the fences around the fix. Note the raw exception message is asserted
 * verbatim: that is deliberate and mirrors the chat path's W4 fence in
 * `chatPathToolErrorText.test.ts` — the operator debugging their own tool needs the
 * driver's real message, so the streaming catch must not mask or digest it either.
 */

const usage = {
  inputTokens: 50,
  outputTokens: 4,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
} as const;

const providerCapabilities = {
  tools: true,
  vision: true,
  streaming: true,
  promptCaching: true,
  forcedToolChoice: true,
  parallelToolCalls: true,
} as const;

/** The exact shape of a Postgres driver error escaping a tool handler — the
 *  concrete trigger reported in the issue (`query_dataset` + `get_schema`). */
const PG_MESSAGE = 'invalid input syntax for type uuid: "ds_00000000-0000-0000-0000-000000000000"';

function toolCallResponse(
  toolUses: ReadonlyArray<{ id: string; name: string; input: unknown }>,
): LlmResponse {
  return {
    content: toolUses.map((u) => ({
      type: 'tool_call',
      id: u.id,
      name: u.name,
      input: u.input,
    })),
    finishReason: 'tool_calls',
    providerFinishReason: 'tool_use',
    model: 'test',
    usage,
  } as unknown as LlmResponse;
}

function textResponse(text: string): LlmResponse {
  return {
    content: [{ type: 'text', text }],
    finishReason: 'stop',
    providerFinishReason: 'end_turn',
    model: 'test',
    usage,
  } as unknown as LlmResponse;
}

/** Streams the scripted responses and records every message list handed to the
 *  provider, so the tool_result the MODEL saw can be inspected directly. */
function recordingStreamProvider(responses: readonly LlmResponse[]): {
  provider: LlmProvider;
  seen: unknown[][];
} {
  const seen: unknown[][] = [];
  let idx = 0;
  const provider = {
    id: 'anthropic',
    capabilities: providerCapabilities,
    complete: (request: { messages?: unknown[] }): Promise<LlmResponse> => {
      seen.push(request.messages ?? []);
      const response = responses[idx];
      idx += 1;
      if (!response) throw new Error('recordingStreamProvider: no scripted response left');
      return Promise.resolve(response);
    },
    stream: (request: { messages?: unknown[] }): AsyncIterable<LlmStreamEvent> => {
      seen.push(request.messages ?? []);
      const response = responses[idx];
      idx += 1;
      if (!response) throw new Error('recordingStreamProvider: no scripted response left');
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'final', response } as LlmStreamEvent;
        },
      };
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  };
  return { provider: provider as unknown as LlmProvider, seen };
}

const minimalSpec = (name: string): Record<string, unknown> => ({
  name,
  description: `${name} for testing`,
  input_schema: { type: 'object' as const, properties: {}, required: [] },
});

function registryWith(
  tools: ReadonlyArray<{ name: string; handler: () => Promise<string> }>,
): NativeToolRegistry {
  const registry = new NativeToolRegistry();
  for (const tool of tools) {
    registry.register(tool.name, {
      handler: tool.handler,
      spec: minimalSpec(tool.name) as never,
    });
  }
  return registry;
}

function buildOrchestrator(provider: LlmProvider, registry: NativeToolRegistry): Orchestrator {
  return new Orchestrator({
    provider,
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 5,
    domainTools: [],
    nativeToolRegistry: registry,
  });
}

/** Every `tool_result` content string the model was handed across all calls. */
function toolResultTexts(messages: readonly unknown[][]): string[] {
  const out: string[] = [];
  for (const list of messages) {
    for (const message of list) {
      const content = (message as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        const b = block as { type?: string; content?: unknown };
        if (b.type === 'tool_result' && typeof b.content === 'string') out.push(b.content);
      }
    }
  }
  return out;
}

async function collect(stream: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = [];
  for await (const ev of stream) events.push(ev);
  return events;
}

describe('Issue #1095 — streaming path: a rejected tool dispatch settles its slot', () => {
  it('yields an `Error:` tool_result and finishes the turn normally', async () => {
    const registry = registryWith([
      {
        name: 'throwing_tool',
        handler: () => Promise.reject(new Error(PG_MESSAGE)),
      },
    ]);
    const { provider, seen } = recordingStreamProvider([
      toolCallResponse([{ id: 'use-1', name: 'throwing_tool', input: {} }]),
      textResponse('recovered'),
    ]);

    const events = await collect(
      buildOrchestrator(provider, registry).chatStream({ userMessage: 'go' }),
    );

    const results = events.filter((e) => e.type === 'tool_result');
    assert.equal(results.length, 1, 'the rejected slot must still yield a tool_result');
    const result = results[0];
    assert.ok(result?.type === 'tool_result');
    assert.equal(result.id, 'use-1');
    assert.equal(result.isError, true);
    assert.equal(result.output, `Error: ${PG_MESSAGE}`);

    // The model gets the error back, verbatim, and can react to it.
    assert.ok(
      toolResultTexts(seen).includes(`Error: ${PG_MESSAGE}`),
      `model must receive the raw error text; saw ${JSON.stringify(toolResultTexts(seen))}`,
    );

    const done = events.find((e) => e.type === 'done');
    assert.ok(done?.type === 'done', 'the turn must finish with a done event');
    assert.ok(
      done.answer.startsWith('recovered'),
      `expected the model's own answer, got ${JSON.stringify(done.answer)}`,
    );
    assert.equal(
      events.some((e) => e.type === 'error'),
      false,
      'a tool-level failure is not a turn-level error',
    );
  });

  it('lets sibling tools in the same iteration finish', async () => {
    const registry = registryWith([
      {
        name: 'throwing_tool',
        handler: async (): Promise<string> => {
          await new Promise((r) => setTimeout(r, 10));
          throw new Error('boom');
        },
      },
      {
        name: 'slow_ok_tool',
        handler: async (): Promise<string> => {
          await new Promise((r) => setTimeout(r, 80));
          return 'slow-ok-output';
        },
      },
    ]);
    const { provider } = recordingStreamProvider([
      toolCallResponse([
        { id: 'use-throw', name: 'throwing_tool', input: {} },
        { id: 'use-ok', name: 'slow_ok_tool', input: {} },
      ]),
      textResponse('both handled'),
    ]);

    const events = await collect(
      buildOrchestrator(provider, registry).chatStream({ userMessage: 'go' }),
    );

    const results = events.filter((e) => e.type === 'tool_result');
    assert.equal(results.length, 2, 'both slots must settle');
    const byId = new Map(results.map((e) => [e.type === 'tool_result' ? e.id : '', e]));
    const failed = byId.get('use-throw');
    const ok = byId.get('use-ok');
    assert.ok(failed?.type === 'tool_result' && ok?.type === 'tool_result');
    assert.equal(failed.isError, true);
    assert.equal(failed.output, 'Error: boom');
    assert.equal(ok.isError, false);
    assert.equal(ok.output, 'slow-ok-output');
  });

  it('does not report the #506 pseudo-success for a tool-level failure', async () => {
    // A tool COMMITS in iteration 0, then a tool throws in iteration 1. Before
    // the fix the throw hit the turn's catch with `committedToolNames` non-empty,
    // so the caller got a fabricated `done` claiming success. Now the rejection
    // never reaches that branch at all.
    const registry = registryWith([
      { name: 'committing_tool', handler: () => Promise.resolve('committed') },
      { name: 'throwing_tool', handler: () => Promise.reject(new Error(PG_MESSAGE)) },
    ]);
    const { provider } = recordingStreamProvider([
      toolCallResponse([{ id: 'use-commit', name: 'committing_tool', input: {} }]),
      toolCallResponse([{ id: 'use-throw', name: 'throwing_tool', input: {} }]),
      textResponse('real answer'),
    ]);

    const events = await collect(
      buildOrchestrator(provider, registry).chatStream({ userMessage: 'go' }),
    );

    const done = events.find((e) => e.type === 'done');
    assert.ok(done?.type === 'done');
    assert.ok(
      done.answer.startsWith('real answer'),
      `expected the model's own answer, got ${JSON.stringify(done.answer)}`,
    );
    assert.ok(
      !done.answer.includes('could not finish generating a follow-up response'),
      'the emergency #506 wording must not stand in for a recoverable tool error',
    );
    assert.equal(
      events.filter((e) => e.type === 'tool_result').length,
      2,
      'both iterations must have streamed their tool_result',
    );
  });

  it('regression: the non-streaming path keeps its allSettled behaviour', async () => {
    const registry = registryWith([
      { name: 'throwing_tool', handler: () => Promise.reject(new Error(PG_MESSAGE)) },
    ]);
    const { provider, seen } = recordingStreamProvider([
      toolCallResponse([{ id: 'use-1', name: 'throwing_tool', input: {} }]),
      textResponse('recovered'),
    ]);

    const answer = await buildOrchestrator(provider, registry).chat({
      userMessage: 'go',
    });

    assert.ok(
      answer.text.startsWith('recovered'),
      `expected the model's own answer, got ${JSON.stringify(answer.text)}`,
    );
    assert.ok(
      toolResultTexts(seen).includes(`Error: ${PG_MESSAGE}`),
      `model must receive the raw error text; saw ${JSON.stringify(toolResultTexts(seen))}`,
    );
  });
});
