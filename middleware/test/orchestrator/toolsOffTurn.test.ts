/**
 * #2217 / ADR 0043 — `ChatTurnInput.toolsOff`: a turn the model answers
 * without any tool. Both tool loops send no tool definitions and say so in the
 * per-turn hint; a tool call the model emits anyway is never dispatched.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
} from '@omadia/llm-provider';
import {
  AskUserChoiceTool,
  NativeToolRegistry,
  Orchestrator,
  type TurnAnnotation,
  type TurnHookPoint,
  type TurnHookRunner,
} from '../../packages/harness-orchestrator/src/index.js';
import {
  TOOLS_OFF_DIRECTIVE,
  ToolsOffViolationError,
  assertNoToolUseInToolsOffTurn,
} from '../../packages/harness-orchestrator/src/toolsOffTurn.js';
import { withCorrectionHint } from '../../packages/harness-orchestrator/src/verifierEnforceStream.js';

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

const textResponse: LlmResponse = {
  content: [{ type: 'text', text: 'done' }],
  finishReason: 'stop',
  providerFinishReason: 'end_turn',
  model: 'test',
  usage,
} as unknown as LlmResponse;

const toolUseResponse: LlmResponse = {
  content: [{ type: 'tool_call', id: 'tu_1', name: 'ask_user_choice', input: {} }],
  finishReason: 'tool_use',
  providerFinishReason: 'tool_use',
  model: 'test',
  usage,
} as unknown as LlmResponse;

function recordingProvider(seen: LlmRequest[], response: LlmResponse = textResponse): LlmProvider {
  return {
    id: 'anthropic',
    capabilities: {
      tools: true,
      vision: true,
      streaming: true,
      promptCaching: true,
      forcedToolChoice: true,
      parallelToolCalls: true,
    },
    complete: async (req: LlmRequest): Promise<LlmResponse> => {
      seen.push(req);
      return response;
    },
    stream: (req: LlmRequest): AsyncIterable<LlmStreamEvent> => {
      seen.push(req);
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'final', response } as LlmStreamEvent;
        },
      };
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
}

function orchestratorWith(
  seen: LlmRequest[],
  response?: LlmResponse,
  turnHookRegistry?: TurnHookRunner,
): Orchestrator {
  return new Orchestrator({
    ...(turnHookRegistry ? { turnHookRegistry } : {}),
    provider: recordingProvider(seen, response),
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 5,
    domainTools: [],
    nativeToolRegistry: new NativeToolRegistry(),
    askUserChoiceTool: new AskUserChoiceTool(),
  });
}

const systemText = (request: LlmRequest): string => JSON.stringify(request.system ?? '');

describe('toolsOff turns (#2217)', () => {
  it('a normal turn offers tools — the baseline the flag removes', async () => {
    const seen: LlmRequest[] = [];
    await orchestratorWith(seen).chat({ userMessage: 'go' });
    assert.ok((seen[0]?.tools ?? []).length > 0, 'baseline turn offered no tools');
    assert.equal(systemText(seen[0]!).includes('TURN OHNE WERKZEUGE'), false);
  });

  it('buffered loop: no tool definitions, and the turn is told so', async () => {
    const seen: LlmRequest[] = [];
    const answer = await orchestratorWith(seen).chat({ userMessage: 'go', toolsOff: true });
    assert.equal(answer.text.includes('done'), true);
    assert.ok(seen.length > 0);
    for (const request of seen) {
      assert.deepEqual(request.tools ?? [], []);
      assert.equal(request.toolChoice, undefined);
    }
    assert.ok(systemText(seen[0]!).includes('TURN OHNE WERKZEUGE'));
  });

  it('streaming loop: no tool definitions, and the turn is told so', async () => {
    const seen: LlmRequest[] = [];
    for await (const _ev of orchestratorWith(seen).chatStream({ userMessage: 'go', toolsOff: true })) {
      // drain
    }
    assert.ok(seen.length > 0);
    for (const request of seen) assert.deepEqual(request.tools ?? [], []);
    assert.ok(systemText(seen[0]!).includes('TURN OHNE WERKZEUGE'));
  });

  it('a tool call the model sends anyway is refused, never dispatched', async () => {
    const seen: LlmRequest[] = [];
    await assert.rejects(
      orchestratorWith(seen, toolUseResponse).chat({ userMessage: 'go', toolsOff: true }),
      (err: unknown) => err instanceof ToolsOffViolationError || /without tools/.test(String(err)),
    );
    assert.equal(seen.length, 1, 'no second request: nothing was dispatched to answer');
  });

  it('streaming: a tool call the model sends anyway is refused, never dispatched', async () => {
    const seen: LlmRequest[] = [];
    let refused = false;
    try {
      for await (const ev of orchestratorWith(seen, toolUseResponse).chatStream({ userMessage: 'go', toolsOff: true })) {
        if (ev.type === 'error' && /without tools/.test(JSON.stringify(ev))) refused = true;
      }
    } catch (err) {
      refused = err instanceof ToolsOffViolationError || /without tools/.test(String(err));
    }
    assert.ok(refused, 'the tool call was not refused');
    assert.equal(seen.length, 1, 'no second request: nothing was dispatched to answer');
  });

  it('fires no onBeforeTurn hook: the plan-runner writes no Plan for it', async () => {
    const points: TurnHookPoint[] = [];
    const runner: TurnHookRunner = {
      async run(point): Promise<TurnAnnotation[]> {
        points.push(point);
        return [];
      },
    };
    await orchestratorWith([], undefined, runner).chat({ userMessage: 'go', toolsOff: true });
    for await (const _ev of orchestratorWith([], undefined, runner).chatStream({ userMessage: 'go', toolsOff: true })) {
      // drain
    }
    assert.equal(points.includes('onBeforeTurn'), false, points.join(', '));
    // The baseline does fire it, so the assertion above means something.
    await orchestratorWith([], undefined, runner).chat({ userMessage: 'go' });
    assert.ok(points.includes('onBeforeTurn'));
  });
});

describe('toolsOffTurn helpers', () => {
  it('the guard only bites in a tool-less turn with a tool call', () => {
    assert.doesNotThrow(() => assertNoToolUseInToolsOffTurn({ toolsOff: true }, []));
    assert.doesNotThrow(() => assertNoToolUseInToolsOffTurn({}, [{ name: 'x' }]));
    assert.throws(() => assertNoToolUseInToolsOffTurn({ toolsOff: true }, [{ name: 'x' }]), ToolsOffViolationError);
  });

  it('the verifier retry keeps the turn tool-less', () => {
    const retry = withCorrectionHint({ userMessage: 'x', toolsOff: true }, 'Korrektur');
    assert.equal(retry.toolsOff, true);
  });

  it('the directive is static prose', () => {
    assert.ok(TOOLS_OFF_DIRECTIVE.startsWith('# TURN OHNE WERKZEUGE'));
  });
});
