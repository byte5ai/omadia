import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { AsyncLocalStorage } from 'node:async_hooks';
import { PassThrough } from 'node:stream';

import {
  CLI_BUILTIN_TOOL_DENYLIST,
  CliChatAgent,
  StreamJsonParser,
  composeCliSystemPrompt,
} from '../../packages/harness-orchestrator/src/cliChatAgent.js';
import type { CliChatAgentDeps } from '../../packages/harness-orchestrator/src/cliChatAgent.js';

// Unit tests for the M2 stream-json → omadia mapping. The `claude -p
// --output-format stream-json` terminal `result` line is the authoritative
// source for final text + usage; these lock that mapping + malformed-line
// tolerance without spawning the CLI (the live end-to-end path is exercised
// against the real logged-in CLI in the container, gated on login).
describe('StreamJsonParser (M2 stream-json mapping)', () => {
  it('maps a terminal success result to finalAnswer, a done event, and usage', () => {
    const p = new StreamJsonParser(() => 0);
    const events = p.push(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'hello world',
        num_turns: 3,
        total_cost_usd: 0.01,
        usage: {
          input_tokens: 5,
          output_tokens: 9,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 2,
        },
      }),
    );

    assert.equal(p.isError(), false);
    assert.equal(p.sawTerminalResult(), true);
    assert.equal(p.finalAnswer(), 'hello world');
    assert.equal(p.iterations(), 3);
    const u = p.usage();
    assert.equal(u.inputTokens, 5);
    assert.equal(u.outputTokens, 9);
    assert.equal(u.cacheReadInputTokens, 100);
    assert.equal(u.cacheCreationInputTokens, 2);
    assert.equal(u.costUsd, 0.01);
    assert.equal(u.numTurns, 3);
    assert.ok(events.some((e) => e.type === 'done'));
  });

  it('flags a terminal error result with a formatted message', () => {
    const p = new StreamJsonParser(() => 0);
    p.push(
      JSON.stringify({
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        result: 'too many turns',
      }),
    );
    assert.equal(p.isError(), true);
    assert.match(p.errorMessage(), /error_max_turns/);
    assert.match(p.errorMessage(), /too many turns/);
  });

  it('tolerates malformed, non-object, and blank lines without throwing', () => {
    const p = new StreamJsonParser(() => 0);
    assert.deepEqual(p.push('not json at all'), []);
    assert.deepEqual(p.push(''), []);
    assert.deepEqual(p.push('   '), []);
    assert.deepEqual(p.push('123'), []);
    assert.deepEqual(p.push(JSON.stringify({ type: 'unknown_event' })), []);
    // After noise, a real terminal still parses cleanly.
    p.push(JSON.stringify({ type: 'result', is_error: false, result: 'ok', num_turns: 1 }));
    assert.equal(p.finalAnswer(), 'ok');
  });

  it('chat() rejects a clean CLI exit that never produced a terminal result line', async () => {
    const agent = new CliChatAgent({
      dispatch: {
        listDispatchableToolSpecs: () => [],
      } as CliChatAgentDeps['dispatch'],
      createLoopbackServer: () =>
        ({
          start: async () => ({
            url: 'http://127.0.0.1:1/mcp',
            port: 1,
            bearer: 'bearer',
          }),
          stop: async () => {},
        }) as never,
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
          kill: () => true,
        });
        stdin.on('finish', () => {
          stdout.end();
          child.exitCode = 0;
          child.emit('close', 0, null);
        });
        return child;
      }) as CliChatAgentDeps['spawnFn'],
    });

    await assert.rejects(
      agent.chat({ userMessage: 'hello from test' }),
      /terminal result line/,
    );
  });
});

/**
 * OM-81 / OM-83 (#991, #992) — the CLI process boundary.
 *
 * `--allowedTools mcp__omadia__*` is a pre-approval, not a restriction: the
 * CLI's own Bash/Edit/Write/Read/WebFetch stayed reachable and the agent ran
 * `whoami && hostname` on the tester's machine without any omadia gate. These
 * tests pin the argv that closes that hole and the system-prompt flag that
 * makes the model identify as omadia instead of Claude Code.
 */
describe('CliChatAgent CLI process boundary (OM-81, OM-83)', () => {
  /** Spawn a fake child that exits cleanly with a terminal result, capturing argv. */
  function makeAgent(opts: { readonly systemPrompt?: string } = {}): {
    readonly agent: CliChatAgent;
    readonly argv: () => readonly string[];
  } {
    let captured: readonly string[] = [];
    const agent = new CliChatAgent({
      dispatch: {
        listDispatchableToolSpecs: () => [],
      } as unknown as CliChatAgentDeps['dispatch'],
      createLoopbackServer: () =>
        ({
          start: async () => ({
            url: 'http://127.0.0.1:1/mcp',
            port: 1,
            bearer: 'bearer',
          }),
          stop: async () => {},
        }) as never,
      ...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
      spawnFn: ((_bin: string, argv: readonly string[]) => {
        captured = argv;
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
        stdin.on('finish', () => {
          stdout.end(
            JSON.stringify({ type: 'result', is_error: false, result: 'ok', num_turns: 1 }) + '\n',
          );
          child.exitCode = 0;
          child.emit('close', 0, null);
        });
        return child;
      }) as unknown as CliChatAgentDeps['spawnFn'],
    });
    return { agent, argv: () => captured };
  }

  function valueAfter(argv: readonly string[], flag: string): string | undefined {
    const idx = argv.indexOf(flag);
    return idx === -1 ? undefined : argv[idx + 1];
  }

  it('removes the CLI built-in tool set and denies anything not pre-approved', async () => {
    const { agent, argv } = makeAgent();
    await agent.chat({ userMessage: 'run whoami' });
    const a = argv();

    // `--tools ""` removes every built-in tool; only MCP tools remain.
    assert.equal(valueAfter(a, '--tools'), '');
    // Belt and braces: an explicit deny list for the built-ins, so an older
    // CLI that ignores `--tools ""` still refuses them.
    const denyIdx = a.indexOf('--disallowedTools');
    assert.notEqual(denyIdx, -1, 'argv must carry --disallowedTools');
    const denied = new Set(a.slice(denyIdx + 1, denyIdx + 1 + CLI_BUILTIN_TOOL_DENYLIST.length));
    for (const tool of ['Bash', 'Edit', 'Write', 'Read', 'WebFetch', 'WebSearch', 'Agent']) {
      assert.ok(CLI_BUILTIN_TOOL_DENYLIST.includes(tool), `denylist names ${tool}`);
      assert.ok(denied.has(tool), `argv denies ${tool}`);
    }
    // Anything not pre-approved is denied instead of prompting a UI nobody sees.
    assert.equal(valueAfter(a, '--permission-mode'), 'dontAsk');
    // No user/project/local settings.json: the host user's `hooks` and
    // personal allow rules must not reach a session omadia spawns.
    assert.equal(valueAfter(a, '--setting-sources'), '');
    // The omadia loopback tools stay pre-approved.
    assert.equal(valueAfter(a, '--allowedTools'), 'mcp__omadia__*');
  });

  it('replaces the CLI system prompt instead of appending to it', async () => {
    const { agent, argv } = makeAgent({ systemPrompt: 'You are Hedwig, the HR assistant.' });
    await agent.chat({ userMessage: 'hi' });
    const a = argv();

    assert.equal(a.includes('--append-system-prompt'), false);
    const prompt = valueAfter(a, '--system-prompt');
    assert.ok(prompt, 'argv must carry --system-prompt');
    assert.match(prompt, /Hedwig, the HR assistant/);
    // The prompt names the runtime and the only toolset the model has.
    assert.match(prompt, /omadia/);
    assert.match(prompt, /mcp__omadia__/);
  });

  it('still replaces the system prompt when no omadia prompt is configured', async () => {
    const { agent, argv } = makeAgent();
    await agent.chat({ userMessage: 'hi' });
    const prompt = valueAfter(argv(), '--system-prompt');
    assert.ok(prompt && prompt.length > 0);
    assert.match(prompt, /omadia/);
  });

  it('composeCliSystemPrompt keeps the caller prompt first and appends the runtime context once', () => {
    const composed = composeCliSystemPrompt('Persona text.');
    assert.ok(composed.startsWith('Persona text.'));
    assert.equal(composed.split('mcp__omadia__').length, 2);
    assert.equal(composeCliSystemPrompt(undefined), composeCliSystemPrompt(''));
  });
});

describe('CliChatAgent turn context reaches the loopback server (OM-82)', () => {
  it('constructs the loopback server inside the async context chat() was called in', async () => {
    const turnStore = new AsyncLocalStorage<string>();
    let storeAtConstruction: string | undefined = 'never-called';

    const agent = new CliChatAgent({
      dispatch: {
        listDispatchableToolSpecs: () => [],
      } as unknown as CliChatAgentDeps['dispatch'],
      // The factory runs where `LoopbackMcpServer` takes its snapshot. If server
      // creation were hoisted out of the turn (e.g. into the constructor), this
      // would read `undefined` and the snapshot would carry no user context.
      createLoopbackServer: () => {
        storeAtConstruction = turnStore.getStore();
        return {
          start: async () => ({ url: 'http://127.0.0.1:1/mcp', port: 1, bearer: 'b' }),
          stop: async () => {},
        } as never;
      },
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
          kill: () => true,
        });
        stdin.on('finish', () => {
          stdout.end(
            JSON.stringify({ type: 'result', is_error: false, result: 'ok', num_turns: 1 }) + '\n',
          );
          child.exitCode = 0;
          child.emit('close', 0, null);
        });
        return child;
      }) as unknown as CliChatAgentDeps['spawnFn'],
    });

    await turnStore.run('turn:te-printline/silvio', () => agent.chat({ userMessage: 'hi' }));
    assert.equal(storeAtConstruction, 'turn:te-printline/silvio');
  });
});

describe('StreamJsonParser foreign tool marking (OM-81)', () => {
  it('flags tool calls outside mcp__omadia__* as foreign', () => {
    const p = new StreamJsonParser(() => 0);
    const events = p.push(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'whoami' } },
            { type: 'tool_use', id: 'b', name: 'mcp__omadia__query_processes', input: {} },
          ],
        },
      }),
    );
    const byId = new Map(events.map((e) => [(e as { id: string }).id, e]));
    const bash = byId.get('a') as { type: string; foreign?: true };
    const omadia = byId.get('b') as { type: string; foreign?: true };
    assert.equal(bash.type, 'tool_use');
    assert.equal(bash.foreign, true);
    assert.equal(omadia.type, 'tool_use');
    assert.equal('foreign' in omadia, false);
  });
});
