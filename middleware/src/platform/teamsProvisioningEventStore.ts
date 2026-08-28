/**
 * `agent_teams_provisioning_events` store (epic byte5ai/omadia#860, #915) —
 * backing migration 0053. Sibling of `agentTeamsIdentityStore.ts` (0049) and
 * `agentTeamsInstallStore.ts` (0051) in shape.
 *
 * WHAT IT IS FOR. The identity row records the five chain STATES; the minutes
 * an operator waits happen between them (Entra replication, ARM retries with
 * backoff, catalog upload). This store is where the runner writes those down,
 * so the operator UI has something to show between two 3-second polls instead
 * of a frozen badge.
 *
 * FAILURE POSTURE — DELIBERATELY DIFFERENT PER CALLER.
 * The store itself is honest: a query failure throws, like every other store
 * here. What differs is who is allowed to care.
 *
 *   * The RUNNER must not care. A provisioning run that died because its
 *     progress note could not be written would be an outage caused by a
 *     diary. The swallow lives in exactly one place — the runner's private
 *     `emit` helper — not scattered across the emit sites.
 *   * The STATUS ROUTE must not care either, for the same reason inverted:
 *     the event list is additive decoration on a response whose real payload
 *     is the identity row. It has its own single choke point in
 *     `routes/operatorAgents.ts`.
 *
 * Both choke points are one function each; neither is a `try`/`catch` at a
 * call site.
 *
 * NO SECRETS, NO PII. `detail` carries short machine-readable notes composed
 * by the runner (`skipped`, `retry_in_ms=8000;max_attempts=5`, a classified
 * failure code). Nothing here forwards a client secret, a token or a URL
 * carrying a query string, and {@link MAX_DETAIL_LENGTH} truncates whatever
 * does arrive so a runaway message cannot turn one event into a page of log.
 */

import type { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Status vocabulary — the CHECK constraint of migration 0053, verbatim. */
export const TEAMS_PROVISIONING_EVENT_STATUSES = [
  /** The step was entered. */
  'started',
  /** Something happened INSIDE a step that is still running. */
  'progress',
  /** The step failed and will be attempted again after a delay. */
  'retrying',
  /** The step is done (including "there was nothing to do"). */
  'succeeded',
  /** The step, or the run, stopped here. */
  'failed',
] as const;

export type TeamsProvisioningEventStatus =
  (typeof TEAMS_PROVISIONING_EVENT_STATUSES)[number];

export function isTeamsProvisioningEventStatus(
  value: unknown,
): value is TeamsProvisioningEventStatus {
  return (
    typeof value === 'string' &&
    (TEAMS_PROVISIONING_EVENT_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Hard per-agent cap, enforced on every insert (see the migration header on
 * why this exists alongside {@link TeamsProvisioningEventStore.clearForAgent}).
 * One run emits roughly a dozen events, or a few dozen with a full retry
 * storm — the cap is an order of magnitude above that, so it never truncates
 * a real run and only ever catches an accumulation the clear failed to
 * prevent.
 */
export const MAX_EVENTS_PER_AGENT = 200;

/** Longest `detail` that reaches the column; longer notes are truncated. */
export const MAX_DETAIL_LENGTH = 500;

/** Default page size of {@link TeamsProvisioningEventStore.listRecent}. */
export const DEFAULT_EVENT_PAGE_SIZE = 30;

/** Upper bound a caller can ask for — a status endpoint has no business
 *  streaming the whole log into one JSON response. */
export const MAX_EVENT_PAGE_SIZE = 200;

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** One `agent_teams_provisioning_events` row, camelCase. */
export interface TeamsProvisioningEventRecord {
  /** `bigserial`, carried as a string — `pg` returns int8 as text, and the
   *  value is an opaque ordering handle, never arithmetic. */
  readonly id: string;
  readonly agentId: string;
  readonly at: Date;
  readonly step: string;
  readonly status: TeamsProvisioningEventStatus;
  /** 1-based retry counter; `null` on everything that is not a retry. */
  readonly attempt: number | null;
  readonly detail: string | null;
}

export interface RecordTeamsProvisioningEventInput {
  readonly agentId: string;
  readonly step: string;
  readonly status: TeamsProvisioningEventStatus;
  readonly attempt?: number | null;
  readonly detail?: string | null;
}

/** A write carried a status outside the CHECK-constraint vocabulary. Caught
 *  here (not by the DB) so the error names the union. */
export class TeamsProvisioningEventStatusError extends Error {
  public readonly code = 'invalid_teams_provisioning_event_status';

  constructor(value: unknown) {
    super(
      `invalid teams provisioning event status ${JSON.stringify(value)} — expected one of ${TEAMS_PROVISIONING_EVENT_STATUSES.join(', ')}`,
    );
    this.name = 'TeamsProvisioningEventStatusError';
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const COLUMNS = 'id, agent_id, at, step, status, attempt, detail';

interface TeamsProvisioningEventRow {
  id: string;
  agent_id: string;
  at: Date;
  step: string;
  status: string;
  attempt: number | null;
  detail: string | null;
}

function mapRow(row: TeamsProvisioningEventRow): TeamsProvisioningEventRecord {
  if (!isTeamsProvisioningEventStatus(row.status)) {
    // Unreachable while the CHECK constraint stands; surfacing beats lying.
    throw new TeamsProvisioningEventStatusError(row.status);
  }
  return {
    id: String(row.id),
    agentId: row.agent_id,
    at: row.at,
    step: row.step,
    status: row.status,
    attempt: row.attempt,
    detail: row.detail,
  };
}

/** Truncate a note to the column budget. Never throws on a long message —
 *  losing the tail of a diary entry beats losing the entry. */
function clampDetail(detail: string | null | undefined): string | null {
  if (typeof detail !== 'string') return null;
  const trimmed = detail.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length <= MAX_DETAIL_LENGTH
    ? trimmed
    : trimmed.slice(0, MAX_DETAIL_LENGTH);
}

/** A retry counter is a positive integer or nothing. Anything else (0, NaN,
 *  a float) is dropped rather than persisted as a number the UI would then
 *  announce. */
function clampAttempt(attempt: number | null | undefined): number | null {
  if (typeof attempt !== 'number' || !Number.isInteger(attempt)) return null;
  return attempt > 0 ? attempt : null;
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    return DEFAULT_EVENT_PAGE_SIZE;
  }
  const floored = Math.floor(limit);
  if (floored < 1) return 1;
  return Math.min(floored, MAX_EVENT_PAGE_SIZE);
}

export class TeamsProvisioningEventStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Append one event, and enforce the per-agent cap in the same round trip.
   *
   * The trim is a CTE rather than a second statement so a note costs exactly
   * one query: events are written from a hot path (every step boundary, every
   * retry) and the runner awaits each one.
   */
  async record(input: RecordTeamsProvisioningEventInput): Promise<void> {
    if (!isTeamsProvisioningEventStatus(input.status)) {
      throw new TeamsProvisioningEventStatusError(input.status);
    }
    await this.pool.query(
      `WITH inserted AS (
         INSERT INTO agent_teams_provisioning_events (agent_id, step, status, attempt, detail)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING agent_id
       )
       DELETE FROM agent_teams_provisioning_events
        WHERE agent_id = (SELECT agent_id FROM inserted)
          AND id NOT IN (
            SELECT id FROM agent_teams_provisioning_events
             WHERE agent_id = $1
             ORDER BY id DESC
             LIMIT $6
          )`,
      [
        input.agentId,
        input.step,
        input.status,
        clampAttempt(input.attempt),
        clampDetail(input.detail),
        MAX_EVENTS_PER_AGENT,
      ],
    );
  }

  /** The newest events first — the order the operator timeline renders in. */
  async listRecent(
    agentId: string,
    limit?: number,
  ): Promise<readonly TeamsProvisioningEventRecord[]> {
    const res = await this.pool.query<TeamsProvisioningEventRow>(
      `SELECT ${COLUMNS} FROM agent_teams_provisioning_events
        WHERE agent_id = $1
        ORDER BY id DESC
        LIMIT $2`,
      [agentId, clampLimit(limit)],
    );
    return res.rows.map(mapRow);
  }

  /**
   * Drop this agent's log. Called by the runner as a run BEGINS, because the
   * log describes one run — see the migration header.
   *
   * Returns how many rows went, which is what the runner logs when it wants
   * to say "a previous run's timeline was replaced".
   */
  async clearForAgent(agentId: string): Promise<number> {
    const res = await this.pool.query(
      'DELETE FROM agent_teams_provisioning_events WHERE agent_id = $1',
      [agentId],
    );
    return res.rowCount ?? 0;
  }
}
