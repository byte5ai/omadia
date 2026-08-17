import type { Pool } from 'pg';

/**
 * Audit trail for operator-triggered self-updates (#432, slice 3).
 *
 * Table creation is lazy + idempotent rather than an entry in
 * `middleware/migrations/`, matching `routes/memoryPurge.ts`'s
 * `memory_purge_audit`. That is a deliberate copy: the numbered kernel
 * migrations are applied by `runMultiOrchestratorMigrations` inside the
 * harness-orchestrator plugin, so a deployment that runs without that plugin
 * would silently never get the table — and the audit row would then be the
 * thing that fails on the one operation that most needs a record.
 *
 * The lifecycle is unusual and drives the schema: the process that writes the
 * row is the process the update kills. Only `requested` can be written by the
 * triggering request; the terminal outcome is reconciled afterwards by
 * `reconcileOpenEntries`, once a middleware is running again and can compare
 * its own version against what was asked for.
 */

export type UpdateOutcome = 'requested' | 'succeeded' | 'failed';

export interface UpdateAuditEntry {
  readonly id: string;
  readonly actor: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly outcome: UpdateOutcome;
  readonly detail: string | null;
  readonly createdAt: string;
}

let tableReady: Promise<void> | null = null;

async function ensureTable(pool: Pool): Promise<void> {
  tableReady ??= pool
    .query(
      `CREATE TABLE IF NOT EXISTS update_audit (
         id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         actor        text NOT NULL,
         from_version text NOT NULL,
         to_version   text NOT NULL,
         outcome      text NOT NULL,
         detail       text,
         created_at   timestamptz NOT NULL DEFAULT now()
       )`,
    )
    .then(() => undefined)
    .catch((err: unknown) => {
      // Reset so a transient failure (e.g. pgcrypto not yet available on a
      // cold database) can be retried by the next caller.
      tableReady = null;
      throw err;
    });
  return tableReady;
}

/** Test-only: drop the memoised table-creation promise so a fresh pool
 *  re-runs the DDL. */
export function resetAuditTableCacheForTests(): void {
  tableReady = null;
}

interface AuditRow {
  id: string;
  actor: string;
  from_version: string;
  to_version: string;
  outcome: string;
  detail: string | null;
  created_at: Date | string;
}

function toEntry(row: AuditRow): UpdateAuditEntry {
  return {
    id: row.id,
    actor: row.actor,
    fromVersion: row.from_version,
    toVersion: row.to_version,
    outcome: row.outcome as UpdateOutcome,
    detail: row.detail,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at),
  };
}

export interface UpdateAuditStore {
  recordRequest(input: {
    actor: string;
    fromVersion: string;
    toVersion: string;
  }): Promise<UpdateAuditEntry>;
  list(limit?: number): Promise<UpdateAuditEntry[]>;
  /**
   * Settle every still-`requested` row against the version now running.
   * Called from the status endpoint, i.e. by the middleware that came back up
   * after the restart. A row whose `to_version` matches the running build is
   * `succeeded`; anything older than `staleAfterMs` that still does not match
   * is `failed` (the updater rolled back, or never got that far).
   */
  reconcileOpenEntries(
    runningVersion: string,
    staleAfterMs?: number,
  ): Promise<void>;
}

const DEFAULT_STALE_AFTER_MS = 15 * 60 * 1000;

export function createUpdateAuditStore(pool: Pool): UpdateAuditStore {
  return {
    async recordRequest({ actor, fromVersion, toVersion }) {
      await ensureTable(pool);
      const { rows } = await pool.query<AuditRow>(
        `INSERT INTO update_audit (actor, from_version, to_version, outcome)
         VALUES ($1, $2, $3, 'requested')
         RETURNING *`,
        [actor, fromVersion, toVersion],
      );
      // RETURNING on a single-row INSERT always yields exactly one row.
      return toEntry(rows[0] as AuditRow);
    },

    async list(limit = 20) {
      await ensureTable(pool);
      const { rows } = await pool.query<AuditRow>(
        `SELECT * FROM update_audit ORDER BY created_at DESC LIMIT $1`,
        [Math.max(1, Math.min(limit, 200))],
      );
      return rows.map(toEntry);
    },

    async reconcileOpenEntries(
      runningVersion,
      staleAfterMs = DEFAULT_STALE_AFTER_MS,
    ) {
      await ensureTable(pool);
      await pool.query(
        `UPDATE update_audit
            SET outcome = 'succeeded',
                detail  = COALESCE(detail, 'observed running after restart')
          WHERE outcome = 'requested' AND to_version = $1`,
        [runningVersion],
      );
      await pool.query(
        `UPDATE update_audit
            SET outcome = 'failed',
                detail  = COALESCE(detail, 'target version never observed running')
          WHERE outcome = 'requested'
            AND created_at < now() - make_interval(secs => $1)`,
        // Clamped at 0, not 1: a zero window is a meaningful request ("settle
        // everything still open now"), and only a negative value is nonsense.
        [Math.max(0, Math.round(staleAfterMs / 1000))],
      );
    },
  };
}
