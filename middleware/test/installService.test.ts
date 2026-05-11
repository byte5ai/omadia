import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { Plugin } from '../src/api/admin-v1.js';
import type {
  InstalledAgent,
  InstalledRegistry,
} from '../src/plugins/installedRegistry.js';
import {
  InstallError,
  InstallService,
} from '../src/plugins/installService.js';
import type { PluginCatalog } from '../src/plugins/manifestLoader.js';
import type { SecretVault } from '../src/secrets/vault.js';

/**
 * S+8.5 Sub-Commit 1 — install-time capability gate.
 *
 * The interesting surface is `InstallService.create()`'s requires-check:
 * given a target plugin whose `requires:` chain isn't fully covered by
 * active installed providers, the service must throw a 409
 * `install.missing_capability` with `details.available_providers` (a
 * topo-ordered chain that the wizard can render directly).
 *
 * Pre-S+8.5 the check did not exist — boot-time `resolveCapabilities`
 * threw at activation. We now block at install-time, in addition to the
 * runtime soft-fail.
 */

type Partial_Plugin = Pick<
  Plugin,
  'id' | 'provides' | 'requires' | 'depends_on'
> & {
  kind?: Plugin['kind'];
  name?: string;
};

function makePlugin(p: Partial_Plugin): Plugin {
  return {
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
  };
}

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
      plugin: makePlugin(p),
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

function makeRegistry(active: InstalledAgent[] = []): InstalledRegistry {
  const map = new Map<string, InstalledAgent>();
  for (const a of active) map.set(a.id, a);
  return {
    list: () => Array.from(map.values()),
    get: (id) => map.get(id),
    has: (id) => map.has(id),
    register: async (entry) => {
      map.set(entry.id, entry);
    },
    remove: async (id) => {
      map.delete(id);
    },
    markActivationFailed: async () => {
      /* no-op */
    },
    markActivationSucceeded: async () => {
      /* no-op */
    },
    updateConfig: async () => {
      /* no-op */
    },
    updateVersion: async () => {
      /* no-op */
    },
  };
}

function makeActive(id: string): InstalledAgent {
  return {
    id,
    installed_version: '0.1.0',
    installed_at: '2026-04-29T00:00:00Z',
    status: 'active',
    config: {},
  };
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

describe('InstallService.create — capability gate', () => {
  it('allows install when target has no requires', () => {
    const cat = makeCatalog([
      { id: 'standalone', provides: [], requires: [], depends_on: [] },
    ]);
    const service = new InstallService({
      catalog: cat,
      registry: makeRegistry(),
      vault: noopVault,
    });
    const job = service.create('standalone');
    assert.equal(job.plugin_id, 'standalone');
    assert.equal(job.state, 'awaiting_config');
  });

  it('allows install when every requires is covered by an active provider', () => {
    const cat = makeCatalog([
      { id: 'kg', provides: ['knowledgeGraph@1'], requires: [], depends_on: [] },
      {
        id: 'consumer',
        provides: [],
        requires: ['knowledgeGraph@^1'],
        depends_on: [],
      },
    ]);
    const service = new InstallService({
      catalog: cat,
      registry: makeRegistry([makeActive('kg')]),
      vault: noopVault,
    });
    const job = service.create('consumer');
    assert.equal(job.plugin_id, 'consumer');
    assert.equal(job.state, 'awaiting_config');
  });

  it('blocks install with 409 install.missing_capability when a requires has no active provider', () => {
    const cat = makeCatalog([
      { id: 'kg', provides: ['knowledgeGraph@1'], requires: [], depends_on: [] },
      {
        id: 'consumer',
        provides: [],
        requires: ['knowledgeGraph@^1'],
        depends_on: [],
      },
    ]);
    // KG plugin exists in catalog but is NOT installed → consumer install
    // must fail with the chain pointing operator at the missing provider.
    const service = new InstallService({
      catalog: cat,
      registry: makeRegistry(),
      vault: noopVault,
    });

    let caught: InstallError | undefined;
    try {
      service.create('consumer');
    } catch (err) {
      assert.ok(err instanceof InstallError);
      caught = err;
    }
    assert.ok(caught, 'expected InstallError to be thrown');
    assert.equal(caught.code, 'install.missing_capability');
    assert.equal(caught.status, 409);
    const details = caught.details as
      | {
          unresolved_requires: string[];
          available_providers: Array<{
            capability: string;
            providers: Array<{ id: string }>;
          }>;
        }
      | undefined;
    assert.ok(details, 'expected details payload');
    assert.deepEqual(details.unresolved_requires, ['knowledgeGraph@^1']);
    assert.equal(details.available_providers.length, 1);
    assert.deepEqual(
      details.available_providers[0]?.providers.map((p) => p.id),
      ['kg'],
    );
  });

  it('surfaces transitive pre-requisites in details (server-side, no client recursion needed)', () => {
    // confluence → kg-neon → embeddings
    const cat = makeCatalog([
      {
        id: 'embeddings',
        provides: ['embeddingClient@1'],
        requires: [],
        depends_on: [],
      },
      {
        id: 'kg-neon',
        provides: ['knowledgeGraph@1'],
        requires: ['embeddingClient@^1'],
        depends_on: [],
      },
      {
        id: 'confluence',
        provides: [],
        requires: ['knowledgeGraph@^1'],
        depends_on: [],
      },
    ]);
    const service = new InstallService({
      catalog: cat,
      registry: makeRegistry(),
      vault: noopVault,
    });

    let caught: InstallError | undefined;
    try {
      service.create('confluence');
    } catch (err) {
      caught = err as InstallError;
    }
    assert.ok(caught instanceof InstallError);
    const details = caught.details as
      | { unresolved_requires: string[] }
      | undefined;
    assert.ok(details);
    // Deepest first — embeddings must be installed before kg-neon, kg-neon
    // before confluence. Frontend wizard installs in the order returned.
    assert.deepEqual(details.unresolved_requires, [
      'embeddingClient@^1',
      'knowledgeGraph@^1',
    ]);
  });

  it('returns empty providers list when the catalog has no candidate at all', () => {
    const cat = makeCatalog([
      {
        id: 'orphan',
        provides: [],
        requires: ['neverProvided@^1'],
        depends_on: [],
      },
    ]);
    const service = new InstallService({
      catalog: cat,
      registry: makeRegistry(),
      vault: noopVault,
    });
    let caught: InstallError | undefined;
    try {
      service.create('orphan');
    } catch (err) {
      caught = err as InstallError;
    }
    assert.ok(caught instanceof InstallError);
    const details = caught.details as
      | {
          available_providers: Array<{
            capability: string;
            providers: unknown[];
          }>;
        }
      | undefined;
    assert.equal(details?.available_providers[0]?.providers.length, 0);
  });

  it('still rejects an unknown plugin id with store.plugin_not_found', () => {
    const cat = makeCatalog([
      { id: 'a', provides: [], requires: [], depends_on: [] },
    ]);
    const service = new InstallService({
      catalog: cat,
      registry: makeRegistry(),
      vault: noopVault,
    });
    assert.throws(
      () => service.create('does-not-exist'),
      (err: Error) => {
        assert.ok(err instanceof InstallError);
        assert.equal(err.code, 'store.plugin_not_found');
        assert.equal(err.status, 404);
        return true;
      },
    );
  });

  it('still rejects an already-installed plugin', () => {
    const cat = makeCatalog([
      { id: 'a', provides: [], requires: [], depends_on: [] },
    ]);
    const service = new InstallService({
      catalog: cat,
      registry: makeRegistry([makeActive('a')]),
      vault: noopVault,
    });
    assert.throws(
      () => service.create('a'),
      (err: Error) => {
        assert.ok(err instanceof InstallError);
        assert.equal(err.code, 'install.already_installed');
        assert.equal(err.status, 409);
        return true;
      },
    );
  });
});

describe('InstallError.details', () => {
  it('exposes details as a public, optional field', () => {
    const err = new InstallError('x', 'msg', 409, { a: 1 });
    assert.deepEqual(err.details, { a: 1 });
  });

  it('leaves details undefined when not provided (backward compat)', () => {
    const err = new InstallError('x', 'msg', 409);
    assert.equal(err.details, undefined);
  });
});
