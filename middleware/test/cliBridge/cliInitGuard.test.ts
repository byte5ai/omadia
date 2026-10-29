import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { PassThrough } from 'node:stream';

import {
  CliChatAgent,
  StreamJsonParser,
  buildGatedCliEnv,
  checkCliInit,
} from '../../packages/harness-orchestrator/src/cliChatAgent.js';
import type {
  CliChatAgentDeps,
  CliSpawnLogger,
} from '../../packages/harness-orchestrator/src/cliChatAgent.js';
import type { ChatStreamEvent } from '../../packages/harness-channel-sdk/src/chatAgent.js';

/**
 * #1581 — on the subscription CLI the memory tool never ran. CLI 2.1.187 sent
 * its first model request without the loopback MCP tools whenever the
 * handshake took longer than a few seconds (measured: 3 × 1.5 s handshake
 * steps ⇒ `tools: []`, server `pending`). The model then wrote
 * `<function_calls><invoke name="mcp__omadia__memory_write">…` as answer text
 * and told the user the file was created. The CLI's `system`/`init` line says
 * what it actually loaded; a turn whose CLI loaded none of omadia's tools now
 * ends with an honest error instead of the fake success.
 */

const OFFERED_SPEC = {
  name: 'ask_user_choice',
  description: 'choice',
  input_schema: { type: 'object' as const, properties: {} },
};

function initLine(tools: readonly string[], status: string): string {
  return JSON.stringify({
    type: 'system',
    subtype: 'init',
    tools,
    mcp_servers: [{ name: 'omadia', status }],
  });
}

const FAKE_SUCCESS = JSON.stringify({
  type: 'result',
  is_error: false,
  result: 'Die Datei /memories/test-cli.md wurde erstellt.',
  num_turns: 1,
});

function makeAgent(stdoutLines: readonly string[]): {
  readonly agent: CliChatAgent;
  readonly logged: { level: string; message: string; meta?: Record<string, unknown> }[];
  readonly killed: () => boolean;
} {
  const logged: { level: string; message: string; meta?: Record<string, unknown> }[] = [];
  const logger: CliSpawnLogger = {
    info: (message, meta) => logged.push({ level: 'info', message, ...(meta ? { meta: { ...meta } } : {}) }),
    warn: (message, meta) => logged.push({ level: 'warn', message, ...(meta ? { meta: { ...meta } } : {}) }),
  };
  let wasKilled = false;
  const agent = new CliChatAgent({
    dispatch: {
      listDispatchableToolSpecs: () => [OFFERED_SPEC],
    } as unknown as CliChatAgentDeps['dispatch'],
    createLoopbackServer: () =>
      ({
        start: async () => ({ url: 'http://127.0.0.1:1/mcp', port: 1, bearer: 'bearer' }),
        stop: async () => {},
      }) as never,
    resolveCliVersion: async () => '2.1.187',
    logger,
    buildEnv: () => ({ PATH: '/usr/bin', HOME: '/home/tester' }),
    spawnFn: (() => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin = new PassThrough();
      const child = Object.assign(new PassThrough(), {
        stdin,
        stdout,
        stderr,
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        kill: () => {
          wasKilled = true;
          return true;
        },
      });
      stdin.on('finish', () => {
        stdout.end(stdoutLines.map((l) => `${l}\n`).join(''));
        // Async, like a real process: the agent sees `init` while the child
        // is still alive, which is the window the guard has to act in.
        setTimeout(() => {
          child.exitCode = 0;
          child.emit('close', 0, null);
        }, 20);
      });
      return child;
    }) as unknown as CliChatAgentDeps['spawnFn'],
  });
  return { agent, logged, killed: () => wasKilled };
}

async function collect(agent: CliChatAgent): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = [];
  for await (const event of agent.chatStream({ userMessage: 'Merk dir: Testwert CLI.' })) {
    events.push(event);
  }
  return events;
}

describe('CLI init guard (#1581)', () => {
  it('reads tools and the omadia server state from the init line', () => {
    const parser = new StreamJsonParser(() => 0);
    parser.push(initLine(['mcp__omadia__memory'], 'connected'));
    assert.deepEqual(parser.takeInit(), {
      tools: ['mcp__omadia__memory'],
      omadiaServerStatus: 'connected',
    });
    assert.equal(parser.takeInit(), undefined, 'the report is handed out once');
  });

  it('flags a CLI that loaded none of the offered tools', () => {
    const err = checkCliInit({ tools: [], omadiaServerStatus: 'pending' }, 18, 'en-US');
    assert.ok(err);
    assert.match(err.message, /without omadia's tools \(MCP server pending\)/);
    assert.match(err.message, /nothing was saved/);
    // German by default, like every notice.
    assert.match(
      checkCliInit({ tools: [], omadiaServerStatus: 'failed' }, 18)!.message,
      /nichts gespeichert/,
    );
  });

  it('lets a turn through when omadia tools loaded, or when none were offered', () => {
    assert.equal(
      checkCliInit({ tools: ['mcp__omadia__memory'], omadiaServerStatus: 'connected' }, 18),
      undefined,
    );
    assert.equal(checkCliInit({ tools: [], omadiaServerStatus: 'absent' }, 0), undefined);
  });

  it('ends the turn with an error instead of the fake "file created" answer', async () => {
    const { agent, logged, killed } = makeAgent([initLine([], 'pending'), FAKE_SUCCESS]);
    const events = await collect(agent);

    assert.ok(!events.some((e) => e.type === 'done'), 'no success may reach the user');
    const error = events.find((e) => e.type === 'error');
    assert.ok(error && error.type === 'error');
    assert.match(JSON.stringify(error), /ohne die Werkzeuge von omadia/);
    assert.ok(killed(), 'the child is stopped before it answers');
    assert.ok(logged.some((l) => l.message === 'claude CLI started without omadia tools'));
  });

  it('runs the turn normally when the CLI loaded omadia tools', async () => {
    const { agent, logged } = makeAgent([
      initLine(['mcp__omadia__ask_user_choice'], 'connected'),
      FAKE_SUCCESS,
    ]);
    const events = await collect(agent);

    assert.ok(events.some((e) => e.type === 'done'));
    const spawn = logged.find((l) => l.message === 'spawning claude CLI');
    assert.deepEqual(spawn?.meta?.toolNames, ['ask_user_choice'], 'the spawn log names the tools');
    const loaded = logged.find((l) => l.message === 'claude CLI loaded tools');
    assert.deepEqual(loaded?.meta, { omadiaServer: 'connected', omadiaTools: 1 });
  });

  it('switches tool search off, because the gate denies ToolSearch', () => {
    assert.equal(buildGatedCliEnv({ PATH: '/usr/bin' }).ENABLE_TOOL_SEARCH, 'false');
  });
});
