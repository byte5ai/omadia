// Postgres store for authenticated inbound conversation messages (#2043,
// migration 0068). Same rules as the in-memory store in `store.ts`; the
// revision is assigned inside the INSERT so two machines storing edits of the
// same message cannot hand out the same number unnoticed.

import type { Pool } from 'pg';

import type { ConversationMessageKind, ConversationMessageRecord } from '@omadia/plugin-api';

import {
  dedupeKeyFor,
  normalizeChannelKey,
  type ConversationMessageStore,
  type MessageSubscription,
  type NewMessageEvent,
  type NewSubscription,
  type PurgeResult,
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
  card_answer: { cardId: string; value: unknown } | null;
  occurred_at: Date;
  received_at: Date;
}

const SUBSCRIPTION_COLUMNS =
  'id, agent_id, agent_slug, channel_type, conversation_id, channel_key, plugin_id, created_at';

const EVENT_COLUMNS =
  'event_seq, message_id, revision, kind, author_kind, author_id, author_display_name, ' +
  'author_principal_id, tenant_id, body, reply_to_message_id, quoted, forwarded, reaction, ' +
  'card_answer, occurred_at, received_at';

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
  };
}

function isRevisionRace(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string } | null;
  return e?.code === '23505' && e.constraint === 'conversation_message_events_revision_uq';
}

export class PgConversationMessageStore implements ConversationMessageStore {
  constructor(private readonly pool: Pool) {}

  async listActiveSubscriptions(): Promise<readonly MessageSubscription[]> {
    const { rows } = await this.pool.query<SubscriptionRow>(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM conversation_message_subscriptions
        WHERE ended_at IS NULL ORDER BY created_at`,
    );
    return rows.map(mapSubscription);
  }

  async createSubscription(input: NewSubscription): Promise<MessageSubscription> {
    const channelKey = normalizeChannelKey(input.channelKey);
    const inserted = await this.pool.query<SubscriptionRow>(
      `INSERT INTO conversation_message_subscriptions
         (agent_id, agent_slug, channel_type, conversation_id, channel_key, plugin_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (channel_type, conversation_id, channel_key) WHERE ended_at IS NULL
       DO NOTHING
       RETURNING ${SUBSCRIPTION_COLUMNS}`,
      [input.agentId, input.agentSlug, input.channelType, input.conversationId, channelKey, input.pluginId],
    );
    if (inserted.rows[0]) return mapSubscription(inserted.rows[0]);
    const existing = await this.pool.query<SubscriptionRow>(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM conversation_message_subscriptions
        WHERE channel_type = $1 AND conversation_id = $2 AND channel_key = $3 AND ended_at IS NULL`,
      [input.channelType, input.conversationId, channelKey],
    );
    const row = existing.rows[0];
    if (!row) throw new Error('conversation message subscription vanished between insert and read');
    return mapSubscription(row);
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
    ];
    // The revision rule of `assignRevision` (store.ts), in SQL.
    const sql = `
      WITH latest AS (
        SELECT MAX(revision) AS revision FROM conversation_message_events
         WHERE subscription_id = $1 AND message_id = $2
           AND kind IN ('created', 'edited', 'deleted')
      )
      INSERT INTO conversation_message_events
        (subscription_id, message_id, kind, adapter_revision, dedupe_key, author_kind, author_id,
         author_display_name, author_principal_id, tenant_id, body, reply_to_message_id, quoted,
         forwarded, reaction, card_answer, occurred_at, revision)
      SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16::jsonb,
             $17::timestamptz,
             CASE
               WHEN $3 = 'created' THEN 0
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

  async purge(cutoffs: { endedBefore: Date; receivedBefore?: Date }): Promise<PurgeResult> {
    const ended = await this.pool.query<{ events: string; subscriptions: string }>(
      `WITH dead AS (
         SELECT id FROM conversation_message_subscriptions
          WHERE ended_at IS NOT NULL AND ended_at < $1
       ), counted AS (
         SELECT COUNT(*) AS n FROM conversation_message_events
          WHERE subscription_id IN (SELECT id FROM dead)
       ), removed AS (
         DELETE FROM conversation_message_subscriptions
          WHERE id IN (SELECT id FROM dead) RETURNING id
       )
       SELECT (SELECT n FROM counted) AS events, (SELECT COUNT(*) FROM removed) AS subscriptions`,
      [cutoffs.endedBefore],
    );
    let aged = 0;
    if (cutoffs.receivedBefore) {
      const res = await this.pool.query(
        'DELETE FROM conversation_message_events WHERE received_at < $1',
        [cutoffs.receivedBefore],
      );
      aged = res.rowCount ?? 0;
    }
    return {
      events: Number(ended.rows[0]?.events ?? 0) + aged,
      subscriptions: Number(ended.rows[0]?.subscriptions ?? 0),
    };
  }
}
