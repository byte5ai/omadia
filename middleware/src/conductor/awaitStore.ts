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
  /** true when the last reminder found no reachable holder (no channel binding) — operator signal. */
  unreachable: boolean;
  createdAt: Date;
}

/** Resolve an await's principal to concrete holder ids — `role:` via the resolver, `user:` as itself.
 *  Shared by the reminder worker and the operator inbox so the rule never drifts. */
export async function resolveAwaitHolders(
  aw: Pick<ConductorAwait, 'principalKind' | 'principalRef'>,
  resolveRole: (roleKey: string) => Promise<string[]>,
): Promise<string[]> {
  return aw.principalKind === 'role' ? resolveRole(aw.principalRef) : [aw.principalRef];
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
  unreachable: boolean;
  created_at: Date;
}

const COLS = `id, run_id, step_id, principal_kind, principal_ref, channel_type, message, quorum,
  reminder_interval_ms, deadline_at, fallback_transition_id, status, unreachable, created_at`;

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
    unreachable: r.unreachable,
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

  /**
   * All waiting HUMAN awaits (the operator inbox). Dev-job awaits (`channel_type='dev_job'`,
   * Epic #470 W3) are excluded: they have no human holder and are resolved by a terminal dev-job
   * outcome, not an operator response — surfacing them would show a phantom, un-actionable row
   * whose `respond` can only ever be rejected by the authz gate.
   */
  async listWaiting(limit = 100): Promise<ConductorAwait[]> {
    const r = await this.pool.query<AwaitRow>(
      `SELECT ${COLS} FROM conductor_awaits
        WHERE status = 'waiting' AND channel_type <> 'dev_job'
        ORDER BY created_at ASC LIMIT $1`,
      [Math.min(Math.max(1, limit), 500)],
    );
    return r.rows.map(toAwait);
  }

  /**
   * Waiting dev-job awaits (`channel_type='dev_job'`) — the reconciliation sweep's input
   * (Epic #470 W3). Deliberately the COMPLEMENT of {@link listWaiting}: these carry a synthetic
   * `dev_job:<jobId>` principal and are recovered by `reconcileTerminalDevJobAwaits`, which asks
   * the dev-job port whether the bound job is already terminal (closing the terminal-before-bind
   * lost-wakeup window).
   */
  async listWaitingDevJobAwaits(limit = 200): Promise<ConductorAwait[]> {
    const r = await this.pool.query<AwaitRow>(
      `SELECT ${COLS} FROM conductor_awaits
        WHERE status = 'waiting' AND channel_type = 'dev_job'
        ORDER BY created_at ASC LIMIT $1`,
      [Math.min(Math.max(1, limit), 1000)],
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

  /**
   * Candidate awaits whose reminder interval has elapsed (and whose deadline has not yet passed).
   * The interval counts from `COALESCE(last_reminder_at, created_at)`, so the FIRST reminder waits a
   * full interval after the await opened (the holder was already notified at open time) rather than
   * firing on the next tick.
   */
  async listRemindersDue(now: Date): Promise<ConductorAwait[]> {
    const r = await this.pool.query<AwaitRow>(
      `SELECT ${COLS} FROM conductor_awaits
        WHERE status = 'waiting'
          AND reminder_interval_ms IS NOT NULL
          AND COALESCE(last_reminder_at, created_at) + (reminder_interval_ms * interval '1 millisecond') <= $1
          AND (deadline_at IS NULL OR deadline_at > $1)
        ORDER BY created_at ASC LIMIT 100`,
      [now],
    );
    return r.rows.map(toAwait);
  }

  /**
   * Atomically claim a reminder slot: advance `last_reminder_at` to now ONLY if the await is still
   * waiting and genuinely due (same predicate as listRemindersDue). Returns true iff this caller won.
   * Claim-THEN-send: advancing the clock before delivery means a send/record failure (or a crash, or
   * a second replica) can re-deliver at most once per interval rather than every tick (at-most-once
   * nudges — losing one reminder on a crash is safer than a per-minute storm). Replica-safe.
   */
  async claimReminderDue(awaitId: string, now: Date): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE conductor_awaits SET last_reminder_at = $2
        WHERE id = $1
          AND status = 'waiting'
          AND reminder_interval_ms IS NOT NULL
          AND COALESCE(last_reminder_at, created_at) + (reminder_interval_ms * interval '1 millisecond') <= $2
          AND (deadline_at IS NULL OR deadline_at > $2)`,
      [awaitId, now],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** Set the `unreachable` operator signal after a delivery attempt (false clears a stale flag). */
  async setReminderUnreachable(awaitId: string, unreachable: boolean): Promise<void> {
    await this.pool.query(`UPDATE conductor_awaits SET unreachable = $2 WHERE id = $1`, [awaitId, unreachable]);
  }

  async recordResponse(awaitId: string, responderId: string, response: JsonValue): Promise<void> {
    // Only record while the await is still open. A response arriving after close (e.g. a double-click
    // once the run already resumed) must not rewrite the audit row the decision was based on.
    await this.pool.query(
      `INSERT INTO conductor_await_responses (await_id, responder_id, response)
       SELECT $1, $2, $3::jsonb
        WHERE EXISTS (SELECT 1 FROM conductor_awaits WHERE id = $1 AND status = 'waiting')
       ON CONFLICT (await_id, responder_id) DO UPDATE SET response = EXCLUDED.response, responded_at = now()`,
      [awaitId, responderId, JSON.stringify(response)],
    );
  }

  /** Every response recorded for an await (for quorum='all' completeness + the aggregate result). */
  async listResponses(awaitId: string): Promise<Array<{ responderId: string; response: JsonValue }>> {
    const r = await this.pool.query<{ responder_id: string; response: JsonValue }>(
      `SELECT responder_id, response FROM conductor_await_responses WHERE await_id = $1 ORDER BY responded_at ASC`,
      [awaitId],
    );
    return r.rows.map((row) => ({ responderId: row.responder_id, response: row.response }));
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
