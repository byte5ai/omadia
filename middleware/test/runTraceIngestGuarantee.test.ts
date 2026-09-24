/**
 * Issue #684 (epic #642) — the run trace is best-effort TELEMETRY, and every
 * drop is observable.
 *
 * #650 added `model` / `provider` to the persisted trace so a provenance
 * question about a past turn could be answered, then explicitly deferred the
 * harder question: is that record guaranteed? It is not. #684 decided it should
 * NOT be promised to be — the graph sink is optional, the Markdown transcript
 * is the surface that is guaranteed, and forcing the ingest through would mean
 * auto-creating User-Cluster nodes, which both graph implementations refuse on
 * purpose so channel-resolution bugs cannot hide behind orphan clusters.
 *
 * What the decision obliges is therefore not completeness but honesty: a turn
 * may leave no trace, and when it does that must be countable and greppable
 * rather than silent. These tests pin exactly that.
 *
 * The sharpest case is `no-graph-sink`. Before #684 three of the four drop
 * paths already wrote a `console.error`; that one returned in total silence, so
 * a deployment that had never recorded a single trace was indistinguishable
 * from a healthy one. Its test is the one that matters most here.
 *
 * Imported from SOURCE, not the built barrels, so a mutation in `src/` cannot
 * report green over stale `dist/`.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

import { InMemoryMemoryStore } from '../packages/harness-memory/src/inMemoryMemoryStore.js';
import { InMemoryKnowledgeGraph } from '../packages/harness-knowledge-graph-inmemory/src/inMemoryKnowledgeGraph.js';
import { SessionLogger } from '../packages/harness-orchestrator/src/sessionLogger.js';
import { RunTraceOutcomeStats } from '../packages/harness-orchestrator/src/runTraceObservability.js';
import type { RunTracePayload } from '../packages/harness-channel-sdk/src/chatAgent.js';

function payload(over: Partial<RunTracePayload> = {}): RunTracePayload {
  return {
    scope: 'sess-684',
    startedAt: '2026-08-13T10:00:00.000Z',
    finishedAt: '2026-08-13T10:00:02.000Z',
    durationMs: 2000,
    status: 'success',
    iterations: 1,
    orchestratorToolCalls: [],
    agentInvocations: [],
    model: 'claude-sonnet-4-5-20250929',
    provider: 'anthropic',
    ...over,
  };
}

const ENTRY = {
  scope: 'sess-684',
  userMessage: 'Wer hat das Angebot freigegeben?',
  assistantAnswer: 'Anna Müller.',
};

/** Capture warn output so "a warn line is emitted" is an assertion rather than
 *  something a reader has to take on faith. */
let warnings: string[] = [];
const realWarn = console.warn;

beforeEach(() => {
  warnings = [];
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.map(String).join(' '));
  };
});

afterEach(() => {
  console.warn = realWarn;
});

describe('#684 — run-trace ingest is best-effort, and every drop is observable', () => {
  it('counts and warns when there is NO graph sink at all (previously silent)', async () => {
    const stats = new RunTraceOutcomeStats();
    const store = new InMemoryMemoryStore();
    // No graph argument: the deployment shape that recorded nothing, forever,
    // without ever saying so.
    const logger = new SessionLogger(store, undefined, undefined, undefined, stats);

    await logger.log({ ...ENTRY, runTrace: payload() });

    assert.equal(stats.snapshot()['no-graph-sink'], 1);
    assert.equal(stats.droppedTotal(), 1);
    assert.equal(
      warnings.filter((w) => w.includes('no-graph-sink')).length,
      1,
      'the drop must produce exactly one greppable warn line',
    );

    // The guaranteed surface is untouched — that is the whole basis of the
    // "telemetry, not record" decision.
    const files = (await store.list('/memories/sessions/sess-684')).filter(
      (e) => !e.isDirectory,
    );
    assert.equal(files.length, 1);
  });

  it('counts and warns when ingestRun refuses for a missing User-Cluster node', async () => {
    const stats = new RunTraceOutcomeStats();
    const store = new InMemoryMemoryStore();
    const graph = new InMemoryKnowledgeGraph();
    const logger = new SessionLogger(store, graph, undefined, undefined, stats);

    // A `userId` whose User-Cluster node was never resolved. This is the
    // exact drop #684 was filed about, reproduced through the real
    // implementation rather than a stub that merely throws.
    await logger.log({
      ...ENTRY,
      userId: 'omadia-user-with-no-cluster',
      runTrace: payload({ userId: 'omadia-user-with-no-cluster' }),
    });

    assert.equal(stats.snapshot()['run-ingest-failed'], 1);
    assert.equal(stats.snapshot().recorded, 0);
    const drop = warnings.find((w) => w.includes('run-ingest-failed'));
    assert.ok(drop, 'the drop #684 is about must be visible in the log');
    // #1082 — the text names both known causes and defers to the error detail
    // instead of guessing: a filtered turn used to be booked here under the
    // "most often no User-Cluster … browser-login path" hint, which sent
    // operators after a cluster problem that did not exist.
    assert.ok(!drop.includes('most often'), `hint must not guess a cause: ${drop}`);
    assert.ok(!drop.includes('browser-login'), `hint must not blame a path: ${drop}`);
    assert.ok(drop.includes('Turn'), 'a missing Turn is named as a cause');
    assert.ok(
      drop.includes('User-Cluster user:omadia-user-with-no-cluster not found'),
      'the error detail that names the missing node is kept',
    );

    // The turn itself survived: transcript written, Turn node ingested. Only
    // the Run is missing — "not recorded", never "no such turn".
    const graphStats = await graph.stats();
    assert.equal(graphStats.byNodeType.Turn, 1);
    assert.equal(graphStats.byNodeType.Run ?? 0, 0);
  });

  it('counts a successful ingest as recorded and stays quiet', async () => {
    const stats = new RunTraceOutcomeStats();
    const store = new InMemoryMemoryStore();
    const graph = new InMemoryKnowledgeGraph();
    const logger = new SessionLogger(store, graph, undefined, undefined, stats);

    // No `userId` — the BELONGS_TO branch that needs a User-Cluster is skipped
    // entirely, so this is the path that genuinely records.
    await logger.log({ ...ENTRY, runTrace: payload() });

    assert.equal(stats.snapshot().recorded, 1);
    assert.equal(stats.droppedTotal(), 0);
    assert.deepEqual(
      warnings.filter((w) => w.includes('run trace not recorded')),
      [],
      'a recorded trace must not warn',
    );

    const graphStats = await graph.stats();
    assert.equal(graphStats.byNodeType.Run, 1);
  });

  it('does not count a turn that carried no trace as a drop', async () => {
    const stats = new RunTraceOutcomeStats();
    const store = new InMemoryMemoryStore();
    const logger = new SessionLogger(store, undefined, undefined, undefined, stats);

    // No `runTrace`: the orchestrator collected nothing. That is not telemetry
    // loss, and counting it would make the drop total meaningless.
    await logger.log(ENTRY);

    assert.equal(stats.droppedTotal(), 0);
    assert.deepEqual(stats.snapshot(), {
      recorded: 0,
      'no-graph-sink': 0,
      'transcript-failed': 0,
      'turn-ingest-failed': 0,
      'run-ingest-failed': 0,
    });
    // #1082 — the tail-only counter is a separate dimension, not a sixth
    // outcome: it stays out of `snapshot()` (above) and out of the drop total.
    assert.equal(stats.captureTailOnlyTurns(), 0);
    assert.deepEqual(warnings, []);
  });
});
