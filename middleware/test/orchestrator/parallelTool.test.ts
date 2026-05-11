import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type Anthropic from '@anthropic-ai/sdk';
import type { ChatStreamEvent } from '@omadia/channel-sdk';
import { NativeToolRegistry, Orchestrator } from '@omadia/orchestrator';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEvent = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMessage = any;

interface ScriptedStream {
  events: AnyEvent[];
  finalMessage: AnyMessage;
}

function fakeStreamClient(streams: ScriptedStream[]): Anthropic {
  let idx = 0;
  const client = {
    messages: {
      stream: (_req: AnyMessage): AnyMessage => {
        if (idx >= streams.length) {
          throw new Error(
            `fakeStreamClient: no scripted stream for call ${String(idx + 1)}`,
          );
        }
        const fake = streams[idx]!;
        idx += 1;
        return {
          async *[Symbol.asyncIterator]() {
            for (const ev of fake.events) yield ev;
          },
          async finalMessage() {
            return fake.finalMessage;
          },
        };
      },
    },
  };
  return client as unknown as Anthropic;
}

function streamWithTools(
  toolUses: Array<{ id: string; name: string; input: unknown }>,
): ScriptedStream {
  const events: AnyEvent[] = [
    {
      type: 'message_start',
      message: { id: 'm-tools', usage: { input_tokens: 50, output_tokens: 0 } },
    },
  ];
  toolUses.forEach((u, i) => {
    events.push(
      {
        type: 'content_block_start',
        index: i,
        content_block: { type: 'tool_use', id: u.id, name: u.name, input: {} },
      },
      {
        type: 'content_block_delta',
        index: i,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(u.input) },
      },
      { type: 'content_block_stop', index: i },
    );
  });
  events.push(
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { output_tokens: 4 },
    },
    { type: 'message_stop' },
  );
  return {
    events,
    finalMessage: {
      id: 'm-tools',
      type: 'message',
      role: 'assistant',
      content: toolUses.map((u) => ({
        type: 'tool_use',
        id: u.id,
        name: u.name,
        input: u.input,
      })),
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 50,
        output_tokens: 4,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  };
}

const finalTextStream: ScriptedStream = {
  events: [
    {
      type: 'message_start',
      message: { id: 'm-text', usage: { input_tokens: 100, output_tokens: 0 } },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'done' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 1 },
    },
    { type: 'message_stop' },
  ],
  finalMessage: {
    id: 'm-text',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'done' }],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 100,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  },
};

function buildOrchestrator(
  client: Anthropic,
  registry: NativeToolRegistry,
): Orchestrator {
  return new Orchestrator({
    client,
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
    const client = fakeStreamClient([stream0, finalTextStream]);
    const orchestrator = buildOrchestrator(client, registry);

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
    const client = fakeStreamClient([stream0, finalTextStream]);
    const orchestrator = buildOrchestrator(client, registry);

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
    const client = fakeStreamClient([stream0, finalTextStream]);
    const orchestrator = buildOrchestrator(client, registry);

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
