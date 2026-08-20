/**
 * Backward compatibility for RETIRED permission keys.
 *
 * A capability can be removed from the plugin API — its accessor deleted, its
 * permission key no longer parsed. A plugin published before that removal still
 * declares the retired key in its manifest, and it MUST keep installing and
 * activating exactly as before, with the accessor simply absent.
 *
 * Unknown permission keys are silently ignored by `adaptManifestV1` today. That
 * is the entire back-compat guarantee, and it is implicit — nothing in the
 * loader states it. These tests assert it EXPLICITLY, so a future move to
 * strict manifest validation cannot silently start rejecting stale manifests
 * and bricking installed plugins on upgrade.
 *
 * The guarantee is key-AGNOSTIC, so the cases below are too: they exercise the
 * shapes a retired key arrives in (bare `true`, a block of options, alongside
 * live keys) rather than one historical name. Which names were retired, and in
 * which release, is recorded in `packages/plugin-api/CHANGELOG.md` — that is a
 * changelog's job, and pinning a name here would only make this suite go
 * stale-but-green the next time a different capability is retired.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { ServiceNotDeclaredError } from '@omadia/plugin-api';

import type { Plugin } from '../src/api/admin-v1.js';
import { adaptManifestV1 } from '../src/plugins/manifestLoader.js';
import type {
  PluginCatalog,
  PluginCatalogEntry,
} from '../src/plugins/manifestLoader.js';
import { createPluginContext } from '../src/platform/pluginContext.js';
import type { CreatePluginContextOptions } from '../src/platform/pluginContext.js';
import { ServiceRegistry } from '../src/platform/serviceRegistry.js';

const LEGACY_ID = 'de.byte5.integration.stale-manifest';

/** Stands in for any permission key the plugin API no longer parses. */
const RETIRED_KEY = 'retiredCapability';

function manifest(permissions: Record<string, unknown>): Record<string, unknown> {
  return {
    schema_version: '1',
    identity: {
      id: LEGACY_ID,
      kind: 'integration',
      domain: 'test',
      name: 'Stale Manifest Plugin',
      version: '1.0.0',
    },
    permissions,
  };
}

describe('manifests declaring a retired permission key stay loadable', () => {
  it('adapts a manifest declaring a retired key as `true` without rejecting it', () => {
    const plugin = adaptManifestV1(manifest({ [RETIRED_KEY]: true }));
    assert.ok(plugin, 'a stale manifest must still adapt to a Plugin');
    assert.equal(plugin.id, LEGACY_ID);
  });

  it('adapts the block form (`{ repos_hint: [...] }`) too', () => {
    const plugin = adaptManifestV1(
      manifest({ [RETIRED_KEY]: { some_hint: ['omadia/omadia'] } }),
    );
    assert.ok(plugin);
    assert.equal(plugin.id, LEGACY_ID);
  });

  it('surfaces no field for it on permissions_summary — ignored, not mapped', () => {
    const plugin = adaptManifestV1(
      manifest({ [RETIRED_KEY]: { some_hint: ['x'] } }),
    );
    assert.ok(plugin);
    const summary = plugin.permissions_summary;
    assert.equal(
      Object.hasOwn(summary, RETIRED_KEY),
      false,
      'a retired key must not reappear on the operator-facing summary',
    );
    assert.equal(Object.hasOwn(summary, `${RETIRED_KEY}_some_hint`), false);
  });

  it('does not disturb the permission keys that ARE still parsed', () => {
    const plugin = adaptManifestV1(
      manifest({ [RETIRED_KEY]: true, flows: true, mcp: true }),
    );
    assert.ok(plugin);
    assert.equal(plugin.permissions_summary.flows, true);
    assert.equal(plugin.permissions_summary.mcp, true);
  });

  it('builds an activation context with no accessor for the retired key', () => {
    const plugin = adaptManifestV1(manifest({ [RETIRED_KEY]: true }));
    assert.ok(plugin);
    const ctx = createPluginContext({
      agentId: LEGACY_ID,
      vault: {
        get: async () => undefined,
        listKeys: async () => [],
      } as unknown as CreatePluginContextOptions['vault'],
      registry: {
        has: () => true,
        list: () => [],
        get: () => undefined,
      } as unknown as CreatePluginContextOptions['registry'],
      catalog: catalogOf(plugin),
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
    assert.equal(
      Object.hasOwn(ctx, RETIRED_KEY),
      false,
      'the accessor must be absent for a stale manifest — no throw, no accessor',
    );
    // And the rest of the context is intact: the plugin activates normally.
    assert.equal(ctx.agentId, LEGACY_ID);
    assert.equal(typeof ctx.services.get, 'function');
    // And the service-locator route is closed too. Before epic #470 B1 this
    // returned `undefined` (no provider registered); now the manifest gate
    // rejects it outright, because the stale permission key above is not a
    // capability declaration and grants nothing. Either way the deleted
    // accessor is unreachable — the gate just says so out loud instead of
    // looking like a missing installation.
    assert.throws(
      () => ctx.services.get(RETIRED_KEY),
      ServiceNotDeclaredError,
      'the legacy permission key grants nothing through the service locator either',
    );
  });
});

function catalogOf(plugin: Plugin): PluginCatalog {
  const entry = {
    plugin,
    manifest: {},
    source_path: `/abs/${plugin.id}/manifest.yaml`,
    source_kind: 'manifest-v1',
  } as unknown as PluginCatalogEntry;
  return {
    list: () => [entry],
    get: (q: string) => (q === plugin.id ? entry : undefined),
  } as unknown as PluginCatalog;
}
