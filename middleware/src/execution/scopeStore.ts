/**
 * #2090 — durable state of execution scopes, conversation reservations and
 * the kill switch (migration 0073).
 *
 * Every write that decides something is ONE statement or one transaction
 * with a transaction-scoped lock: the instance may sit behind a
 * transaction-mode pooler, and two replicas may race for the last budget
 * unit. Nothing here holds session state.
 */

import type {
  ConversationReservation,
  ExecutionActionType,
  ExecutionEmissionType,
  ExecutionPhase,
  ExecutionPurpose,
  ExecutionScope,
  ExecutionScopeKind,
  ExecutionTarget,
} from '@omadia/plugin-api';
import type { Pool, PoolClient } from 'pg';

/** Advisory-lock namespace for "one process at a time" inside openScope. */
const PROCESS_LOCK_NS = 4_430;
const UNIQUE_VIOLATION = '23505';

export interface ScopeRow extends ExecutionScope {
  readonly agentId: string;
  readonly pluginId: string;
}

export interface KillSwitch {
  readonly id: string;
  readonly level: 'instance' | 'agent' | 'process';
  readonly agentId?: string;
  readonly processId?: string;
  readonly reason: string;
  readonly setBy: string;
  readonly setAt: string;
}

export interface ReservationRow extends ConversationReservation {
  readonly holderKind: 'archetype_process' | 'agent_discussion';
  readonly agentId?: string;
  readonly pluginId?: string;
}

export interface NewScope {
  readonly agentId: string;
  readonly agentSlug: string;
  readonly pluginId: string;
  readonly processId: string;
  readonly kind: ExecutionScopeKind;
  readonly eventId: string;
  readonly deadline: Date;
  readonly absoluteLimit: Date;
  readonly budgetActions: number;
  readonly budgetModelCalls: number;
  readonly targets: readonly ExecutionTarget[];
  readonly home?: { readonly channelType: string; readonly conversationId: string };
}

export type OpenScopeResult =
  | { readonly ok: true; readonly scope: ScopeRow }
  | {
      readonly ok: false;
      readonly code: 'scope_exists' | 'scope_order' | 'conversation_busy' | 'target_not_allowed';
      readonly message: string;
    };

export type ReserveResult =
  | { readonly ok: true; readonly reservation: ReservationRow }
  | { readonly ok: false; readonly heldBy: ReservationRow | undefined };

export type AuthorizeResult =
  | { readonly ok: true; readonly authorizationId: string; readonly scope: ScopeRow }
  | { readonly ok: false };

interface ScopeDbRow {
  id: string;
  agent_id: string;
  agent_slug: string;
  plugin_id: string;
  process_id: string;
  kind: ExecutionScopeKind;
  event_id: string;
  state: 'open' | 'ended';
  deadline: Date;
  absolute_limit: Date;
  deadline_wait: boolean;
  budget_actions: number;
  budget_model_calls: number;
  used_actions: number;
  used_model_calls: number;
  targets: ExecutionTarget[];
  opened_at: Date;
  ended_at: Date | null;
  end_reason: string | null;
}

const SCOPE_COLS =
  'id, agent_id, agent_slug, plugin_id, process_id, kind, event_id, state, deadline, absolute_limit, deadline_wait, ' +
  'budget_actions, budget_model_calls, used_actions, used_model_calls, targets, opened_at, ended_at, end_reason';

function toScope(r: ScopeDbRow): ScopeRow {
  return {
    id: r.id,
    agentId: r.agent_id,
    agentSlug: r.agent_slug,
    pluginId: r.plugin_id,
    processId: r.process_id,
    kind: r.kind,
    eventId: r.event_id,
    state: r.state,
    deadline: r.deadline.toISOString(),
    absoluteLimit: r.absolute_limit.toISOString(),
    deadlineWait: r.deadline_wait,
    budget: { actions: r.budget_actions, modelCalls: r.budget_model_calls },
    used: { actions: r.used_actions, modelCalls: r.used_model_calls },
    targets: r.targets ?? [],
    openedAt: r.opened_at.toISOString(),
    ...(r.ended_at ? { endedAt: r.ended_at.toISOString() } : {}),
    ...(r.end_reason ? { endReason: r.end_reason } : {}),
  };
}

interface ReservationDbRow {
  channel_type: string;
  conversation_id: string;
  holder_kind: 'archetype_process' | 'agent_discussion';
  agent_id: string | null;
  plugin_id: string | null;
  process_id: string;
  role: 'home' | 'session';
  reserved_at: Date;
  released_at: Date | null;
}

const RESERVATION_COLS =
  'channel_type, conversation_id, holder_kind, agent_id, plugin_id, process_id, role, reserved_at, released_at';

function toReservation(r: ReservationDbRow): ReservationRow {
  return {
    channelType: r.channel_type,
    conversationId: r.conversation_id,
    holderKind: r.holder_kind,
    processId: r.process_id,
    role: r.role,
    reservedAt: r.reserved_at.toISOString(),
    ...(r.released_at ? { releasedAt: r.released_at.toISOString() } : {}),
    ...(r.agent_id ? { agentId: r.agent_id } : {}),
    ...(r.plugin_id ? { pluginId: r.plugin_id } : {}),
  };
}

/** The condition under which a set kill switch reaches scope `sc`. */
const KILLED = `EXISTS (
  SELECT 1 FROM execution_kill_switches k
   WHERE k.cleared_at IS NULL
     AND (k.level = 'instance'
       OR (k.level = 'agent' AND k.agent_id = sc.agent_id)
       OR (k.level = 'process' AND k.agent_id = sc.agent_id AND k.process_id = sc.process_id)))`;

export class ExecutionScopeStore {
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

  /**
   * Open a scope under the scope state machine. One transaction, serialised
   * per process, so two workers cannot both open `active` or both find "no
   * scope yet".
   */
  async openScope(input: NewScope): Promise<OpenScopeResult> {
    return this.inTransaction(async (client) => {
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query('SELECT pg_advisory_xact_lock($1::int, hashtext($2)::int)', [
        PROCESS_LOCK_NS,
        `${input.pluginId}|${input.processId}`,
      ]);
      const existing = await client.query<{ kind: ExecutionScopeKind; event_id: string; state: string; agent_id: string }>(
        'SELECT kind, event_id, state, agent_id FROM execution_scopes WHERE plugin_id = $1 AND process_id = $2',
        [input.pluginId, input.processId],
      );
      const had = (kind: ExecutionScopeKind): boolean => existing.rows.some((r) => r.kind === kind);
      if (existing.rows.some((r) => r.kind === input.kind && r.event_id === input.eventId)) {
        return {
          ok: false,
          code: 'scope_exists',
          message: `this process already has or had its '${input.kind}' scope${input.eventId ? ` for '${input.eventId}'` : ''}; an ended scope never re-opens`,
        };
      }
      if (existing.rows.some((r) => r.agent_id !== input.agentId)) {
        return { ok: false, code: 'scope_order', message: 'this process belongs to another agent' };
      }
      const order = scopeOrderRefusal(input.kind, existing.rows, had);
      if (order) return { ok: false, code: 'scope_order', message: order };

      if (input.kind === 'configuring' && input.home) {
        const reserved = await insertReservation(client, {
          channelType: input.home.channelType,
          conversationId: input.home.conversationId,
          holderKind: 'archetype_process',
          agentId: input.agentId,
          pluginId: input.pluginId,
          processId: input.processId,
          role: 'home',
        });
        if (!reserved) {
          return {
            ok: false,
            code: 'conversation_busy',
            message: 'another process (a facilitation or an agent discussion) holds this conversation',
          };
        }
      }

      // A conversation target must be one this process holds or held.
      const held = await client.query<{ channel_type: string; conversation_id: string }>(
        `SELECT channel_type, conversation_id FROM conversation_reservations
          WHERE plugin_id = $1 AND process_id = $2 AND holder_kind = 'archetype_process'`,
        [input.pluginId, input.processId],
      );
      const foreign = input.targets.find(
        (t) =>
          t.kind === 'conversation' &&
          !held.rows.some((h) => h.channel_type === t.channelType && h.conversation_id === t.conversationId),
      );
      if (foreign && foreign.kind === 'conversation') {
        return {
          ok: false,
          code: 'target_not_allowed',
          message: `conversation '${foreign.conversationId}' was never reserved by this process`,
        };
      }

      if (input.kind === 'active') {
        await client.query(
          `UPDATE execution_scopes SET state = 'ended', ended_at = now(), end_reason = 'active_opened'
            WHERE plugin_id = $1 AND process_id = $2 AND kind = 'configuring' AND state = 'open'`,
          [input.pluginId, input.processId],
        );
      }
      const inserted = await client.query<ScopeDbRow>(
        `INSERT INTO execution_scopes
           (agent_id, agent_slug, plugin_id, process_id, kind, event_id, deadline, absolute_limit,
            budget_actions, budget_model_calls, targets)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
         RETURNING ${SCOPE_COLS}`,
        [
          input.agentId,
          input.agentSlug,
          input.pluginId,
          input.processId,
          input.kind,
          input.eventId,
          input.deadline,
          input.absoluteLimit,
          input.budgetActions,
          input.budgetModelCalls,
          JSON.stringify(input.targets),
        ],
      );
      return { ok: true, scope: toScope(inserted.rows[0] as ScopeDbRow) };
    });
  }

  async getScope(id: string): Promise<ScopeRow | undefined> {
    const res = await this.pool.query<ScopeDbRow>(`SELECT ${SCOPE_COLS} FROM execution_scopes WHERE id = $1`, [id]);
    return res.rows[0] ? toScope(res.rows[0]) : undefined;
  }

  async listScopesOfProcess(pluginId: string, processId: string): Promise<ScopeRow[]> {
    const res = await this.pool.query<ScopeDbRow>(
      `SELECT ${SCOPE_COLS} FROM execution_scopes WHERE plugin_id = $1 AND process_id = $2 ORDER BY opened_at, id`,
      [pluginId, processId],
    );
    return res.rows.map(toScope);
  }

  /** Open scopes of every agent, for the operator. */
  async listOpenScopes(limit: number): Promise<ScopeRow[]> {
    const res = await this.pool.query<ScopeDbRow>(
      `SELECT ${SCOPE_COLS} FROM execution_scopes WHERE state = 'open' ORDER BY deadline, id LIMIT $1`,
      [limit],
    );
    return res.rows.map(toScope);
  }

  /**
   * Take one action and `modelCalls` from the scope. ONE statement: the
   * conditions and the increment cannot be separated by another worker, and
   * the authorization row exists exactly when the units were taken.
   */
  async authorize(input: {
    scopeId: string;
    pluginId: string;
    action: ExecutionActionType;
    purpose: ExecutionPurpose;
    phase: ExecutionPhase;
    target?: ExecutionTarget;
    emission?: ExecutionEmissionType;
    modelCalls: number;
  }): Promise<AuthorizeResult> {
    const res = await this.pool.query<ScopeDbRow & { authorization_id: string }>(
      `WITH taken AS (
         UPDATE execution_scopes sc
            SET used_actions = sc.used_actions + 1,
                used_model_calls = sc.used_model_calls + $3
          WHERE sc.id = $1 AND sc.plugin_id = $2 AND sc.state = 'open' AND sc.deadline > now()
            AND sc.used_actions < sc.budget_actions
            AND sc.used_model_calls + $3 <= sc.budget_model_calls
            AND NOT ${KILLED}
          RETURNING ${SCOPE_COLS}
       ), made AS (
         INSERT INTO execution_authorizations (scope_id, action, purpose, phase, target, reserved_model_calls, emission)
         SELECT taken.id, $4, $5, $6, $7::jsonb, $3, $8 FROM taken
         RETURNING id
       )
       SELECT taken.*, made.id AS authorization_id FROM taken, made`,
      [
        input.scopeId,
        input.pluginId,
        input.modelCalls,
        input.action,
        input.purpose,
        input.phase,
        input.target ? JSON.stringify(input.target) : null,
        input.emission ?? null,
      ],
    );
    const row = res.rows[0];
    if (!row) return { ok: false };
    return { ok: true, authorizationId: row.authorization_id, scope: toScope(row) };
  }

  /** Whether a set kill switch reaches the scope, and which. */
  async killSwitchFor(scope: Pick<ScopeRow, 'agentId' | 'processId'>): Promise<KillSwitch | undefined> {
    const res = await this.pool.query<KillSwitchDbRow>(
      `SELECT ${KILL_COLS} FROM execution_kill_switches k
        WHERE k.cleared_at IS NULL
          AND (k.level = 'instance'
            OR (k.level = 'agent' AND k.agent_id = $1)
            OR (k.level = 'process' AND k.agent_id = $1 AND k.process_id = $2))
        ORDER BY k.set_at LIMIT 1`,
      [scope.agentId, scope.processId],
    );
    return res.rows[0] ? toKillSwitch(res.rows[0]) : undefined;
  }

  /**
   * Return the unused part of a turn's model-call reservation; charge what it
   * used beyond it, up to the budget. Settles once.
   */
  async settle(authorizationId: string, pluginId: string, usedModelCalls: number): Promise<boolean> {
    const res = await this.pool.query(
      `WITH done AS (
         UPDATE execution_authorizations a
            SET used_model_calls = $3, settled_at = now()
           FROM execution_scopes sc
          WHERE a.id = $1 AND a.settled_at IS NULL AND sc.id = a.scope_id AND sc.plugin_id = $2
          RETURNING a.scope_id, a.reserved_model_calls
       )
       UPDATE execution_scopes sc
          SET used_model_calls = LEAST(sc.budget_model_calls,
                                       GREATEST(0, sc.used_model_calls - done.reserved_model_calls + $3))
         FROM done WHERE sc.id = done.scope_id`,
      [authorizationId, pluginId, usedModelCalls],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async setTargets(scopeId: string, pluginId: string, targets: readonly ExecutionTarget[]): Promise<ScopeRow | undefined> {
    const res = await this.pool.query<ScopeDbRow>(
      `UPDATE execution_scopes SET targets = $3::jsonb
        WHERE id = $1 AND plugin_id = $2 AND state = 'open' RETURNING ${SCOPE_COLS}`,
      [scopeId, pluginId, JSON.stringify(targets)],
    );
    return res.rows[0] ? toScope(res.rows[0]) : undefined;
  }

  /** Move the deadline of an open scope. The caller has checked the rules;
   *  the absolute limit is enforced again here and by the table. */
  async extend(scopeId: string, pluginId: string, deadline: Date, deadlineWait: boolean): Promise<ScopeRow | undefined> {
    const res = await this.pool.query<ScopeDbRow>(
      `UPDATE execution_scopes SET deadline = $3, deadline_wait = deadline_wait OR $4
        WHERE id = $1 AND plugin_id = $2 AND state = 'open' AND $3 <= absolute_limit
        RETURNING ${SCOPE_COLS}`,
      [scopeId, pluginId, deadline, deadlineWait],
    );
    return res.rows[0] ? toScope(res.rows[0]) : undefined;
  }

  async endScope(scopeId: string, pluginId: string, reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE execution_scopes SET state = 'ended', ended_at = now(), end_reason = $3
        WHERE id = $1 AND plugin_id = $2 AND state = 'open'`,
      [scopeId, pluginId, reason.slice(0, 200)],
    );
  }

  // ── reservations ────────────────────────────────────────────────────────

  async reserve(input: {
    channelType: string;
    conversationId: string;
    holderKind: 'archetype_process' | 'agent_discussion';
    agentId?: string;
    pluginId?: string;
    processId: string;
    role: 'home' | 'session';
  }): Promise<ReserveResult> {
    return this.inTransaction(async (client) => {
      const reservation = await insertReservation(client, input);
      if (reservation) return { ok: true, reservation };
      return { ok: false, heldBy: await holderOf(client, input.channelType, input.conversationId) };
    });
  }

  async holder(channelType: string, conversationId: string): Promise<ReservationRow | undefined> {
    return holderOf(this.pool, channelType, conversationId);
  }

  /** Release what `processId` holds in this conversation. Idempotent. */
  async release(input: {
    channelType: string;
    conversationId: string;
    holderKind: 'archetype_process' | 'agent_discussion';
    pluginId?: string;
    processId?: string;
    reason: string;
  }): Promise<number> {
    const res = await this.pool.query(
      `UPDATE conversation_reservations SET released_at = now(), release_reason = $6
        WHERE channel_type = $1 AND conversation_id = $2 AND holder_kind = $3 AND released_at IS NULL
          AND ($4::text IS NULL OR plugin_id = $4) AND ($5::text IS NULL OR process_id = $5)`,
      [input.channelType, input.conversationId, input.holderKind, input.pluginId ?? null, input.processId ?? null, input.reason.slice(0, 200)],
    );
    return res.rowCount ?? 0;
  }

  async listReservationsOfProcess(pluginId: string, processId: string): Promise<ReservationRow[]> {
    const res = await this.pool.query<ReservationDbRow>(
      `SELECT ${RESERVATION_COLS} FROM conversation_reservations
        WHERE plugin_id = $1 AND process_id = $2 ORDER BY reserved_at, id`,
      [pluginId, processId],
    );
    return res.rows.map(toReservation);
  }

  /**
   * #2089 — what a process may read in a conversation right now: whether it
   * holds the reservation, ever held it, and has an open scope whose
   * deadline has not passed. One statement.
   */
  async processAccess(input: {
    pluginId: string;
    processId: string;
    channelType: string;
    conversationId: string;
  }): Promise<{ reserved: boolean; everReserved: boolean; openScope: boolean }> {
    const res = await this.pool.query<{ reserved: boolean; ever_reserved: boolean; open_scope: boolean }>(
      `SELECT
         EXISTS (SELECT 1 FROM conversation_reservations r
                  WHERE r.plugin_id = $1 AND r.process_id = $2 AND r.channel_type = $3
                    AND r.conversation_id = $4 AND r.holder_kind = 'archetype_process'
                    AND r.released_at IS NULL) AS reserved,
         EXISTS (SELECT 1 FROM conversation_reservations r
                  WHERE r.plugin_id = $1 AND r.process_id = $2 AND r.channel_type = $3
                    AND r.conversation_id = $4 AND r.holder_kind = 'archetype_process') AS ever_reserved,
         EXISTS (SELECT 1 FROM execution_scopes sc
                  WHERE sc.plugin_id = $1 AND sc.process_id = $2 AND sc.state = 'open'
                    AND sc.deadline > now()) AS open_scope`,
      [input.pluginId, input.processId, input.channelType, input.conversationId],
    );
    const row = res.rows[0];
    return { reserved: row?.reserved === true, everReserved: row?.ever_reserved === true, openScope: row?.open_scope === true };
  }

  // ── revocation ──────────────────────────────────────────────────────────

  /** End every open scope and release every reservation of an agent (end of
   *  service) or of a plugin (its uninstall). One transaction. */
  async revokeAll(
    of: { agentId: string } | { pluginId: string },
    reason: string,
  ): Promise<{ scopes: ScopeRow[]; reservations: ReservationRow[] }> {
    const [column, value] = 'agentId' in of ? ['agent_id', of.agentId] : ['plugin_id', of.pluginId];
    return this.inTransaction(async (client) => {
      const scopes = await client.query<ScopeDbRow>(
        `UPDATE execution_scopes SET state = 'ended', ended_at = now(), end_reason = $2
          WHERE ${column} = $1 AND state = 'open' RETURNING ${SCOPE_COLS}`,
        [value, reason.slice(0, 200)],
      );
      const reservations = await client.query<ReservationDbRow>(
        `UPDATE conversation_reservations SET released_at = now(), release_reason = $2
          WHERE ${column} = $1 AND released_at IS NULL AND holder_kind = 'archetype_process'
          RETURNING ${RESERVATION_COLS}`,
        [value, reason.slice(0, 200)],
      );
      return { scopes: scopes.rows.map(toScope), reservations: reservations.rows.map(toReservation) };
    });
  }

  /**
   * End scopes whose deadline passed, and release the reservations of
   * processes that have no open scope left: a plugin that stopped answering
   * must not hold a conversation forever.
   */
  async sweepExpired(): Promise<{ scopesEnded: number; reservationsReleased: number }> {
    return this.inTransaction(async (client) => {
      const scopes = await client.query(
        `UPDATE execution_scopes SET state = 'ended', ended_at = now(), end_reason = 'deadline'
          WHERE state = 'open' AND deadline <= now()`,
      );
      const reservations = await client.query(
        `UPDATE conversation_reservations r SET released_at = now(), release_reason = 'no_open_scope'
          WHERE r.released_at IS NULL AND r.holder_kind = 'archetype_process'
            AND NOT EXISTS (
              SELECT 1 FROM execution_scopes sc
               WHERE sc.plugin_id = r.plugin_id AND sc.process_id = r.process_id AND sc.state = 'open')`,
      );
      return { scopesEnded: scopes.rowCount ?? 0, reservationsReleased: reservations.rowCount ?? 0 };
    });
  }

  // ── kill switch ─────────────────────────────────────────────────────────

  async listKillSwitches(): Promise<KillSwitch[]> {
    const res = await this.pool.query<KillSwitchDbRow>(
      `SELECT ${KILL_COLS} FROM execution_kill_switches k WHERE k.cleared_at IS NULL ORDER BY k.set_at`,
    );
    return res.rows.map(toKillSwitch);
  }

  /** Set a switch. Setting one that is already set returns the existing one. */
  async setKillSwitch(input: {
    level: 'instance' | 'agent' | 'process';
    agentId?: string;
    processId?: string;
    reason: string;
    setBy: string;
  }): Promise<KillSwitch> {
    try {
      const res = await this.pool.query<KillSwitchDbRow>(
        `INSERT INTO execution_kill_switches AS k (level, agent_id, process_id, reason, set_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING ${KILL_COLS}`,
        [input.level, input.agentId ?? null, input.processId ?? null, input.reason.slice(0, 500), input.setBy],
      );
      return toKillSwitch(res.rows[0] as KillSwitchDbRow);
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code !== UNIQUE_VIOLATION) throw err;
      const res = await this.pool.query<KillSwitchDbRow>(
        `SELECT ${KILL_COLS} FROM execution_kill_switches k
          WHERE k.cleared_at IS NULL AND k.level = $1
            AND COALESCE(k.agent_id::text, '') = COALESCE($2::text, '')
            AND COALESCE(k.process_id, '') = COALESCE($3::text, '')`,
        [input.level, input.agentId ?? null, input.processId ?? null],
      );
      return toKillSwitch(res.rows[0] as KillSwitchDbRow);
    }
  }

  async clearKillSwitch(id: string, clearedBy: string): Promise<KillSwitch | undefined> {
    const res = await this.pool.query<KillSwitchDbRow>(
      `UPDATE execution_kill_switches k SET cleared_at = now(), cleared_by = $2
        WHERE k.id = $1 AND k.cleared_at IS NULL RETURNING ${KILL_COLS}`,
      [id, clearedBy],
    );
    return res.rows[0] ? toKillSwitch(res.rows[0]) : undefined;
  }
}

interface KillSwitchDbRow {
  id: string;
  level: 'instance' | 'agent' | 'process';
  agent_id: string | null;
  process_id: string | null;
  reason: string;
  set_by: string;
  set_at: Date;
}

const KILL_COLS = 'k.id, k.level, k.agent_id, k.process_id, k.reason, k.set_by, k.set_at';

function toKillSwitch(r: KillSwitchDbRow): KillSwitch {
  return {
    id: r.id,
    level: r.level,
    reason: r.reason,
    setBy: r.set_by,
    setAt: r.set_at.toISOString(),
    ...(r.agent_id ? { agentId: r.agent_id } : {}),
    ...(r.process_id ? { processId: r.process_id } : {}),
  };
}

/** The order of spec 2043 §0 and §5.2. Returns why the kind may not open now. */
function scopeOrderRefusal(
  kind: ExecutionScopeKind,
  existing: readonly { kind: ExecutionScopeKind; state: string }[],
  had: (kind: ExecutionScopeKind) => boolean,
): string | undefined {
  switch (kind) {
    case 'configuring':
      return existing.length > 0 ? "'configuring' is the first scope of a process" : undefined;
    case 'active':
      return existing.some((r) => r.kind === 'configuring' && r.state === 'open')
        ? undefined
        : "'active' opens out of an open 'configuring' scope (the handshake)";
    case 'closing':
      return had('configuring') ? undefined : "a 'closing' scope needs a process that was started";
    case 'scheduling':
    case 'follow_up':
      return had('active') ? undefined : `'${kind}' needs a process that was active`;
  }
}

async function insertReservation(
  client: Pick<PoolClient, 'query'>,
  input: {
    channelType: string;
    conversationId: string;
    holderKind: 'archetype_process' | 'agent_discussion';
    agentId?: string;
    pluginId?: string;
    processId: string;
    role: 'home' | 'session';
  },
): Promise<ReservationRow | undefined> {
  // ON CONFLICT on the partial unique index: a held conversation yields no
  // row instead of an error that would abort the surrounding transaction.
  const res = await client.query<ReservationDbRow>(
    `INSERT INTO conversation_reservations
       (channel_type, conversation_id, holder_kind, agent_id, plugin_id, process_id, role)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (channel_type, conversation_id) WHERE released_at IS NULL DO NOTHING
     RETURNING ${RESERVATION_COLS}`,
    [
      input.channelType,
      input.conversationId,
      input.holderKind,
      input.agentId ?? null,
      input.pluginId ?? null,
      input.processId,
      input.role,
    ],
  );
  return res.rows[0] ? toReservation(res.rows[0]) : undefined;
}

async function holderOf(
  db: Pick<Pool, 'query'>,
  channelType: string,
  conversationId: string,
): Promise<ReservationRow | undefined> {
  const res = await db.query<ReservationDbRow>(
    `SELECT ${RESERVATION_COLS} FROM conversation_reservations
      WHERE channel_type = $1 AND conversation_id = $2 AND released_at IS NULL`,
    [channelType, conversationId],
  );
  return res.rows[0] ? toReservation(res.rows[0]) : undefined;
}
