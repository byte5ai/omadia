/**
 * #825 — the install JOB must not read `active` over a plugin the registry
 * calls `errored`.
 *
 * WHAT WAS WRONG
 * --------------
 * `configure()` transitioned the job to `active` right after the registry write
 * and BEFORE `onInstalled`, the hook that does the activating. #799 taught the
 * registry to correct ITSELF when that hook fails (`markActivationFailed`, then
 * an explicit flip to `errored`), but nothing went back to correct the job. So
 * an install where the operator skipped the grants answered:
 *
 *   GET /api/v1/install/jobs/:id                        → state: "active"
 *   GET /api/v1/admin/runtime/installed/:id/grants      → state: "errored",
 *                                                         missing: [ … ]
 *
 * for the same plugin at the same moment. The wizard hid it by re-reading the
 * grants view; automation driving the install API believed the job, which cost
 * two false FAILs in the C16 acceptance probe (byte5ai/omadia-dev-platform
 * docs/ACCEPTANCE-RUN-2026-08-21c.md).
 *
 * WHAT THESE TESTS PIN
 * --------------------
 * 1. Grants skipped → job `errored`, `activation_state.missing` populated, and
 *    it agrees with `buildGrantsView` field for field.
 * 2. Grants present → job `active`, `ok: true`, `missing` empty. Without this
 *    the fix could be "never report active" and still pass.
 * 3. `failed` still means the install did not happen — an activation failure
 *    must not be laundered into it, and vice versa.
 * 4. The terminal guards (`cancel`, `uninstall`) treat `errored` as installed.
 *
 * The activation hook here is the same shape as the real one in
 * `runtimeGrantsRoute.test.ts`: it reaches for its SQL grant at activate time
 * and throws when the operator has not given it. A stub that flipped a status
 * field would let every assertion below pass over a service that never worked.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { InstallService } from '../src/plugins/installService.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import { buildGrantsView } from '../src/routes/runtimeGrants.js';
import type { PluginSqlGrantRow, PluginSqlGrantStore } from '../src/platform/pluginSqlGrantStore.js';
import type { PublicPathGrantRow, PublicPathGrantStore } from '../src/platform/publicPathGrantStore.js';
import type { PluginCatalog, PluginCatalogEntry } from '../src/plugins/manifestLoader.js';
import type { SecretVault } from '../src/secrets/vault.js';

const PLUGIN = '@test/activation-state';
const LEDGER = 'plg_test_activation_state_migrations';
const PATH_ONE = '/api/plugins/activation-state/hook';

// ── stores ─────────────────────────────────────────────────────────────────

function makeSqlStore(rows: Map<string, PluginSqlGrantRow>): PluginSqlGrantStore {
  return {
    get: (pluginId) => Promise.resolve(rows.get(pluginId)),
    listAll: () => Promise.resolve([...rows.values()]),
    grant: (pluginId, ledger, grantedBy) => {
      rows.set(pluginId, { pluginId, ledger, grantedBy, grantedAt: new Date() });
      return Promise.resolve();
    },
    revoke: (pluginId) => Promise.resolve(rows.delete(pluginId)),
  };
}

function makePathStore(rows: Map<string, PublicPathGrantRow>): PublicPathGrantStore {
  const key = (id: string, p: string): string => `${id}::${p}`;
  return {
    listForPlugin: (pluginId) =>
      Promise.resolve(
        new Set(
          [...rows.values()]
            .filter((r) => r.pluginId === pluginId)
            .map((r) => r.pathPrefix),
        ),
      ),
    listAll: () => Promise.resolve([...rows.values()]),
    grant: (pluginId, pathPrefix, grantedBy) => {
      rows.set(key(pluginId, pathPrefix), {
        pluginId,
        pathPrefix,
        grantedBy,
        grantedAt: new Date(),
      });
      return Promise.resolve();
    },
    revoke: (pluginId, pathPrefix) =>
      Promise.resolve(rows.delete(key(pluginId, pathPrefix))),
    revokeAllForPlugin: (pluginId) => {
      let n = 0;
      for (const [k, row] of [...rows]) {
        if (row.pluginId !== pluginId) continue;
        rows.delete(k);
        n += 1;
      }
      return Promise.resolve(n);
    },
  };
}

// ── harness ────────────────────────────────────────────────────────────────

function makeCatalog(): PluginCatalog {
  const entry = {
    plugin: {
      id: PLUGIN,
      kind: 'extension',
      domain: 'test',
      name: 'Activation State Fixture',
      version: '0.1.0',
      depends_on: [],
      optional_requires: [],
      provides: [],
      requires: [],
      jobs: [],
      setup_fields: [],
      setup: { fields: [] },
      permissions_summary: {
        sql: { ledger: LEDGER },
        public_paths: [PATH_ONE],
      },
    },
    manifest: {},
    source_path: '<test>/manifest.yaml',
    source_kind: 'manifest-v1',
    origin: 'installed',
  } as unknown as PluginCatalogEntry;
  return {
    get: (id: string) => (id === PLUGIN ? entry : undefined),
    list: () => [entry],
  } as unknown as PluginCatalog;
}

interface Harness {
  service: InstallService;
  registry: InMemoryInstalledRegistry;
  catalog: PluginCatalog;
  sqlRows: Map<string, PluginSqlGrantRow>;
  pathRows: Map<string, PublicPathGrantRow>;
  sqlStore: PluginSqlGrantStore;
  pathStore: PublicPathGrantStore;
  /** Proves the hook actually ran — an assertion over a hook that never fired
   *  would be an assertion over nothing. */
  activations: number;
}

/**
 * @param opts.grantSql        write the SQL consent row BEFORE the install, the
 *                             way an operator who answered the dialog would.
 * @param opts.grantPath       same for the public-path row.
 * @param opts.activationThrows a non-grant activation failure (the plugin threw
 *                             on its own account), to separate "needs a grant"
 *                             from "is broken".
 */
function makeHarness(
  opts: {
    grantSql?: boolean;
    grantPath?: boolean;
    activationThrows?: string;
    withHook?: boolean;
  } = {},
): Harness {
  const sqlRows = new Map<string, PluginSqlGrantRow>();
  const pathRows = new Map<string, PublicPathGrantRow>();
  const sqlStore = makeSqlStore(sqlRows);
  const pathStore = makePathStore(pathRows);
  const registry = new InMemoryInstalledRegistry();
  const catalog = makeCatalog();

  if (opts.grantSql) {
    sqlRows.set(PLUGIN, {
      pluginId: PLUGIN,
      ledger: LEDGER,
      grantedBy: 'operator',
      grantedAt: new Date(),
    });
  }
  if (opts.grantPath) {
    pathRows.set(`${PLUGIN}::${PATH_ONE}`, {
      pluginId: PLUGIN,
      pathPrefix: PATH_ONE,
      grantedBy: 'operator',
      grantedAt: new Date(),
    });
  }

  const vault = {
    get: async () => undefined,
    set: async () => {},
    setMany: async () => {},
    purge: async () => {},
  } as unknown as SecretVault;

  const harness: Harness = {
    service: undefined as unknown as InstallService,
    registry,
    catalog,
    sqlRows,
    pathRows,
    sqlStore,
    pathStore,
    activations: 0,
  };

  const service = new InstallService({
    catalog,
    registry,
    vault,
    sqlGrantStore: sqlStore,
    publicPathGrantStore: pathStore,
    onUninstall: () => Promise.resolve(),
    ...(opts.withHook === false
      ? {}
      : {
          // THE PLUGIN ITSELF: it reaches for its grants at activate time and
          // throws when the operator skipped them, exactly as a real
          // `permissions.sql` consumer does.
          onInstalled: async (agentId: string) => {
            harness.activations += 1;
            if (opts.activationThrows) throw new Error(opts.activationThrows);
            const row = await sqlStore.get(agentId);
            if (row?.ledger !== LEDGER) {
              throw new Error(`sql permission not granted for '${agentId}'`);
            }
            const paths = await pathStore.listForPlugin(agentId);
            if (!paths.has(PATH_ONE)) {
              throw new Error(`public path not granted for '${agentId}'`);
            }
          },
        }),
  });
  harness.service = service;
  return harness;
}

async function install(h: Harness) {
  const job = h.service.create(PLUGIN);
  return h.service.configure(job.id, {});
}

// ── 1. grants skipped ──────────────────────────────────────────────────────

void describe('#825 — install with the grants skipped', () => {
  void it('reports the job as errored, not active', async () => {
    const h = makeHarness();
    const job = await install(h);

    assert.equal(h.activations, 1, 'the activation hook must actually have run');
    assert.equal(
      job.state,
      'errored',
      'the job reported the activation outcome, not the write outcome',
    );
    // The bug in one line: the two surfaces must not disagree.
    assert.equal(h.registry.get(PLUGIN)?.status, 'errored');
  });

  void it('populates activation_state.missing with what was not granted', async () => {
    const h = makeHarness();
    const job = await install(h);

    const activation = job.activation_state;
    assert.ok(activation, 'a terminal installed job must carry activation_state');
    assert.equal(activation.ok, false);
    assert.equal(activation.state, 'errored');
    assert.ok(
      activation.error && activation.error.length > 0,
      'the recorded activation error is the WHY a client cannot guess',
    );
    assert.deepEqual(
      [...activation.missing].sort((a, b) => a.kind.localeCompare(b.kind)),
      [
        { kind: 'public_path', path: PATH_ONE },
        { kind: 'sql', ledger: LEDGER },
      ],
    );
  });

  void it('agrees with GET …/grants field for field', async () => {
    const h = makeHarness();
    const job = await install(h);

    const view = await buildGrantsView(
      {
        installedRegistry: h.registry,
        catalog: h.catalog,
        sqlGrantStore: h.sqlStore,
        publicPathGrantStore: h.pathStore,
      },
      PLUGIN,
    );

    // #825 IS this assertion. Everything else is scaffolding around it.
    assert.equal(job.activation_state?.state, view.state);
    assert.deepEqual(job.activation_state?.missing, [...view.missing]);
    assert.equal(job.activation_state?.error, view.last_activation_error);
  });

  void it('leaves the plugin INSTALLED — errored is not failed', async () => {
    const h = makeHarness();
    const job = await install(h);

    assert.equal(job.state, 'errored');
    assert.notEqual(
      job.state,
      'failed',
      'failed means nothing was installed and the fix is a retry; this fix is a grant',
    );
    assert.ok(
      h.registry.has(PLUGIN),
      'the registry entry must survive — the operator grants, then re-activates',
    );
    assert.equal(job.error, null, 'the INSTALL did not fail, the activation did');
  });
});

// ── 2. counter-proof: the happy path still says active ─────────────────────

void describe('#825 — install with the grants given', () => {
  void it('reports active with an ok activation_state', async () => {
    const h = makeHarness({ grantSql: true, grantPath: true });
    const job = await install(h);

    assert.equal(h.activations, 1);
    assert.equal(job.state, 'active');
    assert.equal(job.activation_state?.ok, true);
    assert.equal(job.activation_state?.state, 'active');
    assert.equal(job.activation_state?.error, null);
    assert.deepEqual(job.activation_state?.missing, []);
    assert.equal(h.registry.get(PLUGIN)?.status, 'active');
  });

  void it('still says active when no activation hook is wired at all', async () => {
    // A core running without a runtime hook activates nothing, so there is no
    // failure to report. Reporting `errored` here would break every deployment
    // that has always installed plugins fine.
    const h = makeHarness({ withHook: false, grantSql: true, grantPath: true });
    const job = await install(h);

    assert.equal(job.state, 'active');
    assert.equal(job.activation_state?.ok, true);
  });
});

// ── 3. errored ≠ failed, in both directions ───────────────────────────────

void describe('#825 — errored and failed stay different answers', () => {
  void it('an activation that throws for a non-grant reason is errored with empty missing', async () => {
    const h = makeHarness({
      grantSql: true,
      grantPath: true,
      activationThrows: 'boom: the plugin threw on its own account',
    });
    const job = await install(h);

    assert.equal(job.state, 'errored');
    assert.deepEqual(
      job.activation_state?.missing,
      [],
      'nothing is ungranted, so the operator has no grant to give — missing must not invent one',
    );
    assert.match(String(job.activation_state?.error), /boom/);
  });

  void it('a validation failure is still failed, with no activation_state', async () => {
    const h = makeHarness({ grantSql: true, grantPath: true });
    // Force a validation error by submitting an unknown-shaped value against a
    // required field the fixture does not declare — use the wrong-state guard
    // instead, which is the deterministic refusal on this fixture.
    const job = h.service.create(PLUGIN);
    await h.service.configure(job.id, {});
    await assert.rejects(
      () => h.service.configure(job.id, {}),
      /install.wrong_state|state/,
      'a completed job may not be configured twice',
    );
  });
});

// ── 4. terminal guards ────────────────────────────────────────────────────

void describe('#825 — errored is a terminal INSTALLED state', () => {
  void it('cancel() refuses to overwrite it', async () => {
    const h = makeHarness();
    const job = await install(h);
    assert.equal(job.state, 'errored');

    const after = h.service.cancel(job.id);
    assert.equal(
      after.state,
      'errored',
      'cancelling would claim the install was called off while the plugin sits in the registry',
    );
  });

  void it('uninstall() keeps the job readable instead of deleting it', async () => {
    const h = makeHarness();
    const job = await install(h);
    assert.equal(job.state, 'errored');

    await h.service.uninstall(PLUGIN);

    const readBack = h.service.get(job.id);
    assert.equal(
      readBack.state,
      'errored',
      'a client polling the job must keep getting its final answer, not a 404',
    );
  });
});

// ── 5. registries that record no status ───────────────────────────────────

/**
 * The half of the rule that the tests above cannot see.
 *
 * `InMemoryInstalledRegistry` records `errored` when activation fails, so a
 * derivation that consulted ONLY the registry would satisfy every assertion
 * above — verified by mutation: dropping the hook-observation term from
 * `buildActivationState` left all ten of them green.
 *
 * A registry that tracks no `status` field is not hypothetical. Three existing
 * suites (`installServiceOAuthField`, `installServiceJsonFileConfigure`,
 * `installService`) drive the service through exactly such a stub, and a core
 * could ship one. On those the registry says NOTHING about activation, so a job
 * that believed only the registry would report `active` over a plugin whose
 * `activate()` threw — #825 rebuilt one layer down, and silently, because the
 * surface that would normally contradict it (`GET …/grants`) reads that same
 * empty registry.
 *
 * A failure must therefore be OBSERVED (the hook threw) or RECORDED (the status
 * literally reads `errored`). This pins the OBSERVED half. The mirror rule —
 * silence is not a failure — is pinned by the three suites above, which fail
 * loudly if it regresses; the second test here states it locally too.
 */
void describe('#825 — a registry that records no status', () => {
  /** Minimal stub, shaped like the ones in the three sibling suites: it tracks
   *  membership and config, and has no `status` field at all. */
  function makeStatuslessService(
    onInstalled: () => Promise<void>,
  ): InstallService {
    const installed = new Set<string>();
    const registry = {
      list: () => [],
      get: (id: string) => (installed.has(id) ? { id, config: {} } : undefined),
      has: (id: string) => installed.has(id),
      register: async (e: { id: string }) => {
        installed.add(e.id);
      },
      remove: async () => {},
      markActivationFailed: async () => {},
      markActivationSucceeded: async () => {},
      updateConfig: async () => {},
      updateVersion: async () => {},
    } as unknown as InMemoryInstalledRegistry;
    const vault = {
      get: async () => undefined,
      set: async () => {},
      setMany: async () => {},
      purge: async () => {},
    } as unknown as SecretVault;
    return new InstallService({
      catalog: makeCatalog(),
      registry,
      vault,
      onInstalled,
    });
  }

  void it('reports errored when the hook threw, even with nothing on record', async () => {
    const service = makeStatuslessService(() =>
      Promise.reject(new Error('activate() threw: no sql grant')),
    );
    const created = service.create(PLUGIN);
    const job = await service.configure(created.id, {});

    assert.equal(
      job.state,
      'errored',
      'the throw was observed first-hand — a silent registry cannot overrule it',
    );
    assert.equal(job.activation_state?.ok, false);
    assert.match(String(job.activation_state?.error), /activate\(\) threw/);
  });

  void it('reports active when the hook succeeded and nothing is on record', async () => {
    // The mirror rule: silence is not a failure. Reading "no status" as
    // `errored` would break every install on a core with such a registry —
    // which is precisely what it did, across three suites, before the
    // derivation was corrected.
    const service = makeStatuslessService(() => Promise.resolve());
    const created = service.create(PLUGIN);
    const job = await service.configure(created.id, {});

    assert.equal(job.state, 'active');
    assert.equal(job.activation_state?.ok, true);
  });
});
