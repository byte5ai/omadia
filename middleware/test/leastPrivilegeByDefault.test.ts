/**
 * #2054 — spec 2042 §6 criterion 9, "No super-agent out of the box": a fresh
 * installation with five plugins installed has no agent holding any of them;
 * installing a sixth plugin attaches it to no agent (INV-8).
 *
 * WHAT USED TO HAPPEN
 * First boot hydrated the seeded fallback agent with every installed plugin
 * (`ensureFallbackAgent` + `attachAllPlugins`; the seed itself is gone with
 * #2055), and every later kernel install
 * path (Hub install, upload, store reinstall, profile apply, built-ins the
 * boot seeded) attached the new plugin to it (`attachToDefaultOrchestrator`,
 * `pendingDefaultAttach`). Whoever reached that agent held the master key to
 * every connected system.
 *
 * WHAT THESE TESTS PIN
 * 1. Boot: the real built-in seeding (`runLegacyBootstrap`) installs five
 *    plugins of every capability kind and more — and no agent holds a
 *    plugin, also not the first agent the operator creates.
 * 2. Install: a sixth plugin installed through the real `InstallService`
 *    (create → configure → active) is granted to no agent.
 * 3. Every install path: the auto-attach machinery is gone from the kernel,
 *    and the only kernel code that writes an agent's plugin grant is the
 *    operator's explicit grant API and the facilitation engine's
 *    archetype-specific attach. The install hooks live in `index.ts` and
 *    cannot run in a unit test, so this pins them structurally: a new
 *    attach anywhere in the kernel fails here.
 */

import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';

import type { Config } from '../src/config.js';
import { runLegacyBootstrap } from '../src/plugins/bootstrap.js';
import { BuiltInPackageStore } from '../src/plugins/builtInPackageStore.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import { InstallService } from '../src/plugins/installService.js';
import { PluginCatalog } from '../src/plugins/manifestLoader.js';
import { InMemorySecretVault } from '../src/secrets/vault.js';

const MIDDLEWARE_ROOT = resolve(new URL(import.meta.url).pathname, '..', '..');

const FIVE: ReadonlyArray<{ dir: string; id: string; kind: string }> = [
  { dir: 'odoo', id: '@test/integration-odoo', kind: 'integration' },
  { dir: 'search', id: '@test/web-search', kind: 'tool' },
  { dir: 'hr', id: '@test/agent-hr', kind: 'agent' },
  { dir: 'chat', id: '@test/channel-chat', kind: 'channel' },
  { dir: 'memory', id: '@test/memory', kind: 'extension' },
];
const SIXTH = { dir: 'jira', id: '@test/integration-jira', kind: 'integration' };

function writeManifest(packageRoot: string, id: string, kind: string): void {
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, 'manifest.yaml'),
    [
      'schema_version: "1"',
      'identity:',
      `  id: "${id}"`,
      `  name: "${id}"`,
      '  version: 1.0.0',
      `  kind: ${kind}`,
      'lifecycle:',
      '  entry: dist/plugin.js',
      '',
    ].join('\n'),
  );
}

interface AgentRowMem {
  id: string;
  slug: string;
  name: string;
  description: string | null;
}

/** The ConfigStore surface the first-boot seed and a grant write use. */
class InMemoryAgentStore {
  readonly agents: AgentRowMem[] = [];
  readonly grants: Array<{ agentId: string; pluginId: string }> = [];
  fallbackAgentId: string | null = null;

  listAgents(): Promise<AgentRowMem[]> {
    return Promise.resolve([...this.agents]);
  }
  getPlatformSettings(): Promise<{ fallbackAgentId: string | null; updatedAt: Date }> {
    return Promise.resolve({ fallbackAgentId: this.fallbackAgentId, updatedAt: new Date(0) });
  }
  getAgentBySlug(slug: string): Promise<AgentRowMem | undefined> {
    return Promise.resolve(this.agents.find((a) => a.slug === slug));
  }
  createAgent(input: { slug: string; name: string; description?: string | null }): Promise<AgentRowMem> {
    const row = {
      id: `agent-${String(this.agents.length + 1)}`,
      slug: input.slug,
      name: input.name,
      description: input.description ?? null,
    };
    this.agents.push(row);
    return Promise.resolve(row);
  }
  setFallbackAgentId(id: string | null): Promise<{ fallbackAgentId: string | null; updatedAt: Date }> {
    this.fallbackAgentId = id;
    return Promise.resolve({ fallbackAgentId: id, updatedAt: new Date(0) });
  }
  upsertAgentPlugin(agentId: string, input: { pluginId: string }): Promise<unknown> {
    this.grants.push({ agentId, pluginId: input.pluginId });
    return Promise.resolve({ agentId, pluginId: input.pluginId, enabled: true, config: {} });
  }
  listAllAgentPlugins(): Promise<Array<{ agentId: string; pluginId: string }>> {
    return Promise.resolve([...this.grants]);
  }
  deleteAgentPluginsForPlugin(pluginId: string): Promise<number> {
    const before = this.grants.length;
    this.grants.splice(0, this.grants.length, ...this.grants.filter((g) => g.pluginId !== pluginId));
    return Promise.resolve(before - this.grants.length);
  }
}

describe('#2054 — spec 2042 §6.9: no super-agent out of the box', () => {
  it('a fresh installation with five plugins installed has no agent holding any of them; a sixth attaches to no agent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'least-privilege-'));
    try {
      const builtInDir = join(dir, 'built-in');
      for (const p of FIVE) writeManifest(join(builtInDir, p.dir), p.id, p.kind);
      const uploadDir = join(dir, 'uploads');
      writeManifest(join(uploadDir, SIXTH.dir), SIXTH.id, SIXTH.kind);

      const builtInStore = new BuiltInPackageStore(builtInDir);
      await builtInStore.load();
      const catalog = new PluginCatalog({
        manifestDir: '/nonexistent',
        extraSources: () => [
          ...builtInStore.list().map((p) => ({ packageRoot: p.path, origin: 'bundled' as const })),
          { packageRoot: join(uploadDir, SIXTH.dir), origin: 'installed' as const },
        ],
      });
      await catalog.load();
      const registry = new InMemoryInstalledRegistry();
      const store = new InMemoryAgentStore();

      // ── first boot ────────────────────────────────────────────────────
      await runLegacyBootstrap({
        config: {} as Config,
        catalog,
        registry,
        vault: new InMemorySecretVault(),
        builtInStore,
        log: () => {},
      });
      assert.deepEqual(
        registry.list().map((e) => e.id).sort(),
        FIVE.map((p) => p.id).sort(),
        'the boot installed the five plugins',
      );
      assert.equal(store.agents.length, 0, 'no agent is seeded (#2055)');
      await store.createAgent({ slug: 'mira', name: 'Mira' });
      assert.deepEqual(await store.listAllAgentPlugins(), [], 'no agent holds any of the five');

      // ── a sixth plugin is installed ──────────────────────────────────
      const installService = new InstallService({
        catalog,
        registry,
        vault: new InMemorySecretVault(),
        agentPluginBindingStore: () => store,
      });
      const job = installService.create(SIXTH.id);
      const done = await installService.configure(job.id, {});
      assert.equal(done.state, 'active');
      assert.ok(registry.has(SIXTH.id));
      assert.deepEqual(await store.listAllAgentPlugins(), [], 'the sixth attaches to no agent');

    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('criterion 9: boot with the host’s hooks backed by the agent store attaches nothing, also to an agent that existed before boot and on a reboot that adds a built-in', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'least-privilege-boot-'));
    try {
      const builtInDir = join(dir, 'built-in');
      for (const p of FIVE) writeManifest(join(builtInDir, p.dir), p.id, p.kind);
      const store = new InMemoryAgentStore();
      // An instance whose operator already created an agent and made it the default.
      const mira = await store.createAgent({ slug: 'mira', name: 'Mira' });
      await store.setFallbackAgentId(mira.id);
      const registry = new InMemoryInstalledRegistry();
      const reported: string[] = [];

      const boot = async (): Promise<void> => {
        const builtInStore = new BuiltInPackageStore(builtInDir);
        await builtInStore.load();
        const catalog = new PluginCatalog({
          manifestDir: '/nonexistent',
          extraSources: () => builtInStore.list().map((p) => ({ packageRoot: p.path, origin: 'bundled' as const })),
        });
        await catalog.load();
        await runLegacyBootstrap({
          config: {} as Config,
          catalog,
          registry,
          vault: new InMemorySecretVault(),
          builtInStore,
          log: () => {},
          // The host's hooks, backed by the agent store (index.ts wires
          // `onPluginRemoved` to the binding purge; `onPluginInstalled` is
          // the seam #1498 used to attach boot installs to the default
          // agent — here it is the host's, which must not grant anything).
          onPluginRemoved: (pluginId) => {
            void store.deleteAgentPluginsForPlugin(pluginId);
          },
          onPluginInstalled: (pluginId) => {
            reported.push(pluginId);
            hostOnPluginInstalled(store, pluginId);
          },
        });
      };

      await boot();
      assert.deepEqual(reported.sort(), FIVE.map((p) => p.id).sort(), 'boot reports every plugin it installed');
      assert.deepEqual(await store.listAllAgentPlugins(), [], 'no agent holds any of the five, not even the default agent');

      // A new image ships a sixth built-in: the reboot installs it and grants it to no one.
      writeManifest(join(builtInDir, SIXTH.dir), SIXTH.id, SIXTH.kind);
      reported.length = 0;
      await boot();
      assert.deepEqual(reported, [SIXTH.id]);
      assert.ok(registry.has(SIXTH.id));
      assert.deepEqual(await store.listAllAgentPlugins(), [], 'the sixth built-in attaches to no agent');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('criterion 9: the host wires no install hook into its boot (the test above runs the host’s real hooks)', () => {
    const index = readFileSync(join(MIDDLEWARE_ROOT, 'src', 'index.ts'), 'utf8');
    const start = index.indexOf('await runLegacyBootstrap({');
    assert.ok(start >= 0, 'index.ts no longer boots through runLegacyBootstrap — re-point this test');
    const call = index.slice(start, index.indexOf('\n  });', start));
    assert.deepEqual(
      [...call.matchAll(/^\s{4}(\w+)[,:]/gm)].map((m) => m[1]).sort(),
      ['builtInOptOuts', 'builtInStore', 'catalog', 'config', 'onPluginRemoved', 'registry', 'vault'],
      'a new boot hook needs a reviewed entry in hostOnPluginInstalled above, which must not grant a plugin to an agent',
    );
  });
});

/**
 * What index.ts does with a plugin the boot installed: nothing (it passes no
 * `onPluginInstalled`, pinned by the test above). A host that starts using
 * the hook mirrors it here, and the store-backed boot test fails the moment
 * it grants a plugin to an agent.
 */
function hostOnPluginInstalled(_store: InMemoryAgentStore, _pluginId: string): void {}

function kernelSources(): string[] {
  const roots = [join(MIDDLEWARE_ROOT, 'src'), join(MIDDLEWARE_ROOT, 'packages', 'harness-orchestrator', 'src')];
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(full);
    }
  };
  for (const r of roots) walk(r);
  return out;
}

describe('#2054 — no install path attaches a plugin to an agent', () => {
  const files = kernelSources().map((f) => ({
    path: relative(MIDDLEWARE_ROOT, f),
    text: readFileSync(f, 'utf8'),
  }));

  it('the auto-attach machinery is gone', () => {
    for (const name of [
      'attachAllPlugins',
      'attachNewPluginsToFallbackAgent',
      'attachToDefaultOrchestrator',
      'pendingDefaultAttach',
      'createPendingDefaultAttach',
      'defaultOrchestratorAttach',
    ]) {
      const hits = files.filter((f) => f.text.includes(name)).map((f) => f.path);
      assert.deepEqual(hits, [], `${name} is still referenced`);
    }
  });

  it('only the operator grant API and the facilitation engine attach write an agent plugin grant', () => {
    const writers = files
      .filter((f) => /\.upsertAgentPlugin\(/.test(f.text))
      .map((f) => f.path)
      .sort();
    assert.deepEqual(writers, [
      'src/platform/facilitatorEngineAttach.ts',
      'src/routes/operatorAgents.ts',
    ]);
  });
});
