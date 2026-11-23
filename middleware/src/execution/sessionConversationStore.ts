/**
 * #2076 / #2089 (spec 2043 §5.3) — linked session conversations: link
 * requests and the session state of a `session` reservation (migration 0107).
 *
 * A session conversation is linked only on a link request made inside it
 * (criterion 48), and the reservation, the consumption of that request and
 * the new scope targets are one transaction (criterion 45: a second process
 * linking the same conversation at the same moment gets nothing). Every
 * write is one statement or one transaction with row locks; nothing holds
 * session state (the instance may sit behind a transaction-mode pooler).
 */

import {
  SESSION_CONVERSATION_TRANSITIONS,
  type SessionConversationState,
} from '@omadia/plugin-api';
import type { Pool, PoolClient } from 'pg';

import { RESERVATION_COLS, toReservation, type ReservationDbRow, type ReservationRow } from './scopeStore.js';

export interface NewLinkRequest {
  readonly pluginId: string;
  readonly agentId: string;
  readonly channelType: string;
  readonly conversationId: string;
  readonly principalId: string;
  readonly messageId?: string;
  readonly processIds: readonly string[];
  readonly ttlMs: number;
}

export type ReserveSessionResult =
  | { readonly ok: true; readonly reservation: ReservationRow }
  | { readonly ok: false; readonly code: 'link_not_authorized'; readonly message: string }
  | { readonly ok: false; readonly code: 'conversation_busy'; readonly heldBy: ReservationRow | undefined };

export type SetSessionStateResult =
  | { readonly ok: true; readonly reservation: ReservationRow; readonly changed: boolean }
  | { readonly ok: false; readonly code: 'unknown_scope' | 'session_state'; readonly message: string };

/** How the operator route names its releases (`routes/operatorExecution.ts`). */
const OPERATOR_RELEASE_PREFIX = 'released by ';

/** Scope kinds a linked conversation becomes a target of. A `closing` scope
 *  lists its targets when it opens. */
const LINKING_SCOPE_KINDS = ['configuring', 'active'];

export class SessionConversationStore {
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

  /** The processes of an agent, run by this plugin, that may link a
   *  conversation now: an open `configuring` or `active` scope. */
  async linkingProcesses(pluginId: string, agentId: string): Promise<string[]> {
    const res = await this.pool.query<{ process_id: string }>(
      `SELECT DISTINCT process_id FROM execution_scopes
        WHERE plugin_id = $1 AND agent_id = $2 AND state = 'open' AND deadline > now()
          AND kind = ANY($3::text[])
        ORDER BY process_id`,
      [pluginId, agentId, LINKING_SCOPE_KINDS],
    );
    return res.rows.map((r) => r.process_id);
  }

  async createLinkRequest(input: NewLinkRequest): Promise<{ id: string; expiresAt: string }> {
    const res = await this.pool.query<{ id: string; expires_at: Date }>(
      `INSERT INTO conversation_link_requests
         (plugin_id, agent_id, channel_type, conversation_id, principal_id, message_id, process_ids, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::text[], now() + ($8::bigint * interval '1 millisecond'))
       RETURNING id, expires_at`,
      [
        input.pluginId,
        input.agentId,
        input.channelType,
        input.conversationId,
        input.principalId,
        input.messageId ?? null,
        [...input.processIds],
        Math.max(1, Math.round(input.ttlMs)),
      ],
    );
    const row = res.rows[0] as { id: string; expires_at: Date };
    return { id: row.id, expiresAt: row.expires_at.toISOString() };
  }

  /** A request the plugin did not take is not left lying around. */
  async dropLinkRequest(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM conversation_link_requests WHERE id = $1 AND consumed_at IS NULL`, [id]);
  }

  /** Expired, unused requests; a used one stays while its reservation is
   *  held: it is the record of who authorized the link. */
  async purgeLinkRequests(olderThanMs: number): Promise<number> {
    const res = await this.pool.query(
      `DELETE FROM conversation_link_requests l
        WHERE l.expires_at < now() - ($1::bigint * interval '1 millisecond')
          AND NOT EXISTS (SELECT 1 FROM conversation_reservations r WHERE r.id = l.reservation_id AND r.released_at IS NULL)`,
      [Math.max(0, Math.round(olderThanMs))],
    );
    return res.rowCount ?? 0;
  }

  /**
   * Reserve a conversation as the session conversation of a process, on a
   * link request made inside it. The process that already holds it gets the
   * same reservation back (a restart, a repeated call).
   */
  async reserveSession(input: {
    pluginId: string;
    agentId: string;
    processId: string;
    channelType: string;
    conversationId: string;
    linkRequestId: string | undefined;
    sessionId: string | undefined;
  }): Promise<ReserveSessionResult> {
    return this.inTransaction(async (client) => {
      await client.query("SET LOCAL lock_timeout = '5s'");
      const held = await client.query<ReservationDbRow>(
        `SELECT ${RESERVATION_COLS} FROM conversation_reservations
          WHERE channel_type = $1 AND conversation_id = $2 AND released_at IS NULL`,
        [input.channelType, input.conversationId],
      );
      const holder = held.rows[0] ? toReservation(held.rows[0]) : undefined;
      if (holder && holder.holderKind === 'archetype_process' && holder.pluginId === input.pluginId && holder.processId === input.processId) {
        return { ok: true, reservation: holder };
      }
      if (input.linkRequestId === undefined) {
        // The process takes back its own home conversation after it lost the
        // reservation; no link is needed for that. Not after an operator
        // released it: that release is meant to stand.
        const home = await client.query<{ release_reason: string | null }>(
          `SELECT release_reason FROM conversation_reservations
            WHERE plugin_id = $1 AND process_id = $2 AND channel_type = $3 AND conversation_id = $4
              AND holder_kind = 'archetype_process' AND role = 'home'
            ORDER BY reserved_at DESC LIMIT 1`,
          [input.pluginId, input.processId, input.channelType, input.conversationId],
        );
        const last = home.rows[0];
        if (last && !(last.release_reason ?? '').startsWith(OPERATOR_RELEASE_PREFIX)) {
          if (holder) return { ok: false, code: 'conversation_busy', heldBy: holder };
          const again = await client.query<ReservationDbRow>(
            `INSERT INTO conversation_reservations
               (channel_type, conversation_id, holder_kind, agent_id, plugin_id, process_id, role)
             VALUES ($1, $2, 'archetype_process', $3, $4, $5, 'home')
             ON CONFLICT (channel_type, conversation_id) WHERE released_at IS NULL DO NOTHING
             RETURNING ${RESERVATION_COLS}`,
            [input.channelType, input.conversationId, input.agentId, input.pluginId, input.processId],
          );
          const taken = again.rows[0];
          return taken ? { ok: true, reservation: toReservation(taken) } : { ok: false, code: 'conversation_busy', heldBy: undefined };
        }
        return {
          ok: false,
          code: 'link_not_authorized',
          message: 'a session conversation is linked only on a link request made inside it',
        };
      }
      if (!/^[0-9a-f-]{36}$/i.test(input.linkRequestId)) {
        return { ok: false, code: 'link_not_authorized', message: 'not a link request' };
      }
      const request = await client.query<{ id: string }>(
        `SELECT id FROM conversation_link_requests
          WHERE id = $1 AND plugin_id = $2 AND agent_id = $3 AND channel_type = $4 AND conversation_id = $5
            AND $6 = ANY(process_ids) AND consumed_at IS NULL AND expires_at > now()
          FOR UPDATE`,
        [input.linkRequestId, input.pluginId, input.agentId, input.channelType, input.conversationId, input.processId],
      );
      if (request.rows.length === 0) {
        return {
          ok: false,
          code: 'link_not_authorized',
          message: 'the link request was not made in this conversation for this process, was used, or expired',
        };
      }
      if (holder) return { ok: false, code: 'conversation_busy', heldBy: holder };
      const inserted = await client.query<ReservationDbRow>(
        `INSERT INTO conversation_reservations
           (channel_type, conversation_id, holder_kind, agent_id, plugin_id, process_id, role, session_state, session_id)
         VALUES ($1, $2, 'archetype_process', $3, $4, $5, 'session', 'scheduled', $6)
         ON CONFLICT (channel_type, conversation_id) WHERE released_at IS NULL DO NOTHING
         RETURNING ${RESERVATION_COLS}`,
        [input.channelType, input.conversationId, input.agentId, input.pluginId, input.processId, input.sessionId ?? null],
      );
      const row = inserted.rows[0];
      if (!row) {
        // Taken by someone else in the same instant.
        const now = await client.query<ReservationDbRow>(
          `SELECT ${RESERVATION_COLS} FROM conversation_reservations
            WHERE channel_type = $1 AND conversation_id = $2 AND released_at IS NULL`,
          [input.channelType, input.conversationId],
        );
        return { ok: false, code: 'conversation_busy', heldBy: now.rows[0] ? toReservation(now.rows[0]) : undefined };
      }
      await client.query(
        `UPDATE conversation_link_requests SET consumed_at = now(), reservation_id = $2 WHERE id = $1`,
        [input.linkRequestId, row.id],
      );
      // The linked conversation becomes a target of the open scopes that
      // may address session conversations (spec 2043 §0).
      const target = JSON.stringify([{ kind: 'conversation', channelType: input.channelType, conversationId: input.conversationId }]);
      await client.query(
        `UPDATE execution_scopes SET targets = targets || $4::jsonb
          WHERE plugin_id = $1 AND process_id = $2 AND state = 'open' AND kind = ANY($3::text[])
            AND NOT targets @> $4::jsonb`,
        [input.pluginId, input.processId, LINKING_SCOPE_KINDS, target],
      );
      return { ok: true, reservation: toReservation(row) };
    });
  }

  /** The session reservation of a process in a conversation: the held one,
   *  else the latest released one. */
  async sessionReservation(input: {
    pluginId: string;
    processId: string;
    channelType: string;
    conversationId: string;
  }): Promise<ReservationRow | undefined> {
    const res = await this.pool.query<ReservationDbRow>(
      `SELECT ${RESERVATION_COLS} FROM conversation_reservations
        WHERE plugin_id = $1 AND process_id = $2 AND channel_type = $3 AND conversation_id = $4
          AND holder_kind = 'archetype_process' AND role = 'session'
        ORDER BY (released_at IS NULL) DESC, reserved_at DESC LIMIT 1`,
      [input.pluginId, input.processId, input.channelType, input.conversationId],
    );
    return res.rows[0] ? toReservation(res.rows[0]) : undefined;
  }

  /**
   * Move a session conversation to another state. `closed` and `cancelled`
   * release the reservation in the same statement. The same state again is
   * not a change.
   */
  async setSessionState(input: {
    pluginId: string;
    processId: string;
    channelType: string;
    conversationId: string;
    state: SessionConversationState;
    reason: string;
  }): Promise<SetSessionStateResult> {
    return this.inTransaction(async (client) => {
      await client.query("SET LOCAL lock_timeout = '5s'");
      const res = await client.query<ReservationDbRow>(
        `SELECT ${RESERVATION_COLS} FROM conversation_reservations
          WHERE plugin_id = $1 AND process_id = $2 AND channel_type = $3 AND conversation_id = $4
            AND holder_kind = 'archetype_process' AND role = 'session'
          ORDER BY (released_at IS NULL) DESC, reserved_at DESC LIMIT 1
          FOR UPDATE`,
        [input.pluginId, input.processId, input.channelType, input.conversationId],
      );
      const current = res.rows[0] ? toReservation(res.rows[0]) : undefined;
      if (!current) {
        return { ok: false, code: 'unknown_scope', message: 'this process never linked that conversation' };
      }
      const from = current.sessionState ?? 'scheduled';
      if (from === input.state) return { ok: true, reservation: current, changed: false };
      if (current.releasedAt) {
        return { ok: false, code: 'session_state', message: `the session conversation was released (${from})` };
      }
      if (!SESSION_CONVERSATION_TRANSITIONS[from].includes(input.state)) {
        return { ok: false, code: 'session_state', message: `a session does not go from '${from}' to '${input.state}'` };
      }
      const ends = input.state === 'closed' || input.state === 'cancelled';
      const updated = await client.query<ReservationDbRow>(
        `UPDATE conversation_reservations
            SET session_state = $2,
                released_at = CASE WHEN $3 THEN now() ELSE released_at END,
                release_reason = CASE WHEN $3 THEN $4 ELSE release_reason END
          WHERE id = $1 RETURNING ${RESERVATION_COLS}`,
        [current.id, input.state, ends, `session_${input.state}: ${input.reason}`.slice(0, 200)],
      );
      return { ok: true, reservation: toReservation(updated.rows[0] as ReservationDbRow), changed: true };
    });
  }
}
