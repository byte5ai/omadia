import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

import type {
  LlmProvider,
  LlmResponse,
  LlmStreamEvent,
} from '@omadia/llm-provider';
import type { ChatStreamEvent } from '@omadia/channel-sdk';
import {
  NativeToolRegistry,
  Orchestrator,
  turnContext,
  type AskObserver,
  type DomainTool,
} from '@omadia/orchestrator';

/**
 * W0-2 — per-tool dispatch deadline.
 *
 * Before this, `dispatchTool` had no timeout anywhere: `domainQueryTool` awaits
 * `agent.ask()` with no abort, and every tool of an iteration is dispatched into
 * one `Promise.allSettled` / race loop. One hung sub-agent therefore pinned the
 * whole batch for the rest of the turn.
 *
 * The load-bearing test here is the MUTATION CHECK: it is not enough that the
 * timed-out slot returns an error — the abandoned dispatch's LATE result must
 * never be written into the turn afterwards. `captureRawToolResult` is a real
 * turn-state write (the routine runner reads it back as the source of truth for
 * template data sections), so a late write is observable. Delete the
 * `deadlineSignal?.aborted` guard in `dispatchToolDeadlined` and this test fails
 * on the capture assertion, not merely on a missing error string.
 */

const DEADLINE_MS = 150;
const LATE_VALUE = 'LATE-VALUE-from-abandoned-subagent';
const FAST_VALUE = 'fast-tool-output';

const providerCapabilities = {
  tools: true,
  vision: true,
  streaming: true,
  promptCaching: true,
  forcedToolChoice: true,
  parallelToolCalls: true,
} as const;

const usage = {
  inputTokens: 10,
  outputTokens: 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
} as const;

function toolCallResponse(
  toolUses: ReadonlyArray<{ id: string; name: string }>,
): LlmResponse {
  return {
    content: toolUses.map((u) => ({
      type: 'tool_call',
      id: u.id,
      name: u.name,
      input: {},
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

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Scripted provider. `completeDelays[i]` / `streamDelays[i]` hold the i-th
 * call open, which keeps the turn LIVE while the abandoned dispatch settles —
 * without that window a late write could not be observed at all and the
 * mutation check would be vacuous.
 */
function fakeProvider(
  responses: readonly LlmResponse[],
  delaysMs: readonly number[] = [],
): LlmProvider {
  let idx = 0;
  const next = async (): Promise<LlmResponse> => {
    const i = idx;
    idx += 1;
    const response = responses[i];
    if (!response) {
      throw new Error(`fakeProvider: no scripted response for call ${String(i + 1)}`);
    }
    const delay = delaysMs[i] ?? 0;
    if (delay > 0) await sleep(delay);
    return response;
  };
  const provider = {
    id: 'anthropic',
    capabilities: providerCapabilities,
    complete: next,
    stream: (): AsyncIterable<LlmStreamEvent> => ({
      async *[Symbol.asyncIterator]() {
        const response = await next();
        yield { type: 'final', response } as LlmStreamEvent;
      },
    }),
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  };
  return provider as unknown as LlmProvider;
}

const minimalSpec = (name: string): Record<string, unknown> => ({
  name,
  description: `${name} for testing`,
  input_schema: { type: 'object' as const, properties: {}, required: [] },
});

interface SlowToolProbe {
  readonly settledLate: () => boolean;
  readonly lateObserverCalls: () => number;
  readonly tool: DomainTool;
}

/**
 * A sub-agent that ignores the deadline entirely — the real-world case this
 * unit exists for. It resolves long after the deadline AND emits a sub-agent
 * event on its way out, exercising both late-write vectors.
 */
function slowDomainTool(name: string, latencyMs: number): SlowToolProbe {
  let settled = false;
  let lateEmits = 0;
  const tool: DomainTool = {
    name,
    domain: 'test.slow',
    spec: minimalSpec(name) as unknown as DomainTool['spec'],
    async handle(_input: unknown, observer?: AskObserver): Promise<string> {
      observer?.onIteration?.({ iteration: 1 });
      await sleep(latencyMs);
      // Everything below happens AFTER the deadline fired for this slot.
      lateEmits += 1;
      observer?.onSubToolResult?.({
        id: 'late-sub-call',
        output: LATE_VALUE,
        durationMs: latencyMs,
        isError: false,
      });
      settled = true;
      return LATE_VALUE;
    },
  };
  return {
    settledLate: () => settled,
    lateObserverCalls: () => lateEmits,
    tool,
  };
}

function buildOrchestrator(
  provider: LlmProvider,
  registry: NativeToolRegistry,
  domainTools: DomainTool[],
): Orchestrator {
  return new Orchestrator({
    provider,
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 5,
    domainTools,
    nativeToolRegistry: registry,
  });
}

function fastToolRegistry(): NativeToolRegistry {
  const registry = new NativeToolRegistry();
  registry.register('fast_tool', {
    handler: async (): Promise<string> => {
      await sleep(10);
      return FAST_VALUE;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spec: minimalSpec('fast_tool') as any,
  });
  return registry;
}

const originalTimeout = process.env['OMADIA_TOOL_DISPATCH_TIMEOUT_MS'];

afterEach(() => {
  if (originalTimeout === undefined) {
    delete process.env['OMADIA_TOOL_DISPATCH_TIMEOUT_MS'];
  } else {
    process.env['OMADIA_TOOL_DISPATCH_TIMEOUT_MS'] = originalTimeout;
  }
});

describe('Orchestrator per-tool dispatch deadline (W0-2)', () => {
  it('times out the hung tool, keeps its batch siblings, and DISCARDS the late result', async () => {
    process.env['OMADIA_TOOL_DISPATCH_TIMEOUT_MS'] = String(DEADLINE_MS);
    const probe = slowDomainTool('query_slow_agent', DEADLINE_MS * 4);
    const orchestrator = buildOrchestrator(
      // Second call is held open past the slow tool's late settle, so the turn
      // is still live when the abandoned dispatch resolves.
      fakeProvider(
        [
          toolCallResponse([
            { id: 'use-slow', name: 'query_slow_agent' },
            { id: 'use-fast', name: 'fast_tool' },
          ]),
          textResponse('done'),
        ],
        [0, DEADLINE_MS * 6],
      ),
      fastToolRegistry(),
      [probe.tool],
    );

    const captured: Array<{ name: string; result: string }> = [];
    const events: ChatStreamEvent[] = [];
    await turnContext.run(
      {
        turnId: 'outer-turn',
        turnDate: '2026-07-30',
        captureRawToolResult: (name, result) => {
          captured.push({ name, result });
        },
      },
      async () => {
        // `sessionScope` switches the run-trace collector on, so the late
        // sub-agent event has a real turn-state sink to corrupt: without the
        // abort-guarded observer it lands in the `done` event's runTrace.
        for await (const ev of orchestrator.chatStream({
          userMessage: 'go',
          sessionScope: 'test::deadline',
        })) {
          events.push(ev);
        }
      },
    );

    // The late path must actually have run, or this test proves nothing.
    assert.equal(
      probe.settledLate(),
      true,
      'the abandoned sub-agent must have settled during the turn for this test to be meaningful',
    );

    const results = events.filter((e) => e.type === 'tool_result');
    const slow = results.find((e) => e.type === 'tool_result' && e.id === 'use-slow');
    const fast = results.find((e) => e.type === 'tool_result' && e.id === 'use-fast');
    assert.ok(slow && slow.type === 'tool_result', 'the slow slot must produce a tool_result');
    assert.ok(fast && fast.type === 'tool_result', 'the fast slot must produce a tool_result');

    // 1. Structured error, not a hang.
    assert.equal(slow.isError, true);
    assert.match(slow.output, /^Error: tool `query_slow_agent` was aborted/);
    assert.match(slow.output, /dispatch deadline/);

    // 2. Batch siblings are unaffected by another slot's deadline.
    assert.equal(fast.isError, false);
    assert.equal(fast.output, FAST_VALUE);

    // 3. MUTATION CHECK — the late result is never written into the turn.
    assert.deepEqual(
      captured,
      [{ name: 'fast_tool', result: FAST_VALUE }],
      'only the sibling tool may reach captureRawToolResult; a late write from the aborted slot is a corruption bug',
    );
    const transcript = JSON.stringify(events);
    assert.equal(
      transcript.includes(LATE_VALUE),
      false,
      'the abandoned dispatch\'s value must not appear anywhere in the turn transcript',
    );
    assert.equal(
      probe.lateObserverCalls(),
      1,
      'the sub-agent still emitted its late event (so the observer guard, not the sub-agent, is what suppresses it)',
    );
    // Invariant (belt-and-braces): the abort-guarded observer drops the late
    // sub-event at the boundary. Downstream layers happen to ignore it too (the
    // slot left the race loop, its invocation is already finished), so this
    // assertion documents the boundary contract rather than being the only
    // thing standing between a late event and the turn.
    assert.equal(
      events.some(
        (e) => e.type === 'sub_tool_result' && e.id === 'late-sub-call',
      ),
      false,
      'a post-deadline sub-agent event must be dropped, not streamed into the turn',
    );
  });

  it('non-streaming Promise.allSettled batch: one deadline does not stop the siblings', async () => {
    process.env['OMADIA_TOOL_DISPATCH_TIMEOUT_MS'] = String(DEADLINE_MS);
    const probe = slowDomainTool('query_slow_agent', DEADLINE_MS * 3);
    const orchestrator = buildOrchestrator(
      fakeProvider([
        toolCallResponse([
          { id: 'use-slow', name: 'query_slow_agent' },
          { id: 'use-fast', name: 'fast_tool' },
        ]),
        textResponse('answered'),
      ]),
      fastToolRegistry(),
      [probe.tool],
    );

    const started = Date.now();
    const result = await orchestrator.runTurn({ userMessage: 'go' });
    const elapsed = Date.now() - started;

    assert.equal(result.answer, 'answered');
    // The turn must not wait for the hung tool (3× the deadline).
    assert.ok(
      elapsed < DEADLINE_MS * 3,
      `turn should finish on the deadline, not on the hung tool; took ${String(elapsed)}ms`,
    );
    assert.equal(probe.settledLate(), false, 'the hung tool must still be in flight');
  });

  it('honours a 0 deadline as "disabled" (legacy behaviour)', async () => {
    process.env['OMADIA_TOOL_DISPATCH_TIMEOUT_MS'] = '0';
    const probe = slowDomainTool('query_slow_agent', 60);
    const orchestrator = buildOrchestrator(
      fakeProvider([
        toolCallResponse([{ id: 'use-slow', name: 'query_slow_agent' }]),
        textResponse('answered'),
      ]),
      fastToolRegistry(),
      [probe.tool],
    );

    const result = await orchestrator.runTurn({ userMessage: 'go' });
    assert.equal(result.answer, 'answered');
    assert.equal(
      probe.settledLate(),
      true,
      'with the deadline disabled the dispatch must be awaited to completion',
    );
  });

  it('falls back to the 120s default when the env value is not a number', async () => {
    process.env['OMADIA_TOOL_DISPATCH_TIMEOUT_MS'] = 'not-a-number';
    const probe = slowDomainTool('query_slow_agent', 20);
    const orchestrator = buildOrchestrator(
      fakeProvider([
        toolCallResponse([{ id: 'use-slow', name: 'query_slow_agent' }]),
        textResponse('answered'),
      ]),
      fastToolRegistry(),
      [probe.tool],
    );

    const result = await orchestrator.runTurn({ userMessage: 'go' });
    // A bad env value must not degrade into "no deadline" or "0ms deadline":
    // the tool completes normally well inside the 120s default.
    assert.equal(result.answer, 'answered');
    assert.equal(probe.settledLate(), true);
  });
});
