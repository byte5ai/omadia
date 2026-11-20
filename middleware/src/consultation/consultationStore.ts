/**
 * Spec 2042 §5.4 / ADR-0018 — consultation switches, directed grants and the
 * call ledger (migration 0097). Postgres only; every read the broker makes on
 * a call is fresh, so a revoked grant is refused on the next call.
 */

import type { Pool } from 'pg';

import {
  liveAgentRow,
  parseDisclosurePolicy,
  type DisclosurePolicy,
} from '@omadia/orchestrator';

export type ConsultationMemoryAccess = 'none' | 'discreet';

export interface ConsultationSwitches {
  readonly consultable: boolean;
  readonly mayConsult: boolean;
}

export interface ConsultationGrant {
  readonly fromAgentId: string;
  readonly toAgentId: string;
  /** Channel types the grant holds in; `null` = every channel. */
  readonly channelScope: readonly string[] | null;
  readonly allowedCapabilities: readonly string[];
  readonly memoryAccess: ConsultationMemoryAccess;
  readonly disclosure: DisclosurePolicy;
  readonly maxCallsPerTurn: number;
  readonly maxCallsPerDay: number;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedBy: string | null;
  readonly updatedAt: Date;
}

export interface ConsultationGrantInput {
  readonly channelScope?: readonly string[] | null;
  readonly allowedCapabilities?: readonly string[];
  readonly memoryAccess?: ConsultationMemoryAccess;
  readonly disclosure?: DisclosurePolicy;
  readonly maxCallsPerTurn?: number;
  readonly maxCallsPerDay?: number;
}

/** A grant both of whose agents have their switch on (offering snapshot). */
export interface ActiveConsultationPair {
  readonly fromSlug: string;
  readonly toSlug: string;
}

export type ConsultationCallStatus = 'delivered' | 'withheld' | 'failed';

interface GrantDbRow {
  from_agent_id: string;
  to_agent_id: string;
  channel_scope: string[] | null;
  allowed_capabilities: string[];
  memory_access: string;
  disclosure: unknown;
  max_calls_per_turn: number;
  max_calls_per_day: number;
  created_by: string;
  created_at: Date;
  updated_by: string | null;
  updated_at: Date;
}

const GRANT_COLUMNS =
  'from_agent_id, to_agent_id, channel_scope, allowed_capabilities, memory_access, disclosure, ' +
  'max_calls_per_turn, max_calls_per_day, created_by, created_at, updated_by, updated_at';

function mapGrant(row: GrantDbRow): ConsultationGrant {
  return {
    fromAgentId: row.from_agent_id,
    toAgentId: row.to_agent_id,
    channelScope: row.channel_scope,
    allowedCapabilities: row.allowed_capabilities,
    // Deny-default: anything unrecognised reads as no memory.
    memoryAccess: row.memory_access === 'discreet' ? 'discreet' : 'none',
    // A malformed policy reads as `{}`: `none` for everything new.
    disclosure: parseDisclosurePolicy(row.disclosure) ?? {},
    maxCallsPerTurn: row.max_calls_per_turn,
    maxCallsPerDay: row.max_calls_per_day,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

const COUNT_CALLS_TODAY_SQL = `SELECT count(*)::int AS n FROM agent_consultation_calls
  WHERE from_agent_id = $1 AND to_agent_id = $2
    AND started_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;

export class ConsultationStore {
  /**
   * `pool` may be late-bound: the kernel's Postgres pool is published by the
   * knowledge-graph plugin during plugin activation, after the services the
   * orchestrator reads are published. A call before it exists throws.
   */
  constructor(private readonly poolRef: Pool | (() => Pool | undefined)) {}

  private get pool(): Pool {
    const pool = typeof this.poolRef === 'function' ? this.poolRef() : this.poolRef;
    if (!pool) throw new Error('consultation store: no database');
    return pool;
  }

  async getSwitches(agentId: string): Promise<ConsultationSwitches | undefined> {
    const { rows } = await this.pool.query<{ consultable: boolean; may_consult: boolean }>(
      `SELECT consultable, may_consult FROM agents a WHERE a.id = $1 AND ${liveAgentRow('a')}`,
      [agentId],
    );
    const row = rows[0];
    return row ? { consultable: row.consultable, mayConsult: row.may_consult } : undefined;
  }

  async setSwitches(agentId: string, patch: Partial<ConsultationSwitches>): Promise<ConsultationSwitches> {
    const { rows } = await this.pool.query<{ consultable: boolean; may_consult: boolean }>(
      `UPDATE agents
          SET consultable = COALESCE($2, consultable),
              may_consult = COALESCE($3, may_consult),
              updated_at  = now()
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING consultable, may_consult`,
      [agentId, patch.consultable ?? null, patch.mayConsult ?? null],
    );
    const row = rows[0];
    if (!row) throw new Error(`agent ${agentId} not found`);
    return { consultable: row.consultable, mayConsult: row.may_consult };
  }

  async getGrant(fromAgentId: string, toAgentId: string): Promise<ConsultationGrant | undefined> {
    const { rows } = await this.pool.query<GrantDbRow>(
      `SELECT ${GRANT_COLUMNS} FROM agent_consultation_grants WHERE from_agent_id = $1 AND to_agent_id = $2`,
      [fromAgentId, toAgentId],
    );
    return rows[0] ? mapGrant(rows[0]) : undefined;
  }

  /** Grants where the agent is either side. */
  async listGrantsOf(agentId: string): Promise<ConsultationGrant[]> {
    const { rows } = await this.pool.query<GrantDbRow>(
      `SELECT ${GRANT_COLUMNS} FROM agent_consultation_grants
        WHERE from_agent_id = $1 OR to_agent_id = $1
        ORDER BY created_at`,
      [agentId],
    );
    return rows.map(mapGrant);
  }

  async upsertGrant(
    fromAgentId: string,
    toAgentId: string,
    input: ConsultationGrantInput,
    actor: string,
  ): Promise<{ before: ConsultationGrant | undefined; after: ConsultationGrant }> {
    const before = await this.getGrant(fromAgentId, toAgentId);
    const { rows } = await this.pool.query<GrantDbRow>(
      `INSERT INTO agent_consultation_grants
         (from_agent_id, to_agent_id, channel_scope, allowed_capabilities, memory_access,
          disclosure, max_calls_per_turn, max_calls_per_day, created_by)
       VALUES ($1, $2, $3, COALESCE($4, '{}'::text[]), COALESCE($5, 'none'), COALESCE($6::jsonb, '{}'::jsonb),
               COALESCE($7, 2), COALESCE($8, 50), $9)
       ON CONFLICT (from_agent_id, to_agent_id) DO UPDATE SET
         channel_scope        = CASE WHEN $10 THEN EXCLUDED.channel_scope ELSE agent_consultation_grants.channel_scope END,
         allowed_capabilities = COALESCE($4, agent_consultation_grants.allowed_capabilities),
         memory_access        = COALESCE($5, agent_consultation_grants.memory_access),
         disclosure           = COALESCE($6::jsonb, agent_consultation_grants.disclosure),
         max_calls_per_turn   = COALESCE($7, agent_consultation_grants.max_calls_per_turn),
         max_calls_per_day    = COALESCE($8, agent_consultation_grants.max_calls_per_day),
         updated_by           = $9,
         updated_at           = now()
       RETURNING ${GRANT_COLUMNS}`,
      [
        fromAgentId,
        toAgentId,
        input.channelScope === undefined ? null : input.channelScope,
        input.allowedCapabilities ?? null,
        input.memoryAccess ?? null,
        input.disclosure ? JSON.stringify(input.disclosure) : null,
        input.maxCallsPerTurn ?? null,
        input.maxCallsPerDay ?? null,
        actor,
        input.channelScope !== undefined,
      ],
    );
    return { before, after: mapGrant(rows[0] as GrantDbRow) };
  }

  async deleteGrant(fromAgentId: string, toAgentId: string): Promise<ConsultationGrant | undefined> {
    const { rows } = await this.pool.query<GrantDbRow>(
      `DELETE FROM agent_consultation_grants WHERE from_agent_id = $1 AND to_agent_id = $2
       RETURNING ${GRANT_COLUMNS}`,
      [fromAgentId, toAgentId],
    );
    return rows[0] ? mapGrant(rows[0]) : undefined;
  }

  /** Pairs whose grant exists and both switches are on, between live agents. */
  async listActivePairs(): Promise<ActiveConsultationPair[]> {
    const { rows } = await this.pool.query<{ from_slug: string; to_slug: string }>(
      `SELECT f.slug AS from_slug, t.slug AS to_slug
         FROM agent_consultation_grants g
         JOIN agents f ON f.id = g.from_agent_id AND ${liveAgentRow('f')} AND f.may_consult
         JOIN agents t ON t.id = g.to_agent_id AND ${liveAgentRow('t')} AND t.consultable
        ORDER BY f.slug, t.slug`,
    );
    return rows.map((r) => ({ fromSlug: r.from_slug, toSlug: r.to_slug }));
  }

  /**
   * Both directions granted (and all four switches on), each grant covering
   * the channel type: what a discussion there needs.
   */
  async hasMutualGrants(agentIdA: string, agentIdB: string, channelType: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM agent_consultation_grants g
         JOIN agents f ON f.id = g.from_agent_id AND ${liveAgentRow('f')} AND f.may_consult
         JOIN agents t ON t.id = g.to_agent_id AND ${liveAgentRow('t')} AND t.consultable
        WHERE ((g.from_agent_id = $1 AND g.to_agent_id = $2)
            OR (g.from_agent_id = $2 AND g.to_agent_id = $1))
          AND (g.channel_scope IS NULL OR $3 = ANY(g.channel_scope))`,
      [agentIdA, agentIdB, channelType],
    );
    return (rows[0]?.n ?? 0) === 2;
  }

  /** Calls A made to B since the start of the current UTC day. */
  async countCallsToday(fromAgentId: string, toAgentId: string): Promise<number> {
    const { rows } = await this.pool.query<{ n: number }>(COUNT_CALLS_TODAY_SQL, [fromAgentId, toAgentId]);
    return rows[0]?.n ?? 0;
  }

  /**
   * Record a call when the pair's day budget still has room; false when it
   * is spent. Count and insert run in one transaction under a transaction-
   * scoped advisory lock on the pair, so concurrent calls cannot both take
   * the last slot (transaction-scoped: safe behind a transaction pooler).
   */
  async startCall(call: {
    readonly id: string;
    readonly fromAgentId: string;
    readonly toAgentId: string;
    readonly fromTurnId: string;
    readonly channelType?: string;
    readonly maxCallsPerDay: number;
  }): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('consultation:' || $1 || ':' || $2, 0))", [
        call.fromAgentId,
        call.toAgentId,
      ]);
      const { rows } = await client.query<{ n: number }>(COUNT_CALLS_TODAY_SQL, [call.fromAgentId, call.toAgentId]);
      if ((rows[0]?.n ?? 0) >= call.maxCallsPerDay) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query(
        `INSERT INTO agent_consultation_calls (id, from_agent_id, to_agent_id, from_turn_id, channel_type)
         VALUES ($1, $2, $3, $4, $5)`,
        [call.id, call.fromAgentId, call.toAgentId, call.fromTurnId, call.channelType ?? null],
      );
      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async finishCall(
    id: string,
    result: { readonly status: ConsultationCallStatus; readonly outcome: string; readonly toTurnId?: string },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE agent_consultation_calls
          SET status = $2, outcome = $3, to_turn_id = $4, finished_at = now()
        WHERE id = $1`,
      [id, result.status, result.outcome, result.toTurnId ?? null],
    );
  }
}
