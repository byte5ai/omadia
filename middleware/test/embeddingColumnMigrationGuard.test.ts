import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { EmbeddingClient } from '@omadia/plugin-api';
import type { Pool, PoolClient, QueryResult } from 'pg';

import {
  resolveColumnMigrationPermission,
  type GovernedVectorColumn,
} from '@omadia/knowledge-graph-neon/dist/embeddingModelGate.js';
import { startGateRunner } from '@omadia/knowledge-graph-neon/dist/gateReevaluation.js';
import { areGovernedColumnsEmpty } from '@omadia/knowledge-graph-neon/dist/vectorCorpusEmptiness.js';
import { migrateVectorColumns } from '@omadia/knowledge-graph-neon/dist/vectorColumnMigration.js';

/**
 * OM-98 — the GATE half of "reactivate a provider stuck behind a width
 * mismatch". The route half lives in `adminEmbeddingProviderReactivate.test.ts`.
 *
 * Everything here is about ONE property: the non-destructive rebuild must be
 * reachable exactly when the governed vector columns are empty, and must fail
 * CLOSED in every other case — populated, unknowable, or forbidden by the
 * `auto_migrate_vector_columns` master switch. It is the only path in this
 * subsystem that drops a column without an operator confirmation, so "we could
 * not tell" has to read as "no", never as "probably fine".
 *
 * A fake driver rather than Postgres because the interesting inputs are the
 * ones a real database will not produce on demand: a count that TIMES OUT, and
 * a corpus that gains vectors between the pre-lock check and the lock.
 * `embeddingModelGateMigrationGuards.pg.test.ts` covers the real semantics.
 */

const silent = (): void => undefined;

const MISMATCH: readonly GovernedVectorColumn[] = [
  { table: 'graph_nodes', column: 'embedding', declaredDimensions: 768 },
  { table: 'processes', column: 'embedding', declaredDimensions: 768 },
];

const rows = (r: ReadonlyArray<Record<string, unknown>>): QueryResult =>
  ({
    command: '',
    rowCount: r.length,
    oid: 0,
    rows: [...r],
    fields: [],
  }) as unknown as QueryResult;

interface ProbePool {
  pool: Pool;
  sql: string[];
  released: number;
}

/**
 * A pool whose only interesting statement is the emptiness probe.
 * `hasVectors: undefined` makes it throw, which is what a `statement_timeout`
 * on the probe looks like from here.
 *
 * Cato-Audit Runde 5 / OM-98: the fake answers a TENANT-SCOPED probe and a
 * TABLE-WIDE probe differently, so a regression back to `WHERE tenant_id = $1`
 * shows up as a wrong verdict rather than as an identical green test. The
 * scoped answer is always "this tenant owns nothing" — the empty-tenant case
 * that used to authorise dropping every other tenant's embeddings.
 */
function makeProbePool(hasVectors: boolean | undefined): ProbePool {
  const state: ProbePool = { pool: undefined as unknown as Pool, sql: [], released: 0 };
  const query = async (text: string): Promise<QueryResult> => {
    state.sql.push(text);
    if (/AS has_vectors/i.test(text)) {
      if (hasVectors === undefined) {
        const err = new Error('canceling statement due to statement timeout');
        (err as Error & { code?: string }).code = '57014';
        throw err;
      }
      if (/tenant_id/i.test(text)) return rows([{ has_vectors: false }]);
      return rows([{ has_vectors: hasVectors }]);
    }
    return rows([]);
  };
  state.pool = {
    async connect(): Promise<PoolClient> {
      return {
        query,
        release(): void {
          state.released += 1;
        },
      } as unknown as PoolClient;
    },
  } as unknown as Pool;
  return state;
}

describe('OM-98 areGovernedColumnsEmpty', () => {
  it('answers true without touching the database for an empty target list', async () => {
    const probe = makeProbePool(false);

    assert.equal(await areGovernedColumnsEmpty(probe.pool, [], 1_000), true);
    // Nothing to probe is not a reason to open a connection.
    assert.equal(probe.sql.length, 0);
  });

  it('reports an empty corpus as empty, in its own transaction', async () => {
    const probe = makeProbePool(false);

    assert.equal(await areGovernedColumnsEmpty(probe.pool, MISMATCH, 1_000), true);
    // Own BEGIN + SET LOCAL: a probe run for a decision must never be able to
    // wedge the evaluation it informs.
    assert.ok(probe.sql.some((s) => /^BEGIN$/.test(s)));
    assert.ok(probe.sql.some((s) => /SET LOCAL statement_timeout = 1000/.test(s)));
    assert.ok(probe.sql.some((s) => /^COMMIT$/.test(s)));
    assert.equal(probe.released, 1);
  });

  it('reports a populated corpus as not empty', async () => {
    const probe = makeProbePool(true);

    assert.equal(await areGovernedColumnsEmpty(probe.pool, MISMATCH, 1_000), false);
  });

  it('refuses when ANOTHER tenant holds the vectors — Cato-Audit Runde 5 / OM-98', async () => {
    // The bug, pinned. `graph_nodes` is ONE physical table for every tenant, so
    // `DROP COLUMN` is table-wide whoever triggers it. The fake answers a
    // tenant-scoped probe with "nothing here" and a table-wide probe with
    // "vectors present": tenant A is empty, tenant B is not. A scoped check
    // returns `true` and licenses the destruction of B's corpus.
    const probe = makeProbePool(true);

    assert.equal(await areGovernedColumnsEmpty(probe.pool, MISMATCH, 1_000), false);
    const emptinessProbe = probe.sql.find((s) => /AS has_vectors/i.test(s)) ?? '';
    assert.ok(
      !/tenant_id/i.test(emptinessProbe),
      `the emptiness probe must not be tenant-scoped: ${emptinessProbe}`,
    );
  });

  it('answers undefined — never false — when the probe fails', async () => {
    // The distinction is the whole point: `false` would have the log tell an
    // operator their corpus is populated when the truth is that a count timed
    // out. Both refuse; only one of them is a fact.
    const probe = makeProbePool(undefined);

    assert.equal(await areGovernedColumnsEmpty(probe.pool, MISMATCH, 1_000), undefined);
    assert.ok(probe.sql.some((s) => /^ROLLBACK$/.test(s)));
    assert.equal(probe.released, 1);
  });
});

describe('OM-98 resolveColumnMigrationPermission', () => {
  const base = {
    tenantId: 't1',
    mismatches: MISMATCH,
    statementTimeoutMs: 1_000,
    log: silent,
  };

  it('grants a confirmed discard outright, without probing anything', async () => {
    const probe = makeProbePool(false);

    const permission = await resolveColumnMigrationPermission({
      ...base,
      pool: probe.pool,
      destructiveAllowed: true,
      emptyAllowed: false,
    });

    assert.deepEqual(permission, { allowed: true, destructive: true, empty: undefined });
    // The operator handed over the capability to destroy a corpus. Whether the
    // columns happen to be empty does not change what was authorised, and
    // asking would only spend a query.
    assert.equal(probe.sql.length, 0);
  });

  it('refuses when neither capability was handed over', async () => {
    const probe = makeProbePool(false);

    const permission = await resolveColumnMigrationPermission({
      ...base,
      pool: probe.pool,
      destructiveAllowed: false,
      emptyAllowed: false,
    });

    // This is every boot: `blocked/column-width-mismatch` stays the answer.
    assert.equal(permission.allowed, false);
    assert.equal(probe.sql.length, 0);
  });

  it('permits a NON-destructive rebuild once the columns verify as empty', async () => {
    const probe = makeProbePool(false);
    const logged: string[] = [];

    const permission = await resolveColumnMigrationPermission({
      ...base,
      log: (msg) => logged.push(msg),
      pool: probe.pool,
      destructiveAllowed: false,
      emptyAllowed: true,
    });

    assert.deepEqual(permission, { allowed: true, destructive: false, empty: true });
    assert.ok(logged.some((m) => /EMPTY/.test(m)));
  });

  it('refuses the rebuild while the columns still hold vectors', async () => {
    const probe = makeProbePool(true);
    const logged: string[] = [];

    const permission = await resolveColumnMigrationPermission({
      ...base,
      log: (msg) => logged.push(msg),
      pool: probe.pool,
      destructiveAllowed: false,
      emptyAllowed: true,
    });

    assert.deepEqual(permission, { allowed: false, destructive: true, empty: false });
    // …and points at the path that IS allowed to destroy a corpus.
    assert.ok(logged.some((m) => /confirm the discard/.test(m)));
  });

  it('FAILS CLOSED when emptiness could not be established', async () => {
    // The security-relevant case. A probe that timed out is not evidence of an
    // empty corpus, and folding it in with `false` would be the one bug this
    // whole guard exists to prevent.
    const probe = makeProbePool(undefined);
    const logged: string[] = [];

    const permission = await resolveColumnMigrationPermission({
      ...base,
      log: (msg) => logged.push(msg),
      pool: probe.pool,
      destructiveAllowed: false,
      emptyAllowed: true,
    });

    assert.deepEqual(permission, { allowed: false, destructive: true, empty: undefined });
    assert.ok(logged.some((m) => /could not be established/.test(m)));
  });
});

/**
 * The master switch, at the layer that owns it.
 *
 * `auto_migrate_vector_columns: false` is an operator saying "never rewrite my
 * vector columns automatically". "They were empty anyway" is not a reason to
 * overrule that, so the reactivation capability is ANDed with the switch before
 * it ever reaches the gate.
 */
function makeGatePool(): { pool: Pool; sql: string[] } {
  const sql: string[] = [];
  const query = async (
    text: string,
    params?: ReadonlyArray<unknown>,
  ): Promise<QueryResult> => {
    sql.push(text);
    if (/pg_try_advisory_lock/i.test(text)) return rows([{ locked: true }]);
    if (/FROM pg_attribute/i.test(text)) {
      return rows([
        {
          table_name: 'graph_nodes',
          column_name: 'embedding',
          declared_type: 'vector(768)',
          typmod: 768,
        },
      ]);
    }
    if (/AS has_vectors/i.test(text)) return rows([{ has_vectors: false }]);
    if (/count\(\*\) AS n/i.test(text)) return rows([{ n: '0' }]);
    if (/FROM graph_embedding_model/i.test(text)) {
      return rows([
        {
          model_id: 'ollama:nomic-embed-text',
          dimensions: 768,
          clear_pending: false,
          age_ms: 86_400_000,
        },
      ]);
    }
    void params;
    return rows([]);
  };
  const pool = {
    async query(text: string, params?: ReadonlyArray<unknown>): Promise<QueryResult> {
      return query(text, params);
    },
    async connect(): Promise<PoolClient> {
      return {
        query,
        release(): void {
          /* no-op */
        },
      } as unknown as PoolClient;
    },
  } as unknown as Pool;
  return { pool, sql };
}

/** A 384-d keyless adapter against 768-wide columns — the reported dead end. */
const KEYLESS: EmbeddingClient = {
  modelId: 'local:paraphrase-multilingual-MiniLM-L12-v2',
  dimensions: 384,
  embed: async () => [],
} as unknown as EmbeddingClient;

describe('OM-98 master switch over the reactivation path', () => {
  it("refuses the empty-column rebuild while auto_migrate_vector_columns is 'false'", async () => {
    const { pool, sql } = makeGatePool();
    const logged: string[] = [];
    const runner = await startGateRunner({
      pool,
      tenantId: 't1',
      resolveRegistryClient: () => KEYLESS,
      autoMigrateVectorColumns: false,
      syncBackfill: () => undefined,
      log: (msg) => logged.push(msg),
    });

    await runner.reevaluate({ allowEmptyColumnMigration: true });

    assert.ok(
      logged.some((m) => /OM-98.*auto_migrate_vector_columns is 'false'/.test(m)),
      'the refusal has to name the switch that caused it',
    );
    // Fails closed all the way down: no column was touched, and the emptiness
    // probe was never even reached — the capability stopped one layer above it.
    assert.ok(!sql.some((s) => /DROP COLUMN/i.test(s)));
    assert.ok(!sql.some((s) => /AS has_vectors/i.test(s)));
    assert.equal(runner.vectorWritesAllowed(), false);
  });

  it('lets the rebuild through when the switch is on', async () => {
    const { pool } = makeGatePool();
    const logged: string[] = [];
    const runner = await startGateRunner({
      pool,
      tenantId: 't1',
      resolveRegistryClient: () => KEYLESS,
      autoMigrateVectorColumns: true,
      syncBackfill: () => undefined,
      log: (msg) => logged.push(msg),
    });

    await runner.reevaluate({ allowEmptyColumnMigration: true });

    assert.ok(!logged.some((m) => /auto_migrate_vector_columns is 'false'/.test(m)));
    // The permission resolved, which is what this test pins — the DDL itself
    // is Postgres semantics and belongs to the .pg suite.
    assert.ok(logged.some((m) => /OM-98.*EMPTY/.test(m)));
  });
});

/**
 * The TIME-OF-CHECK / TIME-OF-USE half.
 *
 * `resolveColumnMigrationPermission` establishes emptiness BEFORE
 * `migrateVectorColumns` takes the advisory lock. A backfill tick landing in
 * that window used only to be logged as `discarded=N` — after the column had
 * already been dropped. `requireEmpty` turns the in-lock count into the
 * decision.
 */
function makeMigrationPool(
  vectorCount: number | 'timeout',
  /** Cato-Audit Runde 5 / OM-98: what a TENANT-SCOPED count would answer. It
   *  defaults to 0 — the empty-tenant case — so every table-wide expectation
   *  below fails loudly if the production code ever re-adds the tenant filter. */
  tenantVectorCount = 0,
): {
  pool: Pool;
  sql: string[];
  lockKeys: string[];
} {
  const sql: string[] = [];
  const lockKeys: string[] = [];
  const query = async (text: string, params?: unknown[]): Promise<QueryResult> => {
    sql.push(text);
    if (/pg_try_advisory_lock/i.test(text)) {
      lockKeys.push(String(params?.[1] ?? ''));
      return rows([{ locked: true }]);
    }
    if (/pg_advisory_unlock/i.test(text)) return rows([{ unlocked: true }]);
    if (/FROM pg_attribute/i.test(text)) {
      return rows([
        {
          table_name: 'graph_nodes',
          column_name: 'embedding',
          declared_type: 'vector(768)',
          typmod: 768,
        },
      ]);
    }
    // The tenant-scoped count survives only as the best-effort log line.
    if (/count\(\*\) AS n/i.test(text)) return rows([{ n: String(tenantVectorCount) }]);
    // The GATE is the table-wide EXISTS probe; the two answer differently on
    // purpose, so a regression back to a tenant filter changes the verdict.
    if (/AS has_vectors/i.test(text)) {
      if (vectorCount === 'timeout') {
        const err = new Error('canceling statement due to statement timeout');
        (err as Error & { code?: string }).code = '57014';
        throw err;
      }
      if (/tenant_id/i.test(text)) return rows([{ has_vectors: false }]);
      return rows([{ has_vectors: vectorCount > 0 }]);
    }
    if (/FROM graph_embedding_model/i.test(text)) {
      return rows([
        {
          model_id: 'ollama:nomic-embed-text',
          dimensions: 768,
          age_ms: 86_400_000,
        },
      ]);
    }
    return rows([]);
  };
  const pool = {
    async connect(): Promise<PoolClient> {
      return {
        query,
        release(): void {
          /* no-op */
        },
      } as unknown as PoolClient;
    },
  } as unknown as Pool;
  return { pool, sql, lockKeys };
}

/** Index of the first statement matching `re`, or -1. */
const at = (sql: readonly string[], re: RegExp): number =>
  sql.findIndex((s) => re.test(s));

const MIGRATION_OPTS = {
  tenantId: 't1',
  targets: [{ table: 'graph_nodes', column: 'embedding' }],
  targetModelId: 'local:paraphrase-multilingual-MiniLM-L12-v2',
  targetDimensions: 384,
  switchCooldownMs: 0,
  log: silent,
};

describe('OM-98 migrateVectorColumns requireEmpty', () => {
  it('aborts without DDL when vectors appeared after the pre-lock check', async () => {
    const { pool, sql } = makeMigrationPool(17);

    const result = await migrateVectorColumns({
      ...MIGRATION_OPTS,
      pool,
      requireEmpty: true,
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'corpus-not-empty');
    assert.ok(result.ok === false && /still holds vectors/.test(result.detail));
    assert.deepEqual(result.migrated, []);
    // The column is the point: nothing may be dropped on this path, ever.
    assert.ok(!sql.some((s) => /DROP COLUMN/i.test(s)));
    assert.ok(!sql.some((s) => /DROP INDEX/i.test(s)));
    // Cato-Audit Runde 5 / OM-98: the deciding count runs INSIDE the DDL
    // transaction and behind a table lock, because the advisory lock this run
    // holds does not exclude the backfill writer. Out of that transaction it
    // was just a second racy check.
    const begin = at(sql, /^BEGIN$/);
    const lock = at(sql, /LOCK TABLE .* IN SHARE ROW EXCLUSIVE MODE/i);
    const count = sql.findIndex((s) => /AS has_vectors/i.test(s) && !/tenant_id/i.test(s));
    assert.ok(begin >= 0 && lock > begin, 'the table lock belongs inside the transaction');
    assert.ok(count > lock, 'the deciding probe must be taken after the table lock');
    assert.ok(sql.some((s) => /^ROLLBACK$/.test(s)), 'the refusal rolls its transaction back');
  });

  it('refuses when the vectors belong to ANOTHER tenant — Cato-Audit Runde 5 / OM-98', async () => {
    // This tenant owns nothing (`tenantVectorCount` 0); the shared table holds
    // 9 vectors for somebody else. The old guard counted `WHERE tenant_id = $1`,
    // read 0, and dropped the column for everyone.
    const { pool, sql } = makeMigrationPool(9, 0);

    const result = await migrateVectorColumns({
      ...MIGRATION_OPTS,
      pool,
      requireEmpty: true,
    });

    assert.equal(result.ok === false && result.reason, 'corpus-not-empty');
    assert.ok(result.ok === false && /every tenant/i.test(result.detail));
    assert.ok(!sql.some((s) => /DROP COLUMN/i.test(s)), 'no tenant may lose another tenant\'s corpus');
  });

  it('serialises the rebuild on a key no tenant owns', async () => {
    // Two tenants hold two different registry keys, so the tenant-scoped lock
    // alone cannot keep them from rewriting the SAME physical column at the
    // same time. A second, constant key does.
    const { pool, lockKeys } = makeMigrationPool(0);

    await migrateVectorColumns({ ...MIGRATION_OPTS, pool, requireEmpty: true });

    assert.equal(lockKeys.length, 2, `expected two advisory locks, got ${JSON.stringify(lockKeys)}`);
    assert.equal(lockKeys[0], 'vector-column-migration', 'the global rebuild lock is taken first');
    assert.equal(lockKeys[1], 't1', 'the tenant registry lock still contends with decideRegistry');
  });

  it('aborts when the in-lock count itself could not be established', async () => {
    // Same fail-closed rule the permission half applies. The two halves have to
    // agree or the guard has a hole exactly where it is hardest to notice.
    const { pool, sql } = makeMigrationPool('timeout');

    const result = await migrateVectorColumns({
      ...MIGRATION_OPTS,
      pool,
      requireEmpty: true,
    });

    // A DIFFERENT reason from `corpus-not-empty`: both refuse, but only one of
    // them is a claim about the corpus, and only one of them should point an
    // operator at the discard confirmation.
    assert.equal(result.ok === false && result.reason, 'emptiness-unknown');
    assert.ok(
      result.ok === false && /could not be established/.test(result.detail),
      'an unanswerable probe must not be reported as a probe that said zero',
    );
    assert.ok(!sql.some((s) => /DROP COLUMN/i.test(s)));
  });

  it('proceeds past an empty column, which is the case it exists to allow', async () => {
    const { pool, sql } = makeMigrationPool(0);

    await migrateVectorColumns({ ...MIGRATION_OPTS, pool, requireEmpty: true });

    // The guard is not a blanket refusal: an empty column still gets rebuilt.
    assert.ok(sql.some((s) => /DROP COLUMN/i.test(s)));
  });

  it('never fires on the operator-confirmed destructive switch', async () => {
    // A confirmed discard is supposed to destroy vectors. Applying the guard
    // there would break the one path that is allowed to — and it must not take
    // the extra table lock either, which is the non-destructive path's cost.
    const { pool, sql } = makeMigrationPool(4_200, 4_200);

    await migrateVectorColumns({ ...MIGRATION_OPTS, pool, requireEmpty: false });

    assert.ok(sql.some((s) => /DROP COLUMN/i.test(s)));
    assert.ok(!sql.some((s) => /LOCK TABLE/i.test(s)));
  });
});
