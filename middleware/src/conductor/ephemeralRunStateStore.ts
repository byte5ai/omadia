// Durable per-run state for ephemeral runs (#330 follow-up, migration 0012).
//
// Why: on 2026-10-15 a deploy restart wiped the Facilitator plugin's in-memory
// store while its durable facilitation run kept ticking hourly against "no
// active facilitation known". Runs survive restarts; the plugin's knowledge of
// them did not. This store gives an agent two owner-scoped seams: read back
// every active ephemeral run it created (with the context it was started with
// and the last state blob it saved), and upsert that blob.
//
// The owner guard lives IN the SQL, never in a pre-check: every query joins
// runs → versions → workflows and filters on `created_by_agent`, so an agent
// can neither read nor write state of a run another agent created, and a
// write against a terminal, reaped or foreign run is a silent no-op
// (rowCount 0) instead of a race-prone read-then-write.

import type { Pool } from 'pg';

export interface OwnActiveRunRow {
  runId: string;
  workflowId: string;
  workflowSlug: string;
  expiresAt: Date;
  /** The run context (start payload plus executor-owned keys — the caller strips those). */
  context: Record<string, unknown>;
  patternId: string | null;
  /** Last saved state blob, or null when the agent never saved one. */
  state: Record<string, unknown> | null;
}

export interface OwnedRunRow {
  runId: string;
  status: string;
}

/** Mirrors the 0012 size CHECK on conductor_ephemeral_run_state.state. */
export const MAX_RUN_STATE_BYTES = 16 * 1024;

/** Postgres refused the blob for a reason the caller controls. */
export class RunStateRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunStateRejectedError';
  }
}

/** The 0012 size CHECK rejected the blob — jsonb's canonical text can be a few
 *  bytes longer than the caller's JSON.stringify measurement. */
export class RunStateSizeExceededError extends RunStateRejectedError {
  constructor() {
    super(`run state exceeds the ${MAX_RUN_STATE_BYTES}-byte storage limit`);
    this.name = 'RunStateSizeExceededError';
  }
}

const SIZE_CHECK_CONSTRAINT = 'conductor_ephemeral_run_state_size_check';
const PG_CHECK_VIOLATION = '23514';
/** jsonb cannot represent U+0000 ("unsupported Unicode escape sequence"). */
const PG_UNTRANSLATABLE_CHARACTER = '22P05';

interface RawActiveRunRow {
  run_id: unknown;
  workflow_id: unknown;
  workflow_slug: unknown;
  expires_at: unknown;
  context: unknown;
  pattern_id: unknown;
  state: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function toDate(value: unknown, field: string): Date {
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) {
    throw new Error(`conductor_ephemeral_run_state: unexpected ${field} value from pg`);
  }
  return date;
}

function toActiveRun(row: RawActiveRunRow): OwnActiveRunRow {
  if (typeof row.run_id !== 'string' || typeof row.workflow_id !== 'string' || typeof row.workflow_slug !== 'string') {
    throw new Error('conductor_ephemeral_run_state: malformed run row from pg');
  }
  return {
    runId: row.run_id,
    workflowId: row.workflow_id,
    workflowSlug: row.workflow_slug,
    expiresAt: toDate(row.expires_at, 'expires_at'),
    context: isPlainObject(row.context) ? row.context : {},
    patternId: typeof row.pattern_id === 'string' && row.pattern_id.length > 0 ? row.pattern_id : null,
    state: isPlainObject(row.state) ? row.state : null,
  };
}

function toRejection(err: unknown): RunStateRejectedError | null {
  if (typeof err !== 'object' || err === null) return null;
  const { code, constraint } = err as { code?: unknown; constraint?: unknown };
  if (code === PG_CHECK_VIOLATION && constraint === SIZE_CHECK_CONSTRAINT) return new RunStateSizeExceededError();
  if (code === PG_UNTRANSLATABLE_CHARACTER) return new RunStateRejectedError('run state contains a character jsonb cannot store');
  return null;
}

export class ConductorEphemeralRunStateStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Every live ephemeral run this agent created: un-reaped, not expired,
   * running/waiting and not already asked to cancel — the set a restarted
   * plugin must rehydrate. One query; the state blob is LEFT-joined.
   */
  async listOwnActiveRuns(agentId: string, now: Date): Promise<OwnActiveRunRow[]> {
    const r = await this.pool.query<RawActiveRunRow>(
      `SELECT r.id AS run_id, w.id AS workflow_id, w.slug AS workflow_slug, w.expires_at,
              r.context, r.trigger_source->>'patternId' AS pattern_id, s.state
         FROM conductor_runs r
         JOIN conductor_workflow_versions v ON r.workflow_version_id = v.id
         JOIN conductor_workflows w ON v.workflow_id = w.id
         LEFT JOIN conductor_ephemeral_run_state s ON s.run_id = r.id
        WHERE w.origin = 'ephemeral'
          AND w.created_by_agent = $1
          AND w.reaped_at IS NULL
          AND w.expires_at > $2
          AND r.status IN ('running', 'waiting')
          AND r.cancel_requested_at IS NULL
        ORDER BY r.started_at ASC`,
      [agentId, now],
    );
    return r.rows.map(toActiveRun);
  }

  /**
   * Owner-guarded upsert in ONE statement: the INSERT…SELECT only yields a row
   * when the run is an active, un-reaped, unexpired, uncancelled ephemeral run
   * this agent created (the same set listOwnActiveRuns returns). Returns false
   * otherwise.
   *
   * `FOR SHARE OF w` closes the purge-on-reap race: markReaped's UPDATE takes
   * the workflow row lock, so a write that starts after it waits, re-checks
   * `reaped_at IS NULL` on the committed row and inserts nothing. The opposite
   * order (write commits while markReaped's purge already holds its snapshot)
   * can still leave a row; ConductorEphemeralStore.purgeReapedRunState, run on
   * every reaper tick, sweeps those.
   */
  async upsertOwned(agentId: string, runId: string, state: Record<string, unknown>): Promise<boolean> {
    try {
      const r = await this.pool.query(
        `INSERT INTO conductor_ephemeral_run_state (run_id, agent_id, state, updated_at)
         SELECT r.id, $2, $3::jsonb, now()
           FROM conductor_runs r
           JOIN conductor_workflow_versions v ON r.workflow_version_id = v.id
           JOIN conductor_workflows w ON v.workflow_id = w.id
          WHERE r.id = $1
            AND w.created_by_agent = $2
            AND w.origin = 'ephemeral'
            AND w.reaped_at IS NULL
            AND w.expires_at > now()
            AND r.status IN ('running', 'waiting')
            AND r.cancel_requested_at IS NULL
            FOR SHARE OF w
         ON CONFLICT (run_id) DO UPDATE
            SET state = EXCLUDED.state, agent_id = EXCLUDED.agent_id, updated_at = now()`,
        [runId, agentId, JSON.stringify(state)],
      );
      return (r.rowCount ?? 0) > 0;
    } catch (err) {
      throw toRejection(err) ?? err;
    }
  }

  /**
   * The run if it is an ephemeral run this agent created — deliberately in ANY
   * status, so a cancel can answer `already_ended` instead of `not_found` for
   * the agent's own finished run. Null for unknown or foreign runs.
   */
  async getOwnedRun(agentId: string, runId: string): Promise<OwnedRunRow | null> {
    const r = await this.pool.query<{ run_id: unknown; status: unknown }>(
      `SELECT r.id AS run_id, r.status
         FROM conductor_runs r
         JOIN conductor_workflow_versions v ON r.workflow_version_id = v.id
         JOIN conductor_workflows w ON v.workflow_id = w.id
        WHERE r.id = $1
          AND w.created_by_agent = $2
          AND w.origin = 'ephemeral'`,
      [runId, agentId],
    );
    const row = r.rows[0];
    if (!row) return null;
    if (typeof row.run_id !== 'string' || typeof row.status !== 'string') {
      throw new Error('conductor_ephemeral_run_state: malformed owned-run row from pg');
    }
    return { runId: row.run_id, status: row.status };
  }
}
