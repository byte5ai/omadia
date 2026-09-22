/**
 * #1096 — the in-session context tail must not depend on the capture filter's
 * significance verdict.
 *
 * Before the fix, `CaptureFilteringKnowledgeGraph` skipped the inner
 * `ingestTurn` for any sub-threshold turn, and `ContextRetriever.loadTail`
 * reads exactly those inner turns — so a short message ("ok", "pong") was
 * erased from the model's view of the conversation while the user still saw
 * it in the chat. The two jobs are now split: the session record is always
 * written (`tailOnly`), the knowledge paths (embedding, cross-session recall,
 * promotion) stay gated by significance.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { loadManifestFromPath } from '../src/plugins/manifestLoader.js';

import {
  CaptureFilter,
  CaptureFilteringKnowledgeGraph,
  ContextRetriever,
} from '@omadia/orchestrator-extras';
import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import type { KnowledgeGraph, TurnIngest } from '@omadia/plugin-api';

/** Capture filter at `level=normal` with a scorer that returns a fixed score. */
function filterScoring(score: number): CaptureFilter {
  return new CaptureFilter({
    captureLevel: 'normal',
    defaultVisibility: 'team',
    significanceThreshold: 0.2,
    significanceScorer: {
      async score() {
        return { score };
      },
    },
    log: () => {},
  });
}

function turn(scope: string, minute: number, user: string, answer: string): TurnIngest {
  const mm = String(minute).padStart(2, '0');
  return {
    scope,
    time: `2026-09-22T08:${mm}:00.000Z`,
    userMessage: user,
    assistantAnswer: answer,
    entityRefs: [],
  };
}

describe('#1096 session tail vs. capture filter', () => {
  it('keeps every sub-threshold turn in the session record', async () => {
    const inner = new InMemoryKnowledgeGraph();
    const wrapped = new CaptureFilteringKnowledgeGraph({
      inner,
      filter: filterScoring(0.0),
      log: () => {},
    });

    await wrapped.ingestTurn(turn('s-short', 1, 'pong', 'pong'));
    await wrapped.ingestTurn(turn('s-short', 2, 'ok', 'ok'));
    await wrapped.ingestTurn(turn('s-short', 3, 'Farbe: blau', 'notiert'));

    const session = await inner.getSession('s-short');
    assert.ok(session, 'session must exist');
    assert.equal(session.turns.length, 3, 'all three turns must be recorded');
  });

  it('delivers those turns to the context tail', async () => {
    const inner = new InMemoryKnowledgeGraph();
    const wrapped = new CaptureFilteringKnowledgeGraph({
      inner,
      filter: filterScoring(0.1),
      log: () => {},
    });
    await wrapped.ingestTurn(turn('s-tail', 1, 'pong', 'pong'));
    await wrapped.ingestTurn(turn('s-tail', 2, 'ok', 'ok'));
    await wrapped.ingestTurn(turn('s-tail', 3, 'Farbe: blau', 'notiert'));

    const retriever = new ContextRetriever(wrapped);
    const result = await retriever.build({
      userMessage: 'Fasse zusammen, was ich dir geschrieben habe.',
      sessionScope: 's-tail',
    });

    assert.equal(result.sources.verbatimTurns.length, 3);
    assert.ok(result.text.includes('Farbe: blau'), 'tail must render the turns');
    assert.ok(result.text.includes('pong'));
  });

  it('marks the record tail-only and keeps it out of cross-session recall', async () => {
    const inner = new InMemoryKnowledgeGraph();
    const wrapped = new CaptureFilteringKnowledgeGraph({
      inner,
      filter: filterScoring(0.1),
      log: () => {},
    });
    await wrapped.ingestTurn(
      turn('s-trivial', 1, 'Farbe: blau', 'notiert'),
    );

    const session = await inner.getSession('s-trivial');
    const recorded = session?.turns[0]?.turn;
    assert.ok(recorded, 'turn must be recorded');
    assert.equal(recorded.props['tailOnly'], true);
    assert.equal(recorded.significance, 0.1, 'score stays on the row');

    // Cross-session recall runs from a DIFFERENT session — the tail-only turn
    // must be invisible on both the lexical and the hybrid leg.
    const lexical = await inner.searchTurns({
      query: 'blau',
      excludeScope: 's-other',
    });
    assert.deepEqual(lexical, []);

    const hybrid = await inner.searchTurnsByEmbedding({
      queryEmbedding: [0.1, 0.2, 0.3],
      ftsQuery: 'blau',
      excludeScope: 's-other',
    });
    assert.deepEqual(hybrid, []);
  });

  it('still admits supra-threshold turns to recall', async () => {
    const inner = new InMemoryKnowledgeGraph();
    const wrapped = new CaptureFilteringKnowledgeGraph({
      inner,
      filter: filterScoring(0.8),
      log: () => {},
    });
    await wrapped.ingestTurn(
      turn('s-real', 1, 'Der Kunde heisst Lilium', 'verstanden'),
    );

    const session = await inner.getSession('s-real');
    const recorded = session?.turns[0]?.turn;
    assert.ok(recorded);
    assert.equal(recorded.props['tailOnly'], false, 'not a tail-only row');

    const lexical = await inner.searchTurns({
      query: 'Lilium',
      excludeScope: 's-other',
    });
    assert.equal(lexical.length, 1);
  });

  it('drops entity refs on a tail-only turn so entity recall cannot resurface it', async () => {
    const inner = new InMemoryKnowledgeGraph();
    const wrapped = new CaptureFilteringKnowledgeGraph({
      inner,
      filter: filterScoring(0.0),
      log: () => {},
    });
    await wrapped.ingestTurn({
      ...turn('s-entity', 1, 'und Lilium?', 'ja'),
      entityRefs: [
        {
          system: 'odoo',
          model: 'res.partner',
          id: '42',
          op: 'read',
          displayName: 'Lilium GmbH',
        },
      ],
    });

    const hits = await inner.findEntityCapturedTurns({
      terms: ['lilium'],
      excludeScope: 's-other',
    });
    assert.deepEqual(hits, []);
  });

  it('clears the flag when the same turn is re-ingested as knowledge', async () => {
    // Props are MERGED on upsert in both backends, so a write-only-when-true
    // flag would be one-way: a replay at capture_level=off, or a backfill,
    // would leave the row flagged and invisible to recall forever.
    const inner = new InMemoryKnowledgeGraph();
    const dropping = new CaptureFilteringKnowledgeGraph({
      inner,
      filter: filterScoring(0.0),
      log: () => {},
    });
    const replay = turn('s-replay', 1, 'Der Kunde heisst Lilium', 'verstanden');
    await dropping.ingestTurn(replay);
    assert.deepEqual(
      await inner.searchTurns({ query: 'Lilium', excludeScope: 's-other' }),
      [],
    );

    // Same scope + time → same node id, re-ingested without the flag.
    await inner.ingestTurn(replay);
    const session = await inner.getSession('s-replay');
    assert.equal(session?.turns[0]?.turn.props['tailOnly'], false);
    const lexical = await inner.searchTurns({
      query: 'Lilium',
      excludeScope: 's-other',
    });
    assert.equal(lexical.length, 1, 'recall sees it again');
  });

  it('never fails the turn when the tail-only write is rejected', async () => {
    const inner = new InMemoryKnowledgeGraph();
    const failing: KnowledgeGraph = new Proxy(inner, {
      get(target, prop, recv) {
        if (prop === 'ingestTurn') {
          return async (): Promise<never> => {
            throw new Error('backend down');
          };
        }
        return Reflect.get(target, prop, recv) as unknown;
      },
    }) as KnowledgeGraph;

    const wrapped = new CaptureFilteringKnowledgeGraph({
      inner: failing,
      filter: filterScoring(0.0),
      log: () => {},
    });

    const result = await wrapped.ingestTurn(turn('s-fail', 1, 'ok', 'ok'));
    assert.equal(result.sessionId, 'session:s-fail');
    assert.ok(result.turnId.startsWith('turn:s-fail'));
    assert.deepEqual(result.entityNodeIds, []);
  });
});

describe('#1096 configurable tail size', () => {
  async function seed(scope: string, count: number): Promise<InMemoryKnowledgeGraph> {
    const graph = new InMemoryKnowledgeGraph();
    for (let i = 1; i <= count; i++) {
      await graph.ingestTurn(turn(scope, i, `frage ${String(i)}`, `antwort ${String(i)}`));
    }
    return graph;
  }

  it('defaults to 10 turns instead of the hard-wired 3', async () => {
    const graph = await seed('s-depth', 12);
    const retriever = new ContextRetriever(graph);
    const result = await retriever.build({
      userMessage: 'weiter',
      sessionScope: 's-depth',
    });
    assert.equal(result.sources.verbatimTurns.length, 10);
    assert.equal(result.sources.verbatimTurns[0]?.userMessage, 'frage 3');
  });

  it('honours an explicit tailSize', async () => {
    const graph = await seed('s-depth-2', 12);
    const retriever = new ContextRetriever(graph, { tailSize: 5 });
    const result = await retriever.build({
      userMessage: 'weiter',
      sessionScope: 's-depth-2',
    });
    assert.equal(result.sources.verbatimTurns.length, 5);
    assert.equal(result.sources.verbatimTurns[0]?.userMessage, 'frage 8');
  });
});

describe('#1096 tail size is reachable from the plugin store', () => {
  const PKG_ROOT = new URL('../packages/harness-orchestrator-extras/', import.meta.url);

  it('declares context_tail_size in the manifest it reads', async () => {
    // The tail length decides how much of the running conversation the model
    // sees at all. A value that only lives in code — the hard-wired 3 this
    // issue is about — is invisible to the operator who has to diagnose
    // "the agent forgot what I said", so the declaration is part of the fix.
    const entry = await loadManifestFromPath(
      fileURLToPath(new URL('manifest.yaml', PKG_ROOT)),
    );
    assert.ok(entry, 'manifest loads as a valid schema-v1 document');

    const field = entry.plugin.setup_fields.find((f) => f.key === 'context_tail_size');
    assert.ok(field, 'context_tail_size must be declared under setup.fields');
    assert.equal(field.type, 'integer');
    assert.equal(field.default, '10');

    const pluginSrc = readFileSync(
      fileURLToPath(new URL('src/plugin.ts', PKG_ROOT)),
      'utf8',
    );
    assert.ok(
      pluginSrc.includes("'context_tail_size'"),
      'plugin.ts must read the declared key',
    );
  });
});
