import type { Pool } from 'pg';

export type RoutineStatus = 'active' | 'paused';
export type RoutineRunStatus = 'ok' | 'error' | 'timeout';

export interface Routine {
  id: string;
  tenant: string;
  userId: string;
  name: string;
  cron: string;
  prompt: string;
  channel: string;
  conversationRef: unknown;
  status: RoutineStatus;
  timeoutMs: number;
  createdAt: Date;
  updatedAt: Date;
  lastRunAt: Date | null;
  lastRunStatus: RoutineRunStatus | null;
  lastRunError: string | null;
}

export interface CreateRoutineInput {
  tenant: string;
  userId: string;
  name: string;
  cron: string;
  prompt: string;
  channel: string;
  conversationRef: unknown;
  timeoutMs?: number;
}

export interface RecordRunInput {
  id: string;
  status: RoutineRunStatus;
  error?: string | null;
}

export interface RoutineStoreOptions {
  pool: Pool;
  log?: (msg: string) => void;
}

/**
 * Conflict thrown when the (tenant, user_id, name) unique constraint is
 * violated on insert. Callers catch this to surface a friendly "you already
 * have a routine with that name" message instead of a raw pg error.
 */
export class RoutineNameConflictError extends Error {
  constructor(name: string) {
    super(`routine name '${name}' already exists for this user`);
    this.name = 'RoutineNameConflictError';
  }
}

interface RoutineRow {
  id: string;
  tenant: string;
  user_id: string;
  name: string;
  cron: string;
  prompt: string;
  channel: string;
  conversation_ref: unknown;
  status: RoutineStatus;
  timeout_ms: number;
  created_at: Date;
  updated_at: Date;
  last_run_at: Date | null;
  last_run_status: RoutineRunStatus | null;
  last_run_error: string | null;
}

const SELECT_COLUMNS = `
  id, tenant, user_id, name, cron, prompt, channel, conversation_ref,
  status, timeout_ms, created_at, updated_at,
  last_run_at, last_run_status, last_run_error
`;

function rowToRoutine(row: RoutineRow): Routine {
  return {
    id: row.id,
    tenant: row.tenant,
    userId: row.user_id,
    name: row.name,
    cron: row.cron,
    prompt: row.prompt,
    channel: row.channel,
    conversationRef: row.conversation_ref,
    status: row.status,
    timeoutMs: row.timeout_ms,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRunAt: row.last_run_at,
    lastRunStatus: row.last_run_status,
    lastRunError: row.last_run_error,
  };
}

interface PgError {
  code?: string;
  constraint?: string;
}

function isPgError(err: unknown): err is PgError {
  return typeof err === 'object' && err !== null && 'code' in err;
}

/**
 * Persistence for user-created scheduled agent invocations. The
 * RoutineRunner reads at boot, registers each row with the in-memory
 * JobScheduler, and writes back on lifecycle transitions and after each
 * trigger run.
 *
 * Failure model:
 *   - duplicate (tenant, user_id, name) → RoutineNameConflictError
 *   - all other pg errors                → bubble up as-is so callers can
 *                                          decide whether to retry or surface
 */
export class RoutineStore {
  private readonly pool: Pool;
  private readonly log: (msg: string) => void;

  constructor(opts: RoutineStoreOptions) {
    this.pool = opts.pool;
    this.log =
      opts.log ??
      ((msg: string): void => {
        console.error(msg);
      });
  }

  async create(input: CreateRoutineInput): Promise<Routine> {
    try {
      const result = await this.pool.query<RoutineRow>(
        `INSERT INTO routines
           (tenant, user_id, name, cron, prompt, channel,
            conversation_ref, timeout_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
         RETURNING ${SELECT_COLUMNS}`,
        [
          input.tenant,
          input.userId,
          input.name,
          input.cron,
          input.prompt,
          input.channel,
          JSON.stringify(input.conversationRef ?? {}),
          input.timeoutMs ?? 600_000,
        ],
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error('routines insert returned no row');
      }
      return rowToRoutine(row);
    } catch (err) {
      if (
        isPgError(err) &&
        err.code === '23505' &&
        err.constraint === 'routines_user_name_unique'
      ) {
        throw new RoutineNameConflictError(input.name);
      }
      throw err;
    }
  }

  async get(id: string): Promise<Routine | null> {
    const result = await this.pool.query<RoutineRow>(
      `SELECT ${SELECT_COLUMNS} FROM routines WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? rowToRoutine(row) : null;
  }

  /**
   * List a user's routines, newest-updated first. Includes paused rows so
   * the user can see and resume them via the tool.
   */
  async listForUser(tenant: string, userId: string): Promise<Routine[]> {
    const result = await this.pool.query<RoutineRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM routines
        WHERE tenant = $1 AND user_id = $2
        ORDER BY updated_at DESC`,
      [tenant, userId],
    );
    return result.rows.map(rowToRoutine);
  }

  /**
   * Boot-time scan: every active routine across all tenants. Used by the
   * RoutineRunner on startup to seed the in-memory JobScheduler.
   */
  async listAllActive(): Promise<Routine[]> {
    const result = await this.pool.query<RoutineRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM routines
        WHERE status = 'active'
        ORDER BY tenant, user_id, name`,
    );
    return result.rows.map(rowToRoutine);
  }

  /**
   * Operator view: every routine across all tenants, active + paused,
   * newest-updated first. Used by the operator dashboard route. The size
   * is bounded by the global active+paused population — for the v1 cap
   * of 50 per user this stays small. If the paused archive grows past
   * a few thousand, swap for paged listing.
   */
  async listAll(): Promise<Routine[]> {
    const result = await this.pool.query<RoutineRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM routines
        ORDER BY updated_at DESC`,
    );
    return result.rows.map(rowToRoutine);
  }

  /**
   * Count active routines for a user. Used by the tool layer to enforce
   * the per-user quota before calling create().
   */
  async countActiveForUser(tenant: string, userId: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM routines
        WHERE tenant = $1 AND user_id = $2 AND status = 'active'`,
      [tenant, userId],
    );
    const raw = result.rows[0]?.count;
    return raw ? Number.parseInt(raw, 10) : 0;
  }

  /**
   * Flip a routine's status. Returns the updated row, or null if the id
   * was not found. The RoutineRunner mirrors the change into the
   * JobScheduler (register on resume, dispose on pause).
   */
  async setStatus(id: string, status: RoutineStatus): Promise<Routine | null> {
    const result = await this.pool.query<RoutineRow>(
      `UPDATE routines
          SET status = $2, updated_at = now()
        WHERE id = $1
        RETURNING ${SELECT_COLUMNS}`,
      [id, status],
    );
    const row = result.rows[0];
    return row ? rowToRoutine(row) : null;
  }

  /** Returns true if a row was deleted. */
  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM routines WHERE id = $1',
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Record the outcome of a triggered run. Fire-and-forget from the
   * RoutineRunner's perspective: a failing telemetry write logs but
   * never aborts the run.
   */
  async recordRun(input: RecordRunInput): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE routines
            SET last_run_at     = now(),
                last_run_status = $2,
                last_run_error  = $3,
                updated_at      = now()
          WHERE id = $1`,
        [input.id, input.status, input.error ?? null],
      );
    } catch (err) {
      this.log(
        `[routines/store] recordRun failed for id=${input.id}: ${errMsg(err)}`,
      );
    }
  }
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
