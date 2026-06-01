import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type Anthropic from '@anthropic-ai/sdk';
import {
  NativeToolRegistry,
  Orchestrator,
  type TurnHookPoint,
  type TurnHookRunner,
} from '@omadia/orchestrator';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEvent = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMessage = any;

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
    async run(point, _ctx, payload): Promise<void> {
      points.push(point);
      payloads.push(payload);
    },
  };
  return { runner, points, payloads };
}

function buildOrchestrator(
  client: Anthropic,
  registry: NativeToolRegistry,
  runner: TurnHookRunner,
): Orchestrator {
  return new Orchestrator({
    client,
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
  events: AnyEvent[];
  finalMessage: AnyMessage;
}

function fakeStreamClient(streams: ScriptedStream[]): Anthropic {
  let idx = 0;
  const client = {
    messages: {
      stream: (_req: AnyMessage): AnyMessage => {
        const fake = streams[idx]!;
        idx += 1;
        return {
          async *[Symbol.asyncIterator]() {
            for (const ev of fake.events) yield ev;
          },
          async finalMessage() {
            return fake.finalMessage;
          },
        };
      },
    },
  };
  return client as unknown as Anthropic;
}

function streamWithTool(id: string, name: string): ScriptedStream {
  return {
    events: [
      {
        type: 'message_start',
        message: { id: 'm-tools', usage: { input_tokens: 50, output_tokens: 0 } },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id, name, input: {} },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{}' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 4 },
      },
      { type: 'message_stop' },
    ],
    finalMessage: {
      id: 'm-tools',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'tool_use', id, name, input: {} }],
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 50,
        output_tokens: 4,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  };
}

const finalTextStream: ScriptedStream = {
  events: [
    {
      type: 'message_start',
      message: { id: 'm-text', usage: { input_tokens: 100, output_tokens: 0 } },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'done' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 1 },
    },
    { type: 'message_stop' },
  ],
  finalMessage: {
    id: 'm-text',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'done' }],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 100,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  },
};

// --- non-streaming fakes -----------------------------------------------------

function fakeCreateClient(messages: AnyMessage[]): Anthropic {
  let idx = 0;
  const client = {
    messages: {
      create: async (_req: AnyMessage, _opts?: AnyMessage): Promise<AnyMessage> => {
        const m = messages[idx];
        idx += 1;
        return m;
      },
    },
  };
  return client as unknown as Anthropic;
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
    const client = fakeStreamClient([
      streamWithTool('use-1', 'only_tool'),
      finalTextStream,
    ]);
    const { runner, points, payloads } = recordingRunner();
    const orch = buildOrchestrator(client, registry, runner);

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

  it('non-streaming runTurn: fires onBeforeTurn → onAfterToolCall → onAfterTurn', async () => {
    const registry = new NativeToolRegistry();
    registry.register('only_tool', {
      handler: async (): Promise<string> => 'only-output',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spec: minimalSpec('only_tool') as any,
    });
    const client = fakeCreateClient([
      msgWithTool('u1', 'only_tool'),
      msgWithText('done'),
    ]);
    const { runner, points, payloads } = recordingRunner();
    const orch = buildOrchestrator(client, registry, runner);

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
    const client = fakeCreateClient([msgWithText('done')]);
    const { runner, points, payloads } = recordingRunner();
    const orch = new Orchestrator({
      client,
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
    const client = fakeCreateClient([msgWithText('hi')]);
    const orch = new Orchestrator({
      client,
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
