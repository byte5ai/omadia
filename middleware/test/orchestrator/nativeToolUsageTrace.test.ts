/**
 * #584 — END-TO-END: a NATIVE tool's metering reaches the run trace
 * through the real orchestrator seam.
 *
 * runTraceTranscriptionUsage.test.ts pins the pieces (collector copy, ALS
 * box, KG persistence) in isolation; this test drives the actual streaming
 * dispatch path — `toolUsage.capture` around `dispatchTool`, the handler
 * reporting via `toolUsage.report`, `finishSlotInvocation` stamping the box
 * onto `recordOrchestratorToolCall` — and reads the result off the `done`
 * event's `runTrace`. A regression anywhere along that seam (box created but
 * never stamped, capture scope lost across the dispatch await, sink leaking
 * between parallel slots) turns this red while the unit tests stay green.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type {
  LlmProvider,
  LlmResponse,
  LlmStreamEvent,
} from '@omadia/llm-provider';
import {
  NativeToolRegistry,
  Orchestrator,
  toolUsage,
  type ChatStreamEvent,
} from '@omadia/orchestrator';

const providerCapabilities = {
  tools: true,
  vision: true,
  streaming: true,
  promptCaching: true,
  forcedToolChoice: true,
  parallelToolCalls: true,
} as const;

function fakeProvider(streams: LlmStreamEvent[][]): LlmProvider {
  let idx = 0;
  const take = (): LlmStreamEvent[] => {
    if (idx >= streams.length) {
      throw new Error(`no scripted stream for provider call ${String(idx + 1)}`);
    }
    const events = streams[idx]!;
    idx += 1;
    return events;
  };
  return {
    id: 'anthropic',
    capabilities: providerCapabilities,
    complete: async (): Promise<LlmResponse> => {
      const events = take();
      const final = events.at(-1) as { type: string; response: LlmResponse };
      return final.response;
    },
    stream: (): AsyncIterable<LlmStreamEvent> => {
      const events = take();
      return {
        async *[Symbol.asyncIterator]() {
          for (const ev of events) yield ev;
        },
      };
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
}

function toolCallStream(
  calls: Array<{ id: string; name: string; input: unknown }>,
): LlmStreamEvent[] {
  return [
    {
      type: 'final',
      response: {
        content: calls.map((c) => ({
          type: 'tool_call',
          id: c.id,
          name: c.name,
          input: c.input,
        })),
        finishReason: 'tool_calls',
        providerFinishReason: 'tool_use',
        model: 'test',
        usage: { inputTokens: 50, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    } as LlmStreamEvent,
  ];
}

function textStream(text: string): LlmStreamEvent[] {
  return [
    { type: 'text_delta', text },
    {
      type: 'final',
      response: {
        content: [{ type: 'text', text }],
        finishReason: 'stop',
        providerFinishReason: 'end_turn',
        model: 'test',
        usage: { inputTokens: 100, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    } as LlmStreamEvent,
  ];
}

const METERED_TOOL = 'transcribe_probe';
const PLAIN_TOOL = 'plain_probe';
const USAGE = { sourceMinutes: 2, billedMinutes: 4 };

function spec(name: string): never {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return {
    name,
    description: 'test probe',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  } as any as never;
}

describe('#584 — native tool usage reaches the run trace end-to-end', () => {
  it('MUTATION CHECK: the metered slot carries usage, the parallel plain slot does not', async () => {
    const registry = new NativeToolRegistry();
    registry.register(METERED_TOOL, {
      handler: async () => {
        // What handleTranscribeRecording does after booking the ledger row.
        toolUsage.report(USAGE);
        return 'Aufnahme transkribiert.';
      },
      spec: spec(METERED_TOOL),
      agentId: 'probe',
    });
    registry.register(PLAIN_TOOL, {
      handler: async () => 'ok',
      spec: spec(PLAIN_TOOL),
      agentId: 'probe',
    });

    const orchestrator = new Orchestrator({
      provider: fakeProvider([
        // Both native tools in ONE parallel batch: also pins that the two
        // capture scopes do not leak into each other.
        toolCallStream([
          { id: 'tu-metered', name: METERED_TOOL, input: {} },
          { id: 'tu-plain', name: PLAIN_TOOL, input: {} },
        ]),
        textStream('fertig'),
      ]),
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 5,
      domainTools: [],
      nativeToolRegistry: registry,
      agentId: 'probe-agent',
    });

    let done: Extract<ChatStreamEvent, { type: 'done' }> | undefined;
    for await (const ev of orchestrator.chatStream({
      userMessage: 'transkribiere',
      sessionScope: 'sess-584-e2e',
    })) {
      if (ev.type === 'done') done = ev;
    }

    assert.ok(done, 'no done event');
    const trace = done.runTrace;
    assert.ok(trace, 'done event carried no runTrace');
    const byId = new Map(
      trace.orchestratorToolCalls.map((tc) => [tc.callId, tc]),
    );
    const metered = byId.get('tu-metered');
    const plain = byId.get('tu-plain');
    assert.ok(metered, 'metered tool call missing from the trace');
    assert.ok(plain, 'plain tool call missing from the trace');
    assert.deepEqual(metered.usage, USAGE);
    assert.equal('usage' in plain, false, 'usage leaked into the parallel slot');
  });
});
