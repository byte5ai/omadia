/**
 * #1585 — choice cards never appeared. Every Orchestrator build makes its own
 * `AskUserChoiceTool`, but the native-tool registry is one kernel service
 * shared by all builds, and `registerKernelNativeTools` keeps the FIRST build's
 * handler. `dispatchToolInner` (and the subscription-CLI `ToolDispatchService`)
 * dispatched through that handler, so the card was parked on the first build's
 * instance while the turn drained the current one: no card, and every later
 * call in the process answered `choice_card_already_scheduled`.
 *
 * These tests build two orchestrators on one registry (boot publishes
 * `chatAgent@1` twice, and every config save rebuilds) and pin that the
 * second build's turn ends at its own card, on both paths.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type {
  LlmProvider,
  LlmResponse,
  LlmStreamEvent,
} from '@omadia/llm-provider';
import {
  AskUserChoiceTool,
  NativeToolRegistry,
  Orchestrator,
  ToolDispatchService,
  type ChatStreamEvent,
} from '../../packages/harness-orchestrator/src/index.js';

const CHOICE_INPUT = {
  question: 'Welches Jahr?',
  options: [{ label: '2025' }, { label: '2026' }],
};

function toolCallStream(id: string): LlmStreamEvent[] {
  return [
    {
      type: 'final',
      response: {
        content: [{ type: 'tool_call', id, name: 'ask_user_choice', input: CHOICE_INPUT }],
        finishReason: 'tool_calls',
        providerFinishReason: 'tool_use',
        model: 'test',
        usage: { inputTokens: 5, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    } as LlmStreamEvent,
  ];
}

function textStream(text: string): LlmStreamEvent[] {
  return [
    { type: 'text_delta', text },
    {
      type: 'final',
      response: {
        content: [{ type: 'text', text }],
        finishReason: 'stop',
        providerFinishReason: 'end_turn',
        model: 'test',
        usage: { inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    } as LlmStreamEvent,
  ];
}

/** Serves `streams` in order; a turn that runs past the card hits the text. */
function scriptedProvider(streams: LlmStreamEvent[][]): LlmProvider {
  let idx = 0;
  const next = (): LlmStreamEvent[] => {
    const events = streams[idx] ?? textStream('Die Auswahlkarte steht.');
    idx += 1;
    return events;
  };
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
    complete: async (): Promise<LlmResponse> => {
      const final = next().at(-1) as { response: LlmResponse };
      return final.response;
    },
    stream: (): AsyncIterable<LlmStreamEvent> => {
      const events = next();
      return {
        async *[Symbol.asyncIterator]() {
          for (const ev of events) yield ev;
        },
      };
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
}

function build(
  registry: NativeToolRegistry,
  streams: LlmStreamEvent[][],
): { orchestrator: Orchestrator; choiceTool: AskUserChoiceTool } {
  const choiceTool = new AskUserChoiceTool();
  const orchestrator = new Orchestrator({
    provider: scriptedProvider(streams),
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 5,
    domainTools: [],
    nativeToolRegistry: registry,
    askUserChoiceTool: choiceTool,
  });
  return { orchestrator, choiceTool };
}

async function doneOf(orchestrator: Orchestrator): Promise<{ pendingUserChoice?: unknown }> {
  const events: ChatStreamEvent[] = [];
  for await (const ev of orchestrator.chatStream({ userMessage: 'Frag mich nach dem Jahr.' })) {
    events.push(ev);
  }
  const done = events.find((e) => e.type === 'done');
  assert.ok(done, 'no done event');
  return done as never;
}

describe('kernel natives after an orchestrator rebuild (#1585)', () => {
  it('the second build\'s turn ends at its own choice card', async () => {
    const registry = new NativeToolRegistry();
    const first = build(registry, []);
    const second = build(registry, [toolCallStream('t1')]);

    const done = await doneOf(second.orchestrator);

    assert.ok(done.pendingUserChoice, 'the done event must carry the choice card');
    assert.equal(first.choiceTool.hasPending(), false, 'nothing may park on the first build');
  });

  it('a later turn schedules a new card instead of choice_card_already_scheduled', async () => {
    const registry = new NativeToolRegistry();
    build(registry, []);
    const second = build(registry, [toolCallStream('t1'), toolCallStream('t2')]);

    assert.ok((await doneOf(second.orchestrator)).pendingUserChoice);
    assert.ok(
      (await doneOf(second.orchestrator)).pendingUserChoice,
      'the second turn must get its own card',
    );
  });

  it('the subscription-CLI dispatcher lands the card where drainCliTurnCards reads', async () => {
    const registry = new NativeToolRegistry();
    const first = build(registry, []);
    const second = build(registry, []);
    const dispatch = new ToolDispatchService({
      nativeTools: registry,
      domainTools: [],
      kernelNativeHandler: (name) => second.orchestrator.kernelNativeHandler(name),
    });

    const res = await dispatch.dispatch('ask_user_choice', CHOICE_INPUT);

    assert.equal(res.isError, undefined);
    assert.match(res.content, /choice_card_scheduled/);
    assert.ok(second.orchestrator.drainCliTurnCards().pendingUserChoice);
    assert.equal(first.choiceTool.hasPending(), false);
  });

  it('a plugin that owns the name keeps its handler on both paths', async () => {
    const registry = new NativeToolRegistry();
    registry.register('ask_user_choice', {
      handler: async () => 'plugin-choice',
      spec: {
        name: 'ask_user_choice',
        description: 'plugin-owned',
        input_schema: { type: 'object', properties: {} },
      },
    });
    const { orchestrator } = build(registry, []);

    assert.equal(orchestrator.kernelNativeHandler('ask_user_choice'), undefined);
    const dispatch = new ToolDispatchService({
      nativeTools: registry,
      domainTools: [],
      kernelNativeHandler: (name) => orchestrator.kernelNativeHandler(name),
    });
    assert.equal((await dispatch.dispatch('ask_user_choice', {})).content, 'plugin-choice');
  });
});

describe('the shared registry handler after a rebuild (#1585)', () => {
  it('serves the most recent build, for readers outside the turn loop', async () => {
    const registry = new NativeToolRegistry();
    const first = build(registry, []);
    const second = build(registry, []);

    // Sub-agent tool refs and plugin `tools.invoke` read the registry directly.
    const handler = registry.get('ask_user_choice')?.handler;
    assert.ok(handler);
    await handler(CHOICE_INPUT);

    assert.equal(first.choiceTool.hasPending(), false);
    assert.ok(second.orchestrator.drainCliTurnCards().pendingUserChoice);
  });
});
