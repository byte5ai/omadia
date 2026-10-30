/**
 * The serial legs before a chat turn's first model call, measured live on a
 * trivial web-chat turn (~25 s end to end): the plan-runner's two Haiku calls
 * in `onBeforeTurn`, the recall plus its C1 scan, and — when the memory tree
 * is still empty — the model's own opening `/memories` view that only learned
 * "does not exist". Pinned here, on both paths:
 *
 *   1. the recall starts BEFORE `onBeforeTurn` and is awaited after it, so
 *      the two overlap instead of adding up;
 *   2. `onBeforeTurn` carries the fast-path verdict (`routeHint`) so the
 *      plan-runner can skip its gate;
 *   3. an absent `/memories` root is prefetched as an EMPTY index — the hint
 *      tells the model so, and no opening view round is paid.
 *
 * Diagnosing a failure of (1): the hook gate is released by the retriever,
 * so a sequential regression (hook first, then recall) shows up as the hook
 * timing out (`HOOK_TIMEOUT_MS`) and `released === false` — not as a hang.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { ChatTurnInput } from '@omadia/channel-sdk';
import type { LlmProvider, LlmRequest, LlmResponse, LlmStreamEvent } from '@omadia/llm-provider';
import type { MemoryToolHandler } from '@omadia/memory';
import {
  NativeToolRegistry,
  Orchestrator,
  type TurnAnnotation,
  type TurnHookPoint,
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

function recordingProvider(requests: LlmRequest[]): LlmProvider {
  const answer = (req: LlmRequest): LlmResponse => {
    requests.push(req);
    return {
      content: [{ type: 'text', text: 'Erledigt.' }],
      finishReason: 'stop',
      providerFinishReason: 'end_turn',
      model: 'test',
      usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  };
  return {
    id: 'anthropic',
    capabilities: CAPS,
    complete: async (req: LlmRequest): Promise<LlmResponse> => answer(req),
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
}

function systemText(req: LlmRequest): string {
  const sys = req.system;
  if (sys === undefined) return '';
  return typeof sys === 'string' ? sys : sys.map((b) => b.text).join('\n');
}

/** Hook runner that records the payload and, on `onBeforeTurn`, waits for
 *  `release()` — the retriever releases it, so the hook can only resolve
 *  once the recall is under way. A sequential implementation (hook first,
 *  then recall) would never release it: the test then fails on `HOOK_TIMEOUT`
 *  instead of hanging. */
interface Hooks {
  readonly runner: TurnHookRunner;
  readonly calls: Array<{ point: TurnHookPoint; payload: unknown }>;
  /** True once the hook resolved by `release()`, not by the timeout. */
  released: boolean;
  release(): void;
}

const HOOK_TIMEOUT_MS = 2000;

function gatedHooks(): Hooks {
  const calls: Hooks['calls'] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const hooks: Hooks = {
    calls,
    released: false,
    release: () => {
      hooks.released = true;
      release();
    },
    runner: {
      async run(point, _ctx, payload): Promise<TurnAnnotation[]> {
        calls.push({ point, payload });
        if (point === 'onBeforeTurn') {
          await Promise.race([
            gate,
            new Promise<void>((resolve) => setTimeout(resolve, HOOK_TIMEOUT_MS)),
          ]);
        }
        return [];
      },
    },
  };
  return hooks;
}

interface World {
  readonly orch: Orchestrator;
  readonly requests: LlmRequest[];
  readonly hooks: Hooks;
  readonly recalls: number[];
}

function buildWorld(memoryAnswer: string): World {
  const requests: LlmRequest[] = [];
  const recalls: number[] = [];
  const hooks = gatedHooks();
  const contextRetriever = {
    assembleForBudget: async (): Promise<unknown> => {
      recalls.push(Date.now());
      // The recall reached the retriever: let the hook resolve.
      hooks.release();
      return {
        text: 'Frühere Unterhaltung: nichts Relevantes.',
        included: [],
        excluded: [],
        stats: { candidatePool: 0, compactMode: false, tokensUsed: 0 },
        recalled: undefined,
      };
    },
  } as unknown as OrchestratorOptions['contextRetriever'];
  const memoryToolHandler = {
    handle: async (): Promise<string> => memoryAnswer,
  } as unknown as MemoryToolHandler;
  const orch = new Orchestrator({
    provider: recordingProvider(requests),
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 3,
    domainTools: [],
    nativeToolRegistry: new NativeToolRegistry(),
    turnHookRegistry: hooks.runner,
    contextRetriever,
    memoryToolHandler,
  });
  return { orch, requests, hooks, recalls };
}

const NOT_FOUND = 'The path /memories does not exist. Please provide a valid path.';

const input = (extra: Partial<ChatTurnInput> = {}): ChatTurnInput => ({
  userMessage: 'Was geht morgen in Frankfurt ab?',
  sessionScope: 'sess-overlap',
  userId: 'u1',
  ...extra,
});

type Path = 'stream' | 'runTurn';

async function runOn(path: Path, w: World, turn: ChatTurnInput): Promise<void> {
  if (path === 'stream') {
    for await (const ev of w.orch.chatStream(turn)) void ev;
  } else {
    await w.orch.runTurn(turn);
  }
}

for (const path of ['stream', 'runTurn'] as const) {
  describe(`turn start overlap — ${path}`, () => {
    it('the recall is under way while onBeforeTurn is still running', async () => {
      const w = buildWorld(NOT_FOUND);
      await runOn(path, w, input());
      const before = w.hooks.calls.find((c) => c.point === 'onBeforeTurn');
      assert.ok(before, 'onBeforeTurn fired');
      assert.ok(w.hooks.released, 'the retriever released the hook — the recall ran alongside it');
      assert.equal(w.recalls.length, 1, 'and exactly once for the turn');
      assert.ok(w.requests.length >= 1, 'the model ran');
      const prompt = systemText(w.requests[0]!);
      assert.ok(prompt.includes('Frühere Unterhaltung'), 'the recalled text reached the prompt');
    });

    it('onBeforeTurn carries the fast-path verdict as routeHint', async () => {
      const w = buildWorld(NOT_FOUND);
      await runOn(path, w, input({ routeHint: 'simple' }));
      const before = w.hooks.calls.find((c) => c.point === 'onBeforeTurn');
      assert.ok(before, 'onBeforeTurn fired');
      assert.equal((before.payload as { routeHint?: string }).routeHint, 'simple');
    });

    it('without a verdict the payload has no routeHint', async () => {
      const w = buildWorld(NOT_FOUND);
      await runOn(path, w, input());
      const before = w.hooks.calls.find((c) => c.point === 'onBeforeTurn');
      assert.ok(before, 'onBeforeTurn fired');
      assert.ok(!('routeHint' in (before.payload as object)), 'no routeHint key');
    });

    it('an absent /memories root rides the hint as an empty index', async () => {
      const w = buildWorld(NOT_FOUND);
      await runOn(path, w, input());
      const prompt = systemText(w.requests[0]!);
      assert.ok(prompt.includes('MEMORY-INDEX'), 'the prefetched index block is in the hint');
      assert.ok(prompt.includes('/memories ist leer'), 'and says the tree is empty (#1635)');
    });
  });
}
