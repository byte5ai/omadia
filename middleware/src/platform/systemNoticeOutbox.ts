// System notices owed outside a turn (spec 2042 §5.10, INV-7, criterion 37).
//
// When an agent goes out of service — disabled, deleted, or its archetype
// plugin removed — each affected home conversation gets ONE registered
// `system` notice. This is the #2045 seam the end-of-service procedure calls
// (`agentEndOfService.ts`), made real:
//
//   - THE NOTICE IS WRITTEN FIRST (`system_notice_outbox`, migration 0126),
//     with its rendered, localized text. A restart before it went out still
//     delivers it: the worker drains pending rows at boot.
//   - ONCE PER END OF SERVICE. The procedure runs again only when a crash
//     interrupted the change it guards (the agent is still enabled, the
//     plugin still installed) and the operator repeats it; that repeat owes
//     nothing new. A notice already owed for the same agent, kind and
//     conversation within the dedupe window is not written again. A genuine
//     second end of service inside the window finds the first notice still
//     standing in the conversation.
//   - SENT ONCE. A row is claimed under a lease and marked sent by the worker
//     that still holds that lease; a sent row is never sent again. A crash
//     between the platform's accept and the mark can repeat it after the
//     lease (channels give no exactly-once delivery); a lease that runs out
//     spends an attempt, so a send that never returns ends `failed`.
//   - A CHANNEL THAT IS NOT UP YET (boot, a plugin that starts late) defers
//     the notice without spending an attempt.
//   - SPEAKER `system`, through the channel's shared bot: never as the agent's
//     own identity, which is exactly what went away.
//
// Never throws into the caller: a notice that cannot be written is logged,
// one that cannot be sent is retried with backoff and then left `failed` for
// the operator.

import { buildSystemNotice, type SystemNoticeRequest } from '@omadia/orchestrator';
import { SYSTEM_SPEAKER, type Speaker } from '@omadia/plugin-api';
import type { Pool } from 'pg';

export type NoticeSendOutcome =
  | { readonly delivered: true }
  /** `deferred`: nobody could take it yet (the channel is not up): retried
   *  later without spending an attempt. */
  | { readonly delivered: false; readonly reason: string; readonly deferred?: boolean };

export interface SystemNoticeOutboxDeps {
  /** Absent = no database: a notice is logged as owed, nothing is sent. */
  readonly pool: () => Pool | undefined;
  /** Post `message` into a conversation through the channel's shared bot. */
  readonly send: (
    channelType: string,
    conversationId: string,
    message: { readonly text: string; readonly speaker: Speaker },
  ) => Promise<NoticeSendOutcome>;
  /** The instance's language for notices (`de`, `en`, …). */
  readonly locale: () => string | undefined;
  readonly dedupeWindowMs?: number;
  readonly maxAttempts?: number;
  readonly leaseMs?: number;
  readonly log?: (message: string) => void;
}

export interface SystemNoticeOutbox {
  /** Write the notice (once) and start sending what is due. Never throws. */
  emit(notice: SystemNoticeRequest): Promise<void>;
  /** Send every due notice; returns how many went out. Never throws. */
  drain(): Promise<number>;
  /** Drain now and every `intervalMs`. */
  start(intervalMs: number): void;
  stop(): void;
}

export const DEFAULT_NOTICE_DEDUPE_WINDOW_MS = 24 * 3_600_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_LEASE_MS = 120_000;
const RETRY_STEP_MS = 60_000;
const DRAIN_BATCH = 20;

interface DueRow {
  id: string;
  /** The lease this worker holds; a settle under another lease changes nothing. */
  lease: string;
  channel_type: string;
  conversation_id: string;
  text: string;
  attempts: number;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function createSystemNoticeOutbox(deps: SystemNoticeOutboxDeps): SystemNoticeOutbox {
  const log = deps.log ?? (() => undefined);
  const windowMs = deps.dedupeWindowMs ?? DEFAULT_NOTICE_DEDUPE_WINDOW_MS;
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
  let timer: ReturnType<typeof setInterval> | undefined;
  let draining: Promise<number> | undefined;

  async function write(pool: Pool, notice: SystemNoticeRequest): Promise<boolean> {
    const rendered = buildSystemNotice(notice.kind, {
      agent: { slug: notice.agentSlug ?? notice.agentId, displayName: notice.agentName, agentId: notice.agentId },
      ...(deps.locale() ? { locale: deps.locale() } : {}),
    });
    const key = [notice.kind, notice.agentId, notice.channelType, notice.channelKey].join('\n');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Two machines ending the same agent write one row (pooled Postgres:
      // a transaction-scoped lock only).
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
      const owed = await client.query(
        `SELECT 1 FROM system_notice_outbox
          WHERE agent_id = $1 AND code = $2 AND channel_type = $3 AND conversation_id = $4
            AND created_at > now() - ($5::double precision * interval '1 millisecond')`,
        [notice.agentId, notice.kind, notice.channelType, notice.channelKey, windowMs],
      );
      if ((owed.rowCount ?? 0) > 0) {
        await client.query('COMMIT');
        return false;
      }
      await client.query(
        `INSERT INTO system_notice_outbox (code, agent_id, channel_type, conversation_id, process_id, text, locale)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [notice.kind, notice.agentId, notice.channelType, notice.channelKey, notice.processId ?? null, rendered.text, rendered.locale],
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

  async function claim(pool: Pool): Promise<DueRow[]> {
    // A lease that ran out was an attempt without an outcome; the last one
    // allowed ends the row.
    await pool.query(
      `UPDATE system_notice_outbox
          SET state = 'failed', attempts = attempts + 1, lease_until = NULL, last_error = 'no outcome within the lease'
        WHERE state = 'sending' AND lease_until < now() AND attempts + 1 >= $1`,
      [maxAttempts],
    );
    const { rows } = await pool.query<DueRow>(
      `UPDATE system_notice_outbox o
          SET attempts = o.attempts + CASE WHEN o.state = 'sending' THEN 1 ELSE 0 END,
              state = 'sending', lease_until = clock_timestamp() + ($1::double precision * interval '1 millisecond')
        WHERE o.id IN (
          SELECT id FROM system_notice_outbox
           WHERE (state = 'pending' AND next_attempt_at <= now()) OR (state = 'sending' AND lease_until < now())
           ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED)
        RETURNING o.id::text, o.lease_until::text AS lease, o.channel_type, o.conversation_id, o.text, o.attempts`,
      [leaseMs, DRAIN_BATCH],
    );
    return rows;
  }

  async function settle(pool: Pool, row: DueRow, outcome: NoticeSendOutcome): Promise<void> {
    const held = `id = $1 AND state = 'sending' AND lease_until = $2::timestamptz`;
    if (outcome.delivered) {
      await pool.query(`UPDATE system_notice_outbox SET state = 'sent', sent_at = now(), lease_until = NULL WHERE ${held}`, [row.id, row.lease]);
      return;
    }
    if (outcome.deferred === true) {
      await pool.query(
        `UPDATE system_notice_outbox SET state = 'pending', lease_until = NULL, last_error = $3,
                next_attempt_at = now() + ($4::double precision * interval '1 millisecond') WHERE ${held}`,
        [row.id, row.lease, outcome.reason.slice(0, 500), RETRY_STEP_MS],
      );
      return;
    }
    const attempts = row.attempts + 1;
    const final = attempts >= maxAttempts;
    await pool.query(
      `UPDATE system_notice_outbox
          SET state = $3, attempts = $4, last_error = $5, lease_until = NULL,
              next_attempt_at = now() + ($6::double precision * interval '1 millisecond')
        WHERE ${held}`,
      [row.id, row.lease, final ? 'failed' : 'pending', attempts, outcome.reason.slice(0, 500), attempts * RETRY_STEP_MS],
    );
    log(
      `[system-notice] ${row.channel_type}/${row.conversation_id} not delivered (${outcome.reason})${final ? `; given up after ${String(attempts)} attempts` : '; will retry'}`,
    );
  }

  async function drainOnce(): Promise<number> {
    const pool = deps.pool();
    if (!pool) return 0;
    let sent = 0;
    try {
      for (let rows = await claim(pool); rows.length > 0; rows = await claim(pool)) {
        for (const row of rows) {
          let outcome: NoticeSendOutcome;
          try {
            outcome = await deps.send(row.channel_type, row.conversation_id, { text: row.text, speaker: SYSTEM_SPEAKER });
          } catch (err) {
            outcome = { delivered: false, reason: message(err) };
          }
          await settle(pool, row, outcome);
          if (outcome.delivered) sent += 1;
        }
      }
    } catch (err) {
      log(`[system-notice] draining the outbox failed: ${message(err)}`);
    }
    return sent;
  }

  const drain = (): Promise<number> => {
    // One drain at a time per process; the lease keeps machines apart.
    draining ??= drainOnce().finally(() => {
      draining = undefined;
    });
    return draining;
  };

  return {
    async emit(notice) {
      const pool = deps.pool();
      if (!pool) {
        log(`[system-notice] owed, no database to keep it: ${notice.kind} for '${notice.agentName}' in ${notice.channelType}/${notice.channelKey}`);
        return;
      }
      try {
        const written = await write(pool, notice);
        if (!written) log(`[system-notice] already owed: ${notice.kind} for '${notice.agentName}' in ${notice.channelType}/${notice.channelKey}`);
      } catch (err) {
        log(`[system-notice] could not record ${notice.kind} for '${notice.agentName}' in ${notice.channelType}/${notice.channelKey}: ${message(err)}`);
        return;
      }
      // Kept before the change it announces; sent without holding it up.
      void drain();
    },
    drain,
    start(intervalMs) {
      void drain();
      timer = setInterval(() => void drain(), intervalMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
