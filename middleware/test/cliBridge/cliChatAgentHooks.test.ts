import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { PassThrough } from 'node:stream';

import { CliChatAgent } from '../../packages/harness-orchestrator/src/cliChatAgent.js';
import type {
  CliChatAgentDeps,
  CliSpawnLogger,
  CliUsage,
} from '../../packages/harness-orchestrator/src/cliChatAgent.js';
import type { ChatStreamEvent } from '../../packages/harness-channel-sdk/src/chatAgent.js';

/**
 * #1072 — `CliChatAgent.chat(input, hooks)` hands every lifecycle event and the
 * terminal usage to the caller while keeping `chat()`'s error semantics (a
 * terminal `is_error` result still throws). `createCliSubAgent` builds the
 * builder's live view on top of these hooks.
 */

const silentLogger: CliSpawnLogger = { info: () => undefined, warn: () => undefined };

function line(payload: unknown): string {
  return `${JSON.stringify(payload)}\n`;
}

const SUCCESS_LINES = [
  line({ type: 'stream_event', event: { type: 'message_start' } }),
  line({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hallo' } },
  }),
  line({
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id: 'tu_1', name: 'mcp__omadia__fill_slot', input: { slotKey: 'x' } },
      ],
    },
  }),
  line({
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: 'ok' }] }],
    },
  }),
  line({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Hallo fertig',
    num_turns: 2,
    usage: {
      input_tokens: 11,
      output_tokens: 22,
      cache_read_input_tokens: 33,
      cache_creation_input_tokens: 44,
    },
  }),
];

const ERROR_LINES = [
  line({
    type: 'result',
    subtype: 'error_max_turns',
    is_error: true,
    result: 'too many turns',
    num_turns: 9,
    usage: { input_tokens: 1, output_tokens: 1 },
  }),
];

function makeAgent(stdoutLines: readonly string[]): CliChatAgent {
  return new CliChatAgent({
    dispatch: {
      listDispatchableToolSpecs: () => [],
    } as unknown as CliChatAgentDeps['dispatch'],
    createLoopbackServer: () =>
      ({
        start: async () => ({ url: 'http://127.0.0.1:1/mcp', port: 1, bearer: 'bearer' }),
        stop: async () => {},
      }) as never,
    resolveCliVersion: async () => '2.1.259',
    logger: silentLogger,
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
        stdout.end(stdoutLines.join(''));
        stderr.end();
        child.exitCode = 0;
        child.emit('close', 0, null);
      });
      return child;
    }) as unknown as CliChatAgentDeps['spawnFn'],
  });
}

describe('CliChatAgent.chat hooks (#1072)', () => {
  it('delivers lifecycle events in order and the terminal usage', async () => {
    const events: ChatStreamEvent[] = [];
    const usages: CliUsage[] = [];
    const agent = makeAgent(SUCCESS_LINES);

    const answer = await agent.chat(
      { userMessage: 'hi' },
      { onEvent: (ev) => events.push(ev), onUsage: (u) => usages.push(u) },
    );

    assert.equal(answer.text, 'Hallo fertig');
    assert.deepEqual(
      events.map((e) => e.type),
      ['text_delta', 'tool_use', 'tool_result', 'done'],
    );
    const toolUse = events[1];
    assert.ok(toolUse?.type === 'tool_use');
    assert.equal(toolUse.name, 'mcp__omadia__fill_slot');
    const toolResult = events[2];
    assert.ok(toolResult?.type === 'tool_result');
    assert.equal(toolResult.output, 'ok');
    assert.equal(usages.length, 1);
    assert.equal(usages[0]?.inputTokens, 11);
    assert.equal(usages[0]?.outputTokens, 22);
    assert.equal(usages[0]?.cacheReadInputTokens, 33);
    assert.equal(usages[0]?.cacheCreationInputTokens, 44);
  });

  it('does not fail the turn when a hook throws', async (t) => {
    t.mock.method(console, 'warn', () => undefined);
    const agent = makeAgent(SUCCESS_LINES);

    const answer = await agent.chat(
      { userMessage: 'hi' },
      {
        onEvent: () => {
          throw new Error('listener bug');
        },
        onUsage: () => {
          throw new Error('listener bug');
        },
      },
    );

    assert.equal(answer.text, 'Hallo fertig');
  });

  it('still throws on a terminal is_error result and reports no usage', async () => {
    const usages: CliUsage[] = [];
    const agent = makeAgent(ERROR_LINES);

    await assert.rejects(
      agent.chat({ userMessage: 'hi' }, { onUsage: (u) => usages.push(u) }),
      /error_max_turns/,
    );
    assert.equal(usages.length, 0);
  });

  it('keeps working without hooks', async () => {
    const agent = makeAgent(SUCCESS_LINES);
    const answer = await agent.chat({ userMessage: 'hi' });
    assert.equal(answer.text, 'Hallo fertig');
  });
});
