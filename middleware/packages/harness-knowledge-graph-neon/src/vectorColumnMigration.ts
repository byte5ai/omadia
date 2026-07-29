import type { Pool, PoolClient } from 'pg';

import { ATTEMPT_RESETS } from './staleVectorClear.js';
import {
  captureIndexDefs,
  countVectors,
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
 *      forever, which is the one thing a provider switch has to fix. BOUNDED:
 *      see ATTEMPT RESET below;
 *   4. flip `graph_embedding_model` to the new model + dimensions. The columns
 *      are empty by construction, so there is nothing for a stale-vector clear
 *      to do and an owed clear is subsumed rather than left dangling —
 *      `clear_pending` is therefore lowered to FALSE, EXCEPT when the bounded
 *      attempt reset did not drain (below), where it stays TRUE as the durable
 *      marker that finishes the job.
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
 *   - the anti-oscillation cooldown is armed by REGISTRY WRITE RECENCY ALONE.
 *     Registry row written inside `switchCooldownMs` → refused, full stop. It
 *     used to also require "and the corpus still holds vectors", which made the
 *     guard unable to survive the very migration it guards: the previous
 *     migration re-created the target columns EMPTY, so the vectors-present
 *     probe read false and the cooldown never fired. Reproduced against
 *     pgvector: 768 corpus + day-old registry → migrate to 1536 → immediately
 *     re-evaluate with a 768 provider → migrated straight back, 0s elapsed,
 *     cooldown 600s. Two machine versions in a rolling deploy therefore
 *     alternately dropped BOTH governed columns, each cycle burning paid API
 *     calls on rows the next cycle discarded. Recency is the durable signal;
 *     "are there vectors" is state this operation itself destroys;
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
 *
 * ATTEMPT RESET, AND WHY IT IS BOUNDED. The column swap is metadata-only and
 * cheap; the attempt reset is the ONLY row-touching statement in here, and it
 * runs under the same 4s `statement_timeout` while the table is held at
 * AccessExclusiveLock. Unbounded, its predicate degenerates after the swap to
 * "every row that ever failed an embed" — on a million-row `graph_nodes` that
 * times out, rolls the whole swap back, and returns `ddl-failed` → `blocked`.
 * Identically on every restart: a livelock whose only escape is turning off a
 * default-ON flag. So it is capped at `attemptResetMaxRows` (default 5000,
 * the same ceiling `clearStaleVectors` uses), which keeps the invariant that
 * every row-touching path in this subsystem is explicitly batched.
 *
 * Capping alone would violate the invariant that actually matters — A MIGRATED
 * COLUMN MUST NEVER LEAVE ROWS PERMANENTLY UN-EMBEDDABLE BECAUSE THEIR ATTEMPT
 * COUNTER STAYED SPENT — so the remainder is handed to a durable marker rather
 * than dropped: when the capped UPDATE comes back FULL, the registry flip
 * writes `clear_pending = TRUE`. That flag already arms the two existing
 * resumers, both of which run `ATTEMPT_RESETS` in bounded batches and lower it
 * only after a residual probe says nothing is left — the gate's `resumeClear`
 * on every activation, and the backfill sweep on every tick
 * (`resumeStaleVectorClear` is unconditionally on). Their vector-clearing half
 * is a no-op here because the columns are NULL by construction, so the only
 * work they do is the reset we owe. Vector writes stay refused for the
 * duration, which is required rather than incidental: `clearStaleVectors`
 * NULLs any non-NULL governed vector it finds, so allowing writes while it is
 * armed would destroy freshly embedded rows.
 *
 * "The UPDATE came back full ⇒ rows remain" is EXACT here, not a guess: the
 * transaction already holds AccessExclusiveLock on the table from the
 * `DROP COLUMN`, so no concurrent session can be adding or removing rows from
 * the predicate. A short batch therefore means drained, and no residual probe
 * is needed.
 */

/** Advisory-lock namespace shared with the gate's registry transaction. */
export const LOCK_NS_REGISTRY = 4_400;

const DEFAULT_BUDGET_MS = 5_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 4_000;
/** Kept short on purpose: `DROP COLUMN` needs an AccessExclusiveLock, and
 *  queueing behind a long reader inside a 10s activate() budget is a hang. */
const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
/** Rows the in-transaction attempt reset may touch per table, per run. Same
 *  ceiling as `clearStaleVectors`' `DEFAULT_CLEAR_MAX_ROWS`; the remainder is
 *  carried by `clear_pending`. See ATTEMPT RESET in the module header. */
const DEFAULT_ATTEMPT_RESET_MAX_ROWS = 5_000;

export interface MigratedVectorColumn {
  table: string;
  column: string;
  previousDimensions: number | undefined;
  newDimensions: number;
  /** Index definitions captured before the drop and replayed verbatim. */
  indexes: readonly string[];
  /** Non-NULL vectors destroyed, or `undefined` when the count timed out. */
  discardedVectors: number | undefined;
  /** Exhausted `embedding_attempts` counters reset inside the swap. */
  attemptsReset: number;
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
      /**
       * The bounded attempt reset hit its cap, so counters are still owed.
       * `clear_pending` was written TRUE to carry the remainder; the caller
       * must refuse vector writes until a resumer drains it. See ATTEMPT RESET
       * in the module header.
       */
      attemptsResetPending: boolean;
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
  /** Cap on rows the attempt reset touches per table. Default 5000. */
  attemptResetMaxRows?: number;
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
  const attemptResetMaxRows =
    opts.attemptResetMaxRows ?? DEFAULT_ATTEMPT_RESET_MAX_ROWS;
  const migrated: MigratedVectorColumn[] = [];
  let attemptsResetPending = false;

  const client = await opts.pool.connect();
  let poisoned = false;
  // Tracks whether the SESSION-scoped advisory lock may still be held on this
  // connection. It is the only thing that decides pooling vs destruction on
  // the way out — see the `finally` at the bottom.
  let lockHeld = false;
  try {
    let acquired: boolean;
    try {
      acquired = await tryAcquireRegistryLock(client, opts.tenantId);
    } catch (err) {
      // The acquire statement itself failed, so whether the lock was granted
      // is unknowable. Assume the worst and destroy the connection.
      poisoned = true;
      throw err;
    }
    if (!acquired) {
      return {
        ok: false,
        reason: 'lock-held',
        detail:
          'another instance holds the embedding-registry lock — it may be migrating these columns right now',
        migrated,
      };
    }
    lockHeld = true;
    try {
      const stored = await readRegistryRow(client, opts.tenantId);

      // Anti-oscillation, armed by registry write recency ALONE. It used to
      // also require `hasAnyVector(targets)`, which probes the very columns the
      // previous migration re-created EMPTY — so the guard could not survive
      // the operation it guards. See the GUARDS section of the module header.
      if (
        stored !== undefined &&
        opts.switchCooldownMs > 0 &&
        isWithinCooldown(stored, opts.switchCooldownMs)
      ) {
        return {
          ok: false,
          reason: 'cooldown',
          detail: `the registry was last written ${String(Math.round(Number(stored.age_ms) / 1000))}s ago, inside the ${String(Math.round(opts.switchCooldownMs / 1000))}s anti-oscillation cooldown — refusing to rewrite the governed columns again`,
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
        let reset: AttemptResetOutcome;
        try {
          reset = await migrateOneColumn(client, target, info, indexes, {
            targetDimensions: opts.targetDimensions,
            tenantId: opts.tenantId,
            statementTimeoutMs,
            lockTimeoutMs,
            attemptResetMaxRows,
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
        if (reset.pending) attemptsResetPending = true;
        migrated.push({
          table: target.table,
          column: target.column,
          previousDimensions: info.declaredDimensions,
          newDimensions: opts.targetDimensions,
          indexes,
          discardedVectors,
          attemptsReset: reset.rows,
        });
        opts.log(
          `[graph-embedding-gate] MIGRATED ${target.table}.${target.column}: vector(${String(info.declaredDimensions ?? 0)}) → vector(${String(opts.targetDimensions)}); ${discardedVectors === undefined ? 'an unknown number of' : String(discardedVectors)} stored vector(s) DISCARDED and must be re-embedded, ${String(indexes.length)} index(es) re-created from their captured definition, ${String(reset.rows)} exhausted retry counter(s) reset${reset.pending ? ' (CAP HIT — more are owed, clear_pending will carry them)' : ''}`,
        );
      }

      if (!(await flipRegistry(client, stored, opts, attemptsResetPending))) {
        return {
          ok: false,
          reason: 'registry-flip-failed',
          detail:
            `the registry row changed between read and flip and now names neither the old model nor '${opts.targetModelId}' — the columns ARE at the new width but graph_embedding_model still names a different one. The next activation will NOT self-heal this: it sees no width mismatch, falls through to decideRegistry and reports blocked/dimension-mismatch until the registry row is corrected. Point graph_embedding_model at '${opts.targetModelId}' (${String(opts.targetDimensions)}d) for this tenant, or run every instance on one provider and restart.`,
          migrated,
        };
      }

      if (attemptsResetPending) {
        opts.log(
          `[graph-embedding-gate] the attempt reset hit its ${String(attemptResetMaxRows)}-row cap — clear_pending was left TRUE so the gate's resume path and the backfill sweep finish it in bounded batches. Vector writes stay refused until they do; no row is left permanently un-embeddable.`,
        );
      }

      return {
        ok: true,
        migrated,
        previousModelId: stored?.model_id,
        previousDimensions: stored?.dimensions,
        discardedVectors: sumDiscarded(migrated),
        attemptsResetPending,
      };
    } finally {
      // EVERY throw inside the locked region lands here, not just the one from
      // `migrateOneColumn`: `readRegistryRow`, `readColumnInfo`,
      // `captureIndexDefs` and `flipRegistry` can all fail, and each of them
      // used to run this `finally`, swallow the unlock error and then hand a
      // connection that may STILL HOLD the session-scoped lock back to the
      // pool. That is not a degraded mode: `decideRegistry` takes a BLOCKING
      // `pg_advisory_xact_lock` in this same namespace with no
      // `lock_timeout`, so a leaked lock means the knowledge-graph plugin
      // never activates again until the process restarts.
      //
      // So the unlock now REPORTS. Released ⇒ the connection is clean and gets
      // pooled. Not released (query threw, connection sits in an aborted
      // transaction, driver says the lock was not held) ⇒ the connection is
      // destroyed below, which releases the session lock with it.
      if (await releaseRegistryLock(client, opts.tenantId)) lockHeld = false;
    }
  } finally {
    // Same reasoning as the stale-vector clear: a connection that could not
    // provably release its SESSION-level lock is destroyed rather than pooled
    // — otherwise every later migration and every `decideRegistry` on this
    // tenant blocks for the connection's lifetime.
    client.release(poisoned || lockHeld);
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

/** What the bounded attempt reset did for one table. */
interface AttemptResetOutcome {
  rows: number;
  /** The cap was hit, so counters are still owed. */
  pending: boolean;
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
    attemptResetMaxRows: number;
  },
): Promise<AttemptResetOutcome> {
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
    // budget the OLD provider spent — which after the swap is "every row that
    // ever failed an embed", with no natural ceiling. BOUNDED for that reason;
    // the module header explains the cap, the durable marker that carries the
    // remainder, and why a short batch here proves the predicate is drained.
    //
    // No `FOR UPDATE SKIP LOCKED`: this transaction already holds
    // AccessExclusiveLock on the table from the `DROP COLUMN` above, so there
    // is no concurrent writer to skip and `rowCount` is exact.
    const limit = Math.max(1, Math.floor(opts.attemptResetMaxRows));
    let rows = 0;
    let pending = false;
    for (const reset of ATTEMPT_RESETS) {
      if (reset.table !== target.table) continue;
      const done = await client.query(
        `UPDATE ${quoteIdent(reset.table)}
            SET ${reset.set}
          WHERE ctid IN (
                  SELECT ctid
                    FROM ${quoteIdent(reset.table)}
                   WHERE tenant_id = $1 AND ${reset.where}
                   ORDER BY ctid
                   LIMIT ${String(limit)}
                )`,
        [opts.tenantId],
      );
      const affected = done.rowCount ?? 0;
      rows += affected;
      if (affected >= limit) pending = true;
    }
    await client.query('COMMIT');
    return { rows, pending };
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
 * Record the new identity.
 *
 * `clearPending` is normally FALSE and that is not an oversight: the columns
 * were just re-created empty, so no old-model vector is left for a clear to
 * find and this migration subsumes whatever clear was owed. It is TRUE only
 * when the bounded attempt reset hit its cap — see ATTEMPT RESET in the module
 * header for why that flag is the right carrier for the remainder.
 *
 * The CAS predicate is the same one the same-width switch uses. Losing it is
 * not automatically a failure, though: two instances migrating to the SAME
 * provider is the ordinary rolling-deploy shape, and the loser's work is
 * already done for it. `adoptIfAlreadyOurs` turns that into success, which is
 * what keeps a concurrent pair from leaving the columns migrated and the
 * registry stale — the one state the next activation cannot recover from on
 * its own (no width mismatch left to trigger this path, so it dead-ends on
 * `blocked/dimension-mismatch`).
 */
async function flipRegistry(
  client: PoolClient,
  stored: StoredRegistryRow | undefined,
  opts: VectorColumnMigrationOptions,
  clearPending: boolean,
): Promise<boolean> {
  if (stored === undefined) {
    const inserted = await client.query(
      `INSERT INTO graph_embedding_model (tenant_id, model_id, dimensions, clear_pending)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id) DO NOTHING
       RETURNING model_id`,
      [opts.tenantId, opts.targetModelId, opts.targetDimensions, clearPending],
    );
    if ((inserted.rowCount ?? 0) === 1) return true;
    return await adoptIfAlreadyOurs(client, opts, clearPending);
  }
  const updated = await client.query(
    `UPDATE graph_embedding_model
        SET model_id = $2, dimensions = $3, clear_pending = $6, updated_at = now()
      WHERE tenant_id = $1
        AND model_id = $4
        AND dimensions = $5`,
    [
      opts.tenantId,
      opts.targetModelId,
      opts.targetDimensions,
      stored.model_id,
      stored.dimensions,
      clearPending,
    ],
  );
  if ((updated.rowCount ?? 0) === 1) return true;
  return await adoptIfAlreadyOurs(client, opts, clearPending);
}

/**
 * The CAS lost — did it lose to somebody who wrote exactly what we wanted?
 *
 * If the row now names our target model at our target width, the flip is a
 * no-op that already happened and reporting failure would be a lie that leaves
 * a perfectly consistent schema flagged as broken. An owed attempt reset is
 * still raised, because the winner may not have owed one.
 */
async function adoptIfAlreadyOurs(
  client: PoolClient,
  opts: VectorColumnMigrationOptions,
  clearPending: boolean,
): Promise<boolean> {
  const current = await readRegistryRow(client, opts.tenantId);
  if (
    current === undefined ||
    current.model_id !== opts.targetModelId ||
    Number(current.dimensions) !== opts.targetDimensions
  ) {
    return false;
  }
  if (clearPending) {
    await client.query(
      `UPDATE graph_embedding_model
          SET clear_pending = TRUE, updated_at = now()
        WHERE tenant_id = $1 AND model_id = $2 AND dimensions = $3`,
      [opts.tenantId, opts.targetModelId, opts.targetDimensions],
    );
  }
  return true;
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

/**
 * Release the session lock, and REPORT whether it actually went.
 *
 * The return value is load-bearing: `false` is what makes the caller destroy
 * the connection instead of pooling it, which is the only other way a
 * session-scoped lock can be released. Swallowing the answer (what this used
 * to do) leaked the lock on every failure path except one, and a leaked lock
 * in this namespace hangs `decideRegistry` forever rather than degrading it.
 */
async function releaseRegistryLock(
  client: PoolClient,
  tenantId: string,
): Promise<boolean> {
  try {
    const result = await client.query<{ unlocked: boolean }>(
      'SELECT pg_advisory_unlock($1::int, hashtext($2)::int) AS unlocked',
      [LOCK_NS_REGISTRY, tenantId],
    );
    // A fake/limited driver that does not model advisory locks returns no row.
    // It never took a lock either, so "no row" is a clean release — the same
    // symmetry `tryAcquireRegistryLock` uses.
    const row = result.rows[0];
    return row === undefined || row.unlocked !== false;
  } catch {
    return false;
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
