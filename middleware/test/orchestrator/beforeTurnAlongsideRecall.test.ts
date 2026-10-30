/**
 * `onBeforeTurn` (the plan-runner's Haiku gate + materialiser, ~4 s live)
 * and recall + its C1 mask (~6 s live) used to run one after the other before
 * the first model call. They are independent: the hook is now fired at the
 * same point (after the wire mask, #1547) and awaited alongside recall. Pinned
 * here: recall starts while the hook is still running, the model starts only
 * once both settled, and the plan annotation is still the first stream event.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { ChatStreamEvent, ChatTurnInput } from '@omadia/channel-sdk';
import type { LlmProvider, LlmRequest, LlmResponse, LlmStreamEvent } from '@omadia/llm-provider';
import {
  NativeToolRegistry,
  Orchestrator,
  type TurnAnnotation,
  type TurnHookRunner,
} from '@omadia/orchestrator';

type OrchestratorOptions = ConstructorParameters<typeof Orchestrator>[0];

const CAPS = {
  tools: true,
  vision: true,
  streaming: true,
  promptCaching: true,
  forcedToolChoice: true,
  parallelToolCalls: true,
} as const;

const PLAN: TurnAnnotation = { channel: 'plan', payload: { steps: 3 } };

/** Hook waits (bounded) until recall has started; records whether it did. */
function world() {
  const order: string[] = [];
  let recallStarted: (() => void) | undefined;
  const recallStart = new Promise<void>((resolve) => {
    recallStarted = resolve;
  });
  const hooks: TurnHookRunner = {
    async run(point): Promise<TurnAnnotation[]> {
      if (point !== 'onBeforeTurn') return [];
      order.push('hook:start');
      const overlapped = await Promise.race([
        recallStart.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 300)),
      ]);
      order.push(overlapped ? 'hook:end(overlapped)' : 'hook:end(serial)');
      return [PLAN];
    },
  };
  const contextRetriever = {
    assembleForBudget: async (): Promise<unknown> => {
      order.push('recall:start');
      recallStarted?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('recall:end');
      return {
        text: '## Letzte Turns in diesem Chat\nvorher',
        included: [],
        excluded: [],
        stats: { candidatePool: 0, compactMode: false, tokensUsed: 0 },
        recalled: undefined,
      };
    },
  } as unknown as OrchestratorOptions['contextRetriever'];
  const answer = (req: LlmRequest): LlmResponse => {
    void req;
    order.push('model');
    return {
      content: [{ type: 'text', text: 'Erledigt.' }],
      finishReason: 'stop',
      providerFinishReason: 'end_turn',
      model: 'test',
      usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  };
  const provider = {
    id: 'anthropic',
    capabilities: CAPS,
    complete: async (req: LlmRequest) => answer(req),
    stream: (req: LlmRequest): AsyncIterable<LlmStreamEvent> => {
      const response = answer(req);
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text_delta', text: 'Erledigt.' } as LlmStreamEvent;
          yield { type: 'final', response } as LlmStreamEvent;
        },
      };
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
  const orch = new Orchestrator({
    provider,
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 3,
    domainTools: [],
    nativeToolRegistry: new NativeToolRegistry(),
    turnHookRegistry: hooks,
    contextRetriever,
  });
  return { orch, order };
}

const input: ChatTurnInput = { userMessage: 'Offene Posten je Monat?', sessionScope: 'sess-1', userId: 'u1' };

function assertOverlapped(order: string[]): void {
  assert.ok(order.includes('hook:end(overlapped)'), `recall ran while the hook was pending: ${order.join(' → ')}`);
  const model = order.indexOf('model');
  assert.ok(model > order.indexOf('hook:end(overlapped)'), 'the model starts after the hook settled');
  assert.ok(model > order.indexOf('recall:end'), 'the model starts after recall settled');
}

describe('onBeforeTurn runs alongside recall', () => {
  it('stream: overlapped, and the plan annotation is still the first event', async () => {
    const { orch, order } = world();
    const events: ChatStreamEvent[] = [];
    for await (const ev of orch.chatStream(input)) events.push(ev);
    assertOverlapped(order);
    const first = events.find((e) => e.type !== 'iteration_start');
    assert.equal(first?.type, 'turn_annotation');
    assert.deepEqual((first as { channel?: string }).channel, 'plan');
  });

  it('runTurn: overlapped', async () => {
    const { orch, order } = world();
    await orch.runTurn(input);
    assertOverlapped(order);
  });

  it('a canvas turn fires no onBeforeTurn at all (unchanged)', async () => {
    const { orch, order } = world();
    for await (const ev of orch.chatStream({ ...input, canvasSessionId: 'c1' })) void ev;
    assert.ok(!order.some((o) => o.startsWith('hook:')));
  });
});
