// Storage for authenticated inbound conversation messages (#2043,
// 'conversationMessages@1'): the store contract, the pure rules both
// implementations share, and an in-memory implementation.
//
// The Postgres implementation (`pgStore.ts`, migration 0068) is what a
// deployment runs: subscriptions and events survive a restart, which is the
// point of the replay cursor. The in-memory one backs unit tests and the
// simulated-channel contract suite; it is NOT wired on an install without a
// database, because a record that vanishes on restart is not a record.

import { createHash, randomUUID } from 'node:crypto';

import type { ConversationMessageKind, ConversationMessageRecord } from '@omadia/plugin-api';

/** Kinds that are a revision of the message itself. Reactions and card
 *  answers refer to a message; they do not change it. */
export const REVISION_KINDS: readonly ConversationMessageKind[] = ['created', 'edited', 'deleted'];

export function isRevisionKind(kind: ConversationMessageKind): boolean {
  return REVISION_KINDS.includes(kind);
}

/** Identity keys are compared lower-cased on both sides (Teams adapters ask
 *  with `28:<appid lowercase>` on the hot path). */
export function normalizeChannelKey(channelKey: string): string {
  return channelKey.trim().toLowerCase();
}

export interface MessageSubscription {
  readonly id: string;
  readonly agentId: string;
  readonly agentSlug: string;
  readonly channelType: string;
  readonly conversationId: string;
  /** Lower-cased. */
  readonly channelKey: string;
  /** The engine plugin that subscribed. */
  readonly pluginId: string;
  readonly createdAt: Date;
}

export interface NewSubscription {
  readonly agentId: string;
  readonly agentSlug: string;
  readonly channelType: string;
  readonly conversationId: string;
  readonly channelKey: string;
  readonly pluginId: string;
}

export interface NewMessageEvent {
  readonly messageId: string;
  /** What the adapter reported; a hint, never the stored revision. */
  readonly adapterRevision?: number;
  readonly kind: ConversationMessageKind;
  readonly author: {
    readonly kind: string;
    readonly id: string;
    readonly displayName?: string;
    readonly principalId?: string;
  };
  readonly tenantId?: string;
  readonly text?: string;
  readonly replyToMessageId?: string;
  readonly quoted?: boolean;
  readonly forwarded?: boolean;
  readonly reaction?: { readonly name: string; readonly removed: boolean };
  readonly cardAnswer?: {
    readonly cardId: string;
    readonly value: unknown;
    readonly answererVerified?: boolean;
  };
  /** ISO 8601, platform time. */
  readonly occurredAt: string;
}

export interface StoredAuthor {
  readonly kind: string;
  /** As the platform stated it (original case). */
  readonly id: string;
  readonly displayName?: string;
}

export interface PurgeResult {
  readonly events: number;
  readonly subscriptions: number;
}

export interface ConversationMessageStore {
  listActiveSubscriptions(): Promise<readonly MessageSubscription[]>;
  /** Idempotent: an active subscription for the same (type, conversation,
   *  identity) is returned as it is. */
  createSubscription(input: NewSubscription): Promise<MessageSubscription>;
  endSubscription(subscriptionId: string): Promise<void>;
  /** Stores the event with a kernel-assigned revision. `undefined` when the
   *  same platform event was already stored (redelivery). */
  insertEvent(
    subscription: MessageSubscription,
    event: NewMessageEvent,
  ): Promise<ConversationMessageRecord | undefined>;
  /** The record of a message: latest revision unless one is named. */
  getEvent(
    subscription: MessageSubscription,
    messageId: string,
    revision?: number,
  ): Promise<ConversationMessageRecord | undefined>;
  getEventById(
    subscription: MessageSubscription,
    eventId: string,
  ): Promise<ConversationMessageRecord | undefined>;
  /** Events after the cursor in storage order, at most `limit`. */
  listSince(
    subscription: MessageSubscription,
    after: string | undefined,
    limit: number,
  ): Promise<readonly ConversationMessageRecord[]>;
  /** The channel user who wrote in this subscription, matched on the
   *  lower-cased id; the most recent record wins. */
  findAuthor(
    subscription: MessageSubscription,
    userIdLowerCase: string,
  ): Promise<StoredAuthor | undefined>;
  /** Remove events (and the rows) of subscriptions that ended before
   *  `endedBefore`, and any event received before `receivedBefore`. */
  purge(cutoffs: { endedBefore: Date; receivedBefore?: Date }): Promise<PurgeResult>;
}

/**
 * What makes two deliveries the same platform event. Hashed so a long text
 * or card payload cannot bloat the unique index.
 */
export function dedupeKeyFor(event: NewMessageEvent): string {
  const parts: unknown[] = [event.kind, event.messageId];
  switch (event.kind) {
    case 'created':
      break; // one original per message, whenever it is redelivered
    case 'edited':
      parts.push(event.occurredAt, event.text ?? '');
      break;
    case 'deleted':
      parts.push(event.occurredAt);
      break;
    case 'reaction':
      parts.push(event.author.id, event.reaction?.name ?? '', event.reaction?.removed === true, event.occurredAt);
      break;
    case 'card_answer':
      parts.push(event.author.id, event.occurredAt, event.cardAnswer ?? null);
      break;
  }
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/**
 * The revision the kernel assigns. `latest` is the highest stored revision of
 * the message (among created/edited/deleted), or `undefined` when the kernel
 * holds none.
 *
 * - `created` is always 0.
 * - an edit or deletion is one above the latest, never below 1 (an edit of a
 *   message the kernel never stored is still not "the original"), and never
 *   below the adapter's own count when the adapter is ahead.
 * - a reaction or card answer carries the revision it refers to.
 */
export function assignRevision(
  kind: ConversationMessageKind,
  latest: number | undefined,
  adapterRevision: number | undefined,
): number {
  if (kind === 'created') return 0;
  if (kind === 'edited' || kind === 'deleted') {
    const next = latest === undefined ? 1 : latest + 1;
    const hint = kind === 'edited' && Number.isInteger(adapterRevision) ? adapterRevision! : 0;
    return Math.max(1, next, hint);
  }
  return latest ?? 0;
}

export function toRecord(
  subscription: MessageSubscription,
  eventId: string,
  revision: number,
  event: NewMessageEvent,
  receivedAt: Date,
): ConversationMessageRecord {
  return {
    eventId,
    channelType: subscription.channelType,
    conversationId: subscription.conversationId,
    messageId: event.messageId,
    revision,
    kind: event.kind,
    author: {
      kind: event.author.kind,
      id: event.author.id,
      ...(event.author.displayName !== undefined ? { displayName: event.author.displayName } : {}),
      ...(event.author.principalId !== undefined ? { principalId: event.author.principalId } : {}),
    },
    ...(event.tenantId !== undefined ? { tenantId: event.tenantId } : {}),
    receivedByChannelKey: subscription.channelKey,
    ...(event.text !== undefined && event.kind !== 'deleted' ? { text: event.text } : {}),
    ...(event.replyToMessageId !== undefined ? { replyToMessageId: event.replyToMessageId } : {}),
    ...(event.quoted ? { quoted: true } : {}),
    ...(event.forwarded ? { forwarded: true } : {}),
    ...(event.reaction ? { reaction: { name: event.reaction.name, removed: event.reaction.removed } } : {}),
    ...(event.cardAnswer
      ? {
          cardAnswer: {
            cardId: event.cardAnswer.cardId,
            value: event.cardAnswer.value,
            ...(event.cardAnswer.answererVerified !== undefined
              ? { answererVerified: event.cardAnswer.answererVerified }
              : {}),
          },
        }
      : {}),
    occurredAt: event.occurredAt,
    receivedAt: receivedAt.toISOString(),
  };
}

interface MemoryEvent {
  readonly seq: number;
  readonly subscriptionId: string;
  readonly dedupeKey: string;
  readonly record: ConversationMessageRecord;
  readonly receivedAt: Date;
}

/** In-memory implementation with the same rules as the Postgres one. */
export class InMemoryConversationMessageStore implements ConversationMessageStore {
  private subscriptions: (MessageSubscription & { endedAt?: Date })[] = [];
  private events: MemoryEvent[] = [];
  private seq = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  listActiveSubscriptions(): Promise<readonly MessageSubscription[]> {
    return Promise.resolve(this.subscriptions.filter((s) => s.endedAt === undefined));
  }

  createSubscription(input: NewSubscription): Promise<MessageSubscription> {
    const channelKey = normalizeChannelKey(input.channelKey);
    const existing = this.subscriptions.find(
      (s) =>
        s.endedAt === undefined &&
        s.channelType === input.channelType &&
        s.conversationId === input.conversationId &&
        s.channelKey === channelKey,
    );
    if (existing) return Promise.resolve(existing);
    const created: MessageSubscription = { ...input, channelKey, id: randomUUID(), createdAt: this.now() };
    this.subscriptions = [...this.subscriptions, created];
    return Promise.resolve(created);
  }

  endSubscription(subscriptionId: string): Promise<void> {
    this.subscriptions = this.subscriptions.map((s) =>
      s.id === subscriptionId && s.endedAt === undefined ? { ...s, endedAt: this.now() } : s,
    );
    return Promise.resolve();
  }

  insertEvent(
    subscription: MessageSubscription,
    event: NewMessageEvent,
  ): Promise<ConversationMessageRecord | undefined> {
    const dedupeKey = dedupeKeyFor(event);
    const own = this.events.filter((e) => e.subscriptionId === subscription.id);
    if (own.some((e) => e.dedupeKey === dedupeKey)) return Promise.resolve(undefined);
    const revisions = own
      .filter((e) => e.record.messageId === event.messageId && isRevisionKind(e.record.kind))
      .map((e) => e.record.revision);
    const latest = revisions.length > 0 ? Math.max(...revisions) : undefined;
    const revision = assignRevision(event.kind, latest, event.adapterRevision);
    this.seq += 1;
    const receivedAt = this.now();
    const record = toRecord(subscription, String(this.seq), revision, event, receivedAt);
    this.events = [...this.events, { seq: this.seq, subscriptionId: subscription.id, dedupeKey, record, receivedAt }];
    return Promise.resolve(record);
  }

  getEvent(
    subscription: MessageSubscription,
    messageId: string,
    revision?: number,
  ): Promise<ConversationMessageRecord | undefined> {
    const candidates = this.events
      .filter(
        (e) =>
          e.subscriptionId === subscription.id &&
          e.record.messageId === messageId &&
          isRevisionKind(e.record.kind) &&
          (revision === undefined || e.record.revision === revision),
      )
      .sort((a, b) => b.record.revision - a.record.revision);
    return Promise.resolve(candidates[0]?.record);
  }

  getEventById(
    subscription: MessageSubscription,
    eventId: string,
  ): Promise<ConversationMessageRecord | undefined> {
    return Promise.resolve(
      this.events.find((e) => e.subscriptionId === subscription.id && e.record.eventId === eventId)?.record,
    );
  }

  listSince(
    subscription: MessageSubscription,
    after: string | undefined,
    limit: number,
  ): Promise<readonly ConversationMessageRecord[]> {
    const cursor = after === undefined ? 0 : Number(after);
    return Promise.resolve(
      this.events
        .filter((e) => e.subscriptionId === subscription.id && e.seq > cursor)
        .slice(0, limit)
        .map((e) => e.record),
    );
  }

  findAuthor(subscription: MessageSubscription, userIdLowerCase: string): Promise<StoredAuthor | undefined> {
    const match = [...this.events]
      .reverse()
      .find(
        (e) => e.subscriptionId === subscription.id && e.record.author.id.toLowerCase() === userIdLowerCase,
      );
    if (!match) return Promise.resolve(undefined);
    const { kind, id, displayName } = match.record.author;
    return Promise.resolve({ kind, id, ...(displayName !== undefined ? { displayName } : {}) });
  }

  purge(cutoffs: { endedBefore: Date; receivedBefore?: Date }): Promise<PurgeResult> {
    const dead = new Set(
      this.subscriptions
        .filter((s) => s.endedAt !== undefined && s.endedAt.getTime() < cutoffs.endedBefore.getTime())
        .map((s) => s.id),
    );
    const before = this.events.length;
    this.events = this.events.filter(
      (e) =>
        !dead.has(e.subscriptionId) &&
        (cutoffs.receivedBefore === undefined || e.receivedAt.getTime() >= cutoffs.receivedBefore.getTime()),
    );
    this.subscriptions = this.subscriptions.filter((s) => !dead.has(s.id));
    return Promise.resolve({ events: before - this.events.length, subscriptions: dead.size });
  }
}
