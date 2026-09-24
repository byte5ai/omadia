/**
 * #1089 — who installed it, not what it is.
 *
 * The onboarding surfaces ("Erste Schritte" step 3, the store's profile
 * modal) need to distinguish a plugin the operator installed from one the
 * kernel auto-installed at boot. The registry could not answer that: it
 * records id/version/timestamps/status/config and nothing about the writer,
 * so 16 bootstrap entries read exactly like 16 operator installs.
 *
 * The catalog's `origin: 'bundled' | 'installed'` (#794) is NOT that answer —
 * it says whether a package ships inside the image. Bundled packages that the
 * operator installs by hand exist on purpose (the KG providers and the
 * memoryStore alternatives are skipped by `bootstrapBuiltInPackages` exactly
 * so the operator owns that choice), so a catalog-origin rule would leave
 * step 3 open forever for those operators. Hence a field on the registry
 * entry, written where the write happens.
 *
 * Back-compat is the interesting half: registry files predate the field, and
 * those entries are deliberately NOT backfilled. The only evidence left after
 * the fact is whether the image ships the package, which is wrong for exactly
 * the entries that prove an operator did something — the KG providers and the
 * memoryStore alternatives ship in the image and are skipped by the boot
 * auto-install so the operator installs them by hand. An absent origin
 * therefore means "not attributable", and the web-ui falls back to counting
 * every installed plugin, i.e. the pre-#1089 behaviour.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import path from 'node:path';
import { describe, it, before, after } from 'node:test';
import express from 'express';
import ts from 'typescript';

import {
  bootstrapBuiltInPackages,
  bootstrapEmbeddingsFromEnv,
  bootstrapKnowledgeGraphFromEnv,
  bootstrapMemoryFromEnv,
} from '../src/plugins/bootstrap.js';
import type { Config } from '../src/config.js';
import {
  InMemoryInstalledRegistry,
  type InstalledAgent,
} from '../src/plugins/installedRegistry.js';
import type { PluginCatalog } from '../src/plugins/manifestLoader.js';
import type { Plugin } from '../src/api/admin-v1.js';
import type { SecretVault } from '../src/secrets/vault.js';
import { InstallService } from '../src/plugins/installService.js';
import { createStoreRouter } from '../src/routes/store.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

function plugin(id: string, over: Partial<Plugin> = {}): Plugin {
  return {
    id,
    kind: 'tool',
    name: id,
    version: '1.0.0',
    latest_version: '1.0.0',
    description: '',
    authors: [],
    license: 'MIT',
    icon_url: null,
    categories: [],
    domain: 'x.y',
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
    depends_on: [],
    jobs: [],
    provides: [],
    requires: [],
    multi_instance: true,
    privacy_class: 'default',
    ...over,
  };
}

/** Catalog fake that answers `isBundledId` — whether the image ships an id,
 *  which is NOT who installed it (see `InstalledAgent.origin`). */
function fakeCatalog(plugins: Plugin[], bundledIds: string[] = []): PluginCatalog {
  const bundled = new Set(bundledIds);
  return {
    list: () =>
      plugins.map((p) => ({
        plugin: p,
        manifest: {},
        source_path: `<test>/${p.id}.yaml`,
        source_kind: 'manifest-v1',
        origin: bundled.has(p.id) ? 'bundled' : 'installed',
      })),
    get: (id: string) => {
      const p = plugins.find((x) => x.id === id);
      return p
        ? {
            plugin: p,
            manifest: {},
            source_path: `<test>/${p.id}.yaml`,
            source_kind: 'manifest-v1',
            origin: bundled.has(p.id) ? 'bundled' : 'installed',
          }
        : undefined;
    },
    isBundledId: (id: string) => bundled.has(id),
  } as unknown as PluginCatalog;
}

function entry(id: string, over: Partial<InstalledAgent> = {}): InstalledAgent {
  return {
    id,
    installed_version: '1.0.0',
    installed_at: '2026-04-20T00:00:00Z',
    status: 'active',
    config: {},
    ...over,
  };
}

const noopVault = {
  setMany: async () => {},
  getMany: async () => ({}),
  purge: async () => {},
  list: async () => [],
} as unknown as SecretVault;

// ---------------------------------------------------------------------------
// bootstrap writes
// ---------------------------------------------------------------------------

describe('#1089 · bootstrapBuiltInPackages stamps bundled', () => {
  void it('records origin bundled for every auto-installed built-in', async () => {
    const registry = new InMemoryInstalledRegistry();
    const builtInStore = {
      get: (id: string) =>
        id === '@om/auto'
          ? { id: '@om/auto', version: '1.0.0', path: '/tmp/auto' }
          : undefined,
      list: () => [{ id: '@om/auto', version: '1.0.0', path: '/tmp/auto' }],
    } as unknown as Parameters<
      typeof bootstrapBuiltInPackages
    >[0]['builtInStore'];

    await bootstrapBuiltInPackages({
      config: {} as unknown as Config,
      catalog: fakeCatalog([plugin('@om/auto')], ['@om/auto']),
      registry,
      vault: noopVault,
      builtInStore,
      log: () => {},
    });

    assert.equal(registry.get('@om/auto')?.origin, 'bundled');
  });
});

describe('#1089 · the env-driven bootstraps stamp bundled', () => {
  // Six of the sixteen boot entries on a default Compose deploy come from the
  // env-driven installers, not from bootstrapBuiltInPackages. `origin` is
  // optional, so typecheck cannot catch a dropped stamp, and a missing origin
  // counts as an operator install — the #1089 bug, back with CI green.
  const vault = {
    ...noopVault,
    get: async () => undefined,
  } as unknown as SecretVault;

  void it('memory: the DATABASE_URL-selected memoryStore provider', async () => {
    const registry = new InMemoryInstalledRegistry();
    await bootstrapMemoryFromEnv({
      config: {
        DATABASE_URL: 'postgres://x',
        MEMORY_SEED_DIR: '/seed',
        MEMORY_SEED_MODE: 'missing',
      } as unknown as Config,
      catalog: fakeCatalog([plugin('@omadia/memory-postgres')]),
      registry,
      vault,
      log: () => {},
    });
    assert.equal(registry.get('@omadia/memory-postgres')?.origin, 'bundled');
  });

  void it('embeddings: the Ollama adapter', async () => {
    const registry = new InMemoryInstalledRegistry();
    await bootstrapEmbeddingsFromEnv({
      config: { OLLAMA_BASE_URL: 'http://ollama:11434' } as unknown as Config,
      catalog: fakeCatalog([plugin('@omadia/embeddings')]),
      registry,
      vault,
      log: () => {},
    });
    assert.equal(registry.get('@omadia/embeddings')?.origin, 'bundled');
  });

  void it('knowledge graph: the DATABASE_URL-selected provider', async () => {
    const registry = new InMemoryInstalledRegistry();
    await bootstrapKnowledgeGraphFromEnv({
      config: {
        DATABASE_URL: 'postgres://x',
        GRAPH_TENANT_ID: 'default',
      } as unknown as Config,
      catalog: fakeCatalog([plugin('@omadia/knowledge-graph-neon')]),
      registry,
      vault,
      log: () => {},
    });
    assert.equal(
      registry.get('@omadia/knowledge-graph-neon')?.origin,
      'bundled',
    );
  });
});

describe('#1089 · every fresh bootstrap write is stamped (source guard)', () => {
  // The runtime tests above reach only the exported installers. The other
  // boot writes (orchestrator, orchestrator-extras, verifier, diagrams,
  // office, Microsoft 365, Telegram, the two auto-install-dependent helpers)
  // sit behind env and filesystem preconditions, so this reads bootstrap.ts
  // itself: a `registry.register({ … })` that does not start with a spread
  // creates a new entry and must say `origin: 'bundled'`; one that spreads an
  // existing entry must leave the origin it carries alone.
  const FRESH_WRITE_SITES = 13;

  void it("stamps origin 'bundled' on every fresh registry write", async () => {
    const file = path.resolve(
      import.meta.dirname,
      '../src/plugins/bootstrap.ts',
    );
    const source = ts.createSourceFile(
      file,
      await readFile(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const fresh: string[] = [];
    const unstamped: string[] = [];
    const overridden: string[] = [];

    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'register' &&
        /registry$/.test(node.expression.expression.getText(source))
      ) {
        const at = `bootstrap.ts:${String(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1)}`;
        const arg = node.arguments[0];
        if (!arg || !ts.isObjectLiteralExpression(arg)) {
          unstamped.push(`${at} (argument is not an object literal)`);
        } else {
          const origin = arg.properties.find(
            (p) => ts.isPropertyAssignment(p) && p.name.getText(source) === 'origin',
          );
          const first = arg.properties[0];
          if (first && ts.isSpreadAssignment(first)) {
            if (origin) overridden.push(at);
          } else {
            fresh.push(at);
            const stamped =
              origin !== undefined &&
              ts.isPropertyAssignment(origin) &&
              ts.isStringLiteral(origin.initializer) &&
              origin.initializer.text === 'bundled';
            if (!stamped) unstamped.push(at);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);

    assert.deepEqual(unstamped, [], "fresh boot writes without origin: 'bundled'");
    assert.deepEqual(overridden, [], 'spread writes that overwrite the origin');
    assert.equal(
      fresh.length,
      FRESH_WRITE_SITES,
      `fresh write sites changed (${fresh.join(', ')}) — stamp the new one and update FRESH_WRITE_SITES`,
    );
  });
});

// ---------------------------------------------------------------------------
// operator writes
// ---------------------------------------------------------------------------

describe('#1089 · InstallService stamps operator', () => {
  void it('records origin operator for a hub/ZIP install', async () => {
    const registry = new InMemoryInstalledRegistry();
    const service = new InstallService({
      catalog: fakeCatalog([plugin('@om/hub-install')]),
      registry,
      vault: noopVault,
    } as unknown as ConstructorParameters<typeof InstallService>[0]);

    const job = service.create('@om/hub-install');
    await service.configure(job.id, {});

    assert.equal(registry.get('@om/hub-install')?.status, 'active');
    assert.equal(registry.get('@om/hub-install')?.origin, 'operator');
  });

  void it('stamps operator even for an id the image ships', async () => {
    // The operator uninstalled a built-in and installed it again by hand. The
    // catalog still calls the id bundled; the write does not.
    const registry = new InMemoryInstalledRegistry();
    const service = new InstallService({
      catalog: fakeCatalog([plugin('@om/bundled-id')], ['@om/bundled-id']),
      registry,
      vault: noopVault,
    } as unknown as ConstructorParameters<typeof InstallService>[0]);

    const job = service.create('@om/bundled-id');
    await service.configure(job.id, {});

    assert.equal(registry.get('@om/bundled-id')?.origin, 'operator');
  });
});

// ---------------------------------------------------------------------------
// store DTO
// ---------------------------------------------------------------------------

describe('#1089 · store router projects install_origin', () => {
  let server: Server;
  let base: string;
  const registry = new InMemoryInstalledRegistry();

  before(async () => {
    await registry.register(entry('@om/bundled', { origin: 'bundled' }));
    await registry.register(entry('@om/operator', { origin: 'operator' }));
    await registry.register(entry('@om/legacy'));
    const app = express();
    app.use(
      '/v1/store/plugins',
      createStoreRouter({
        catalog: fakeCatalog([
          plugin('@om/bundled'),
          plugin('@om/operator'),
          plugin('@om/legacy'),
          plugin('@om/uninstalled'),
        ]),
        registry,
      } as unknown as Parameters<typeof createStoreRouter>[0]),
    );
    server = await listenLoopback(app);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    server.close();
  });

  void it('carries the registry origin and leaves install_state alone', async () => {
    const res = await fetch(`${base}/v1/store/plugins`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { items: Plugin[] };
    const byId = new Map(body.items.map((p) => [p.id, p]));

    assert.equal(byId.get('@om/bundled')?.install_origin, 'bundled');
    assert.equal(byId.get('@om/operator')?.install_origin, 'operator');
    assert.equal(byId.get('@om/bundled')?.install_state, 'installed');
    assert.equal(byId.get('@om/operator')?.install_state, 'installed');
  });

  void it('omits install_origin for an entry written before the field', async () => {
    // Absent ≠ 'bundled'. The web-ui reads absence as "this middleware cannot
    // tell me", and falls back to counting every installed plugin.
    const res = await fetch(`${base}/v1/store/plugins`);
    const body = (await res.json()) as { items: Plugin[] };
    const legacy = body.items.find((p) => p.id === '@om/legacy');
    assert.equal(legacy?.install_state, 'installed');
    assert.equal(legacy?.install_origin, undefined);
  });

  void it('omits install_origin for a plugin that is not installed', async () => {
    const res = await fetch(`${base}/v1/store/plugins`);
    const body = (await res.json()) as { items: Plugin[] };
    const free = body.items.find((p) => p.id === '@om/uninstalled');
    assert.equal(free?.install_state, 'available');
    assert.equal(free?.install_origin, undefined);
  });
});
