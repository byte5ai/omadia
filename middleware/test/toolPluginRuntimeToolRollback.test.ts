/**
 * #2043 — a plugin's native tools go away with a failed activation and with a
 * deactivation.
 *
 * Found in the integration run with the real facilitation engine: its
 * `activate()` registered its tools, then threw on a later step. The rollback
 * took routes, UI entries, services and jobs down, but not the tools, so the
 * retry after the operator fixed the cause failed for good with "duplicate
 * native-tool name 'facilitation_start'": an error about the kernel's own
 * leftover, not about the plugin.
 *
 * Real on-disk package and the real `NativeToolRegistry`, because the defect
 * is exactly in what the kernel keeps between two real `activate()` calls.
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

const PLUGIN = '@test/tool-rollback';
const TOOL = 'rollback_probe_tool';
const FAIL_FLAG = '__toolRollbackFailActivation';

interface Harness {
  readonly runtime: ToolPluginRuntime;
  readonly tools: NativeToolRegistry;
  setFailing(failing: boolean): void;
}

async function makeHarness(t: TestContext, options: { closeDisposes: boolean }): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'tool-rollback-'));
  const flags = globalThis as unknown as Record<string, boolean>;
  t.after(async () => {
    delete flags[FAIL_FLAG];
    await rm(root, { recursive: true, force: true });
  });
  const packagePath = join(root, 'plugin');
  await mkdir(packagePath);
  const manifest = {
    schema_version: '1',
    identity: { id: PLUGIN, name: PLUGIN, version: '1.0.0', kind: 'tool', domain: 'test.rollback' },
    lifecycle: { entry: 'plugin.ts' },
  };
  const plugin = adaptManifestV1(manifest);
  assert.ok(plugin, 'fixture manifest must adapt');
  // Tools first, then the step that can fail: the order the engine uses.
  await writeFile(
    join(packagePath, 'plugin.ts'),
    `import type { PluginContext } from '@omadia/plugin-api';
     export async function activate(ctx: PluginContext): Promise<{ close(): Promise<void> }> {
       const dispose = ctx.tools.register(
         { name: '${TOOL}', description: 'probe', input_schema: { type: 'object', properties: {} } },
         async () => 'ok',
       );
       if ((globalThis as unknown as Record<string, boolean>)['${FAIL_FLAG}']) {
         throw new Error('a later activation step failed');
       }
       return { close: async (): Promise<void> => { ${options.closeDisposes ? 'dispose();' : 'void dispose;'} } };
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
  const entry: PluginCatalogEntry = {
    plugin,
    manifest,
    source_path: packagePath,
    source_kind: 'manifest-v1',
    origin: 'installed',
  } as unknown as PluginCatalogEntry;
  const tools = new NativeToolRegistry();
  const stub = (): (() => void) => (): void => {};
  const deps = {
    catalog: {
      get: (id: string) => (id === PLUGIN ? entry : undefined),
      list: () => [entry],
    } as unknown as PluginCatalog,
    registry,
    vault: {
      get: async (): Promise<undefined> => undefined,
      listKeys: async (): Promise<string[]> => [],
    },
    uploadedStore: {
      get: (id: string) => (id === PLUGIN ? { id, path: packagePath } : undefined),
      list: () => [{ id: PLUGIN, path: packagePath }],
    },
    serviceRegistry: new ServiceRegistry(),
    nativeToolRegistry: tools,
    pluginRouteRegistry: newTestRouteRegistry(),
    notificationRouter: { dispatch: (): void => {}, registerChannel: stub },
    uiRouteCatalog: new UiRouteCatalog(),
    jobScheduler: { register: stub, stopForPlugin: (): void => {} },
    log: (): void => {},
  } as unknown as ToolPluginRuntimeDeps;
  return {
    runtime: new ToolPluginRuntime(deps),
    tools,
    setFailing: (failing) => {
      flags[FAIL_FLAG] = failing;
    },
  };
}

describe('ToolPluginRuntime — native tools follow the plugin lifecycle (#2043)', () => {
  it('a failed activation leaves no tool behind, so the retry activates', async (t) => {
    const h = await makeHarness(t, { closeDisposes: true });
    h.setFailing(true);
    await assert.rejects(h.runtime.activate(PLUGIN), /a later activation step failed/);
    assert.equal(h.tools.has(TOOL), false, 'the tool of the failed activation is gone');

    h.setFailing(false);
    await h.runtime.activate(PLUGIN);
    assert.equal(h.runtime.isActive(PLUGIN), true);
    assert.equal(h.tools.get(TOOL)?.agentId, PLUGIN);
  });

  it('a deactivation removes the tools even when close() forgot its disposer', async (t) => {
    const h = await makeHarness(t, { closeDisposes: false });
    h.setFailing(false);
    await h.runtime.activate(PLUGIN);
    assert.equal(h.tools.has(TOOL), true);

    await h.runtime.deactivate(PLUGIN);
    assert.equal(h.tools.has(TOOL), false);
    await h.runtime.activate(PLUGIN);
    assert.equal(h.tools.has(TOOL), true, 'and the plugin activates again');
  });

  it('unregisterBySource leaves kernel tools and other plugins alone', () => {
    const tools = new NativeToolRegistry();
    const handler = async (): Promise<string> => 'ok';
    tools.register('kernel_marker');
    tools.registerHandler('other_tool', { handler, agentId: '@test/other' });
    tools.registerHandler('mine_a', { handler, agentId: PLUGIN });
    tools.registerHandler('mine_b', { handler, agentId: PLUGIN });
    assert.deepEqual(tools.unregisterBySource(PLUGIN).sort(), ['mine_a', 'mine_b']);
    assert.deepEqual([...tools.list()].sort(), ['kernel_marker', 'other_tool']);
  });
});
