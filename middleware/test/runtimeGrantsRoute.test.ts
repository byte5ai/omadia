import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';
import type { Express, Request, Response, NextFunction } from 'express';

/**
 * `Response` in this file is EXPRESS's response object — the express type
 * import above wins over the global. Naming fetch's separately keeps the two
 * apart; without it every `await res.json()` below typechecks against the wrong
 * object and the assertions are worth nothing.
 */
type FetchResponse = Awaited<ReturnType<typeof fetch>>;

import { SqlPermissionError } from '@omadia/plugin-api';

import { createRuntimeRouter } from '../src/routes/runtime.js';
import { InstallService } from '../src/plugins/installService.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import type {
  PluginCatalog,
  PluginCatalogEntry,
} from '../src/plugins/manifestLoader.js';
import { createSqlGate } from '../src/platform/pluginSqlGrants.js';
import type { PluginSqlGrantRow, PluginSqlGrantStore } from '../src/platform/pluginSqlGrantStore.js';
import { LedgerAlreadyOwnedError } from '../src/platform/pluginSqlGrantStore.js';
import type { PublicPathGrantRow, PublicPathGrantStore } from '../src/platform/publicPathGrantStore.js';
import type { SecretVault } from '../src/secrets/vault.js';

/**
 * Epic #470 C16 (issue #817) — the operator consent surface for the two grants
 * a plugin can ask for.
 *
 * These tests exercise the loop an operator actually walks: the manifest asks,
 * the operator answers through ONE route, the plugin is re-activated in-process,
 * and the answer that comes back is the state the plugin is really in — not the
 * state the route hoped for. That last clause is the whole point of the issue:
 * before C16 the only way to say yes to `permissions.sql` was an `INSERT` plus a
 * restart, and `pluginSqlGrants.ts` said so twice in its own source.
 *
 * The `reactivate` wired into the harness is the REAL `InstallService.reactivate`
 * over a hook that fails exactly the way a real plugin fails when the grant is
 * missing. A stub that flipped a status field would let every assertion below
 * pass over a consent surface that never worked.
 */

const PLUGIN = '@test/grants';
const LEDGER = 'plg_test_grants_migrations';
const P_ONE = '/api/plugins/test-grants/hook';
const P_TWO = '/api/plugins/test-grants/callback';
const OPERATOR = 'operator@example.com';

// ── in-memory stores ───────────────────────────────────────────────────────
//
// Faithful to the real ones on the two properties these tests turn on: the SQL
// store enforces `UNIQUE (ledger)` across plugins, and both are keyed the way
// their tables are.

interface SqlStoreState {
  rows: Map<string, PluginSqlGrantRow>;
  failGrant?: Error;
}

function makeSqlStore(state: SqlStoreState): PluginSqlGrantStore {
  return {
    get: (pluginId) => Promise.resolve(state.rows.get(pluginId)),
    listAll: () => Promise.resolve([...state.rows.values()]),
    grant: (pluginId, ledger, grantedBy) => {
      if (state.failGrant) return Promise.reject(state.failGrant);
      for (const [otherId, row] of state.rows) {
        if (otherId !== pluginId && row.ledger === ledger) {
          return Promise.reject(new LedgerAlreadyOwnedError(ledger));
        }
      }
      state.rows.set(pluginId, {
        pluginId,
        ledger,
        grantedBy,
        grantedAt: new Date(),
      });
      return Promise.resolve();
    },
    revoke: (pluginId) => Promise.resolve(state.rows.delete(pluginId)),
  };
}

interface PathStoreState {
  rows: Map<string, PublicPathGrantRow>;
}

function pathKey(pluginId: string, prefix: string): string {
  return `${pluginId}::${prefix}`;
}

function makePathStore(state: PathStoreState): PublicPathGrantStore {
  return {
    listForPlugin: (pluginId) =>
      Promise.resolve(
        new Set(
          [...state.rows.values()]
            .filter((r) => r.pluginId === pluginId)
            .map((r) => r.pathPrefix),
        ),
      ),
    listAll: () => Promise.resolve([...state.rows.values()]),
    grant: (pluginId, pathPrefix, grantedBy) => {
      state.rows.set(pathKey(pluginId, pathPrefix), {
        pluginId,
        pathPrefix,
        grantedBy,
        grantedAt: new Date(),
      });
      return Promise.resolve();
    },
    revoke: (pluginId, pathPrefix) =>
      Promise.resolve(state.rows.delete(pathKey(pluginId, pathPrefix))),
    revokeAllForPlugin: (pluginId) => {
      let n = 0;
      for (const [key, row] of [...state.rows]) {
        if (row.pluginId !== pluginId) continue;
        state.rows.delete(key);
        n += 1;
      }
      return Promise.resolve(n);
    },
  };
}

// ── harness ────────────────────────────────────────────────────────────────

interface Harness {
  baseUrl: string;
  registry: InMemoryInstalledRegistry;
  installService: InstallService;
  sqlState: SqlStoreState;
  pathState: PathStoreState;
  /** How many times the activation hook ran — proves the route re-activated
   *  rather than merely writing a row and hoping. */
  activations: number;
  close(): Promise<void>;
}

function makeCatalog(opts: {
  declareSql: boolean;
  declarePaths: readonly string[];
}): PluginCatalog {
  const entry = {
    plugin: {
      id: PLUGIN,
      name: 'Grants Fixture',
      version: '0.1.0',
      optional_requires: ['someOptional@^1'],
      permissions_summary: {
        ...(opts.declareSql ? { sql: { ledger: LEDGER } } : {}),
        public_paths: [...opts.declarePaths],
      },
    },
    manifest: {},
    source_path: '<test>',
    source_kind: 'manifest-v1',
    // #794 — test fixtures are unprivileged: only the built-in package store
    // may assert 'bundled'.
    origin: 'installed',
  } as unknown as PluginCatalogEntry;
  return {
    get: (id: string): PluginCatalogEntry | undefined =>
      id === PLUGIN ? entry : undefined,
    list: () => [entry],
  } as unknown as PluginCatalog;
}

async function makeHarness(
  opts: {
    declareSql?: boolean;
    declarePaths?: readonly string[];
    grantedSql?: string;
    grantedPaths?: readonly string[];
    /** Whether the plugin's activation needs the SQL grant. Off for the
     *  public-path-only fixtures, so their state does not move for an
     *  unrelated reason. */
    activationNeedsSql?: boolean;
    sqlStore?: PluginSqlGrantStore | null;
  } = {},
): Promise<Harness> {
  const declareSql = opts.declareSql ?? true;
  const declarePaths = opts.declarePaths ?? [P_ONE, P_TWO];

  const registry = new InMemoryInstalledRegistry();
  await registry.register({
    id: PLUGIN,
    installed_version: '0.1.0',
    installed_at: new Date().toISOString(),
    status: 'active',
    config: {},
  });

  const sqlState: SqlStoreState = { rows: new Map() };
  if (opts.grantedSql) {
    sqlState.rows.set(PLUGIN, {
      pluginId: PLUGIN,
      ledger: opts.grantedSql,
      grantedBy: 'someone-earlier@example.com',
      grantedAt: new Date(),
    });
  }
  const pathState: PathStoreState = { rows: new Map() };
  for (const prefix of opts.grantedPaths ?? []) {
    pathState.rows.set(pathKey(PLUGIN, prefix), {
      pluginId: PLUGIN,
      pathPrefix: prefix,
      grantedBy: 'someone-earlier@example.com',
      grantedAt: new Date(),
    });
  }

  const sqlStore =
    opts.sqlStore === null ? undefined : (opts.sqlStore ?? makeSqlStore(sqlState));
  const publicPathGrantStore = makePathStore(pathState);
  const catalog = makeCatalog({ declareSql, declarePaths });

  const harness: Partial<Harness> = { activations: 0 };

  const vault = {
    get: () => Promise.resolve(undefined),
    setMany: () => Promise.resolve(),
    purge: () => Promise.resolve(),
  } as unknown as SecretVault;

  const installService = new InstallService({
    catalog,
    registry,
    vault,
    publicPathGrantStore,
    ...(sqlStore ? { sqlGrantStore: sqlStore } : {}),
    onUninstall: () => Promise.resolve(),
    // THE PLUGIN ITSELF. It reaches for the database at activate exactly as a
    // real `permissions.sql` consumer does, and throws the real error type when
    // the operator has not granted it.
    onInstalled: async (agentId) => {
      harness.activations = (harness.activations ?? 0) + 1;
      if (!(opts.activationNeedsSql ?? true)) return;
      const row = await sqlStore?.get(agentId);
      if (row?.ledger !== LEDGER) {
        throw new SqlPermissionError(agentId, 'graphPool', 'ungranted');
      }
    },
  });

  const app: Express = express();
  app.use(express.json());
  // The router is mounted behind `requireAuth` in production; the session is
  // what `granted_by` is read from, so the harness supplies one.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Only `email` matters here — it is what `actorOf` reads. Cast rather than
    // fabricating a full SessionClaims: inventing the other four fields would
    // suggest the route reads them, and it must not.
    Object.assign(req, { session: { email: OPERATOR } });
    next();
  });
  const stub = { names: () => [], counts: () => ({}) };
  app.use(
    '/api/v1/admin/runtime',
    createRuntimeRouter({
      installedRegistry: registry,
      serviceRegistry: stub as never,
      turnHookRegistry: stub as never,
      backgroundJobRegistry: stub as never,
      chatAgentWrapRegistry: { labels: () => [], count: () => 0 } as never,
      promptContributionRegistry: { labels: () => [], count: () => 0 } as never,
      catalog,
      publicPathGrantStore,
      ...(sqlStore ? { sqlGrantStore: sqlStore } : {}),
      reactivate: async (agentId) => {
        await installService.reactivate(agentId);
      },
    }),
  );

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;

  Object.assign(harness, {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    registry,
    installService,
    sqlState,
    pathState,
    close: () =>
      new Promise<void>((resolve) => server.close(() => resolve())),
  });
  return harness as Harness;
}

function grantsUrl(h: Harness): string {
  return `${h.baseUrl}/api/v1/admin/runtime/installed/${encodeURIComponent(PLUGIN)}/grants`;
}

function putGrants(h: Harness, body: unknown): Promise<FetchResponse> {
  return fetch(grantsUrl(h), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ── consent may never exceed the declaration ───────────────────────────────

void describe('#470 C16 — consent cannot exceed the declaration', () => {
  void it('refuses `sql: true` for a plugin that declares no permissions.sql', async () => {
    const h = await makeHarness({
      declareSql: false,
      activationNeedsSql: false,
    });
    try {
      const res = await putGrants(h, { sql: true });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { code: string; message: string };
      assert.equal(body.code, 'runtime.sql_not_declared');
      assert.match(body.message, /consent cannot exceed the declaration/);
      assert.equal(
        h.sqlState.rows.size,
        0,
        'a refused consent must not write a row',
      );
    } finally {
      await h.close();
    }
  });

  void it('refuses a public path the manifest never declared', async () => {
    const h = await makeHarness({ declarePaths: [P_ONE] });
    try {
      const res = await putGrants(h, { public_paths: [P_ONE, P_TWO] });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { code: string };
      assert.equal(body.code, 'runtime.public_path_not_declared');
      assert.equal(
        h.pathState.rows.size,
        0,
        'the DECLARED half must not be written either — the request is refused whole',
      );
    } finally {
      await h.close();
    }
  });

  void it('refuses a body that speaks to no grant at all', async () => {
    const h = await makeHarness();
    try {
      const res = await putGrants(h, { sqll: true });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { code: string };
      assert.equal(body.code, 'runtime.invalid_grants');
    } finally {
      await h.close();
    }
  });
});

// ── the consent record records the consenting party ────────────────────────

void describe('#470 C16 — granted_by comes from the session', () => {
  void it('writes the session identity, and the manifest ledger, ignoring the body', async () => {
    const h = await makeHarness();
    try {
      const res = await putGrants(h, {
        sql: true,
        // Both are attacker-controlled in the general case and both must be
        // ignored: a consent record the consenting party can dictate records
        // nothing, and a body-supplied ledger would let this route grant a
        // table no operator ever saw named.
        granted_by: 'attacker@example.com',
        ledger: 'plg_test_grants_somewhere_else',
      });
      assert.equal(res.status, 200);
      const row = h.sqlState.rows.get(PLUGIN);
      assert.ok(row, 'the grant must be written');
      assert.equal(row.grantedBy, OPERATOR);
      assert.equal(row.ledger, LEDGER);
    } finally {
      await h.close();
    }
  });

  void it('writes the session identity on public-path grants too', async () => {
    const h = await makeHarness({ activationNeedsSql: false });
    try {
      const res = await putGrants(h, { public_paths: [P_ONE] });
      assert.equal(res.status, 200);
      const row = h.pathState.rows.get(pathKey(PLUGIN, P_ONE));
      assert.equal(row?.grantedBy, OPERATOR);
    } finally {
      await h.close();
    }
  });
});

// ── the grant takes effect without a restart ───────────────────────────────

void describe('#470 C16 — the grant takes effect in-process', () => {
  void it('re-activates and reports `active` — no restart', async () => {
    // Start from the state issue #817 describes: declared, ungranted, and the
    // plugin errored because its activate() could not reach the database.
    // SQL only, so `missing` speaks to exactly the grant under test.
    const h = await makeHarness({ declarePaths: [] });
    try {
      await h.registry.markActivationFailed(PLUGIN, 'ungranted');
      await h.registry.register({
        ...h.registry.get(PLUGIN)!,
        status: 'errored',
      });
      assert.equal(h.registry.get(PLUGIN)?.status, 'errored');

      const before = h.activations;
      const res = await putGrants(h, { sql: true });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        state: string;
        granted: { sql: boolean };
        missing: unknown[];
        last_activation_error: string | null;
      };

      assert.equal(
        h.activations,
        before + 1,
        'the route must re-activate the plugin, not just write a row',
      );
      assert.equal(body.state, 'active', 'the resulting state is reported back');
      assert.equal(body.granted.sql, true);
      assert.deepEqual(body.missing, []);
      assert.equal(
        body.last_activation_error,
        null,
        'the stale failure must be cleared, or the panel keeps showing a fixed problem',
      );
      assert.equal(h.registry.get(PLUGIN)?.status, 'active');
    } finally {
      await h.close();
    }
  });

  void it('revoking takes the plugin back to `errored`, with the reason and the remedy', async () => {
    const h = await makeHarness({ grantedSql: LEDGER, declarePaths: [] });
    try {
      const res = await putGrants(h, { sql: false });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        state: string;
        granted: { sql: boolean };
        missing: { kind: string; ledger?: string }[];
        last_activation_error: string | null;
      };

      assert.equal(
        body.state,
        'errored',
        'the route reports what the re-activation actually did, not that the write succeeded',
      );
      assert.equal(body.granted.sql, false);
      assert.deepEqual(body.missing, [{ kind: 'sql', ledger: LEDGER }]);
      // Item 4 of C16: the activation error names the missing grant AND where
      // to fix it. Before this, an operator got "stays unavailable until the
      // grant is recorded" with no way to record one.
      assert.match(body.last_activation_error ?? '', /permissions\.sql/);
      assert.match(body.last_activation_error ?? '', /grants/);
      assert.equal(h.sqlState.rows.size, 0);
    } finally {
      await h.close();
    }
  });

  void it('reports a grant left over for a ledger the manifest no longer declares', async () => {
    // A plugin update that moves its ledger must not carry the old consent
    // forward — the operator granted a specific table.
    const h = await makeHarness({
      grantedSql: 'plg_test_grants_old',
      declarePaths: [],
    });
    try {
      const res = await fetch(grantsUrl(h));
      const body = (await res.json()) as {
        granted: { sql: boolean; sql_ledger: string | null };
        missing: { kind: string }[];
      };
      assert.equal(body.granted.sql, false, 'a stale ledger is not consent');
      assert.equal(
        body.granted.sql_ledger,
        'plg_test_grants_old',
        'what IS on record is still shown, so "not granted" and "granted elsewhere" stay distinguishable',
      );
      assert.deepEqual(body.missing, [{ kind: 'sql', ledger: LEDGER }]);
    } finally {
      await h.close();
    }
  });
});

// ── a revoked grant denies at the next activation ──────────────────────────

void describe('#470 C16 — a revoked grant denies the pool', () => {
  void it('the next SQL gate throws SqlPermissionError(ungranted)', async () => {
    const h = await makeHarness({ grantedSql: LEDGER });
    try {
      const res = await putGrants(h, { sql: false });
      assert.equal(res.status, 200);

      // What the next activation does: read the grant, then build the gate.
      const row = h.sqlState.rows.get(PLUGIN);
      const gate = createSqlGate({
        agentId: PLUGIN,
        catalog: makeCatalog({ declareSql: true, declarePaths: [] }),
        granted: row?.ledger === LEDGER,
        legacyCapabilities: [],
        log: () => undefined,
      });
      assert.throws(
        () => {
          gate('graphPool');
        },
        (err: unknown) => {
          assert.ok(err instanceof SqlPermissionError);
          assert.equal(
            err.reason,
            'ungranted',
            "'ungranted' is the operator's to fix; 'undeclared' would send the operator chasing the plugin author",
          );
          return true;
        },
      );
    } finally {
      await h.close();
    }
  });
});

// ── the ledger is exclusive ────────────────────────────────────────────────

void describe('#470 C16 — ledger collisions are named, not raw 23505s', () => {
  void it('answers 409 when another plugin already owns the ledger', async () => {
    const sqlState: SqlStoreState = { rows: new Map() };
    sqlState.rows.set('@other/plugin', {
      pluginId: '@other/plugin',
      ledger: LEDGER,
      grantedBy: 'someone@example.com',
      grantedAt: new Date(),
    });
    const h = await makeHarness({ sqlStore: makeSqlStore(sqlState) });
    try {
      const res = await putGrants(h, { sql: true });
      assert.equal(res.status, 409);
      const body = (await res.json()) as { code: string };
      assert.equal(body.code, 'runtime.ledger_already_owned');
    } finally {
      await h.close();
    }
  });
});

// ── no database ────────────────────────────────────────────────────────────

void describe('#470 C16 — no database configured', () => {
  void it('answers 503 rather than pretending the grant was recorded', async () => {
    const h = await makeHarness({ sqlStore: null, activationNeedsSql: false });
    try {
      const res = await putGrants(h, { sql: true });
      assert.equal(res.status, 503);
      const body = (await res.json()) as { code: string };
      assert.equal(body.code, 'runtime.sql_grants_unavailable');
    } finally {
      await h.close();
    }
  });
});

// ── the old route still works ──────────────────────────────────────────────

void describe('#470 C16 — the /public-paths alias keeps its contract', () => {
  void it('GET answers the old shape', async () => {
    const h = await makeHarness({
      grantedPaths: [P_ONE],
      activationNeedsSql: false,
    });
    try {
      const res = await fetch(
        `${h.baseUrl}/api/v1/admin/runtime/installed/${encodeURIComponent(PLUGIN)}/public-paths`,
      );
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        id: string;
        declared: string[];
        paths: { path: string; granted: boolean }[];
        orphaned: string[];
      };
      assert.equal(body.id, PLUGIN);
      assert.deepEqual(body.declared, [P_ONE, P_TWO]);
      assert.deepEqual(body.paths, [
        { path: P_ONE, granted: true },
        { path: P_TWO, granted: false },
      ]);
      assert.deepEqual(body.orphaned, []);
    } finally {
      await h.close();
    }
  });

  void it('PUT still takes { paths } and answers { id, paths }', async () => {
    const h = await makeHarness({
      grantedPaths: [P_ONE],
      activationNeedsSql: false,
    });
    try {
      // The complete set: grants P_TWO, revokes P_ONE.
      const res = await fetch(
        `${h.baseUrl}/api/v1/admin/runtime/installed/${encodeURIComponent(PLUGIN)}/public-paths`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ paths: [P_TWO] }),
        },
      );
      assert.equal(res.status, 200);
      const body = (await res.json()) as { id: string; paths: string[] };
      assert.deepEqual(body, { id: PLUGIN, paths: [P_TWO] });
      assert.equal(h.pathState.rows.has(pathKey(PLUGIN, P_ONE)), false);
      assert.equal(h.pathState.rows.has(pathKey(PLUGIN, P_TWO)), true);
    } finally {
      await h.close();
    }
  });

  void it('PUT still refuses an undeclared path with the same code', async () => {
    const h = await makeHarness({
      declarePaths: [P_ONE],
      activationNeedsSql: false,
    });
    try {
      const res = await fetch(
        `${h.baseUrl}/api/v1/admin/runtime/installed/${encodeURIComponent(PLUGIN)}/public-paths`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ paths: ['/api/plugins/somebody-else/x'] }),
        },
      );
      assert.equal(res.status, 400);
      const body = (await res.json()) as { code: string };
      assert.equal(body.code, 'runtime.public_path_not_declared');
    } finally {
      await h.close();
    }
  });
});

// ── B6: consent does not outlive the plugin ────────────────────────────────

void describe('#470 C16 / B6 — uninstall clears both grant tables', () => {
  void it('removes the SQL grant and every public-path grant', async () => {
    const h = await makeHarness({
      grantedSql: LEDGER,
      grantedPaths: [P_ONE, P_TWO],
    });
    try {
      assert.equal(h.sqlState.rows.size, 1);
      assert.equal(h.pathState.rows.size, 2);

      await h.installService.uninstall(PLUGIN);

      assert.equal(h.sqlState.rows.size, 0, 'plugin_sql_grants must be empty');
      assert.equal(
        h.pathState.rows.size,
        0,
        'plugin_public_path_grants must be empty',
      );
      assert.equal(h.registry.has(PLUGIN), false);
    } finally {
      await h.close();
    }
  });

  void it('leaves another plugin’s grants alone', async () => {
    const h = await makeHarness({ grantedSql: LEDGER, grantedPaths: [P_ONE] });
    try {
      h.sqlState.rows.set('@other/plugin', {
        pluginId: '@other/plugin',
        ledger: 'plg_other_plugin_migrations',
        grantedBy: OPERATOR,
        grantedAt: new Date(),
      });
      h.pathState.rows.set(pathKey('@other/plugin', '/api/plugins/other/x'), {
        pluginId: '@other/plugin',
        pathPrefix: '/api/plugins/other/x',
        grantedBy: OPERATOR,
        grantedAt: new Date(),
      });

      await h.installService.uninstall(PLUGIN);

      assert.equal(h.sqlState.rows.size, 1);
      assert.ok(h.sqlState.rows.has('@other/plugin'));
      assert.equal(h.pathState.rows.size, 1);
    } finally {
      await h.close();
    }
  });

  void it('a reinstall under the same id starts un-granted', async () => {
    const h = await makeHarness({
      grantedSql: LEDGER,
      grantedPaths: [P_ONE, P_TWO],
    });
    try {
      await h.installService.uninstall(PLUGIN);
      await h.registry.register({
        id: PLUGIN,
        installed_version: '0.2.0',
        installed_at: new Date().toISOString(),
        status: 'active',
        config: {},
      });

      const res = await fetch(grantsUrl(h));
      const body = (await res.json()) as {
        granted: { sql: boolean; public_paths: string[] };
        missing: unknown[];
      };
      assert.equal(
        body.granted.sql,
        false,
        'the new package must not inherit the old one’s database',
      );
      assert.deepEqual(
        body.granted.public_paths,
        [],
        'nor its unauthenticated surface',
      );
      assert.equal(body.missing.length, 3);
    } finally {
      await h.close();
    }
  });
});

// ── the view ───────────────────────────────────────────────────────────────

void describe('#470 C16 — GET /grants describes the whole ask', () => {
  void it('reports declaration, consent, state and what is missing', async () => {
    const h = await makeHarness({
      grantedSql: LEDGER,
      grantedPaths: [P_ONE],
    });
    try {
      const res = await fetch(grantsUrl(h));
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        id: string;
        declared: {
          sql: { ledger: string } | null;
          public_paths: string[];
          optional_requires: string[];
        };
        granted: { sql: boolean; public_paths: string[] };
        state: string;
        missing: { kind: string; path?: string }[];
      };
      assert.equal(body.id, PLUGIN);
      assert.equal(body.declared.sql?.ledger, LEDGER);
      assert.deepEqual(body.declared.public_paths, [P_ONE, P_TWO]);
      assert.deepEqual(body.declared.optional_requires, ['someOptional@^1']);
      assert.equal(body.granted.sql, true);
      assert.deepEqual(body.granted.public_paths, [P_ONE]);
      assert.equal(body.state, 'active');
      assert.deepEqual(body.missing, [{ kind: 'public_path', path: P_TWO }]);
    } finally {
      await h.close();
    }
  });

  void it('404s for a plugin that is not installed', async () => {
    const h = await makeHarness();
    try {
      const res = await fetch(
        `${h.baseUrl}/api/v1/admin/runtime/installed/@test%2Fnope/grants`,
      );
      assert.equal(res.status, 404);
    } finally {
      await h.close();
    }
  });
});
