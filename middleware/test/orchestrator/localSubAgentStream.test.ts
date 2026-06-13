import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
} from '@omadia/llm-provider';
import { LocalSubAgent } from '@omadia/orchestrator';
import type { AskObserver } from '@omadia/orchestrator';

/**
 * A scripted stream: the ordered neutral `LlmStreamEvent`s the fake provider
 * yields for one `stream()` call. The terminal `final` event carries the full
 * `LlmResponse` (there is no `finalMessage()` method on the neutral contract —
 * the production stream-helper reads the response off the `final` event).
 */
interface FakeStream {
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

function fakeStreamProvider(streams: FakeStream[]): {
  provider: LlmProvider;
  calls: number;
} {
  let idx = 0;
  const counter = { calls: 0 };
  const provider = {
    id: 'anthropic',
    capabilities: providerCapabilities,
    complete: async (): Promise<LlmResponse> => {
      throw new Error('fakeStreamProvider: complete() not scripted');
    },
    stream: (_req: LlmRequest): AsyncIterable<LlmStreamEvent> => {
      counter.calls += 1;
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
  } as unknown as LlmProvider;
  return { provider, calls: counter.calls };
}

function buildAgent(provider: LlmProvider): LocalSubAgent {
  return new LocalSubAgent({
    name: 'stream-test',
    provider,
    model: 'claude-haiku',
    maxTokens: 1024,
    maxIterations: 5,
    systemPrompt: 'you are a test',
    tools: [],
  });
}

// Two `text_delta` events (`'Hello '` + `'world'`) reproduce the original
// two-chunk SSE so `onTokenChunk` still sees ≥2 chunks; the terminal `final`
// carries the reconstructed full text plus the asserted usage numbers
// (inputTokens 100, outputTokens 12, cacheReadTokens 80).
const baseTextStream: FakeStream = {
  events: [
    { type: 'text_delta', text: 'Hello ' },
    { type: 'text_delta', text: 'world' },
    {
      type: 'final',
      response: {
        content: [{ type: 'text', text: 'Hello world' }],
        finishReason: 'stop',
        providerFinishReason: 'end_turn',
        model: 'claude-haiku',
        usage: {
          inputTokens: 100,
          outputTokens: 12,
          cacheReadTokens: 80,
          cacheWriteTokens: 0,
        },
      },
    },
  ],
};

describe('LocalSubAgent stream observability', () => {
  it('emits phase transitions thinking → streaming → idle on a text-only iteration', async () => {
    const { provider } = fakeStreamProvider([baseTextStream]);
    const phases: string[] = [];
    const observer: AskObserver = {
      onIterationPhase: (ev) => phases.push(ev.phase),
    };
    const answer = await buildAgent(provider).ask('hi', observer);
    assert.equal(answer, 'Hello world');
    // 'thinking' first, 'streaming' once message_start arrived, 'idle' in
    // the finally block after the iteration returns. tool_running must NOT
    // appear because no tool_use blocks were in the stream.
    assert.deepEqual(phases, ['thinking', 'streaming', 'idle']);
  });

  it('emits onTokenChunk with monotonically increasing cumulativeOutputTokens', async () => {
    const { provider } = fakeStreamProvider([baseTextStream]);
    const cumulatives: number[] = [];
    const observer: AskObserver = {
      onTokenChunk: (ev) => cumulatives.push(ev.cumulativeOutputTokens),
    };
    await buildAgent(provider).ask('hi', observer);
    assert.ok(cumulatives.length >= 2, 'at least one chunk per text_delta');
    for (let i = 1; i < cumulatives.length; i++) {
      assert.ok(
        cumulatives[i]! >= cumulatives[i - 1]!,
        `cumulative must not decrease at index ${String(i)}: ${String(cumulatives)}`,
      );
    }
  });

  it('emits onIterationUsage with cache_read_input_tokens from finalMessage', async () => {
    const { provider } = fakeStreamProvider([baseTextStream]);
    const usages: Array<{ cacheReadInputTokens: number; outputTokens: number }> = [];
    const observer: AskObserver = {
      onIterationUsage: (ev) =>
        usages.push({
          cacheReadInputTokens: ev.cacheReadInputTokens,
          outputTokens: ev.outputTokens,
        }),
    };
    await buildAgent(provider).ask('hi', observer);
    assert.equal(usages.length, 1);
    assert.equal(usages[0]?.cacheReadInputTokens, 80);
    assert.equal(usages[0]?.outputTokens, 12);
  });

  it('flips phase to tool_running when stream emits a tool_use content block', async () => {
    // Iteration 0: stream emits a tool_use block (forces phase tool_running),
    // dispatch swallows it (no tool registered → 'unknown tool' error
    // string, which is NOT prefixed 'Error:' so no isError flag, but the
    // result still feeds back into iteration 1 which the agent then
    // closes with text). For phase assertion we only care that
    // 'tool_running' appears between 'streaming' and the iteration-end.
    const toolStream: FakeStream = {
      events: [
        { type: 'tool_use_start' },
        { type: 'tool_input_delta', text: '{}' },
        {
          type: 'final',
          response: {
            content: [{ type: 'tool_call', id: 'tu1', name: 'noop', input: {} }],
            finishReason: 'tool_calls',
            providerFinishReason: 'tool_use',
            model: 'claude-haiku',
            usage: {
              inputTokens: 50,
              outputTokens: 4,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          },
        },
      ],
    };
    const { provider } = fakeStreamProvider([toolStream, baseTextStream]);
    const phases: string[] = [];
    const observer: AskObserver = {
      onIterationPhase: (ev) => phases.push(`${String(ev.iteration)}:${ev.phase}`),
    };
    await buildAgent(provider).ask('use a tool', observer);
    // Iteration 0 must traverse thinking → streaming → tool_running (helper
    // emit) → tool_running (caller defensive emit before dispatch loop).
    // Iteration 1 traverses thinking → streaming. Final 'idle' is on the
    // last-iteration counter (iteration 1 here).
    assert.ok(phases.includes('0:thinking'));
    assert.ok(phases.includes('0:streaming'));
    assert.ok(phases.includes('0:tool_running'));
    assert.ok(phases.includes('1:thinking'));
    assert.equal(phases[phases.length - 1], '1:idle');
  });

  it('final-event reconstruction preserves text content (backward-compat with messages.create callers)', async () => {
    const { provider } = fakeStreamProvider([baseTextStream]);
    const answer = await buildAgent(provider).ask('hi');
    // Critical backward-compat assertion: callers like Confluence-Playbook
    // and Odoo-Sub-Agent that pass NO observer must still get the same
    // string they'd have gotten from messages.create.
    assert.equal(answer, 'Hello world');
  });
});
