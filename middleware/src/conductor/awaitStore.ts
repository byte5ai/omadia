import type { Pool } from 'pg';
import type { JsonValue } from '@omadia/conductor-core';

export type AwaitStatus = 'waiting' | 'resolved' | 'timed_out' | 'cancelled';

export interface ConductorAwait {
  id: string;
  runId: string;
  stepId: string;
  principalKind: 'user' | 'role';
  principalRef: string;
  channelType: string;
  message: string;
  quorum: 'any' | 'all';
  reminderIntervalMs: number | null;
  deadlineAt: Date | null;
  fallbackTransitionId: string | null;
  status: AwaitStatus;
  createdAt: Date;
}

interface AwaitRow {
  id: string;
  run_id: string;
  step_id: string;
  principal_kind: 'user' | 'role';
  principal_ref: string;
  channel_type: string;
  message: string;
  quorum: 'any' | 'all';
  reminder_interval_ms: string | null;
  deadline_at: Date | null;
  fallback_transition_id: string | null;
  status: AwaitStatus;
  created_at: Date;
}

const COLS = `id, run_id, step_id, principal_kind, principal_ref, channel_type, message, quorum,
  reminder_interval_ms, deadline_at, fallback_transition_id, status, created_at`;

function toAwait(r: AwaitRow): ConductorAwait {
  return {
    id: r.id,
    runId: r.run_id,
    stepId: r.step_id,
    principalKind: r.principal_kind,
    principalRef: r.principal_ref,
    channelType: r.channel_type,
    message: r.message,
    quorum: r.quorum,
    reminderIntervalMs: r.reminder_interval_ms === null ? null : Number(r.reminder_interval_ms),
    deadlineAt: r.deadline_at,
    fallbackTransitionId: r.fallback_transition_id,
    status: r.status,
    createdAt: r.created_at,
  };
}

/** Durable pending human action — the net-new substrate (ask_user_choice was in-memory). */
export class ConductorAwaitStore {
  constructor(private readonly pool: Pool) {}

  async create(input: {
    runId: string;
    stepId: string;
    principalKind: 'user' | 'role';
    principalRef: string;
    channelType: string;
    message: string;
    quorum: 'any' | 'all';
    reminderIntervalMs: number | null;
    deadlineAt: Date | null;
    fallbackTransitionId: string | null;
  }): Promise<ConductorAwait> {
    // Idempotent against a crash-and-resume: if an open await already exists for this
    // (run, step), the partial unique index makes the insert a no-op and we return the
    // existing row — never a duplicate await (and so never a duplicate notification).
    const r = await this.pool.query<AwaitRow>(
      `INSERT INTO conductor_awaits
         (run_id, step_id, principal_kind, principal_ref, channel_type, message, quorum,
          reminder_interval_ms, deadline_at, fallback_transition_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (run_id, step_id) WHERE status = 'waiting' DO NOTHING
       RETURNING ${COLS}`,
      [
        input.runId, input.stepId, input.principalKind, input.principalRef, input.channelType,
        input.message, input.quorum, input.reminderIntervalMs, input.deadlineAt, input.fallbackTransitionId,
      ],
    );
    if (r.rows[0]) return toAwait(r.rows[0]);
    const existing = await this.pool.query<AwaitRow>(
      `SELECT ${COLS} FROM conductor_awaits WHERE run_id = $1 AND step_id = $2 AND status = 'waiting' LIMIT 1`,
      [input.runId, input.stepId],
    );
    return toAwait(existing.rows[0]!);
  }

  async get(awaitId: string): Promise<ConductorAwait | null> {
    const r = await this.pool.query<AwaitRow>(`SELECT ${COLS} FROM conductor_awaits WHERE id = $1`, [awaitId]);
    return r.rows[0] ? toAwait(r.rows[0]) : null;
  }

  /** All waiting awaits (the operator inbox). */
  async listWaiting(limit = 100): Promise<ConductorAwait[]> {
    const r = await this.pool.query<AwaitRow>(
      `SELECT ${COLS} FROM conductor_awaits WHERE status = 'waiting' ORDER BY created_at ASC LIMIT $1`,
      [Math.min(Math.max(1, limit), 500)],
    );
    return r.rows.map(toAwait);
  }

  /** Waiting awaits whose deadline has passed (for the deadline worker). */
  async listDue(now: Date): Promise<ConductorAwait[]> {
    const r = await this.pool.query<AwaitRow>(
      `SELECT ${COLS} FROM conductor_awaits
        WHERE status = 'waiting' AND deadline_at IS NOT NULL AND deadline_at <= $1
        ORDER BY deadline_at ASC LIMIT 100`,
      [now],
    );
    return r.rows.map(toAwait);
  }

  async recordResponse(awaitId: string, responderId: string, response: JsonValue): Promise<void> {
    await this.pool.query(
      `INSERT INTO conductor_await_responses (await_id, responder_id, response)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (await_id, responder_id) DO UPDATE SET response = EXCLUDED.response, responded_at = now()`,
      [awaitId, responderId, JSON.stringify(response)],
    );
  }

  /** Atomic transition waiting → resolved/timed_out (FR-018). Returns true iff this call won. */
  async close(awaitId: string, status: 'resolved' | 'timed_out'): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE conductor_awaits SET status = $2, resolved_at = now()
        WHERE id = $1 AND status = 'waiting'`,
      [awaitId, status],
    );
    return (r.rowCount ?? 0) > 0;
  }
}
