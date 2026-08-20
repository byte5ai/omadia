/**
 * #795 (epic #470 C9) — `optional_requires:` — a dependency a plugin can
 * survive the absence of.
 *
 * WHAT WAS UNREPRESENTABLE
 * -----------------------
 * Two core rules met and left no legal spelling for a degradable dependency:
 *
 *   - C2b makes `ctx.services.get(name)` throw `ServiceNotDeclaredError` for
 *     a name in neither `requires:` nor `provides:` — so a plugin MUST list
 *     anything it might resolve.
 *   - The installer (`InstallService.create`) and the boot loop
 *     (`resolveEligiblePlugins`) both treat every `requires:` entry as a hard
 *     prerequisite.
 *
 * Declaring a degradable dependency therefore blocked the install; omitting
 * it made runtime resolution throw. `optional_requires:` is the third
 * position: it satisfies the declaration gate and neither enforcement gate.
 *
 * These tests pin the properties that make it worth having, one per gate
 * that had to agree:
 *   1. the manifest loader parses it with the same capability-ref syntax;
 *   2. it grants `services.get` / `services.getOptional` (no throw), and
 *      resolution answers `undefined` when nothing provides it;
 *   3. a provider that IS registered resolves normally through it;
 *   4. an UNdeclared name still throws — optionality is not a hole;
 *   5. neither the installer nor the boot resolver treats it as a
 *      prerequisite, while `requires:` still does. The contrast is load
 *      bearing: a test that only checked the optional side would stay green
 *      against a build that had stopped enforcing `requires:` entirely.
 *
 * Mutation check, run while writing these: dropping
 * `entry.plugin.optional_requires` from `declaredServiceNames` fails the
 * three cases in block 2; making `walkCapabilityInstallChain` read optional
 * entries fails the two install cases; restoring the optional edge in
 * `resolveCapabilities` fails the last case.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { ServiceNotDeclaredError } from '@omadia/plugin-api';

import type { Plugin } from '../src/api/admin-v1.js';
import { createPluginContext } from '../src/platform/pluginContext.js';
import type { CreatePluginContextOptions } from '../src/platform/pluginContext.js';
import {
  classifyServiceGrant,
  declaredServiceNames,
} from '../src/platform/pluginServiceGrants.js';
import { ServiceRegistry } from '../src/platform/serviceRegistry.js';
import {
  resolveEligiblePlugins,
  walkCapabilityInstallChain,
} from '../src/plugins/capabilityResolver.js';
import type {
  InstalledAgent,
  InstalledRegistry,
} from '../src/plugins/installedRegistry.js';
import { InstallError, InstallService } from '../src/plugins/installService.js';
import { adaptManifestV1 } from '../src/plugins/manifestLoader.js';
import type { PluginCatalog } from '../src/plugins/manifestLoader.js';
import type { SecretVault } from '../src/secrets/vault.js';

// --- fixtures --------------------------------------------------------------

interface PluginSpec {
  readonly id: string;
  readonly requires?: string[];
  readonly optional_requires?: string[];
  readonly provides?: string[];
}

/**
 * Built through the real `adaptManifestV1`, never as an object literal.
 * The feature under test is "does the loader carry this field through to the
 * gates", so a fixture that bypassed the loader could stay green while the
 * loader silently dropped `optional_requires:`.
 */
function pluginOf(spec: PluginSpec): Plugin {
  const plugin = adaptManifestV1({
    schema_version: '1',
    identity: {
      id: spec.id,
      name: spec.id,
      version: '1.0.0',
      kind: 'extension',
      domain: 'test.optional',
    },
    ...(spec.requires ? { requires: spec.requires } : {}),
    ...(spec.optional_requires
      ? { optional_requires: spec.optional_requires }
      : {}),
    ...(spec.provides ? { provides: spec.provides } : {}),
  });
  assert.ok(plugin, `fixture manifest for ${spec.id} must adapt`);
  return plugin;
}

function catalogOf(...plugins: Plugin[]): PluginCatalog {
  const entries = new Map(
    plugins.map((plugin) => [
      plugin.id,
      {
        plugin,
        manifest: {},
        source_path: 'test',
        source_kind: 'manifest-v1',
      },
    ]),
  );
  return {
    get: (id: string) => entries.get(id),
    list: () => [...entries.values()],
  } as unknown as PluginCatalog;
}

function makeCtx(
  agentId: string,
  catalog: PluginCatalog,
  registry = new ServiceRegistry(),
): { ctx: ReturnType<typeof createPluginContext>; registry: ServiceRegistry } {
  const stub = (): (() => void) => (): void => {};
  const ctx = createPluginContext({
    agentId,
    vault: {
      get: async (): Promise<undefined> => undefined,
      listKeys: async (): Promise<string[]> => [],
    },
    registry: { has: () => true, list: () => [], get: () => undefined },
    catalog,
    serviceRegistry: registry,
    nativeToolRegistry: { register: stub, registerHandler: stub },
    routeRegistry: { register: stub, disposeBySource: () => 0 },
    jobScheduler: { register: stub, stopForPlugin: (): void => {} },
    notificationRouter: { dispatch: (): void => {}, registerChannel: stub },
    uiRouteCatalog: { register: stub, registerNav: stub },
    logger: (): void => {},
  } as unknown as CreatePluginContextOptions);
  return { ctx, registry };
}

function installedRegistry(active: readonly string[] = []): InstalledRegistry {
  const map = new Map<string, InstalledAgent>();
  for (const id of active) {
    map.set(id, {
      id,
      installed_version: '1.0.0',
      installed_at: '2026-08-20T00:00:00Z',
      status: 'active',
      config: {},
    });
  }
  return {
    list: () => [...map.values()],
    get: (id) => map.get(id),
    has: (id) => map.has(id),
    register: async () => {
      /* no-op */
    },
    remove: async () => {
      /* no-op */
    },
    markActivationFailed: async () => {
      /* no-op */
    },
    markActivationSucceeded: async () => {
      /* no-op */
    },
    clearActivationError: async () => {
      /* no-op */
    },
    updateConfig: async () => {
      /* no-op */
    },
    updateVersion: async () => {
      /* no-op */
    },
  };
}

const noopVault = {
  setMany: async () => {
    /* no-op */
  },
  getMany: async () => ({}),
  purge: async () => {
    /* no-op */
  },
  list: async () => [],
} as unknown as SecretVault;

// --- 1. the manifest loader ------------------------------------------------

describe('#795 manifest — optional_requires parses like requires', () => {
  it('carries valid capability-refs onto the Plugin, separate from requires', () => {
    const plugin = pluginOf({
      id: '@test/consumer',
      requires: ['knowledgeGraph@^1'],
      optional_requires: ['turnContext@1', 'usageTelemetry@^1'],
    });
    assert.deepEqual(plugin.requires, ['knowledgeGraph@^1']);
    assert.deepEqual(plugin.optional_requires, [
      'turnContext@1',
      'usageTelemetry@^1',
    ]);
  });

  it('omits the field entirely when the manifest declares none', () => {
    const plugin = pluginOf({ id: '@test/plain', requires: [] });
    assert.equal(plugin.optional_requires, undefined);
  });

  it('drops a malformed entry rather than failing the whole manifest', () => {
    const plugin = pluginOf({
      id: '@test/messy',
      optional_requires: ['turnContext@1', 'no-version-here'],
    });
    assert.deepEqual(plugin.optional_requires, ['turnContext@1']);
  });
});

// --- 2 + 3 + 4. the C2b declaration gate ----------------------------------

describe('#795 services gate — optional_requires is a declaration', () => {
  it('counts toward declaredServiceNames alongside requires and provides', () => {
    const catalog = catalogOf(
      pluginOf({
        id: '@test/consumer',
        requires: ['knowledgeGraph@^1'],
        optional_requires: ['turnContext@1'],
        provides: ['reportStore@1'],
      }),
    );
    const declared = declaredServiceNames('@test/consumer', catalog);
    assert.ok(declared.has('knowledgeGraph'));
    assert.ok(declared.has('turnContext'), 'optional_requires must grant');
    assert.ok(declared.has('reportStore'));
  });

  it('classifies an optional-only capability as declared, not undeclared', () => {
    const catalog = catalogOf(
      pluginOf({ id: '@test/consumer', optional_requires: ['turnContext@1'] }),
    );
    const declared = declaredServiceNames('@test/consumer', catalog);
    assert.equal(
      classifyServiceGrant('@test/consumer', 'turnContext', declared, catalog),
      'declared',
    );
  });

  it('declared-optional + provider ABSENT: getOptional answers undefined, get does not throw', () => {
    const catalog = catalogOf(
      pluginOf({ id: '@test/consumer', optional_requires: ['turnContext@1'] }),
    );
    const { ctx } = makeCtx('@test/consumer', catalog);

    // The whole point: absence is an answer, not an exception.
    assert.equal(ctx.services.getOptional('turnContext'), undefined);
    assert.doesNotThrow(() => ctx.services.get('turnContext'));
    assert.equal(ctx.services.get('turnContext'), undefined);
    assert.equal(ctx.services.has('turnContext'), false);
  });

  it('declared-optional + provider PRESENT: resolves through both accessors', () => {
    const catalog = catalogOf(
      pluginOf({ id: '@test/consumer', optional_requires: ['turnContext@1'] }),
    );
    const { ctx, registry } = makeCtx('@test/consumer', catalog);
    const impl = { currentTurnId: (): string => 'turn-1' };
    registry.provide('turnContext', impl);

    assert.equal(ctx.services.getOptional('turnContext'), impl);
    assert.equal(ctx.services.get('turnContext'), impl);
    assert.equal(ctx.services.has('turnContext'), true);
  });

  it('UNDECLARED still throws through getOptional — optionality is not a hole', () => {
    const catalog = catalogOf(
      pluginOf({ id: '@test/consumer', optional_requires: ['turnContext@1'] }),
    );
    const { ctx, registry } = makeCtx('@test/consumer', catalog);
    registry.provide('graphPool', { pool: 'the real one' });

    // A typo must not become `undefined`: that is exactly the failure the
    // declaration gate exists to prevent, and `getOptional` inherits it.
    assert.throws(
      () => ctx.services.getOptional('graphPool'),
      (err: unknown) => {
        assert.ok(err instanceof ServiceNotDeclaredError);
        assert.equal(err.capability, 'graphPool');
        return true;
      },
    );
    assert.throws(
      () => ctx.services.getOptional('turnContxet'),
      ServiceNotDeclaredError,
    );
  });

  it('names optional_requires in the error a plugin author has to act on', () => {
    const catalog = catalogOf(pluginOf({ id: '@test/consumer' }));
    const { ctx } = makeCtx('@test/consumer', catalog);
    assert.throws(
      () => ctx.services.get('turnContext'),
      (err: unknown) => {
        assert.ok(err instanceof ServiceNotDeclaredError);
        assert.match(err.message, /optional_requires:/);
        return true;
      },
    );
  });
});

// --- 5. the two enforcement gates -----------------------------------------

describe('#795 install gate — optional_requires never yields a 409', () => {
  const service = (
    catalog: PluginCatalog,
    active: readonly string[] = [],
  ): InstallService =>
    new InstallService({
      catalog,
      registry: installedRegistry(active),
      vault: noopVault,
    });

  it('installs a plugin whose optional capability nothing provides', () => {
    const catalog = catalogOf(
      pluginOf({
        id: '@test/consumer',
        optional_requires: ['turnContext@1', 'usageTelemetry@^1'],
      }),
    );
    const job = service(catalog).create('@test/consumer');
    assert.equal(job.plugin_id, '@test/consumer');
    assert.equal(job.state, 'awaiting_config');
  });

  it('still 409s for a hard requires — the contrast is the assertion', () => {
    const catalog = catalogOf(
      pluginOf({
        id: '@test/consumer',
        requires: ['knowledgeGraph@^1'],
        optional_requires: ['turnContext@1'],
      }),
      pluginOf({ id: '@test/kg', provides: ['knowledgeGraph@1'] }),
    );
    assert.throws(
      () => service(catalog).create('@test/consumer'),
      (err: unknown) => {
        assert.ok(err instanceof InstallError);
        assert.equal(err.code, 'install.missing_capability');
        assert.equal(err.status, 409);
        return true;
      },
    );
  });

  it('keeps the optional capability out of the unresolved chain entirely', () => {
    const catalog = catalogOf(
      pluginOf({
        id: '@test/consumer',
        requires: ['knowledgeGraph@^1'],
        optional_requires: ['turnContext@1'],
      }),
      pluginOf({ id: '@test/kg', provides: ['knowledgeGraph@1'] }),
    );
    const chain = walkCapabilityInstallChain(
      '@test/consumer',
      catalog,
      installedRegistry(),
    );
    assert.deepEqual(chain.unresolved_requires, ['knowledgeGraph@^1']);
    assert.ok(
      !chain.available_providers.some((p) => p.capability === 'turnContext@1'),
      'an optional capability must not appear in available_providers — the ' +
        'operator would be told to install a provider for something the ' +
        'plugin already said it can live without',
    );
  });
});

describe('#795 boot resolver — optional_requires is not an activation dep', () => {
  it('keeps a consumer eligible when only its optional capability is missing', () => {
    const catalog = catalogOf(
      pluginOf({ id: '@test/consumer', optional_requires: ['turnContext@1'] }),
    );
    const resolution = resolveEligiblePlugins(['@test/consumer'], catalog);
    assert.deepEqual(resolution.resolved, ['@test/consumer']);
    assert.deepEqual(resolution.unresolved, []);
  });

  it('drops the same consumer when the capability is a hard require', () => {
    const catalog = catalogOf(
      pluginOf({ id: '@test/consumer', requires: ['turnContext@1'] }),
    );
    const resolution = resolveEligiblePlugins(['@test/consumer'], catalog);
    assert.deepEqual(resolution.resolved, []);
    assert.equal(resolution.unresolved.length, 1);
    assert.deepEqual(resolution.unresolved[0]?.requires, ['turnContext@1']);
  });

  it('contributes no ordering edge even when the provider IS eligible', () => {
    const catalog = catalogOf(
      pluginOf({ id: '@test/consumer', optional_requires: ['turnContext@1'] }),
      pluginOf({ id: '@test/provider', provides: ['turnContext@1'] }),
    );
    const resolution = resolveEligiblePlugins(
      ['@test/consumer', '@test/provider'],
      catalog,
    );
    assert.deepEqual(
      [...resolution.resolved].sort(),
      ['@test/consumer', '@test/provider'],
    );
    // Deliberate, and documented in capabilityResolver.ts: an edge from a
    // link the kernel may not enforce would turn a mutual optional
    // reference into a topo-sort cycle — a boot failure caused by a
    // dependency the manifest declared as skippable.
    assert.deepEqual(resolution.edges, []);
  });
});
