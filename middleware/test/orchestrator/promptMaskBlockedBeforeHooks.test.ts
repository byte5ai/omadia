/**
 * #1547 — a turn whose prompt mask is blocked tells the user its message "was
 * not sent to the language model". The plan-runner's gate and materialiser
 * send the message to a model from `onBeforeTurn`, which used to fire before
 * the turn masked anything: the turn was refused, but the raw message had
 * already reached the provider. The mask now runs before the hook, on both
 * paths, so a blocked mask means no hook, no model call — and a true notice.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { LlmProvider, LlmRequest, LlmResponse, LlmStreamEvent } from '@omadia/llm-provider';
import { NativeToolRegistry, Orchestrator } from '@omadia/orchestrator';
import type { TurnHookPoint, TurnHookRunner } from '@omadia/orchestrator';
import {
  PROMPT_MASK_BLOCKED_AFTER_HOOKS_ANSWER,
  PROMPT_MASK_BLOCKED_ANSWER,
} from '@omadia/orchestrator/dist/orchestrator.js';
import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';

const capabilities = {
  tools: true,
  vision: true,
  streaming: true,
  promptCaching: true,
  forcedToolChoice: true,
  parallelToolCalls: true,
} as const;

const SECRET = 'Bitte prüfe xxxxxxxxxxxxxxxxxxxxxxxxz';

function recordingProvider(requests: string[]): LlmProvider {
  const answer = (req: LlmRequest): LlmResponse => {
    requests.push(JSON.stringify(req));
    return {
      content: [{ type: 'text', text: 'ok' }],
      finishReason: 'stop',
      providerFinishReason: 'end_turn',
      model: 'test',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  };
  return {
    id: 'anthropic',
    capabilities,
    complete: async (req: LlmRequest) => answer(req),
    stream: (req: LlmRequest): AsyncIterable<LlmStreamEvent> => {
      const response = answer(req);
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'final', response } as LlmStreamEvent;
        },
      };
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
}

/** A plan-runner stand-in: its `onBeforeTurn` sends the raw message to a
 *  model, as the planning gate does. */
function planRunnerHooks(gateRequests: string[]): {
  readonly runner: TurnHookRunner;
  readonly fired: TurnHookPoint[];
} {
  const fired: TurnHookPoint[] = [];
  return {
    fired,
    runner: {
      run(point, _ctx, payload) {
        fired.push(point);
        if (point === 'onBeforeTurn') {
          gateRequests.push(String((payload as { userMessage?: string }).userMessage));
        }
        return Promise.resolve([]);
      },
    },
  };
}

function orchestrator(requests: string[], hooks: TurnHookRunner): Orchestrator {
  return new Orchestrator({
    provider: recordingProvider(requests),
    model: 'test',
    maxTokens: 256,
    maxToolIterations: 2,
    domainTools: [],
    nativeToolRegistry: new NativeToolRegistry(),
    turnHookRegistry: hooks,
    privacyGuard: () => ({
      ...createPrivacyGuardService(),
      maskUserPrompt: async () => ({
        outcome: 'blocked' as const,
        reason: 'test: custom pattern exceeded its runtime budget',
      }),
    }),
  });
}

describe('#1547 — a blocked prompt mask fires no hook', () => {
  it('runTurn: no onBeforeTurn, no model request, the refusal is delivered', async () => {
    const requests: string[] = [];
    const gate: string[] = [];
    const hooks = planRunnerHooks(gate);
    const orch = orchestrator(requests, hooks.runner);

    const result = await orch.runTurn({ userMessage: SECRET, sessionScope: 's-1547', userId: 'u1' });

    assert.equal(result.answer, PROMPT_MASK_BLOCKED_ANSWER);
    assert.deepEqual(gate, [], 'the planning gate must not see the message');
    assert.ok(!hooks.fired.includes('onBeforeTurn'), hooks.fired.join(','));
    assert.equal(requests.length, 0, 'no model request');
  });

  it('chatStream: no onBeforeTurn, no model request, the refusal is delivered', async () => {
    const requests: string[] = [];
    const gate: string[] = [];
    const hooks = planRunnerHooks(gate);
    const orch = orchestrator(requests, hooks.runner);

    let answer: string | undefined;
    for await (const event of orch.chatStream({
      userMessage: SECRET,
      sessionScope: 's-1547-stream',
      userId: 'u1',
    })) {
      if (event.type === 'done') answer = event.answer;
    }

    // Delivered in the turn's language, with the AI disclosure folded in.
    assert.ok(answer?.startsWith(PROMPT_MASK_BLOCKED_ANSWER.split(' / ')[0]!), answer);
    assert.deepEqual(gate, [], 'the planning gate must not see the message');
    assert.ok(!hooks.fired.includes('onBeforeTurn'), hooks.fired.join(','));
    assert.equal(requests.length, 0, 'no model request');
  });

  it('a turn whose mask passes still fires onBeforeTurn', async () => {
    const requests: string[] = [];
    const gate: string[] = [];
    const hooks = planRunnerHooks(gate);
    const orch = new Orchestrator({
      provider: recordingProvider(requests),
      model: 'test',
      maxTokens: 256,
      maxToolIterations: 2,
      domainTools: [],
      nativeToolRegistry: new NativeToolRegistry(),
      turnHookRegistry: hooks.runner,
      privacyGuard: () => createPrivacyGuardService(),
    });
    for await (const event of orch.chatStream({ userMessage: 'Hallo', sessionScope: 's-ok', userId: 'u1' })) {
      void event;
    }
    assert.deepEqual(gate, ['Hallo']);
    assert.equal(requests.length, 1);
  });

  it('a mask that blocks after the hook fired does not claim the message stayed unsent', async () => {
    for (const path of ['runTurn', 'chatStream'] as const) {
      const requests: string[] = [];
      const gate: string[] = [];
      const hooks = planRunnerHooks(gate);
      const orch = new Orchestrator({
        provider: recordingProvider(requests),
        model: 'test',
        maxTokens: 256,
        maxToolIterations: 2,
        domainTools: [],
        nativeToolRegistry: new NativeToolRegistry(),
        turnHookRegistry: hooks.runner,
        privacyGuard: () => ({
          ...createPrivacyGuardService(),
          // The message passes; the replayed answer (after the hook) blocks.
          maskReplayedAnswer: async () => ({
            outcome: 'blocked' as const,
            reason: 'test: custom pattern exceeded its runtime budget',
          }),
        }),
      });
      const input = {
        userMessage: 'Und weiter?',
        sessionScope: `s-after-${path}`,
        userId: 'u1',
        priorTurns: [{ userMessage: 'Kontakt?', assistantAnswer: 'Kontakt: a.b@firma.example' }],
      };
      let answer: string | undefined;
      if (path === 'runTurn') {
        answer = (await orch.runTurn(input)).answer;
      } else {
        for await (const event of orch.chatStream(input)) {
          if (event.type === 'done') answer = event.answer;
        }
      }
      assert.deepEqual(gate, ['Und weiter?'], `${path}: the hook ran`);
      assert.equal(requests.length, 0, `${path}: no answer-model request`);
      const [de] = PROMPT_MASK_BLOCKED_AFTER_HOOKS_ANSWER.split(' / ');
      assert.ok(
        answer === PROMPT_MASK_BLOCKED_AFTER_HOOKS_ANSWER || answer?.startsWith(de!),
        `${path}: ${String(answer)}`,
      );
      assert.ok(!answer?.includes('nicht an das Sprachmodell gesendet'), path);
    }
  });
});
