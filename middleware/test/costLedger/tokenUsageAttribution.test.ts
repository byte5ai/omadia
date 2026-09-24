import { strict as assert } from 'node:assert';
import { PassThrough } from 'node:stream';
import { afterEach, describe, it, mock } from 'node:test';

import {
  CLI_CHAT_USAGE_SOURCE,
  flushUsageRecorder,
  initUsageRecorder,
  recordUsage,
  setUsageContextProvider,
  withProviderUsageTracking,
} from '@omadia/usage-telemetry';
import type { LlmProvider, LlmRequest, LlmStreamEvent } from '@omadia/llm-provider';
import type { Pool } from 'pg';

import { CliChatAgent } from '../../packages/harness-orchestrator/src/cliChatAgent.js';
import type { CliChatAgentDeps } from '../../packages/harness-orchestrator/src/cliChatAgent.js';
import { routeTurnModel } from '../../packages/harness-orchestrator/src/modelRouter.js';
import { routeTurnPersona } from '../../packages/harness-orchestrator/src/personaRouter.js';
import { streamMessageEvents } from '../../packages/harness-orchestrator/src/streaming.js';
import {
  currentUsageContext,
  turnContext,
} from '../../packages/harness-orchestrator/src/turnContext.js';

/**
 * #1098 — a cost-ledger row could not be attributed to a turn, a session, or a
 * real point in time: no write site passed ids, there was no `turn_id` column,
 * and `created_at` recorded the 5s flush tick (DEFAULT NOW() at flush) rather
 * than the call. These tests pin the fix at the recorder seam:
 *   - turn attribution is read from the ambient turn context the orchestrator
 *     registers via `setUsageContextProvider`;
 *   - the call time (`occurredAt`) is frozen at `recordUsage()` and written to
 *     `created_at`, so it survives the buffered flush;
 *   - a call site with no turn context still writes NULL ids, never throws.
 */

interface CapturedQuery {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function fakePool(captured: CapturedQuery[]): Pool {
  return {
    query: (sql: string, params: readonly unknown[]) => {
      captured.push({ sql, params });
      return Promise.resolve({ rows: [] });
    },
  } as unknown as Pool;
}

/** Column order of the INSERT in `recorder.ts` (10 from 0028/0032, +3 from #1098). */
const COL = {
  source: 0,
  model: 1,
  inputTokens: 2,
  outputTokens: 3,
  cacheReadTokens: 4,
  cacheCreationTokens: 5,
  costUsd: 6,
  tenantId: 7,
  sessionId: 8,
  referenceCostUsd: 9,
  turnId: 10,
  provider: 11,
  createdAt: 12,
} as const;

// One pool for the file: `initUsageRecorder` is idempotent (first pool wins),
// so cases clear the buffer/capture between them rather than re-initialising.
const captured: CapturedQuery[] = [];
initUsageRecorder(fakePool(captured));

function metered(source: string): void {
  recordUsage({
    source,
    model: 'claude-sonnet-5',
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  });
}

const COLS = 13;

/**
 * Every row flushed so far, as its 13-value slice. Robust against the
 * recorder's own 5s interval flush splitting a case across two queries.
 */
async function flushedRows(): Promise<readonly (readonly unknown[])[]> {
  await flushUsageRecorder();
  return captured.flatMap((q) => {
    const rows: (readonly unknown[])[] = [];
    for (let i = 0; i < q.params.length; i += COLS) {
      rows.push(q.params.slice(i, i + COLS));
    }
    return rows;
  });
}

describe('#1098 — cost-ledger rows carry turn attribution and call time', () => {
  afterEach(() => {
    setUsageContextProvider(undefined);
    captured.length = 0;
  });

  it('writes a turn with session_id and turn_id from the ambient context', async () => {
    setUsageContextProvider(() => ({ turnId: 'turn-1', sessionId: 'sess-1' }));

    metered('orchestrator');
    await flushUsageRecorder();

    const row = captured[0];
    assert.ok(row);
    assert.match(row.sql, /turn_id/);
    assert.match(row.sql, /created_at/);
    assert.equal(row.params[COL.turnId], 'turn-1');
    assert.equal(row.params[COL.sessionId], 'sess-1');
  });

  it('keeps two turns in the same flush window separable via turn_id', async () => {
    // Both rows land in ONE flush — the exact case where created_at collides
    // and only turn_id can tell them apart.
    setUsageContextProvider(() => ({ turnId: 'turn-A', sessionId: 'sess-A' }));
    metered('orchestrator');
    setUsageContextProvider(() => ({ turnId: 'turn-B', sessionId: 'sess-B' }));
    metered('extras');

    await flushUsageRecorder();

    // Single multi-row INSERT: one query, two rows' worth of params.
    assert.equal(captured.length, 1);
    const row = captured[0];
    assert.ok(row);
    const cols = 13;
    assert.equal(row.params[COL.turnId], 'turn-A');
    assert.equal(row.params[cols + COL.turnId], 'turn-B');
    assert.notEqual(row.params[COL.turnId], row.params[cols + COL.turnId]);
  });

  it("writes the call's occurredAt to created_at, not the flush tick", async () => {
    // A call time well before the flush; if the row leaned on DEFAULT NOW() the
    // recorder would have to drop this, and the column would carry flush time.
    const callTime = new Date('2026-01-02T03:04:05.678Z');
    recordUsage({
      source: 'orchestrator',
      model: 'claude-sonnet-5',
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      occurredAt: callTime,
    });

    await flushUsageRecorder();

    const row = captured[0];
    assert.ok(row);
    assert.equal(row.params[COL.createdAt], callTime);
  });

  it('freezes the DEFAULT call time at recordUsage(), not at the flush', async () => {
    // No production caller passes `occurredAt`, so this default is the path
    // that matters. Record, let the clock move past it, then flush.
    const before = Date.now();
    metered('orchestrator');
    const recordedBy = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const flushStart = Date.now();
    assert.ok(recordedBy < flushStart);

    const [row] = await flushedRows();
    assert.ok(row);
    const createdAt = row[COL.createdAt];
    assert.ok(createdAt instanceof Date);
    assert.ok(createdAt.getTime() >= before);
    assert.ok(
      createdAt.getTime() <= recordedBy,
      'created_at must carry the call time, not the flush time',
    );
  });

  it('lets ids passed on the UsageRecord win over the ambient context', async () => {
    // The CLI seam relies on this: it passes its own turn id while running
    // inside a route's outer scope.
    setUsageContextProvider(() => ({ turnId: 'ctx-t', sessionId: 'ctx-s' }));
    recordUsage({
      source: 'orchestrator',
      model: 'claude-sonnet-5',
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      turnId: 'exp-t',
      sessionId: 'exp-s',
    });

    const [row] = await flushedRows();
    assert.ok(row);
    assert.equal(row[COL.turnId], 'exp-t');
    assert.equal(row[COL.sessionId], 'exp-s');
  });

  it('writes NULL ids (and does not throw) with no turn context', async () => {
    setUsageContextProvider(undefined);

    assert.doesNotThrow(() => metered('background-job'));
    await flushUsageRecorder();

    const row = captured[0];
    assert.ok(row);
    assert.equal(row.params[COL.turnId], null);
    assert.equal(row.params[COL.sessionId], null);
    assert.equal(row.params[COL.tenantId], null);
  });

  it('logs a throwing context provider once and still writes the row', async () => {
    const warn = mock.method(console, 'warn', () => undefined);
    try {
      setUsageContextProvider(() => {
        throw new Error('ctx boom');
      });
      assert.doesNotThrow(() => metered('orchestrator'));
      metered('orchestrator');

      const rows = await flushedRows();
      assert.equal(rows.length, 2);
      for (const row of rows) assert.equal(row[COL.turnId], null);
      const logged = warn.mock.calls.filter((c) =>
        String(c.arguments[0]).includes('context provider threw'),
      );
      assert.equal(logged.length, 1, 'a throwing provider must be visible, once');
    } finally {
      warn.mock.restore();
    }
  });
});

describe('#1098 — each capture seam names the provider that generated the cost', () => {
  afterEach(() => {
    setUsageContextProvider(undefined);
    captured.length = 0;
  });

  const response = {
    content: [{ type: 'text', text: 'SIMPLE' }],
    finishReason: 'stop',
    model: 'claude-haiku-4-5',
    usage: { inputTokens: 4, outputTokens: 1 },
  };

  it('withProviderUsageTracking records the wrapped provider id (complete + stream)', async () => {
    const fake = {
      id: 'fake-prov',
      capabilities: {},
      complete: () => Promise.resolve(response),
      stream: async function* () {
        yield { type: 'final', response };
      },
      classifyError: () => ({ retryable: false, kind: 'other' }),
    } as unknown as Parameters<typeof withProviderUsageTracking>[0];
    const tracked = withProviderUsageTracking(fake, { source: 'extras' });

    await tracked.complete({ model: 'claude-haiku-4-5', messages: [] } as never);
    for await (const _ev of tracked.stream({
      model: 'claude-haiku-4-5',
      messages: [],
    } as never)) {
      // drain
    }

    const rows = await flushedRows();
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row[COL.source], 'extras');
      assert.equal(row[COL.provider], 'fake-prov');
    }
  });

  it('the model and persona routers record their classifier provider', async () => {
    const classifier = { id: 'router-prov', complete: () => Promise.resolve(response) };

    await routeTurnModel(
      classifier as never,
      { classifierModel: 'claude-haiku-4-5', simpleModel: 's', complexModel: 'c' },
      'hi',
      'fb',
    );
    await routeTurnPersona(
      classifier as never,
      [{ skillId: 'sk-1', slug: 'simple', name: 'Simple', description: 'd' }],
      'hi',
      'claude-haiku-4-5',
    );

    const rows = await flushedRows();
    assert.deepEqual(
      rows.map((r) => [r[COL.source], r[COL.provider]]),
      [
        ['model-router', 'router-prov'],
        ['persona-router', 'router-prov'],
      ],
    );
  });
});

describe('#1098 — a streaming orchestrator turn writes an attributed row', () => {
  afterEach(() => {
    setUsageContextProvider(undefined);
    captured.length = 0;
  });

  const PARAMS = {
    model: 'primary-model',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hi' }],
  };
  const FB_PARAMS = { ...PARAMS, model: 'fallback-model' };
  const provider = (id: string, stream: (req: LlmRequest) => AsyncIterable<LlmStreamEvent>) =>
    ({
      id,
      capabilities: {},
      stream,
      classifyError: () => ({ retryable: false, kind: 'auth' }),
    }) as unknown as LlmProvider;
  const answering = (id: string) =>
    provider(id, (req) => ({
      async *[Symbol.asyncIterator]() {
        const usage = { inputTokens: 7, outputTokens: 3 };
        yield {
          type: 'final',
          response: { content: [], finishReason: 'stop', model: req.model, usage },
        } as LlmStreamEvent;
      },
    }));
  const failing = (id: string) =>
    provider(id, () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(Object.assign(new Error(`${id} auth`), { status: 401 })),
      }),
    }));

  async function streamTurn(
    args: Omit<Parameters<typeof streamMessageEvents>[0], 'observer' | 'iteration' | 'streamLabel'>,
  ) {
    setUsageContextProvider(currentUsageContext);
    const ctx = { turnId: 't-stream', turnDate: '2026-09-24', sessionScope: 's-stream' };
    const gen = turnContext.runGenerator(ctx, () =>
      streamMessageEvents({
        ...args,
        observer: undefined,
        iteration: 0,
        streamLabel: 'orchestrator',
      }),
    );
    for await (const _ev of gen) {
      // drain
    }
    return flushedRows();
  }

  it('carries turn_id, session_id and the provider it ran on', async () => {
    const rows = await streamTurn({ provider: answering('prim'), params: PARAMS });
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.ok(row);
    assert.equal(row[COL.source], 'orchestrator');
    assert.equal(row[COL.turnId], 't-stream');
    assert.equal(row[COL.sessionId], 's-stream');
    assert.equal(row[COL.provider], 'prim');
  });

  it('names the fallback provider after a hop', async () => {
    const rows = await streamTurn({
      provider: failing('prim'),
      params: PARAMS,
      fallback: { provider: answering('backup'), params: FB_PARAMS },
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.[COL.provider], 'backup');
    assert.equal(rows[0]?.[COL.model], 'fallback-model');
    assert.equal(rows[0]?.[COL.turnId], 't-stream');
  });
});

describe('#1098 — claude-cli turns carry their own turn id', () => {
  afterEach(() => {
    setUsageContextProvider(undefined);
    captured.length = 0;
  });

  /** A CLI that answers every turn with one terminal result line. */
  function cliAgent(): CliChatAgent {
    return new CliChatAgent({
      dispatch: {
        listDispatchableToolSpecs: () => [],
      } as unknown as CliChatAgentDeps['dispatch'],
      createLoopbackServer: () =>
        ({
          start: async () => ({ url: 'http://127.0.0.1:1/mcp', port: 1, bearer: 'b' }),
          stop: async () => {},
        }) as never,
      resolveCliVersion: async () => '2.1.259',
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
            JSON.stringify({
              type: 'result',
              is_error: false,
              result: 'ok',
              num_turns: 1,
              total_cost_usd: 0.01,
              usage: { input_tokens: 5, output_tokens: 9 },
            }) + '\n',
          );
          child.exitCode = 0;
          child.emit('close', 0, null);
        });
        return child;
      }) as unknown as CliChatAgentDeps['spawnFn'],
    });
  }

  it("does not inherit the route's placeholder id, and two turns stay separable", async () => {
    // Production wiring: the orchestrator's provider is registered, and the
    // CLI runs inside chat.ts's outer scope — never inside an orchestrator one.
    setUsageContextProvider(currentUsageContext);
    const agent = cliAgent();

    await turnContext.run({ turnId: 'http-chat-sess-cli', turnDate: '2026-09-24' }, async () => {
      await agent.chat({ userMessage: 'one', sessionScope: 'sess-cli' });
      await agent.chat({ userMessage: 'two', sessionScope: 'sess-cli' });
    });

    const rows = await flushedRows();
    assert.equal(rows.length, 2);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    for (const row of rows) {
      assert.equal(row[COL.source], CLI_CHAT_USAGE_SOURCE);
      assert.equal(row[COL.provider], 'claude-cli');
      assert.equal(row[COL.sessionId], 'sess-cli');
      assert.match(String(row[COL.turnId]), uuid);
    }
    assert.notEqual(rows[0]?.[COL.turnId], rows[1]?.[COL.turnId]);
  });
});
