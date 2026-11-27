import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import {
  DEDUP_THRESHOLD_SOURCE_CONFIG_KEY,
  describeDedupThreshold,
  reconcileRecommendedDedupThreshold,
  releaseRecommendedDedupThreshold,
} from '../src/routes/embeddingDedupThreshold.js';

/**
 * #1818 — the knowledge graph's `process_dedup_threshold` carries its
 * provenance: omadia's recommendation for a named provider can be replaced or
 * removed when the provider changes, an operator value is never touched.
 */

const KG = '@omadia/knowledge-graph-neon';
const LOCAL = '@omadia/embedding-adapter-local';
const OLLAMA = '@omadia/embeddings';
const KEY = 'process_dedup_threshold';

async function registryWith(config?: Record<string, unknown>): Promise<InMemoryInstalledRegistry> {
  const registry = new InMemoryInstalledRegistry();
  if (config !== undefined) {
    await registry.register({
      id: KG,
      installed_version: '0.1.0',
      installed_at: '2026-11-26T00:00:00Z',
      status: 'active',
      config,
    });
  }
  return registry;
}

const kgConfig = (r: InMemoryInstalledRegistry): Record<string, unknown> =>
  r.get(KG)?.config ?? {};

describe('describeDedupThreshold (#1818)', () => {
  it('reads an unset or blank value as the KG default', () => {
    assert.equal(describeDedupThreshold({}).source, 'default');
    assert.equal(describeDedupThreshold({ [KEY]: '  ' }).source, 'default');
  });

  it('reads a marked value that still equals the recommendation as omadia’s own', () => {
    const p = describeDedupThreshold({ [KEY]: '0.45', [DEDUP_THRESHOLD_SOURCE_CONFIG_KEY]: LOCAL });
    assert.deepEqual(p, { source: 'recommended', value: '0.45', recommendedBy: LOCAL });
  });

  it('reads an edited value as the operator’s even when the marker survived', () => {
    const p = describeDedupThreshold({ [KEY]: '0.5', [DEDUP_THRESHOLD_SOURCE_CONFIG_KEY]: LOCAL });
    assert.equal(p.source, 'operator');
  });

  it('reads an unmarked value as the operator’s unless it is exactly one provider’s recommendation', () => {
    assert.equal(describeDedupThreshold({ [KEY]: '0.6' }).source, 'operator');
    // Legacy: builds before the marker wrote the bare recommendation.
    assert.deepEqual(describeDedupThreshold({ [KEY]: '0.45' }), {
      source: 'recommended',
      value: '0.45',
      recommendedBy: LOCAL,
    });
  });
});

describe('reconcileRecommendedDedupThreshold (#1818)', () => {
  it('writes the recommendation with its marker into an unset threshold', async () => {
    const r = await registryWith({});
    const out = await reconcileRecommendedDedupThreshold(r, LOCAL);
    assert.equal(out.reason, 'applied');
    assert.equal(out.value, 0.45);
    assert.equal(kgConfig(r)[KEY], '0.45');
    assert.equal(kgConfig(r)[DEDUP_THRESHOLD_SOURCE_CONFIG_KEY], LOCAL);
  });

  it('is idempotent for the same provider', async () => {
    const r = await registryWith({ [KEY]: '0.45', [DEDUP_THRESHOLD_SOURCE_CONFIG_KEY]: LOCAL });
    const out = await reconcileRecommendedDedupThreshold(r, LOCAL);
    assert.equal(out.reason, 'unchanged');
  });

  it('removes omadia’s value when the new provider makes no recommendation', async () => {
    const r = await registryWith({ [KEY]: '0.45', [DEDUP_THRESHOLD_SOURCE_CONFIG_KEY]: LOCAL });
    const out = await reconcileRecommendedDedupThreshold(r, OLLAMA);
    assert.equal(out.reason, 'cleared');
    assert.equal(out.previous, '0.45');
    assert.equal(kgConfig(r)[KEY], undefined);
    assert.equal(kgConfig(r)[DEDUP_THRESHOLD_SOURCE_CONFIG_KEY], undefined);
  });

  it('never touches an operator value, and drops a stale marker', async () => {
    const r = await registryWith({ [KEY]: '0.8', [DEDUP_THRESHOLD_SOURCE_CONFIG_KEY]: LOCAL });
    const out = await reconcileRecommendedDedupThreshold(r, OLLAMA);
    assert.equal(out.reason, 'operator-set');
    assert.equal(kgConfig(r)[KEY], '0.8');
    assert.equal(kgConfig(r)[DEDUP_THRESHOLD_SOURCE_CONFIG_KEY], undefined);
  });

  it('reports a missing knowledge graph', async () => {
    const r = await registryWith();
    const out = await reconcileRecommendedDedupThreshold(r, LOCAL);
    assert.equal(out.reason, 'no-knowledge-graph');
  });
});

describe('legacy unmarked recommendation (#1818, installs before the marker)', () => {
  it('a switch away from the keyless adapter clears its old bare threshold', async () => {
    const r = await registryWith({ [KEY]: '0.45' });
    const out = await reconcileRecommendedDedupThreshold(r, OLLAMA);
    assert.equal(out.reason, 'cleared');
    assert.equal(kgConfig(r)[KEY], undefined);
  });

  it('an uninstall of the keyless adapter releases its old bare threshold', async () => {
    const r = await registryWith({ [KEY]: '0.45' });
    assert.equal(await releaseRecommendedDedupThreshold(r, LOCAL), true);
    assert.equal(kgConfig(r)[KEY], undefined);
  });
});

describe('releaseRecommendedDedupThreshold (#1818)', () => {
  it('removes the value recommended for the uninstalled provider', async () => {
    const r = await registryWith({ [KEY]: '0.45', [DEDUP_THRESHOLD_SOURCE_CONFIG_KEY]: LOCAL });
    assert.equal(await releaseRecommendedDedupThreshold(r, LOCAL), true);
    assert.equal(kgConfig(r)[KEY], undefined);
  });

  it('keeps an operator value and another provider’s recommendation', async () => {
    const operator = await registryWith({ [KEY]: '0.6' });
    assert.equal(await releaseRecommendedDedupThreshold(operator, LOCAL), false);
    assert.equal(kgConfig(operator)[KEY], '0.6');

    const other = await registryWith({ [KEY]: '0.45', [DEDUP_THRESHOLD_SOURCE_CONFIG_KEY]: LOCAL });
    assert.equal(await releaseRecommendedDedupThreshold(other, OLLAMA), false);
    assert.equal(kgConfig(other)[KEY], '0.45');
  });
});
