import type { Pool } from 'pg';

import {
  parseRoutineOutputTemplate,
  type RoutineOutputTemplate,
} from './routineOutputTemplate.js';

export type RoutineStatus = 'active' | 'paused';
export type RoutineRunStatus = 'ok' | 'error' | 'timeout' | 'cancelled' | 'silent';

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
  /**
   * Phase C — optional output template. Null/absent means the legacy
   * LLM-authors-everything path runs (current behaviour). When set,
   * the orchestrator routes the run through the template-rendering
   * pipeline so data sections come from the raw tool result, not
   * from the LLM. Loaded as JSONB from the `output_template` column.
   */
  outputTemplate: RoutineOutputTemplate | null;
  /**
   * #1598 — slug of the orchestrator that created the routine (migration
   * 0005). The run resolves that orchestrator, so the routine has exactly the
   * plugins its orchestrator is granted. `null` = the standard orchestrator.
   */
  agentSlug?: string | null;
  /** #2082 — the deadline of the routine's trigger (migration 0006). */
  until?: Date | null;
  /** #2082 — when the owner was asked whether the routine should go on. */
  renewalAskedAt?: Date | null;
  /** #1743 / ADR 0240 — IANA zone of the cron pattern (migration 0008); null = UTC. */
  timezone?: string | null;
  /** #1745 — id of the agent that runs it (migration 0009); null = bound on its next run. */
  agentId?: string | null;
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
  /** Phase C — optional output template (see Routine.outputTemplate). */
  outputTemplate?: RoutineOutputTemplate | null;
  /** #1598 — see Routine.agentSlug. */
  agentSlug?: string | null;
  /** #1743 — see Routine.timezone. */
  timezone?: string | null;
  /** #1745 — see Routine.agentId. */
  agentId?: string | null;
}

export interface RecordRunInput {
  id: string;
  status: RoutineRunStatus;
  error?: string | null;
}

/**
 * #1025 — the (tenant, user_id) pair a scoped mutation must match. Same
 * pair `listForUser` filters on and `create` enforces uniqueness within,
 * so "the rows this principal can see" and "the rows it can act on" are
 * one definition rather than two that can drift apart.
 */
export interface RoutineOwner {
  tenant: string;
  userId: string;
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
  /** Phase C — JSONB column added in migration 0004. NULL for legacy
   *  routines; structured `RoutineOutputTemplate` shape when set. */
  output_template: unknown;
  /** #1598 — migration 0005. */
  agent_slug: string | null;
  /** #2082 — migration 0006. */
  until: Date | null;
  renewal_asked_at: Date | null;
  /** #1743 — migration 0008. */
  timezone: string | null;
  /** #1745 — migration 0009. */
  agent_id: string | null;
}

const SELECT_COLUMNS = `
  id, tenant, user_id, name, cron, prompt, channel, conversation_ref,
  status, timeout_ms, created_at, updated_at,
  last_run_at, last_run_status, last_run_error,
  output_template, agent_slug, until, renewal_asked_at, timezone, agent_id
`;

function rowToRoutine(row: RoutineRow): Routine {
  // Phase C — parse + validate the JSONB blob. Invalid templates are
  // logged at the caller and treated as NULL so a broken template
  // does not break the routine entirely.
  let outputTemplate: RoutineOutputTemplate | null = null;
  if (row.output_template !== null && row.output_template !== undefined) {
    const parsed = parseRoutineOutputTemplate(row.output_template);
    if (parsed.ok) {
      outputTemplate = parsed.value;
    } else {
      console.warn(
        `[routineStore] routine id=${row.id} has invalid output_template, falling back to legacy path: ${parsed.reason}`,
      );
    }
  }
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
    outputTemplate,
    agentSlug: row.agent_slug ?? null,
    until: row.until ?? null,
    renewalAskedAt: row.renewal_asked_at ?? null,
    timezone: row.timezone ?? null,
    agentId: row.agent_id ?? null,
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
            conversation_ref, timeout_ms, output_template, agent_slug, timezone, agent_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10, $11, $12)
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
          input.outputTemplate !== undefined && input.outputTemplate !== null
            ? JSON.stringify(input.outputTemplate)
            : null,
          input.agentSlug ?? null,
          input.timezone ?? null,
          input.agentId ?? null,
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
   * Look up a single routine by its (tenant, user_id, name) unique key —
   * the same triple `create()` enforces via `routines_user_name_unique`.
   * Used by the runner to reconcile a `RoutineNameConflictError` against
   * the row that already won the race (see issue #506: a retried create
   * after an ambiguous confirmation must not be told it failed).
   */
  async getByName(
    tenant: string,
    userId: string,
    name: string,
  ): Promise<Routine | null> {
    const result = await this.pool.query<RoutineRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM routines
        WHERE tenant = $1 AND user_id = $2 AND name = $3`,
      [tenant, userId, name],
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
   * Phase C.7 — Set or clear the output_template column on a routine.
   * Passing `null` reverts the routine to the legacy LLM-authors-
   * everything path; passing an object opts into the server-side
   * template pipeline (C.5/C.6).
   *
   * Does not touch the JobScheduler — template state has no bearing on
   * cron firing. Returns the updated routine, or null if `id` was not
   * found.
   */
  async setOutputTemplate(
    id: string,
    template: RoutineOutputTemplate | null,
  ): Promise<Routine | null> {
    const result = await this.pool.query<RoutineRow>(
      `UPDATE routines
          SET output_template = $2::jsonb,
              updated_at      = now()
        WHERE id = $1
        RETURNING ${SELECT_COLUMNS}`,
      [id, template !== null ? JSON.stringify(template) : null],
    );
    const row = result.rows[0];
    return row ? rowToRoutine(row) : null;
  }

  /**
   * Replace the stored delivery handle (`conversation_ref`) on a routine.
   *
   * Used by the cold-start proactive path: a channel sender resolves a
   * `ColdStartTarget` into a live, channel-native conversation reference on
   * first delivery and persists it here so subsequent runs deliver via the
   * warm path without re-installing / re-opening a chat. Does not touch the
   * JobScheduler — the delivery handle has no bearing on cron firing.
   * Returns the updated routine, or null if `id` was not found.
   */
  async updateConversationRef(
    id: string,
    conversationRef: unknown,
  ): Promise<Routine | null> {
    const result = await this.pool.query<RoutineRow>(
      `UPDATE routines
          SET conversation_ref = $2::jsonb,
              updated_at        = now()
        WHERE id = $1
        RETURNING ${SELECT_COLUMNS}`,
      [id, JSON.stringify(conversationRef ?? {})],
    );
    const row = result.rows[0];
    return row ? rowToRoutine(row) : null;
  }

  /**
   * Flip a routine's status. Returns the updated row, or null if the id
   * was not found. The RoutineRunner mirrors the change into the
   * JobScheduler (register on resume, dispose on pause).
   */
  async setStatus(
    id: string,
    status: RoutineStatus,
    owner?: RoutineOwner,
  ): Promise<Routine | null> {
    // #1025 — an `owner` narrows the WHERE clause to that (tenant, user_id),
    // so a row belonging to someone else returns null exactly like a
    // non-existent id. The predicate lives HERE rather than as a
    // read-then-act check in the caller: a single statement cannot be
    // raced, and a caller that forgets the check cannot bypass a scope it
    // never supplied.
    const result = owner
      ? await this.pool.query<RoutineRow>(
          `UPDATE routines
              SET status = $2, updated_at = now()
            WHERE id = $1 AND tenant = $3 AND user_id = $4
            RETURNING ${SELECT_COLUMNS}`,
          [id, status, owner.tenant, owner.userId],
        )
      : await this.pool.query<RoutineRow>(
          `UPDATE routines
              SET status = $2, updated_at = now()
            WHERE id = $1
            RETURNING ${SELECT_COLUMNS}`,
          [id, status],
        );
    const row = result.rows[0];
    return row ? rowToRoutine(row) : null;
  }

  /**
   * #2082 — set the deadline of a routine's trigger. A new deadline clears
   * the renewal question, so the owner is asked again before it ends.
   */
  async setUntil(id: string, until: Date | null): Promise<Routine | null> {
    const result = await this.pool.query<RoutineRow>(
      `UPDATE routines SET until = $2, renewal_asked_at = NULL, updated_at = now()
        WHERE id = $1 RETURNING ${SELECT_COLUMNS}`,
      [id, until],
    );
    const row = result.rows[0];
    return row ? rowToRoutine(row) : null;
  }

  /** #2082 — active routines whose deadline lies before `before`. */
  async listActiveEndingBefore(before: Date): Promise<Routine[]> {
    const result = await this.pool.query<RoutineRow>(
      `SELECT ${SELECT_COLUMNS} FROM routines
        WHERE status = 'active' AND until IS NOT NULL AND until < $1
        ORDER BY until`,
      [before],
    );
    return result.rows.map(rowToRoutine);
  }

  /** #2082 — the owner was asked about renewal (once per deadline). */
  async markRenewalAsked(id: string, at: Date): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE routines SET renewal_asked_at = $2 WHERE id = $1 AND renewal_asked_at IS NULL`,
      [id, at],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** #2082 — the deadline passed: paused, with an error that says so. */
  async markExpired(id: string, message: string): Promise<Routine | null> {
    const result = await this.pool.query<RoutineRow>(
      `UPDATE routines SET status = 'paused', last_run_error = $2, updated_at = now()
        WHERE id = $1 AND status = 'active' RETURNING ${SELECT_COLUMNS}`,
      [id, message],
    );
    const row = result.rows[0];
    return row ? rowToRoutine(row) : null;
  }

  /** #1745 — bind a routine created before agent ids to the agent that runs it now. */
  async bindAgentId(id: string, agentId: string): Promise<void> {
    await this.pool.query(
      'UPDATE routines SET agent_id = $2 WHERE id = $1 AND agent_id IS NULL',
      [id, agentId],
    );
  }

  /**
   * #1744 — the agent ended service (disabled, deleted): every active routine
   * it runs is paused with `message`, so none fires into an error. Matches
   * the id, and the slug for rows not yet bound by id. Returns the paused ids.
   */
  async pauseForAgent(agentId: string, agentSlug: string, message: string): Promise<string[]> {
    const result = await this.pool.query<{ id: string }>(
      `UPDATE routines SET status = 'paused', last_run_error = $3, updated_at = now()
        WHERE status = 'active'
          AND (agent_id = $1 OR (agent_id IS NULL AND agent_slug = $2))
        RETURNING id`,
      [agentId, agentSlug, message],
    );
    return result.rows.map((r) => r.id);
  }

  /**
   * Returns true if a row was deleted.
   *
   * #1025 — see `setStatus`: an `owner` scopes the delete, so another
   * tenant's id reports false instead of removing the row.
   */
  async delete(id: string, owner?: RoutineOwner): Promise<boolean> {
    const result = owner
      ? await this.pool.query(
          'DELETE FROM routines WHERE id = $1 AND tenant = $2 AND user_id = $3',
          [id, owner.tenant, owner.userId],
        )
      : await this.pool.query('DELETE FROM routines WHERE id = $1', [id]);
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
