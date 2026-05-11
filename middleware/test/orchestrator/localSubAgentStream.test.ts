import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type Anthropic from '@anthropic-ai/sdk';
import { LocalSubAgent } from '@omadia/orchestrator';
import type { AskObserver } from '@omadia/orchestrator';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEvent = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMessage = any;

interface FakeStream {
  events: AnyEvent[];
  finalMessage: AnyMessage;
}

function fakeStreamClient(streams: FakeStream[]): {
  client: Anthropic;
  calls: number;
} {
  let idx = 0;
  const counter = { calls: 0 };
  const client = {
    messages: {
      stream: (_req: AnyMessage): AnyMessage => {
        counter.calls += 1;
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
  } as unknown as Anthropic;
  return { client, calls: counter.calls };
}

function buildAgent(client: Anthropic): LocalSubAgent {
  return new LocalSubAgent({
    name: 'stream-test',
    client,
    model: 'claude-haiku',
    maxTokens: 1024,
    maxIterations: 5,
    systemPrompt: 'you are a test',
    tools: [],
  });
}

const baseTextStream: FakeStream = {
  events: [
    {
      type: 'message_start',
      message: { id: 'm1', usage: { input_tokens: 100, output_tokens: 0 } },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Hello ' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'world' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 12, cache_read_input_tokens: 80 },
    },
    { type: 'message_stop' },
  ],
  finalMessage: {
    id: 'm1',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'Hello world' }],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 100,
      output_tokens: 12,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 0,
    },
  },
};

describe('LocalSubAgent stream observability', () => {
  it('emits phase transitions thinking → streaming → idle on a text-only iteration', async () => {
    const { client } = fakeStreamClient([baseTextStream]);
    const phases: string[] = [];
    const observer: AskObserver = {
      onIterationPhase: (ev) => phases.push(ev.phase),
    };
    const answer = await buildAgent(client).ask('hi', observer);
    assert.equal(answer, 'Hello world');
    // 'thinking' first, 'streaming' once message_start arrived, 'idle' in
    // the finally block after the iteration returns. tool_running must NOT
    // appear because no tool_use blocks were in the stream.
    assert.deepEqual(phases, ['thinking', 'streaming', 'idle']);
  });

  it('emits onTokenChunk with monotonically increasing cumulativeOutputTokens', async () => {
    const { client } = fakeStreamClient([baseTextStream]);
    const cumulatives: number[] = [];
    const observer: AskObserver = {
      onTokenChunk: (ev) => cumulatives.push(ev.cumulativeOutputTokens),
    };
    await buildAgent(client).ask('hi', observer);
    assert.ok(cumulatives.length >= 2, 'at least one chunk per text_delta');
    for (let i = 1; i < cumulatives.length; i++) {
      assert.ok(
        cumulatives[i]! >= cumulatives[i - 1]!,
        `cumulative must not decrease at index ${String(i)}: ${String(cumulatives)}`,
      );
    }
  });

  it('emits onIterationUsage with cache_read_input_tokens from finalMessage', async () => {
    const { client } = fakeStreamClient([baseTextStream]);
    const usages: Array<{ cacheReadInputTokens: number; outputTokens: number }> = [];
    const observer: AskObserver = {
      onIterationUsage: (ev) =>
        usages.push({
          cacheReadInputTokens: ev.cacheReadInputTokens,
          outputTokens: ev.outputTokens,
        }),
    };
    await buildAgent(client).ask('hi', observer);
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
        {
          type: 'message_start',
          message: { id: 'm-tool', usage: { input_tokens: 50, output_tokens: 0 } },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'tu1',
            name: 'noop',
            input: {},
          },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{}' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: { output_tokens: 4, cache_read_input_tokens: 0 },
        },
        { type: 'message_stop' },
      ],
      finalMessage: {
        id: 'm-tool',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu1', name: 'noop', input: {} },
        ],
        stop_reason: 'tool_use',
        usage: {
          input_tokens: 50,
          output_tokens: 4,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    };
    const { client } = fakeStreamClient([toolStream, baseTextStream]);
    const phases: string[] = [];
    const observer: AskObserver = {
      onIterationPhase: (ev) => phases.push(`${String(ev.iteration)}:${ev.phase}`),
    };
    await buildAgent(client).ask('use a tool', observer);
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

  it('finalMessage() reconstruction preserves text content (backward-compat with messages.create callers)', async () => {
    const { client } = fakeStreamClient([baseTextStream]);
    const answer = await buildAgent(client).ask('hi');
    // Critical backward-compat assertion: callers like Confluence-Playbook
    // and Odoo-Sub-Agent that pass NO observer must still get the same
    // string they'd have gotten from messages.create.
    assert.equal(answer, 'Hello world');
  });
});
