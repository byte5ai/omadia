/**
 * Issue #1082 — a turn the capture filter drops below the significance
 * threshold still gets its run trace, is never blamed on a missing
 * User-Cluster, and is COUNTED rather than only logged.
 *
 * #1171 (the #1096 fix) already changed the capture filter to write such a
 * turn as a tail-only record instead of skipping it, which is what lets
 * `ingestRun` find the Turn node. Nothing pinned that end to end — through the
 * real decorator, the real `SessionLogger` and the real in-memory graph — so a
 * regression back to "skip and return a synthetic id" would have gone
 * unnoticed. These tests pin the whole chain, plus the part #1171 left open:
 * the count of filtered turns (acceptance criterion 4 of the issue).
 *
 * Imported from SOURCE, not the built barrels, so a mutation in `src/` cannot
 * report green over stale `dist/`.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

import { turnNodeId } from '@omadia/plugin-api';
import { InMemoryMemoryStore } from '../packages/harness-memory/src/inMemoryMemoryStore.js';
import { InMemoryKnowledgeGraph } from '../packages/harness-knowledge-graph-inmemory/src/inMemoryKnowledgeGraph.js';
import { CaptureFilter } from '../packages/harness-orchestrator-extras/src/captureFilter.js';
import { CaptureFilteringKnowledgeGraph } from '../packages/harness-orchestrator-extras/src/captureFilteringKnowledgeGraph.js';
import { SessionLogger } from '../packages/harness-orchestrator/src/sessionLogger.js';
import { RunTraceOutcomeStats } from '../packages/harness-orchestrator/src/runTraceObservability.js';
import type { RunTracePayload } from '../packages/harness-channel-sdk/src/chatAgent.js';

const THRESHOLD = 0.2;

function payload(scope: string, over: Partial<RunTracePayload> = {}): RunTracePayload {
  return {
    scope,
    startedAt: '2026-09-24T10:00:00.000Z',
    finishedAt: '2026-09-24T10:00:01.250Z',
    durationMs: 1250,
    status: 'success',
    iterations: 1,
    orchestratorToolCalls: [
      {
        callId: 'toolu_1082',
        toolName: 'memory',
        durationMs: 40,
        isError: false,
        agentContext: 'orchestrator',
      },
    ],
    agentInvocations: [],
    model: 'claude-sonnet-4-5-20250929',
    provider: 'anthropic',
    ...over,
  };
}

/** A filter at the default level and threshold, with a scorer that returns a
 *  fixed score — or no scorer at all, the "no Anthropic key" install. */
function filterWith(score: number | undefined): CaptureFilter {
  return new CaptureFilter({
    captureLevel: 'normal',
    defaultVisibility: 'team',
    significanceThreshold: THRESHOLD,
    ...(score === undefined
      ? {}
      : { significanceScorer: { score: async () => ({ score }) } }),
    log: () => {},
  });
}

interface Rig {
  graph: InMemoryKnowledgeGraph;
  stats: RunTraceOutcomeStats;
  logger: SessionLogger;
}

function rig(score: number | undefined): Rig {
  const graph = new InMemoryKnowledgeGraph();
  const wrapped = new CaptureFilteringKnowledgeGraph({
    inner: graph,
    filter: filterWith(score),
    log: () => {},
  });
  const stats = new RunTraceOutcomeStats();
  const logger = new SessionLogger(
    new InMemoryMemoryStore(),
    wrapped,
    undefined,
    undefined,
    stats,
  );
  return { graph, stats, logger };
}

let warnings: string[] = [];
const realWarn = console.warn;
const realError = console.error;

beforeEach(() => {
  warnings = [];
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.map(String).join(' '));
  };
  // The logger reports a failed turn ingest on stderr; capture it too so a
  // regression shows up as an assertion rather than as noise.
  console.error = (...args: unknown[]): void => {
    warnings.push(args.map(String).join(' '));
  };
});

afterEach(() => {
  console.warn = realWarn;
  console.error = realError;
});

describe('#1082 — capture-filtered turns keep their run trace and are counted', () => {
  it('records the full trace of a sub-threshold turn, with no #684 blame', async () => {
    const { graph, stats, logger } = rig(0.0);
    const scope = 'sess-1082-a';

    const { turnExternalId } = await logger.log({
      scope,
      userMessage: 'Antworte nur mit dem Wort pong.',
      assistantAnswer: 'pong',
      time: '2026-09-24T10:00:01.300Z',
      runTrace: payload(scope),
    });

    // Criterion 1 — the trace exists and carries model, duration and tool calls.
    const graphStats = await graph.stats();
    assert.equal(graphStats.byNodeType.Run, 1);
    const view = await graph.getRunForTurn(turnExternalId);
    assert.ok(view, 'the run trace of a filtered turn must be readable');
    assert.equal(view.run.props['model'], 'claude-sonnet-4-5-20250929');
    assert.equal(view.run.props['provider'], 'anthropic');
    assert.equal(view.run.props['durationMs'], 1250);
    assert.equal(view.orchestratorToolCalls.length, 1);
    assert.equal(view.orchestratorToolCalls[0]?.node.props['toolName'], 'memory');
    // The Turn behind it is the tail-only record, not a knowledge turn.
    assert.equal(view.turn.props['tailOnly'], true);

    // Criterion 3 — booked as recorded, and nothing blames a User-Cluster.
    // Note: InMemoryKnowledgeGraph.ingestRun does not check that the Turn
    // exists, so these asserts alone would stay green if the old skip bug
    // returned. The regression is caught by `assert.ok(view)` above.
    assert.equal(stats.snapshot().recorded, 1);
    assert.equal(stats.snapshot()['run-ingest-failed'], 0);
    assert.equal(stats.droppedTotal(), 0);
    assert.deepEqual(
      warnings.filter(
        (w) =>
          w.includes('run-ingest-failed') ||
          w.includes('#684') ||
          w.includes('User-Cluster'),
      ),
      [],
    );

    // Criterion 4 — the filtered turn is a number, not only a log line.
    assert.equal(stats.captureTailOnlyTurns(), 1);
  });

  it('does not count a turn that clears the threshold', async () => {
    const { stats, logger } = rig(0.9);
    const scope = 'sess-1082-b';

    await logger.log({
      scope,
      userMessage: 'Wie läuft der tägliche ETL-Job?',
      assistantAnswer: '1) … 2) … 3) …',
      time: '2026-09-24T10:00:02.000Z',
      runTrace: payload(scope),
    });

    assert.equal(stats.snapshot().recorded, 1);
    assert.equal(stats.captureTailOnlyTurns(), 0);
  });

  it('keeps the two counters independent across mixed turns', async () => {
    // One scorer, two answers: the first turn is filtered, the second is not.
    const scores = [0.05, 0.9];
    const graph = new InMemoryKnowledgeGraph();
    const filter = new CaptureFilter({
      captureLevel: 'normal',
      defaultVisibility: 'team',
      significanceThreshold: THRESHOLD,
      significanceScorer: { score: async () => ({ score: scores.shift() ?? 0 }) },
      log: () => {},
    });
    const stats = new RunTraceOutcomeStats();
    const logger = new SessionLogger(
      new InMemoryMemoryStore(),
      new CaptureFilteringKnowledgeGraph({ inner: graph, filter, log: () => {} }),
      undefined,
      undefined,
      stats,
    );
    const scope = 'sess-1082-mixed';

    await logger.log({
      scope,
      userMessage: 'ok',
      assistantAnswer: 'ok',
      time: '2026-09-24T10:00:03.000Z',
      runTrace: payload(scope),
    });
    await logger.log({
      scope,
      userMessage: 'Wer hat das Angebot freigegeben?',
      assistantAnswer: 'Anna Müller, am Dienstag.',
      time: '2026-09-24T10:00:04.000Z',
      runTrace: payload(scope),
    });

    assert.equal(stats.snapshot().recorded, 2, 'both traces are recorded');
    assert.equal(stats.captureTailOnlyTurns(), 1, 'only the filtered turn is counted');
    assert.equal((await graph.stats()).byNodeType.Run, 2);
  });

  it('counts a filtered turn even when it carried no run trace', async () => {
    // Criterion 4 asks for the number of FILTERED TURNS, not of traces: a turn
    // the orchestrator collected no trace for is still a turn the filter
    // judged below the bar.
    const { stats, logger } = rig(0.0);

    await logger.log({
      scope: 'sess-1082-c',
      userMessage: 'danke',
      assistantAnswer: 'gern',
      time: '2026-09-24T10:00:05.000Z',
    });

    assert.equal(stats.captureTailOnlyTurns(), 1);
    // No trace means no trace outcome at all — neither recorded nor dropped.
    assert.equal(stats.snapshot().recorded, 0);
    assert.equal(stats.droppedTotal(), 0);
  });

  it('with no scorer configured nothing is filtered and the trace is recorded as before', async () => {
    // The negative case from the issue: no Anthropic key → `no-scorer:
    // scorer-skipped` → significance stays null → the turn persists normally.
    const { graph, stats, logger } = rig(undefined);
    const scope = 'sess-1082-d';

    const { turnExternalId } = await logger.log({
      scope,
      userMessage: 'pong?',
      assistantAnswer: 'pong',
      time: '2026-09-24T10:00:06.000Z',
      runTrace: payload(scope),
    });

    assert.equal(stats.captureTailOnlyTurns(), 0);
    assert.equal(stats.snapshot().recorded, 1);
    assert.equal(turnExternalId, turnNodeId(scope, '2026-09-24T10:00:06.000Z'));
    const view = await graph.getRunForTurn(turnExternalId);
    assert.ok(view);
    assert.notEqual(view.turn.props['tailOnly'], true);
  });
});
