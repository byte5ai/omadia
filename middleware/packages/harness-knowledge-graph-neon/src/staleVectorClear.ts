import type { Pool, PoolClient } from 'pg';

/**
 * #440 — the stale-vector clear, extracted from `embeddingModelGate.ts`.
 *
 * When the embedding provider changes to a different model of the SAME vector
 * width, every stored vector becomes garbage in the new cosine space. There is
 * no in-place conversion, so the only recovery is: drop the vectors, then let
 * `embeddingBackfill` re-embed them. This module owns that drop.
 *
 * Three callers: knowledge-graph activation (capped, so activate() cannot
 * stall on a large corpus), the gate's "recorded model matches but a clear is
 * still owed" resume path, and the backfill sweep. All three run while vector
 * writes are REFUSED, which is what makes the invariant this module depends on
 * — "a non-NULL governed vector is an old-model vector" — true by
 * construction. That refusal covers every gate outcome that can coexist with
 * `clear_pending`, INCLUDING `unknown-provider`: an adapter carrying no model
 * metadata used to short-circuit the gate before the registry was read, and
 * the hot path then refilled each tick exactly what the sweep had NULLed.
 *
 * Soundness notes, all learned the hard way:
 *   - a session-level advisory lock keeps two clearers off the same tenant. A
 *     clearer that cannot take the lock reports `pending: true` and does
 *     nothing, so it can never lower `clear_pending` over rows it never saw;
 *   - `rowCount < limit` does NOT mean "done". Under READ COMMITTED a
 *     concurrent updater makes rows drop out of the predicate after the LIMIT
 *     was applied, so a short batch is ambiguous. The loop only stops on a
 *     batch that changed nothing, and then re-probes for residual rows before
 *     anybody may declare the clear finished;
 *   - a connection whose ROLLBACK failed is DESTROYED rather than returned to
 *     the pool. It is stuck in an aborted transaction, so the advisory-unlock
 *     on the way out fails too, and reuse would keep the tenant's clear lock
 *     held for the connection's lifetime — after which every later clearer
 *     reports "still pending" and the flag never drops.
 */

/** Advisory-lock namespace (first key of the two-int form). */
const LOCK_NS_CLEAR = 4_401;

/**
 * Columns reset on a same-dimension model switch, and the extra bookkeeping
 * each one needs. `discoverGovernedVectorColumns` is the authority on which
 * vector columns EXIST; this list says which ones we know how to clear. A
 * column that shows up in discovery but not here is reported loudly rather
 * than silently left holding foreign-model vectors.
 */
export const CLEARABLE_COLUMNS: ReadonlyArray<{
  table: string;
  column: string;
  /** Extra SET fragments applied together with `column = NULL`. */
  extraSet: string;
}> = [
  {
    table: 'graph_nodes',
    column: 'embedding',
    // Reset the attempt counter for the rows we actually clear. Rows that are
    // ALREADY NULL because they exhausted their retries can never match
    // `embedding IS NOT NULL`; those are handled by ATTEMPT_RESETS below.
    extraSet:
      ', embedding_attempts = 0, embedding_last_error = NULL, embedding_last_error_at = NULL',
  },
  // `processes.embedding` (migration 0009) is a second cosine space, used for
  // the write-path dedup pre-check AND for hybrid recall. It has to be cleared
  // on the same switch, otherwise process recall silently scores old-model
  // vectors against new-model queries forever.
  { table: 'processes', column: 'embedding', extraSet: '' },
];

/**
 * Rows whose vector is already NULL but whose retry budget is spent.
 *
 * Invisible to the clear above (`embedding IS NOT NULL` can never match them)
 * yet exactly the rows a provider switch is supposed to rescue: a node that
 * failed to embed five times because the old sidecar was down is permanently
 * skipped by `embeddingBackfill`'s `embedding_attempts < maxAttempts`
 * predicate. Without this statement the reset in `CLEARABLE_COLUMNS[0]` is
 * dead code for precisely the rows it was written for.
 *
 * `embedding_attempts > 0` rather than `>= maxAttempts`: this module does not
 * know the backfill's cap, and clearing a partially-spent counter after a
 * provider switch is desirable anyway — those failures were the old
 * provider's, not the new one's.
 */
export const ATTEMPT_RESETS: ReadonlyArray<{
  table: string;
  set: string;
  where: string;
}> = [
  {
    table: 'graph_nodes',
    set: 'embedding_attempts = 0, embedding_last_error = NULL, embedding_last_error_at = NULL',
    where: 'embedding IS NULL AND embedding_attempts > 0',
  },
];

export interface ClearOptions {
  batchSize: number;
  maxRows: number;
  statementTimeoutMs: number;
}

/** Per-column tally of a stale-vector clear pass. */
export interface StaleVectorClearResult {
  clearedByTable: Record<string, number>;
  totalCleared: number;
  /** `true` when rows are still owed — cap hit, residual rows detected, or
   *  another clearer holds the lock. Never lower `clear_pending` on this. */
  pending: boolean;
  /** Exhausted `embedding_attempts` counters reset so the backfill can pick
   *  those rows up again under the new provider. */
  attemptsReset: number;
}

/** Is a stale-vector clear still owed for this tenant? */
export async function isStaleVectorClearPending(
  pool: Pool,
  tenantId: string,
): Promise<boolean> {
  const result = await pool.query<{ clear_pending: boolean }>(
    'SELECT clear_pending FROM graph_embedding_model WHERE tenant_id = $1',
    [tenantId],
  );
  return result.rows[0]?.clear_pending === true;
}

/** Clear foreign-model vectors in bounded batches. See the module header. */
export async function clearStaleVectors(
  pool: Pool,
  tenantId: string,
  opts: ClearOptions,
): Promise<StaleVectorClearResult> {
  const clearedByTable: Record<string, number> = {};
  let totalCleared = 0;
  let attemptsReset = 0;
  let pending = false;

  const client: PoolClient = await pool.connect();
  const session: ClearSession = { poisoned: false };
  try {
    if (!(await tryAcquireClearLock(client, tenantId))) {
      // Somebody else is clearing this tenant right now. Report the work as
      // still owed — anything else risks lowering `clear_pending` over rows
      // we never looked at.
      return { clearedByTable, totalCleared: 0, pending: true, attemptsReset: 0 };
    }
    try {
      for (const target of CLEARABLE_COLUMNS) {
        const step = {
          table: target.table,
          set: `${target.column} = NULL${target.extraSet}`,
          where: `${target.column} IS NOT NULL`,
        };
        const run = await drain(client, step, tenantId, opts, session);
        clearedByTable[target.table] = run.affected;
        totalCleared += run.affected;
        if (run.pending) pending = true;
      }

      // Rows that were already NULL but out of retry budget — the clear above
      // structurally cannot reach them.
      for (const reset of ATTEMPT_RESETS) {
        const run = await drain(client, reset, tenantId, opts, session);
        attemptsReset += run.affected;
        if (run.pending) pending = true;
      }

      if (!pending) {
        await client.query(
          `UPDATE graph_embedding_model
              SET clear_pending = FALSE, updated_at = now()
            WHERE tenant_id = $1`,
          [tenantId],
        );
      }
    } finally {
      await releaseClearLock(client, tenantId);
    }
  } finally {
    // `release(true)` DESTROYS the connection instead of returning it to the
    // pool. That is what a poisoned client needs: it sits inside an aborted
    // transaction, so the `pg_advisory_unlock` above already failed (silently,
    // by design), and the session-scoped clear lock would stay held for as
    // long as the pool kept reusing that connection — after which every later
    // clearer for this tenant reports `pending: true` forever and the flag
    // never drops. Destroying the connection releases the lock with it.
    client.release(session.poisoned);
  }

  return { clearedByTable, totalCleared, pending, attemptsReset };
}

interface ClearStep {
  table: string;
  set: string;
  where: string;
}

/** Per-`clearStaleVectors` connection state. `poisoned` means the connection
 *  is stuck inside an aborted transaction and must not go back to the pool. */
interface ClearSession {
  poisoned: boolean;
}

/**
 * Run bounded batches until the predicate stops matching anything reachable,
 * then verify. Progress is monotonic (rows leave the predicate for good while
 * vector writes are refused), so the loop terminates; the residual probe is
 * what turns "the last batch was short" into an actual answer.
 */
async function drain(
  client: PoolClient,
  step: ClearStep,
  tenantId: string,
  opts: ClearOptions,
  session: ClearSession,
): Promise<{ affected: number; pending: boolean }> {
  let done = 0;
  for (;;) {
    // Hitting the cap is not by itself proof that rows remain — the last batch
    // may have drained the table exactly. The residual probe below decides.
    if (done >= opts.maxRows) break;
    const limit = Math.min(opts.batchSize, opts.maxRows - done);
    const affected = await runBoundedUpdate(
      client,
      step,
      tenantId,
      limit,
      opts,
      session,
    );
    done += affected;
    // A zero batch means we reached everything reachable — rows another
    // session holds locked included, which is why the probe below still runs.
    if (affected === 0) break;
  }
  const residual = await hasResidualRows(client, step, tenantId);
  return { affected: done, pending: residual };
}

async function tryAcquireClearLock(
  client: PoolClient,
  tenantId: string,
): Promise<boolean> {
  const result = await client.query<{ locked: boolean }>(
    'SELECT pg_try_advisory_lock($1::int, hashtext($2)::int) AS locked',
    [LOCK_NS_CLEAR, tenantId],
  );
  // A fake/limited driver that does not model advisory locks returns no row;
  // treat that as "acquired" so unit tests still exercise the clear itself.
  const row = result.rows[0];
  return row === undefined || row.locked !== false;
}

async function releaseClearLock(
  client: PoolClient,
  tenantId: string,
): Promise<void> {
  try {
    await client.query('SELECT pg_advisory_unlock($1::int, hashtext($2)::int)', [
      LOCK_NS_CLEAR,
      tenantId,
    ]);
  } catch {
    // Best-effort: the lock is session-scoped and the connection goes back to
    // the pool, where a reset drops it anyway.
  }
}

/** Anything left that the bounded loop did not manage to update? */
async function hasResidualRows(
  client: PoolClient,
  step: ClearStep,
  tenantId: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 AS residual
       FROM ${step.table}
      WHERE tenant_id = $1 AND ${step.where}
      LIMIT 1`,
    [tenantId],
  );
  return (result.rowCount ?? result.rows.length) > 0;
}

/**
 * One bounded UPDATE, in its own transaction with its own statement timeout.
 *
 * `ctid IN (SELECT … LIMIT n FOR UPDATE SKIP LOCKED)` is the bounded-update
 * idiom; table/column names come from the module-local constants above, never
 * from user input. `SKIP LOCKED` matters: without it a concurrent updater
 * blocks this session on the same ctids, and on unblock Postgres re-evaluates
 * the predicate against the now-updated tuple, silently dropping those rows
 * from the update and returning a short `rowCount` that looks exactly like
 * "nothing left to do".
 */
async function runBoundedUpdate(
  client: PoolClient,
  step: ClearStep,
  tenantId: string,
  limit: number,
  opts: ClearOptions,
  session: ClearSession,
): Promise<number> {
  await client.query('BEGIN');
  try {
    await client.query(
      `SET LOCAL statement_timeout = ${String(Math.max(1, Math.floor(opts.statementTimeoutMs)))}`,
    );
    const result = await client.query(
      `UPDATE ${step.table}
          SET ${step.set}
        WHERE ctid IN (
                SELECT ctid
                  FROM ${step.table}
                 WHERE tenant_id = $1 AND ${step.where}
                 ORDER BY ctid
                 LIMIT ${String(Math.max(1, Math.floor(limit)))}
                 FOR UPDATE SKIP LOCKED
              )`,
      [tenantId],
    );
    await client.query('COMMIT');
    return result.rowCount ?? 0;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The ROLLBACK itself failed, so the connection is still inside an
      // aborted transaction and every further statement on it errors out —
      // including the `pg_advisory_unlock` on the way out, whose failure is
      // swallowed on purpose. Returning such a connection to the pool leaks
      // the session-scoped clear lock for its whole lifetime. Mark it so the
      // caller destroys it instead.
      session.poisoned = true;
    }
    throw err;
  }
}
