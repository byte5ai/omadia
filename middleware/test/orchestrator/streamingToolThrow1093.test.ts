import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
} from '@omadia/llm-provider';
import type { ChatStreamEvent } from '@omadia/channel-sdk';
import { NativeToolRegistry, Orchestrator } from '@omadia/orchestrator';

/** A scripted stream: the ordered neutral `LlmStreamEvent`s the fake provider
 *  yields for one `stream()` call. The terminal `final` event carries the full
 *  `LlmResponse` (no `finalMessage()` on the neutral contract). */
interface ScriptedStream {
  events: LlmStreamEvent[];
}

const providerCapabilities = {
  tools: true,
  vision: true,
  streaming: true,
  promptCaching: true,
  forcedToolChoice: true,
  parallelToolCalls: true,
} as const;

function fakeStreamProvider(streams: ScriptedStream[]): LlmProvider {
  let idx = 0;
  const provider = {
    id: 'anthropic',
    capabilities: providerCapabilities,
    complete: async (): Promise<LlmResponse> => {
      throw new Error('fakeStreamProvider: complete() not scripted');
    },
    stream: (_req: LlmRequest): AsyncIterable<LlmStreamEvent> => {
      if (idx >= streams.length) {
        throw new Error(
          `fakeStreamProvider: no scripted stream for call ${String(idx + 1)}`,
        );
      }
      const fake = streams[idx]!;
      idx += 1;
      return {
        async *[Symbol.asyncIterator]() {
          for (const ev of fake.events) yield ev;
        },
      };
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  };
  return provider as unknown as LlmProvider;
}

function streamWithTools(
  toolUses: Array<{ id: string; name: string; input: unknown }>,
): ScriptedStream {
  const events: LlmStreamEvent[] = [];
  toolUses.forEach((u) => {
    events.push(
      { type: 'tool_use_start' },
      { type: 'tool_input_delta', text: JSON.stringify(u.input) },
    );
  });
  // The terminal `final` carries EVERY tool_call (with real inputs) so the
  // orchestrator sees all tool_use blocks in the response and dispatches them
  // in parallel — matching the old `finalMessage.content`.
  events.push({
    type: 'final',
    response: {
      content: toolUses.map((u) => ({
        type: 'tool_call',
        id: u.id,
        name: u.name,
        input: u.input,
      })),
      finishReason: 'tool_calls',
      providerFinishReason: 'tool_use',
      model: 'test',
      usage: {
        inputTokens: 50,
        outputTokens: 4,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
  });
  return { events };
}

const finalTextStream: ScriptedStream = {
  events: [
    { type: 'text_delta', text: 'done' },
    {
      type: 'final',
      response: {
        content: [{ type: 'text', text: 'done' }],
        finishReason: 'stop',
        providerFinishReason: 'end_turn',
        model: 'test',
        usage: {
          inputTokens: 100,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
    },
  ],
};

function buildOrchestrator(
  provider: LlmProvider,
  registry: NativeToolRegistry,
): Orchestrator {
  return new Orchestrator({
    provider,
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 5,
    domainTools: [],
    nativeToolRegistry: registry,
  });
}

const minimalSpec = (name: string): Record<string, unknown> => ({
  name,
  description: `${name} for testing`,
  input_schema: { type: 'object' as const, properties: {}, required: [] },
});

/**
 * #1093 — a native tool that THROWS (rather than returning the `Error: …`
 * string the tool convention asks for) used to end the whole streaming turn.
 *
 * The non-streaming loop dispatches under `Promise.allSettled` and turns a
 * rejected slot into an `is_error` tool result; the streaming loop raced the
 * slot promises bare, so one rejection rejected the race, propagated out of
 * `chatStreamInner`, and the client got a terminal `error` event (or, when
 * another tool had already committed, the emergency `done` that reports
 * `runTrace.status: "success"` for a turn that produced no answer).
 *
 * Reported for `query_dataset` + a Privacy-Shield `ds_…` id (that specific
 * throw is now impossible — see `queryDatasetTool.ts` and the Neon dataset
 * id guard), but the amplifier is generic: this test pins the streaming path
 * to the same recoverable behaviour the non-streaming path already had, for
 * ANY throwing tool.
 */

describe('Orchestrator streaming dispatch — a throwing tool (#1093)', () => {
  it('turns a rejected slot into an is_error tool_result and finishes the turn', async () => {
    const registry = new NativeToolRegistry();
    registry.register('throwing_tool', {
      handler: (): Promise<string> => {
        throw new Error('invalid input syntax for type uuid: "ds_0000"');
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spec: minimalSpec('throwing_tool') as any,
    });

    const stream0 = streamWithTools([
      { id: 'use-throw', name: 'throwing_tool', input: {} },
    ]);
    const provider = fakeStreamProvider([stream0, finalTextStream]);
    const orchestrator = buildOrchestrator(provider, registry);

    const events: ChatStreamEvent[] = [];
    for await (const ev of orchestrator.chatStream({ userMessage: 'go' })) {
      events.push(ev);
    }

    const result = events.find((e) => e.type === 'tool_result');
    assert.ok(result && result.type === 'tool_result', 'a tool_result must be yielded');
    assert.equal(result.id, 'use-throw');
    assert.equal(result.isError, true, 'a throwing tool is an errored tool call');
    assert.match(result.output, /^Error: /);
    // The model must be able to read WHAT failed, not just that something did.
    assert.match(result.output, /invalid input syntax for type uuid/);

    assert.equal(
      events.filter((e) => e.type === 'error').length,
      0,
      'a tool-level throw must not surface as a terminal stream error',
    );
    const done = events.find((e) => e.type === 'done');
    assert.ok(done && done.type === 'done', 'the turn must still finish with done');
    assert.match(done.answer, /^done/);
  });

  it('a throwing slot does not take its siblings down', async () => {
    const registry = new NativeToolRegistry();
    registry.register('throwing_tool', {
      handler: async (): Promise<string> => {
        await new Promise((r) => setTimeout(r, 10));
        throw new Error('boom');
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spec: minimalSpec('throwing_tool') as any,
    });
    registry.register('ok_tool', {
      handler: async (): Promise<string> => {
        await new Promise((r) => setTimeout(r, 40));
        return 'ok-output';
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spec: minimalSpec('ok_tool') as any,
    });

    const stream0 = streamWithTools([
      { id: 'use-throw', name: 'throwing_tool', input: {} },
      { id: 'use-ok', name: 'ok_tool', input: {} },
    ]);
    const provider = fakeStreamProvider([stream0, finalTextStream]);
    const orchestrator = buildOrchestrator(provider, registry);

    const events: ChatStreamEvent[] = [];
    for await (const ev of orchestrator.chatStream({ userMessage: 'go' })) {
      events.push(ev);
    }

    const results = events.filter((e) => e.type === 'tool_result');
    assert.equal(results.length, 2, 'both slots must produce a tool_result');
    const byId = new Map(
      results.map((e) => [e.type === 'tool_result' ? e.id : '', e]),
    );
    const thrown = byId.get('use-throw');
    const ok = byId.get('use-ok');
    assert.ok(thrown?.type === 'tool_result' && ok?.type === 'tool_result');
    assert.equal(thrown.isError, true);
    assert.equal(ok.isError, false);
    assert.equal(ok.output, 'ok-output');
    assert.ok(events.some((e) => e.type === 'done'), 'the turn must finish');
  });
});
