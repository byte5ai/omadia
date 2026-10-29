import { strict as assert } from 'node:assert';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import { attachNewPluginsToFallbackAgent } from '@omadia/orchestrator';

import type { Config } from '../src/config.js';
import {
  reconcileBuiltInVersions,
  runLegacyBootstrap,
} from '../src/plugins/bootstrap.js';
import {
  FileBuiltInOptOutStore,
  InMemoryBuiltInOptOutStore,
} from '../src/plugins/builtInOptOuts.js';
import { BuiltInPackageStore } from '../src/plugins/builtInPackageStore.js';
import {
  attachablePluginIds,
  createPendingDefaultAttach,
  withInstalledParents,
} from '../src/plugins/defaultOrchestratorAttach.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import { InstallService } from '../src/plugins/installService.js';
import { PluginCatalog } from '../src/plugins/manifestLoader.js';
import { listProfiles } from '../src/plugins/profileLoader.js';
import { InMemorySecretVault } from '../src/secrets/vault.js';

/**
 * Sweep 2 / N05 — how built-in plugins are installed, versioned and attached:
 * #1505 (version reconcile), #1481 (uninstall sticks), #1498 / #1491 (attach
 * to the default orchestrator), #1499 (bundled manifest rule), #1484 (shipped
 * profiles).
 */

const MIDDLEWARE_ROOT = resolve(new URL(import.meta.url).pathname, '..', '..');

function writeManifest(
  packageRoot: string,
  id: string,
  version: string,
  extra: string[] = [],
): void {
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, 'manifest.yaml'),
    [
      'schema_version: "1"',
      'identity:',
      `  id: "${id}"`,
      `  name: "${id}"`,
      `  version: ${version}`,
      '  kind: tool',
      'lifecycle:',
      '  entry: dist/plugin.js',
      ...extra,
      '',
    ].join('\n'),
  );
}

async function builtIns(
  dir: string,
  origin: 'bundled' | 'installed' = 'bundled',
): Promise<{ store: BuiltInPackageStore; catalog: PluginCatalog }> {
  const store = new BuiltInPackageStore(dir);
  await store.load();
  const catalog = new PluginCatalog({
    manifestDir: '/nonexistent',
    extraSources: () => store.list().map((p) => ({ packageRoot: p.path, origin })),
  });
  await catalog.load();
  return { store, catalog };
}

function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'builtin-lifecycle-'));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe('#1505 — built-in installed_version follows the image', () => {
  it('bumps a stale built-in to the shipped version and keeps its config', async () => {
    await withTmpDir(async (dir) => {
      writeManifest(join(dir, 'quality'), '@test/quality', '0.2.0');
      const { store, catalog } = await builtIns(dir);
      const registry = new InMemoryInstalledRegistry();
      await registry.register({
        id: '@test/quality',
        installed_version: '0.1.0',
        installed_at: '2026-01-01T00:00:00.000Z',
        status: 'active',
        origin: 'bundled',
        config: { threshold: 3 },
      });
      const lines: string[] = [];

      await runLegacyBootstrap({
        config: {} as Config,
        catalog,
        registry,
        vault: new InMemorySecretVault(),
        builtInStore: store,
        log: (m) => lines.push(m),
      });

      const entry = registry.get('@test/quality');
      assert.equal(entry?.installed_version, '0.2.0');
      assert.deepEqual(entry?.config, { threshold: 3 });
      assert.equal(entry?.installed_at, '2026-01-01T00:00:00.000Z');
      assert.ok(lines.some((l) => l.includes('installed_version 0.1.0 → 0.2.0')));
      assert.ok(lines.some((l) => l.includes('built-in version reconcile: 1 updated')));
    });
  });

  it('a failing version write is logged and does not abort the reconcile', async () => {
    await withTmpDir(async (dir) => {
      writeManifest(join(dir, 'a'), '@test/a', '2.0.0');
      writeManifest(join(dir, 'b'), '@test/b', '2.0.0');
      const { catalog } = await builtIns(dir);
      const registry = new InMemoryInstalledRegistry();
      for (const id of ['@test/a', '@test/b']) {
        await registry.register({
          id,
          installed_version: '1.0.0',
          installed_at: new Date().toISOString(),
          status: 'active',
          config: {},
        });
      }
      const real = registry.updateVersion.bind(registry);
      registry.updateVersion = async (id, v, c) => {
        if (id === '@test/a') throw new Error('disk full');
        await real(id, v, c);
      };
      const lines: string[] = [];

      await reconcileBuiltInVersions({ catalog, registry, log: (m) => lines.push(m) });

      assert.equal(registry.get('@test/b')?.installed_version, '2.0.0');
      assert.ok(lines.some((l) => l.includes('reconcile FAILED for @test/a: disk full')));
    });
  });

  it('leaves a package that does not ship in the image alone', async () => {
    await withTmpDir(async (dir) => {
      writeManifest(join(dir, 'uploaded'), '@test/uploaded', '2.0.0');
      const { catalog } = await builtIns(dir, 'installed');
      const registry = new InMemoryInstalledRegistry();
      await registry.register({
        id: '@test/uploaded',
        installed_version: '1.0.0',
        installed_at: new Date().toISOString(),
        status: 'active',
        config: {},
      });

      await reconcileBuiltInVersions({ catalog, registry, log: () => {} });

      assert.equal(registry.get('@test/uploaded')?.installed_version, '1.0.0');
    });
  });
});

describe('#1481 — an uninstalled built-in stays uninstalled', () => {
  it('the seeder skips an opted-out built-in and reports only new ids', async () => {
    await withTmpDir(async (dir) => {
      writeManifest(join(dir, 'kept'), '@test/kept', '1.0.0');
      writeManifest(join(dir, 'gone'), '@test/gone', '1.0.0');
      writeManifest(join(dir, 'fresh'), '@test/fresh', '1.0.0');
      const { store, catalog } = await builtIns(dir);
      const registry = new InMemoryInstalledRegistry();
      await registry.register({
        id: '@test/kept',
        installed_version: '1.0.0',
        installed_at: new Date().toISOString(),
        status: 'active',
        config: {},
      });
      const optOuts = new InMemoryBuiltInOptOutStore(['@test/gone']);
      const installed: string[] = [];
      const lines: string[] = [];

      await runLegacyBootstrap({
        config: {} as Config,
        catalog,
        registry,
        vault: new InMemorySecretVault(),
        builtInStore: store,
        builtInOptOuts: optOuts,
        onPluginInstalled: (id) => installed.push(id),
        log: (m) => lines.push(m),
      });

      assert.equal(registry.has('@test/gone'), false);
      assert.ok(optOuts.has('@test/gone'));
      assert.ok(lines.some((l) => l.includes('@test/gone skipped — the operator uninstalled it')));
      // #1498 — exactly the ids this boot added; the existing entry is not
      // re-reported (its attachment is the operator's business).
      assert.deepEqual(installed, ['@test/fresh']);
    });
  });

  it('drops the mark of a built-in that is installed again', async () => {
    await withTmpDir(async (dir) => {
      writeManifest(join(dir, 'back'), '@test/back', '1.0.0');
      const { store, catalog } = await builtIns(dir);
      const registry = new InMemoryInstalledRegistry();
      await registry.register({
        id: '@test/back',
        installed_version: '1.0.0',
        installed_at: new Date().toISOString(),
        status: 'active',
        config: {},
      });
      const optOuts = new InMemoryBuiltInOptOutStore(['@test/back']);

      await runLegacyBootstrap({
        config: {} as Config,
        catalog,
        registry,
        vault: new InMemorySecretVault(),
        builtInStore: store,
        builtInOptOuts: optOuts,
        log: () => {},
      });

      assert.equal(optOuts.has('@test/back'), false);
    });
  });

  it('uninstall records a bundled package, not an uploaded one', async () => {
    await withTmpDir(async (dir) => {
      writeManifest(join(dir, 'bundled'), '@test/bundled', '1.0.0');
      const { catalog } = await builtIns(dir);
      const registry = new InMemoryInstalledRegistry();
      for (const id of ['@test/bundled', '@test/not-in-catalog']) {
        await registry.register({
          id,
          installed_version: '1.0.0',
          installed_at: new Date().toISOString(),
          status: 'active',
          config: {},
        });
      }
      const optOuts = new InMemoryBuiltInOptOutStore();
      const service = new InstallService({
        catalog,
        registry,
        vault: new InMemorySecretVault(),
        builtInOptOuts: optOuts,
      });

      await service.uninstall('@test/bundled');
      await service.uninstall('@test/not-in-catalog');

      assert.deepEqual(optOuts.list(), ['@test/bundled']);
    });
  });

  it('the file store survives a reload', async () => {
    await withTmpDir(async (dir) => {
      const file = join(dir, 'builtin-uninstalls.json');
      const first = new FileBuiltInOptOutStore(file);
      await first.load();
      await first.add('@test/a');
      await first.add('@test/b');
      await first.remove('@test/a');

      const second = new FileBuiltInOptOutStore(file);
      await second.load();
      assert.deepEqual(second.list(), ['@test/b']);
    });
  });

  it('a corrupt file does not stop the boot — it is moved aside', async () => {
    await withTmpDir(async (dir) => {
      const file = join(dir, 'builtin-uninstalls.json');
      writeFileSync(file, '{ not json');
      const original = console.error;
      console.error = () => {};
      const store = new FileBuiltInOptOutStore(file);
      try {
        await store.load();
      } finally {
        console.error = original;
      }
      assert.deepEqual(store.list(), []);
      assert.ok(existsSync(`${file}.corrupt`));
      await store.add('@test/c');
      const written = JSON.parse(readFileSync(file, 'utf8')) as { uninstalled: Record<string, string> };
      assert.ok(written.uninstalled['@test/c']);
    });
  });
});

describe('#1491 / #1498 — attach to the default orchestrator', () => {
  it('#1601 — never attaches a reference-only plugin', () => {
    const plugins: Record<string, { is_reference_only?: boolean }> = {
      '@omadia/agent-reference-maximum': { is_reference_only: true },
      '@omadia/integration-odoo': {},
    };
    const catalog = {
      get: (id: string) => (plugins[id] ? { plugin: plugins[id] } : undefined),
    } as unknown as Pick<PluginCatalog, 'get'>;

    assert.deepEqual(
      attachablePluginIds(
        ['@omadia/agent-reference-maximum', '@omadia/integration-odoo', '@test/unknown'],
        catalog,
      ),
      ['@omadia/integration-odoo', '@test/unknown'],
    );
  });

  it('expands installed depends_on parents, parents first', async () => {
    await withTmpDir(async (dir) => {
      writeManifest(join(dir, 'integration'), '@test/integration', '1.0.0');
      writeManifest(join(dir, 'agent'), '@test/agent', '1.0.0', [
        'depends_on:',
        '  - "@test/integration"',
        '  - "@test/not-installed"',
      ]);
      const { catalog } = await builtIns(dir);
      const registry = new InMemoryInstalledRegistry();
      for (const id of ['@test/integration', '@test/agent']) {
        await registry.register({
          id,
          installed_version: '1.0.0',
          installed_at: new Date().toISOString(),
          status: 'active',
          config: {},
        });
      }

      assert.deepEqual(withInstalledParents(['@test/agent'], catalog, registry), [
        '@test/integration',
        '@test/agent',
      ]);
    });
  });

  it('attaches only ids without a row and never the orchestrator itself', async () => {
    const upserts: Array<{ agentId: string; pluginId: string; enabled?: boolean }> = [];
    const store = {
      getPlatformSettings: async () => ({ fallbackAgentId: 'agent-1' }),
      listAgentPlugins: async () => [
        // The operator disabled this one on purpose — it must stay disabled.
        { agentId: 'agent-1', pluginId: '@test/parent', enabled: false, config: { k: 1 } },
      ],
      upsertAgentPlugin: async (
        agentId: string,
        input: { pluginId: string; enabled?: boolean },
      ) => {
        upserts.push({ agentId, pluginId: input.pluginId, enabled: input.enabled });
        return { agentId, pluginId: input.pluginId, enabled: true, config: {} };
      },
    };

    const result = await attachNewPluginsToFallbackAgent(
      store as unknown as Parameters<typeof attachNewPluginsToFallbackAgent>[0],
      ['@test/parent', '@test/child', '@omadia/orchestrator', '@test/child'],
    );

    assert.equal(result.agentId, 'agent-1');
    assert.deepEqual(result.attached, ['@test/child']);
    assert.deepEqual(upserts, [
      { agentId: 'agent-1', pluginId: '@test/child', enabled: true },
    ]);
  });

  it('attaches nothing when no fallback Agent is set', async () => {
    let upserted = false;
    const store = {
      getPlatformSettings: async () => ({ fallbackAgentId: null }),
      listAgentPlugins: async () => [],
      upsertAgentPlugin: async () => {
        upserted = true;
        return {};
      },
    };
    const result = await attachNewPluginsToFallbackAgent(
      store as unknown as Parameters<typeof attachNewPluginsToFallbackAgent>[0],
      ['@test/x'],
    );
    assert.equal(result.agentId, undefined);
    assert.equal(upserted, false);
  });

  it('the boot queue waits for the store, then attaches what is still installed', async () => {
    const installed = new Set(['@test/a', '@test/b']);
    const calls: string[][] = [];
    let storeReady = false;
    const queue = createPendingDefaultAttach({
      attach: async (ids) => {
        if (!storeReady) return false;
        calls.push([...ids]);
        return true;
      },
      isInstalled: (id) => installed.has(id),
      log: () => {},
    });
    queue.enqueue('@test/a');
    queue.enqueue('@test/b');

    await queue.flush();
    assert.deepEqual(queue.pending(), ['@test/a', '@test/b']);
    assert.deepEqual(calls, []);

    installed.delete('@test/b');
    storeReady = true;
    // A throwing attach (DB blip) keeps the ids for the next flush point.
    const failing = createPendingDefaultAttach({
      attach: async () => {
        throw new Error('connection refused');
      },
      isInstalled: () => true,
      log: () => {},
    });
    failing.enqueue('@test/x');
    await failing.flush();
    assert.deepEqual(failing.pending(), ['@test/x']);

    await queue.flush();
    assert.deepEqual(calls, [['@test/a']]);
    assert.deepEqual(queue.pending(), []);
  });
});

describe('shipped packages and profiles', () => {
  it('#1499 — every bundled manifest follows the multi_instance rule', async () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    let catalog: PluginCatalog;
    try {
      ({ catalog } = await builtIns(join(MIDDLEWARE_ROOT, 'packages')));
    } finally {
      console.warn = original;
    }
    assert.ok(catalog.list().length > 10, 'bundled packages were loaded');
    assert.deepEqual(
      warnings.filter((w) => w.includes('multi_instance_justification')),
      [],
    );
    for (const { plugin } of catalog.list()) {
      if (plugin.multi_instance === false) {
        assert.ok(
          plugin.multi_instance_justification?.trim(),
          `${plugin.id} declares multi_instance: false without a justification`,
        );
      }
    }
  });

  it('#1484 — every shipped profile lists only catalog plugins the boot keeps', async () => {
    const { catalog } = await builtIns(join(MIDDLEWARE_ROOT, 'packages'));
    // Capabilities whose provider the boot selects from the environment and
    // de-duplicates: a profile that adds one is undone by the next boot.
    const bootSelected = /^(memoryStore|knowledgeGraph)@/;
    const profiles = await listProfiles(join(MIDDLEWARE_ROOT, 'profiles'));
    assert.ok(profiles.length >= 3);
    for (const profile of profiles) {
      assert.doesNotMatch(profile.description, /\/store\/upload/);
      for (const { id } of profile.plugins) {
        const entry = catalog.get(id);
        assert.ok(entry, `profile ${profile.id} lists ${id}, which is not a bundled plugin`);
        const selected = entry.plugin.provides.filter((p) => bootSelected.test(p));
        assert.deepEqual(
          selected,
          [],
          `profile ${profile.id} lists ${id}, a boot-selected provider (${selected.join(', ')})`,
        );
      }
    }
  });
});
