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
    assert.match(String(handedToTheRegistry.detail), /restart/);
    assert.equal(
      handedToTheRegistry.vectorWritesAllowed,
      false,
      'the hot path really is still off — this process built its stores without ' +
        'an embedding client, so flipping to true would restore the false-green reading',
    );
    // The published shape has to survive JSON — /health serialises it.
    assert.deepEqual(JSON.parse(JSON.stringify(handedToTheRegistry)), {
      vectorWritesAllowed: false,
      status: 'match',
      reason: 'stale-vector-clear-complete',
      activeModelId: OWED_MATCH.modelId,
      detail: handedToTheRegistry.detail,
    });
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
    assert.equal(blocked.status.vectorWritesAllowed, false);
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
    assert.ok(
      !/still dropping old vectors/.test(String(after.warnings[0])),
      'the clear is finished — saying it is still draining is the red-lie this fixes',
    );
    assert.match(String(after.warnings[0]), /clear has drained/);
    assert.match(String(after.warnings[0]), /restart/);
    assert.ok(
      !/no vectors are being written/.test(String(after.warnings[0])),
      'the backfill sweep IS writing vectors again; only the hot path is off',
    );
  });
});
