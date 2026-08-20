/**
 * Epic #470 C7 / G4 — `permissions.sql`, ledger ownership, and the pool gate.
 *
 * These are the pure, offline halves: the decision table and the name
 * validation. The database-backed half (advisory lock, ledger, checksums)
 * lives in `pluginMigrations.pg.test.ts`, which needs a real Postgres because
 * the properties it asserts — a lock that actually serialises, a UNIQUE that
 * actually rejects — cannot be exercised against a fake that has them by
 * construction.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { LedgerNameError, SqlPermissionError } from '@omadia/plugin-api';

import {
  assertLedgerName,
  classifySqlAccess,
  createSqlGate,
  isValidLedgerName,
  LEDGER_NAME_RE,
  PLUGIN_LEDGER_NAMESPACE,
  parseSqlPermission,
  POOL_SHAPED_CAPABILITIES,
  sanitizedPluginPrefix,
} from '../src/platform/pluginSqlGrants.js';
import { PluginCatalog } from '../src/plugins/manifestLoader.js';

const PLUGIN = '@omadia/verifier';
const SANITIZED = 'omadia_verifier';
const PREFIX = `${PLUGIN_LEDGER_NAMESPACE}${SANITIZED}_`;
const LEDGER = `${PREFIX}migrations`;

/** Minimal catalog stub. Only the two fields the gate reads are populated —
 *  a fuller fixture would make it harder to see which of them the decision
 *  actually turns on. */
function catalogWith(
  entries: Record<string, { sql?: { ledger: string; migrations?: string } }>,
): PluginCatalog {
  const catalog = new PluginCatalog();
  const map = new Map(
    Object.entries(entries).map(([id, cfg]) => [
      id,
      {
        plugin: {
          id,
          permissions_summary: cfg.sql ? { sql: cfg.sql } : {},
        },
      },
    ]),
  );
  (catalog as unknown as { entries: unknown }).entries = map;
  return catalog;
}

describe('#470 C7 — ledger name validation', () => {
  it('derives the prefix from the FULL plugin id, not its last segment', () => {
    // The whole point: `@omadia/verifier` and `@acme/verifier` must not derive
    // the same prefix, or the ownership check is blind to the collision it
    // exists to catch.
    assert.equal(sanitizedPluginPrefix('@omadia/verifier'), 'omadia_verifier');
    assert.equal(sanitizedPluginPrefix('@acme/verifier'), 'acme_verifier');
    assert.notEqual(
      sanitizedPluginPrefix('@omadia/verifier'),
      sanitizedPluginPrefix('@acme/verifier'),
    );
  });

  it('accepts a well-formed, correctly-prefixed name', () => {
    assert.equal(assertLedgerName(PLUGIN, LEDGER), LEDGER);
  });

  it("rejects another plugin's prefix — the hijack this rule exists for", () => {
    assert.throws(
      () => assertLedgerName(PLUGIN, 'plg_acme_tool_migrations'),
      (err: unknown) => {
        assert.ok(err instanceof LedgerNameError);
        assert.match(err.message, /must start with this plugin's reserved prefix/);
        return true;
      },
    );
  });

  it('rejects core ledgers — a plugin must not be able to forge core history', () => {
    for (const core of ['tasks', 'plugin_sql_grants', 'agents']) {
      assert.throws(
        () => assertLedgerName(PLUGIN, core),
        LedgerNameError,
        `expected '${core}' to be refused`,
      );
    }
  });

  it('rejects a core table even when the plugin id FOLDS to that exact name', () => {
    // The decisive case for the reserved namespace, and the one the old
    // "starts with the sanitized id" rule could not see. These plugin ids fold
    // onto real core table names, so under the old rule the plugin's own
    // prefix WAS the core table and `startsWith` returned true — after which
    // `CREATE TABLE IF NOT EXISTS "tasks"` adopts core's table instead of
    // creating a ledger. Nothing downstream re-checks the name, so the only
    // thing that stopped a write was the adopted table happening to lack the
    // ledger's columns. That is a coincidence of column shape, not a rule.
    //
    // Under the mandatory `plg_` namespace it cannot arise: no core table is
    // inside the namespace, so the syntactic check now carries the guarantee
    // its own doc comment claims.
    for (const [pluginId, coreTable] of [
      ['@tasks', 'tasks'],
      ['@agents', 'agents'],
      ['@plugin/sql', 'plugin_sql_grants'],
    ] as const) {
      assert.equal(
        coreTable.startsWith(sanitizedPluginPrefix(pluginId)),
        true,
        `precondition: '${pluginId}' must still fold onto '${coreTable}', or this test no longer covers the hole it was written for`,
      );
      assert.throws(
        () => assertLedgerName(pluginId, coreTable),
        LedgerNameError,
        `expected '${pluginId}' to be refused the core table '${coreTable}'`,
      );
    }
  });

  it('rejects SQL-injection shaped names before they can reach DDL', () => {
    // Each of these is a name that, interpolated unvalidated into
    // `CREATE TABLE <x>`, changes the statement's meaning. The allowlist has
    // to reject them by CHARSET — an escaping approach would have to be right
    // about every one of them individually.
    const injections = [
      `${PREFIX}x"; DROP TABLE users; --`,
      `${PREFIX}x"; DELETE FROM plugin_sql_grants; --`,
      `${PREFIX}x" , "y`,
      `${PREFIX}x--`,
      `${PREFIX}x;`,
      `${PREFIX}x'`,
      `${PREFIX}x users`,
      `${PREFIX}x\nDROP TABLE t`,
      `${PREFIX}x\u0000`,
      `${PREFIX}x.y`,
      `${PREFIX}x-x`,
      `pg_catalog.${PREFIX}x`,
    ];
    for (const name of injections) {
      assert.throws(
        () => assertLedgerName(PLUGIN, name),
        LedgerNameError,
        `expected ${JSON.stringify(name)} to be refused`,
      );
      assert.equal(
        isValidLedgerName(PLUGIN, name),
        false,
        `predicate disagreed with the throwing form for ${JSON.stringify(name)}`,
      );
    }
  });

  it('rejects names outside the charset even with the right prefix', () => {
    assert.throws(
      () => assertLedgerName(PLUGIN, `${PREFIX}MIGRATIONS`), // uppercase
      LedgerNameError,
    );
    assert.throws(
      () => assertLedgerName(PLUGIN, `${PREFIX}${'x'.repeat(64)}`),
      (err: unknown) => {
        assert.ok(err instanceof LedgerNameError);
        assert.match(err.message, /leaves room for at most/);
        return true;
      },
    );
  });

  it('rejects a plugin id whose mandatory namespace leaves no room for a suffix', () => {
    const pluginId = `@${'a'.repeat(58)}`;
    const ledger = `plg_${'a'.repeat(58)}_x`;
    assert.throws(
      () => assertLedgerName(pluginId, ledger),
      (err: unknown) => {
        assert.ok(err instanceof LedgerNameError);
        assert.match(err.message, /leaves no room for the required suffix/);
        return true;
      },
    );
  });

  it('the regex itself is anchored at both ends', () => {
    // An unanchored regex would `test` true for anything CONTAINING a legal
    // name, which is exactly how a charset allowlist silently stops working.
    assert.equal(LEDGER_NAME_RE.test('abc'), true);
    assert.equal(LEDGER_NAME_RE.test('abc; DROP TABLE t'), false);
    assert.equal(LEDGER_NAME_RE.test('DROP TABLE t; abc'), false);
    assert.equal(LEDGER_NAME_RE.test('a\nabc'), false);
  });
});

describe('#470 C7 — permissions.sql parsing', () => {
  const silently = (): void => undefined;

  it('parses a full block', () => {
    const parsed = parseSqlPermission(
      { ledger: LEDGER, migrations: 'db/migrations' },
      PLUGIN,
      silently,
    );
    assert.deepEqual(parsed, { ledger: LEDGER, migrations: 'db/migrations' });
  });

  it('omits `migrations` when the manifest does not declare it', () => {
    const parsed = parseSqlPermission({ ledger: LEDGER }, PLUGIN, silently);
    assert.deepEqual(parsed, { ledger: LEDGER });
  });

  it('drops the whole block when the ledger is not ownable — fail closed', () => {
    // Dropping is the safe direction: no block means no permission, which is
    // one fewer plugin holding the operator's database, never one more.
    assert.equal(
      parseSqlPermission({ ledger: 'plg_acme_other_mig' }, PLUGIN, silently),
      undefined,
    );
    assert.equal(
      parseSqlPermission({ ledger: 'x"; DROP TABLE t; --' }, PLUGIN, silently),
      undefined,
    );
    assert.equal(parseSqlPermission({}, PLUGIN, silently), undefined);
    assert.equal(parseSqlPermission('yes', PLUGIN, silently), undefined);
    assert.equal(parseSqlPermission([LEDGER], PLUGIN, silently), undefined);
    assert.equal(parseSqlPermission(undefined, PLUGIN, silently), undefined);
  });
});

describe('#470 C7 — pool-gate decision table', () => {
  const base = {
    capability: 'graphPool',
    legacy: false,
    bundledLegacy: false,
  } as const;
  const declared = { ledger: LEDGER };

  it('graphPool is the gated capability — and the gate set is closed', () => {
    assert.ok(POOL_SHAPED_CAPABILITIES.has('graphPool'));
    // A heuristic would have silently stopped gating on a rename; a closed set
    // fails the reviewable way instead.
    assert.equal(POOL_SHAPED_CAPABILITIES.has('graph'), false);
  });

  it('leaves non-pool capabilities entirely alone', () => {
    assert.equal(
      classifySqlAccess({
        capability: 'knowledgeGraph',
        declared: undefined,
        granted: false,
        legacy: false,
        bundledLegacy: false,
      }),
      'not-pool-shaped',
    );
  });

  it('undeclared → undeclared (the author fixes this)', () => {
    assert.equal(
      classifySqlAccess({ ...base, declared: undefined, granted: false }),
      'undeclared',
    );
    // Granting a plugin that never declared still does not open the pool: the
    // operator cannot have consented to a request that was never shown.
    assert.equal(
      classifySqlAccess({ ...base, declared: undefined, granted: true }),
      'undeclared',
    );
  });

  it('declared but ungranted → ungranted (the OPERATOR fixes this)', () => {
    assert.equal(
      classifySqlAccess({ ...base, declared, granted: false }),
      'ungranted',
    );
  });

  it('declared AND granted → allowed', () => {
    assert.equal(
      classifySqlAccess({ ...base, declared, granted: true }),
      'allowed',
    );
  });

  it('legacy ramp applies only when the clean path already failed', () => {
    assert.equal(
      classifySqlAccess({
        ...base,
        declared: undefined,
        granted: false,
        legacy: true,
      }),
      'legacy-allowlist',
    );
    // A plugin that has done the work is reported as `allowed`, never as
    // legacy — otherwise the ramp could never be observed to be empty.
    assert.equal(
      classifySqlAccess({ ...base, declared, granted: true, legacy: true }),
      'allowed',
    );
  });

  it('#794 — the BUNDLED ramp covers a plugin that did C2b\'s work correctly', () => {
    // The #794 shape exactly: `permissions.sql` declared, no operator grant
    // (nothing in `src/` calls `grant()` yet), and NOT on C2b's list precisely
    // because its `requires:` is correct. Before the bundled ramp this fell
    // through to `ungranted` and threw on the boot path.
    assert.equal(
      classifySqlAccess({
        ...base,
        declared,
        granted: false,
        legacy: false,
        bundledLegacy: true,
      }),
      'bundled-legacy',
    );
    // Same for a bundled plugin that has not declared yet — the ramp keeps it
    // booting rather than making the manifest fix a prerequisite for boot.
    assert.equal(
      classifySqlAccess({
        ...base,
        declared: undefined,
        granted: false,
        bundledLegacy: true,
      }),
      'bundled-legacy',
    );
  });

  it('#794 — the bundled ramp is the reason reported when both ramps apply', () => {
    // Both true is the normal state for orchestrator/verifier/extras. The
    // bundled reason is the accurate one and names the right remedy.
    assert.equal(
      classifySqlAccess({
        ...base,
        declared: undefined,
        granted: false,
        legacy: true,
        bundledLegacy: true,
      }),
      'bundled-legacy',
    );
  });

  it('#794 — a granted, declared plugin is never reported as bundled-legacy', () => {
    // Otherwise the ramp could never be observed to be empty, and its
    // retirement date would be unfalsifiable.
    assert.equal(
      classifySqlAccess({
        ...base,
        declared,
        granted: true,
        bundledLegacy: true,
      }),
      'allowed',
    );
  });
});

describe('#470 C7 — createSqlGate', () => {
  it('denies an undeclared plugin with a typed, actionable error', () => {
    const gate = createSqlGate({
      agentId: PLUGIN,
      catalog: catalogWith({ [PLUGIN]: {} }),
      granted: true,
      legacyCapabilities: [],
      log: () => undefined,
    });
    assert.throws(
      () => {
        gate('graphPool');
      },
      (err: unknown) => {
        assert.ok(err instanceof SqlPermissionError);
        assert.equal(err.reason, 'undeclared');
        assert.equal(err.pluginId, PLUGIN);
        assert.equal(err.capability, 'graphPool');
        assert.match(err.message, /permissions\.sql/);
        return true;
      },
    );
  });

  it('denies a declared-but-ungranted plugin, and says whose problem it is', () => {
    const gate = createSqlGate({
      agentId: PLUGIN,
      catalog: catalogWith({ [PLUGIN]: { sql: { ledger: LEDGER } } }),
      granted: false,
      legacyCapabilities: [],
      log: () => undefined,
    });
    assert.throws(
      () => {
        gate('graphPool');
      },
      (err: unknown) => {
        assert.ok(err instanceof SqlPermissionError);
        assert.equal(err.reason, 'ungranted');
        // The two reasons must not read alike — one is the author's to fix,
        // the other the operator's.
        assert.match(err.message, /operator has not granted/);
        return true;
      },
    );
  });

  it('allows a declared AND granted plugin', () => {
    const gate = createSqlGate({
      agentId: PLUGIN,
      catalog: catalogWith({ [PLUGIN]: { sql: { ledger: LEDGER } } }),
      granted: true,
      legacyCapabilities: [],
      log: () => undefined,
    });
    assert.doesNotThrow(() => {
      gate('graphPool');
    });
  });

  it('pins the read-once contract: revocation does not disarm a LIVE plugin', () => {
    // Documented behaviour, deliberately pinned rather than left implicit.
    //
    // The grant is resolved ONCE, before the context is built, because
    // `ctx.services.get` is synchronous and cannot await a database read. The
    // consequence is security-relevant and easy to miss: deleting the row via
    // `PluginSqlGrantStore.revoke()` does NOT reach into a plugin that is
    // already running — the gate it holds is a closure over the boolean taken
    // at activate time. Revocation stops the NEXT activation; an operator who
    // needs access gone now must deactivate/reactivate.
    //
    // This test exists so that changing that — in either direction, to a live
    // lookup or to something even lazier — has to be a deliberate edit here
    // and a matching edit to the doc comments on `revoke` and `sqlGranted`,
    // rather than a silent drift.
    const gate = createSqlGate({
      agentId: PLUGIN,
      catalog: catalogWith({ [PLUGIN]: { sql: { ledger: LEDGER } } }),
      granted: true,
      legacyCapabilities: [],
      log: () => undefined,
    });

    // A revoke lands in the database here. Nothing about it can reach `gate`:
    // there is no store reference to re-read and no cache to invalidate.
    assert.doesNotThrow(() => {
      gate('graphPool');
    }, 'a live plugin keeps its access for the life of the activation');

    // The next activation builds a NEW gate from the NEW answer, and that one
    // denies — which is where revocation actually takes effect.
    const afterReactivation = createSqlGate({
      agentId: PLUGIN,
      catalog: catalogWith({ [PLUGIN]: { sql: { ledger: LEDGER } } }),
      granted: false,
      legacyCapabilities: [],
      log: () => undefined,
    });
    assert.throws(
      () => {
        afterReactivation('graphPool');
      },
      (err: unknown) => {
        assert.ok(err instanceof SqlPermissionError);
        assert.equal(err.reason, 'ungranted');
        return true;
      },
    );
  });

  it('never blocks a non-pool capability, however ungranted', () => {
    const gate = createSqlGate({
      agentId: PLUGIN,
      catalog: catalogWith({ [PLUGIN]: {} }),
      granted: false,
      legacyCapabilities: [],
      log: () => undefined,
    });
    assert.doesNotThrow(() => {
      gate('knowledgeGraph');
    });
  });

  it('warns ONCE on the legacy ramp, not once per call', () => {
    // A pool resolved inside a per-turn hot path would otherwise flood the log
    // until the warning is worth nothing.
    const lines: string[] = [];
    const gate = createSqlGate({
      agentId: PLUGIN,
      catalog: catalogWith({ [PLUGIN]: {} }),
      granted: false,
      legacyCapabilities: ['graphPool'],
      log: (...args) => lines.push(String(args[0])),
    });
    for (let i = 0; i < 5; i++) gate('graphPool');
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? '', /legacy allowlist/);
  });

  it('a plugin absent from the catalog is granted nothing', () => {
    const gate = createSqlGate({
      agentId: 'ghost',
      catalog: catalogWith({}),
      granted: true,
      legacyCapabilities: [],
      log: () => undefined,
    });
    assert.throws(() => {
      gate('graphPool');
    }, SqlPermissionError);
  });
});
