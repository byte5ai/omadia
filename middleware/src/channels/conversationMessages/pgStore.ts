// Postgres store for authenticated inbound conversation messages (#2043,
// migration 0068). Same rules as the in-memory store in `store.ts`; the
// revision is assigned inside the INSERT so two machines storing edits of the
// same message cannot hand out the same number unnoticed.

import { ofLiveAgent } from '@omadia/orchestrator';
import type { Pool } from 'pg';

import type { ConversationMessageKind, ConversationMessageRecord } from '@omadia/plugin-api';

import {
  dedupeKeyFor,
  normalizeChannelKey,
  type ConversationMessageStore,
  type MessageSubscription,
  type NewMessageEvent,
  type NewProcessSubscription,
  type ProcessMessageBinding,
  type SubscriptionMode,
  type PurgeResult,
  type StoredAuthor,
} from './store.js';

interface SubscriptionRow {
  id: string;
  agent_id: string;
  agent_slug: string;
  channel_type: string;
  conversation_id: string;
  channel_key: string;
  plugin_id: string;
  created_at: Date;
  /** Never NULL in a row this store reads: every query asks for a process. */
  process_id: string;
  mode: SubscriptionMode;
  ended_at?: Date | null;
}

interface EventRow {
  event_seq: string;
  message_id: string;
  revision: number;
  kind: ConversationMessageKind;
  author_kind: string;
  author_id: string;
  author_display_name: string | null;
  author_principal_id: string | null;
  tenant_id: string | null;
  body: string | null;
  reply_to_message_id: string | null;
  quoted: boolean;
  forwarded: boolean;
  reaction: { name: string; removed: boolean } | null;
  card_answer: NonNullable<NewMessageEvent['cardAnswer']> | null;
  addressed_to_bot: boolean;
  transcript: NonNullable<NewMessageEvent['transcript']> | null;
  occurred_at: Date;
  received_at: Date;
}

const SUBSCRIPTION_COLUMNS =
  'id, agent_id, agent_slug, channel_type, conversation_id, channel_key, plugin_id, created_at, process_id, mode';

const EVENT_COLUMNS =
  'event_seq, message_id, revision, kind, author_kind, author_id, author_display_name, ' +
  'author_principal_id, tenant_id, body, reply_to_message_id, quoted, forwarded, reaction, ' +
  'card_answer, addressed_to_bot, transcript, occurred_at, received_at';

/** Rows one purge statement removes, and how many statements one tick runs. */
const PURGE_BATCH = 5_000;
const PURGE_MAX_BATCHES = 200;

/** Attempts at a revision another writer took in the same instant. */
const REVISION_RETRIES = 3;

function mapSubscription(row: SubscriptionRow): MessageSubscription {
  return {
    id: row.id,
    agentId: row.agent_id,
    agentSlug: row.agent_slug,
    channelType: row.channel_type,
    conversationId: row.conversation_id,
    channelKey: row.channel_key,
    pluginId: row.plugin_id,
    createdAt: row.created_at,
    mode: row.mode,
    processId: row.process_id,
  };
}

function mapEvent(subscription: MessageSubscription, row: EventRow): ConversationMessageRecord {
  return {
    eventId: String(row.event_seq),
    channelType: subscription.channelType,
    conversationId: subscription.conversationId,
    messageId: row.message_id,
    revision: row.revision,
    kind: row.kind,
    author: {
      kind: row.author_kind,
      id: row.author_id,
      ...(row.author_display_name !== null ? { displayName: row.author_display_name } : {}),
      ...(row.author_principal_id !== null ? { principalId: row.author_principal_id } : {}),
    },
    ...(row.tenant_id !== null ? { tenantId: row.tenant_id } : {}),
    receivedByChannelKey: subscription.channelKey,
    ...(row.body !== null ? { text: row.body } : {}),
    ...(row.reply_to_message_id !== null ? { replyToMessageId: row.reply_to_message_id } : {}),
    ...(row.quoted ? { quoted: true } : {}),
    ...(row.forwarded ? { forwarded: true } : {}),
    ...(row.reaction ? { reaction: row.reaction } : {}),
    ...(row.card_answer ? { cardAnswer: row.card_answer } : {}),
    occurredAt: row.occurred_at.toISOString(),
    receivedAt: row.received_at.toISOString(),
    ...(row.addressed_to_bot ? { addressedToBot: true } : {}),
    ...(row.transcript ? { transcript: row.transcript } : {}),
  };
}

function isRevisionRace(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string } | null;
  return (
    e?.code === '23505' &&
    (e.constraint === 'conversation_message_events_revision_uq' ||
      e.constraint === 'conversation_message_events_transcript_revision_uq')
  );
}

export class PgConversationMessageStore implements ConversationMessageStore {
  constructor(private readonly pool: Pool) {}

  async listActiveSubscriptions(): Promise<readonly MessageSubscription[]> {
    const { rows } = await this.pool.query<SubscriptionRow>(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM conversation_message_subscriptions
        WHERE ended_at IS NULL AND process_id IS NOT NULL AND ${ofLiveAgent('agent_id')} ORDER BY created_at`,
    );
    return rows.map(mapSubscription);
  }

  async createProcessSubscription(
    input: NewProcessSubscription,
  ): Promise<{ subscription: MessageSubscription; existed: boolean; ended: boolean }> {
    const channelKey = normalizeChannelKey(input.channelKey);
    const inserted = await this.pool.query<SubscriptionRow>(
      `INSERT INTO conversation_message_subscriptions
         (agent_id, agent_slug, channel_type, conversation_id, channel_key, plugin_id, process_id, mode)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (channel_type, conversation_id, channel_key, plugin_id, process_id) WHERE process_id IS NOT NULL
       DO NOTHING
       RETURNING ${SUBSCRIPTION_COLUMNS}`,
      [input.agentId, input.agentSlug, input.channelType, input.conversationId, channelKey, input.pluginId, input.processId, input.mode],
    );
    if (inserted.rows[0]) return { subscription: mapSubscription(inserted.rows[0]), existed: false, ended: false };
    const existing = await this.pool.query<SubscriptionRow>(
      `SELECT ${SUBSCRIPTION_COLUMNS}, ended_at FROM conversation_message_subscriptions
        WHERE channel_type = $1 AND conversation_id = $2 AND channel_key = $3 AND plugin_id = $4 AND process_id = $5`,
      [input.channelType, input.conversationId, channelKey, input.pluginId, input.processId],
    );
    const row = existing.rows[0];
    if (!row) throw new Error('conversation message subscription vanished between insert and read');
    return { subscription: mapSubscription(row), existed: true, ended: row.ended_at != null };
  }

  async setSubscriptionMode(subscriptionId: string, mode: SubscriptionMode): Promise<MessageSubscription | undefined> {
    const { rows } = await this.pool.query<SubscriptionRow>(
      `UPDATE conversation_message_subscriptions SET mode = $2
        WHERE id = $1 AND ended_at IS NULL AND process_id IS NOT NULL
        RETURNING ${SUBSCRIPTION_COLUMNS}`,
      [subscriptionId, mode],
    );
    return rows[0] ? mapSubscription(rows[0]) : undefined;
  }

  async bindProcessMessage(input: {
    channelType: string;
    conversationId: string;
    ref: string;
    agentId: string;
    pluginId: string;
    processId: string;
  }): Promise<boolean> {
    // The first binding stands; binding the same ref to the same process
    // again is fine.
    const { rows } = await this.pool.query<{ plugin_id: string; process_id: string }>(
      `INSERT INTO conversation_process_messages (channel_type, conversation_id, ref, agent_id, plugin_id, process_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (channel_type, conversation_id, ref) DO UPDATE SET bound_at = conversation_process_messages.bound_at
       RETURNING plugin_id, process_id`,
      [input.channelType, input.conversationId, input.ref, input.agentId, input.pluginId, input.processId],
    );
    return rows[0]?.plugin_id === input.pluginId && rows[0]?.process_id === input.processId;
  }

  async findProcessBindings(
    channelType: string,
    conversationId: string,
    refs: readonly string[],
  ): Promise<readonly ProcessMessageBinding[]> {
    if (refs.length === 0) return [];
    const { rows } = await this.pool.query<{ ref: string; plugin_id: string; process_id: string }>(
      `SELECT ref, plugin_id, process_id FROM conversation_process_messages
        WHERE channel_type = $1 AND conversation_id = $2 AND ref = ANY($3::text[])`,
      [channelType, conversationId, [...refs]],
    );
    return rows.map((r) => ({ ref: r.ref, pluginId: r.plugin_id, processId: r.process_id }));
  }

  async endSubscription(subscriptionId: string): Promise<void> {
    await this.pool.query(
      `UPDATE conversation_message_subscriptions SET ended_at = now()
        WHERE id = $1 AND ended_at IS NULL`,
      [subscriptionId],
    );
  }

  async insertEvent(
    subscription: MessageSubscription,
    event: NewMessageEvent,
  ): Promise<ConversationMessageRecord | undefined> {
    const params = [
      subscription.id,
      event.messageId,
      event.kind,
      Number.isInteger(event.adapterRevision) ? event.adapterRevision : null,
      dedupeKeyFor(event),
      event.author.kind,
      event.author.id,
      event.author.displayName ?? null,
      event.author.principalId ?? null,
      event.tenantId ?? null,
      event.kind === 'deleted' ? null : (event.text ?? null),
      event.replyToMessageId ?? null,
      event.quoted === true,
      event.forwarded === true,
      event.reaction ? JSON.stringify(event.reaction) : null,
      event.cardAnswer ? JSON.stringify(event.cardAnswer) : null,
      event.occurredAt,
      event.addressedToBot === true,
      event.transcript ? JSON.stringify(event.transcript) : null,
    ];
    // The revision rule of `assignRevision` (store.ts), in SQL.
    const sql = `
      WITH latest AS (
        SELECT MAX(revision) AS revision FROM conversation_message_events
         WHERE subscription_id = $1 AND message_id = $2
           -- #2089: a transcript segment counts its revisions apart.
           AND CASE WHEN $3 = 'transcript_segment' THEN kind = 'transcript_segment'
                    ELSE kind IN ('created', 'edited', 'deleted') END
      )
      INSERT INTO conversation_message_events
        (subscription_id, message_id, kind, adapter_revision, dedupe_key, author_kind, author_id,
         author_display_name, author_principal_id, tenant_id, body, reply_to_message_id, quoted,
         forwarded, reaction, card_answer, occurred_at, addressed_to_bot, transcript, revision)
      SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16::jsonb,
             $17::timestamptz, $18::boolean, $19::jsonb,
             CASE
               WHEN $3 = 'created' THEN 0
               WHEN $3 = 'transcript_segment' THEN COALESCE(latest.revision + 1, 0)
               WHEN $3 = 'edited' THEN GREATEST(1, COALESCE(latest.revision + 1, 1), COALESCE($4::int, 0))
               WHEN $3 = 'deleted' THEN GREATEST(1, COALESCE(latest.revision + 1, 1))
               ELSE COALESCE(latest.revision, 0)
             END
        FROM latest
      ON CONFLICT (subscription_id, dedupe_key) DO NOTHING
      RETURNING ${EVENT_COLUMNS}`;
    for (let attempt = 1; ; attempt += 1) {
      try {
        const { rows } = await this.pool.query<EventRow>(sql, params);
        return rows[0] ? mapEvent(subscription, rows[0]) : undefined;
      } catch (err) {
        // A second original of the same message is a redelivery under another
        // dedupe key (it cannot happen for `created`, whose key is the message
        // id alone); a clash on an edit is a concurrent writer: read again.
        if (!isRevisionRace(err) || attempt >= REVISION_RETRIES) throw err;
      }
    }
  }

  async getEvent(
    subscription: MessageSubscription,
    messageId: string,
    revision?: number,
  ): Promise<ConversationMessageRecord | undefined> {
    const { rows } = await this.pool.query<EventRow>(
      `SELECT ${EVENT_COLUMNS} FROM conversation_message_events
        WHERE subscription_id = $1 AND message_id = $2
          AND kind IN ('created', 'edited', 'deleted')
          AND ($3::int IS NULL OR revision = $3::int)
        ORDER BY revision DESC LIMIT 1`,
      [subscription.id, messageId, revision ?? null],
    );
    return rows[0] ? mapEvent(subscription, rows[0]) : undefined;
  }

  async getEventById(
    subscription: MessageSubscription,
    eventId: string,
  ): Promise<ConversationMessageRecord | undefined> {
    if (!/^\d{1,18}$/.test(eventId)) return undefined;
    const { rows } = await this.pool.query<EventRow>(
      `SELECT ${EVENT_COLUMNS} FROM conversation_message_events
        WHERE subscription_id = $1 AND event_seq = $2::bigint`,
      [subscription.id, eventId],
    );
    return rows[0] ? mapEvent(subscription, rows[0]) : undefined;
  }

  async latestRevisions(
    subscription: MessageSubscription,
    messageIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>> {
    const latest = new Map<string, number>();
    if (messageIds.length === 0) return latest;
    const { rows } = await this.pool.query<{ message_id: string; family: string; revision: number }>(
      `SELECT message_id,
              CASE WHEN kind = 'transcript_segment' THEN 'transcript' ELSE 'message' END AS family,
              MAX(revision) AS revision
         FROM conversation_message_events
        WHERE subscription_id = $1 AND message_id = ANY($2::text[])
          AND kind IN ('created', 'edited', 'deleted', 'transcript_segment')
        GROUP BY 1, 2`,
      [subscription.id, [...new Set(messageIds)]],
    );
    for (const row of rows) latest.set(`${row.family}\u0000${row.message_id}`, Number(row.revision));
    return latest;
  }

  async listSince(
    subscription: MessageSubscription,
    after: string | undefined,
    limit: number,
  ): Promise<readonly ConversationMessageRecord[]> {
    const cursor = after !== undefined && /^\d{1,18}$/.test(after) ? after : '0';
    const { rows } = await this.pool.query<EventRow>(
      `SELECT ${EVENT_COLUMNS} FROM conversation_message_events
        WHERE subscription_id = $1 AND event_seq > $2::bigint
        ORDER BY event_seq LIMIT $3`,
      [subscription.id, cursor, limit],
    );
    return rows.map((row) => mapEvent(subscription, row));
  }

  async findAuthor(
    subscription: MessageSubscription,
    userIdLowerCase: string,
  ): Promise<StoredAuthor | undefined> {
    const { rows } = await this.pool.query<{
      author_kind: string;
      author_id: string;
      author_display_name: string | null;
    }>(
      `SELECT author_kind, author_id, author_display_name FROM conversation_message_events
        WHERE subscription_id = $1 AND lower(author_id) = $2
        ORDER BY event_seq DESC LIMIT 1`,
      [subscription.id, userIdLowerCase],
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      kind: row.author_kind,
      id: row.author_id,
      ...(row.author_display_name !== null ? { displayName: row.author_display_name } : {}),
    };
  }

  /**
   * Batched: a subscription that ran for weeks can hold a great many events,
   * and one DELETE over all of them would hold its locks (and bloat the WAL)
   * for the whole run. Each statement removes at most `PURGE_BATCH` rows; a
   * tick stops after `PURGE_MAX_BATCHES` and the next tick continues, so the
   * job stays bounded whatever it finds.
   */
  async purge(cutoffs: { endedBefore: Date; receivedBefore?: Date }): Promise<PurgeResult> {
    let events = 0;
    let batches = 0;
    const drain = async (where: string, param: Date): Promise<boolean> => {
      for (; batches < PURGE_MAX_BATCHES; batches += 1) {
        const res = await this.pool.query(
          `DELETE FROM conversation_message_events
            WHERE event_seq IN (
              SELECT e.event_seq FROM conversation_message_events e
               WHERE ${where}
               ORDER BY e.event_seq
               LIMIT ${String(PURGE_BATCH)}
            )`,
          [param],
        );
        const removed = res.rowCount ?? 0;
        events += removed;
        if (removed < PURGE_BATCH) return true;
      }
      return false; // budget spent; the next tick goes on
    };

    const endedDrained = await drain(
      `e.subscription_id IN (
         SELECT id FROM conversation_message_subscriptions
          WHERE ended_at IS NOT NULL AND ended_at < $1
       )`,
      cutoffs.endedBefore,
    );
    let subscriptions = 0;
    if (endedDrained) {
      // Only rows whose events are gone: the row is what the next tick finds
      // the remaining events by.
      const removed = await this.pool.query(
        `DELETE FROM conversation_message_subscriptions s
          WHERE s.ended_at IS NOT NULL AND s.ended_at < $1
            AND NOT EXISTS (
              SELECT 1 FROM conversation_message_events e WHERE e.subscription_id = s.id
            )`,
        [cutoffs.endedBefore],
      );
      subscriptions = removed.rowCount ?? 0;
    }
    // #2089 — the maximum age does not apply to a subscription that is still
    // active: its process's scopes bound it, and nothing of a running process
    // is deleted early. (A row without a process is the form migration 0080
    // ended; its events go by age like those of any ended subscription.)
    if (cutoffs.receivedBefore) {
      await drain(
        `e.received_at < $1 AND NOT EXISTS (
           SELECT 1 FROM conversation_message_subscriptions s
            WHERE s.id = e.subscription_id AND s.process_id IS NOT NULL AND s.ended_at IS NULL)`,
        cutoffs.receivedBefore,
      );
    }
    return { events, subscriptions };
  }
}
