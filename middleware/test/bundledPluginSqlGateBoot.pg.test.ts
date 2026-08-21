/**
 * Issue #794 — C7's SQL gate must not stop the middleware booting.
 *
 * WHAT WENT WRONG
 * ---------------
 * C7 (#787) made a pool-shaped `ctx.services.get('graphPool')` require BOTH a
 * `permissions.sql` declaration AND an operator grant row, with C2b's dated
 * `LEGACY_UNDECLARED_SERVICE_GRANTS_2026_08_20` as the only ramp. But that
 * list answers a DIFFERENT question — "this plugin did not declare the
 * SERVICE" — and `@omadia/memory-postgres` had already done C2b's work
 * correctly (`requires: ["graphPool@^1"]`). Doing the C2b migration properly
 * is exactly what removed it from C2b's list, and therefore from C7's ramp.
 *
 * The result was not a degradation. `activate()` threw, `memoryStore` was
 * never published, and `index.ts` aborted boot with "MemoryStore service
 * missing after tool-plugin activation".
 *
 * WHY C7'S OWN 452-LINE TEST FILE DID NOT CATCH IT
 * ------------------------------------------------
 * `pluginSqlPermission.test.ts` is entirely unit-level: every case builds a
 * hand-written catalog stub via `catalogWith({...})`. A hand-written catalog
 * cannot disagree with the real manifests, so no amount of that kind of
 * coverage can see a manifest that is missing a block. The gap was never in
 * the decision table — it was between the table and the shipped manifests.
 *
 * So these two suites are deliberately shaped to close that seam:
 *
 *   1. `cold-boot classification` reads the REAL bundled manifests through the
 *      REAL `PluginCatalog` + `BuiltInPackageStore` and asserts the cold-boot
 *      decision for every bundled plugin that DECLARES `graphPool`. No
 *      database, so it runs in the ordinary CI step. It is keyed on the
 *      manifest's own `requires:` rather than on a hardcoded list of plugin
 *      names, which means it starts covering each remaining bundled plugin
 *      automatically the moment that plugin finishes its C2b migration — i.e.
 *      at exactly the moment #794's trap would otherwise re-arm for it.
 *
 *   2. `real boot` drives the REAL `ToolPluginRuntime.activate()` against a
 *      real pg pool. The oracle is `serviceRegistry.has('memoryStore')`, not
 *      "activate did not throw": the plugin's no-pool path returns a handle
 *      WITHOUT publishing `memoryStore` (see its `activate()`), so only a run
 *      that actually resolved the pool through both gates can satisfy it. A
 *      test asserting merely "no throw" would pass against a plugin that
 *      silently degraded to the no-pool branch — which is the same
 *      boot-failure, one frame later.
 *
 * MUTATION CHECK (run it before trusting this file): drop
 * `@omadia/memory-postgres` from `LEGACY_SQL_GRANTS_2026_08_20` in
 * `src/platform/pluginSqlGrants.ts`. Both suites must go red. If they stay
 * green the test is decorative.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';
import { newTestRouteRegistry } from './_helpers/routeRegistry.js';

import { PluginCatalog } from '../src/plugins/manifestLoader.js';
import { BuiltInPackageStore } from '../src/plugins/builtInPackageStore.js';
import {
  ToolPluginRuntime,
  type ToolPluginRuntimeDeps,
} from '../src/plugins/toolPluginRuntime.js';
import { ServiceRegistry } from '../src/platform/serviceRegistry.js';
import { UiRouteCatalog } from '../src/platform/uiRouteCatalog.js';
import {
  classifySqlAccess,
  POOL_SHAPED_CAPABILITIES,
  sqlPermissionOf,
  bundledSqlRampCapabilities,
} from '../src/platform/pluginSqlGrants.js';
import { parseCapabilityRef } from '@omadia/plugin-api';
import { LEGACY_UNDECLARED_SERVICE_GRANTS_2026_08_20 } from '../src/platform/pluginServiceGrants.js';

const MEMORY_PG = '@omadia/memory-postgres';

/** `graphPool@^1` -> `graphPool`. Malformed refs are dropped rather than
 *  thrown on: the loader has already accepted the manifest by this point, and
 *  a capability this helper cannot parse is one the gate will not match
 *  either, so treating it as "not pool-shaped" keeps the two in agreement. */
function capabilityName(raw: string): string {
  try {
    return parseCapabilityRef(raw).name;
  } catch {
    return '';
  }
}

/** `middleware/packages` — the same directory `BUILT_IN_PACKAGES_DIR` points
 *  at in production. Resolved from this file so the suite does not depend on
 *  the runner's CWD. */
const PACKAGES_DIR = path.resolve(
  fileURLToPath(new URL('../packages', import.meta.url)),
);

/**
 * The real catalog over the real bundled packages, wired EXACTLY as
 * `src/index.ts` wires it — built-ins marked `bundled`, which is what the C7
 * ramp keys on. Wiring it any other way would test a catalog production never
 * builds.
 */
async function loadBundledCatalog(): Promise<{
  catalog: PluginCatalog;
  builtInStore: BuiltInPackageStore;
}> {
  const builtInStore = new BuiltInPackageStore(PACKAGES_DIR);
  await builtInStore.load();
  const catalog = new PluginCatalog({
    extraSources: () =>
      builtInStore.list().map((p) => ({
        packageRoot: p.path,
        origin: 'bundled' as const,
      })),
  });
  await catalog.load();
  return { catalog, builtInStore };
}

describe('#794 — cold-boot SQL classification of the real bundled manifests', () => {
  it('marks the built-in packages as bundled (the ramp key)', async () => {
    const { catalog } = await loadBundledCatalog();
    const entry = catalog.get(MEMORY_PG);
    assert.ok(entry, `${MEMORY_PG} must be in the bundled catalog`);
    // Guard the guard: if `origin` ever stops being set here, every ramp
    // assertion below would be asking about a plugin the gate no longer
    // considers bundled, and would pass for the wrong reason.
    assert.equal(
      entry.origin,
      'bundled',
      'built-in packages must carry origin=bundled or the SQL ramp cannot key on it',
    );
  });

  it('never classifies an UPLOADED plugin as bundled, whatever its id', async () => {
    // The ramp must be unreachable by upload. An uploaded package that names
    // itself `@omadia/memory-postgres` must not inherit the built-in's ramp —
    // that is the whole reason the key is (id AND origin) and not id alone.
    const builtInStore = new BuiltInPackageStore(PACKAGES_DIR);
    await builtInStore.load();
    const impostorRoot = builtInStore.get(MEMORY_PG)?.path;
    assert.ok(impostorRoot, 'precondition: the built-in package resolves');

    const catalog = new PluginCatalog({
      // Same package root, but arriving the way an UPLOAD arrives: with no
      // origin, which must default to 'installed'.
      extraSources: () => [{ packageRoot: impostorRoot }],
    });
    await catalog.load();

    assert.equal(catalog.get(MEMORY_PG)?.origin, 'installed');
    assert.deepEqual(
      bundledSqlRampCapabilities(MEMORY_PG, catalog),
      [],
      'an installed plugin must get NO ramp capabilities even under a built-in id',
    );
  });

  it('every bundled plugin that declares graphPool still boots cold', async () => {
    const { catalog } = await loadBundledCatalog();

    // Keyed on the manifest's own `requires:`, not on a hardcoded name list.
    // A plugin that finishes its C2b migration (and so drops off C2b's ramp)
    // walks into this assertion automatically — which is precisely the trap
    // #794 was.
    const declaringPoolAccess = catalog
      .list()
      .filter((entry) =>
        entry.plugin.requires.some((raw) =>
          POOL_SHAPED_CAPABILITIES.has(capabilityName(raw)),
        ),
      );

    assert.ok(
      declaringPoolAccess.some((e) => e.plugin.id === MEMORY_PG),
      `precondition: ${MEMORY_PG} declares a pool-shaped capability`,
    );

    for (const entry of declaringPoolAccess) {
      const id = entry.plugin.id;
      for (const raw of entry.plugin.requires) {
        const capability = capabilityName(raw);
        if (!POOL_SHAPED_CAPABILITIES.has(capability)) continue;

        const outcome = classifySqlAccess({
          capability,
          declared: sqlPermissionOf(id, catalog),
          // Cold boot on a fresh install: `plugin_sql_grants` is empty, and
          // nothing in `src/` calls `grant()` yet, so `false` is not a
          // pessimistic choice — it is the only value reachable today.
          granted: false,
          legacy: (
            LEGACY_UNDECLARED_SERVICE_GRANTS_2026_08_20[id] ?? []
          ).includes(capability),
          bundledLegacy:
            bundledSqlRampCapabilities(id, catalog).includes(capability),
        });

        assert.notEqual(
          outcome,
          'undeclared',
          `bundled '${id}' would throw SqlPermissionError(undeclared) for '${capability}' at boot`,
        );
        assert.notEqual(
          outcome,
          'ungranted',
          `bundled '${id}' would throw SqlPermissionError(ungranted) for '${capability}' at boot`,
        );
      }
    }
  });

  it('memory-postgres declares permissions.sql with a ledger it may own', async () => {
    // The ramp is the belt; the declaration is the braces. It is also what
    // makes the request visible in the admin API at install time, and what
    // the operator will grant against once the grant surface ships.
    const { catalog } = await loadBundledCatalog();
    const declared = sqlPermissionOf(MEMORY_PG, catalog);
    assert.ok(
      declared,
      `${MEMORY_PG} must declare permissions.sql — a malformed block is DROPPED by the loader with a warning, so undefined here also means "declared it wrong"`,
    );
    assert.equal(declared.ledger, 'plg_omadia_memory_postgres_migrations');
    // It self-migrates via its own `_memory_migrations` table, so it must NOT
    // claim core-run migrations — that would make `ctx.sql.runMigrations()`
    // scan a directory this package does not ship.
    assert.equal(
      declared.migrations,
      undefined,
      'memory-postgres runs its own migrator; declaring `migrations:` would be a false claim',
    );
  });
});

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'bundledPluginSqlGateBoot',
  vars: ['MEMORY_PG_TEST_URL', 'GRAPH_PG_TEST_URL', 'DATABASE_URL'],
});

describe('#794 — real boot: memory-postgres activates against a real pool', () => {
  it('publishes memoryStore through the real ToolPluginRuntime', async (t) => {
    if (!pgAvailable || !PG_URL) return t.skip('no test Postgres');

    const { catalog, builtInStore } = await loadBundledCatalog();
    const serviceRegistry = new ServiceRegistry();

    // The pool the kernel holds. Registered under the same capability name
    // `@omadia/knowledge-graph-neon` publishes at boot, because that is the
    // object the gate decides about.
    const pool = new Pool({ connectionString: PG_URL, max: 2 });
    serviceRegistry.provide('graphPool', pool);

    const nativeTools: string[] = [];
    const deps = {
      catalog,
      builtInStore,
      uploadedStore: { get: () => undefined, list: () => [] },
      registry: {
        has: () => true,
        list: () => [],
        // The plugin reads `seed_dir` / `seed_mode` / the dev-endpoint flag
        // from here. Seeding is turned OFF so the suite asserts the gate, not
        // the seeder.
        get: () => ({ id: MEMORY_PG, config: { seed_mode: 'skip' } }),
        updateConfig: async () => undefined,
        markActivationFailed: async () => undefined,
      },
      vault: {
        get: async () => undefined,
        listKeys: async () => [],
      },
      serviceRegistry,
      nativeToolRegistry: {
        register: (name: string) => {
          nativeTools.push(name);
          return () => undefined;
        },
        registerHandler: () => () => undefined,
      },
      pluginRouteRegistry: newTestRouteRegistry(),
      uiRouteCatalog: new UiRouteCatalog(),
      jobScheduler: {
        register: () => () => undefined,
        stopForPlugin: () => undefined,
      },
      notificationRouter: { emit: () => undefined },
      log: () => undefined,
    } as unknown as ToolPluginRuntimeDeps;

    const runtime = new ToolPluginRuntime(deps);

    try {
      // On `main` this throws:
      //   plugin '@omadia/memory-postgres' reached for the database
      //   capability 'graphPool' but its manifest does not declare
      //   `permissions.sql`
      await runtime.activate(MEMORY_PG);

      // THE ORACLE. The plugin's no-pool branch returns a handle without ever
      // calling `ctx.services.provide('memoryStore', …)`, so this is true only
      // if the pool was actually resolved through BOTH gates. `index.ts` aborts
      // boot on exactly this condition ("MemoryStore service missing after
      // tool-plugin activation"), so this assertion is the boot check itself,
      // not a proxy for it.
      assert.equal(
        serviceRegistry.has('memoryStore'),
        true,
        'memory-postgres must publish memoryStore — this is the check index.ts aborts boot on',
      );

      // And the store must be usable, not merely registered: the migrator ran
      // against the borrowed pool.
      const store = serviceRegistry.get('memoryStore');
      assert.ok(store, 'memoryStore resolved');

      const applied = await pool.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM _memory_migrations',
      );
      assert.ok(
        Number(applied.rows[0]?.n ?? 0) > 0,
        'the plugin migrator must have applied its schema through the borrowed pool',
      );
    } finally {
      await runtime.deactivate(MEMORY_PG).catch(() => undefined);
      await pool.end();
    }
  });

  it('borrows the pool rather than owning it', async (t) => {
    if (!pgAvailable || !PG_URL) return t.skip('no test Postgres');

    // C7 hands plugins a BORROWED pool so one plugin's `.end()` cannot tear
    // down the connection pool core writes user data through. Asserted here
    // because the borrow only happens on the path that survives the gate —
    // it is untestable while activation throws.
    const { catalog, builtInStore } = await loadBundledCatalog();
    const serviceRegistry = new ServiceRegistry();
    const pool = new Pool({ connectionString: PG_URL, max: 2 });
    serviceRegistry.provide('graphPool', pool);

    const deps = {
      catalog,
      builtInStore,
      uploadedStore: { get: () => undefined, list: () => [] },
      registry: {
        has: () => true,
        list: () => [],
        get: () => ({ id: MEMORY_PG, config: { seed_mode: 'skip' } }),
        updateConfig: async () => undefined,
        markActivationFailed: async () => undefined,
      },
      vault: { get: async () => undefined, listKeys: async () => [] },
      serviceRegistry,
      nativeToolRegistry: {
        register: () => () => undefined,
        registerHandler: () => () => undefined,
      },
      pluginRouteRegistry: newTestRouteRegistry(),
      uiRouteCatalog: new UiRouteCatalog(),
      jobScheduler: {
        register: () => () => undefined,
        stopForPlugin: () => undefined,
      },
      notificationRouter: { emit: () => undefined },
      log: () => undefined,
    } as unknown as ToolPluginRuntimeDeps;

    const runtime = new ToolPluginRuntime(deps);
    try {
      await runtime.activate(MEMORY_PG);
      await runtime.deactivate(MEMORY_PG);

      // The kernel's own pool must still answer after the plugin went away.
      const after = await pool.query<{ ok: number }>('SELECT 1 AS ok');
      assert.equal(after.rows[0]?.ok, 1);
    } finally {
      await pool.end();
    }
  });
});
