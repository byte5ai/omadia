import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type {
  ContentPart,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
} from '@omadia/llm-provider';
import {
  NativeToolRegistry,
  Orchestrator,
  type TurnAnnotation,
  type TurnHookPoint,
  type TurnHookRunner,
} from '@omadia/orchestrator';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEvent = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMessage = any;

const providerCapabilities = {
  tools: true,
  vision: true,
  streaming: true,
  promptCaching: true,
  forcedToolChoice: true,
  parallelToolCalls: true,
} as const;

/** Map an Anthropic-shaped scripted message ({ content blocks, stop_reason,
 *  usage }) to a neutral `LlmResponse` — the create-path fake returns this and
 *  the orchestrator reads it back via `fromLlmResponse`. */
function toLlmResponse(msg: AnyMessage): LlmResponse {
  const content: ContentPart[] = (msg.content as AnyEvent[]).map((block) => {
    if (block.type === 'text') {
      return { type: 'text', text: block.text as string };
    }
    if (block.type === 'tool_use') {
      return {
        type: 'tool_call',
        id: block.id as string,
        name: block.name as string,
        input: block.input,
      };
    }
    throw new Error(`Unsupported stub block type: ${String(block.type)}`);
  });
  const stopReason = msg.stop_reason as string;
  return {
    content,
    finishReason:
      stopReason === 'tool_use'
        ? 'tool_calls'
        : stopReason === 'max_tokens'
          ? 'max_tokens'
          : 'stop',
    providerFinishReason: stopReason,
    model: (msg.model as string | undefined) ?? 'test',
    usage: {
      inputTokens: (msg.usage?.input_tokens as number | undefined) ?? 0,
      outputTokens: (msg.usage?.output_tokens as number | undefined) ?? 0,
      cacheReadTokens:
        (msg.usage?.cache_read_input_tokens as number | undefined) ?? 0,
      cacheWriteTokens:
        (msg.usage?.cache_creation_input_tokens as number | undefined) ?? 0,
    },
  };
}

const minimalSpec = (name: string): Record<string, unknown> => ({
  name,
  description: `${name} for testing`,
  input_schema: { type: 'object' as const, properties: {}, required: [] },
});

interface Recorder {
  runner: TurnHookRunner;
  points: TurnHookPoint[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payloads: any[];
}

function recordingRunner(): Recorder {
  const points: TurnHookPoint[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payloads: any[] = [];
  const runner: TurnHookRunner = {
    async run(point, _ctx, payload): Promise<TurnAnnotation[]> {
      points.push(point);
      payloads.push(payload);
      return [];
    },
  };
  return { runner, points, payloads };
}

function buildOrchestrator(
  provider: LlmProvider,
  registry: NativeToolRegistry,
  runner: TurnHookRunner,
): Orchestrator {
  return new Orchestrator({
    provider,
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 5,
    domainTools: [],
    nativeToolRegistry: registry,
    turnHookRegistry: runner,
  });
}

// --- streaming fakes (mirror test/orchestrator/parallelTool.test.ts) ---------

interface ScriptedStream {
  events: LlmStreamEvent[];
}

function fakeStreamProvider(streams: ScriptedStream[]): LlmProvider {
  let idx = 0;
  const provider = {
    id: 'anthropic',
    capabilities: providerCapabilities,
    complete: async (): Promise<LlmResponse> => {
      throw new Error('fakeStreamProvider: complete() not scripted');
    },
    stream: (_req: LlmRequest): AsyncIterable<LlmStreamEvent> => {
      const fake = streams[idx]!;
      idx += 1;
      return {
        async *[Symbol.asyncIterator]() {
          for (const ev of fake.events) yield ev;
        },
      };
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  };
  return provider as unknown as LlmProvider;
}

function streamWithTool(id: string, name: string): ScriptedStream {
  return {
    events: [
      { type: 'tool_use_start' },
      { type: 'tool_input_delta', text: '{}' },
      {
        type: 'final',
        response: {
          content: [{ type: 'tool_call', id, name, input: {} }],
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
      },
    ],
  };
}

const finalTextStream: ScriptedStream = {
  events: [
    { type: 'text_delta', text: 'done' },
    {
      type: 'final',
      response: {
        content: [{ type: 'text', text: 'done' }],
        finishReason: 'stop',
        providerFinishReason: 'end_turn',
        model: 'test',
        usage: {
          inputTokens: 100,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
    },
  ],
};

// --- non-streaming fakes -----------------------------------------------------

function fakeCreateProvider(messages: AnyMessage[]): LlmProvider {
  let idx = 0;
  const provider = {
    id: 'anthropic',
    capabilities: providerCapabilities,
    complete: async (_req: LlmRequest): Promise<LlmResponse> => {
      const m = messages[idx];
      idx += 1;
      return toLlmResponse(m);
    },
    stream: (): AsyncIterable<LlmStreamEvent> => {
      throw new Error('fakeCreateProvider: stream() not scripted');
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  };
  return provider as unknown as LlmProvider;
}

const msgWithTool = (id: string, name: string): AnyMessage => ({
  id: 'm1',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'tool_use', id, name, input: {} }],
  stop_reason: 'tool_use',
  usage: {
    input_tokens: 10,
    output_tokens: 2,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
});

const msgWithText = (text: string): AnyMessage => ({
  id: 'm2',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
  usage: {
    input_tokens: 10,
    output_tokens: 1,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
});

describe('Orchestrator turn hooks (#133 E0)', () => {
  it('streaming: fires onBeforeTurn → onAfterToolCall → onAfterTurn', async () => {
    const registry = new NativeToolRegistry();
    registry.register('only_tool', {
      handler: async (): Promise<string> => 'only-output',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spec: minimalSpec('only_tool') as any,
    });
    const provider = fakeStreamProvider([
      streamWithTool('use-1', 'only_tool'),
      finalTextStream,
    ]);
    const { runner, points, payloads } = recordingRunner();
    const orch = buildOrchestrator(provider, registry, runner);

    for await (const _ of orch.chatStream({ userMessage: 'go' })) {
      void _;
    }

    assert.deepEqual(points, ['onBeforeTurn', 'onAfterToolCall', 'onAfterTurn']);
    assert.equal(payloads[0].userMessage, 'go');
    const afterTool = payloads[points.indexOf('onAfterToolCall')];
    assert.equal(afterTool.toolName, 'only_tool');
    assert.equal(afterTool.toolResult, 'only-output');
    assert.equal(payloads[points.indexOf('onAfterTurn')].assistantAnswer, 'done');
  });

  it('streaming: emits a turn_annotation event (first) for a hook annotation (#133 E9)', async () => {
    const registry = new NativeToolRegistry();
    const provider = fakeStreamProvider([finalTextStream]);
    const runner: TurnHookRunner = {
      async run(point): Promise<TurnAnnotation[]> {
        return point === 'onBeforeTurn'
          ? [{ channel: 'plan', payload: { hi: 1 } }]
          : [];
      },
    };
    const orch = buildOrchestrator(provider, registry, runner);

    const events: AnyEvent[] = [];
    for await (const e of orch.chatStream({ userMessage: 'go' })) events.push(e);

    const annIdx = events.findIndex((e) => e.type === 'turn_annotation');
    const doneIdx = events.findIndex((e) => e.type === 'done');
    assert.ok(annIdx >= 0, 'a turn_annotation event should be emitted');
    assert.equal(events[annIdx].channel, 'plan');
    assert.deepEqual(events[annIdx].payload, { hi: 1 });
    // onBeforeTurn is unbounded → the annotation precedes the done event.
    assert.ok(annIdx < doneIdx, 'annotation should arrive before done');
  });

  it('non-streaming runTurn: fires onBeforeTurn → onAfterToolCall → onAfterTurn', async () => {
    const registry = new NativeToolRegistry();
    registry.register('only_tool', {
      handler: async (): Promise<string> => 'only-output',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spec: minimalSpec('only_tool') as any,
    });
    const provider = fakeCreateProvider([
      msgWithTool('u1', 'only_tool'),
      msgWithText('done'),
    ]);
    const { runner, points, payloads } = recordingRunner();
    const orch = buildOrchestrator(provider, registry, runner);

    const result = await orch.runTurn({ userMessage: 'go' });

    assert.equal(result.answer, 'done');
    assert.deepEqual(points, ['onBeforeTurn', 'onAfterToolCall', 'onAfterTurn']);
    const afterTool = payloads[points.indexOf('onAfterToolCall')];
    assert.equal(afterTool.toolName, 'only_tool');
    assert.equal(afterTool.toolResult, 'only-output');
    assert.equal(payloads[points.indexOf('onAfterTurn')].assistantAnswer, 'done');
  });

  it('onAfterTurn forwards the persisted Turn node id as turnExternalId (#133 E8)', async () => {
    const STUB_TURN = 'turn:sess-1:2026-06-01T00:00:00.000Z';
    // Minimal SessionLogger stub: just hand back a persisted Turn id so the
    // orchestrator's onAfterTurn can surface it to observers (plan-runner).
    const sessionLogger = {
      log: async (): Promise<{ turnExternalId: string }> => ({
        turnExternalId: STUB_TURN,
      }),
    } as unknown as ConstructorParameters<typeof Orchestrator>[0]['sessionLogger'];

    const registry = new NativeToolRegistry();
    const provider = fakeCreateProvider([msgWithText('done')]);
    const { runner, points, payloads } = recordingRunner();
    const orch = new Orchestrator({
      provider,
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 5,
      domainTools: [],
      nativeToolRegistry: registry,
      turnHookRegistry: runner,
      sessionLogger,
    });

    const result = await orch.runTurn({ userMessage: 'go', sessionScope: 'sess-1' });

    assert.equal(result.turnId, STUB_TURN);
    const after = payloads[points.indexOf('onAfterTurn')];
    assert.equal(after.turnExternalId, STUB_TURN);
  });

  it('no registry: turn runs normally, no hooks fired', async () => {
    const registry = new NativeToolRegistry();
    const provider = fakeCreateProvider([msgWithText('hi')]);
    const orch = new Orchestrator({
      provider,
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 5,
      domainTools: [],
      nativeToolRegistry: registry,
    });
    const result = await orch.runTurn({ userMessage: 'go' });
    assert.equal(result.answer, 'hi');
  });
});
