/**
 * #2090 — two majors of one kernel service next to each other.
 *
 * The registry holds one provider per name and the grant gate compared names
 * only, so `foo@^1` in a manifest bought whatever was registered as `foo`. A
 * second major is registered as `foo@2` and asked for by that name; the bare
 * name keeps meaning the first major.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { CapabilityParseError, ServiceNotDeclaredError } from '@omadia/plugin-api';

import {
  createPluginContext,
  type CreatePluginContextOptions,
} from '../src/platform/pluginContext.js';
import { declaresServiceMajor, versionedServiceRef } from '../src/platform/pluginServiceGrants.js';
import { ServiceRegistry } from '../src/platform/serviceRegistry.js';
import { adaptManifestV1, type PluginCatalog } from '../src/plugins/manifestLoader.js';

const PLUGIN = '@acme/consumer';

function catalogWith(requires: string[], optional: string[] = []): PluginCatalog {
  const manifest = {
    schema_version: '1',
    identity: { id: PLUGIN, kind: 'extension', domain: 'test.versions', name: 'Consumer', version: '1.0.0' },
    requires,
    optional_requires: optional,
  };
  const plugin = adaptManifestV1(manifest);
  assert.ok(plugin, 'fixture manifest must adapt');
  const entries = new Map([[plugin.id, { plugin, manifest, source_path: 'test', source_kind: 'manifest-v1' }]]);
  return { get: (id: string) => entries.get(id), list: () => [...entries.values()] } as unknown as PluginCatalog;
}

function contextFor(catalog: PluginCatalog): ReturnType<typeof createPluginContext> {
  const stub = (): (() => void) => (): void => {};
  const serviceRegistry = new ServiceRegistry();
  serviceRegistry.provide('agentTurn', { major: 1 });
  serviceRegistry.provide('agentTurn@2', { major: 2 });
  return createPluginContext({
    agentId: PLUGIN,
    vault: { get: async (): Promise<undefined> => undefined, listKeys: async (): Promise<string[]> => [] },
    registry: { has: () => true, list: () => [], get: () => undefined },
    catalog,
    serviceRegistry,
    nativeToolRegistry: { register: stub, registerHandler: stub },
    routeRegistry: { register: stub, disposeBySource: () => 0 },
    jobScheduler: { register: stub, stopForPlugin: (): void => {} },
    notificationRouter: { dispatch: (): void => {}, registerChannel: stub },
    uiRouteCatalog: { register: stub, registerNav: stub },
    logger: (): void => {},
  } as unknown as CreatePluginContextOptions);
}

describe('#2090 versioned service lookup', () => {
  it('the bare name is the first major, the versioned name its own registration', () => {
    const ctx = contextFor(catalogWith([], ['agentTurn@^1', 'agentTurn@^2']));
    assert.deepEqual(ctx.services.get('agentTurn'), { major: 1 });
    assert.deepEqual(ctx.services.get('agentTurn@2'), { major: 2 });
  });

  it('declaring one major does not buy the other', () => {
    const onlyOne = contextFor(catalogWith(['agentTurn@^1']));
    assert.deepEqual(onlyOne.services.get('agentTurn'), { major: 1 });
    assert.throws(() => onlyOne.services.get('agentTurn@2'), ServiceNotDeclaredError);
    const onlyTwo = contextFor(catalogWith([], ['agentTurn@2']));
    assert.deepEqual(onlyTwo.services.get('agentTurn@2'), { major: 2 });
  });

  it('an undeclared capability is refused under either name', () => {
    const ctx = contextFor(catalogWith(['somethingElse@^1']));
    assert.throws(() => ctx.services.get('agentTurn'), ServiceNotDeclaredError);
    assert.throws(() => ctx.services.get('agentTurn@2'), ServiceNotDeclaredError);
  });

  it('a major nobody registered resolves to nothing', () => {
    const ctx = contextFor(catalogWith([], ['agentTurn@^3']));
    assert.equal(ctx.services.get('agentTurn@3'), undefined);
  });

  it('a lookup names its major exactly; manifest syntax is refused', () => {
    assert.equal(versionedServiceRef('agentTurn'), undefined);
    assert.deepEqual(versionedServiceRef('agentTurn@2'), { name: 'agentTurn', major: 2 });
    for (const bad of ['agentTurn@^2', 'agentTurn@', '@2', 'agentTurn@two', 'agentTurn@02']) {
      assert.throws(() => versionedServiceRef(bad), CapabilityParseError, bad);
    }
    const catalog = catalogWith(['a@^1'], ['b@2']);
    assert.equal(declaresServiceMajor(PLUGIN, catalog, { name: 'a', major: 1 }), true);
    assert.equal(declaresServiceMajor(PLUGIN, catalog, { name: 'a', major: 2 }), false);
    assert.equal(declaresServiceMajor(PLUGIN, catalog, { name: 'b', major: 2 }), true);
    assert.equal(declaresServiceMajor('@nobody/here', catalog, { name: 'a', major: 1 }), false);
  });
});
