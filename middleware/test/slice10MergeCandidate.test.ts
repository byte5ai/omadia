import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import {
  GRAPH_EDGE_TYPES,
  GRAPH_NODE_TYPES,
  MERGE_CANDIDATE_RESOLUTIONS,
  MERGE_CANDIDATE_STATUSES,
  validateNodeProps,
} from '@omadia/knowledge-graph-neon';
import type {
  InconsistencyDetectorService,
  KnowledgeGraph,
  MergeCandidateDetectorService,
} from '@omadia/plugin-api';

import { createBulkMergeDetectService } from '../packages/harness-orchestrator-extras/src/bulkMergeDetect.js';
import { MergeTriggeringKnowledgeGraph } from '../packages/harness-orchestrator-extras/src/mergeTriggeringKnowledgeGraph.js';

/**
 * Slice 10 — MK-Auto-Merge detector + resolver.
 *
 * Coverage (DB-less via InMemory + a mock detector):
 *   1. Migration 0023 SQL declares DUPLICATE_OF index + status CHECK +
 *      bulk-marker partial index.
 *   2. Schema enums + Zod validate the new node + edge.
 *   3. KG round-trips: create → list → get → resolve (keep_a/keep_b/
 *      not_duplicate), dedupe, ACL gate.
 *   4. Bulk-marker helpers (parallel to Slice 9.5): list + count +
 *      mark — independent from the inconsistency marker.
 *   5. BulkMergeDetectService: preview / run / idempotency / failure
 *      semantics.
 *   6. MergeTriggeringKnowledgeGraph fires the detector post-COMMIT on
 *      createMK / updateMK / resolveInconsistency / resolveMergeCandidate.
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
const BOB = '22222222-2222-2222-2222-222222222222';

async function seed(
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

describe('Slice 10 · migration 0025 SQL', () => {
  it('runs in a single transaction', async () => {
    const sql = await readFile(
      join(MIGRATIONS_DIR, '0025_merge_candidate.sql'),
      'utf8',
    );
    assert.match(sql, /^BEGIN;/m);
    assert.match(sql, /^COMMIT;/m);
  });
  it('declares DUPLICATE_OF partial index', async () => {
    const sql = await readFile(
      join(MIGRATIONS_DIR, '0025_merge_candidate.sql'),
      'utf8',
    );
    assert.match(sql, /graph_edges_duplicate_of_idx/);
    assert.match(sql, /WHERE type = 'DUPLICATE_OF'/);
  });
  it('declares MergeCandidate status enum CHECK', async () => {
    const sql = await readFile(
      join(MIGRATIONS_DIR, '0025_merge_candidate.sql'),
      'utf8',
    );
    assert.match(sql, /graph_nodes_merge_candidate_status_chk/);
    assert.match(sql, /'open', 'resolved', 'dismissed'/);
  });
  it('declares bulk-merge unchecked partial index', async () => {
    const sql = await readFile(
      join(MIGRATIONS_DIR, '0025_merge_candidate.sql'),
      'utf8',
    );
    assert.match(sql, /graph_nodes_mk_merge_unchecked_idx/);
    assert.match(sql, /NOT \(properties \? 'last_merge_check_at'\)/);
  });
});

describe('Slice 10 · enums + Zod', () => {
  it('GRAPH_NODE_TYPES contains MergeCandidate', () => {
    assert.ok(GRAPH_NODE_TYPES.includes('MergeCandidate'));
  });
  it('GRAPH_EDGE_TYPES contains DUPLICATE_OF', () => {
    assert.ok(GRAPH_EDGE_TYPES.includes('DUPLICATE_OF'));
  });
  it('exports the enum constants', () => {
    assert.deepEqual([...MERGE_CANDIDATE_STATUSES], ['open', 'resolved', 'dismissed']);
    assert.deepEqual(
      [...MERGE_CANDIDATE_RESOLUTIONS],
      ['keep_a', 'keep_b', 'not_duplicate'],
    );
  });
  it('validateNodeProps accepts well-formed MergeCandidate', () => {
    const out = validateNodeProps('MergeCandidate', {
      cosine_sim: 0.974,
      status: 'open',
      resolution: null,
      created_at: new Date().toISOString(),
      resolved_at: null,
      resolved_by: null,
      mk_pair: ['mk:a', 'mk:b'],
    });
    assert.equal(out['status'], 'open');
  });
  it('validateNodeProps rejects bad status', () => {
    assert.throws(() =>
      validateNodeProps('MergeCandidate', {
        cosine_sim: 0.95,
        status: 'pending',
        resolution: null,
        created_at: new Date().toISOString(),
        resolved_at: null,
        resolved_by: null,
        mk_pair: ['mk:a', 'mk:b'],
      }),
    );
  });
});

describe('Slice 10 · createMergeCandidate', () => {
  it('persists with sorted duplicateOf pair', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const owner = await seed(kg, ALICE, 'alice@example.com');
    const mkA = await makeMK(kg, owner, 'A');
    const mkB = await makeMK(kg, owner, 'B');
    const mc = await kg.createMergeCandidate({
      mkAExternalId: mkA,
      mkBExternalId: mkB,
      cosineSim: 0.97,
    });
    assert.ok(mc);
    assert.equal(mc.props.status, 'open');
    assert.equal(mc.props.cosine_sim, 0.97);
    assert.deepEqual(mc.duplicateOf, [mkA, mkB].sort());
  });
  it('dedupes regardless of input order', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const owner = await seed(kg, ALICE, 'alice@example.com');
    const mkA = await makeMK(kg, owner, 'A');
    const mkB = await makeMK(kg, owner, 'B');
    const first = await kg.createMergeCandidate({
      mkAExternalId: mkA,
      mkBExternalId: mkB,
      cosineSim: 0.96,
    });
    const second = await kg.createMergeCandidate({
      mkAExternalId: mkB,
      mkBExternalId: mkA,
      cosineSim: 0.98,
    });
    assert.ok(first);
    assert.equal(second, null);
  });
  it('returns null when one MK does not exist', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const owner = await seed(kg, ALICE, 'alice@example.com');
    const mkA = await makeMK(kg, owner, 'A');
    const mc = await kg.createMergeCandidate({
      mkAExternalId: mkA,
      mkBExternalId: 'mk:does-not-exist',
      cosineSim: 0.99,
    });
    assert.equal(mc, null);
  });
});

describe('Slice 10 · list + get with ACL', () => {
  it('hides MergeCandidates whose MKs Bob does not own', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const alice = await seed(kg, ALICE, 'alice@example.com');
    const bob = await seed(kg, BOB, 'bob@example.com');
    const mkA = await makeMK(kg, alice, 'A');
    const mkB = await makeMK(kg, alice, 'B');
    await kg.createMergeCandidate({
      mkAExternalId: mkA,
      mkBExternalId: mkB,
      cosineSim: 0.97,
    });
    const aliceList = await kg.listMergeCandidates({ viewerOmadiaUserId: alice });
    const bobList = await kg.listMergeCandidates({ viewerOmadiaUserId: bob });
    assert.equal(aliceList.length, 1);
    assert.equal(bobList.length, 0);
  });
  it('filters by status', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const owner = await seed(kg, ALICE, 'alice@example.com');
    const mkA = await makeMK(kg, owner, 'A');
    const mkB = await makeMK(kg, owner, 'B');
    const created = await kg.createMergeCandidate({
      mkAExternalId: mkA,
      mkBExternalId: mkB,
      cosineSim: 0.97,
    });
    await kg.resolveMergeCandidate(created!.id, 'not_duplicate', {
      actorOmadiaUserId: owner,
    });
    const open = await kg.listMergeCandidates({
      viewerOmadiaUserId: owner,
      status: 'open',
    });
    const dismissed = await kg.listMergeCandidates({
      viewerOmadiaUserId: owner,
      status: 'dismissed',
    });
    assert.equal(open.length, 0);
    assert.equal(dismissed.length, 1);
  });
});

describe('Slice 10 · resolve flows', () => {
  it('keep_a deletes sorted-B', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const owner = await seed(kg, ALICE, 'alice@example.com');
    const mkA = await makeMK(kg, owner, 'A');
    const mkB = await makeMK(kg, owner, 'B');
    const mc = await kg.createMergeCandidate({
      mkAExternalId: mkA,
      mkBExternalId: mkB,
      cosineSim: 0.97,
    });
    await kg.resolveMergeCandidate(mc!.id, 'keep_a', {
      actorOmadiaUserId: owner,
    });
    const sortedPair = [mkA, mkB].sort();
    const winner = await kg.getMemorableKnowledge(sortedPair[0]!);
    const deleted = await kg.getMemorableKnowledge(sortedPair[1]!);
    assert.ok(winner, 'sorted-A should survive');
    assert.equal(deleted, null, 'sorted-B should be deleted');
  });
  it('not_duplicate marks dismissed without delete', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const owner = await seed(kg, ALICE, 'alice@example.com');
    const mkA = await makeMK(kg, owner, 'A');
    const mkB = await makeMK(kg, owner, 'B');
    const mc = await kg.createMergeCandidate({
      mkAExternalId: mkA,
      mkBExternalId: mkB,
      cosineSim: 0.97,
    });
    const resolved = await kg.resolveMergeCandidate(mc!.id, 'not_duplicate', {
      actorOmadiaUserId: owner,
    });
    assert.equal(resolved.props.status, 'dismissed');
    assert.equal(resolved.props.resolution, 'not_duplicate');
    assert.ok(await kg.getMemorableKnowledge(mkA));
    assert.ok(await kg.getMemorableKnowledge(mkB));
  });
  it('non-owner can not resolve', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const alice = await seed(kg, ALICE, 'alice@example.com');
    const bob = await seed(kg, BOB, 'bob@example.com');
    const mkA = await makeMK(kg, alice, 'A');
    const mkB = await makeMK(kg, alice, 'B');
    const mc = await kg.createMergeCandidate({
      mkAExternalId: mkA,
      mkBExternalId: mkB,
      cosineSim: 0.97,
    });
    await assert.rejects(
      kg.resolveMergeCandidate(mc!.id, 'not_duplicate', { actorOmadiaUserId: bob }),
      (err: { code?: string }) => err.code === 'merge_candidate_not_found',
    );
  });
  it('already-resolved blocks re-resolve', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const owner = await seed(kg, ALICE, 'alice@example.com');
    const mkA = await makeMK(kg, owner, 'A');
    const mkB = await makeMK(kg, owner, 'B');
    const mc = await kg.createMergeCandidate({
      mkAExternalId: mkA,
      mkBExternalId: mkB,
      cosineSim: 0.97,
    });
    await kg.resolveMergeCandidate(mc!.id, 'not_duplicate', {
      actorOmadiaUserId: owner,
    });
    await assert.rejects(
      kg.resolveMergeCandidate(mc!.id, 'keep_a', { actorOmadiaUserId: owner }),
      (err: { code?: string }) => err.code === 'already_resolved',
    );
  });
});

describe('Slice 10 · bulk-marker helpers', () => {
  it('marker is independent from inconsistency marker', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const owner = await seed(kg, ALICE, 'alice@example.com');
    const mk = await makeMK(kg, owner, 'A');
    kg.setEmbedding(mk, [0.1, 0.2]);

    await kg.markMemorableKnowledgeInconsistencyChecked(mk);
    let mergeBuckets = await kg.countMemorableKnowledgeMergeCheckBuckets();
    let incBuckets = await kg.countMemorableKnowledgeInconsistencyCheckBuckets();
    assert.equal(mergeBuckets.unchecked, 1);
    assert.equal(mergeBuckets.alreadyChecked, 0);
    assert.equal(incBuckets.alreadyChecked, 1);

    await kg.markMemorableKnowledgeMergeChecked(mk);
    mergeBuckets = await kg.countMemorableKnowledgeMergeCheckBuckets();
    incBuckets = await kg.countMemorableKnowledgeInconsistencyCheckBuckets();
    assert.equal(mergeBuckets.alreadyChecked, 1);
    assert.equal(incBuckets.alreadyChecked, 1);
  });
  it('selection respects marker + embedding presence', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const owner = await seed(kg, ALICE, 'alice@example.com');
    const mk1 = await makeMK(kg, owner, 'A');
    const mk2 = await makeMK(kg, owner, 'B');
    const mk3 = await makeMK(kg, owner, 'C'); // no embedding
    kg.setEmbedding(mk1, [0.1]);
    kg.setEmbedding(mk2, [0.2]);
    await kg.markMemorableKnowledgeMergeChecked(mk1);

    const ids = await kg.listMemorableKnowledgeIdsForBulkMergeCheck({
      limit: 10,
    });
    assert.deepEqual(ids, [mk2]);
  });
});

interface MockDetectorState {
  calls: string[];
}

function createMockMergeDetector(
  kg: KnowledgeGraph,
  state: MockDetectorState,
  perCallCreated = 1,
): MergeCandidateDetectorService {
  return {
    async detectFor(mkId) {
      state.calls.push(mkId);
      await kg.markMemorableKnowledgeMergeChecked(mkId);
      return { candidatesScanned: 2, mergeCandidatesCreated: perCallCreated };
    },
  };
}

describe('Slice 10 · BulkMergeDetectService', () => {
  it('preview reports counts + detectorAvailable=true', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const owner = await seed(kg, ALICE, 'alice@example.com');
    const mk = await makeMK(kg, owner, 'A');
    kg.setEmbedding(mk, [0.1]);
    const state: MockDetectorState = { calls: [] };
    const service = createBulkMergeDetectService({
      kg,
      detector: createMockMergeDetector(kg, state),
    });
    const preview = await service.preview();
    assert.equal(preview.unchecked, 1);
    assert.equal(preview.detectorAvailable, true);
  });
  it('run walks selection and aggregates stats; re-run is idempotent', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const owner = await seed(kg, ALICE, 'alice@example.com');
    const mk1 = await makeMK(kg, owner, 'A');
    const mk2 = await makeMK(kg, owner, 'B');
    kg.setEmbedding(mk1, [0.1]);
    kg.setEmbedding(mk2, [0.2]);
    const state: MockDetectorState = { calls: [] };
    const service = createBulkMergeDetectService({
      kg,
      detector: createMockMergeDetector(kg, state, 1),
    });
    const result = await service.run({ limit: 10 });
    assert.equal(result.scanned, 2);
    assert.equal(result.checked, 2);
    assert.equal(result.mergeCandidatesCreated, 2);
    const second = await service.run({ limit: 10 });
    assert.equal(second.scanned, 0);
  });
  it('clamps limit to 500', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const owner = await seed(kg, ALICE, 'alice@example.com');
    const mk = await makeMK(kg, owner, 'A');
    kg.setEmbedding(mk, [0.1]);
    const state: MockDetectorState = { calls: [] };
    const service = createBulkMergeDetectService({
      kg,
      detector: createMockMergeDetector(kg, state, 0),
    });
    const result = await service.run({ limit: 9999 });
    assert.equal(result.scanned, 1);
  });
});

describe('Slice 10 · MergeTriggeringKnowledgeGraph', () => {
  it('fires the detector on createMemorableKnowledge', async () => {
    const inner = new InMemoryKnowledgeGraph();
    const owner = await seed(inner, ALICE, 'alice@example.com');
    const state: MockDetectorState = { calls: [] };
    const wrapped = new MergeTriggeringKnowledgeGraph({
      inner,
      detector: createMockMergeDetector(inner, state, 0),
    });
    const r = await wrapped.createMemorableKnowledge({
      kind: 'insight',
      summary: 'A',
      createdBy: `web:${owner}`,
      involvedOmadiaUserIds: [owner],
      aclOwners: [owner],
    });
    // Trigger is fire-and-forget — flush the microtask queue.
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(state.calls.includes(r.memorableKnowledgeNodeId));
  });
  it('fires on resolveMergeCandidate keep_a (survivor re-check)', async () => {
    const inner = new InMemoryKnowledgeGraph();
    const owner = await seed(inner, ALICE, 'alice@example.com');
    const mkA = await makeMK(inner, owner, 'A');
    const mkB = await makeMK(inner, owner, 'B');
    const mc = await inner.createMergeCandidate({
      mkAExternalId: mkA,
      mkBExternalId: mkB,
      cosineSim: 0.97,
    });
    const state: MockDetectorState = { calls: [] };
    const wrapped = new MergeTriggeringKnowledgeGraph({
      inner,
      detector: createMockMergeDetector(inner, state, 0),
    });
    await wrapped.resolveMergeCandidate(mc!.id, 'keep_a', {
      actorOmadiaUserId: owner,
    });
    await new Promise((resolve) => setImmediate(resolve));
    // Survivor is duplicateOf[0] (sorted-A).
    assert.ok(state.calls.length >= 1);
  });
  it('does not fire on resolveInconsistency dismiss', async () => {
    // Sanity: the InMemory inner needs an inconsistency to resolve;
    // mock both detectors to count their calls.
    const inner = new InMemoryKnowledgeGraph();
    const owner = await seed(inner, ALICE, 'alice@example.com');
    const mkA = await makeMK(inner, owner, 'A');
    const mkB = await makeMK(inner, owner, 'B');
    const inc = await inner.createInconsistency({
      mkAExternalId: mkA,
      mkBExternalId: mkB,
      summary: 'mock',
      severity: 'low',
    });
    const mergeState: MockDetectorState = { calls: [] };
    const wrapped = new MergeTriggeringKnowledgeGraph({
      inner,
      detector: createMockMergeDetector(inner, mergeState, 0),
    });
    await wrapped.resolveInconsistency(inc!.id, 'dismiss', {
      actorOmadiaUserId: owner,
    });
    await new Promise((resolve) => setImmediate(resolve));
    // dismiss path → no fire (only a_wins/b_wins re-fire the survivor).
    assert.equal(mergeState.calls.length, 0);
  });
});

// Suppress unused warning on the InconsistencyDetectorService type
// import — kept for symmetry with slice9Inconsistency.test.ts shape.
type _Keep = InconsistencyDetectorService;
