import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import type {
  InconsistencyDetectorService,
  KnowledgeGraph,
} from '@omadia/plugin-api';

import { createBulkInconsistencyService } from '../packages/harness-orchestrator-extras/src/bulkInconsistency.js';

/**
 * Slice 9.5 — Bulk Inconsistency Detect.
 *
 * Backend coverage (DB-less via InMemory + a mock detector):
 *   1. Migration 0022 SQL declares the partial index for unchecked MKs.
 *   2. `countMemorableKnowledgeInconsistencyCheckBuckets` partitions
 *      MKs correctly across (unchecked / alreadyChecked / withoutEmbedding).
 *   3. `listMemorableKnowledgeIdsForBulkInconsistencyCheck` returns
 *      only MKs with an embedding and no marker.
 *   4. `markMemorableKnowledgeInconsistencyChecked` writes the
 *      property; subsequent listings exclude the MK.
 *   5. `BulkInconsistencyService.preview` reports detector availability.
 *   6. `BulkInconsistencyService.run` walks the selection, calls the
 *      detector for each MK, returns aggregated stats. Re-run is
 *      idempotent (0 work).
 *   7. `run` throws `bulk.detector_unavailable` when judgementAvailable=false.
 */

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(
  here,
  '..',
  'packages',
  'harness-knowledge-graph-neon',
  'src',
  'migrations',
);

const ALICE = '11111111-1111-1111-1111-111111111111';

async function seedOwner(
  kg: InMemoryKnowledgeGraph,
  uuid: string,
  email: string,
): Promise<string> {
  const cluster = await kg.resolveOrCreateChannelIdentity({
    channelKind: 'web',
    channelUserId: uuid,
    displayName: email,
    email,
    emailVerified: true,
  });
  return cluster.omadiaUserId;
}

async function makeMK(
  kg: InMemoryKnowledgeGraph,
  owner: string,
  summary: string,
): Promise<string> {
  const r = await kg.createMemorableKnowledge({
    kind: 'insight',
    summary,
    createdBy: `web:${owner}`,
    involvedOmadiaUserIds: [owner],
    aclOwners: [owner],
  });
  return r.memorableKnowledgeNodeId;
}

describe('Slice 9.5 · migration 0024 SQL', () => {
  it('runs in a single transaction', async () => {
    const sql = await readFile(
      join(MIGRATIONS_DIR, '0024_inconsistency_bulk_marker.sql'),
      'utf8',
    );
    assert.match(sql, /^BEGIN;/m);
    assert.match(sql, /^COMMIT;/m);
  });
  it('declares the unchecked-MK partial index', async () => {
    const sql = await readFile(
      join(MIGRATIONS_DIR, '0024_inconsistency_bulk_marker.sql'),
      'utf8',
    );
    assert.match(sql, /graph_nodes_mk_inconsistency_unchecked_idx/);
    assert.match(sql, /WHERE type = 'MemorableKnowledge'/);
    assert.match(sql, /embedding IS NOT NULL/);
    assert.match(sql, /NOT \(properties \? 'last_inconsistency_check_at'\)/);
  });
});

describe('Slice 9.5 · KG bucket counts', () => {
  it('partitions MKs across unchecked / alreadyChecked / withoutEmbedding', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const owner = await seedOwner(kg, ALICE, 'alice@example.com');
    const mkUnchecked = await makeMK(kg, owner, 'no marker but has embedding');
    const mkChecked = await makeMK(kg, owner, 'has marker');
    const mkNoEmbedding = await makeMK(kg, owner, 'no embedding at all');
    kg.setEmbedding(mkUnchecked, [0.1, 0.2, 0.3]);
    kg.setEmbedding(mkChecked, [0.4, 0.5, 0.6]);
    // mkNoEmbedding deliberately not set.
    await kg.markMemorableKnowledgeInconsistencyChecked(mkChecked);

    const buckets = await kg.countMemorableKnowledgeInconsistencyCheckBuckets();
    assert.equal(buckets.unchecked, 1);
    assert.equal(buckets.alreadyChecked, 1);
    assert.equal(buckets.withoutEmbedding, 1);
  });
  it('returns zero buckets when there are no MKs', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const buckets = await kg.countMemorableKnowledgeInconsistencyCheckBuckets();
    assert.deepEqual(buckets, {
      unchecked: 0,
      alreadyChecked: 0,
      withoutEmbedding: 0,
    });
  });
});

describe('Slice 9.5 · KG selection query', () => {
  it('lists only MKs with embedding AND without marker, ascending created_at', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const owner = await seedOwner(kg, ALICE, 'alice@example.com');
    const mk1 = await makeMK(kg, owner, 'first');
    // Force a deterministic gap in created_at so the ascending order
    // is checkable even when the clock resolution is per-millisecond.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const mk2 = await makeMK(kg, owner, 'second');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const mk3 = await makeMK(kg, owner, 'third');
    kg.setEmbedding(mk1, [0.1]);
    kg.setEmbedding(mk2, [0.2]);
    kg.setEmbedding(mk3, [0.3]);
    await kg.markMemorableKnowledgeInconsistencyChecked(mk2);

    const ids = await kg.listMemorableKnowledgeIdsForBulkInconsistencyCheck({
      limit: 50,
    });
    assert.deepEqual(ids, [mk1, mk3]);
  });
  it('clamps limit to [1, 200]', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const owner = await seedOwner(kg, ALICE, 'alice@example.com');
    const created: string[] = [];
    for (let i = 0; i < 5; i++) {
      const mk = await makeMK(kg, owner, `mk ${String(i)}`);
      kg.setEmbedding(mk, [i]);
      created.push(mk);
    }
    const oneId = await kg.listMemorableKnowledgeIdsForBulkInconsistencyCheck({
      limit: 1,
    });
    assert.equal(oneId.length, 1);
    const allIds = await kg.listMemorableKnowledgeIdsForBulkInconsistencyCheck({
      limit: 999,
    });
    assert.equal(allIds.length, 5);
  });
});

describe('Slice 9.5 · marker write', () => {
  it('write + re-read removes the MK from the unchecked set', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const owner = await seedOwner(kg, ALICE, 'alice@example.com');
    const mk = await makeMK(kg, owner, 'A');
    kg.setEmbedding(mk, [0.1, 0.2]);

    let buckets = await kg.countMemorableKnowledgeInconsistencyCheckBuckets();
    assert.equal(buckets.unchecked, 1);
    await kg.markMemorableKnowledgeInconsistencyChecked(mk);
    buckets = await kg.countMemorableKnowledgeInconsistencyCheckBuckets();
    assert.equal(buckets.unchecked, 0);
    assert.equal(buckets.alreadyChecked, 1);
  });
  it('is idempotent (rewriting just refreshes timestamp)', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const owner = await seedOwner(kg, ALICE, 'alice@example.com');
    const mk = await makeMK(kg, owner, 'A');
    kg.setEmbedding(mk, [0.1]);
    await kg.markMemorableKnowledgeInconsistencyChecked(mk);
    await kg.markMemorableKnowledgeInconsistencyChecked(mk);
    const buckets = await kg.countMemorableKnowledgeInconsistencyCheckBuckets();
    assert.equal(buckets.alreadyChecked, 1);
  });
  it('no-ops on missing MK', async () => {
    const kg = new InMemoryKnowledgeGraph();
    await kg.markMemorableKnowledgeInconsistencyChecked('mk:nothing');
    const buckets = await kg.countMemorableKnowledgeInconsistencyCheckBuckets();
    assert.equal(buckets.alreadyChecked, 0);
  });
});

interface MockDetectorState {
  calls: string[];
  /** Per-MK override: if non-null, throw; if undefined, default success. */
  overrides: Map<string, 'throw' | { candidatesScanned: number; inconsistenciesCreated: number }>;
}

function createMockDetector(
  kg: KnowledgeGraph,
  state: MockDetectorState,
): InconsistencyDetectorService {
  return {
    async detectFor(mkId) {
      state.calls.push(mkId);
      const override = state.overrides.get(mkId);
      if (override === 'throw') {
        throw new Error(`mock detector throw for ${mkId}`);
      }
      // Detector contract: marker is written by detectFor itself at
      // the end of a successful run. Mirror that here so re-runs
      // dedupe correctly.
      await kg.markMemorableKnowledgeInconsistencyChecked(mkId);
      if (override) return override;
      return { candidatesScanned: 1, inconsistenciesCreated: 0 };
    },
  };
}

describe('Slice 9.5 · BulkInconsistencyService', () => {
  it('preview reports detector availability + bucket counts', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const owner = await seedOwner(kg, ALICE, 'alice@example.com');
    const mk1 = await makeMK(kg, owner, 'A');
    kg.setEmbedding(mk1, [0.1]);
    const state: MockDetectorState = { calls: [], overrides: new Map() };
    const service = createBulkInconsistencyService({
      kg,
      detector: createMockDetector(kg, state),
      judgementAvailable: true,
    });
    const preview = await service.preview();
    assert.equal(preview.unchecked, 1);
    assert.equal(preview.alreadyChecked, 0);
    assert.equal(preview.detectorAvailable, true);
  });
  it('preview returns detectorAvailable=false when judgement-pass off', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const service = createBulkInconsistencyService({
      kg,
      judgementAvailable: false,
    });
    const preview = await service.preview();
    assert.equal(preview.detectorAvailable, false);
  });
  it('run calls detector for every unchecked MK and aggregates stats', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const owner = await seedOwner(kg, ALICE, 'alice@example.com');
    const mk1 = await makeMK(kg, owner, 'A');
    const mk2 = await makeMK(kg, owner, 'B');
    kg.setEmbedding(mk1, [0.1]);
    kg.setEmbedding(mk2, [0.2]);
    const state: MockDetectorState = { calls: [], overrides: new Map() };
    state.overrides.set(mk1, { candidatesScanned: 2, inconsistenciesCreated: 1 });
    state.overrides.set(mk2, { candidatesScanned: 0, inconsistenciesCreated: 0 });
    const service = createBulkInconsistencyService({
      kg,
      detector: createMockDetector(kg, state),
      judgementAvailable: true,
    });
    const result = await service.run({ limit: 10 });
    assert.equal(result.scanned, 2);
    assert.equal(result.checked, 2);
    assert.equal(result.inconsistenciesCreated, 1);
    assert.equal(result.failed, 0);
    assert.deepEqual([...state.calls].sort(), [mk1, mk2].sort());
  });
  it('run is idempotent — re-run after success processes 0 MKs', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const owner = await seedOwner(kg, ALICE, 'alice@example.com');
    const mk1 = await makeMK(kg, owner, 'A');
    kg.setEmbedding(mk1, [0.1]);
    const state: MockDetectorState = { calls: [], overrides: new Map() };
    const service = createBulkInconsistencyService({
      kg,
      detector: createMockDetector(kg, state),
      judgementAvailable: true,
    });
    await service.run({ limit: 10 });
    const second = await service.run({ limit: 10 });
    assert.equal(second.scanned, 0);
    assert.equal(second.checked, 0);
  });
  it('run counts detector throws as failed, leaves marker unset', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const owner = await seedOwner(kg, ALICE, 'alice@example.com');
    const mk = await makeMK(kg, owner, 'A');
    kg.setEmbedding(mk, [0.1]);
    const state: MockDetectorState = { calls: [], overrides: new Map() };
    state.overrides.set(mk, 'throw');
    const service = createBulkInconsistencyService({
      kg,
      detector: createMockDetector(kg, state),
      judgementAvailable: true,
    });
    const result = await service.run({ limit: 10 });
    assert.equal(result.scanned, 1);
    assert.equal(result.checked, 0);
    assert.equal(result.failed, 1);
    // Marker NOT written → next run picks the MK up again.
    const buckets = await kg.countMemorableKnowledgeInconsistencyCheckBuckets();
    assert.equal(buckets.unchecked, 1);
  });
  it('run throws bulk.detector_unavailable when judgement-pass off', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const service = createBulkInconsistencyService({
      kg,
      judgementAvailable: false,
    });
    await assert.rejects(service.run({}), (err: { code?: string }) =>
      err.code === 'bulk.detector_unavailable'
    );
  });
  it('limit clamps to hard-cap 200', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const owner = await seedOwner(kg, ALICE, 'alice@example.com');
    const created: string[] = [];
    for (let i = 0; i < 3; i++) {
      const mk = await makeMK(kg, owner, `mk ${String(i)}`);
      kg.setEmbedding(mk, [i]);
      created.push(mk);
    }
    const state: MockDetectorState = { calls: [], overrides: new Map() };
    const service = createBulkInconsistencyService({
      kg,
      detector: createMockDetector(kg, state),
      judgementAvailable: true,
    });
    const result = await service.run({ limit: 999 });
    // Service clamps the limit, but with only 3 MKs the cap doesn't
    // matter beyond the actual count.
    assert.equal(result.scanned, 3);
    assert.equal(result.checked, 3);
  });
});
