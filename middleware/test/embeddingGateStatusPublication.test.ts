import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createEmbeddingGateStatus } from '@omadia/knowledge-graph-neon/dist/gateStatusPublication.js';

import { buildKgHealth } from '../src/health/kgHealth.js';
import type { InstalledRegistry } from '../src/plugins/installedRegistry.js';

/**
 * #440 — the gate runs once, at activation. What it describes does NOT stay
 * still: the backfill sweep finishes the owed clear minutes later. A frozen
 * snapshot could no longer lie green, but it lied RED indefinitely — /health
 * kept reporting `stale-vector-clear-pending` until somebody restarted the
 * process.
 */

const KG_NEON = '@omadia/knowledge-graph-neon';
const EMBEDDINGS = '@omadia/embeddings';

/** Minimal stand-in for the installed registry: buildKgHealth only calls get(). */
function registry(
  entries: ReadonlyArray<{ id: string; config?: Record<string, unknown> }>,
): InstalledRegistry {
  const byId = new Map(
    entries.map((e) => [e.id, { status: 'active', config: e.config ?? {} }]),
  );
  return {
    get: (id: string) => byId.get(id),
  } as unknown as InstalledRegistry;
}

const OWED_MATCH = {
  status: 'match',
  modelId: 'ollama:nomic-embed-text',
  dimensions: 768,
  clearPending: true,
} as const;

describe('embedding gate status publication (#440)', () => {
  it('publishes ONE object whose fields follow the clear to completion', async () => {
    const published = createEmbeddingGateStatus(OWED_MATCH, false, true);
    // The ServiceRegistry hands out this reference once and never again, so
    // the identity has to survive the update.
    const handedToTheRegistry = published.status;

    assert.equal(handedToTheRegistry.vectorWritesAllowed, false);
    assert.equal(handedToTheRegistry.reason, 'stale-vector-clear-pending');

    published.markStaleVectorClearComplete();

    assert.equal(
      handedToTheRegistry.reason,
      'stale-vector-clear-complete',
      'the same object the registry holds must reflect the finished clear',
    );
    assert.match(String(handedToTheRegistry.detail), /without a restart/);
    assert.equal(
      handedToTheRegistry.vectorWritesAllowed,
      true,
      'the hot path really IS back on: both stores resolve their embedding ' +
        'client live, so this flip is what re-enables them — reporting false ' +
        'would now be the lie',
    );
    assert.equal(
      published.vectorWritesAllowed(),
      true,
      'the plugin resolver reads this, so it has to agree with the published field',
    );
    // The published shape has to survive JSON — /health serialises it.
    assert.deepEqual(JSON.parse(JSON.stringify(handedToTheRegistry)), {
      vectorWritesAllowed: true,
      status: 'match',
      reason: 'stale-vector-clear-complete',
      activeModelId: OWED_MATCH.modelId,
      detail: handedToTheRegistry.detail,
    });
  });

  it('exposes the live verdict the plugin resolver consults', async () => {
    const published = createEmbeddingGateStatus(OWED_MATCH, false, true);
    assert.equal(
      published.vectorWritesAllowed(),
      false,
      'while a clear is owed the resolver must hand the stores nothing',
    );
    published.markStaleVectorClearComplete();
    assert.equal(published.vectorWritesAllowed(), true);
  });

  it('never upgrades a verdict that had no pending clear to begin with', async () => {
    const blocked = createEmbeddingGateStatus(
      {
        status: 'blocked',
        reason: 'dimension-mismatch',
        modelId: 'openai:text-embedding-3-small',
        dimensions: 1536,
        storedModelId: 'ollama:nomic-embed-text',
        storedDimensions: 768,
      },
      false,
      false,
    );

    blocked.markStaleVectorClearComplete();

    assert.equal(blocked.status.reason, 'dimension-mismatch');
    assert.equal(
      blocked.status.vectorWritesAllowed,
      false,
      'a completion callback must never open writes a blocked verdict closed',
    );
    assert.equal(blocked.vectorWritesAllowed(), false);
  });

  it('carries a pending clear on the unknown-provider outcome too', async () => {
    const published = createEmbeddingGateStatus(
      { status: 'unknown-provider', clearPending: true },
      false,
      true,
    );

    assert.equal(published.status.status, 'unknown-provider');
    assert.equal(published.status.vectorWritesAllowed, false);
    assert.equal(published.status.reason, 'stale-vector-clear-pending');

    published.markStaleVectorClearComplete();
    assert.equal(published.status.reason, 'stale-vector-clear-complete');
    assert.equal(published.status.vectorWritesAllowed, true);
  });

  it('/health stops reporting a pending clear the moment the sweep finishes it', async () => {
    const published = createEmbeddingGateStatus(OWED_MATCH, false, true);
    const reg = registry([
      { id: KG_NEON },
      { id: EMBEDDINGS, config: { ollama_base_url: 'http://ollama:11434' } },
    ]);

    const before = buildKgHealth(reg, published.status);
    assert.equal(before.embeddings, false);
    assert.equal(before.warnings.length, 1);
    assert.match(String(before.warnings[0]), /still dropping old vectors/);

    published.markStaleVectorClearComplete();

    const after = buildKgHealth(reg, published.status);
    assert.deepEqual(
      after.warnings,
      [],
      'the clear is finished AND the hot path was re-enabled in-process — there ' +
        'is nothing left to warn about, and the old "restart it" note became wrong',
    );
    assert.equal(after.embeddings, true);
    assert.equal(after.semanticRecall, true);
    assert.equal(after.processReuse, true);
  });

  it('surfaces a runtime vector-column migration on /health even though writes are ON', async () => {
    const published = createEmbeddingGateStatus(
      {
        status: 'column-migrated',
        modelId: 'openai:text-embedding-3-small',
        dimensions: 1536,
        previousModelId: 'ollama:nomic-embed-text',
        previousDimensions: 768,
        migratedColumns: [
          {
            table: 'graph_nodes',
            column: 'embedding',
            previousDimensions: 768,
            newDimensions: 1536,
            indexes: ['CREATE INDEX i ON graph_nodes USING hnsw (embedding)'],
            discardedVectors: 42,
            attemptsReset: 7,
          },
        ],
        discardedVectors: 42,
        clearPending: false,
      },
      true,
      false,
    );

    assert.equal(published.status.vectorWritesAllowed, true);
    assert.equal(published.status.reason, 'vector-columns-migrated');
    assert.match(String(published.status.detail), /42 stored vector\(s\) were discarded/);
    assert.match(String(published.status.activeModelId), /1536d/);

    const health = buildKgHealth(
      registry([
        { id: KG_NEON },
        { id: EMBEDDINGS, config: { ollama_base_url: 'http://ollama:11434' } },
      ]),
      published.status,
    );
    assert.equal(health.embeddings, true, 'nothing is disabled — the columns fit now');
    assert.equal(health.warnings.length, 1);
    assert.match(String(health.warnings[0]), /migrated automatically/);
    assert.match(String(health.warnings[0]), /42 stored vector/);
    assert.match(String(health.warnings[0]), /auto_migrate_vector_columns=false/);
  });

  it('reports a migration whose capped retry-counter reset is still owed as writes-OFF', async () => {
    // F2 — the reset is bounded, and the remainder rides on `clear_pending`.
    // While that is up, `clearStaleVectors` NULLs every non-NULL governed
    // vector it finds, so allowing writes would destroy freshly embedded rows.
    const published = createEmbeddingGateStatus(
      {
        status: 'column-migrated',
        modelId: 'openai:text-embedding-3-small',
        dimensions: 1536,
        previousModelId: 'ollama:nomic-embed-text',
        previousDimensions: 768,
        migratedColumns: [
          {
            table: 'graph_nodes',
            column: 'embedding',
            previousDimensions: 768,
            newDimensions: 1536,
            indexes: [],
            discardedVectors: 9,
            attemptsReset: 5_000,
          },
        ],
        discardedVectors: 9,
        clearPending: true,
      },
      false,
      true,
    );

    assert.equal(published.vectorWritesAllowed(), false);
    assert.equal(published.status.reason, 'stale-vector-clear-pending');
    assert.match(String(published.status.detail), /retry-counter reset is still owed/);

    // …and it clears without a restart, the same way every other owed clear
    // does — this must not become a permanent red.
    published.markStaleVectorClearComplete();
    assert.equal(published.vectorWritesAllowed(), true);
    assert.equal(published.status.reason, 'stale-vector-clear-complete');
  });

  it('names a schema/registry split on /health instead of a width complaint that no longer fits', async () => {
    // A migration that moved columns and could not record it leaves the
    // columns at the new width while `graph_embedding_model` names the old
    // model. The next activation sees no width mismatch, falls through to
    // decideRegistry and reports blocked/dimension-mismatch forever — so the
    // one boot that CAN describe the state has to say so.
    const published = createEmbeddingGateStatus(
      {
        status: 'blocked',
        reason: 'column-width-mismatch',
        modelId: 'openai:text-embedding-3-small',
        dimensions: 1536,
        mismatches: [
          { table: 'processes', column: 'embedding', declaredDimensions: 768 },
        ],
        migrationHazard:
          "1 column(s) are already vector(1536) while graph_embedding_model was NOT updated [registry-flip-failed]: the registry row changed between read and flip",
      },
      false,
      false,
    );

    assert.equal(published.status.vectorWritesAllowed, false);
    assert.equal(published.status.reason, 'column-width-mismatch');
    assert.match(String(published.status.detail), /processes\.embedding is vector\(768\)/);
    assert.match(String(published.status.detail), /SCHEMA\/REGISTRY SPLIT/);
    assert.match(String(published.status.detail), /registry-flip-failed/);
  });
});
