import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { LocalSubAgentTool } from '@omadia/plugin-api';

import { createCliSubAgent } from '../../packages/harness-orchestrator/src/cliSubAgent.js';
import type {
  CliChatAgentDeps,
  CliChatHooks,
  CliUsage,
} from '../../packages/harness-orchestrator/src/cliChatAgent.js';
import type {
  ChatStreamEvent,
  ChatTurnInput,
} from '../../packages/harness-channel-sdk/src/chatAgent.js';
import type {
  AskObserver,
  AskOptions,
} from '../../packages/harness-orchestrator/src/tools/domainQueryTool.js';

describe('createCliSubAgent', () => {
  /**
   * #1085 — a sub-agent turn is a CLI spawn like any other, and
   * `createCliSubAgent` builds its own deps rather than inheriting the chat
   * agent's, so the resolved binary has to be handed in explicitly. Without
   * this forward the main chat turn runs the operator's installed CLI while
   * every `ask_<slug>` sub-agent still spawns whatever PATH resolves.
   */
  it('forwards the resolved CLI binary into the sub-agent spawn (#1085)', async () => {
    let capturedDeps: CliChatAgentDeps | undefined;

    const agent = createCliSubAgent({
      name: 'finance',
      systemPrompt: 'You are finance.',
      model: 'sonnet',
      tools: [],
      resolveCliBinary: () => '/data/cli-tools/bin/claude',
      createCliAgent(deps) {
        capturedDeps = deps;
        return {
          async chat() {
            return { text: 'ok' };
          },
        } as never;
      },
    });
    await agent.ask('anything');

    assert.equal(capturedDeps?.resolveCliBinary?.(), '/data/cli-tools/bin/claude');
  });

  it('omits the resolver when none is wired, keeping the PATH fallback', () => {
    let capturedDeps: CliChatAgentDeps | undefined;
    createCliSubAgent({
      name: 'finance',
      systemPrompt: 'You are finance.',
      model: 'sonnet',
      tools: [],
      createCliAgent(deps) {
        capturedDeps = deps;
        return { async chat() { return { text: 'ok' }; } } as never;
      },
    });

    assert.equal(capturedDeps?.resolveCliBinary, undefined);
  });

  it('routes ask() through CliChatAgent.chat and exposes sub-agent tools on dispatch', async () => {
    let seenInput: ChatTurnInput | undefined;
    let capturedDeps: CliChatAgentDeps | undefined;
    const structuredTool: LocalSubAgentTool = {
      spec: {
        name: 'sub_lookup',
        description: 'lookup',
        input_schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
          required: ['id'],
        },
      },
      async handle(input) {
        assert.deepEqual(input, { id: '42' });
        return { output: 'tool-out' };
      },
    };

    const agent = createCliSubAgent({
      name: 'finance',
      systemPrompt: 'You are finance.',
      model: 'sonnet',
      tools: [structuredTool],
      createCliAgent(deps) {
        capturedDeps = deps;
        return {
          async chat(input: ChatTurnInput) {
            seenInput = input;
            return { text: 'cli-answer' };
          },
        } as never;
      },
    });

    const answer = await agent.ask('where is invoice 42?');

    assert.equal(answer, 'cli-answer');
    assert.deepEqual(seenInput, { userMessage: 'where is invoice 42?' });
    assert.ok(capturedDeps);
    assert.deepEqual(
      capturedDeps.dispatch.listDispatchableToolSpecs().map((spec) => spec.name),
      ['sub_lookup'],
    );

    const dispatched = await capturedDeps.dispatch.dispatch('sub_lookup', {
      id: '42',
    });
    assert.equal(dispatched.content, 'tool-out');
    assert.equal(dispatched.isError, undefined);
  });

  it('passes through string-returning sub-agent tools unchanged', async () => {
    let capturedDeps: CliChatAgentDeps | undefined;
    const stringTool: LocalSubAgentTool = {
      spec: {
        name: 'sub_ping',
        description: 'ping',
        input_schema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      async handle() {
        return 'pong';
      },
    };

    createCliSubAgent({
      name: 'ops',
      systemPrompt: 'You are ops.',
      model: 'haiku',
      tools: [stringTool],
      createCliAgent(deps) {
        capturedDeps = deps;
        return {
          async chat() {
            return { text: 'unused' };
          },
        } as never;
      },
    });

    assert.ok(capturedDeps);
    const dispatched = await capturedDeps.dispatch.dispatch('sub_ping', {});
    assert.equal(dispatched.content, 'pong');
    assert.equal(dispatched.isError, undefined);
  });
});

// ---------------------------------------------------------------------------
// #1072 — observer bridge + AskOptions on the CLI path
// ---------------------------------------------------------------------------

const PREFIX = 'mcp__omadia__';

interface SpawnScript {
  readonly events?: readonly ChatStreamEvent[];
  readonly usage?: CliUsage;
  readonly answer?: string;
  readonly throws?: Error;
}

function usage(input: number, output: number): CliUsage {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadInputTokens: 3,
    cacheCreationInputTokens: 4,
    costUsd: 0,
    numTurns: 1,
  };
}

/** A sub-agent whose CLI replays one script per `chat()` call, in order. */
function scriptedSubAgent(
  scripts: readonly SpawnScript[],
  extra: { readonly onForeignToolUse?: (name: string) => void } = {},
): { readonly agent: ReturnType<typeof createCliSubAgent>; readonly inputs: ChatTurnInput[] } {
  const inputs: ChatTurnInput[] = [];
  const agent = createCliSubAgent({
    name: 'builder-test',
    systemPrompt: 'sp',
    model: 'sonnet',
    tools: [],
    ...(extra.onForeignToolUse ? { onForeignToolUse: extra.onForeignToolUse } : {}),
    createCliAgent() {
      return {
        async chat(input: ChatTurnInput, hooks?: CliChatHooks) {
          const script = scripts[inputs.length];
          inputs.push(input);
          if (script === undefined) throw new Error('unexpected extra chat() call');
          for (const ev of script.events ?? []) hooks?.onEvent?.(ev);
          if (script.throws) throw script.throws;
          if (script.usage) hooks?.onUsage?.(script.usage);
          return { text: script.answer ?? '' };
        },
      } as never;
    },
  });
  return { agent, inputs };
}

type Recorded = { readonly hook: string; readonly ev: unknown };

function recordingObserver(): { readonly observer: AskObserver; readonly calls: Recorded[] } {
  const calls: Recorded[] = [];
  const rec =
    (hook: string) =>
    (ev: unknown): void => {
      calls.push({ hook, ev });
    };
  return {
    calls,
    observer: {
      onIteration: rec('onIteration'),
      onSubToolUse: rec('onSubToolUse'),
      onSubToolResult: rec('onSubToolResult'),
      onIterationPhase: rec('onIterationPhase'),
      onTokenChunk: rec('onTokenChunk'),
      onIterationUsage: rec('onIterationUsage'),
      onIterationEnd: rec('onIterationEnd'),
    },
  };
}

function of(calls: readonly Recorded[], hook: string): unknown[] {
  return calls.filter((c) => c.hook === hook).map((c) => c.ev);
}

function fillSlotSpawn(answer: string, id = 'tu_1'): SpawnScript {
  return {
    events: [
      { type: 'tool_use', id, name: `${PREFIX}fill_slot`, input: { slotKey: 'a' } },
      { type: 'tool_result', id, output: 'ok', durationMs: 5 },
      { type: 'done', answer, toolCalls: 1, iterations: 2 },
    ],
    answer,
  };
}

describe('createCliSubAgent observer bridge (#1072)', () => {
  it('forwards omadia tool calls with the prefix stripped, isError from flag and Error: prefix', async () => {
    const { agent } = scriptedSubAgent([
      {
        events: [
          { type: 'tool_use', id: 'a', name: `${PREFIX}fill_slot`, input: { k: 1 } },
          { type: 'tool_result', id: 'a', output: 'ok', durationMs: 12 },
          { type: 'tool_use', id: 'b', name: `${PREFIX}patch_spec`, input: {} },
          { type: 'tool_result', id: 'b', output: 'boom', durationMs: 3, isError: true },
          { type: 'tool_use', id: 'c', name: `${PREFIX}lint_spec`, input: {} },
          { type: 'tool_result', id: 'c', output: 'Error: bad spec', durationMs: 7 },
        ],
        answer: 'done',
      },
    ]);
    const { observer, calls } = recordingObserver();

    assert.equal(await agent.ask('q', observer), 'done');

    assert.deepEqual(of(calls, 'onSubToolUse'), [
      { id: 'a', name: 'fill_slot', input: { k: 1 } },
      { id: 'b', name: 'patch_spec', input: {} },
      { id: 'c', name: 'lint_spec', input: {} },
    ]);
    assert.deepEqual(of(calls, 'onSubToolResult'), [
      { id: 'a', output: 'ok', durationMs: 12, isError: false },
      { id: 'b', output: 'boom', durationMs: 3, isError: true },
      { id: 'c', output: 'Error: bad spec', durationMs: 7, isError: true },
    ]);
  });

  it('maps text deltas to token chunks, phases and iteration boundaries', async () => {
    const { agent } = scriptedSubAgent([
      {
        events: [
          { type: 'text_delta', text: 'abcdefgh' }, // 2 tokens
          { type: 'tool_use', id: 'a', name: `${PREFIX}fill_slot`, input: {} },
          { type: 'tool_result', id: 'a', output: 'ok', durationMs: 1 },
          { type: 'text_delta', text: 'xyz' }, // 1 token
          { type: 'done', answer: 'final', toolCalls: 1, iterations: 2 },
        ],
        answer: 'final',
      },
    ]);
    const { observer, calls } = recordingObserver();

    await agent.ask('q', observer);

    assert.deepEqual(of(calls, 'onIteration'), [{ iteration: 0 }, { iteration: 1 }]);
    const chunks = of(calls, 'onTokenChunk') as Array<{
      iteration: number;
      deltaTokens: number;
      cumulativeOutputTokens: number;
    }>;
    // Cumulative per iteration, as on the API path (`streaming.ts`).
    assert.deepEqual(
      chunks.map((c) => [c.iteration, c.deltaTokens, c.cumulativeOutputTokens]),
      [
        [0, 2, 2],
        [1, 1, 1],
      ],
    );
    const phases = (of(calls, 'onIterationPhase') as Array<{ iteration: number; phase: string }>).map(
      (p) => `${String(p.iteration)}:${p.phase}`,
    );
    assert.deepEqual(phases, [
      '0:thinking',
      '0:streaming',
      '0:tool_running',
      '1:thinking',
      '1:streaming',
      '1:idle',
    ]);
    assert.deepEqual(of(calls, 'onIterationEnd'), [
      { iteration: 0, stopReason: 'tool_use', toolUseCount: 1, textLength: 8 },
      { iteration: 1, stopReason: 'end_turn', toolUseCount: 0, textLength: 3 },
    ]);
  });

  it('reports the spawn usage as one onIterationUsage for the final iteration', async () => {
    const { agent } = scriptedSubAgent([
      {
        events: [
          { type: 'tool_use', id: 'a', name: `${PREFIX}fill_slot`, input: {} },
          { type: 'tool_result', id: 'a', output: 'ok', durationMs: 1 },
          { type: 'text_delta', text: 'hi' },
        ],
        usage: usage(10, 20),
        answer: 'hi',
      },
    ]);
    const { observer, calls } = recordingObserver();

    await agent.ask('q', observer);

    assert.deepEqual(of(calls, 'onIterationUsage'), [
      {
        iteration: 1,
        inputTokens: 10,
        outputTokens: 20,
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 4,
      },
    ]);
  });

  it('drops foreign tool calls from the observer and reports them via onForeignToolUse', async () => {
    const foreign: string[] = [];
    const { agent } = scriptedSubAgent(
      [
        {
          events: [
            { type: 'tool_use', id: 'x', name: 'Bash', input: { cmd: 'whoami' }, foreign: true },
            { type: 'tool_result', id: 'x', output: 'root', durationMs: 1 },
            { type: 'tool_use', id: 'a', name: `${PREFIX}fill_slot`, input: {} },
            { type: 'tool_result', id: 'a', output: 'ok', durationMs: 1 },
          ],
          answer: 'ok',
        },
      ],
      { onForeignToolUse: (name) => foreign.push(name) },
    );
    const { observer, calls } = recordingObserver();

    await agent.ask('q', observer);

    assert.deepEqual(foreign, ['Bash']);
    assert.deepEqual(
      (of(calls, 'onSubToolUse') as Array<{ id: string }>).map((e) => e.id),
      ['a'],
    );
    assert.deepEqual(
      (of(calls, 'onSubToolResult') as Array<{ id: string }>).map((e) => e.id),
      ['a'],
    );
  });

  it('logs a foreign tool call at error level by default', async (t) => {
    const errors = t.mock.method(console, 'error', () => undefined);
    const { agent } = scriptedSubAgent([
      {
        events: [{ type: 'tool_use', id: 'x', name: 'Read', input: {}, foreign: true }],
        answer: 'ok',
      },
    ]);

    await agent.ask('q');

    const messages = errors.mock.calls.map((c) => String(c.arguments[0]));
    assert.ok(
      messages.some((m) => m.includes('[security]') && m.includes('FOREIGN') && m.includes('Read')),
      `expected a [security] FOREIGN log, got ${JSON.stringify(messages)}`,
    );
  });

  it('never lets a throwing observer callback fail ask()', async (t) => {
    t.mock.method(console, 'warn', () => undefined);
    const { agent } = scriptedSubAgent([
      { ...fillSlotSpawn('still fine'), usage: usage(1, 1) },
    ]);
    const boom = (): never => {
      throw new Error('listener bug');
    };
    const observer: AskObserver = {
      onIteration: boom,
      onSubToolUse: boom,
      onSubToolResult: boom,
      onIterationPhase: boom,
      onTokenChunk: boom,
      onIterationUsage: boom,
      onIterationEnd: boom,
    };

    assert.equal(await agent.ask('q', observer), 'still fine');
  });

  it('emits the idle phase even when the CLI turn throws', async () => {
    const { agent } = scriptedSubAgent([{ throws: new Error('cli died') }]);
    const { observer, calls } = recordingObserver();

    await assert.rejects(agent.ask('q', observer), /cli died/);

    const phases = of(calls, 'onIterationPhase') as Array<{ phase: string }>;
    assert.equal(phases.at(-1)?.phase, 'idle');
  });
});

describe('createCliSubAgent expectedTurnToolUse post-turn check (#1072)', () => {
  const opts: AskOptions = { expectedTurnToolUse: 'fill_slot' };

  it('does not re-prompt when the expected tool was called', async () => {
    const { agent, inputs } = scriptedSubAgent([fillSlotSpawn('built')]);

    assert.equal(await agent.ask('build it', undefined, opts), 'built');
    assert.equal(inputs.length, 1);
  });

  it('matches a prefixed expectedTurnToolUse against the bare tool name', async () => {
    const { agent, inputs } = scriptedSubAgent([fillSlotSpawn('built')]);

    const prefixed: AskOptions = { expectedTurnToolUse: `${PREFIX}fill_slot` };
    assert.equal(await agent.ask('build it', undefined, prefixed), 'built');
    assert.equal(inputs.length, 1);
  });

  it('re-prompts exactly once with question, first answer and a reminder naming the tool', async (t) => {
    const warn = t.mock.method(console, 'warn', () => undefined);
    const { agent, inputs } = scriptedSubAgent([
      { events: [{ type: 'text_delta', text: 'Ich baue das jetzt.' }], answer: 'Ich baue das jetzt.' },
      fillSlotSpawn('Slot gefüllt.', 'tu_2'),
    ]);
    const { observer, calls } = recordingObserver();

    const answer = await agent.ask('<ctx>bau den Agenten</ctx>', observer, opts);

    assert.equal(answer, 'Slot gefüllt.');
    assert.equal(inputs.length, 2);
    assert.deepEqual(inputs[0], { userMessage: '<ctx>bau den Agenten</ctx>' });
    const reprompt = inputs[1]?.userMessage ?? '';
    assert.ok(reprompt.includes('<ctx>bau den Agenten</ctx>'), 'carries the original question');
    assert.ok(reprompt.includes('Ich baue das jetzt.'), 'carries the first answer');
    assert.ok(reprompt.includes(`${PREFIX}fill_slot`), 'names the prefixed tool');
    assert.ok(warn.mock.calls.length >= 1, 'logs the missed obligation');
    // Iterations continue across the re-prompt spawn instead of restarting.
    assert.deepEqual(
      (of(calls, 'onIteration') as Array<{ iteration: number }>).map((e) => e.iteration),
      [0, 1, 2],
    );
    assert.deepEqual(
      (of(calls, 'onSubToolUse') as Array<{ name: string }>).map((e) => e.name),
      ['fill_slot'],
    );
  });

  it('lets the re-prompt re-run read-only calls but not state-changing ones', async (t) => {
    t.mock.method(console, 'warn', () => undefined);
    const { agent, inputs } = scriptedSubAgent([
      {
        events: [
          { type: 'tool_use', id: 'r', name: `${PREFIX}read_reference`, input: {} },
          { type: 'tool_result', id: 'r', output: 'ref body', durationMs: 4 },
        ],
        answer: 'Referenz gelesen, ich baue gleich.',
      },
      fillSlotSpawn('Slot gefüllt.', 'tu_2'),
    ]);

    await agent.ask('bau', undefined, opts);

    const reprompt = inputs[1]?.userMessage ?? '';
    assert.ok(reprompt.includes(`${PREFIX}read_reference`), 'lists the earlier call');
    assert.ok(reprompt.includes('Lesende Calls darfst du erneut ausführen'), 'allows read-only re-runs');
    assert.ok(reprompt.includes('Wiederhole keine Calls, die Zustand ändern'), 'forbids state changes');
    assert.ok(!reprompt.includes('wiederhole sie nicht'), 'no blanket ban on repeating calls');
  });

  it('returns the re-prompt answer and warns when the tool is still not called', async (t) => {
    const warn = t.mock.method(console, 'warn', () => undefined);
    const { agent, inputs } = scriptedSubAgent([
      { answer: 'Mache ich.' },
      { answer: 'Mir fehlt noch die API-URL.' },
    ]);

    const answer = await agent.ask('bau', undefined, opts);

    assert.equal(answer, 'Mir fehlt noch die API-URL.');
    assert.equal(inputs.length, 2);
    const warnings = warn.mock.calls.map((c) => String(c.arguments[0]));
    assert.ok(
      warnings.some((w) => w.includes('fill_slot') && w.includes('still')),
      `expected a still-not-called warning, got ${JSON.stringify(warnings)}`,
    );
  });

  it('falls back to the first answer when the re-prompt returns empty text', async (t) => {
    t.mock.method(console, 'warn', () => undefined);
    const { agent } = scriptedSubAgent([{ answer: 'erste Antwort' }, { answer: '   ' }]);

    assert.equal(await agent.ask('bau', undefined, opts), 'erste Antwort');
  });

  it('propagates a failing re-prompt', async (t) => {
    t.mock.method(console, 'warn', () => undefined);
    const cause = new Error('re-prompt spawn failed');
    const { agent } = scriptedSubAgent([
      {
        events: [
          { type: 'tool_use', id: 'r', name: `${PREFIX}read_slot`, input: {} },
          { type: 'tool_result', id: 'r', output: 'slot', durationMs: 2 },
        ],
        answer: 'Mache ich.',
      },
      { throws: cause },
    ]);

    await assert.rejects(agent.ask('bau', undefined, opts), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /re-prompt spawn failed/);
      assert.match(err.message, /fill_slot/);
      assert.match(err.message, /first pass/);
      assert.match(err.message, /read_slot/);
      assert.equal(err.cause, cause);
      return true;
    });
  });

  it('does not re-prompt with maxEscalations: 0', async () => {
    const { agent, inputs } = scriptedSubAgent([{ answer: 'Mache ich.' }]);

    const answer = await agent.ask('bau', undefined, { ...opts, maxEscalations: 0 });

    assert.equal(answer, 'Mache ich.');
    assert.equal(inputs.length, 1);
  });

  it('does not count a foreign tool with the same bare name as the obligation', async (t) => {
    t.mock.method(console, 'warn', () => undefined);
    t.mock.method(console, 'error', () => undefined);
    const { agent, inputs } = scriptedSubAgent([
      {
        events: [
          { type: 'tool_use', id: 'x', name: 'fill_slot', input: {}, foreign: true },
          // The `foreign` flag wins even over the omadia prefix.
          { type: 'tool_use', id: 'y', name: `${PREFIX}fill_slot`, input: {}, foreign: true },
        ],
        answer: 'hm',
      },
      fillSlotSpawn('ok'),
    ]);

    await agent.ask('bau', undefined, opts);
    assert.equal(inputs.length, 2);
  });
});
