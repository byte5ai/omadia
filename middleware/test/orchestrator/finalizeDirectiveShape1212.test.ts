/**
 * #1212 — the finalize directive must not change the system prompt mid-turn.
 *
 * On the final, tools-disabled iteration the orchestrator tells the model to
 * answer from what it already has. That instruction used to be spliced into
 * the per-turn system hint (`withFinalizeHint`), so system block N differed
 * between iteration 0 and the finalize iteration of the SAME turn. On the
 * current Opus/Fable models a thinking block is signed against the
 * conversation prefix it was produced under, so editing the system prompt
 * between iterations invalidates that binding for every earlier turn — and it
 * also breaks the prompt-cache prefix.
 *
 * These tests pin, on BOTH loops (non-streaming `runTurn` — Teams — and
 * streaming `chatStream` — web chat):
 *   - the system blocks are identical across the turn's iterations,
 *   - no system block carries the directive,
 *   - the directive rides the newest USER turn, after its tool_result blocks,
 *   - it is said exactly once.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type {
  ChatMessage,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
} from '@omadia/llm-provider';
import { NativeToolRegistry, Orchestrator } from '@omadia/orchestrator';

import { appendTextToLastUserTurn } from '../../packages/harness-orchestrator/src/appendTextToLastUserTurn.js';

/** A fragment of FINALIZE_DIRECTIVE. Matched rather than imported so the
 *  constant stays package-internal. */
const DIRECTIVE_MARK = /Tool-Budget für diesen Turn aufgebraucht/;

const providerCapabilities = {
  tools: true,
  vision: true,
  streaming: true,
  promptCaching: true,
  forcedToolChoice: true,
  parallelToolCalls: true,
} as const;

function usage() {
  return { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

const toolCallResponse: LlmResponse = {
  content: [{ type: 'tool_call', id: 'use-1', name: 'probe', input: {} }],
  finishReason: 'tool_calls',
  providerFinishReason: 'tool_use',
  model: 'test',
  usage: usage(),
};

const textResponse: LlmResponse = {
  content: [{ type: 'text', text: 'best effort answer' }],
  finishReason: 'stop',
  providerFinishReason: 'end_turn',
  model: 'test',
  usage: usage(),
};

/** Captures every request, buffered and streaming, and replays one scripted
 *  response per call. */
function capturingProvider(responses: LlmResponse[]): {
  provider: LlmProvider;
  calls: LlmRequest[];
} {
  const calls: LlmRequest[] = [];
  let idx = 0;
  const next = (): LlmResponse => {
    const res = responses[idx];
    if (res === undefined) {
      throw new Error(`capturingProvider: no scripted response for call ${String(idx + 1)}`);
    }
    idx += 1;
    return res;
  };
  const provider = {
    id: 'anthropic',
    capabilities: providerCapabilities,
    complete: async (req: LlmRequest): Promise<LlmResponse> => {
      calls.push(req);
      return next();
    },
    stream: (req: LlmRequest): AsyncIterable<LlmStreamEvent> => {
      calls.push(req);
      const res = next();
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'final', response: res };
        },
      };
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  };
  return { calls, provider: provider as unknown as LlmProvider };
}

function orchestratorWithProbe(
  provider: LlmProvider,
  opts: { maxToolIterations?: number; maxTurnSeconds?: number; toolLatencyMs?: number } = {},
): Orchestrator {
  const registry = new NativeToolRegistry();
  registry.register('probe', {
    handler: async (): Promise<string> => {
      if (opts.toolLatencyMs !== undefined) {
        await new Promise((r) => setTimeout(r, opts.toolLatencyMs));
      }
      return 'probe-output';
    },
    spec: {
      name: 'probe',
      description: 'probe for testing',
      input_schema: { type: 'object' as const, properties: {}, required: [] },
    },
  });
  return new Orchestrator({
    provider,
    model: 'test',
    maxTokens: 1024,
    // Two iterations: one tool round, then the forced tools-disabled finalize.
    maxToolIterations: opts.maxToolIterations ?? 2,
    ...(opts.maxTurnSeconds !== undefined ? { maxTurnSeconds: opts.maxTurnSeconds } : {}),
    domainTools: [],
    nativeToolRegistry: registry,
  });
}

function textPartsOf(messages: ReadonlyArray<ChatMessage>): string[] {
  return messages.flatMap((m) =>
    m.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])),
  );
}

type RunOpts = Parameters<typeof orchestratorWithProbe>[1];

async function runBuffered(provider: LlmProvider, opts?: RunOpts): Promise<void> {
  await orchestratorWithProbe(provider, opts).runTurn({ userMessage: 'go' });
}

async function runStreaming(provider: LlmProvider, opts?: RunOpts): Promise<void> {
  const stream = orchestratorWithProbe(provider, opts).chatStream({ userMessage: 'go' });
  for await (const _ev of stream) {
    // drain
  }
}

describe('#1212 — the finalize directive rides the conversation, not the system prompt', () => {
  for (const [label, run] of [
    ['non-streaming (runTurn)', runBuffered],
    ['streaming (chatStream)', runStreaming],
  ] as const) {
    it(`${label}: the system blocks are identical across the turn's iterations`, async () => {
      const { provider, calls } = capturingProvider([toolCallResponse, textResponse]);
      await run(provider);

      // The finalize iteration is the one that offers no tools at all.
      const finalCall = calls.find((c) => c.tools === undefined);
      assert.ok(finalCall, 'no tools-disabled finalize call was made');
      assert.ok(calls.length >= 2, `expected at least 2 calls, got ${String(calls.length)}`);
      assert.notEqual(calls[0], finalCall, 'iteration 0 should still offer tools');

      assert.deepEqual(finalCall.system, calls[0]?.system);
      for (const call of calls) {
        const blocks = Array.isArray(call.system) ? call.system : [];
        for (const block of blocks) {
          assert.doesNotMatch(
            block.text,
            DIRECTIVE_MARK,
            'the finalize directive must never reach a system block',
          );
        }
      }
    });

    it(`${label}: the directive is the last block of the newest user turn, once`, async () => {
      const { provider, calls } = capturingProvider([toolCallResponse, textResponse]);
      await run(provider);

      const finalCall = calls.find((c) => c.tools === undefined);
      assert.ok(finalCall);

      const lastTurn = finalCall.messages.at(-1);
      assert.equal(lastTurn?.role, 'user');
      const parts = lastTurn?.content ?? [];
      const tail = parts.at(-1);
      assert.equal(tail?.type, 'text');
      assert.match(tail?.type === 'text' ? tail.text : '', DIRECTIVE_MARK);
      // It rides AFTER the tool_result blocks of that turn — the append-only
      // position the conversation format allows.
      assert.equal(parts.at(-2)?.type, 'tool_result');

      const said = textPartsOf(finalCall.messages).filter((t) => DIRECTIVE_MARK.test(t));
      assert.equal(said.length, 1, 'the directive must be said exactly once');
    });

    it(`${label}: it is still said once when several finalize iterations run`, async () => {
      // The belt-and-braces path the guard exists for: a provider that answers
      // a `tools: []` request with a tool_use stop_reason. The loop dispatches
      // and comes back round, still over budget, so `finalizeThisIter` holds
      // for more than one iteration. A 1 ms turn budget plus a slower tool
      // guarantees at least two of those, whichever iteration first trips it.
      const { provider, calls } = capturingProvider([
        toolCallResponse,
        toolCallResponse,
        textResponse,
      ]);
      await run(provider, {
        maxToolIterations: 3,
        maxTurnSeconds: 0.001,
        toolLatencyMs: 5,
      });

      const disabled = calls.filter((c) => c.tools === undefined);
      assert.ok(
        disabled.length >= 2,
        `expected >= 2 tools-disabled iterations, got ${String(disabled.length)}`,
      );
      const lastCall = calls.at(-1);
      assert.ok(lastCall);
      const said = textPartsOf(lastCall.messages).filter((t) => DIRECTIVE_MARK.test(t));
      assert.equal(said.length, 1, 'the directive must be said exactly once per turn');
    });
  }
});

describe('appendTextToLastUserTurn', () => {
  it('promotes string content to blocks instead of concatenating', () => {
    const messages = [{ role: 'user' as const, content: 'die Frage' }];
    appendTextToLastUserTurn(messages, 'der Hinweis');
    assert.deepEqual(messages, [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'die Frage' },
          { type: 'text', text: 'der Hinweis' },
        ],
      },
    ]);
  });

  it('appends after the existing blocks of a tool_result turn', () => {
    const messages = [
      {
        role: 'user' as const,
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
      },
    ];
    appendTextToLastUserTurn(messages, 'der Hinweis');
    assert.equal(messages[0]?.content.length, 2);
    assert.deepEqual(messages[0]?.content[1], { type: 'text', text: 'der Hinweis' });
  });

  it('pushes a fresh user turn rather than appending to an assistant turn', () => {
    const messages = [
      { role: 'assistant' as const, content: [{ type: 'text', text: 'antwort' }] },
    ];
    appendTextToLastUserTurn(messages, 'der Hinweis');
    assert.equal(messages.length, 2);
    assert.equal(messages[1]?.role, 'user');
    assert.deepEqual(messages[1]?.content, [{ type: 'text', text: 'der Hinweis' }]);
  });

  it('pushes a user turn when there are no messages at all', () => {
    const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [];
    appendTextToLastUserTurn(
      messages as Parameters<typeof appendTextToLastUserTurn>[0],
      'der Hinweis',
    );
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.role, 'user');
  });
});
