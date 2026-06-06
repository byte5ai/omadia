import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  bootstrapBuiltInPackages,
  bootstrapMemoryFromEnv,
  retryErroredPlugins,
  type RetryErroredPluginsDeps,
} from '../src/plugins/bootstrap.js';
import type { Config } from '../src/config.js';
import type { SecretVault } from '../src/secrets/vault.js';
import {
  InMemoryInstalledRegistry,
  type InstalledAgent,
} from '../src/plugins/installedRegistry.js';
import type { PluginCatalog } from '../src/plugins/manifestLoader.js';
import type { Plugin } from '../src/api/admin-v1.js';

/**
 * S+8.5 sub-commit-3 — `retryErroredPlugins` is the auto-reset path
 * for circuit-broken plugins. Two independent triggers (file-mtime
 * OR cap-resolution) must both reset, and unrelated entries must be
 * untouched on every boot.
 *
 * The test file uses a real tmpdir for the file-mtime path (so we
 * actually exercise `fs.stat`) and a hand-rolled fake catalog +
 * registry for cap-resolution scenarios.
 */

type Partial_Plugin = Pick<
  Plugin,
  'id' | 'provides' | 'requires' | 'depends_on'
> & {
  kind?: Plugin['kind'];
  name?: string;
};

function makeCatalog(plugins: Partial_Plugin[]): PluginCatalog {
  const map = new Map<
    string,
    {
      plugin: Plugin;
      manifest: unknown;
      source_path: string;
      source_kind: 'manifest-v1';
    }
  >();
  for (const p of plugins) {
    map.set(p.id, {
      plugin: {
        id: p.id,
        kind: p.kind ?? 'tool',
        name: p.name ?? p.id,
        version: '0.1.0',
        latest_version: '0.1.0',
        description: '',
        authors: [],
        license: 'proprietary',
        icon_url: null,
        categories: [],
        domain: 'test',
        compat_core: '>=1.0 <2.0',
        signed: false,
        signed_by: null,
        setup_fields: [],
        permissions_summary: {
          memory_reads: [],
          memory_writes: [],
          graph_reads: [],
          graph_writes: [],
          network_outbound: [],
        },
        integrations_summary: [],
        install_state: 'available',
        depends_on: p.depends_on,
        jobs: [],
        provides: p.provides,
        requires: p.requires,
      },
      manifest: {},
      source_path: `<test>/${p.id}.manifest.yaml`,
      source_kind: 'manifest-v1',
    });
  }
  return {
    get: (id: string) => map.get(id),
    list: () => Array.from(map.values()),
  } as unknown as PluginCatalog;
}

function makeBuiltInStore(packages: Array<{ id: string; path: string }>) {
  const map = new Map<string, { id: string; version: string; path: string }>();
  for (const p of packages) {
    map.set(p.id, { id: p.id, version: '0.1.0', path: p.path });
  }
  return {
    get: (id: string) => map.get(id),
    list: () => Array.from(map.values()),
  };
}

function erroredAgent(opts: {
  id: string;
  errorAtIso?: string;
  unresolvedRequires?: string[];
}): InstalledAgent {
  return {
    id: opts.id,
    installed_version: '0.1.0',
    installed_at: '2026-04-20T00:00:00Z',
    status: 'errored',
    config: {},
    activation_failure_count: 3,
    last_activation_error: 'simulated',
    last_activation_error_at: opts.errorAtIso ?? '2026-04-29T05:00:00Z',
    ...(opts.unresolvedRequires
      ? { unresolved_requires: opts.unresolvedRequires }
      : {}),
  };
}

function activeAgent(id: string): InstalledAgent {
  return {
    id,
    installed_version: '0.1.0',
    installed_at: '2026-04-20T00:00:00Z',
    status: 'active',
    config: {},
  };
}

describe('retryErroredPlugins — file-mtime path', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), 's85-bootstrap-'));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  async function writeManifest(pkgId: string, mtimeIso: string): Promise<string> {
    const pkgDir = path.join(tmpRoot, pkgId);
    await fs.mkdir(pkgDir, { recursive: true });
    const manifestPath = path.join(pkgDir, 'manifest.yaml');
    await writeFile(manifestPath, 'schema_version: "1"\n', 'utf8');
    const t = new Date(mtimeIso);
    await utimes(manifestPath, t, t);
    return pkgDir;
  }

  it('resets when manifest.yaml mtime is newer than last_activation_error_at', async () => {
    const pkgPath = await writeManifest('p1', '2026-04-29T07:00:00Z');
    const reg = new InMemoryInstalledRegistry();
    await reg.register(
      erroredAgent({ id: 'p1', errorAtIso: '2026-04-29T05:00:00Z' }),
    );
    const cat = makeCatalog([
      { id: 'p1', provides: [], requires: [], depends_on: [] },
    ]);
    const deps: RetryErroredPluginsDeps = {
      catalog: cat,
      registry: reg,
      builtInStore: makeBuiltInStore([{ id: 'p1', path: pkgPath }]),
      log: () => {},
    };

    await retryErroredPlugins(deps);

    const got = reg.get('p1');
    assert.equal(got?.status, 'active');
    assert.equal(got?.last_activation_error, undefined);
    assert.equal(got?.activation_failure_count, undefined);
  });

  it('does NOT reset when manifest.yaml mtime is older than last_activation_error_at', async () => {
    const pkgPath = await writeManifest('p1', '2026-04-29T03:00:00Z');
    const reg = new InMemoryInstalledRegistry();
    await reg.register(
      erroredAgent({ id: 'p1', errorAtIso: '2026-04-29T05:00:00Z' }),
    );
    const cat = makeCatalog([
      { id: 'p1', provides: [], requires: [], depends_on: [] },
    ]);
    const deps: RetryErroredPluginsDeps = {
      catalog: cat,
      registry: reg,
      builtInStore: makeBuiltInStore([{ id: 'p1', path: pkgPath }]),
      log: () => {},
    };

    await retryErroredPlugins(deps);

    assert.equal(reg.get('p1')?.status, 'errored');
  });

  it('handles missing manifest.yaml gracefully (no reset, no throw)', async () => {
    const pkgDir = path.join(tmpRoot, 'p1'); // not created on disk
    const reg = new InMemoryInstalledRegistry();
    await reg.register(erroredAgent({ id: 'p1' }));
    const cat = makeCatalog([
      { id: 'p1', provides: [], requires: [], depends_on: [] },
    ]);

    await retryErroredPlugins({
      catalog: cat,
      registry: reg,
      builtInStore: makeBuiltInStore([{ id: 'p1', path: pkgDir }]),
      log: () => {},
    });

    assert.equal(reg.get('p1')?.status, 'errored');
  });
});

describe('retryErroredPlugins — capability-resolution path', () => {
  it('resets when every unresolved_requires has an active provider', async () => {
    const reg = new InMemoryInstalledRegistry();
    await reg.register(activeAgent('kg-provider'));
    await reg.register(
      erroredAgent({
        id: 'consumer',
        unresolvedRequires: ['knowledgeGraph@^1'],
      }),
    );
    const cat = makeCatalog([
      {
        id: 'kg-provider',
        provides: ['knowledgeGraph@1'],
        requires: [],
        depends_on: [],
      },
      {
        id: 'consumer',
        provides: [],
        requires: ['knowledgeGraph@^1'],
        depends_on: [],
      },
    ]);

    await retryErroredPlugins({
      catalog: cat,
      registry: reg,
      log: () => {},
    });

    assert.equal(reg.get('consumer')?.status, 'active');
    assert.equal(reg.get('consumer')?.unresolved_requires, undefined);
  });

  it('does NOT reset when at least one unresolved_requires lacks an active provider', async () => {
    const reg = new InMemoryInstalledRegistry();
    await reg.register(activeAgent('kg-provider'));
    await reg.register(
      erroredAgent({
        id: 'consumer',
        unresolvedRequires: ['knowledgeGraph@^1', 'embeddings@^1'],
      }),
    );
    const cat = makeCatalog([
      {
        id: 'kg-provider',
        provides: ['knowledgeGraph@1'],
        requires: [],
        depends_on: [],
      },
      // No provider for embeddings@^1.
      {
        id: 'consumer',
        provides: [],
        requires: ['knowledgeGraph@^1', 'embeddings@^1'],
        depends_on: [],
      },
    ]);

    await retryErroredPlugins({
      catalog: cat,
      registry: reg,
      log: () => {},
    });

    assert.equal(reg.get('consumer')?.status, 'errored');
  });

  it('treats inactive (status !== active) providers as unresolved', async () => {
    const reg = new InMemoryInstalledRegistry();
    await reg.register({
      ...activeAgent('kg-provider'),
      status: 'inactive',
    });
    await reg.register(
      erroredAgent({
        id: 'consumer',
        unresolvedRequires: ['knowledgeGraph@^1'],
      }),
    );
    const cat = makeCatalog([
      {
        id: 'kg-provider',
        provides: ['knowledgeGraph@1'],
        requires: [],
        depends_on: [],
      },
      {
        id: 'consumer',
        provides: [],
        requires: ['knowledgeGraph@^1'],
        depends_on: [],
      },
    ]);

    await retryErroredPlugins({
      catalog: cat,
      registry: reg,
      log: () => {},
    });

    assert.equal(reg.get('consumer')?.status, 'errored');
  });
});

describe('retryErroredPlugins — transient-error path', () => {
  function erroredWithMessage(id: string, message: string): InstalledAgent {
    return {
      id,
      installed_version: '0.1.0',
      installed_at: '2026-04-20T00:00:00Z',
      status: 'errored',
      config: {},
      activation_failure_count: 3,
      last_activation_error: message,
      last_activation_error_at: '2026-04-29T05:00:00Z',
    };
  }

  it('resets when last_activation_error is a transient DNS failure (KG provider crash-loop recovery)', async () => {
    const reg = new InMemoryInstalledRegistry();
    await reg.register(
      erroredWithMessage(
        '@omadia/knowledge-graph-neon',
        'getaddrinfo ENOTFOUND postgres',
      ),
    );
    const cat = makeCatalog([
      {
        id: '@omadia/knowledge-graph-neon',
        provides: [],
        requires: [],
        depends_on: [],
      },
    ]);

    await retryErroredPlugins({ catalog: cat, registry: reg, log: () => {} });

    const got = reg.get('@omadia/knowledge-graph-neon');
    assert.equal(got?.status, 'active');
    assert.equal(got?.last_activation_error, undefined);
    assert.equal(got?.activation_failure_count, undefined);
  });

  it('resets on ECONNREFUSED / "Connection terminated" as well', async () => {
    const reg = new InMemoryInstalledRegistry();
    await reg.register(erroredWithMessage('a', 'connect ECONNREFUSED 10.0.0.5:5432'));
    await reg.register(erroredWithMessage('b', 'Connection terminated unexpectedly'));
    const cat = makeCatalog([
      { id: 'a', provides: [], requires: [], depends_on: [] },
      { id: 'b', provides: [], requires: [], depends_on: [] },
    ]);

    await retryErroredPlugins({ catalog: cat, registry: reg, log: () => {} });

    assert.equal(reg.get('a')?.status, 'active');
    assert.equal(reg.get('b')?.status, 'active');
  });

  it('does NOT reset a non-transient (code/config) error', async () => {
    const reg = new InMemoryInstalledRegistry();
    await reg.register(
      erroredWithMessage('p1', 'TypeError: cannot read properties of undefined'),
    );
    const cat = makeCatalog([
      { id: 'p1', provides: [], requires: [], depends_on: [] },
    ]);

    await retryErroredPlugins({ catalog: cat, registry: reg, log: () => {} });

    assert.equal(reg.get('p1')?.status, 'errored');
  });
});

describe('bootstrapMemoryFromEnv — env→config reconcile', () => {
  // The `bootstrap` flow originally wrote `dev_memory_endpoints_enabled`
  // into the @omadia/memory plugin's config exactly once (on first ever
  // boot). Subsequent boots returned early on `registry.has(MEMORY_TOOL_ID)`
  // — so operators who flipped `DEV_ENDPOINTS_ENABLED=true` in `.env`
  // after first boot saw no effect and the local Next-UI's `/api/dev/memory`
  // route stayed dark. This suite pins the reconcile path so the env
  // var stays authoritative on every boot.

  const MEMORY_ID = '@omadia/memory';

  function makeConfig(devEnabled: boolean): Config {
    return {
      DEV_ENDPOINTS_ENABLED: devEnabled,
      MEMORY_DIR: '/test/.memory',
      MEMORY_SEED_DIR: '/test/seed/memory',
      MEMORY_SEED_MODE: 'missing',
    } as unknown as Config;
  }

  const noopVault: SecretVault = {
    setMany: async () => {
      /* no-op */
    },
    getMany: async () => ({}),
    purge: async () => {
      /* no-op */
    },
    list: async () => [],
  } as unknown as SecretVault;

  it('auto-installs with dev_memory_endpoints_enabled=true when env is on (first boot)', async () => {
    const reg = new InMemoryInstalledRegistry();
    const cat = makeCatalog([
      { id: MEMORY_ID, provides: [], requires: [], depends_on: [] },
    ]);

    await bootstrapMemoryFromEnv({
      config: makeConfig(true),
      catalog: cat,
      registry: reg,
      vault: noopVault,
      log: () => {},
    });

    const entry = reg.get(MEMORY_ID);
    assert.ok(entry, 'memory plugin should be auto-installed');
    assert.equal(entry.status, 'active');
    assert.equal(entry.config?.['dev_memory_endpoints_enabled'], 'true');
  });

  it('reconciles dev_memory_endpoints_enabled from false→true on subsequent boots when env flips on', async () => {
    const reg = new InMemoryInstalledRegistry();
    await reg.register({
      id: MEMORY_ID,
      installed_version: '0.1.0',
      installed_at: '2026-04-29T00:00:00Z',
      status: 'active',
      config: {
        memory_dir: '/test/.memory',
        seed_dir: '/test/seed/memory',
        seed_mode: 'missing',
        dev_memory_endpoints_enabled: 'false',
      },
    });
    const cat = makeCatalog([
      { id: MEMORY_ID, provides: [], requires: [], depends_on: [] },
    ]);

    await bootstrapMemoryFromEnv({
      config: makeConfig(true),
      catalog: cat,
      registry: reg,
      vault: noopVault,
      log: () => {},
    });

    assert.equal(
      reg.get(MEMORY_ID)?.config?.['dev_memory_endpoints_enabled'],
      'true',
    );
  });

  it('reconciles dev_memory_endpoints_enabled from true→false on subsequent boots when env flips off', async () => {
    const reg = new InMemoryInstalledRegistry();
    await reg.register({
      id: MEMORY_ID,
      installed_version: '0.1.0',
      installed_at: '2026-04-29T00:00:00Z',
      status: 'active',
      config: {
        memory_dir: '/test/.memory',
        seed_dir: '/test/seed/memory',
        seed_mode: 'missing',
        dev_memory_endpoints_enabled: 'true',
      },
    });
    const cat = makeCatalog([
      { id: MEMORY_ID, provides: [], requires: [], depends_on: [] },
    ]);

    await bootstrapMemoryFromEnv({
      config: makeConfig(false),
      catalog: cat,
      registry: reg,
      vault: noopVault,
      log: () => {},
    });

    assert.equal(
      reg.get(MEMORY_ID)?.config?.['dev_memory_endpoints_enabled'],
      'false',
    );
  });

  it('preserves operator-owned config keys (memory_dir, seed_dir, seed_mode) during reconcile', async () => {
    // The reconcile path may NOT clobber non-env-derived config. Only
    // `dev_memory_endpoints_enabled` is the env-driven flag; other
    // values are operator-managed after first boot.
    const reg = new InMemoryInstalledRegistry();
    await reg.register({
      id: MEMORY_ID,
      installed_version: '0.1.0',
      installed_at: '2026-04-29T00:00:00Z',
      status: 'active',
      config: {
        memory_dir: '/operator/picked/.memory',
        seed_dir: '/operator/picked/seed',
        seed_mode: 'always',
        dev_memory_endpoints_enabled: 'false',
      },
    });
    const cat = makeCatalog([
      { id: MEMORY_ID, provides: [], requires: [], depends_on: [] },
    ]);

    await bootstrapMemoryFromEnv({
      config: makeConfig(true),
      catalog: cat,
      registry: reg,
      vault: noopVault,
      log: () => {},
    });

    const entry = reg.get(MEMORY_ID);
    assert.equal(entry?.config?.['memory_dir'], '/operator/picked/.memory');
    assert.equal(entry?.config?.['seed_dir'], '/operator/picked/seed');
    assert.equal(entry?.config?.['seed_mode'], 'always');
    assert.equal(entry?.config?.['dev_memory_endpoints_enabled'], 'true');
  });

  it('is a no-op when dev_memory_endpoints_enabled already matches env', async () => {
    // Idempotency: a boot that finds the config already in the desired
    // state must not rewrite the entry. We assert by snapshotting the
    // installed_at field — a register-with-same-value would survive but
    // log noise / activity should not change.
    const reg = new InMemoryInstalledRegistry();
    const installedAt = '2026-04-29T00:00:00Z';
    await reg.register({
      id: MEMORY_ID,
      installed_version: '0.1.0',
      installed_at: installedAt,
      status: 'active',
      config: {
        memory_dir: '/test/.memory',
        seed_dir: '/test/seed/memory',
        seed_mode: 'missing',
        dev_memory_endpoints_enabled: 'true',
      },
    });
    const cat = makeCatalog([
      { id: MEMORY_ID, provides: [], requires: [], depends_on: [] },
    ]);

    const logs: string[] = [];
    await bootstrapMemoryFromEnv({
      config: makeConfig(true),
      catalog: cat,
      registry: reg,
      vault: noopVault,
      log: (m) => logs.push(m),
    });

    assert.equal(reg.get(MEMORY_ID)?.installed_at, installedAt);
    assert.equal(
      logs.some((l) => l.includes('reconciled')),
      false,
      'no reconcile log line should be emitted when nothing changed',
    );
  });
});

describe('retryErroredPlugins — guards', () => {
  it('does not touch entries with status !== errored', async () => {
    const reg = new InMemoryInstalledRegistry();
    await reg.register(activeAgent('a'));
    await reg.register({ ...activeAgent('b'), status: 'inactive' });
    const cat = makeCatalog([
      { id: 'a', provides: [], requires: [], depends_on: [] },
      { id: 'b', provides: [], requires: [], depends_on: [] },
    ]);

    await retryErroredPlugins({ catalog: cat, registry: reg, log: () => {} });

    assert.equal(reg.get('a')?.status, 'active');
    assert.equal(reg.get('b')?.status, 'inactive');
  });

  it('leaves errored entries untouched when neither file-mtime nor cap-resolution apply', async () => {
    const reg = new InMemoryInstalledRegistry();
    await reg.register(erroredAgent({ id: 'p1' })); // no unresolved_requires, no package path
    const cat = makeCatalog([
      { id: 'p1', provides: [], requires: [], depends_on: [] },
    ]);

    await retryErroredPlugins({ catalog: cat, registry: reg, log: () => {} });

    assert.equal(reg.get('p1')?.status, 'errored');
  });
});

describe('memoryStore provider selection', () => {
  const MEMORY_ID = '@omadia/memory';
  const MEMORY_PG_ID = '@omadia/memory-postgres';

  const stubVault = {
    get: async () => undefined,
    set: async () => {},
    has: async () => false,
    purge: async () => {},
    list: async () => [],
  } as unknown as SecretVault;

  function memCfg(opts: {
    backend?: 'filesystem' | 'postgres';
    databaseUrl?: string;
  }): Config {
    return {
      DEV_ENDPOINTS_ENABLED: false,
      MEMORY_BACKEND: opts.backend ?? 'filesystem',
      MEMORY_DIR: '/test/.memory',
      MEMORY_SEED_DIR: '/test/seed/memory',
      MEMORY_SEED_MODE: 'missing',
      ...(opts.databaseUrl ? { DATABASE_URL: opts.databaseUrl } : {}),
    } as unknown as Config;
  }

  const memCatalog = makeCatalog([
    {
      id: MEMORY_ID,
      kind: 'extension',
      provides: ['memoryStore@1'],
      requires: [],
      depends_on: [],
    },
    {
      id: MEMORY_PG_ID,
      kind: 'extension',
      provides: ['memoryStore@1'],
      requires: ['graphPool@^1'],
      depends_on: [],
    },
  ]);

  function memDeps(reg: InMemoryInstalledRegistry, cfg: Config) {
    return {
      config: cfg,
      vault: stubVault,
      registry: reg,
      catalog: memCatalog,
      log: () => {},
    };
  }

  async function seedActive(
    reg: InMemoryInstalledRegistry,
    id: string,
    config: Record<string, unknown> = {},
  ) {
    await reg.register({
      id,
      installed_version: '0.1.0',
      installed_at: '2026-04-29T00:00:00Z',
      status: 'active',
      config,
    });
  }

  it('filesystem (default) installs @omadia/memory, not the Postgres provider', async () => {
    const reg = new InMemoryInstalledRegistry();
    await bootstrapMemoryFromEnv(memDeps(reg, memCfg({})));
    assert.equal(reg.get(MEMORY_ID)?.status, 'active');
    assert.equal(reg.get(MEMORY_PG_ID), undefined);
  });

  it('postgres + DATABASE_URL installs memory-postgres and removes the filesystem provider', async () => {
    const reg = new InMemoryInstalledRegistry();
    await seedActive(reg, MEMORY_ID);
    await bootstrapMemoryFromEnv(
      memDeps(reg, memCfg({ backend: 'postgres', databaseUrl: 'postgres://x' })),
    );
    assert.equal(reg.get(MEMORY_PG_ID)?.status, 'active');
    assert.equal(
      reg.get(MEMORY_ID),
      undefined,
      'filesystem provider removed (memoryStore@1 mutual exclusion)',
    );
  });

  it('postgres WITHOUT DATABASE_URL falls back to filesystem', async () => {
    const reg = new InMemoryInstalledRegistry();
    await bootstrapMemoryFromEnv(memDeps(reg, memCfg({ backend: 'postgres' })));
    assert.equal(reg.get(MEMORY_ID)?.status, 'active', 'fell back to filesystem');
    assert.equal(reg.get(MEMORY_PG_ID), undefined);
  });

  it('a persisted both-active state self-heals to the selected backend', async () => {
    const reg = new InMemoryInstalledRegistry();
    await seedActive(reg, MEMORY_ID);
    await seedActive(reg, MEMORY_PG_ID);
    await bootstrapMemoryFromEnv(memDeps(reg, memCfg({}))); // filesystem default
    assert.equal(reg.get(MEMORY_ID)?.status, 'active');
    assert.equal(
      reg.get(MEMORY_PG_ID),
      undefined,
      'non-selected provider removed',
    );
  });

  it('persisted memory_backend=postgres (UI choice) overrides the filesystem env default', async () => {
    const reg = new InMemoryInstalledRegistry();
    // Operator switched to postgres via UI — choice persisted on the entry.
    await seedActive(reg, MEMORY_PG_ID, { memory_backend: 'postgres' });
    await bootstrapMemoryFromEnv(
      memDeps(reg, memCfg({ backend: 'filesystem', databaseUrl: 'postgres://x' })),
    );
    assert.equal(
      reg.get(MEMORY_PG_ID)?.status,
      'active',
      'UI choice honoured over env default',
    );
    assert.equal(reg.get(MEMORY_ID), undefined);
  });

  it('catch-all never auto-installs the opt-in memory-postgres', async () => {
    const reg = new InMemoryInstalledRegistry();
    await seedActive(reg, MEMORY_ID);
    await bootstrapBuiltInPackages({
      config: memCfg({}),
      vault: stubVault,
      registry: reg,
      catalog: memCatalog,
      builtInStore: makeBuiltInStore([
        { id: MEMORY_ID, path: '/x/memory' },
        { id: MEMORY_PG_ID, path: '/x/memory-postgres' },
      ]) as unknown as Parameters<
        typeof bootstrapBuiltInPackages
      >[0]['builtInStore'],
      log: () => {},
    });
    assert.equal(
      reg.get(MEMORY_PG_ID),
      undefined,
      'memory-postgres stays opt-in',
    );
  });
});
