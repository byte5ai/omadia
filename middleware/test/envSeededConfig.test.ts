import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { Config } from '../src/config.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import { bootstrapKnowledgeGraphFromEnv } from '../src/plugins/bootstrap.js';
import {
  ENV_SEEDED_MARKER_KEY,
  applyEnvSeeds,
  type EnvSeed,
} from '../src/plugins/envSeededConfig.js';
import type { PluginCatalog } from '../src/plugins/manifestLoader.js';
import type { SecretVault } from '../src/secrets/vault.js';

/**
 * #1858 / ADR-0193 — GRAPH_EMBEDDING_BACKFILL_* took effect only on the first
 * auto-install: the migration wrote all four keys (defaults included) and the
 * plugin prefers config, so a later env change was silently ignored.
 */

const BATCH: EnvSeed = {
  envName: 'GRAPH_EMBEDDING_BACKFILL_BATCH_SIZE',
  configKey: 'graph_embedding_backfill_batch_size',
  value: '200',
  legacyDefault: '20',
};

describe('applyEnvSeeds (ADR-0193)', () => {
  it('writes nothing for an unset variable', () => {
    const r = applyEnvSeeds({}, [BATCH], {});
    assert.equal(r.config?.[BATCH.configKey], undefined);
    assert.deepEqual(r.shadowed, []);
  });

  it('seeds a set variable and records it as boot-owned', () => {
    const r = applyEnvSeeds({}, [BATCH], { [BATCH.envName]: '200' });
    assert.equal(r.config?.[BATCH.configKey], '200');
    assert.deepEqual(JSON.parse(String(r.config?.[ENV_SEEDED_MARKER_KEY])), {
      [BATCH.configKey]: '200',
    });
  });

  it('a boot-owned value follows a changed variable', () => {
    const first = applyEnvSeeds({}, [{ ...BATCH, value: '50' }], {
      [BATCH.envName]: '50',
    });
    const second = applyEnvSeeds(first.config!, [BATCH], {
      [BATCH.envName]: '200',
    });
    assert.equal(second.config?.[BATCH.configKey], '200');
  });

  it('a boot-owned value is removed when the variable is unset again', () => {
    const first = applyEnvSeeds({}, [BATCH], { [BATCH.envName]: '200' });
    const second = applyEnvSeeds(first.config!, [BATCH], {});
    assert.equal(second.config?.[BATCH.configKey], undefined);
  });

  it('an operator value wins and the shadowed variable is reported', () => {
    const seeded = applyEnvSeeds({}, [{ ...BATCH, value: '50' }], {
      [BATCH.envName]: '50',
    }).config!;
    const edited = { ...seeded, [BATCH.configKey]: '75' };
    const r = applyEnvSeeds(edited, [BATCH], { [BATCH.envName]: '200' });
    assert.equal(r.config, null, 'operator value untouched');
    assert.deepEqual(r.shadowed, [
      {
        envName: BATCH.envName,
        configKey: BATCH.configKey,
        stored: '75',
        envValue: '200',
      },
    ]);
  });

  it('an operator value survives an unset variable', () => {
    const r = applyEnvSeeds(
      { [BATCH.configKey]: '75', [ENV_SEEDED_MARKER_KEY]: '{}' },
      [BATCH],
      {},
    );
    assert.equal(r.config, null);
  });

  it('legacy entry (no marker, built-in default stored) follows a set variable', () => {
    const r = applyEnvSeeds({ [BATCH.configKey]: '20' }, [BATCH], {
      [BATCH.envName]: '200',
    });
    assert.equal(r.config?.[BATCH.configKey], '200');
  });

  it('legacy entry with a non-default value counts as the operator’s', () => {
    const r = applyEnvSeeds({ [BATCH.configKey]: '75' }, [BATCH], {
      [BATCH.envName]: '200',
    });
    assert.equal(r.config?.[BATCH.configKey], '75');
    assert.equal(r.shadowed.length, 1);
  });
});

describe('applyEnvSeeds — #2299 additions', () => {
  const DIR: EnvSeed = {
    envName: 'MEMORY_SEED_DIR',
    configKey: 'seed_dir',
    value: '/app/seed/memory',
    legacyDefault: '/app/seed/memory',
    fallback: '/app/seed/memory',
  };

  it('writes the kernel fallback for an unset variable instead of removing the key', () => {
    const r = applyEnvSeeds({}, [DIR], {});
    assert.equal(r.config?.['seed_dir'], '/app/seed/memory');
    const owned = applyEnvSeeds(r.config ?? {}, [{ ...DIR, value: '/custom' }], { MEMORY_SEED_DIR: '/custom' });
    assert.equal(owned.config?.['seed_dir'], '/custom', 'the fallback stays boot-owned');
  });

  it('keeps an operator value over the fallback', () => {
    const r = applyEnvSeeds({ seed_dir: '/operator', [ENV_SEEDED_MARKER_KEY]: '{}' }, [DIR], {});
    assert.equal(r.config, null);
  });

  it('a pre-marker value equal to the set variable is boot-owned', () => {
    const url: EnvSeed = { envName: 'OLLAMA_BASE_URL', configKey: 'ollama_base_url', value: 'http://a', legacyDefault: '' };
    const first = applyEnvSeeds({ ollama_base_url: 'http://a' }, [url], { OLLAMA_BASE_URL: 'http://a' });
    const next = applyEnvSeeds(first.config ?? {}, [{ ...url, value: 'http://b' }], { OLLAMA_BASE_URL: 'http://b' });
    assert.equal(next.config?.['ollama_base_url'], 'http://b');
    assert.deepEqual(next.shadowed, []);
  });
});

describe('bootstrapKnowledgeGraphFromEnv — backfill seeds (#1858)', () => {
  const NEON = '@omadia/knowledge-graph-neon';
  const catalog = {
    get: (id: string) =>
      id === NEON || id === '@omadia/knowledge-graph-inmemory'
        ? { plugin: { id, version: '1.0.0' } }
        : undefined,
    list: () => [],
  } as unknown as PluginCatalog;
  const vault = {
    get: async () => undefined,
    setMany: async () => {},
  } as unknown as SecretVault;
  const config = {
    DATABASE_URL: 'postgres://x',
    GRAPH_TENANT_ID: 'default',
    GRAPH_EMBEDDING_BACKFILL_ENABLED: true,
    GRAPH_EMBEDDING_BACKFILL_INTERVAL_MINUTES: 1,
    GRAPH_EMBEDDING_BACKFILL_BATCH_SIZE: 200,
    GRAPH_EMBEDDING_BACKFILL_MAX_ATTEMPTS: 5,
  } as unknown as Config;

  it('the issue scenario: a variable added after the first install takes effect', async () => {
    const reg = new InMemoryInstalledRegistry();
    // An install written by the old migration: all four defaults, no marker.
    await reg.register({
      id: NEON,
      installed_version: '1.0.0',
      installed_at: '2026-11-01T00:00:00Z',
      status: 'active',
      config: {
        graph_embedding_backfill_enabled: 'true',
        graph_embedding_backfill_interval_minutes: '5',
        graph_embedding_backfill_batch_size: '20',
        graph_embedding_backfill_max_attempts: '5',
      },
    });
    const logs: string[] = [];
    await bootstrapKnowledgeGraphFromEnv({
      config,
      catalog,
      registry: reg,
      vault,
      env: {
        GRAPH_EMBEDDING_BACKFILL_INTERVAL_MINUTES: '1',
        GRAPH_EMBEDDING_BACKFILL_BATCH_SIZE: '200',
      },
      log: (m) => logs.push(m),
    });
    const c = reg.get(NEON)?.config ?? {};
    assert.equal(c['graph_embedding_backfill_interval_minutes'], '1');
    assert.equal(c['graph_embedding_backfill_batch_size'], '200');
    assert.equal(
      c['graph_embedding_backfill_enabled'],
      undefined,
      'unset variable: the stored default goes, the plugin default applies',
    );
  });

  it('reconciles the seeds on a boot that self-heals a dual-active knowledge graph', async () => {
    const reg = new InMemoryInstalledRegistry();
    for (const id of [NEON, '@omadia/knowledge-graph-inmemory']) {
      await reg.register({
        id,
        installed_version: '1.0.0',
        installed_at: '2026-11-01T00:00:00Z',
        status: 'active',
        config: id === NEON ? { graph_embedding_backfill_batch_size: '20' } : {},
      });
    }
    await bootstrapKnowledgeGraphFromEnv({
      config,
      catalog,
      registry: reg,
      vault,
      env: { GRAPH_EMBEDDING_BACKFILL_BATCH_SIZE: '200' },
      log: () => {},
    });
    assert.equal(reg.get('@omadia/knowledge-graph-inmemory'), undefined, 'dual-active healed');
    assert.equal(reg.get(NEON)?.config?.['graph_embedding_backfill_batch_size'], '200');
  });

  it('logs a set variable that an operator value shadows', async () => {
    const reg = new InMemoryInstalledRegistry();
    await reg.register({
      id: NEON,
      installed_version: '1.0.0',
      installed_at: '2026-11-01T00:00:00Z',
      status: 'active',
      config: {
        graph_embedding_backfill_batch_size: '75',
        [ENV_SEEDED_MARKER_KEY]: '{}',
      },
    });
    const logs: string[] = [];
    await bootstrapKnowledgeGraphFromEnv({
      config,
      catalog,
      registry: reg,
      vault,
      env: { GRAPH_EMBEDDING_BACKFILL_BATCH_SIZE: '200' },
      log: (m) => logs.push(m),
    });
    assert.equal(
      reg.get(NEON)?.config?.['graph_embedding_backfill_batch_size'],
      '75',
    );
    assert.ok(
      logs.some((l) => l.includes('GRAPH_EMBEDDING_BACKFILL_BATCH_SIZE') && l.includes('ignored')),
      logs.join('\n'),
    );
  });

  it('first install writes only the variables that are set', async () => {
    const reg = new InMemoryInstalledRegistry();
    await bootstrapKnowledgeGraphFromEnv({
      config,
      catalog,
      registry: reg,
      vault,
      env: { GRAPH_EMBEDDING_BACKFILL_BATCH_SIZE: '200' },
      log: () => {},
    });
    const c = reg.get(NEON)?.config ?? {};
    assert.equal(c['graph_embedding_backfill_batch_size'], '200');
    assert.equal(c['graph_embedding_backfill_interval_minutes'], undefined);
    assert.equal(c['graph_embedding_backfill_enabled'], undefined);
  });
});
