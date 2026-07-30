import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { buildKgHealth } from '../src/health/kgHealth.js';
import type { EmbeddingGateStatus } from '../src/health/kgHealth.js';
import type { InstalledRegistry } from '../src/plugins/installedRegistry.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';

const KG_NEON = '@omadia/knowledge-graph-neon';
const KG_INMEMORY = '@omadia/knowledge-graph-inmemory';
const EMBEDDINGS = '@omadia/embeddings';
const EMBEDDINGS_OPENAI = '@omadia/embedding-adapter-openai';

async function reg(
  entries: Array<{ id: string; status?: 'active' | 'inactive' | 'errored'; config?: Record<string, unknown> }>,
): Promise<InstalledRegistry> {
  const r = new InMemoryInstalledRegistry();
  for (const e of entries) {
    await r.register({
      id: e.id,
      installed_version: '0.1.0',
      installed_at: '2026-06-28T00:00:00Z',
      status: e.status ?? 'active',
      config: e.config ?? {},
    });
  }
  return r;
}

describe('buildKgHealth', () => {
  it('neon + embeddings configured → fully healthy, no warnings', async () => {
    const h = buildKgHealth(
      await reg([
        { id: KG_NEON },
        { id: EMBEDDINGS, config: { ollama_base_url: 'http://ollama:11434' } },
      ]),
    );
    assert.equal(h.backend, 'neon');
    assert.equal(h.durable, true);
    assert.equal(h.embeddings, true);
    assert.equal(h.semanticRecall, true);
    assert.equal(h.durableTier, true);
    assert.equal(h.processReuse, true);
    assert.deepEqual(h.warnings, []);
  });

  it('neon but embeddings OFF → FTS-only, recall features inactive (the silent-degradation case)', async () => {
    const h = buildKgHealth(await reg([{ id: KG_NEON }, { id: EMBEDDINGS, config: {} }]));
    assert.equal(h.backend, 'neon');
    assert.equal(h.durable, true);
    assert.equal(h.embeddings, false);
    assert.equal(h.semanticRecall, false);
    assert.equal(h.durableTier, false);
    assert.equal(h.processReuse, false);
    assert.ok(h.warnings.some((w) => w.includes('embeddings disabled')));
  });

  it('inmemory backend → volatile warning + no process-reuse even with embeddings', async () => {
    const h = buildKgHealth(
      await reg([
        { id: KG_INMEMORY },
        { id: EMBEDDINGS, config: { ollama_base_url: 'http://ollama:11434' } },
      ]),
    );
    assert.equal(h.backend, 'inmemory');
    assert.equal(h.durable, false);
    assert.equal(h.processReuse, false, 'inmemory has no processMemory');
    assert.ok(h.warnings.some((w) => w.includes('lost on restart')));
    assert.ok(h.warnings.some((w) => w.includes('process-reuse unavailable')));
  });

  it('no backend active → unavailable warning', async () => {
    const h = buildKgHealth(await reg([{ id: KG_NEON, status: 'errored' }]));
    assert.equal(h.backend, 'none');
    assert.equal(h.semanticRecall, false);
    assert.ok(h.warnings.some((w) => w.includes('no knowledge-graph backend')));
  });

  it('whitespace-only ollama_base_url is treated as OFF (matches the plugin .trim() gate)', async () => {
    const h = buildKgHealth(
      await reg([{ id: KG_NEON }, { id: EMBEDDINGS, config: { ollama_base_url: '  \n ' } }]),
    );
    assert.equal(h.embeddings, false, 'whitespace URL publishes no client → must report off');
    assert.ok(h.warnings.some((w) => w.includes('embeddings disabled')));
  });

  it('dual-active neon+inmemory → neon wins (durable backend reported)', async () => {
    const h = buildKgHealth(await reg([{ id: KG_NEON }, { id: KG_INMEMORY }]));
    assert.equal(h.backend, 'neon', 'neon takes precedence over inmemory when both active');
    assert.equal(h.durable, true);
  });

  it('inactive embeddings entry does not count as embeddings-on', async () => {
    const h = buildKgHealth(
      await reg([
        { id: KG_NEON },
        { id: EMBEDDINGS, status: 'inactive', config: { ollama_base_url: 'http://ollama:11434' } },
      ]),
    );
    assert.equal(h.embeddings, false, 'inactive embeddings plugin is not active');
  });

  it('an alternative embeddingClient provider counts as embeddings-on when the gate passed (#440)', async () => {
    const h = buildKgHealth(await reg([{ id: KG_NEON }, { id: EMBEDDINGS_OPENAI }]), {
      vectorWritesAllowed: true,
      status: 'match',
      activeModelId: 'openai:text-embedding-3-small',
    });
    assert.equal(h.embeddings, true, 'Ollama is no longer the only provider');
    assert.equal(h.semanticRecall, true);
    assert.equal(h.processReuse, true);
    assert.deepEqual(h.warnings, []);
  });
  it('with no gate opinion at all, the registry projection stands alone (#440)', async () => {
    // No neon backend published a gate outcome — e.g. the plugin never got
    // that far. Nothing to add, nothing to subtract.
    const h = buildKgHealth(
      await reg([{ id: KG_NEON }, { id: EMBEDDINGS_OPENAI }]),
    );
    assert.equal(h.embeddings, true);
    assert.deepEqual(h.warnings, []);
  });

  it('an inactive alternative provider does not count as embeddings-on', async () => {
    const h = buildKgHealth(
      await reg([{ id: KG_NEON }, { id: EMBEDDINGS_OPENAI, status: 'inactive' }]),
    );
    assert.equal(h.embeddings, false);
    assert.ok(h.warnings.some((w) => w.includes('embeddings disabled')));
  });

  // -------------------------------------------------------------------------
  // #440 — the model/dimension gate. The registry cannot see any of this: an
  // adapter is installed and active in every case below, yet no vector is
  // written in any of them.
  // -------------------------------------------------------------------------

  const blockedGate = (over: Partial<EmbeddingGateStatus> = {}): EmbeddingGateStatus => ({
    vectorWritesAllowed: false,
    status: 'blocked',
    reason: 'column-width-mismatch',
    activeModelId: 'openai:text-embedding-3-small (1536d)',
    detail: 'graph_nodes.embedding is vector(768), processes.embedding is vector(768)',
    ...over,
  });

  it('a gate-blocked provider reports embeddings OFF, not healthy (#440)', async () => {
    // The exact failing case: vector(768) columns, operator activates the
    // OpenAI adapter with a 1536d model. The gate blocks, the plugin activates
    // with embeddingClient=undefined, nothing is ever embedded — and the
    // registry-only projection used to answer `embeddings: true,
    // semanticRecall: true, durableTier: true, processReuse: true,
    // warnings: []`.
    const h = buildKgHealth(
      await reg([{ id: KG_NEON }, { id: EMBEDDINGS_OPENAI }]),
      blockedGate(),
    );
    assert.equal(h.backend, 'neon');
    assert.equal(h.durable, true, 'the STORE is still durable');
    assert.equal(h.embeddings, false);
    assert.equal(h.semanticRecall, false);
    assert.equal(h.durableTier, false);
    assert.equal(
      h.processReuse,
      false,
      'NeonProcessMemoryStore has no client, so every write returns embedding-unavailable',
    );
    assert.notDeepEqual(h.warnings, []);
    const warning = h.warnings.join(' | ');
    assert.match(warning, /model\/dimension gate/);
    assert.match(warning, /column-width-mismatch/);
    assert.match(warning, /text-embedding-3-small/);
  });

  it('names stored vs active model when the corpus disagrees (#440)', async () => {
    const h = buildKgHealth(
      await reg([{ id: KG_NEON }, { id: EMBEDDINGS_OPENAI }]),
      blockedGate({
        reason: 'dimension-mismatch',
        activeModelId: 'openai:text-embedding-3-small (1536d)',
        storedModelId: 'ollama:nomic-embed-text (768d)',
        detail: undefined,
      }),
    );
    assert.equal(h.embeddings, false);
    const warning = h.warnings.join(' | ');
    assert.match(warning, /openai:text-embedding-3-small/);
    assert.match(warning, /ollama:nomic-embed-text/);
  });

  it('a pending stale-vector clear also reads as embeddings OFF (#440)', async () => {
    // Writes are refused for the duration of the clear, so no vector reaches
    // the corpus. Reporting semantic recall as available would be the same lie
    // in a different costume.
    const h = buildKgHealth(
      await reg([
        { id: KG_NEON },
        { id: EMBEDDINGS, config: { ollama_base_url: 'http://ollama:11434' } },
      ]),
      {
        vectorWritesAllowed: false,
        status: 're-embedding',
        reason: 'stale-vector-clear-pending',
        activeModelId: 'ollama:nomic-embed-text',
        storedModelId: 'openai:some-768-model',
      },
    );
    assert.equal(h.embeddings, false);
    assert.equal(h.semanticRecall, false);
    assert.equal(h.processReuse, false);
    assert.ok(h.warnings.some((w) => w.includes('stale-vector-clear-pending')));
  });

  it('a passing gate leaves the registry projection untouched (#440)', async () => {
    const h = buildKgHealth(
      await reg([
        { id: KG_NEON },
        { id: EMBEDDINGS, config: { ollama_base_url: 'http://ollama:11434' } },
      ]),
      { vectorWritesAllowed: true, status: 'recorded', activeModelId: 'ollama:nomic-embed-text' },
    );
    assert.equal(h.embeddings, true);
    assert.deepEqual(h.warnings, []);
  });

  it('a gate block does not invent embeddings where no provider is installed', async () => {
    const h = buildKgHealth(await reg([{ id: KG_NEON }]), blockedGate());
    assert.equal(h.embeddings, false);
    assert.equal(
      h.warnings.length,
      1,
      'one warning, not two — the operator has no provider to un-block',
    );
    assert.ok(h.warnings.some((w) => w.includes('embeddings disabled')));
  });
});
