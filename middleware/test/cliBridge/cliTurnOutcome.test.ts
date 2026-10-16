import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { PassThrough } from 'node:stream';

import {
  CliChatAgent,
  describeCliTerminalError,
} from '../../packages/harness-orchestrator/src/cliChatAgent.js';
import type {
  CliChatAgentDeps,
  CliSpawnLogger,
} from '../../packages/harness-orchestrator/src/cliChatAgent.js';
import {
  CliToolTrace,
  type CliCompletedTurn,
} from '../../packages/harness-orchestrator/src/cliTurnRecord.js';
import type {
  ChatStreamEvent,
  ChatTurnInput,
} from '../../packages/harness-channel-sdk/src/chatAgent.js';

/**
 * #1325 — a CLI turn that ends in a terminal `is_error` result is a failed
 * turn: no `done`, exactly one `error` that names the cause.
 * #1391 — a successful CLI turn is recorded (session log, graph, hooks) and
 * recalls graph context before the spawn, like an in-process turn.
 */

const silentLogger: CliSpawnLogger = { info: () => undefined, warn: () => undefined };

function line(payload: unknown): string {
  return `${JSON.stringify(payload)}\n`;
}

const NOT_LOGGED_IN = line({
  type: 'result',
  subtype: 'success',
  is_error: true,
  result: 'Not logged in · Please run /login',
  num_turns: 1,
});

const SUCCESS = [
  line({
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id: 'tu_1', name: 'mcp__omadia__query_knowledge_graph', input: {} },
      ],
    },
  }),
  line({
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_1',
          is_error: true,
          content: [{ type: 'text', text: 'boom' }],
        },
      ],
    },
  }),
  line({ type: 'result', subtype: 'success', is_error: false, result: 'Freitag.', num_turns: 2 }),
];

interface FakeCli {
  readonly lines: readonly string[];
  readonly exitCode?: number;
  readonly stderr?: string;
}

function makeAgent(
  cli: FakeCli,
  extra: Partial<CliChatAgentDeps> = {},
  seenArgv: string[][] = [],
  seenStdin: string[] = [],
): CliChatAgent {
  return new CliChatAgent({
    dispatch: {
      listDispatchableToolSpecs: () => [],
    } as unknown as CliChatAgentDeps['dispatch'],
    createLoopbackServer: () =>
      ({
        start: async () => ({ url: 'http://127.0.0.1:1/mcp', port: 1, bearer: 'bearer' }),
        stop: async () => {},
      }) as never,
    resolveCliVersion: async () => '2.1.187',
    logger: silentLogger,
    spawnFn: ((_bin: string, argv: string[]) => {
      seenArgv.push(argv);
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin = new PassThrough();
      const child = Object.assign(new PassThrough(), {
        stdin,
        stdout,
        stderr,
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        kill: () => true,
      });
      let prompt = '';
      stdin.on('data', (chunk: Buffer) => {
        prompt += chunk.toString();
      });
      stdin.on('finish', () => {
        seenStdin.push(prompt);
        stdout.end(cli.lines.join(''));
        stderr.end(cli.stderr ?? '');
        child.exitCode = cli.exitCode ?? 0;
        child.emit('close', cli.exitCode ?? 0, null);
      });
      return child;
    }) as unknown as CliChatAgentDeps['spawnFn'],
    ...extra,
  });
}

async function collect(
  agent: CliChatAgent,
  input: ChatTurnInput = { userMessage: 'Reply with pong only.' },
): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = [];
  for await (const event of agent.chatStream(input)) {
    events.push(event);
  }
  return events;
}


describe('CliChatAgent terminal error results (#1325)', () => {
  for (const exitCode of [1, 0]) {
    it(`streams no done and exactly one error when the CLI is not logged in (exit ${exitCode})`, async () => {
      const events = await collect(makeAgent({ lines: [NOT_LOGGED_IN], exitCode }));

      assert.equal(events.filter((e) => e.type === 'done').length, 0, 'a failed turn has no done');
      const errors = events.filter(
        (e): e is Extract<ChatStreamEvent, { type: 'error' }> => e.type === 'error',
      );
      assert.equal(errors.length, 1, 'exactly one error event');
      assert.match(errors[0]!.message, /not logged in/i);
      assert.match(errors[0]!.message, /LLM access page, Subscriptions tab/);
      assert.doesNotMatch(errors[0]!.message, /exited with code/);
      assert.equal(events.at(-1)?.type, 'error', 'the error is the terminal event');
    });
  }

  it('chat() rejects with the described cause', async () => {
    await assert.rejects(
      makeAgent({ lines: [NOT_LOGGED_IN], exitCode: 1 }).chat({ userMessage: 'hi' }),
      /not logged in, or its login expired/,
    );
  });

  it('holds back a success result when the CLI then exits non-zero', async () => {
    const events = await collect(makeAgent({ lines: SUCCESS, exitCode: 2, stderr: 'crash' }));

    assert.equal(events.filter((e) => e.type === 'done').length, 0);
    assert.equal(events.filter((e) => e.type === 'error').length, 1);
    assert.equal(events.at(-1)?.type, 'error');
  });

  it('does not record a failed turn', async () => {
    let recorded = 0;
    await collect(
      makeAgent(
        { lines: [NOT_LOGGED_IN], exitCode: 1 },
        {
          recordTurn: async () => {
            recorded += 1;
            return {};
          },
        },
      ),
      { userMessage: 'hi', sessionScope: 'sess-1325' },
    );
    assert.equal(recorded, 0);
  });

  it('describes quota exhaustion and keeps unknown CLI text', () => {
    assert.match(
      describeCliTerminalError('error: Claude AI usage limit reached|1760000000'),
      /usage limit reached/,
    );
    assert.match(describeCliTerminalError('error: OAuth token has expired'), /not logged in/);
    assert.equal(
      describeCliTerminalError('error_max_turns: too many turns'),
      'Claude subscription CLI failed: error_max_turns: too many turns',
    );
  });
});

describe('CliChatAgent turn record and recall (#1391)', () => {
  it('records a successful turn once and releases its record on done', async () => {
    const recorded: Array<{ input: ChatTurnInput; turn: CliCompletedTurn }> = [];
    const agent = makeAgent(
      { lines: SUCCESS },
      {
        recordTurn: async (input, turn) => {
          recorded.push({ input, turn });
          return {
            turnId: 'turn-1391',
            autoPromotedMkId: 'mk-1',
            events: [{ type: 'turn_annotation', channel: 'kg_insert', payload: {} }],
          };
        },
      },
    );

    const events = await collect(agent, {
      userMessage: 'Wann beginnt der Release-Freeze?',
      sessionScope: 'sess-1391',
      userId: 'user-1',
    });

    assert.equal(recorded.length, 1);
    const { input, turn } = recorded[0]!;
    assert.equal(input.sessionScope, 'sess-1391');
    assert.equal(turn.answer, 'Freitag.');
    assert.equal(typeof turn.turnId, 'string');
    assert.equal(turn.toolCalls, 1);
    assert.equal(turn.runTrace.scope, 'sess-1391');
    assert.equal(turn.runTrace.userId, 'user-1');
    assert.equal(turn.runTrace.provider, 'claude-cli');
    assert.deepEqual(
      turn.runTrace.orchestratorToolCalls.map((c) => [c.callId, c.toolName, c.isError]),
      [['tu_1', 'query_knowledge_graph', true]],
    );

    const types = events.map((e) => e.type);
    assert.ok(types.indexOf('turn_annotation') < types.indexOf('done'), 'record events precede done');
    const done = events.find(
      (e): e is Extract<ChatStreamEvent, { type: 'done' }> => e.type === 'done',
    );
    assert.equal(done?.turnId, 'turn-1391');
    assert.equal((done as { autoPromotedMkId?: string }).autoPromotedMkId, 'mk-1');
  });

  it('still releases the answer when recording rejects', async () => {
    const events = await collect(
      makeAgent(
        { lines: SUCCESS },
        { recordTurn: async () => Promise.reject(new Error('graph down')) },
      ),
      { userMessage: 'hi', sessionScope: 'sess-1391' },
    );
    const done = events.find((e) => e.type === 'done');
    assert.ok(done, 'a failed record must not swallow the answer');
    assert.equal(events.filter((e) => e.type === 'error').length, 0);
  });

  it('puts the graph recall into the stdin prompt, not argv, and streams its cards first', async () => {
    const argv: string[][] = [];
    const stdin: string[] = [];
    const events = await collect(
      makeAgent(
        { lines: SUCCESS },
        {
          recallContext: async () => ({
            text: '## Früher besprochene Entitäten\n- Release-Freeze: Freitag',
            events: [{ type: 'turn_annotation', channel: 'kg_recall', payload: { n: 1 } }],
          }),
        },
        argv,
        stdin,
      ),
      { userMessage: 'Wann ist der Freeze?', sessionScope: 'sess-1391' },
    );

    // argv is visible to every process in the container (`ps`), and capped
    // at 128 KiB per argument; recalled content must never ride it.
    assert.doesNotMatch(argv[0]!.join('\n'), /Release-Freeze/);
    assert.match(stdin[0]!, /Context recalled from earlier conversations/);
    assert.match(stdin[0]!, /Release-Freeze: Freitag/);
    assert.ok(
      stdin[0]!.indexOf('Release-Freeze') < stdin[0]!.indexOf('User: Wann ist der Freeze?'),
      'recall precedes the live message',
    );
    assert.equal(events[0]?.type, 'turn_annotation');
  });

  it('asks for no recall on a turn without a chat (a CLI sub-agent)', async () => {
    let asked = 0;
    const stdin: string[] = [];
    await collect(
      makeAgent(
        { lines: SUCCESS },
        {
          recallContext: async () => {
            asked += 1;
            return { text: 'should not appear' };
          },
        },
        [],
        stdin,
      ),
    );
    assert.equal(asked, 0);
    assert.doesNotMatch(stdin[0]!, /should not appear/);
  });

  it('runs the turn without recall when recall hangs past its deadline', async () => {
    const stdin: string[] = [];
    const events = await collect(
      makeAgent(
        { lines: SUCCESS },
        {
          recallContext: () => new Promise(() => undefined),
          recallTimeoutMs: 20,
        },
        [],
        stdin,
      ),
      { userMessage: 'hi', sessionScope: 'sess-1391' },
    );
    assert.ok(events.some((e) => e.type === 'done'));
    assert.doesNotMatch(stdin[0]!, /Context recalled/);
  });

  it('carries the drained cards and the record on one done', async () => {
    const events = await collect(
      makeAgent(
        { lines: SUCCESS },
        {
          recordTurn: async () => ({ turnId: 'turn-x' }),
          drainTurnCards: () => ({ followUpOptions: [{ label: 'Weiter', prompt: 'weiter' }] }),
        },
      ),
      { userMessage: 'hi', sessionScope: 'sess-1391' },
    );
    const dones = events.filter(
      (e): e is Extract<ChatStreamEvent, { type: 'done' }> => e.type === 'done',
    );
    assert.equal(dones.length, 1);
    assert.equal(dones[0]?.turnId, 'turn-x');
    assert.equal(dones[0]?.followUpOptions?.length, 1);
  });

  it('runs the turn without recall when recall rejects', async () => {
    const events = await collect(
      makeAgent(
        { lines: SUCCESS },
        { recallContext: async () => Promise.reject(new Error('kg down')) },
      ),
      { userMessage: 'hi', sessionScope: 'sess-1391' },
    );
    assert.ok(events.some((e) => e.type === 'done'));
  });
});

describe('CliToolTrace (#1391)', () => {
  it('times a call whose result never streamed until the turn ended', () => {
    let clock = 1_000;
    const trace = new CliToolTrace(() => clock);
    trace.observe({ type: 'tool_use', id: 'a', name: 'mcp__omadia__ask_user_choice', input: {} });
    clock = 1_250;
    const payload = trace.finish({ scope: 's', iterations: 1, model: 'sonnet' });
    assert.equal(payload.durationMs, 250);
    assert.deepEqual(payload.orchestratorToolCalls, [
      {
        callId: 'a',
        toolName: 'ask_user_choice',
        durationMs: 250,
        isError: false,
        agentContext: 'orchestrator',
      },
    ]);
    assert.equal(payload.status, 'success');
  });
});
