/**
 * Canvas-turn latency — the kernel side of the canvas fast path.
 *
 * A canvas turn (`input.canvasSessionId` set) used to pay for machinery the
 * canvas client throws away. These tests pin the four kernel changes:
 *
 *   1. `fixedSystemHint` (the canvas orchestrator's fixed protocol block)
 *      rides the turn's SYSTEM prompt, unmasked — never the user message,
 *      the C1 detector, the plan gate, recall or the session log;
 *   2. the `onBeforeTurn` hook (plan-runner gate + materialiser) does not
 *      fire on a canvas turn;
 *   3. a canvas turn carries a static hint that suspends the start-of-task
 *      `/memories` read (only canvas turns — the memory tool stays wired);
 *   4. the palaia excerpt pass (save-as-memory modal prefill) is skipped on
 *      a canvas turn — the canvas has no such modal.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
} from '@omadia/llm-provider';
import type { ChatTurnInput } from '@omadia/channel-sdk';
import {
  NativeToolRegistry,
  Orchestrator,
  type TurnAnnotation,
  type TurnHookPoint,
  type TurnHookRunner,
} from '@omadia/orchestrator';
import { CANVAS_TURN_MEMORY_HINT } from '@omadia/orchestrator/dist/orchestrator.js';
import type { PromptPiiDetector, PromptPiiSpan } from '@omadia/plugin-api';
import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';

type OrchestratorOptions = ConstructorParameters<typeof Orchestrator>[0];

const providerCapabilities = {
  tools: true,
  vision: true,
  streaming: true,
  promptCaching: true,
  forcedToolChoice: true,
  parallelToolCalls: true,
} as const;

/** A recognisable protocol block, as the canvas orchestrator would send. */
const FIXED_HINT =
  '[canvas-protocol] FIXED-HINT-MARKER-7f3a: publish via canvas_publish_rows, reply with one sentence.';
const USER_MESSAGE = 'Geburtstage im Januar';

function textResponse(text: string): LlmResponse {
  return {
    content: [{ type: 'text', text }],
    finishReason: 'stop',
    providerFinishReason: 'end_turn',
    model: 'test',
    usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };
}

/** Both-path fake: records every main-call request, answers with fixed text. */
function recordingProvider(requests: LlmRequest[]): LlmProvider {
  const answerFor = (req: LlmRequest): LlmResponse => {
    requests.push(req);
    return textResponse('Erledigt.');
  };
  const provider = {
    id: 'anthropic',
    capabilities: providerCapabilities,
    complete: async (req: LlmRequest): Promise<LlmResponse> => answerFor(req),
    stream: (req: LlmRequest): AsyncIterable<LlmStreamEvent> => {
      const response = answerFor(req);
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text_delta', text: 'Erledigt.' } as LlmStreamEvent;
          yield { type: 'final', response } as LlmStreamEvent;
        },
      };
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  };
  return provider as unknown as LlmProvider;
}

function systemText(req: LlmRequest): string {
  const sys = req.system;
  if (sys === undefined) return '';
  return typeof sys === 'string' ? sys : sys.map((b) => b.text).join('\n');
}

interface HookRecord {
  readonly runner: TurnHookRunner;
  readonly calls: Array<{ point: TurnHookPoint; payload: unknown }>;
}

function recordingHooks(): HookRecord {
  const calls: Array<{ point: TurnHookPoint; payload: unknown }> = [];
  return {
    calls,
    runner: {
      async run(point, _ctx, payload): Promise<TurnAnnotation[]> {
        calls.push({ point, payload });
        return [];
      },
    },
  };
}

/** C1 stand-in that records every text it was asked to scan. */
function recordingC1(seen: string[]): PromptPiiDetector {
  return {
    id: 'c1-test',
    async detect(text: string): Promise<readonly PromptPiiSpan[]> {
      seen.push(text);
      return [];
    },
  };
}

interface World {
  readonly orch: Orchestrator;
  readonly requests: LlmRequest[];
  readonly hooks: HookRecord;
  readonly c1Seen: string[];
  readonly logged: Array<{ userMessage: string; assistantAnswer: string }>;
  readonly recallQueries: string[];
  readonly excerptCalls: Array<{ cleanedUserMessage: string }>;
}

function buildWorld(): World {
  const requests: LlmRequest[] = [];
  const hooks = recordingHooks();
  const c1Seen: string[] = [];
  const logged: Array<{ userMessage: string; assistantAnswer: string }> = [];
  const recallQueries: string[] = [];
  const excerptCalls: Array<{ cleanedUserMessage: string }> = [];

  const sessionLogger = {
    log: async (entry: {
      userMessage: string;
      assistantAnswer: string;
    }): Promise<{ turnExternalId: string }> => {
      logged.push({ userMessage: entry.userMessage, assistantAnswer: entry.assistantAnswer });
      return { turnExternalId: `turn:sess:${String(logged.length)}` };
    },
  } as unknown as OrchestratorOptions['sessionLogger'];

  const contextRetriever = {
    assembleForBudget: async (opts: unknown): Promise<unknown> => {
      recallQueries.push(JSON.stringify(opts));
      return {
        text: '',
        included: [],
        excluded: [],
        stats: { candidatePool: 0, compactMode: false, tokensUsed: 0 },
        recalled: undefined,
      };
    },
  } as unknown as OrchestratorOptions['contextRetriever'];

  const excerptExtractor = {
    extract: async (input: { cleanedUserMessage: string }): Promise<undefined> => {
      excerptCalls.push({ cleanedUserMessage: input.cleanedUserMessage });
      return undefined;
    },
  } as unknown as OrchestratorOptions['excerptExtractor'];

  const orch = new Orchestrator({
    provider: recordingProvider(requests),
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 3,
    domainTools: [],
    nativeToolRegistry: new NativeToolRegistry(),
    turnHookRegistry: hooks.runner,
    sessionLogger,
    contextRetriever,
    excerptExtractor,
    privacyGuard: () =>
      createPrivacyGuardService({
        readConfig: (key: string) => (key === 'mask_user_prompt' ? 'on' : undefined),
        c1Detector: recordingC1(c1Seen),
      }),
  });
  return { orch, requests, hooks, c1Seen, logged, recallQueries, excerptCalls };
}

type Path = 'stream' | 'runTurn';

async function runOn(path: Path, orch: Orchestrator, input: ChatTurnInput): Promise<void> {
  if (path === 'stream') {
    for await (const ev of orch.chatStream(input)) void ev;
  } else {
    await orch.runTurn(input);
  }
}

const canvasInput = (extra: Partial<ChatTurnInput> = {}): ChatTurnInput => ({
  userMessage: USER_MESSAGE,
  sessionScope: 'sess-canvas',
  userId: 'u1',
  canvasSessionId: 'canvas-1',
  ...extra,
});

const chatInput = (extra: Partial<ChatTurnInput> = {}): ChatTurnInput => ({
  userMessage: USER_MESSAGE,
  sessionScope: 'sess-chat',
  userId: 'u1',
  ...extra,
});

for (const path of ['stream', 'runTurn'] as const) {
  describe(`canvas turn latency — ${path}`, () => {
    it('fixedSystemHint reaches the system prompt, unmasked, and nothing else', async () => {
      const w = buildWorld();
      await runOn(path, w.orch, canvasInput({ fixedSystemHint: FIXED_HINT }));

      assert.ok(w.requests.length >= 1, 'the main model ran');
      for (const req of w.requests) {
        assert.ok(
          systemText(req).includes(FIXED_HINT),
          'the fixed hint rides the system prompt verbatim (unmasked)',
        );
        assert.ok(
          !JSON.stringify(req.messages).includes('FIXED-HINT-MARKER-7f3a'),
          'the fixed hint is not part of the user message',
        );
      }
      assert.ok(w.c1Seen.length >= 1, 'the C1 detector scanned the user message');
      for (const text of w.c1Seen) {
        assert.ok(!text.includes('FIXED-HINT-MARKER-7f3a'), 'C1 never sees the fixed hint');
      }
      assert.equal(w.logged.length, 1, 'the session log wrote the turn');
      assert.equal(w.logged[0]!.userMessage, USER_MESSAGE, 'the session log gets only the user ask');
      assert.ok(!w.logged[0]!.assistantAnswer.includes('FIXED-HINT-MARKER-7f3a'));
      for (const q of w.recallQueries) {
        assert.ok(!q.includes('FIXED-HINT-MARKER-7f3a'), 'recall never sees the fixed hint');
      }
    });

    it('fixedSystemHint stays out of the plan-gate payload on a non-canvas turn', async () => {
      const w = buildWorld();
      await runOn(path, w.orch, chatInput({ fixedSystemHint: FIXED_HINT }));

      const before = w.hooks.calls.filter((c) => c.point === 'onBeforeTurn');
      assert.equal(before.length, 1, 'a non-canvas turn still fires onBeforeTurn');
      assert.deepEqual(before[0]!.payload, { userMessage: USER_MESSAGE });
      assert.ok(systemText(w.requests[0]!).includes(FIXED_HINT));
    });

    it('a canvas turn does not fire onBeforeTurn (no plan-runner gate)', async () => {
      const w = buildWorld();
      await runOn(path, w.orch, canvasInput());

      const points = w.hooks.calls.map((c) => c.point);
      assert.ok(!points.includes('onBeforeTurn'), `hooks fired: ${points.join(',')}`);
      // The observer hooks still run — they no-op without a plan record.
      assert.ok(points.includes('onAfterTurn'));
    });

    it('the memory-read suspension hint is present only on canvas turns', async () => {
      const canvas = buildWorld();
      await runOn(path, canvas.orch, canvasInput());
      assert.ok(
        systemText(canvas.requests[0]!).includes(CANVAS_TURN_MEMORY_HINT),
        'canvas turn carries the hint',
      );

      const chat = buildWorld();
      await runOn(path, chat.orch, chatInput());
      assert.ok(
        !systemText(chat.requests[0]!).includes(CANVAS_TURN_MEMORY_HINT),
        'a regular chat turn keeps the standing memory-read convention',
      );
    });
  });
}

describe('canvas turn latency — palaia excerpt (stream)', () => {
  it('skips the excerpt pass on a canvas turn', async () => {
    const w = buildWorld();
    await runOn('stream', w.orch, canvasInput());
    assert.equal(w.excerptCalls.length, 0);
  });

  it('still runs the excerpt pass on a regular chat turn', async () => {
    const w = buildWorld();
    await runOn('stream', w.orch, chatInput());
    assert.equal(w.excerptCalls.length, 1);
  });
});
