import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { PassThrough } from 'node:stream';

import {
  CLI_MEMORY_TOOL_SPEC,
  turnMemoryDispatch,
  withCliMemoryTool,
  type LoopbackDispatch,
} from '../../packages/harness-orchestrator/src/cliMemoryTool.js';
import { CliChatAgent } from '../../packages/harness-orchestrator/src/cliChatAgent.js';
import type {
  CliChatAgentDeps,
  CliSpawnLogger,
} from '../../packages/harness-orchestrator/src/cliChatAgent.js';
import type { DispatchableToolSpec } from '../../packages/harness-orchestrator/src/toolDispatchService.js';

/**
 * #1102 — the subscription CLI gets the `memory` tool, served from the handler
 * bound to the turn (MemoryBinder), never from the shared native registry whose
 * `memory` entry is the memory plugin's raw root store.
 */

const silentLogger: CliSpawnLogger = { info: () => undefined, warn: () => undefined };

function spec(name: string): DispatchableToolSpec {
  return { name, description: name, input_schema: { type: 'object', properties: {} } };
}

describe('cliMemoryTool (#1102)', () => {
  it('serves memory from the bound handler and everything else from the base dispatch', async () => {
    const baseCalls: string[] = [];
    const base: LoopbackDispatch = {
      dispatch: async (name) => {
        baseCalls.push(name);
        return { content: `base:${name}` };
      },
    };
    const seen: unknown[] = [];
    const dispatch = turnMemoryDispatch(base, {
      handle: async (input) => {
        seen.push(input);
        return 'File created successfully at /memories/backup.md';
      },
    });

    const memory = await dispatch.dispatch('memory', { command: 'create', path: '/memories/backup.md' });
    assert.equal(memory.content, 'File created successfully at /memories/backup.md');
    assert.equal(memory.isError, undefined);
    assert.deepEqual(seen, [{ command: 'create', path: '/memories/backup.md' }]);
    assert.deepEqual(baseCalls, [], 'memory never reaches the shared dispatch');

    assert.equal((await dispatch.dispatch('query_knowledge_graph', {})).content, 'base:query_knowledge_graph');
    assert.deepEqual(baseCalls, ['query_knowledge_graph']);
  });

  it('reports handler errors as tool errors', async () => {
    const dispatch = turnMemoryDispatch(
      { dispatch: async () => ({ content: 'x' }) },
      { handle: async () => Promise.reject(new Error('disk full')) },
    );
    const result = await dispatch.dispatch('memory', { command: 'view', path: '/memories' });
    assert.equal(result.isError, true);
    assert.match(result.content, /disk full/);

    const refused = turnMemoryDispatch(
      { dispatch: async () => ({ content: 'x' }) },
      { handle: async () => 'Error: path outside /memories' },
    );
    assert.equal((await refused.dispatch('memory', {})).isError, true);
  });

  it('advertises exactly one memory spec, name-sorted', () => {
    const tools = withCliMemoryTool([spec('suggest_follow_ups'), spec('memory'), spec('ask_user_choice')]);
    assert.deepEqual(tools.map((t) => t.name), ['ask_user_choice', 'memory', 'suggest_follow_ups']);
    assert.equal(tools.find((t) => t.name === 'memory'), CLI_MEMORY_TOOL_SPEC);
    assert.deepEqual(
      (CLI_MEMORY_TOOL_SPEC.input_schema.properties['command'] as { enum: string[] }).enum,
      ['view', 'create', 'str_replace', 'insert', 'delete', 'rename'],
    );
  });
});

interface LoopbackSeen {
  tools: readonly DispatchableToolSpec[];
  dispatch: LoopbackDispatch;
}

function makeAgent(
  bindTurnMemory: CliChatAgentDeps['bindTurnMemory'],
  seen: LoopbackSeen[],
  argv: string[][],
): CliChatAgent {
  return new CliChatAgent({
    dispatch: {
      listDispatchableToolSpecs: () => [spec('ask_user_choice')],
      dispatch: async (name: string) => ({ content: `base:${name}` }),
    } as unknown as CliChatAgentDeps['dispatch'],
    createLoopbackServer: (deps) => {
      seen.push({ tools: deps.tools, dispatch: deps.dispatch });
      return {
        start: async () => ({ url: 'http://127.0.0.1:1/mcp', port: 1, bearer: 'bearer' }),
        stop: async () => {},
      } as never;
    },
    resolveCliVersion: async () => '2.1.187',
    logger: silentLogger,
    ...(bindTurnMemory ? { bindTurnMemory } : {}),
    spawnFn: ((_bin: string, args: string[]) => {
      argv.push(args);
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
      stdin.resume();
      stdin.on('end', () => {
        stdout.end(`${JSON.stringify({ type: 'result', is_error: false, result: 'ok', num_turns: 1 })}\n`);
        stderr.end();
        child.exitCode = 0;
        child.emit('close', 0, null);
      });
      return child;
    }) as unknown as CliChatAgentDeps['spawnFn'],
  });
}

function systemPrompt(args: readonly string[]): string {
  return args[args.indexOf('--system-prompt') + 1] ?? '';
}

describe('CliChatAgent memory tool (#1102)', () => {
  it('advertises memory and serves it from the turn-bound handler', async () => {
    const seen: LoopbackSeen[] = [];
    const argv: string[][] = [];
    const writes: unknown[] = [];
    const agent = makeAgent(
      async () => ({
        handle: async (input: unknown) => {
          writes.push(input);
          return 'ok';
        },
      }),
      seen,
      argv,
    );
    await agent.chat({ userMessage: 'Merk dir: Mein Lieblingsbackup ist pg_dump.', sessionScope: 's' });

    assert.deepEqual(seen[0]!.tools.map((t) => t.name), ['ask_user_choice', 'memory']);
    await seen[0]!.dispatch.dispatch('memory', { command: 'create' });
    assert.deepEqual(writes, [{ command: 'create' }]);
    // The honesty sentence no longer denies a memory the turn has.
    assert.doesNotMatch(systemPrompt(argv[0]!), /remember facts across turns/);
  });

  for (const [label, bind] of [
    ['no binder wired', undefined],
    ['the binder returns no handler', async () => undefined],
    ['the binder rejects', async () => Promise.reject(new Error('binder down'))],
  ] as const) {
    it(`offers no memory tool when ${label}`, async () => {
      const seen: LoopbackSeen[] = [];
      const argv: string[][] = [];
      await makeAgent(bind, seen, argv).chat({ userMessage: 'Merk dir das.', sessionScope: 's' });
      assert.deepEqual(seen[0]!.tools.map((t) => t.name), ['ask_user_choice']);
      assert.equal((await seen[0]!.dispatch.dispatch('memory', {})).content, 'base:memory');
      assert.match(systemPrompt(argv[0]!), /remember facts across turns/);
    });
  }
});
