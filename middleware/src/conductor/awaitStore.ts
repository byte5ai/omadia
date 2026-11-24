import type { Pool } from 'pg';
import type { JsonObject, JsonValue } from '@omadia/conductor-core';

import { renderAwaitMessage } from './runInterpolation.js';

export type AwaitStatus = 'waiting' | 'resolved' | 'timed_out' | 'cancelled';

export interface ConductorAwait {
  id: string;
  runId: string;
  stepId: string;
  /** 'timer' (#330 C3): a deterministic tick — no principal, no reminders;
   *  only the deadline poll acts on it. */
  principalKind: 'user' | 'role' | 'timer';
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
  if (aw.principalKind === 'timer') return []; // #330 C3 — nobody to remind or list
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
  /** The run's context, joined in by every SELECT below — see {@link storedMessage}.
   *  Absent on an INSERT ... RETURNING row, which needs no rendering. */
  run_context?: JsonObject | null;
}

const COLS = `id, run_id, step_id, principal_kind, principal_ref, channel_type, message, quorum,
  reminder_interval_ms, deadline_at, fallback_transition_id, status, unreachable, created_at`;

// #1709 — the same columns for a READ, plus the run's context, so a row written before
// the interpolation fix can be rendered on the way out (`storedMessage`). One join here
// instead of a re-render at each of the three readers (operator inbox, reminder worker,
// approval card), and no per-row extra query.
const SELECT_COLS = `a.id, a.run_id, a.step_id, a.principal_kind, a.principal_ref, a.channel_type,
  a.message, a.quorum, a.reminder_interval_ms, a.deadline_at, a.fallback_transition_id, a.status,
  a.unreachable, a.created_at, r.context AS run_context`;
const SELECT_FROM = `conductor_awaits a LEFT JOIN conductor_runs r ON r.id = a.run_id`;

/**
 * #1709 — the message a person reads. `openHumanAwait` renders it at WRITE time, so the
 * normal case is a string with no token left in it and this returns it untouched. A row
 * parked before that fix still holds raw `{{ctx.…}}` template text, and it would keep
 * showing it in the inbox forever (an await is written once and never rewritten), so such
 * a row is rendered here against the run's context instead of being migrated.
 *
 * Cheap by design: the `includes('{{')` guard means a current row costs one substring
 * scan. A run row that has since been deleted leaves no context, and the message then
 * renders with the ordinary unresolved-token dashes rather than raw syntax.
 */
function storedMessage(r: AwaitRow): string {
  if (!r.message.includes('{{')) return r.message;
  const context = typeof r.run_context === 'object' && r.run_context !== null ? r.run_context : {};
  return renderAwaitMessage(r.message, context);
}

function toAwait(r: AwaitRow): ConductorAwait {
  return {
    id: r.id,
    runId: r.run_id,
    stepId: r.step_id,
    principalKind: r.principal_kind,
    principalRef: r.principal_ref,
    channelType: r.channel_type,
    message: storedMessage(r),
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
    principalKind: 'user' | 'role' | 'timer';
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
      `SELECT ${SELECT_COLS} FROM ${SELECT_FROM}
        WHERE a.run_id = $1 AND a.step_id = $2 AND a.status = 'waiting' LIMIT 1`,
      [input.runId, input.stepId],
    );
    return toAwait(existing.rows[0]!);
  }

  async get(awaitId: string): Promise<ConductorAwait | null> {
    const r = await this.pool.query<AwaitRow>(
      `SELECT ${SELECT_COLS} FROM ${SELECT_FROM} WHERE a.id = $1`,
      [awaitId],
    );
    return r.rows[0] ? toAwait(r.rows[0]) : null;
  }

  /**
   * All waiting awaits — the operator inbox.
   *
   * Every await IS a human await by construction: `openHumanAwait` is the single caller of
   * {@link create}, and it always writes a human principal and a human channel. An earlier
   * `channel_type` exclusion filter hid a machine step's synthetic awaits; that step was
   * deleted with its writer, so the excluded set is now empty and the filter is gone rather
   * than kept as a generic one — a filter whose complement no member can enter is an
   * invariant asserted in the wrong place, and a future non-human await kind would have to
   * remember to add itself to survive it. If such a kind ever lands, it names itself here.
   */
  /** #330 C3 — the run's open timer await, if any (there is at most one open
   *  await per (run, step); a graph has no reason to park two timers at once).
   *  Backs `conductorEphemeralRuns.poke`: expire the tick early when the
   *  group already reached its outcome instead of waiting out the interval. */
  async openTimerAwaitForRun(runId: string): Promise<ConductorAwait | null> {
    const r = await this.pool.query<AwaitRow>(
      `SELECT ${SELECT_COLS} FROM ${SELECT_FROM}
        WHERE a.run_id = $1 AND a.status = 'waiting' AND a.principal_kind = 'timer'
        ORDER BY a.created_at ASC LIMIT 1`,
      [runId],
    );
    return r.rows[0] ? toAwait(r.rows[0]) : null;
  }

  async listWaiting(limit = 100): Promise<ConductorAwait[]> {
    const r = await this.pool.query<AwaitRow>(
      `SELECT ${SELECT_COLS} FROM ${SELECT_FROM}
        WHERE a.status = 'waiting'
        ORDER BY a.created_at ASC LIMIT $1`,
      [Math.min(Math.max(1, limit), 500)],
    );
    return r.rows.map(toAwait);
  }

  /** Waiting awaits whose deadline has passed (for the deadline worker). */
  async listDue(now: Date): Promise<ConductorAwait[]> {
    const r = await this.pool.query<AwaitRow>(
      `SELECT ${SELECT_COLS} FROM ${SELECT_FROM}
        WHERE a.status = 'waiting' AND a.deadline_at IS NOT NULL AND a.deadline_at <= $1
        ORDER BY a.deadline_at ASC LIMIT 100`,
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
      `SELECT ${SELECT_COLS} FROM ${SELECT_FROM}
        WHERE a.status = 'waiting'
          AND a.reminder_interval_ms IS NOT NULL
          AND COALESCE(a.last_reminder_at, a.created_at) + (a.reminder_interval_ms * interval '1 millisecond') <= $1
          AND (a.deadline_at IS NULL OR a.deadline_at > $1)
        ORDER BY a.created_at ASC LIMIT 100`,
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

  /** #759 — close every waiting await of a run as 'cancelled' (operator run
   *  cancel). Returns the number of awaits closed. The first writer of the
   *  'cancelled' enum value the schema has carried since 0001. */
  async cancelForRun(runId: string): Promise<number> {
    const r = await this.pool.query(
      `UPDATE conductor_awaits SET status = 'cancelled', resolved_at = now()
        WHERE run_id = $1 AND status = 'waiting'`,
      [runId],
    );
    return r.rowCount ?? 0;
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
