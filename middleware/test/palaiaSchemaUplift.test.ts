import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import {
  rowToNode,
  type NodeRow,
} from '@omadia/knowledge-graph-neon';

/**
 * Palaia-Integration Phase 1 (OB-70) — Schema-uplift defaults & mappers.
 *
 * Three test surfaces:
 *   1. The migration SQL file is shaped correctly (column adds, indices,
 *      check constraints) — a static scan keeps Phase 2 from accidentally
 *      mutating 0007 instead of writing 0008.
 *   2. `rowToNode` projects every palaia column the SELECT brought back
 *      and tolerates pre-uplift rows (column undefined).
 *   3. `InMemoryKnowledgeGraph` mirrors the Neon DB defaults on Turn
 *      ingest so consumers see identical fields across backends.
 *
 * Live-DB integration (migration runs end-to-end on an empty schema, is
 * idempotent across re-runs) is covered by the boot smoke-test against
 * the dev Neon DSN; not in the unit-test suite to keep CI hermetic.
 */

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = join(
  here,
  '..',
  'packages',
  'harness-knowledge-graph-neon',
  'src',
  'migrations',
  '0007_palaia_schema_uplift.sql',
);

describe('Palaia Phase 1 · migration 0007 SQL file', () => {
  it('declares all 9 additive columns with NOT NULL defaults where required', async () => {
    const sql = await readFile(MIGRATION_PATH, 'utf8');

    // Required columns + each one's expected default / nullability fragment.
    const expectations: Array<[string, RegExp]> = [
      [
        'entry_type',
        /entry_type TEXT NOT NULL DEFAULT 'memory'\s+CHECK \(entry_type IN \('memory', 'process', 'task'\)\)/,
      ],
      ['visibility', /visibility TEXT NOT NULL DEFAULT 'team'/],
      [
        'tier',
        /tier TEXT NOT NULL DEFAULT 'HOT'\s+CHECK \(tier IN \('HOT', 'WARM', 'COLD'\)\)/,
      ],
      ['accessed_at', /accessed_at TIMESTAMPTZ NULL/],
      ['access_count', /access_count INTEGER NOT NULL DEFAULT 0/],
      ['decay_score', /decay_score REAL NOT NULL DEFAULT 1\.0/],
      ['content_hash', /content_hash TEXT NULL/],
      [
        'manually_authored',
        /manually_authored BOOLEAN NOT NULL DEFAULT FALSE/,
      ],
      [
        'task_status',
        /task_status TEXT NULL\s+CHECK \(task_status IS NULL OR task_status IN \('open', 'done'\)\)/,
      ],
      [
        'significance',
        /significance REAL NULL\s+CHECK \(significance IS NULL OR \(significance >= 0\.0 AND significance <= 1\.0\)\)/,
      ],
    ];
    for (const [name, pattern] of expectations) {
      assert.match(sql, pattern, `missing or malformed column definition: ${name}`);
    }
  });

  it('uses ADD COLUMN IF NOT EXISTS on every ALTER (idempotent re-run)', async () => {
    const sql = await readFile(MIGRATION_PATH, 'utf8');
    const adds = sql.match(/ADD COLUMN/g) ?? [];
    const guarded = sql.match(/ADD COLUMN IF NOT EXISTS/g) ?? [];
    assert.equal(
      guarded.length,
      adds.length,
      'every ADD COLUMN must use IF NOT EXISTS to keep the migration idempotent',
    );
    assert.equal(adds.length, 10, 'expected 10 ADD COLUMN statements');
  });

  it('declares the 5 partial indices for the palaia hot paths', async () => {
    const sql = await readFile(MIGRATION_PATH, 'utf8');
    const required = [
      /CREATE INDEX IF NOT EXISTS idx_graph_nodes_tier_score\s+ON graph_nodes \(tier, decay_score DESC\)\s+WHERE type = 'Turn'/,
      /CREATE INDEX IF NOT EXISTS idx_graph_nodes_entry_type\s+ON graph_nodes \(entry_type\)\s+WHERE type = 'Turn'/,
      /CREATE INDEX IF NOT EXISTS idx_graph_nodes_content_hash\s+ON graph_nodes \(content_hash\)\s+WHERE content_hash IS NOT NULL/,
      /CREATE INDEX IF NOT EXISTS idx_graph_nodes_visibility\s+ON graph_nodes \(visibility\)\s+WHERE type = 'Turn'/,
      /CREATE INDEX IF NOT EXISTS idx_graph_nodes_open_tasks\s+ON graph_nodes \(created_at DESC\)\s+WHERE entry_type = 'task' AND task_status = 'open'/,
    ];
    for (const pattern of required) {
      assert.match(sql, pattern, `missing partial index: ${pattern.source}`);
    }
  });
});

describe('Palaia Phase 1 · rowToNode read-mapper', () => {
  it('projects all palaia columns when the SELECT included them (DB defaults applied)', () => {
    const row: NodeRow = {
      id: 'uuid-1',
      external_id: 'turn:demo:2026-05-07T10:00:00Z',
      type: 'Turn',
      scope: 'demo',
      properties: { time: '2026-05-07T10:00:00Z' },
      entry_type: 'memory',
      visibility: 'team',
      tier: 'HOT',
      accessed_at: null,
      access_count: 0,
      decay_score: 1.0,
      content_hash: null,
      manually_authored: false,
      task_status: null,
      significance: null,
    };
    const node = rowToNode(row);
    assert.equal(node.id, 'turn:demo:2026-05-07T10:00:00Z');
    assert.equal(node.type, 'Turn');
    assert.equal(node.entryType, 'memory');
    assert.equal(node.visibility, 'team');
    assert.equal(node.tier, 'HOT');
    assert.equal(node.accessedAt, null);
    assert.equal(node.accessCount, 0);
    assert.equal(node.decayScore, 1.0);
    assert.equal(node.contentHash, null);
    assert.equal(node.manuallyAuthored, false);
    assert.equal(node.taskStatus, null);
    assert.equal(node.significance, null);
  });

  it('coerces postgres numeric strings (REAL, INTEGER) to JS numbers', () => {
    const row: NodeRow = {
      id: 'uuid-2',
      external_id: 'turn:x:t',
      type: 'Turn',
      scope: 'x',
      properties: {},
      entry_type: 'task',
      visibility: 'private',
      tier: 'WARM',
      accessed_at: new Date('2026-05-07T08:00:00.000Z'),
      access_count: '7' as unknown as number, // pg returns INTEGER as number, but be defensive
      decay_score: '0.42' as unknown as number, // pg returns REAL as string
      content_hash: 'a'.repeat(64),
      manually_authored: true,
      task_status: 'open',
      significance: '0.85' as unknown as number,
    };
    const node = rowToNode(row);
    assert.equal(node.accessedAt, '2026-05-07T08:00:00.000Z');
    assert.equal(node.accessCount, 7);
    assert.equal(typeof node.accessCount, 'number');
    assert.equal(node.decayScore, 0.42);
    assert.equal(typeof node.decayScore, 'number');
    assert.equal(node.contentHash, 'a'.repeat(64));
    assert.equal(node.manuallyAuthored, true);
    assert.equal(node.taskStatus, 'open');
    assert.equal(node.significance, 0.85);
    assert.equal(typeof node.significance, 'number');
  });

  it('omits palaia fields when the SELECT did not include them (legacy projection)', () => {
    const row: NodeRow = {
      id: 'uuid-3',
      external_id: 'session:legacy',
      type: 'Session',
      scope: 'legacy',
      properties: { scope: 'legacy' },
    };
    const node = rowToNode(row);
    assert.equal(node.entryType, undefined);
    assert.equal(node.visibility, undefined);
    assert.equal(node.tier, undefined);
    assert.equal(node.accessedAt, undefined);
    assert.equal(node.accessCount, undefined);
    assert.equal(node.decayScore, undefined);
    assert.equal(node.contentHash, undefined);
    assert.equal(node.manuallyAuthored, undefined);
    assert.equal(node.taskStatus, undefined);
    assert.equal(node.significance, undefined);
  });
});

describe('Palaia Phase 1 · InMemoryKnowledgeGraph mirror', () => {
  it('initialises every Turn node with the DB-default palaia fields', async () => {
    const g = new InMemoryKnowledgeGraph();
    await g.ingestTurn({
      scope: 'demo',
      time: '2026-05-07T10:00:00Z',
      userMessage: 'q',
      assistantAnswer: 'a',
      entityRefs: [],
    });
    const view = await g.getSession('demo');
    assert.ok(view, 'session view present');
    const turn = view.turns[0]?.turn;
    assert.ok(turn, 'turn present');
    assert.equal(turn.entryType, 'memory');
    assert.equal(turn.visibility, 'team');
    assert.equal(turn.tier, 'HOT');
    assert.equal(turn.accessedAt, null);
    assert.equal(turn.accessCount, 0);
    assert.equal(turn.decayScore, 1.0);
    assert.equal(turn.contentHash, null);
    assert.equal(turn.manuallyAuthored, false);
    assert.equal(turn.taskStatus, null);
    assert.equal(turn.significance, null);
  });

  it('preserves palaia defaults across re-ingest of the same (scope,time)', async () => {
    const g = new InMemoryKnowledgeGraph();
    await g.ingestTurn({
      scope: 's',
      time: '2026-05-07T10:00:00Z',
      userMessage: 'q1',
      assistantAnswer: 'a1',
      entityRefs: [],
    });
    await g.ingestTurn({
      scope: 's',
      time: '2026-05-07T10:00:00Z',
      userMessage: 'q1-edited',
      assistantAnswer: 'a1-edited',
      entityRefs: [],
    });
    const view = await g.getSession('s');
    const turn = view?.turns[0]?.turn;
    assert.ok(turn);
    assert.equal(turn.entryType, 'memory');
    assert.equal(turn.tier, 'HOT');
    assert.equal(turn.decayScore, 1.0);
  });
});
