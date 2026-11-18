/**
 * #2043 rollout (D3) — a plugin version this core refuses to start is taken
 * out of service at activation, also when it is ALREADY installed.
 *
 * Facilitator 0.7.3 stayed installed on the first kernel with native
 * facilitators. It still loaded, `query_facilitator` stayed on the agents, its
 * start failed inside and the group was told "the facilitation is started".
 * The install paths refused such a version already; the boot did not ask.
 */

import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { NativeToolRegistry } from '@omadia/orchestrator';

import { ServiceRegistry } from '../src/platform/serviceRegistry.js';
import { UiRouteCatalog } from '../src/platform/uiRouteCatalog.js';
import { PluginNotStartableError } from '../src/plugins/coreCompat.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import {
  adaptManifestV1,
  type PluginCatalog,
  type PluginCatalogEntry,
} from '../src/plugins/manifestLoader.js';
import {
  ToolPluginRuntime,
  type ToolPluginRuntimeDeps,
} from '../src/plugins/toolPluginRuntime.js';
import { newTestRouteRegistry } from './_helpers/routeRegistry.js';

const PLUGIN = '@omadia/agent-facilitator';
const RAN_FLAG = '__notStartableActivateRan';

async function harness(t: TestContext, version: string) {
  const root = await mkdtemp(join(tmpdir(), 'not-startable-'));
  const flags = globalThis as unknown as Record<string, number>;
  flags[RAN_FLAG] = 0;
  t.after(async () => {
    delete flags[RAN_FLAG];
    await rm(root, { recursive: true, force: true });
  });
  const packagePath = join(root, `plugin-${version}`);
  await mkdir(packagePath);
  const manifest = {
    schema_version: '1',
    identity: { id: PLUGIN, name: PLUGIN, version, kind: 'tool', domain: 'test.facilitation' },
    lifecycle: { entry: 'plugin.ts' },
  };
  const plugin = adaptManifestV1(manifest);
  assert.ok(plugin);
  await writeFile(
    join(packagePath, 'plugin.ts'),
    `export async function activate(): Promise<{ close(): Promise<void> }> {
       (globalThis as unknown as Record<string, number>)['${RAN_FLAG}'] += 1;
       return { close: async (): Promise<void> => {} };
     }
    `,
    'utf8',
  );
  const registry = new InMemoryInstalledRegistry();
  await registry.register({
    id: PLUGIN,
    installed_version: version,
    installed_at: '2026-10-01T00:00:00Z',
    status: 'active',
    config: {},
  });
  const entry = { plugin, manifest, source_path: packagePath, source_kind: 'manifest-v1', origin: 'installed' } as unknown as PluginCatalogEntry;
  const stub = (): (() => void) => (): void => {};
  const logs: string[] = [];
  const deps = {
    catalog: { get: (id: string) => (id === PLUGIN ? entry : undefined), list: () => [entry] } as unknown as PluginCatalog,
    registry,
    vault: { get: async (): Promise<undefined> => undefined, listKeys: async (): Promise<string[]> => [] },
    uploadedStore: {
      get: (id: string) => (id === PLUGIN ? { id, path: packagePath } : undefined),
      list: () => [{ id: PLUGIN, path: packagePath }],
    },
    serviceRegistry: new ServiceRegistry(),
    nativeToolRegistry: new NativeToolRegistry(),
    pluginRouteRegistry: newTestRouteRegistry(),
    notificationRouter: { dispatch: (): void => {}, registerChannel: stub },
    uiRouteCatalog: new UiRouteCatalog(),
    jobScheduler: { register: stub, stopForPlugin: (): void => {} },
    log: (m: string): void => {
      logs.push(m);
    },
  } as unknown as ToolPluginRuntimeDeps;
  return { runtime: new ToolPluginRuntime(deps), registry, logs, ran: () => flags[RAN_FLAG] ?? 0 };
}

describe('a plugin version this core refuses to start (#2043 D3)', () => {
  it('boot: facilitator 0.7.3 is not activated and is recorded as errored with the way out, at once', async (t) => {
    const h = await harness(t, '0.7.3');
    await h.runtime.activateAllInstalled();
    assert.equal(h.ran(), 0, "the plugin's own activate() never ran");
    assert.equal(h.runtime.isActive(PLUGIN), false);
    const entry = h.registry.get(PLUGIN);
    assert.equal(entry?.status, 'errored', 'terminal on the first boot, not after three');
    assert.match(entry?.last_activation_error ?? '', /cannot start on this host/);
    assert.match(entry?.last_activation_error ?? '', /Install @omadia\/agent-facilitator 1\.0\.0 or newer/);
    assert.match(h.logs.join('\n'), /activate FAILED for @omadia\/agent-facilitator/);
  });

  it('a direct activation (re-activation after a config edit) is refused the same way', async (t) => {
    const h = await harness(t, '0.7.3');
    await assert.rejects(h.runtime.activate(PLUGIN), (err: unknown) => err instanceof PluginNotStartableError);
    assert.equal(h.ran(), 0);
  });

  it('1.0.0 activates', async (t) => {
    const h = await harness(t, '1.0.0');
    await h.runtime.activateAllInstalled();
    assert.equal(h.ran(), 1);
    assert.equal(h.registry.get(PLUGIN)?.status, 'active');
  });
});
