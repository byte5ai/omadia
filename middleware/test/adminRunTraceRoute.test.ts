import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';

import express from 'express';

import { InMemoryMemoryStore } from '../packages/harness-memory/src/inMemoryMemoryStore.js';
import { InMemoryKnowledgeGraph } from '../packages/harness-knowledge-graph-inmemory/src/inMemoryKnowledgeGraph.js';
import { CaptureFilter } from '../packages/harness-orchestrator-extras/src/captureFilter.js';
import { CaptureFilteringKnowledgeGraph } from '../packages/harness-orchestrator-extras/src/captureFilteringKnowledgeGraph.js';
import { SessionLogger } from '../packages/harness-orchestrator/src/sessionLogger.js';
import { RunTraceOutcomeStats } from '../packages/harness-orchestrator/src/runTraceObservability.js';
import { createAdminRouter } from '../src/routes/admin.js';

/**
 * #1082 — the count of capture-filtered turns must be visible as a counter,
 * not only as a log line. `GET /admin/run-trace` is where an operator reads it;
 * driven here through the real decorator and the real SessionLogger, so a
 * counter that is incremented but never surfaced fails.
 */

const TOKEN = 'test-admin-token';
let server: Server;
let base: string;
let current: RunTraceOutcomeStats | undefined;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(
    '/admin',
    createAdminRouter({
      token: TOKEN,
      store: {} as never, // this route touches no store
      runTraceStats: () => current,
    }),
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

after(() => {
  server.close();
});

beforeEach(() => {
  current = new RunTraceOutcomeStats();
});

const get = async (): Promise<{ status: number; body: Record<string, unknown> }> => {
  const res = await fetch(`${base}/admin/run-trace`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

function loggerScoring(score: number, stats: RunTraceOutcomeStats): SessionLogger {
  const filter = new CaptureFilter({
    captureLevel: 'normal',
    defaultVisibility: 'team',
    significanceThreshold: 0.2,
    significanceScorer: { score: async () => ({ score }) },
    log: () => {},
  });
  const graph = new CaptureFilteringKnowledgeGraph({
    inner: new InMemoryKnowledgeGraph(),
    filter,
    log: () => {},
  });
  return new SessionLogger(new InMemoryMemoryStore(), graph, undefined, undefined, stats);
}

describe('#1082 GET /admin/run-trace', () => {
  it('requires the admin token', async () => {
    const res = await fetch(`${base}/admin/run-trace`);
    assert.equal(res.status, 401);
  });

  it('answers 503 while no orchestrator has published the tally', async () => {
    current = undefined;
    const { status, body } = await get();
    assert.equal(status, 503);
    assert.equal(body['error'], 'run_trace_stats_unavailable');
  });

  it('reports filtered turns as a counter, separate from the trace outcomes', async () => {
    const stats = current!;
    // Two loggers, one tally — the production wiring (every Agent's logger
    // shares the plugin's instance).
    await loggerScoring(0.0, stats).log({
      scope: 'sess-1082-route-a',
      userMessage: 'ok',
      assistantAnswer: 'ok',
      time: '2026-09-24T10:00:00.000Z',
    });
    await loggerScoring(0.9, stats).log({
      scope: 'sess-1082-route-b',
      userMessage: 'Wer hat das Angebot freigegeben?',
      assistantAnswer: 'Anna Müller, am Dienstag.',
      time: '2026-09-24T10:00:01.000Z',
    });

    const { status, body } = await get();
    assert.equal(status, 200);
    assert.equal(body['captureTailOnlyTurns'], 1);
    assert.equal(body['droppedTotal'], 0);
    assert.deepEqual(body['outcomes'], {
      recorded: 0,
      'no-graph-sink': 0,
      'transcript-failed': 0,
      'turn-ingest-failed': 0,
      'run-ingest-failed': 0,
    });
  });
});
