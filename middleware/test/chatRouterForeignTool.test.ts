/**
 * #1008 / #1017 item 4 — the chat route's handling of FOREIGN tool calls.
 *
 * A foreign call is one the subscription-CLI agent made outside omadia's
 * loopback MCP server, i.e. one of the CLI's own built-ins. OM-81 (#991)
 * removes those at spawn time, so a foreign event means the gate leaked.
 * Before this, the flag reached the wire and nothing acted on it: no log, no
 * counter, and the matching `tool_result` was unmarked, so the pair was
 * inconsistent in the trace.
 *
 * These tests drive the real `/chat/stream` handler over a loopback server
 * with a fake `chatStream` generator, then read the NDJSON back.
 */

import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import type { ChatAgent } from '@omadia/orchestrator';
import { createChatRouter } from '../src/routes/chat.js';
import {
  getForeignToolMetrics,
  resetForeignToolMetrics,
} from '../src/platform/foreignToolMetrics.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

const SLUG = 'fallback';

/** A ChatAgent whose stream yields exactly the events handed in. */
function streamingAgent(events: readonly unknown[]): ChatAgent {
  return {
    chat: () => {
      throw new Error('not used in these tests');
    },
    chatStream: () =>
      (async function* gen() {
        for (const e of events) yield e;
      })(),
  } as unknown as ChatAgent;
}

async function collectStream(
  events: readonly unknown[],
): Promise<Array<Record<string, unknown>>> {
  const app = express();
  app.use(express.json());
  app.use(
    createChatRouter({
      resolveChatAgent: (slug) => (slug === SLUG ? streamingAgent(events) : undefined),
      getDefaultSlug: () => SLUG,
    }),
  );

  const server: Server = await listenLoopback(app);
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${String(port)}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'run whoami' }),
    });
    assert.equal(res.status, 200);
    const body = await res.text();
    return body
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe('chat route — foreign tool calls (#1008)', () => {
  afterEach(() => {
    resetForeignToolMetrics();
  });

  it('counts a foreign tool_use and stamps its matching tool_result', async () => {
    const lines = await collectStream([
      { type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'whoami' }, foreign: true },
      { type: 'tool_result', id: 'call-1', output: 'silviolange', durationMs: 12 },
      { type: 'done', answer: 'ok', toolCalls: 1, iterations: 1 },
    ]);

    const use = lines.find((l) => l['type'] === 'tool_use');
    const result = lines.find((l) => l['type'] === 'tool_result');
    assert.equal(use?.['foreign'], true, 'tool_use keeps its foreign flag on the wire');
    assert.equal(
      result?.['foreign'],
      true,
      'tool_result is stamped so the pair is consistent in the trace',
    );

    const m = getForeignToolMetrics();
    assert.equal(m.calls, 1);
    assert.deepEqual(m.byTool, { Bash: 1 });
    assert.deepEqual(m.byAgent, { [SLUG]: 1 });
  });

  it('leaves an omadia tool call untouched and uncounted', async () => {
    const lines = await collectStream([
      { type: 'tool_use', id: 'call-1', name: 'mcp__omadia__manage_routine', input: {} },
      { type: 'tool_result', id: 'call-1', output: 'created', durationMs: 5 },
      { type: 'done', answer: 'ok', toolCalls: 1, iterations: 1 },
    ]);

    const use = lines.find((l) => l['type'] === 'tool_use');
    const result = lines.find((l) => l['type'] === 'tool_result');
    assert.equal(use?.['foreign'], undefined);
    assert.equal(result?.['foreign'], undefined);
    assert.equal(getForeignToolMetrics().calls, 0);
  });

  it('stamps only the result whose id was foreign, not every later result', async () => {
    const lines = await collectStream([
      { type: 'tool_use', id: 'bad', name: 'Bash', input: {}, foreign: true },
      { type: 'tool_use', id: 'good', name: 'mcp__omadia__canvas_publish', input: {} },
      { type: 'tool_result', id: 'good', output: 'published', durationMs: 3 },
      { type: 'tool_result', id: 'bad', output: 'silviolange', durationMs: 9 },
      { type: 'done', answer: 'ok', toolCalls: 2, iterations: 1 },
    ]);

    const results = lines.filter((l) => l['type'] === 'tool_result');
    const good = results.find((r) => r['id'] === 'good');
    const bad = results.find((r) => r['id'] === 'bad');
    assert.equal(good?.['foreign'], undefined, 'an omadia result must stay unmarked');
    assert.equal(bad?.['foreign'], true);
    assert.equal(getForeignToolMetrics().calls, 1);
  });
});
