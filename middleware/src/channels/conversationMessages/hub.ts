// The kernel side of 'conversationMessages@1' (#2043): which identity
// receives every message of which conversation, storing what the channel
// reports, and handing it to the facilitation engine.
//
// Three properties the rest of the design leans on:
//
//   1. THE HOT PATH IS A MAP LOOKUP. A channel adapter asks
//      `isSubscribed(...)` synchronously for every inbound activity to decide
//      whether its mention gate applies. It never touches the database and
//      never throws; anything not positively subscribed is `false`.
//
//   2. NOTHING IS STORED WITHOUT A SUBSCRIPTION. An adapter may emit without
//      asking first; an event for an identity that holds no subscription for
//      the conversation is dropped before it reaches the store.
//
//   3. AUTHORSHIP IS THE PLATFORM'S. The record is built from the adapter's
//      event only. The engine reads it by id; no argument of a model or a
//      plugin can stand in for "who wrote this".
//
// Events of one subscription are stored in arrival order (a per-subscription
// queue), so "created, then edited" cannot be stored the other way round.

import type { ConversationMessageEvent } from '@omadia/channel-sdk';
import type {
  ChannelReadinessReport,
  ConversationMessagePage,
  ConversationMessageRecord,
  ConversationMessageScope,
  ConversationMessageSubscribeOutcome,
} from '@omadia/plugin-api';

import { isBoundedText, MAX_ID_LENGTH, toStoredEvent, validateMessageEvent } from './eventIntake.js';
import {
  normalizeChannelKey,
  type ConversationMessageStore,
  type MessageSubscription,
  type StoredAuthor,
} from './store.js';

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

export interface ConversationMessageHubDeps {
  readonly store: ConversationMessageStore;
  /** The agent behind a slug, as the registry knows it. */
  readonly resolveAgent: (
    agentSlug: string,
  ) => { readonly id: string; readonly slug: string; readonly kind?: string } | undefined;
  /** The agent's OWN identity on a channel; never the default bot. */
  readonly identityFor: (agentSlug: string, channelType: string) => { channelKey: string } | undefined;
  /** Was this identity observed in the conversation? */
  readonly isBotPresent: (
    channelType: string,
    conversationId: string,
    channelKey: string,
  ) => Promise<boolean>;
  /** The channel's readiness check. Resolves `undefined` when the channel
   *  type registered no readiness provider — which means the channel has not
   *  DECLARED that it can deliver every message, so nothing is subscribed. */
  readonly checkReadiness?: (
    channelType: string,
    conversationId: string,
    channelKey: string,
  ) => Promise<ChannelReadinessReport | undefined>;
  /**
   * Is this subscription still standing on its ground? Asked by
   * {@link ConversationMessageHub.reconcile}; a reason ends the subscription.
   * `undefined` = fine, or not decidable right now (never end on doubt).
   */
  readonly groundFor?: (subscription: MessageSubscription) => Promise<string | undefined>;
  /** Canonical principal ('user:<id>') for a channel user, when known. */
  readonly resolvePrincipal?: (
    channelType: string,
    author: { readonly kind: string; readonly id: string },
  ) => Promise<string | undefined>;
  readonly log?: (message: string) => void;
}

type LiveHandler = (record: ConversationMessageRecord) => void | Promise<void>;

interface LiveRegistration {
  readonly agentSlug: string;
  /** `undefined` = the kernel itself; it sees every subscription. */
  readonly pluginId: string | undefined;
  /** Asked at EVERY delivery: a plugin that stopped being the engine gets
   *  nothing more, and one that became it again gets events again, without
   *  registering anew. */
  readonly allowed: () => boolean;
  readonly handler: LiveHandler;
}

function lookupKey(channelType: string, conversationId: string, channelKey: string): string {
  return `${channelType}\u0000${conversationId}\u0000${normalizeChannelKey(channelKey)}`;
}

export class ConversationMessageHub {
  private byIdentity = new Map<string, MessageSubscription>();
  private live: LiveRegistration[] = [];
  private readonly queues = new Map<string, Promise<unknown>>();
  /** Serialises everything that reads the table into the cache or changes
   *  both: a refresh must not overwrite a subscribe that finished while its
   *  SELECT was on the wire, nor resurrect a subscription being ended. */
  private sync: Promise<unknown> = Promise.resolve();
  private readonly log: (message: string) => void;

  constructor(private readonly deps: ConversationMessageHubDeps) {
    this.log = deps.log ?? (() => undefined);
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.sync.then(work, work);
    this.sync = run.catch(() => undefined);
    return run;
  }

  /** Load the active subscriptions. Called at boot, on a change notification
   *  from the database (another machine subscribed or ended one) and by the
   *  periodic reconcile. Never interleaves with a local subscribe/unsubscribe. */
  refresh(): Promise<void> {
    return this.exclusive(async () => {
      const active = await this.deps.store.listActiveSubscriptions();
      this.byIdentity = new Map(
        active.map((s) => [lookupKey(s.channelType, s.conversationId, s.channelKey), s]),
      );
    });
  }

  /**
   * End every subscription whose ground is gone: the engine plugin is no
   * longer the usable engine, the agent was disabled or deleted, or it lost
   * the identity the subscription was made for. From then on nothing is
   * stored and the channel's mention gate applies again.
   */
  async reconcile(): Promise<readonly { subscription: MessageSubscription; reason: string }[]> {
    const groundFor = this.deps.groundFor;
    if (!groundFor) return [];
    const ended: { subscription: MessageSubscription; reason: string }[] = [];
    for (const subscription of [...this.byIdentity.values()]) {
      let reason: string | undefined;
      try {
        reason = await groundFor(subscription);
      } catch {
        reason = undefined; // not decidable: never end on doubt
      }
      if (reason === undefined) continue;
      await this.end(subscription);
      ended.push({ subscription, reason });
      this.log(
        `[conversation-messages] ended the subscription of '${subscription.agentSlug}' for ${subscription.channelType}/${subscription.conversationId}: ${reason}`,
      );
    }
    return ended;
  }

  /** Close the gate, then end the row. */
  private end(subscription: MessageSubscription): Promise<void> {
    return this.exclusive(async () => {
      this.forget(subscription);
      await this.deps.store.endSubscription(subscription.id);
    });
  }

  private forget(subscription: MessageSubscription): void {
    const key = lookupKey(subscription.channelType, subscription.conversationId, subscription.channelKey);
    if (this.byIdentity.get(key)?.id !== subscription.id) return;
    const next = new Map(this.byIdentity);
    next.delete(key);
    this.byIdentity = next;
  }

  // ── hot path ─────────────────────────────────────────────────────────────

  isSubscribed(channelType: string, conversationId: string, channelKey: string): boolean {
    if (typeof channelType !== 'string' || typeof conversationId !== 'string' || typeof channelKey !== 'string') {
      return false;
    }
    return this.byIdentity.has(lookupKey(channelType, conversationId, channelKey));
  }

  /** The agent's active subscription for a conversation, from the cache. */
  subscriptionFor(scope: ConversationMessageScope): MessageSubscription | undefined {
    for (const subscription of this.byIdentity.values()) {
      if (
        subscription.agentSlug === scope.agentSlug &&
        subscription.channelType === scope.channelType &&
        subscription.conversationId === scope.conversationId
      ) {
        return subscription;
      }
    }
    return undefined;
  }

  /** Every active subscription for a conversation, whichever agent holds it. */
  subscriptionsIn(channelType: string, conversationId: string): readonly MessageSubscription[] {
    return [...this.byIdentity.values()].filter(
      (s) => s.channelType === channelType && s.conversationId === conversationId,
    );
  }

  /** Every active subscription of an agent on a channel type. */
  subscriptionsOf(agentSlug: string, channelType: string): readonly MessageSubscription[] {
    return [...this.byIdentity.values()].filter(
      (s) => s.agentSlug === agentSlug && s.channelType === channelType,
    );
  }

  /** Who wrote under this id in a subscription (kernel-internal: the send
   *  services resolve a mention or a DM recipient with it). */
  findAuthor(subscription: MessageSubscription, userId: string): Promise<StoredAuthor | undefined> {
    return this.deps.store.findAuthor(subscription, userId.trim().toLowerCase());
  }

  // ── channel side ─────────────────────────────────────────────────────────

  /** Fire-and-forget form for `CoreApi.emitConversationMessage`. */
  emit(event: ConversationMessageEvent): void {
    void this.ingest(event).catch((err: unknown) => {
      this.log(`[conversation-messages] storing an event failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /** Store one event and deliver it. Resolves the stored record, or
   *  `undefined` when it was dropped (no subscription, invalid, redelivery). */
  ingest(event: ConversationMessageEvent): Promise<ConversationMessageRecord | undefined> {
    const invalid = validateMessageEvent(event);
    if (invalid) {
      this.log(`[conversation-messages] dropped an invalid event: ${invalid}`);
      return Promise.resolve(undefined);
    }
    const subscription = this.byIdentity.get(
      lookupKey(event.channelType, event.conversationId, event.receivedByChannelKey),
    );
    if (!subscription) return Promise.resolve(undefined);
    const previous = this.queues.get(subscription.id) ?? Promise.resolve();
    const next = previous.then(
      () => this.store(subscription, event),
      () => this.store(subscription, event),
    );
    this.queues.set(subscription.id, next);
    void next.finally(() => {
      if (this.queues.get(subscription.id) === next) this.queues.delete(subscription.id);
    }).catch(() => undefined);
    return next;
  }

  private async store(
    subscription: MessageSubscription,
    event: ConversationMessageEvent,
  ): Promise<ConversationMessageRecord | undefined> {
    // Unsubscribed while the event waited in the queue: the gate is closed.
    if (this.byIdentity.get(lookupKey(subscription.channelType, subscription.conversationId, subscription.channelKey))?.id !== subscription.id) {
      return undefined;
    }
    let principalId: string | undefined;
    try {
      principalId = await this.deps.resolvePrincipal?.(event.channelType, event.author);
    } catch {
      principalId = undefined; // unknown is an honest answer; the platform id is the authority
    }
    const stored = toStoredEvent(event, principalId);
    let record: ConversationMessageRecord | undefined;
    try {
      record = await this.deps.store.insertEvent(subscription, stored);
    } catch (err) {
      // The row is gone (the agent was deleted and the cascade took its
      // subscription) while this process still had it cached. Close the gate
      // here instead of failing every event until the next refresh.
      if ((err as { code?: string } | null)?.code === '23503') {
        this.forget(subscription);
        this.log(
          `[conversation-messages] the subscription of '${subscription.agentSlug}' for ${subscription.channelType}/${subscription.conversationId} no longer exists; the gate is closed`,
        );
        return undefined;
      }
      throw err;
    }
    if (record) this.deliver(subscription, record);
    return record;
  }

  private deliver(subscription: MessageSubscription, record: ConversationMessageRecord): void {
    for (const registration of this.live) {
      if (registration.agentSlug !== subscription.agentSlug) continue;
      if (registration.pluginId !== undefined && registration.pluginId !== subscription.pluginId) continue;
      if (!registration.allowed()) continue;
      // At-least-once: a handler that fails catches up through `listSince`.
      void Promise.resolve()
        .then(() => registration.handler(record))
        .catch((err: unknown) => {
          this.log(
            `[conversation-messages] live handler for '${subscription.agentSlug}' failed on event ${record.eventId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }
  }

  // ── engine side ──────────────────────────────────────────────────────────

  async subscribe(
    scope: ConversationMessageScope,
    pluginId: string,
  ): Promise<ConversationMessageSubscribeOutcome> {
    const refused = (
      code: Extract<ConversationMessageSubscribeOutcome, { outcome: 'refused' }>['code'],
      message: string,
    ): ConversationMessageSubscribeOutcome => ({ outcome: 'refused', code, message });

    if (
      !isBoundedText(scope?.agentSlug, 128) ||
      !isBoundedText(scope.channelType, 64) ||
      !isBoundedText(scope.conversationId, MAX_ID_LENGTH)
    ) {
      return refused('unavailable', 'agentSlug, channelType and conversationId are required');
    }
    const agent = this.deps.resolveAgent(scope.agentSlug);
    if (!agent) return refused('unavailable', `agent '${scope.agentSlug}' is not active`);
    if (agent.kind !== 'facilitator') {
      return refused(
        'not_facilitator',
        `agent '${scope.agentSlug}' is not a facilitator; only a facilitator may receive every message of a conversation`,
      );
    }
    const identity = this.deps.identityFor(scope.agentSlug, scope.channelType);
    if (!identity) {
      return refused(
        'no_identity',
        `agent '${scope.agentSlug}' has no identity of its own on '${scope.channelType}'; it does not listen through another agent's bot`,
      );
    }
    const channelKey = normalizeChannelKey(identity.channelKey);
    const existing = this.byIdentity.get(lookupKey(scope.channelType, scope.conversationId, channelKey));
    if (existing) {
      return existing.pluginId === pluginId
        ? { outcome: 'subscribed' }
        : refused('unavailable', 'another plugin already holds the subscription for this conversation');
    }
    let present: boolean;
    try {
      present = await this.deps.isBotPresent(scope.channelType, scope.conversationId, channelKey);
    } catch {
      present = false;
    }
    if (!present) {
      return refused(
        'not_present',
        `the bot of agent '${scope.agentSlug}' was not observed in this conversation; add it to the conversation first`,
      );
    }
    if (this.deps.checkReadiness) {
      let report: ChannelReadinessReport | undefined;
      try {
        report = await this.deps.checkReadiness(scope.channelType, scope.conversationId, channelKey);
      } catch (err) {
        return refused('not_ready', `the readiness check failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!report) {
        // No readiness provider = the channel never declared that it can
        // hand over messages that do not mention the bot. Subscribing would
        // silence the agent's ordinary turns and deliver nothing instead.
        return refused(
          'not_ready',
          `channel '${scope.channelType}' does not declare delivery of all messages (it registered no readiness provider)`,
        );
      }
      if (!report.ready) {
        const reasons = report.missing.map((m) => `${m.code}: ${m.message}`).join('; ');
        return refused('not_ready', reasons || 'the channel reported it cannot deliver all messages');
      }
    } else {
      return refused('not_ready', 'no channel readiness is wired on this host');
    }
    let created: MessageSubscription | undefined;
    try {
      created = await this.exclusive(async () => {
        const row = await this.deps.store.createSubscription({
          agentId: agent.id,
          agentSlug: agent.slug,
          channelType: scope.channelType,
          conversationId: scope.conversationId,
          channelKey,
          pluginId,
        });
        if (row.pluginId === pluginId) {
          const next = new Map(this.byIdentity);
          next.set(lookupKey(row.channelType, row.conversationId, row.channelKey), row);
          this.byIdentity = next;
        }
        return row;
      });
    } catch (err) {
      this.log(`[conversation-messages] subscribe failed: ${err instanceof Error ? err.message : String(err)}`);
      return refused('unavailable', 'the subscription could not be stored');
    }
    if (created.pluginId !== pluginId) {
      return refused('unavailable', 'another plugin already holds the subscription for this conversation');
    }
    this.log(`[conversation-messages] '${created.agentSlug}' receives all messages of ${created.channelType}/${created.conversationId}`);
    return { outcome: 'subscribed' };
  }

  async unsubscribe(scope: ConversationMessageScope, pluginId: string | undefined): Promise<void> {
    const subscription = this.owned(scope, pluginId);
    if (!subscription) return;
    await this.end(subscription);
  }

  onMessage(
    agentSlug: string,
    pluginId: string | undefined,
    handler: LiveHandler,
    allowed: () => boolean = () => true,
  ): () => void {
    const registration: LiveRegistration = { agentSlug, pluginId, allowed, handler };
    this.live = [...this.live, registration];
    return () => {
      this.live = this.live.filter((r) => r !== registration);
    };
  }

  async getEvent(
    scope: ConversationMessageScope,
    pluginId: string | undefined,
    messageId: string,
    revision?: number,
  ): Promise<ConversationMessageRecord | undefined> {
    const subscription = this.owned(scope, pluginId);
    if (!subscription || !isBoundedText(messageId, MAX_ID_LENGTH)) return undefined;
    return this.deps.store.getEvent(
      subscription,
      messageId,
      Number.isInteger(revision) ? revision : undefined,
    );
  }

  async getEventById(
    scope: ConversationMessageScope,
    pluginId: string | undefined,
    eventId: string,
  ): Promise<ConversationMessageRecord | undefined> {
    const subscription = this.owned(scope, pluginId);
    if (!subscription || !isBoundedText(eventId, 64)) return undefined;
    return this.deps.store.getEventById(subscription, eventId);
  }

  async listSince(
    scope: ConversationMessageScope,
    pluginId: string | undefined,
    opts?: { after?: string; limit?: number },
  ): Promise<ConversationMessagePage> {
    const subscription = this.owned(scope, pluginId);
    if (!subscription) return { events: [] };
    const requested = Number.isInteger(opts?.limit) ? opts!.limit! : DEFAULT_PAGE_SIZE;
    const limit = Math.min(Math.max(requested, 1), MAX_PAGE_SIZE);
    // One more than asked for: `nextCursor` is present only when there IS a
    // next page, so a consumer can stop at the first page without a cursor.
    const rows = await this.deps.store.listSince(subscription, opts?.after, limit + 1);
    const events = rows.slice(0, limit);
    const last = events[events.length - 1];
    return {
      events,
      ...(rows.length > limit && last ? { nextCursor: last.eventId } : {}),
    };
  }

  /** The caller's own active subscription for the scope, or nothing. */
  private owned(scope: ConversationMessageScope, pluginId: string | undefined): MessageSubscription | undefined {
    if (!scope || typeof scope.agentSlug !== 'string') return undefined;
    const subscription = this.subscriptionFor(scope);
    if (!subscription) return undefined;
    if (pluginId !== undefined && subscription.pluginId !== pluginId) return undefined;
    return subscription;
  }
}
