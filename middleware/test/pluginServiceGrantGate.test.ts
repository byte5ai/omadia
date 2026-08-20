/**
 * Epic #470 — B1: `ctx.services.get` is grant-gated.
 *
 * Before this, `pluginContext.ts` handed the service registry straight
 * through. Any installed plugin could resolve any registered service — the
 * `graphPool` Postgres pool included — with no manifest declaration, no
 * operator consent, and nothing in the install dialog.
 *
 * These tests pin the four properties that make the gate worth having:
 *   1. an undeclared capability THROWS, and the error names both the
 *      capability and the manifest field that would grant it;
 *   2. a declared one (via `requires`, or `provides` for reading back your
 *      own registration) resolves exactly as before;
 *   3. a per-caller factory is invoked with the KERNEL-known id — a consumer
 *      cannot talk the provider into attributing the call to someone else;
 *   4. the dated legacy allowlist warns once and then allows, and is closed:
 *      a different plugin, or a different name, still throws.
 *
 * Counter-proof (documented in the PR): reverting the gate in
 * `pluginContext.ts` to `return serviceRegistry.get<T>(name)` makes cases 1
 * and 4 fail — the undeclared read succeeds and no warning is emitted.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  ServiceNotDeclaredError,
  perCallerService,
  type ServiceCaller,
} from '@omadia/plugin-api';

import type { Plugin } from '../src/api/admin-v1.js';
import { adaptManifestV1 } from '../src/plugins/manifestLoader.js';
import type { PluginCatalog } from '../src/plugins/manifestLoader.js';
import { createPluginContext } from '../src/platform/pluginContext.js';
import type { CreatePluginContextOptions } from '../src/platform/pluginContext.js';
import {
  KERNEL_SERVICE_CALLER,
  ServiceRegistry,
} from '../src/platform/serviceRegistry.js';
import {
  LEGACY_UNDECLARED_SERVICE_GRANTS_2026_08_20,
  classifyServiceGrant,
  declaredServiceNames,
} from '../src/platform/pluginServiceGrants.js';

// --- fixtures --------------------------------------------------------------

/**
 * Build a real `Plugin` through the real manifest adapter rather than a
 * hand-rolled object literal: the gate reads `plugin.requires` /
 * `plugin.provides`, and those fields are produced by `adaptManifestV1`. A
 * fixture that bypasses the adapter could pass while the adapter drops the
 * very entries the gate depends on.
 */
function pluginOf(
  id: string,
  requires: string[],
  provides: string[] = [],
): Plugin {
  const plugin = adaptManifestV1({
    schema_version: '1',
    identity: {
      id,
      name: id,
      version: '1.0.0',
      kind: 'extension',
      domain: 'test.gate',
    },
    requires,
    provides,
  });
  assert.ok(plugin, `fixture manifest for ${id} must adapt`);
  return plugin;
}

function catalogOf(...plugins: Plugin[]): PluginCatalog {
  const entries = new Map(
    plugins.map((plugin) => [
      plugin.id,
      { plugin, manifest: {}, source_path: 'test', source_kind: 'manifest-v1' },
    ]),
  );
  return {
    get: (id: string) => entries.get(id),
    list: () => [...entries.values()],
  } as unknown as PluginCatalog;
}

interface CtxFixture {
  ctx: ReturnType<typeof createPluginContext>;
  registry: ServiceRegistry;
  logs: string[];
}

function makeCtx(
  agentId: string,
  catalog: PluginCatalog,
  registry = new ServiceRegistry(),
): CtxFixture {
  const stub = (): (() => void) => (): void => {};
  const logs: string[] = [];
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
    logger: (...args: unknown[]): void => {
      logs.push(args.map(String).join(' '));
    },
  } as unknown as CreatePluginContextOptions);
  return { ctx, registry, logs };
}

// --- 1. undeclared is denied ----------------------------------------------

describe('services.get — undeclared capabilities are denied', () => {
  it('throws ServiceNotDeclaredError for a capability the manifest never mentions', () => {
    const catalog = catalogOf(pluginOf('@test/consumer', ['knowledgeGraph@^1']));
    const { ctx, registry } = makeCtx('@test/consumer', catalog);
    registry.provide('graphPool', { pool: 'the real one' });

    assert.throws(
      () => ctx.services.get('graphPool'),
      (err: unknown) => {
        assert.ok(
          err instanceof ServiceNotDeclaredError,
          'must be the typed error, not a generic throw',
        );
        assert.equal(err.capability, 'graphPool');
        assert.equal(err.pluginId, '@test/consumer');
        assert.equal(err.manifestField, 'requires');
        assert.match(err.message, /graphPool/);
        assert.match(err.message, /requires:/);
        return true;
      },
    );
  });

  it('denies even when no provider is registered — a manifest bug is not a missing provider', () => {
    const catalog = catalogOf(pluginOf('@test/consumer', []));
    const { ctx } = makeCtx('@test/consumer', catalog);
    assert.throws(
      () => ctx.services.get('tigrisStore'),
      ServiceNotDeclaredError,
      'undeclared must throw rather than silently return undefined — otherwise the plugin author cannot tell the two apart',
    );
  });

  it('denies a plugin the kernel has no manifest for at all', () => {
    const { ctx, registry } = makeCtx('@test/ghost', catalogOf());
    registry.provide('graphPool', { pool: 1 });
    assert.throws(
      () => ctx.services.get('graphPool'),
      ServiceNotDeclaredError,
      'no catalog entry means no declarations to check, and unknown permissions are denied permissions',
    );
  });

  it('leaves `has` ungated — existence is not a capability', () => {
    const catalog = catalogOf(pluginOf('@test/consumer', []));
    const { ctx, registry } = makeCtx('@test/consumer', catalog);
    registry.provide('graphPool', { pool: 1 });
    assert.equal(ctx.services.has('graphPool'), true);
  });
});

// --- 2. declared resolves --------------------------------------------------

describe('services.get — declared capabilities resolve', () => {
  it('resolves a capability listed in `requires`', () => {
    const catalog = catalogOf(pluginOf('@test/consumer', ['knowledgeGraph@^1']));
    const { ctx, registry } = makeCtx('@test/consumer', catalog);
    const impl = { kg: true };
    registry.provide('knowledgeGraph', impl);
    assert.equal(ctx.services.get('knowledgeGraph'), impl);
  });

  it('accepts both `name@1` and `name@^1` spellings', () => {
    const catalog = catalogOf(pluginOf('@test/consumer', ['memoryStore@1']));
    const { ctx, registry } = makeCtx('@test/consumer', catalog);
    registry.provide('memoryStore', { m: 1 });
    assert.deepEqual(ctx.services.get('memoryStore'), { m: 1 });
  });

  it('lets a provider read back the capability it provides', () => {
    const catalog = catalogOf(
      pluginOf('@test/provider', [], ['memoryStore@1']),
    );
    const { ctx } = makeCtx('@test/provider', catalog);
    ctx.services.provide('memoryStore', { own: true });
    assert.deepEqual(ctx.services.get('memoryStore'), { own: true });
    assert.equal(
      classifyServiceGrant(
        '@test/provider',
        'memoryStore',
        declaredServiceNames('@test/provider', catalog),
        catalog,
      ),
      'self-provided',
    );
  });

  it('returns undefined — not a throw — for a declared capability with no provider installed', () => {
    const catalog = catalogOf(pluginOf('@test/consumer', ['knowledgeGraph@^1']));
    const { ctx } = makeCtx('@test/consumer', catalog);
    assert.equal(ctx.services.get('knowledgeGraph'), undefined);
  });
});

// --- 3. per-caller factory attribution ------------------------------------

describe('services.provide — per-caller factories are kernel-attributed', () => {
  it('invokes the factory with the kernel-known id, not one the caller supplies', () => {
    const catalog = catalogOf(
      pluginOf('@test/provider', [], ['repoGrants@1']),
      pluginOf('@test/consumer', ['repoGrants@^1']),
    );
    const registry = new ServiceRegistry();
    const seen: ServiceCaller[] = [];

    const provider = makeCtx('@test/provider', catalog, registry);
    provider.ctx.services.provide(
      'repoGrants',
      perCallerService((caller) => {
        seen.push(caller);
        return { scopedTo: caller.pluginId };
      }),
    );

    const consumer = makeCtx('@test/consumer', catalog, registry);
    const accessor = consumer.ctx.services.get<{ scopedTo: string }>('repoGrants');

    assert.deepEqual(accessor, { scopedTo: '@test/consumer' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.agentId, '@test/consumer');
    assert.equal(
      seen[0]?.pluginId,
      '@test/consumer',
      'attribution must come from the id the kernel activated the plugin under',
    );
  });

  it('cannot be spoofed — the consumer has no argument that reaches the factory', () => {
    const catalog = catalogOf(
      pluginOf('@test/provider', [], ['repoGrants@1']),
      pluginOf('@test/evil', ['repoGrants@^1']),
    );
    const registry = new ServiceRegistry();
    makeCtx('@test/provider', catalog, registry).ctx.services.provide(
      'repoGrants',
      perCallerService((caller) => ({ scopedTo: caller.pluginId })),
    );

    const evil = makeCtx('@test/evil', catalog, registry);
    // The only surface a consumer controls is the service NAME. There is no
    // second parameter through which it could name itself `@test/provider`.
    const accessor = evil.ctx.services.get<{ scopedTo: string }>('repoGrants');
    assert.equal(accessor?.scopedTo, '@test/evil');
    assert.equal(
      (evil.ctx.services.get as (n: string, ...rest: unknown[]) => unknown)
        .length,
      1,
      'services.get takes exactly one parameter — the name',
    );
  });

  it('mints a fresh implementation per consuming plugin', () => {
    const catalog = catalogOf(
      pluginOf('@test/provider', [], ['repoGrants@1']),
      pluginOf('@test/a', ['repoGrants@^1']),
      pluginOf('@test/b', ['repoGrants@^1']),
    );
    const registry = new ServiceRegistry();
    makeCtx('@test/provider', catalog, registry).ctx.services.provide(
      'repoGrants',
      perCallerService((caller) => ({ scopedTo: caller.agentId })),
    );

    const a = makeCtx('@test/a', catalog, registry).ctx.services.get<{
      scopedTo: string;
    }>('repoGrants');
    const b = makeCtx('@test/b', catalog, registry).ctx.services.get<{
      scopedTo: string;
    }>('repoGrants');

    assert.equal(a?.scopedTo, '@test/a');
    assert.equal(b?.scopedTo, '@test/b');
    assert.notEqual(a, b);
  });

  it('attributes core’s own direct registry reads to the kernel', () => {
    const registry = new ServiceRegistry();
    registry.provide(
      'repoGrants',
      perCallerService((caller) => ({ scopedTo: caller.pluginId })),
    );
    assert.deepEqual(registry.get('repoGrants'), {
      scopedTo: KERNEL_SERVICE_CALLER.pluginId,
    });
  });

  it('keeps value providers untouched — including a value that IS a function', () => {
    const catalog = catalogOf(
      pluginOf('@test/provider', [], ['callable@1']),
      pluginOf('@test/consumer', ['callable@^1']),
    );
    const registry = new ServiceRegistry();
    const fn = (): string => 'i am the service itself';
    makeCtx('@test/provider', catalog, registry).ctx.services.provide(
      'callable',
      fn,
    );
    const got = makeCtx('@test/consumer', catalog, registry).ctx.services.get<
      typeof fn
    >('callable');
    assert.equal(
      got,
      fn,
      'a plain function registration must be returned as-is, never mistaken for a factory',
    );
    assert.equal(got?.(), 'i am the service itself');
  });
});

// --- 4. the dated legacy allowlist ----------------------------------------

describe('services.get — dated legacy allowlist (2026-08-20)', () => {
  const LEGACY_ID = '@omadia/orchestrator';

  it('hands the pool over BORROWED — a plugin cannot end core\'s database', () => {
    // The wiring half of the #665 guard. `borrowedPool.test.ts` proves the
    // wrapper refuses `end()`; this proves the wrapper is actually ON the
    // object a plugin receives from `services.get`. Without this, removing the
    // `borrowPool(...)` call in `pluginContext.ts` would leave every unit test
    // green while handing plugins the raw pool again.
    //
    // Asserted on the LEGACY path deliberately: grandfathered plugins are the
    // ones most likely to contain an old `pool.end()` in their teardown, so
    // they are exactly who must not be exempt from the guard.
    const catalog = catalogOf(pluginOf(LEGACY_ID, ['knowledgeGraph@^1']));
    const { ctx, registry } = makeCtx(LEGACY_ID, catalog);
    let ended = false;
    registry.provide('graphPool', {
      pool: true,
      end: () => {
        ended = true;
      },
    });

    const borrowed = ctx.services.get<{ end: () => void }>('graphPool');
    assert.throws(
      () => borrowed?.end(),
      /borrowed rather than owned/,
      'services.get must not hand a plugin a pool it can tear down',
    );
    assert.equal(ended, false, 'the underlying pool must be untouched');
  });

  it('warns exactly once per capability and then allows', () => {
    const catalog = catalogOf(pluginOf(LEGACY_ID, ['knowledgeGraph@^1']));
    const { ctx, registry, logs } = makeCtx(LEGACY_ID, catalog);
    const pool = { pool: true };
    registry.provide('graphPool', pool);

    // Read-through rather than reference equality: since #470 C7 a pool-shaped
    // capability is handed to a plugin through `borrowPool`, so what comes back
    // is a lifecycle-guarded Proxy over `pool`, not `pool` itself. The identity
    // check was never this case's point — the warn-once behaviour below is —
    // and asserting through the Proxy keeps it testing that.
    assert.equal(ctx.services.get<typeof pool>('graphPool')?.pool, true);
    assert.equal(ctx.services.get<typeof pool>('graphPool')?.pool, true);
    assert.equal(ctx.services.get<typeof pool>('graphPool')?.pool, true);

    const warnings = logs.filter((l) => l.includes("resolved 'graphPool'"));
    assert.equal(
      warnings.length,
      1,
      'a service resolved in a per-turn hot path must not flood the log',
    );
    assert.match(warnings[0] ?? '', /legacy allowlist/);
    assert.match(warnings[0] ?? '', /2026-08-20/);
  });

  it('is closed: another plugin asking for the same name still throws', () => {
    const catalog = catalogOf(pluginOf('@test/newcomer', []));
    const { ctx, registry } = makeCtx('@test/newcomer', catalog);
    registry.provide('graphPool', { pool: true });
    assert.throws(
      () => ctx.services.get('graphPool'),
      ServiceNotDeclaredError,
      'the allowlist grandfathers audited pairs, it does not whitelist names globally',
    );
  });

  it('is closed: an allowlisted plugin asking for a NEW name still throws', () => {
    const catalog = catalogOf(pluginOf(LEGACY_ID, []));
    const { ctx, registry } = makeCtx(LEGACY_ID, catalog);
    registry.provide('somethingNew', { x: 1 });
    assert.throws(() => ctx.services.get('somethingNew'), ServiceNotDeclaredError);
  });

  it('classifies a declared name as declared even when it is also allowlisted', () => {
    // `@omadia/orchestrator` is allowlisted for `graphPool`; once the manifest
    // declares it, the row is dead weight and the classification says so.
    const catalog = catalogOf(pluginOf(LEGACY_ID, ['graphPool@^1']));
    assert.equal(
      classifyServiceGrant(
        LEGACY_ID,
        'graphPool',
        declaredServiceNames(LEGACY_ID, catalog),
        catalog,
      ),
      'declared',
    );
  });

  it('is frozen, so nothing can widen it at runtime', () => {
    assert.equal(
      Object.isFrozen(LEGACY_UNDECLARED_SERVICE_GRANTS_2026_08_20),
      true,
    );
    assert.throws(() => {
      (
        LEGACY_UNDECLARED_SERVICE_GRANTS_2026_08_20 as Record<
          string,
          readonly string[]
        >
      )['@test/attacker'] = ['graphPool'];
    });
    assert.equal(
      LEGACY_UNDECLARED_SERVICE_GRANTS_2026_08_20['@test/attacker'],
      undefined,
    );
    // and the per-plugin arrays too — freezing only the outer object would
    // leave `[...].push('graphPool')` open.
    assert.throws(() => {
      (
        LEGACY_UNDECLARED_SERVICE_GRANTS_2026_08_20[
          '@omadia/orchestrator'
        ] as string[]
      ).push('anthropicClient');
    });
  });
});

// --- 5. the declaration reader --------------------------------------------

describe('declaredServiceNames', () => {
  it('unions requires and provides, stripping the version', () => {
    const catalog = catalogOf(
      pluginOf('@test/p', ['a@^1', 'b@2'], ['c@1', 'd@^3']),
    );
    assert.deepEqual(
      [...declaredServiceNames('@test/p', catalog)].sort(),
      ['a', 'b', 'c', 'd'],
    );
  });

  it('drops malformed entries instead of granting them', () => {
    const catalog = catalogOf(pluginOf('@test/p', ['no-version', 'ok@1']));
    assert.deepEqual([...declaredServiceNames('@test/p', catalog)], ['ok']);
  });

  it('grants nothing for an unknown plugin', () => {
    assert.equal(declaredServiceNames('@test/nobody', catalogOf()).size, 0);
  });
});
