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

/**
 * Issue #506 — the one-click repro. `chatStreamInner` wraps its whole
 * per-turn iteration loop in a single try/catch: an exception thrown by a
 * LATER iteration's model call (after an EARLIER iteration's tool call
 * already committed a real side effect and yielded a successful
 * `tool_result`) used to fall into the same catch-all that reports a bare
 * `{ type: 'error' }` — discarding the fact that the action already
 * succeeded. These tests exercise the fix: a committed tool result changes
 * the catch block's outcome to a `done` event; a genuine failure with no
 * prior committed tool result is unaffected.
 */

interface ScriptedStream {
  events: LlmStreamEvent[];
}

/** A scripted stream entry that fails immediately (no events at all), the
 *  way a non-retryable provider error surfaces before any text/tool delta —
 *  see `streamMessageEvents`'s `forwardedText` retry gate in streaming.ts. */
interface ThrowingStream {
  throws: Error;
}

const providerCapabilities = {
  tools: true,
  vision: true,
  streaming: true,
  promptCaching: true,
  forcedToolChoice: true,
  parallelToolCalls: true,
} as const;

/** Mirrors parallelTool.test.ts's fakeStreamProvider, extended with the
 *  ability to script a call that throws instead of streaming events — the
 *  shape needed to reproduce a post-tool-dispatch model failure. */
function fakeStreamProvider(
  scripts: Array<ScriptedStream | ThrowingStream>,
): LlmProvider {
  let idx = 0;
  const provider = {
    id: 'anthropic',
    capabilities: providerCapabilities,
    complete: async (): Promise<LlmResponse> => {
      throw new Error('fakeStreamProvider: complete() not scripted');
    },
    stream: (_req: LlmRequest): AsyncIterable<LlmStreamEvent> => {
      if (idx >= scripts.length) {
        throw new Error(
          `fakeStreamProvider: no scripted stream for call ${String(idx + 1)}`,
        );
      }
      const script = scripts[idx]!;
      idx += 1;
      if ('throws' in script) {
        return {
          async *[Symbol.asyncIterator]() {
            throw script.throws;
          },
        };
      }
      return {
        async *[Symbol.asyncIterator]() {
          for (const ev of script.events) yield ev;
        },
      };
    },
    // Non-retryable — the second scripted call's failure must propagate
    // straight to `chatStreamInner`'s outer catch, exactly like a genuine
    // hard failure would (see isRetryableStreamError for the transient set).
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

describe('Issue #506 — report success when a tool already committed', () => {
  it('ends with `done` (not `error`) when a tool committed in an earlier iteration and a later model call throws', async () => {
    const registry = new NativeToolRegistry();
    registry.register('manage_widget', {
      handler: async (): Promise<string> => 'widget-created',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spec: minimalSpec('manage_widget') as any,
    });

    // Iteration 0: model calls the tool, which succeeds and commits.
    const stream0 = streamWithTools([
      { id: 'use-1', name: 'manage_widget', input: {} },
    ]);
    // Iteration 1: the follow-up model call (generating the natural-language
    // confirmation) fails hard — the exact shape a mid-stream, non-retryable
    // provider error takes, or what's left once internal retries in
    // streamMessageEvents are exhausted.
    const stream1: ThrowingStream = {
      throws: Object.assign(new Error('boom: provider hard-failed'), {
        status: 400,
      }),
    };
    const provider = fakeStreamProvider([stream0, stream1]);
    const orchestrator = buildOrchestrator(provider, registry);

    const events: ChatStreamEvent[] = [];
    for await (const ev of orchestrator.chatStream({ userMessage: 'create a widget' })) {
      events.push(ev);
    }

    const errorEvents = events.filter((e) => e.type === 'error');
    const doneEvents = events.filter((e) => e.type === 'done');
    assert.equal(
      errorEvents.length,
      0,
      `expected no error event, got ${JSON.stringify(errorEvents)}`,
    );
    assert.equal(doneEvents.length, 1, 'expected exactly one done event');

    const done = doneEvents[0];
    assert.ok(done && done.type === 'done');
    if (done && done.type === 'done') {
      assert.match(done.answer, /manage_widget/);
      assert.match(done.answer, /completed successfully/i);
      assert.equal(done.toolCalls, 1);
      // Two iterations were entered (0 and 1) before the failure.
      assert.equal(done.iterations, 2);
    }
  });

  it('still ends with `error` when no tool committed before the failure (genuine failure, unchanged behavior)', async () => {
    const registry = new NativeToolRegistry();

    // Iteration 0: the very first model call fails hard, before any tool ran.
    const stream0: ThrowingStream = {
      throws: Object.assign(new Error('boom: provider hard-failed'), {
        status: 400,
      }),
    };
    const provider = fakeStreamProvider([stream0]);
    const orchestrator = buildOrchestrator(provider, registry);

    const events: ChatStreamEvent[] = [];
    for await (const ev of orchestrator.chatStream({ userMessage: 'do something' })) {
      events.push(ev);
    }

    const errorEvents = events.filter((e) => e.type === 'error');
    const doneEvents = events.filter((e) => e.type === 'done');
    assert.equal(doneEvents.length, 0, 'expected no done event');
    assert.equal(errorEvents.length, 1, 'expected exactly one error event');
    const error = errorEvents[0];
    assert.ok(error && error.type === 'error');
    if (error && error.type === 'error') {
      assert.match(error.message, /boom: provider hard-failed/);
    }
  });
});
