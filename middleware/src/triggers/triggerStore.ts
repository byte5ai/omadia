/**
 * #2082 — durable state of agent-owned triggers (migration 0093).
 *
 * Fly runs on Neon's transaction pooler: no session state survives a
 * statement outside a transaction. So every serialisation here is a
 * transaction-scoped advisory lock or a row lock (`FOR UPDATE [SKIP LOCKED]`),
 * never a session lock, LISTEN or a session-level SET.
 *
 * At most once per occurrence: an occurrence row is unique per
 * (trigger, occurrence key) and is claimed by one statement that moves it to
 * `leased`. A lease that runs out (the worker died mid-firing) is retried only
 * for essential triggers; a droppable one is dropped, because its outcome is
 * unknown and a duplicate reminder is worse than a missing one.
 */

import type { Pool, PoolClient } from 'pg';

import { parseLabelSet, parseStoredReaders, serializeLabelSet, UNKNOWN_READERS } from '@omadia/orchestrator';

import type {
  NewTrigger,
  Occurrence,
  Trigger,
  TriggerContextKind,
  TriggerDiscretion,
  TriggerEndReason,
  TriggerPauseReason,
  TriggerStep,
  TriggerTarget,
} from './types.js';

/** Advisory-lock namespace of the trigger store (first key of the pair). */
const LOCK_NAMESPACE = 2082;

export type TriggerAuditEvent =
  | 'created'
  | 'fired'
  | 'deferred'
  | 'refused'
  | 'paused'
  | 'resumed'
  | 'renewed'
  | 'ended';

export interface TriggerAuditRow {
  readonly triggerId: string;
  readonly agentSlug: string;
  readonly event: TriggerAuditEvent;
  readonly detail: Record<string, unknown>;
  readonly costUsd: number | null;
  readonly at: Date;
}

export type CreateResult =
  | { readonly ok: true; readonly trigger: Trigger }
  | { readonly ok: false; readonly code: 'too_many_active'; readonly message: string };

export interface ClaimedOccurrence extends Occurrence {
  readonly leaseOwner: string;
}

export type ReserveResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly scope: 'trigger' | 'agent' | 'instance' };

export interface SpendCaps {
  readonly monthlyAgentUsd: number;
  readonly monthlyInstanceUsd: number;
}

export interface FinishInput {
  readonly occurrenceId: string;
  readonly leaseOwner: string;
  readonly triggerId: string;
  /** The trigger's agent: its month is settled even if the trigger is gone. */
  readonly agentId: string;
  /** `acted`: an effect happened. `nothing`: a check found nothing to do
   *  (a success). `failed`: an error. `refused`: a guard refused the firing
   *  before anything ran. */
  readonly outcome: 'acted' | 'nothing' | 'failed' | 'refused';
  /** The firing counts against max_runs. */
  readonly countsAsRun: boolean;
  /** A model turn ran and had no effect. */
  readonly ineffectiveTurn: boolean;
  /** A model turn ran and had an effect. */
  readonly effectiveTurn: boolean;
  readonly costUsd: number;
  readonly month: string;
  /** When the firing ran, on the engine's clock: becomes `last_fired_at`,
   *  which the `new_activity` check compares with activity stamped on the
   *  same clock. */
  readonly firedAt: Date;
  readonly error?: string;
  /** The data fingerprint to remember for a `changed` check. */
  readonly fingerprint?: string;
  readonly nextDueAt?: Date;
  /** End the trigger after this firing. */
  readonly end?: TriggerEndReason;
  readonly breaker: { readonly failures: number; readonly ineffective: number };
  readonly detail: Record<string, unknown>;
}

export interface FinishResult {
  readonly ended?: TriggerEndReason;
  readonly paused?: TriggerPauseReason;
  /** The occurrence was no longer this worker's lease (it expired). */
  readonly leaseLost?: true;
}

interface TriggerRowDb {
  id: string;
  agent_id: string;
  agent_slug: string;
  kind: Trigger['kind'];
  origin: Trigger['origin'];
  owner_key: string | null;
  purpose: string;
  context_kind: TriggerContextKind;
  context_id: string;
  delivery_channel: string | null;
  delivery_ref: unknown;
  target: TriggerTarget | null;
  /** The `labels` column: `{ contextKey, labels }` for a trigger a conversation created, `[]` otherwise. */
  labels: unknown;
  event_id: string | null;
  event_filter: unknown;
  fire_at: Date | null;
  interval_seconds: number | null;
  cron: string | null;
  timezone: string | null;
  live_context: boolean;
  actions: TriggerStep[];
  delivery_class: Trigger['deliveryClass'];
  until: Date;
  max_runs: number | null;
  runs: number;
  state: Trigger['state'];
  pause_reason: string | null;
  consecutive_failures: number;
  consecutive_ineffective: number;
  budget_per_firing_usd: string;
  budget_total_usd: string;
  model_calls_per_firing: number;
  spent_usd: string;
  reserved_usd: string;
  last_fired_at: Date | null;
  last_outcome: string | null;
  last_error: string | null;
  last_fingerprint: string | null;
  created_by: string;
  created_at: Date;
}

/**
 * Spec 2042 §5.11 (INV-9) — the creating conversation's discretion as stored.
 * An array is none: triggers no conversation created (routines, schedules,
 * batch jobs) and agent triggers written before it. Any other damage fails
 * closed: an unreadable context, unknown readers, an unreadable label set.
 */
function parseDiscretion(value: unknown): TriggerDiscretion | null {
  if (Array.isArray(value)) return null;
  if (typeof value !== 'object' || value === null) return UNREADABLE_DISCRETION;
  const { contextKey, readers, labels, fieldClasses } = value as {
    contextKey?: unknown;
    readers?: unknown;
    labels?: unknown;
    fieldClasses?: unknown;
  };
  if (typeof contextKey !== 'string' || contextKey === '') return UNREADABLE_DISCRETION;
  // Field rights: anything but a list of class names counts as none.
  const classes = Array.isArray(fieldClasses)
    ? fieldClasses.filter((c): c is string => typeof c === 'string' && c.length > 0 && c.length <= 64)
    : [];
  return {
    contextKey,
    readers: parseStoredReaders(readers),
    labels: parseLabelSet(labels),
    ...(classes.length > 0 ? { fieldClasses: classes } : {}),
  };
}

const UNREADABLE_DISCRETION: TriggerDiscretion = {
  contextKey: 'unreadable',
  readers: UNKNOWN_READERS,
  labels: parseLabelSet(undefined),
};

function serializeDiscretion(discretion: TriggerDiscretion | null): unknown {
  return discretion
    ? {
        contextKey: discretion.contextKey,
        readers: discretion.readers,
        labels: serializeLabelSet(discretion.labels),
        ...(discretion.fieldClasses && discretion.fieldClasses.length > 0
          ? { fieldClasses: [...discretion.fieldClasses] }
          : {}),
      }
    : [];
}

const toTrigger = (r: TriggerRowDb): Trigger => ({
  id: r.id,
  agentId: r.agent_id,
  agentSlug: r.agent_slug,
  kind: r.kind,
  origin: r.origin,
  ownerKey: r.owner_key,
  purpose: r.purpose,
  contextKind: r.context_kind,
  contextId: r.context_id,
  deliveryChannel: r.delivery_channel,
  deliveryRef: r.delivery_ref,
  target: r.target,
  discretion: parseDiscretion(r.labels),
  eventId: r.event_id,
  eventFilter: r.event_filter,
  fireAt: r.fire_at,
  intervalSeconds: r.interval_seconds,
  cron: r.cron,
  timezone: r.timezone,
  liveContext: r.live_context,
  actions: r.actions,
  deliveryClass: r.delivery_class,
  until: r.until,
  maxRuns: r.max_runs,
  runs: r.runs,
  state: r.state,
  pauseReason: r.pause_reason,
  consecutiveFailures: r.consecutive_failures,
  consecutiveIneffective: r.consecutive_ineffective,
  budgetPerFiringUsd: Number(r.budget_per_firing_usd),
  budgetTotalUsd: Number(r.budget_total_usd),
  modelCallsPerFiring: r.model_calls_per_firing,
  spentUsd: Number(r.spent_usd),
  reservedUsd: Number(r.reserved_usd),
  lastFiredAt: r.last_fired_at,
  lastOutcome: r.last_outcome,
  lastError: r.last_error,
  lastFingerprint: r.last_fingerprint,
  createdBy: r.created_by,
  createdAt: r.created_at,
});

interface OccurrenceRowDb {
  id: string;
  trigger_id: string;
  occurrence_key: string;
  due_at: Date;
  payload: Record<string, unknown> | null;
  attempts: number;
  lease_owner: string;
}

const toClaimed = (r: OccurrenceRowDb): ClaimedOccurrence => ({
  id: r.id,
  triggerId: r.trigger_id,
  occurrenceKey: r.occurrence_key,
  dueAt: r.due_at,
  payload: r.payload,
  attempts: r.attempts,
  leaseOwner: r.lease_owner,
});

/** `YYYY-MM-01` of a date in UTC: the spend month. */
export const spendMonth = (d: Date): string =>
  `${String(d.getUTCFullYear())}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;

const KILLED_FOR_AGENT = `EXISTS (
  SELECT 1 FROM execution_kill_switches k
   WHERE k.cleared_at IS NULL
     AND (k.level = 'instance' OR (k.level = 'agent' AND k.agent_id = $1)))`;

export class TriggerStore {
  constructor(private readonly pool: Pool) {}

  private async inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      try {
        const value = await work(client);
        await client.query('COMMIT');
        return value;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      }
    } finally {
      client.release();
    }
  }

  private async auditIn(
    client: PoolClient,
    t: Pick<Trigger, 'id' | 'agentId' | 'agentSlug'>,
    event: TriggerAuditEvent,
    detail: Record<string, unknown>,
    costUsd: number | null = null,
  ): Promise<void> {
    await client.query(
      `INSERT INTO agent_trigger_audit (trigger_id, agent_id, agent_slug, event, detail, cost_usd)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [t.id, t.agentId, t.agentSlug, event, JSON.stringify(detail), costUsd],
    );
  }

  /** Store a validated trigger and its first occurrence, within the agent's
   *  limit of active triggers (serialised per agent). */
  /** `at`: the service's clock, stored as `created_at` — the `new_activity`
   *  check compares a never-fired trigger's creation with activity stamped
   *  on that same clock. */
  async create(input: NewTrigger, firstDueAt: Date | undefined, maxActivePerAgent: number, at: Date): Promise<CreateResult> {
    return this.inTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1::int, hashtext($2)::int)', [LOCK_NAMESPACE, input.agentId]);
      // The cap bounds what the agent sets itself. A person's routine, an
      // Agent Builder schedule or a system batch job is bounded by its own
      // owner (routine quota, Builder, kernel) and never crowds the agent out.
      const { rows: countRows } =
        input.origin === 'agent'
          ? await client.query<{ n: string }>(
              "SELECT count(*)::text AS n FROM agent_triggers WHERE agent_id = $1 AND origin = 'agent'",
              [input.agentId],
            )
          : { rows: [{ n: '0' }] };
      if (Number(countRows[0]?.n ?? '0') >= maxActivePerAgent) {
        return {
          ok: false as const,
          code: 'too_many_active' as const,
          message: `agent '${input.agentSlug}' already has ${String(maxActivePerAgent)} triggers; end one first`,
        };
      }
      const { rows } = await client.query<TriggerRowDb>(
        `INSERT INTO agent_triggers (
           agent_id, agent_slug, kind, origin, owner_key, purpose, context_kind, context_id,
           delivery_channel, delivery_ref, target, labels, event_id, event_filter, fire_at,
           interval_seconds, cron, timezone, live_context, actions, delivery_class, until, max_runs,
           budget_per_firing_usd, budget_total_usd, model_calls_per_firing, created_by, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14::jsonb,$15,
                 $16,$17,$18,$19,$20::jsonb,$21,$22,$23,$24,$25,$26,$27,$28)
         RETURNING *`,
        [
          input.agentId,
          input.agentSlug,
          input.kind,
          input.origin,
          input.ownerKey,
          input.purpose,
          input.contextKind,
          input.contextId,
          input.deliveryChannel,
          JSON.stringify(input.deliveryRef ?? null),
          JSON.stringify(input.target),
          JSON.stringify(serializeDiscretion(input.discretion)),
          input.eventId,
          JSON.stringify(input.eventFilter ?? null),
          input.fireAt,
          input.intervalSeconds,
          input.cron,
          input.timezone,
          input.liveContext,
          JSON.stringify(input.actions),
          input.deliveryClass,
          input.until,
          input.maxRuns,
          input.budgetPerFiringUsd,
          input.budgetTotalUsd,
          input.modelCallsPerFiring,
          input.createdBy,
          at,
        ],
      );
      const trigger = toTrigger(rows[0] as TriggerRowDb);
      if (firstDueAt) await this.insertTimerOccurrence(client, trigger.id, firstDueAt);
      await this.auditIn(client, trigger, 'created', {
        kind: trigger.kind,
        purpose: trigger.purpose,
        context: `${trigger.contextKind}:${trigger.contextId}`,
        until: trigger.until.toISOString(),
        actions: trigger.actions.map((a) => a.type),
        createdBy: trigger.createdBy,
      });
      return { ok: true as const, trigger };
    });
  }

  private async insertTimerOccurrence(client: PoolClient, triggerId: string, dueAt: Date): Promise<void> {
    await client.query(
      `INSERT INTO agent_trigger_occurrences (trigger_id, occurrence_key, due_at)
       VALUES ($1, $2, $3) ON CONFLICT (trigger_id, occurrence_key) DO NOTHING`,
      [triggerId, `at:${dueAt.toISOString()}`, dueAt],
    );
  }

  async get(id: string): Promise<Trigger | undefined> {
    const { rows } = await this.pool.query<TriggerRowDb>('SELECT * FROM agent_triggers WHERE id = $1', [id]);
    return rows[0] ? toTrigger(rows[0]) : undefined;
  }

  async listByAgent(agentId: string): Promise<Trigger[]> {
    const { rows } = await this.pool.query<TriggerRowDb>(
      'SELECT * FROM agent_triggers WHERE agent_id = $1 ORDER BY created_at',
      [agentId],
    );
    return rows.map(toTrigger);
  }

  async listByOwner(ownerKey: string): Promise<Trigger[]> {
    const { rows } = await this.pool.query<TriggerRowDb>(
      'SELECT * FROM agent_triggers WHERE owner_key = $1 ORDER BY created_at',
      [ownerKey],
    );
    return rows.map(toTrigger);
  }

  async listByContext(kind: TriggerContextKind, contextId: string): Promise<Trigger[]> {
    const { rows } = await this.pool.query<TriggerRowDb>(
      'SELECT * FROM agent_triggers WHERE context_kind = $1 AND context_id = $2 ORDER BY created_at',
      [kind, contextId],
    );
    return rows.map(toTrigger);
  }

  async listByContextKind(kind: TriggerContextKind): Promise<Trigger[]> {
    const { rows } = await this.pool.query<TriggerRowDb>(
      'SELECT * FROM agent_triggers WHERE context_kind = $1 ORDER BY created_at',
      [kind],
    );
    return rows.map(toTrigger);
  }

  async listAll(limit: number): Promise<Trigger[]> {
    const { rows } = await this.pool.query<TriggerRowDb>(
      'SELECT * FROM agent_triggers ORDER BY agent_slug, created_at LIMIT $1',
      [limit],
    );
    return rows.map(toTrigger);
  }

  /** Active hooks on an event id at `now` (the caller matches filter and
   *  context). `now` is the service's clock, like every other time decision
   *  of the engine, not the database's. */
  async listHooks(eventId: string, now: Date): Promise<Trigger[]> {
    const { rows } = await this.pool.query<TriggerRowDb>(
      `SELECT * FROM agent_triggers
        WHERE kind = 'on_event' AND event_id = $1 AND state = 'active' AND until > $2`,
      [eventId, now],
    );
    return rows.map(toTrigger);
  }

  /** One occurrence of a hook for one event. False when it already existed. */
  async enqueueEvent(triggerId: string, occurrenceKey: string, dueAt: Date, payload: Record<string, unknown>): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `INSERT INTO agent_trigger_occurrences (trigger_id, occurrence_key, due_at, payload)
       SELECT $1, $2, $3, $4::jsonb
        WHERE EXISTS (SELECT 1 FROM agent_triggers WHERE id = $1 AND state = 'active')
       ON CONFLICT (trigger_id, occurrence_key) DO NOTHING`,
      [triggerId, occurrenceKey, dueAt, JSON.stringify(payload)],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * Renew a held lease right before its firing starts: a batch is fired one
   * after another, and the last one must not start on a lease that ran out
   * (and another replica may already have taken). False = lost; skip it.
   */
  async extendLease(occurrenceId: string, leaseOwner: string, now: Date, leaseUntil: Date): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE agent_trigger_occurrences SET lease_until = $4
        WHERE id = $1 AND lease_owner = $2 AND state = 'leased' AND lease_until >= $3`,
      [occurrenceId, leaseOwner, now, leaseUntil],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Claim due occurrences under a lease, in one statement. */
  async claimDue(leaseOwner: string, now: Date, leaseMs: number, limit: number): Promise<ClaimedOccurrence[]> {
    const { rows } = await this.pool.query<OccurrenceRowDb>(
      `UPDATE agent_trigger_occurrences o
          SET state = 'leased', lease_owner = $1, lease_until = $2, attempts = o.attempts + 1
        WHERE o.id IN (
          SELECT id FROM agent_trigger_occurrences
           WHERE state = 'pending' AND due_at <= $3
           ORDER BY due_at
           LIMIT $4
           FOR UPDATE SKIP LOCKED)
        RETURNING o.id, o.trigger_id, o.occurrence_key, o.due_at, o.payload, o.attempts, o.lease_owner`,
      [leaseOwner, new Date(now.getTime() + leaseMs), now, limit],
    );
    return rows.map(toClaimed);
  }

  /**
   * Leases that ran out: the worker died with the outcome unknown. Essential
   * triggers get the occurrence back (up to `maxAttempts`); droppable ones
   * drop it.
   */
  async recoverExpiredLeases(now: Date, maxAttempts: number): Promise<{ retried: number; dropped: number }> {
    return this.inTransaction(async (client) => {
      const retried = await client.query(
        `UPDATE agent_trigger_occurrences o
            SET state = 'pending', lease_owner = NULL, lease_until = NULL
           FROM agent_triggers t
          WHERE o.trigger_id = t.id AND o.state = 'leased' AND o.lease_until < $1
            AND t.delivery_class = 'essential' AND o.attempts < $2`,
        [now, maxAttempts],
      );
      const dropped = await client.query(
        `UPDATE agent_trigger_occurrences o
            SET state = 'dropped', outcome = 'lease_expired', finished_at = $1
          WHERE o.state = 'leased' AND o.lease_until < $1`,
        [now],
      );
      await this.releaseOrphanReservationsIn(client, now);
      return { retried: retried.rowCount ?? 0, dropped: dropped.rowCount ?? 0 };
    });
  }

  /** Put a leased occurrence back for later (quiet hours, rate limit). */
  async defer(occurrenceId: string, leaseOwner: string, dueAt: Date, trigger: Trigger, reason: string): Promise<void> {
    await this.inTransaction(async (client) => {
      await client.query(
        `UPDATE agent_trigger_occurrences
            SET state = 'pending', lease_owner = NULL, lease_until = NULL, due_at = $3, attempts = 0
          WHERE id = $1 AND lease_owner = $2 AND state = 'leased'`,
        [occurrenceId, leaseOwner, dueAt],
      );
      await this.auditIn(client, trigger, 'deferred', { reason, until: dueAt.toISOString() });
    });
  }

  /** Drop a leased occurrence without running it (with a reason). */
  async drop(occurrenceId: string, leaseOwner: string, outcome: string): Promise<void> {
    await this.pool.query(
      `UPDATE agent_trigger_occurrences SET state = 'dropped', outcome = $3, finished_at = now()
        WHERE id = $1 AND lease_owner = $2 AND state = 'leased'`,
      [occurrenceId, leaseOwner, outcome],
    );
  }

  /** Whether an instance or agent kill switch is set. */
  async killSwitchSet(agentId: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ killed: boolean }>(`SELECT ${KILLED_FOR_AGENT} AS killed`, [agentId]);
    return rows[0]?.killed === true;
  }

  /**
   * Reserve `amount` for one firing against the trigger's own budget, the
   * agent's month and the instance's month. All or nothing.
   */
  async reserve(trigger: Trigger, amount: number, month: string, caps: SpendCaps, occurrenceId: string): Promise<ReserveResult> {
    if (amount <= 0) return { ok: true };
    return this.inTransaction(async (client) => {
      const { rows } = await client.query<{ ok: boolean }>(
        `UPDATE agent_triggers SET reserved_usd = reserved_usd + $2
          WHERE id = $1 AND spent_usd + reserved_usd + $2 <= budget_total_usd
          RETURNING true AS ok`,
        [trigger.id, amount],
      );
      if (rows.length === 0) return { ok: false as const, scope: 'trigger' as const };
      for (const [scope, cap, name] of [
        [trigger.agentId, caps.monthlyAgentUsd, 'agent'],
        ['instance', caps.monthlyInstanceUsd, 'instance'],
      ] as const) {
        if (amount > cap) throw new SpendRefused(name);
        const { rows: spend } = await client.query(
          `INSERT INTO agent_trigger_spend AS s (scope, month, reserved_usd) VALUES ($1, $2::date, $3)
           ON CONFLICT (scope, month) DO UPDATE SET reserved_usd = s.reserved_usd + EXCLUDED.reserved_usd
            WHERE s.spent_usd + s.reserved_usd + EXCLUDED.reserved_usd <= $4
           RETURNING 1`,
          [scope, month, amount, cap],
        );
        if (spend.length === 0) throw new SpendRefused(name);
      }
      await client.query(
        `INSERT INTO agent_trigger_reservations (occurrence_id, trigger_id, agent_id, month, amount_usd)
         VALUES ($1, $2, $3, $4::date, $5)`,
        [occurrenceId, trigger.id, trigger.agentId, month, amount],
      );
      return { ok: true as const };
    }).catch((err: unknown) => {
      if (err instanceof SpendRefused) return { ok: false as const, scope: err.scope };
      throw err;
    });
  }

  /** Month spend of an agent (or 'instance'). */
  async monthSpend(scope: string, month: string): Promise<{ spentUsd: number; reservedUsd: number }> {
    const { rows } = await this.pool.query<{ spent_usd: string; reserved_usd: string }>(
      'SELECT spent_usd, reserved_usd FROM agent_trigger_spend WHERE scope = $1 AND month = $2::date',
      [scope, month],
    );
    return { spentUsd: Number(rows[0]?.spent_usd ?? 0), reservedUsd: Number(rows[0]?.reserved_usd ?? 0) };
  }

  /**
   * Settle a firing in one transaction: the occurrence, the counters, the
   * spend, the circuit breaker, the next occurrence, and the end.
   */
  async finish(input: FinishInput): Promise<FinishResult> {
    return this.inTransaction(async (client) => {
      const held = await client.query(
        `UPDATE agent_trigger_occurrences SET state = 'done', outcome = $3, finished_at = now()
          WHERE id = $1 AND lease_owner = $2 AND state = 'leased'`,
        [input.occurrenceId, input.leaseOwner, input.outcome],
      );
      const released = await this.takeReservationIn(client, input.occurrenceId);
      if ((held.rowCount ?? 0) === 0) {
        // The lease ran out mid-firing and the recovery took the occurrence
        // (dropped, or back to pending for another worker). What this firing
        // spent is still booked; the run, the breaker and the next
        // occurrence belong to whoever holds it now.
        await client.query(
          'UPDATE agent_triggers SET spent_usd = spent_usd + $2, reserved_usd = GREATEST(reserved_usd - $3, 0) WHERE id = $1',
          [input.triggerId, input.costUsd, released],
        );
        await this.settleSpendIn(client, input, released);
        return { leaseLost: true };
      }
      const { rows } = await client.query<TriggerRowDb>(
        `UPDATE agent_triggers SET
            runs = LEAST(runs + $2::int, COALESCE(max_runs, runs + $2::int)),
            consecutive_failures = CASE WHEN $3 THEN consecutive_failures + 1 ELSE 0 END,
            consecutive_ineffective = CASE WHEN $4 THEN consecutive_ineffective + 1
                                           WHEN $5 THEN 0 ELSE consecutive_ineffective END,
            spent_usd = spent_usd + $6,
            reserved_usd = GREATEST(reserved_usd - $7, 0),
            last_fired_at = $11,
            last_outcome = $8,
            last_error = $9,
            last_fingerprint = COALESCE($10, last_fingerprint),
            updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [
          input.triggerId,
          input.countsAsRun ? 1 : 0,
          input.outcome === 'failed',
          input.ineffectiveTurn,
          input.effectiveTurn,
          input.costUsd,
          released,
          input.outcome,
          input.error ?? null,
          input.fingerprint ?? null,
          input.firedAt,
        ],
      );
      await this.settleSpendIn(client, input, released);
      const row = rows[0];
      if (!row) return {};
      const trigger = toTrigger(row);
      await this.auditIn(
        client,
        trigger,
        input.outcome === 'refused' ? 'refused' : 'fired',
        { outcome: input.outcome, ...input.detail, ...(input.error ? { error: input.error } : {}) },
        input.costUsd > 0 ? input.costUsd : null,
      );

      const exhausted = trigger.maxRuns !== null && trigger.runs >= trigger.maxRuns;
      const end: TriggerEndReason | undefined =
        input.end ?? (exhausted ? 'max_runs' : trigger.kind === 'wake_at' && input.countsAsRun ? 'fired' : undefined);
      if (end) {
        await this.deleteIn(client, trigger, end, {});
        return { ended: end };
      }
      let paused: TriggerPauseReason | undefined;
      if (trigger.consecutiveFailures >= input.breaker.failures) paused = 'breaker_failures';
      else if (trigger.consecutiveIneffective >= input.breaker.ineffective) paused = 'breaker_ineffective';
      if (paused) {
        await this.pauseIn(client, trigger, paused, { failures: trigger.consecutiveFailures, ineffective: trigger.consecutiveIneffective });
        return { paused };
      }
      if (input.nextDueAt && trigger.state === 'active') {
        await this.insertTimerOccurrence(client, trigger.id, input.nextDueAt);
      }
      return {};
    });
  }

  /** Remove a firing's reservation; what it held, or 0 when none is left. */
  private async takeReservationIn(client: PoolClient, occurrenceId: string): Promise<number> {
    const { rows } = await client.query<{ amount_usd: string }>(
      'DELETE FROM agent_trigger_reservations WHERE occurrence_id = $1 RETURNING amount_usd',
      [occurrenceId],
    );
    return rows[0] ? Number(rows[0].amount_usd) : 0;
  }

  private async settleSpendIn(client: PoolClient, input: FinishInput, released: number): Promise<void> {
    if (input.costUsd <= 0 && released <= 0) return;
    for (const scope of ['instance', input.agentId]) {
      await client.query(
        `INSERT INTO agent_trigger_spend AS s (scope, month, spent_usd) VALUES ($1, $2::date, $3)
         ON CONFLICT (scope, month) DO UPDATE
           SET spent_usd = s.spent_usd + EXCLUDED.spent_usd,
               reserved_usd = GREATEST(s.reserved_usd - $4, 0)`,
        [scope, input.month, input.costUsd, released],
      );
    }
  }

  /**
   * Release reservations whose firing will never settle: the occurrence is
   * gone (its trigger was deleted) or no longer leased (the lease expired).
   */
  private async releaseOrphanReservationsIn(client: PoolClient, now: Date): Promise<number> {
    const { rows } = await client.query<{ trigger_id: string; agent_id: string; month: Date; amount_usd: string }>(
      `DELETE FROM agent_trigger_reservations r
        WHERE NOT EXISTS (
          SELECT 1 FROM agent_trigger_occurrences o
           WHERE o.id = r.occurrence_id AND o.state = 'leased' AND o.lease_until >= $1)
        RETURNING r.trigger_id, r.agent_id, r.month, r.amount_usd`,
      [now],
    );
    for (const r of rows) {
      const amount = Number(r.amount_usd);
      await client.query('UPDATE agent_triggers SET reserved_usd = GREATEST(reserved_usd - $2, 0) WHERE id = $1', [
        r.trigger_id,
        amount,
      ]);
      for (const scope of ['instance', r.agent_id]) {
        await client.query(
          'UPDATE agent_trigger_spend SET reserved_usd = GREATEST(reserved_usd - $3, 0) WHERE scope = $1 AND month = $2',
          [scope, r.month, amount],
        );
      }
    }
    return rows.length;
  }

  private async deleteIn(client: PoolClient, trigger: Trigger, reason: TriggerEndReason, detail: Record<string, unknown>): Promise<void> {
    await client.query('DELETE FROM agent_triggers WHERE id = $1', [trigger.id]);
    await this.auditIn(client, trigger, 'ended', {
      reason,
      purpose: trigger.purpose,
      runs: trigger.runs,
      spentUsd: trigger.spentUsd,
      ...detail,
    });
  }

  private async pauseIn(client: PoolClient, trigger: Trigger, reason: TriggerPauseReason, detail: Record<string, unknown>): Promise<void> {
    await client.query(
      `UPDATE agent_triggers SET state = 'paused', pause_reason = $2, updated_at = now() WHERE id = $1`,
      [trigger.id, reason],
    );
    await client.query(
      `UPDATE agent_trigger_occurrences SET state = 'dropped', outcome = 'paused', finished_at = now()
        WHERE trigger_id = $1 AND state = 'pending'`,
      [trigger.id],
    );
    await this.auditIn(client, trigger, 'paused', { reason, ...detail });
  }

  /** End (delete) one trigger. False when it was already gone. */
  async end(id: string, reason: TriggerEndReason, detail: Record<string, unknown> = {}): Promise<boolean> {
    return this.inTransaction(async (client) => {
      const { rows } = await client.query<TriggerRowDb>('SELECT * FROM agent_triggers WHERE id = $1 FOR UPDATE', [id]);
      if (!rows[0]) return false;
      await this.deleteIn(client, toTrigger(rows[0]), reason, detail);
      return true;
    });
  }

  /**
   * A context ended (a meeting, a facilitation, a deleted routine): every
   * trigger bound to it ends in this one transaction, hooks and timers alike.
   */
  async endContext(kind: TriggerContextKind, contextId: string, at: Date): Promise<Trigger[]> {
    return this.inTransaction(async (client) => {
      const { rows } = await client.query<TriggerRowDb>(
        'SELECT * FROM agent_triggers WHERE context_kind = $1 AND context_id = $2 FOR UPDATE',
        [kind, contextId],
      );
      const ended = rows.map(toTrigger);
      for (const t of ended) await this.deleteIn(client, t, 'context_ended', { context: `${kind}:${contextId}` });
      await client.query(
        `INSERT INTO agent_trigger_context_activity (context_kind, context_id, last_activity_at, ended_at)
         VALUES ($1, $2, $3, $3)
         ON CONFLICT (context_kind, context_id) DO UPDATE SET ended_at = EXCLUDED.ended_at`,
        [kind, contextId, at],
      );
      return ended;
    });
  }

  /** Pause a trigger (owner, operator, breaker or budget). */
  async pause(id: string, reason: TriggerPauseReason, detail: Record<string, unknown> = {}): Promise<Trigger | undefined> {
    return this.inTransaction(async (client) => {
      const { rows } = await client.query<TriggerRowDb>('SELECT * FROM agent_triggers WHERE id = $1 FOR UPDATE', [id]);
      if (!rows[0]) return undefined;
      const t = toTrigger(rows[0]);
      if (t.state === 'paused') return t;
      await this.pauseIn(client, t, reason, detail);
      return { ...t, state: 'paused' as const, pauseReason: reason };
    });
  }

  /** Resume a paused trigger; the breaker starts over and the next
   *  occurrence is scheduled. */
  async resume(id: string, nextDueAt: Date | undefined, by: string): Promise<Trigger | undefined> {
    return this.inTransaction(async (client) => {
      const { rows } = await client.query<TriggerRowDb>(
        `UPDATE agent_triggers
            SET state = 'active', pause_reason = NULL, consecutive_failures = 0,
                consecutive_ineffective = 0, updated_at = now()
          WHERE id = $1 AND state = 'paused' RETURNING *`,
        [id],
      );
      if (!rows[0]) {
        // Already active (or gone): nothing to resume, no second occurrence.
        const { rows: current } = await client.query<TriggerRowDb>('SELECT * FROM agent_triggers WHERE id = $1', [id]);
        return current[0] ? toTrigger(current[0]) : undefined;
      }
      const t = toTrigger(rows[0]);
      if (nextDueAt) await this.insertTimerOccurrence(client, id, nextDueAt);
      await this.auditIn(client, t, 'resumed', { by });
      return t;
    });
  }

  /** Move the deadline (a routine's renewal). */
  /** Move the deadline; `maxRuns` (a timer's grown run cap) moves with it. */
  async renew(id: string, until: Date, by: string, maxRuns?: number): Promise<Trigger | undefined> {
    return this.inTransaction(async (client) => {
      const { rows } = await client.query<TriggerRowDb>(
        `UPDATE agent_triggers SET until = $2, max_runs = GREATEST(COALESCE($3, max_runs), runs, 1), updated_at = now()
          WHERE id = $1 AND (fire_at IS NULL OR fire_at <= $2) RETURNING *`,
        [id, until, maxRuns ?? null],
      );
      if (!rows[0]) return undefined;
      const t = toTrigger(rows[0]);
      await this.auditIn(client, t, 'renewed', { until: until.toISOString(), maxRuns: t.maxRuns, by });
      return t;
    });
  }

  /** Delete every trigger past its deadline. */
  async sweepExpired(now: Date): Promise<number> {
    return this.inTransaction(async (client) => {
      const { rows } = await client.query<TriggerRowDb>(
        'SELECT * FROM agent_triggers WHERE until < $1 FOR UPDATE SKIP LOCKED',
        [now],
      );
      for (const r of rows) await this.deleteIn(client, toTrigger(r), 'expired', {});
      return rows.length;
    });
  }

  /** A context that had ended runs again (a recurring meeting in the same
   *  chat starts anew): triggers set from now on may fire. */
  async reopenContext(kind: TriggerContextKind, contextId: string): Promise<void> {
    await this.pool.query(
      'UPDATE agent_trigger_context_activity SET ended_at = NULL WHERE context_kind = $1 AND context_id = $2 AND ended_at IS NOT NULL',
      [kind, contextId],
    );
  }

  /** Something happened in a context (a message, an event). */
  async noteActivity(kind: TriggerContextKind, contextId: string, at: Date): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_trigger_context_activity (context_kind, context_id, last_activity_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (context_kind, context_id) DO UPDATE
         SET last_activity_at = GREATEST(agent_trigger_context_activity.last_activity_at, EXCLUDED.last_activity_at)`,
      [kind, contextId, at],
    );
  }

  /** When the context last saw activity, and whether it ended. */
  async contextActivity(kind: TriggerContextKind, contextId: string): Promise<{ lastActivityAt: Date; endedAt: Date | null } | undefined> {
    const { rows } = await this.pool.query<{ last_activity_at: Date; ended_at: Date | null }>(
      'SELECT last_activity_at, ended_at FROM agent_trigger_context_activity WHERE context_kind = $1 AND context_id = $2',
      [kind, contextId],
    );
    return rows[0] ? { lastActivityAt: rows[0].last_activity_at, endedAt: rows[0].ended_at } : undefined;
  }

  async audit(t: Pick<Trigger, 'id' | 'agentId' | 'agentSlug'>, event: TriggerAuditEvent, detail: Record<string, unknown>): Promise<void> {
    const client = await this.pool.connect();
    try {
      await this.auditIn(client, t, event, detail);
    } finally {
      client.release();
    }
  }

  async auditOf(triggerId: string, limit: number): Promise<TriggerAuditRow[]> {
    const { rows } = await this.pool.query<{
      trigger_id: string;
      agent_slug: string;
      event: TriggerAuditEvent;
      detail: Record<string, unknown>;
      cost_usd: string | null;
      at: Date;
    }>(
      'SELECT trigger_id, agent_slug, event, detail, cost_usd, at FROM agent_trigger_audit WHERE trigger_id = $1 ORDER BY id DESC LIMIT $2',
      [triggerId, limit],
    );
    return rows.map((r) => ({
      triggerId: r.trigger_id,
      agentSlug: r.agent_slug,
      event: r.event,
      detail: r.detail,
      costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
      at: r.at,
    }));
  }
}

class SpendRefused extends Error {
  constructor(readonly scope: 'agent' | 'instance') {
    super(`monthly ${scope} cap reached`);
  }
}
