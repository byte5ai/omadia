import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { PassThrough } from 'node:stream';

import {
  CliChatAgent,
  StreamJsonParser,
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
