import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  retryErroredPlugins,
  type RetryErroredPluginsDeps,
} from '../src/plugins/bootstrap.js';
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
        required_secrets: [],
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
