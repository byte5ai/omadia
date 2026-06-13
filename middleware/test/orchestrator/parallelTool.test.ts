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

describe('Orchestrator parallel tool dispatch', () => {
  it('emits all tool_use blocks before any tool_result, then tool_result in completion order', async () => {
    const registry = new NativeToolRegistry();
    const startTimes: Record<string, number> = {};
    const endTimes: Record<string, number> = {};
    const makeHandler = (name: string, latencyMs: number) =>
      async (_input: unknown): Promise<string> => {
        startTimes[name] = Date.now();
        await new Promise((r) => setTimeout(r, latencyMs));
        endTimes[name] = Date.now();
        return `${name}-output`;
      };
    registry.register('slow_tool', {
      handler: makeHandler('slow_tool', 200),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spec: minimalSpec('slow_tool') as any,
    });
    registry.register('fast_tool', {
      handler: makeHandler('fast_tool', 50),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spec: minimalSpec('fast_tool') as any,
    });

    const stream0 = streamWithTools([
      { id: 'use-slow', name: 'slow_tool', input: {} },
      { id: 'use-fast', name: 'fast_tool', input: {} },
    ]);
    const provider = fakeStreamProvider([stream0, finalTextStream]);
    const orchestrator = buildOrchestrator(provider, registry);

    const events: ChatStreamEvent[] = [];
    for await (const ev of orchestrator.chatStream({ userMessage: 'go' })) {
      events.push(ev);
    }

    // Slice the iteration-0 batch (between iteration_start[0] and iteration_start[1]).
    const iter0End = events.findIndex(
      (e, i) => i > 0 && e.type === 'iteration_start',
    );
    const batch = iter0End === -1 ? events : events.slice(0, iter0End);

    const toolUses = batch.filter((e) => e.type === 'tool_use');
    const toolResults = batch.filter((e) => e.type === 'tool_result');

    // Both tool_use blocks must precede any tool_result (parallel-dispatch
    // contract: pills appear immediately, results stream as tools finish).
    assert.equal(toolUses.length, 2, 'both tool_use blocks should be yielded');
    assert.equal(toolResults.length, 2, 'both tool_results should be yielded');
    const lastToolUseIdx = batch.findLastIndex((e) => e.type === 'tool_use');
    const firstResultIdx = batch.findIndex((e) => e.type === 'tool_result');
    assert.ok(
      lastToolUseIdx < firstResultIdx,
      `all tool_use must come before any tool_result, got lastUse=${String(lastToolUseIdx)} firstResult=${String(firstResultIdx)}`,
    );

    // Completion-order: fast_tool finishes first, even though slow_tool was
    // emitted first by the model.
    assert.equal(
      toolResults[0]?.type === 'tool_result' ? toolResults[0].id : '',
      'use-fast',
    );
    assert.equal(
      toolResults[1]?.type === 'tool_result' ? toolResults[1].id : '',
      'use-slow',
    );

    // Parallel-dispatch evidence: slow_tool started before fast_tool ended.
    // Sequential dispatch would have slow_tool start AFTER fast_tool's end.
    assert.ok(
      startTimes.slow_tool !== undefined && endTimes.fast_tool !== undefined,
      'both tools must have run',
    );
    assert.ok(
      startTimes.slow_tool! < endTimes.fast_tool!,
      `slow_tool dispatch must overlap fast_tool dispatch; got slow_start=${String(startTimes.slow_tool)} fast_end=${String(endTimes.fast_tool)}`,
    );
  });

  it('regression: single-tool case still surfaces tool_use → tool_result → done', async () => {
    const registry = new NativeToolRegistry();
    registry.register('only_tool', {
      handler: async (): Promise<string> => 'only-output',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spec: minimalSpec('only_tool') as any,
    });

    const stream0 = streamWithTools([
      { id: 'use-1', name: 'only_tool', input: {} },
    ]);
    const provider = fakeStreamProvider([stream0, finalTextStream]);
    const orchestrator = buildOrchestrator(provider, registry);

    const events: ChatStreamEvent[] = [];
    for await (const ev of orchestrator.chatStream({ userMessage: 'go' })) {
      events.push(ev);
    }

    const toolUses = events.filter((e) => e.type === 'tool_use');
    const toolResults = events.filter((e) => e.type === 'tool_result');
    assert.equal(toolUses.length, 1);
    assert.equal(toolResults.length, 1);
    assert.equal(
      toolResults[0]?.type === 'tool_result' ? toolResults[0].id : '',
      'use-1',
    );

    const done = events.find((e) => e.type === 'done');
    assert.ok(done, 'done event must be emitted');
  });

  it('parallel dispatch achieves wallclock speedup vs sequential expectation', async () => {
    // Two 100ms tools dispatched in parallel should complete in ~100ms
    // wallclock, not ~200ms. Allow a generous slack for CI noise but well
    // under the sequential lower bound.
    const registry = new NativeToolRegistry();
    const handler = async (): Promise<string> => {
      await new Promise((r) => setTimeout(r, 100));
      return 'ok';
    };
    registry.register('tool_a', {
      handler,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spec: minimalSpec('tool_a') as any,
    });
    registry.register('tool_b', {
      handler,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spec: minimalSpec('tool_b') as any,
    });

    const stream0 = streamWithTools([
      { id: 'use-a', name: 'tool_a', input: {} },
      { id: 'use-b', name: 'tool_b', input: {} },
    ]);
    const provider = fakeStreamProvider([stream0, finalTextStream]);
    const orchestrator = buildOrchestrator(provider, registry);

    const before = Date.now();
    const events: ChatStreamEvent[] = [];
    for await (const ev of orchestrator.chatStream({ userMessage: 'go' })) {
      events.push(ev);
    }
    const elapsed = Date.now() - before;

    // Sequential: 2 × 100ms = 200ms minimum. Parallel: ~100ms + overhead.
    // Tick loop adds up to TICK_MS=1000ms quantization between drain and
    // result-yield — give 180ms ceiling (well under sequential floor).
    assert.ok(
      elapsed < 180,
      `expected parallel dispatch under 180ms, got ${String(elapsed)}ms (sequential would be ≥200ms)`,
    );
  });
});
