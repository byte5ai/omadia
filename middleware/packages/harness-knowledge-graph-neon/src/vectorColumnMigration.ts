import type { Pool, PoolClient } from 'pg';

import { ATTEMPT_RESETS } from './staleVectorClear.js';
import {
  captureIndexDefs,
  countVectors,
  hasAnyVector,
  indexNameOf,
  quoteIdent,
  readColumnInfo,
  type ColumnCatalogInfo,
  type VectorColumnTarget,
} from './vectorColumnCatalog.js';

export type { VectorColumnTarget } from './vectorColumnCatalog.js';

/**
 * #440 — automatic vector-column width migration, at runtime.
 *
 * The knowledge-graph columns are `vector(768)` (migrations 0005 and 0009).
 * Every OpenAI embedding model emits 1536 or 3072 dimensions, so "the operator
 * switched provider" and "the declared column width no longer matches" are the
 * SAME event for anyone actually using the pluggable provider. Before this
 * module that combination was terminal: the gate returned
 * `blocked/column-width-mismatch` and the only way forward was a hand-written
 * `0005`-style migration. This module performs that migration itself.
 *
 * Per column, the shape is exactly what migration 0005 did by hand:
 *   1. capture `pg_get_indexdef()` for every index that references the column;
 *   2. DROP those indexes, DROP the column, ADD it back at the new width,
 *      re-create the captured indexes verbatim;
 *   3. reset the attempt bookkeeping (`graph_nodes.embedding_attempts`) so the
 *      backfill picks rows up again — every row is NULL now, and a row that
 *      exhausted its retries under the OLD provider would otherwise be skipped
 *      forever, which is the one thing a provider switch has to fix;
 *   4. flip `graph_embedding_model` to the new model + dimensions with
 *      `clear_pending = FALSE`. The column is empty by construction, so there
 *      is nothing for a stale-vector clear to do — an owed clear is subsumed
 *      and correctly lowered rather than left dangling.
 *
 * It is fast precisely because the re-added column is entirely NULL: the HNSW
 * build has nothing to index. The expensive part is re-embedding, and the
 * existing backfill sweep already does that asynchronously.
 *
 * IT IS DESTRUCTIVE. Every stored embedding is dropped and has to be re-earned
 * through that sweep, which on a paid API costs real money. Hence the config
 * flag on the caller side, the WARN-level logging of exactly what was
 * discarded, the publication into the gate status so `/health` shows it — and
 * the guards below.
 *
 * GUARDS. A width migration destroys strictly more than the same-width clear
 * the existing guards were built for, so it is held to the same bar, not a
 * lower one:
 *   - it runs under a SESSION-level advisory lock in the SAME namespace the
 *     gate's registry transaction uses. `decideRegistry`'s
 *     `pg_advisory_xact_lock` and this `pg_try_advisory_lock` contend in one
 *     lock space, so no second instance can be deciding a model switch while
 *     the columns are being rewritten. `try` rather than a blocking acquire:
 *     `activate()` is hard-capped at 10s (toolPluginRuntime.ts:286-290) and
 *     waiting out another instance's migration would spend that budget on
 *     nothing;
 *   - the anti-oscillation cooldown applies UNCHANGED. Registry row written
 *     inside `switchCooldownMs` AND vectors still present → refused. Two
 *     machine versions with different providers during a rolling deploy would
 *     otherwise take turns dropping each other's columns: the same failure the
 *     cooldown was written for, an order of magnitude more expensive;
 *   - the registry flip carries the SAME CAS predicate as the same-width
 *     switch. A row that moved between read and flip means somebody wrote the
 *     registry without the lock, and this reports failure rather than claiming
 *     a corpus it may not own.
 *
 * ATOMICITY. Everything for one table — index drops, the column swap, index
 * recreation, the attempt reset — is ONE transaction. Postgres DDL is
 * transactional, so a failure anywhere leaves that table fully old, never
 * half-migrated. Tables go one transaction at a time; a run that dies after
 * table A leaves A at the new width, B at the old one and the REGISTRY
 * UNTOUCHED, so the next activation sees the remaining mismatch and finishes
 * the job. That is why the registry flip is last, and why every failure path
 * returns without touching it.
 */

/** Advisory-lock namespace shared with the gate's registry transaction. */
export const LOCK_NS_REGISTRY = 4_400;

const DEFAULT_BUDGET_MS = 5_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 4_000;
/** Kept short on purpose: `DROP COLUMN` needs an AccessExclusiveLock, and
 *  queueing behind a long reader inside a 10s activate() budget is a hang. */
const DEFAULT_LOCK_TIMEOUT_MS = 2_000;

export interface MigratedVectorColumn {
  table: string;
  column: string;
  previousDimensions: number | undefined;
  newDimensions: number;
  /** Index definitions captured before the drop and replayed verbatim. */
  indexes: readonly string[];
  /** Non-NULL vectors destroyed, or `undefined` when the count timed out. */
  discardedVectors: number | undefined;
}

export type VectorColumnMigrationFailure =
  /** Another instance holds the registry lock — it may be migrating already. */
  | 'lock-held'
  /** Anti-oscillation guard: registry too fresh AND vectors still present. */
  | 'cooldown'
  /** The activate() budget ran out before every column was done. */
  | 'budget-exhausted'
  /** A DDL transaction failed; that table is untouched. */
  | 'ddl-failed'
  /** Columns are migrated but the registry would not take the new identity. */
  | 'registry-flip-failed';

export type VectorColumnMigrationResult =
  | {
      ok: true;
      migrated: readonly MigratedVectorColumn[];
      previousModelId: string | undefined;
      previousDimensions: number | undefined;
      /** Sum over columns; `undefined` if any per-column count was unknown. */
      discardedVectors: number | undefined;
    }
  | {
      ok: false;
      reason: VectorColumnMigrationFailure;
      detail: string;
      /** Columns that DID complete before the abort. Their transactions are
       *  committed; the next activation resumes from there. */
      migrated: readonly MigratedVectorColumn[];
    };

export interface VectorColumnMigrationOptions {
  pool: Pool;
  tenantId: string;
  /** Columns whose declared width disagrees with the active provider. */
  targets: ReadonlyArray<VectorColumnTarget>;
  targetModelId: string;
  targetDimensions: number;
  /** Same cooldown value the same-width switch path uses. 0 disables. */
  switchCooldownMs: number;
  /** Wall-clock cap for the whole run. `activate()` is killed at 10s, so this
   *  must leave room for everything else. Exceeding it aborts with
   *  `budget-exhausted`, i.e. the caller degrades to `blocked` — never a
   *  failed activation. Default 5000. */
  budgetMs?: number;
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
  log: (msg: string) => void;
  /** Injectable clock, for tests. */
  now?: () => number;
}

interface StoredRegistryRow {
  model_id: string;
  dimensions: number;
  age_ms: string | number;
}

export async function migrateVectorColumns(
  opts: VectorColumnMigrationOptions,
): Promise<VectorColumnMigrationResult> {
  const now = opts.now ?? ((): number => Date.now());
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const deadline = now() + budgetMs;
  const statementTimeoutMs = opts.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
  const lockTimeoutMs = opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const migrated: MigratedVectorColumn[] = [];

  const client = await opts.pool.connect();
  let poisoned = false;
  try {
    if (!(await tryAcquireRegistryLock(client, opts.tenantId))) {
      return {
        ok: false,
        reason: 'lock-held',
        detail:
          'another instance holds the embedding-registry lock — it may be migrating these columns right now',
        migrated,
      };
    }
    try {
      const stored = await readRegistryRow(client, opts.tenantId);

      // Cheap existence probe over the targets themselves: the columns about
      // to be destroyed ARE the corpus the cooldown is protecting.
      const hasVectors = await hasAnyVector(client, opts.targets, opts.tenantId);
      if (
        stored !== undefined &&
        opts.switchCooldownMs > 0 &&
        hasVectors &&
        isWithinCooldown(stored, opts.switchCooldownMs)
      ) {
        return {
          ok: false,
          reason: 'cooldown',
          detail: `the registry was last written ${String(Math.round(Number(stored.age_ms) / 1000))}s ago (cooldown ${String(Math.round(opts.switchCooldownMs / 1000))}s) and the corpus still holds vectors`,
          migrated,
        };
      }

      for (const target of opts.targets) {
        if (now() >= deadline) {
          return {
            ok: false,
            reason: 'budget-exhausted',
            detail: `ran out of the ${String(budgetMs)}ms activation budget after ${String(migrated.length)} of ${String(opts.targets.length)} column(s); the next activation resumes the rest`,
            migrated,
          };
        }
        const info = await readColumnInfo(client, target);
        // Column gone (a concurrent migration), or already at the right width
        // because an earlier partial run got this far. Both are no-ops.
        if (info === undefined) continue;
        if (info.declaredDimensions === opts.targetDimensions) continue;

        const discardedVectors = await countVectors(
          client,
          target,
          opts.tenantId,
          statementTimeoutMs,
        );
        const indexes = await captureIndexDefs(client, target);
        try {
          await migrateOneColumn(client, target, info, indexes, {
            targetDimensions: opts.targetDimensions,
            tenantId: opts.tenantId,
            statementTimeoutMs,
            lockTimeoutMs,
          });
        } catch (err) {
          if (await isConnectionAborted(client)) poisoned = true;
          return {
            ok: false,
            reason: 'ddl-failed',
            detail: `${target.table}.${target.column}: ${err instanceof Error ? err.message : String(err)} — that table is unchanged (the whole swap was one transaction) and the registry was not touched`,
            migrated,
          };
        }
        migrated.push({
          table: target.table,
          column: target.column,
          previousDimensions: info.declaredDimensions,
          newDimensions: opts.targetDimensions,
          indexes,
          discardedVectors,
        });
        opts.log(
          `[graph-embedding-gate] MIGRATED ${target.table}.${target.column}: vector(${String(info.declaredDimensions ?? 0)}) → vector(${String(opts.targetDimensions)}); ${discardedVectors === undefined ? 'an unknown number of' : String(discardedVectors)} stored vector(s) DISCARDED and must be re-embedded, ${String(indexes.length)} index(es) re-created from their captured definition`,
        );
      }

      if (!(await flipRegistry(client, stored, opts))) {
        return {
          ok: false,
          reason: 'registry-flip-failed',
          detail:
            'the registry row changed between read and flip — the columns are at the new width but graph_embedding_model still names the old model; the next activation reconciles it',
          migrated,
        };
      }

      return {
        ok: true,
        migrated,
        previousModelId: stored?.model_id,
        previousDimensions: stored?.dimensions,
        discardedVectors: sumDiscarded(migrated),
      };
    } finally {
      await releaseRegistryLock(client, opts.tenantId);
    }
  } finally {
    // Same reasoning as the stale-vector clear: a connection stuck inside an
    // aborted transaction could not release the SESSION-level lock, so it is
    // destroyed rather than pooled — otherwise every later migration and every
    // `decideRegistry` on this tenant blocks for the connection's lifetime.
    client.release(poisoned);
  }
}

function sumDiscarded(
  migrated: readonly MigratedVectorColumn[],
): number | undefined {
  let total = 0;
  for (const m of migrated) {
    if (m.discardedVectors === undefined) return undefined;
    total += m.discardedVectors;
  }
  return total;
}

function isWithinCooldown(row: StoredRegistryRow, cooldownMs: number): boolean {
  const ageMs = Number(row.age_ms);
  return Number.isFinite(ageMs) && ageMs < cooldownMs;
}

/**
 * The column swap, as ONE transaction. See the module header for why every
 * step belongs in here rather than being spread across several.
 */
async function migrateOneColumn(
  client: PoolClient,
  target: VectorColumnTarget,
  info: ColumnCatalogInfo,
  indexes: readonly string[],
  opts: {
    targetDimensions: number;
    tenantId: string;
    statementTimeoutMs: number;
    lockTimeoutMs: number;
  },
): Promise<void> {
  const table = quoteIdent(target.table);
  const column = quoteIdent(target.column);
  await client.query('BEGIN');
  try {
    await client.query(
      `SET LOCAL lock_timeout = ${String(Math.max(1, Math.floor(opts.lockTimeoutMs)))}`,
    );
    await client.query(
      `SET LOCAL statement_timeout = ${String(Math.max(1, Math.floor(opts.statementTimeoutMs)))}`,
    );
    // `DROP COLUMN` would cascade to these anyway; dropping them explicitly
    // keeps the operation legible in the Postgres log and makes the
    // capture/replay pairing obvious to the next reader.
    for (const def of indexes) {
      const name = indexNameOf(def);
      if (name !== undefined) await client.query(`DROP INDEX IF EXISTS ${name}`);
    }
    await client.query(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    await client.query(
      `ALTER TABLE ${table} ADD COLUMN ${column} ${info.baseType}(${String(opts.targetDimensions)})`,
    );
    for (const def of indexes) {
      await client.query(def);
    }
    // Every row is NULL now, so ATTEMPT_RESETS' `embedding IS NULL AND
    // embedding_attempts > 0` predicate selects exactly the rows whose retry
    // budget the OLD provider spent. It runs INSIDE this transaction on
    // purpose: a timeout here rolls the column back to its old width, which is
    // the safe direction — a migrated column whose counters were never reset
    // would silently exclude those rows from the backfill forever.
    for (const reset of ATTEMPT_RESETS) {
      if (reset.table !== target.table) continue;
      await client.query(
        `UPDATE ${quoteIdent(reset.table)} SET ${reset.set} WHERE tenant_id = $1 AND ${reset.where}`,
        [opts.tenantId],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Reported by `isConnectionAborted` in the caller, which destroys the
      // connection so the session-level advisory lock goes with it.
    }
    throw err;
  }
}

async function readRegistryRow(
  client: PoolClient,
  tenantId: string,
): Promise<StoredRegistryRow | undefined> {
  const result = await client.query<StoredRegistryRow>(
    `SELECT model_id,
            dimensions,
            EXTRACT(EPOCH FROM (now() - updated_at)) * 1000 AS age_ms
       FROM graph_embedding_model
      WHERE tenant_id = $1`,
    [tenantId],
  );
  return result.rows[0];
}

/**
 * Record the new identity. `clear_pending = FALSE` is not an oversight: the
 * columns were just re-created empty, so no old-model vector is left for a
 * clear to find — this migration subsumes whatever clear was owed.
 *
 * The CAS predicate is the same one the same-width switch uses.
 */
async function flipRegistry(
  client: PoolClient,
  stored: StoredRegistryRow | undefined,
  opts: VectorColumnMigrationOptions,
): Promise<boolean> {
  if (stored === undefined) {
    const inserted = await client.query(
      `INSERT INTO graph_embedding_model (tenant_id, model_id, dimensions, clear_pending)
       VALUES ($1, $2, $3, FALSE)
       ON CONFLICT (tenant_id) DO NOTHING
       RETURNING model_id`,
      [opts.tenantId, opts.targetModelId, opts.targetDimensions],
    );
    return (inserted.rowCount ?? 0) === 1;
  }
  const updated = await client.query(
    `UPDATE graph_embedding_model
        SET model_id = $2, dimensions = $3, clear_pending = FALSE, updated_at = now()
      WHERE tenant_id = $1
        AND model_id = $4
        AND dimensions = $5`,
    [
      opts.tenantId,
      opts.targetModelId,
      opts.targetDimensions,
      stored.model_id,
      stored.dimensions,
    ],
  );
  return (updated.rowCount ?? 0) === 1;
}

async function tryAcquireRegistryLock(
  client: PoolClient,
  tenantId: string,
): Promise<boolean> {
  const result = await client.query<{ locked: boolean }>(
    'SELECT pg_try_advisory_lock($1::int, hashtext($2)::int) AS locked',
    [LOCK_NS_REGISTRY, tenantId],
  );
  // A fake/limited driver that does not model advisory locks returns no row;
  // treat that as "acquired" so unit tests exercise the migration itself.
  const row = result.rows[0];
  return row === undefined || row.locked !== false;
}

async function releaseRegistryLock(
  client: PoolClient,
  tenantId: string,
): Promise<void> {
  try {
    await client.query('SELECT pg_advisory_unlock($1::int, hashtext($2)::int)', [
      LOCK_NS_REGISTRY,
      tenantId,
    ]);
  } catch {
    // Best-effort; a poisoned connection is destroyed by the caller, which
    // releases the session lock with it.
  }
}

/** `true` when the connection is stuck inside an aborted transaction (its
 *  ROLLBACK failed) and must not go back to the pool. */
async function isConnectionAborted(client: PoolClient): Promise<boolean> {
  try {
    await client.query('SELECT 1');
    return false;
  } catch {
    return true;
  }
}
