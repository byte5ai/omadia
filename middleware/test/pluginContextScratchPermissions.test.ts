/** OM-89: exercise the manifest gate through the context handed to activate(). */
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { adaptManifestV1 } from '../src/plugins/manifestLoader.js';
import type { PluginCatalog, PluginCatalogEntry } from '../src/plugins/manifestLoader.js';
import { createPluginContext } from '../src/platform/pluginContext.js';
import type { CreatePluginContextOptions } from '../src/platform/pluginContext.js';
import { SCRATCH_DIR } from '../src/platform/paths.js';
import { ServiceRegistry } from '../src/platform/serviceRegistry.js';

const PLUGIN_ID = 'de.byte5.integration.scratch-permissions-test';

function contextFor(fields: Readonly<Record<string, unknown>>): ReturnType<typeof createPluginContext> {
  const manifest = {
    schema_version: '1',
    identity: {
      id: PLUGIN_ID,
      kind: 'integration',
      domain: 'test',
      name: 'Scratch Permissions Test',
      version: '1.0.0',
    },
    ...fields,
  };
  const plugin = adaptManifestV1(manifest);
  assert.ok(plugin);
  const entry: PluginCatalogEntry = {
    plugin,
    manifest,
    source_path: `/abs/${plugin.id}/manifest.yaml`,
    source_kind: 'manifest-v1',
    origin: 'installed',
  };
  const catalog = {
    list: () => [entry],
    get: (id: string) => (id === plugin.id ? entry : undefined),
  } as unknown as PluginCatalog;

  // Keep the activation harness aligned with manifestRetiredPermissionKey:
  // only the manifest is real; unrelated providers cannot enable scratch.
  return createPluginContext({
    agentId: PLUGIN_ID,
    vault: {
      get: async () => undefined,
      listKeys: async () => [],
    } as unknown as CreatePluginContextOptions['vault'],
    registry: {
      has: () => true,
      list: () => [],
      get: () => undefined,
    } as unknown as CreatePluginContextOptions['registry'],
    catalog,
    serviceRegistry: new ServiceRegistry(),
    nativeToolRegistry: {
      register: () => () => {},
      registerHandler: () => () => {},
    } as unknown as CreatePluginContextOptions['nativeToolRegistry'],
    routeRegistry: {
      register: () => () => {},
      list: () => [],
      disposeBySource: () => 0,
    } as unknown as CreatePluginContextOptions['routeRegistry'],
    jobScheduler: {
      register: () => () => {},
      stopForPlugin: () => {},
    } as unknown as CreatePluginContextOptions['jobScheduler'],
    notificationRouter: {
      dispatch: () => {},
      registerChannel: () => () => {},
    } as unknown as CreatePluginContextOptions['notificationRouter'],
    uiRouteCatalog: {
      register: () => () => {},
      registerNav: () => () => {},
    } as unknown as CreatePluginContextOptions['uiRouteCatalog'],
    logger: () => {},
  } satisfies CreatePluginContextOptions);
}

describe('OM-89: scratch permissions reach the activation context', () => {
  it('publishes a working, lazily-created ctx.scratch for permissions.filesystem.scratch: true', async (t) => {
    const mkdir = t.mock.method(fs, 'mkdir', async () => undefined);
    try {
      const ctx = contextFor({ permissions: { filesystem: { scratch: true } } });
      assert.ok(ctx.scratch, 'the canonical manifest must publish ctx.scratch');
      assert.equal(mkdir.mock.callCount(), 0, 'context construction remains lazy');
      const expected = path.join(SCRATCH_DIR, PLUGIN_ID);
      assert.equal(await ctx.scratch.path(), expected);
      assert.equal(await ctx.scratch.path(), expected);
      assert.equal(mkdir.mock.callCount(), 1, 'the directory is ensured once');
      assert.deepEqual(mkdir.mock.calls[0]?.arguments, [
        expected,
        { recursive: true, mode: 0o700 },
      ]);
    } finally {
      mkdir.mock.restore();
    }
  });

  const disabledCases: ReadonlyArray<{
    name: string;
    fields: Readonly<Record<string, unknown>>;
  }> = [
    { name: 'explicit false', fields: { permissions: { filesystem: { scratch: false } } } },
    { name: 'filesystem block absent', fields: { permissions: {} } },
    { name: 'whole permissions block absent', fields: {} },
    { name: 'scratch absent', fields: { permissions: { filesystem: {} } } },
    { name: 'string scratch', fields: { permissions: { filesystem: { scratch: 'true' } } } },
    { name: 'numeric scratch', fields: { permissions: { filesystem: { scratch: 1 } } } },
    { name: 'null scratch', fields: { permissions: { filesystem: { scratch: null } } } },
    { name: 'null filesystem', fields: { permissions: { filesystem: null } } },
    { name: 'array filesystem', fields: { permissions: { filesystem: [] } } },
    { name: 'primitive filesystem', fields: { permissions: { filesystem: true } } },
    { name: 'null permissions', fields: { permissions: null } },
    { name: 'array permissions', fields: { permissions: [] } },
    { name: 'primitive permissions', fields: { permissions: true } },
    { name: 'legacy false', fields: { filesystem: { scratch: false } } },
    { name: 'legacy scratch absent', fields: { filesystem: {} } },
    { name: 'legacy nonboolean scratch', fields: { filesystem: { scratch: 'true' } } },
  ];
  for (const { name, fields } of disabledCases) {
    it(`leaves ctx.scratch absent for ${name}`, () => {
      const ctx = contextFor(fields);
      assert.equal(ctx.scratch, undefined);
      assert.equal(Object.hasOwn(ctx, 'scratch'), false);
      assert.equal(ctx.agentId, PLUGIN_ID, 'a denied scratch gate still activates');
    });
  }

  it('tolerates the legacy top-level filesystem.scratch: true declaration', () => {
    assert.ok(contextFor({ filesystem: { scratch: true } }).scratch);
  });

  it('tolerates legacy scratch alongside unrelated canonical permissions', () => {
    assert.ok(contextFor({ permissions: { flows: true }, filesystem: { scratch: true } }).scratch);
  });

  it('prefers canonical true over legacy false', () => {
    assert.ok(contextFor({
      permissions: { filesystem: { scratch: true } },
      filesystem: { scratch: false },
    }).scratch);
  });

  for (const filesystem of [{ scratch: false }, {}, { scratch: 'true' }, null, []]) {
    it(`does not let legacy true override canonical ${JSON.stringify(filesystem)}`, () => {
      assert.equal(contextFor({
        permissions: { filesystem },
        filesystem: { scratch: true },
      }).scratch, undefined);
    });
  }
});
