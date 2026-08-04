/**
 * Backward compatibility for the deleted `ctx.devJobs` surface
 * (specs/470-dev-platform-plugin/dormant-capabilities.md §2).
 *
 * A plugin published before the deletion may still declare
 * `permissions.devJobs` in its manifest. Such a plugin MUST keep installing and
 * activating exactly as before, with `ctx.devJobs` simply absent — it was
 * already unusable, because nothing ever provided the backing host service and
 * every call threw.
 *
 * Unknown permission keys are silently ignored by `adaptManifestV1` today. That
 * is the entire back-compat guarantee, and it is implicit — nothing in the
 * loader states it. These tests assert it EXPLICITLY, so a future move to
 * strict manifest validation cannot silently start rejecting stale manifests.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { Plugin } from '../src/api/admin-v1.js';
import { adaptManifestV1 } from '../src/plugins/manifestLoader.js';
import type {
  PluginCatalog,
  PluginCatalogEntry,
} from '../src/plugins/manifestLoader.js';
import { createPluginContext } from '../src/platform/pluginContext.js';
import { ServiceRegistry } from '../src/platform/serviceRegistry.js';

const LEGACY_ID = 'de.byte5.integration.legacy-devjobs';

function manifest(permissions: Record<string, unknown>): Record<string, unknown> {
  return {
    schema_version: '1',
    identity: {
      id: LEGACY_ID,
      kind: 'integration',
      domain: 'test',
      name: 'Legacy devJobs Plugin',
      version: '1.0.0',
    },
    permissions,
  };
}

describe('legacy permissions.devJobs manifests stay loadable', () => {
  it('adapts a manifest declaring `permissions.devJobs: true` without rejecting it', () => {
    const plugin = adaptManifestV1(manifest({ devJobs: true }));
    assert.ok(plugin, 'a stale devJobs manifest must still adapt to a Plugin');
    assert.equal(plugin.id, LEGACY_ID);
  });

  it('adapts the block form (`{ repos_hint: [...] }`) too', () => {
    const plugin = adaptManifestV1(
      manifest({ devJobs: { repos_hint: ['omadia/omadia'] } }),
    );
    assert.ok(plugin);
    assert.equal(plugin.id, LEGACY_ID);
  });

  it('emits no dev_jobs field on permissions_summary — the key is ignored, not mapped', () => {
    const plugin = adaptManifestV1(manifest({ devJobs: true }));
    assert.ok(plugin);
    const summary = plugin.permissions_summary as Record<string, unknown>;
    assert.equal(
      'dev_jobs' in summary,
      false,
      'permissions_summary must not carry dev_jobs any more',
    );
    assert.equal('dev_jobs_repos_hint' in summary, false);
  });

  it('does not disturb the permission keys that ARE still parsed', () => {
    const plugin = adaptManifestV1(
      manifest({ devJobs: true, flows: true, mcp: true }),
    );
    assert.ok(plugin);
    assert.equal(plugin.permissions_summary.flows, true);
    assert.equal(
      (plugin.permissions_summary as Record<string, unknown>)['mcp'],
      true,
    );
  });

  it('builds an activation context with no devJobs accessor', () => {
    const plugin = adaptManifestV1(manifest({ devJobs: true }));
    assert.ok(plugin);
    const ctx = createPluginContext({
      agentId: LEGACY_ID,
      vault: {
        get: async () => undefined,
        listKeys: async () => [],
      } as unknown as Parameters<typeof createPluginContext>[0]['vault'],
      registry: {
        has: () => true,
        list: () => [],
        get: () => undefined,
      } as unknown as Parameters<typeof createPluginContext>[0]['registry'],
      catalog: catalogOf(plugin),
      serviceRegistry: new ServiceRegistry(),
      nativeToolRegistry: {
        register: () => () => {},
        registerHandler: () => () => {},
      } as unknown as Parameters<
        typeof createPluginContext
      >[0]['nativeToolRegistry'],
      routeRegistry: {
        register: () => () => {},
        list: () => [],
        disposeBySource: () => 0,
      } as unknown as Parameters<typeof createPluginContext>[0]['routeRegistry'],
      jobScheduler: {
        register: () => () => {},
        stopForPlugin: () => {},
      } as unknown as Parameters<typeof createPluginContext>[0]['jobScheduler'],
      logger: () => {},
    });
    assert.equal(
      (ctx as Record<string, unknown>)['devJobs'],
      undefined,
      'ctx.devJobs must be absent for a stale manifest — no throw, no accessor',
    );
    // And the rest of the context is intact: the plugin activates normally.
    assert.equal(ctx.agentId, LEGACY_ID);
    assert.equal(typeof ctx.services.get, 'function');
    assert.equal(
      ctx.services.get('devJobs'),
      undefined,
      'no provider registers devJobs, so the service route yields nothing either',
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
