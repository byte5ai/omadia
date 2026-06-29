import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { buildKgHealth } from '../src/health/kgHealth.js';
import type { InstalledRegistry } from '../src/plugins/installedRegistry.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';

const KG_NEON = '@omadia/knowledge-graph-neon';
const KG_INMEMORY = '@omadia/knowledge-graph-inmemory';
const EMBEDDINGS = '@omadia/embeddings';

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
});
