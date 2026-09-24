import type { Pool, PoolClient } from 'pg';

import { ATTEMPT_RESETS } from './staleVectorClear.js';
import {
  captureIndexDefs,
  countVectors,
  hasAnyVectorTableWide,
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
 *     nothing. Cato-Audit Runde 5 / OM-98 added a SECOND, GLOBAL key in the
 *     same namespace (`LOCK_KEY_COLUMN_REBUILD`), taken first: the tenant key
 *     serialises DECISIONS per tenant, but the rewrite acts on tables every
 *     tenant shares, so two tenants holding two different tenant keys could
 *     otherwise `DROP COLUMN` the same physical column at once;
 *   - the emptiness precondition of the non-destructive path is TABLE-WIDE and
 *     is re-taken inside the DDL transaction behind
 *     `LOCK TABLE … IN SHARE ROW EXCLUSIVE MODE`. See `requireEmpty` and
 *     `assertTableWideEmpty`;
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

/**
 * Cato-Audit Runde 5 / OM-98 — the advisory lock for the COLUMN REBUILD, held
 * in addition to the tenant-scoped registry lock below.
 *
 * The registry lock is `hashtext(tenantId)` in `LOCK_NS_REGISTRY` and has to
 * stay that way: it is the key `decideRegistry` takes, so it is what keeps a
 * model decision from racing a rewrite FOR THE SAME TENANT. But the rewrite
 * itself is not a tenant-scoped operation at all — `graph_nodes` is one
 * physical table shared by every tenant, and two tenants holding two different
 * tenant keys could therefore run `DROP COLUMN` against it concurrently. This
 * second key is constant, so exactly one column rebuild runs at a time
 * DATABASE-wide (advisory locks span every session and every process on the
 * database, which is what makes this hold across a rolling deploy, not just
 * within one instance) regardless of which tenant triggered it.
 *
 * Its OWN namespace, deliberately: it never needs to contend with
 * `decideRegistry`, and sharing 4400 would mean a tenant id whose `hashtext`
 * happened to collide with this constant's could block `decideRegistry`'s
 * BLOCKING `pg_advisory_xact_lock` for the length of a rebuild. Cheap class of
 * bug to delete outright.
 */
export const LOCK_NS_COLUMN_REBUILD = 4_401;
const LOCK_KEY_COLUMN_REBUILD = 'vector-column-migration';

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
  /**
   * OM-98 — the run was handed `requireEmpty` and a target turned out to hold
   * vectors, table-wide. Nothing was dropped.
   */
  | 'corpus-not-empty'
  /**
   * Cato-Audit Runde 5 / OM-98 — the run was handed `requireEmpty` and the
   * table-wide probe could not be taken at all (the table lock or the probe
   * timed out). Nothing was dropped, and unlike `corpus-not-empty` this says
   * nothing about whether a corpus exists: it is transient and retryable, and
   * must NOT be presented as a reason to confirm a discard.
   */
  | 'emptiness-unknown'
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
  /**
   * OM-98 — refuse to drop a column that still holds vectors.
   *
   * TIME-OF-CHECK / TIME-OF-USE. The non-destructive reactivation path
   * establishes emptiness in `resolveColumnMigrationPermission`, which runs
   * BEFORE this function takes the advisory lock. Between those two moments a
   * backfill tick or an ingest can embed rows, and the pre-lock verdict then
   * authorises a rewrite that silently discards them. With this flag set the
   * check is re-run as the LAST thing before the DDL — see
   * `assertTableWideEmpty`.
   *
   * Cato-Audit Runde 5 / OM-98 — two properties make that re-check binding
   * rather than decorative, and it had neither before:
   *   - it runs in the SAME TRANSACTION as the `DROP COLUMN`, behind
   *     `LOCK TABLE … IN SHARE ROW EXCLUSIVE MODE`. The advisory lock does not
   *     exclude `embeddingBackfill`, which never takes it, so a re-check in its
   *     own transaction was just a second racy check rather than a fix for the
   *     first;
   *   - it counts TABLE-WIDE. The governed columns live on tables every tenant
   *     shares, so a `WHERE tenant_id = $1` count let an empty tenant authorise
   *     dropping every other tenant's embeddings.
   *
   * Unknown counts abort too. The permission half is fail-closed for exactly
   * the same reason — a probe that timed out is not evidence of an empty
   * corpus — and the two halves have to agree or the guard has a hole.
   *
   * Never set on the operator-confirmed destructive switch: there the discard
   * is the point.
   */
  requireEmpty?: boolean;
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
  // Tracks whether either SESSION-scoped advisory lock may still be held on
  // this connection. Together they are the only thing that decides pooling vs
  // destruction on the way out — see the `finally` at the bottom.
  let lockHeld = false;
  let rebuildLockHeld = false;
  try {
    // Cato-Audit Runde 5 / OM-98 — the GLOBAL rebuild lock comes first, and
    // outside the tenant lock, because the thing it serialises is global: the
    // governed columns live on tables every tenant shares. Two tenants each
    // holding their own registry lock would otherwise be free to drop the same
    // physical column at the same time. Acquired before the tenant key by
    // every caller, so the ordering cannot deadlock; both are `try`, so a
    // loser fails fast instead of eating the activate() budget.
    let acquiredRebuild: boolean;
    try {
      acquiredRebuild = await tryAcquireLock(
        client,
        LOCK_NS_COLUMN_REBUILD,
        LOCK_KEY_COLUMN_REBUILD,
      );
    } catch (err) {
      poisoned = true;
      throw err;
    }
    if (!acquiredRebuild) {
      return {
        ok: false,
        reason: 'lock-held',
        detail:
          'another instance holds the vector-column rebuild lock — a column rewrite is already running (possibly on behalf of a different tenant; the governed columns are shared)',
        migrated,
      };
    }
    rebuildLockHeld = true;

    let acquired: boolean;
    try {
      acquired = await tryAcquireLock(client, LOCK_NS_REGISTRY, opts.tenantId);
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
          // Cato-Audit Runde 5 / OM-98 — `requireEmpty` is now enforced INSIDE
          // the DDL transaction (see `migrateOneColumn`), not out here. Out
          // here it was a second time-of-check/time-of-use hole rather than
          // the fix for the first one: the count ran in its own transaction,
          // took no table lock, and `embeddingBackfill.ts` writes vectors
          // without ever touching the advisory lock this run holds — so rows
          // embedded between this SELECT and the `DROP COLUMN` were still
          // destroyed by a check that had already said "empty".
          reset = await migrateOneColumn(client, target, info, indexes, {
            targetDimensions: opts.targetDimensions,
            tenantId: opts.tenantId,
            statementTimeoutMs,
            lockTimeoutMs,
            attemptResetMaxRows,
            requireEmpty: opts.requireEmpty === true,
          });
        } catch (err) {
          if (await isConnectionAborted(client)) poisoned = true;
          if (err instanceof CorpusNotEmptyError) {
            return { ok: false, reason: 'corpus-not-empty', detail: err.message, migrated };
          }
          if (err instanceof EmptinessUnknownError) {
            return { ok: false, reason: 'emptiness-unknown', detail: err.message, migrated };
          }
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
      if (await releaseLock(client, LOCK_NS_REGISTRY, opts.tenantId)) lockHeld = false;
    }
  } finally {
    // The rebuild lock is released here rather than in its own nested
    // `finally` so that the early `lock-held` return above — which happens
    // AFTER the rebuild lock was taken — cannot leak it. Released in the
    // reverse of the acquisition order: the tenant lock has already gone in
    // the inner `finally` above by the time this runs.
    if (
      rebuildLockHeld &&
      (await releaseLock(client, LOCK_NS_COLUMN_REBUILD, LOCK_KEY_COLUMN_REBUILD))
    ) {
      rebuildLockHeld = false;
    }
    // Same reasoning as the stale-vector clear: a connection that could not
    // provably release its SESSION-level lock is destroyed rather than pooled
    // — otherwise every later migration and every `decideRegistry` on this
    // tenant blocks for the connection's lifetime.
    client.release(poisoned || lockHeld || rebuildLockHeld);
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
 * Cato-Audit Runde 5 / OM-98 — thrown from inside the DDL transaction when the
 * table-wide, table-locked emptiness check refuses the rebuild. A distinct
 * class rather than a flag because it has to travel out through the same
 * `catch` that maps everything else to `ddl-failed`, and the two mean opposite
 * things to an operator: `ddl-failed` is "something broke", this is "the guard
 * did its job".
 */
class CorpusNotEmptyError extends Error {}

/**
 * Cato-Audit Runde 5 / OM-98 — the guard could not ANSWER, which is not the
 * same claim as "there are vectors" and must not be reported as one. Kept
 * separate all the way out to `VectorColumnMigrationFailure` so an operator
 * reading `blocked/…` is not nudged toward the discard confirmation by a lock
 * timeout.
 */
class EmptinessUnknownError extends Error {}

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
    /** Refuse the swap unless the column is empty ACROSS THE WHOLE TABLE. */
    requireEmpty: boolean;
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
    if (opts.requireEmpty) await assertTableWideEmpty(client, target, table);
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

/**
 * Cato-Audit Runde 5 / OM-98 — the emptiness gate, where it actually holds.
 *
 * Runs inside the caller's DDL transaction and does two things the old
 * pre-lock check could not:
 *
 *  1. `LOCK TABLE … IN SHARE ROW EXCLUSIVE MODE` first. The advisory lock this
 *     run holds does NOT exclude the writers that matter — `embeddingBackfill`
 *     (`embeddingBackfill.ts:220-258`) updates `embedding` without taking it at
 *     all — so without a real table lock a backfill tick can land between the
 *     count and the `DROP COLUMN`. SHARE ROW EXCLUSIVE blocks concurrent
 *     INSERT/UPDATE/DELETE while still allowing readers, and it is a lock the
 *     following `ALTER TABLE` only ever escalates from, never contends with.
 *     `SET LOCAL lock_timeout` is already in force, so a table held by a long
 *     writer fails fast instead of eating the activate() budget.
 *  2. Counts TABLE-WIDE, with no `tenant_id` predicate. `graph_nodes` is one
 *     physical table shared by all tenants (`0001_graph_init.sql`), so a
 *     tenant-scoped count let an empty tenant authorise the destruction of
 *     every other tenant's embeddings. That was the bug.
 *
 * Fail-closed: a count that cannot be taken is refused as well, because an
 * unanswerable count is not evidence of an empty corpus.
 */
async function assertTableWideEmpty(
  client: PoolClient,
  target: VectorColumnTarget,
  quotedTable: string,
): Promise<void> {
  let hasVectors: boolean;
  try {
    await client.query(`LOCK TABLE ${quotedTable} IN SHARE ROW EXCLUSIVE MODE`);
    hasVectors = await hasAnyVectorTableWide(client, [target]);
  } catch (err) {
    // A DIFFERENT reason from `corpus-not-empty`, on purpose. Both are
    // fail-closed refusals, but `corpus-not-empty` tells the operator their
    // corpus is populated and points at the discard confirmation — i.e. at
    // DESTRUCTION. A `lock_timeout` behind a long writer must not read as
    // that; it is a "try again", not a "now delete it all".
    throw new EmptinessUnknownError(
      `${target.table}.${target.column}: whether the table still holds vectors could not be established under the table lock (${err instanceof Error ? err.message : String(err)}) — refusing the non-destructive rebuild. An unanswerable probe is not evidence of an empty corpus. This is transient: retry the reactivation when the table is not held by a long-running writer.`,
    );
  }
  if (hasVectors) {
    throw new CorpusNotEmptyError(
      `${target.table}.${target.column}: the table still holds vectors — refusing the non-destructive rebuild rather than discarding them. The probe is table-wide on purpose: DROP COLUMN removes the column for EVERY tenant, so these vectors may belong to a tenant other than the one that triggered this run. Use the provider switch with confirmDiscardVectors, which is the path that carries the discard confirmation.`,
    );
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

/** Take one session-scoped advisory lock. `(ns, key)` is either
 *  `(LOCK_NS_REGISTRY, tenantId)` — the lock `decideRegistry` contends with —
 *  or `(LOCK_NS_COLUMN_REBUILD, LOCK_KEY_COLUMN_REBUILD)`, the global one. */
async function tryAcquireLock(
  client: PoolClient,
  ns: number,
  key: string,
): Promise<boolean> {
  const result = await client.query<{ locked: boolean }>(
    'SELECT pg_try_advisory_lock($1::int, hashtext($2)::int) AS locked',
    [ns, key],
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
async function releaseLock(
  client: PoolClient,
  ns: number,
  key: string,
): Promise<boolean> {
  try {
    const result = await client.query<{ unlocked: boolean }>(
      'SELECT pg_advisory_unlock($1::int, hashtext($2)::int) AS unlocked',
      [ns, key],
    );
    // A fake/limited driver that does not model advisory locks returns no row.
    // It never took a lock either, so "no row" is a clean release — the same
    // symmetry `tryAcquireLock` uses.
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
