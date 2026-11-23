/**
 * Spec 2042 §5.10 / OB-29-5 — the Plugin Builder's pattern source
 * (`@omadia/agent-reference-maximum`) is now a capability plugin of kind
 * `integration`, so the tool runtime is the one that would start it. A
 * reference-only plugin is a read_reference source and never runs: the boot
 * skips it and a direct activation is refused, as the agent runtime did.
 */

import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { NativeToolRegistry } from '@omadia/orchestrator';

import { ServiceRegistry } from '../src/platform/serviceRegistry.js';
import { UiRouteCatalog } from '../src/platform/uiRouteCatalog.js';
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

const PLUGIN = '@omadia/agent-reference-test';
const RAN_FLAG = '__referenceOnlyActivateRan';

async function harness(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'reference-only-'));
  const flags = globalThis as unknown as Record<string, number>;
  flags[RAN_FLAG] = 0;
  t.after(async () => {
    delete flags[RAN_FLAG];
    await rm(root, { recursive: true, force: true });
  });
  const packagePath = join(root, 'plugin');
  await mkdir(packagePath);
  const manifest = {
    schema_version: '1',
    identity: { id: PLUGIN, name: PLUGIN, version: '1.0.0', kind: 'integration', domain: 'test.reference' },
    is_reference_only: true,
    lifecycle: { entry: 'plugin.ts' },
  };
  const plugin = adaptManifestV1(manifest);
  assert.ok(plugin);
  assert.equal(plugin.is_reference_only, true);
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
    installed_version: '1.0.0',
    installed_at: '2026-11-01T00:00:00Z',
    status: 'active',
    config: {},
  });
  const entry = { plugin, manifest, source_path: packagePath, source_kind: 'manifest-v1', origin: 'installed' } as unknown as PluginCatalogEntry;
  const stub = (): (() => void) => (): void => {};
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
    log: (): void => {},
  } as unknown as ToolPluginRuntimeDeps;
  return { runtime: new ToolPluginRuntime(deps), ran: () => flags[RAN_FLAG] ?? 0 };
}

describe('tool runtime: a reference-only capability plugin never runs', () => {
  it('boot skips it', async (t) => {
    const h = await harness(t);
    await h.runtime.activateAllInstalled();
    assert.equal(h.ran(), 0);
    assert.equal(h.runtime.isActive(PLUGIN), false);
  });

  it('a direct activation is refused', async (t) => {
    const h = await harness(t);
    await assert.rejects(h.runtime.activate(PLUGIN), /is_reference_only=true/);
    assert.equal(h.ran(), 0);
  });
});
