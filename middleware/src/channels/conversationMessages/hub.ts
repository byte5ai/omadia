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

import { archetypeAdds, type ArchetypeBearer } from '@omadia/orchestrator';
import type { ConversationMessageEvent } from '@omadia/channel-sdk';
import type {
  ChannelReadinessReport,
  ConversationMessageMode,
  ConversationMessagePage,
  ConversationMessageRecord,
  ConversationMessageScope,
  ConversationMessageSubscribeOutcome,
  ProcessConversationMessageRecord,
  ProcessMessageScope,
  ProcessSubscribeOutcome,
} from '@omadia/plugin-api';

import { isBoundedText, MAX_ID_LENGTH, toStoredEvent, validateMessageEvent } from './eventIntake.js';
import {
  cardRef,
  normalizeChannelKey,
  type ConversationMessageStore,
  type MessageSubscription,
  type StoredAuthor,
} from './store.js';

/** #2089 — what a process may read in a conversation right now, from the
 *  execution scopes and reservations (#2090). */
export interface ProcessAccess {
  /** The process holds the conversation's reservation. */
  readonly reserved: boolean;
  /** It holds or held it. */
  readonly everReserved: boolean;
  /** It has an open execution scope. */
  readonly openScope: boolean;
}

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

export interface ConversationMessageHubDeps {
  readonly store: ConversationMessageStore;
  /** The agent behind a slug, as the registry knows it. */
  readonly resolveAgent: (
    agentSlug: string,
  ) => ({ readonly id: string; readonly slug: string } & ArchetypeBearer) | undefined;
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
  /**
   * #2089 — what the process of a subscription may read. Absent (no
   * execution store): process subscriptions are not offered. Rejects when it
   * cannot be decided right now.
   */
  readonly processAccess?: (process: {
    pluginId: string;
    processId: string;
    channelType: string;
    conversationId: string;
  }) => Promise<ProcessAccess>;
  readonly log?: (message: string) => void;
}

type LiveHandler = (record: ConversationMessageRecord) => void | Promise<void>;

interface LiveRegistration {
  /** `true`: records of process subscriptions (the second major), each with
   *  its process id. `false`: records of subscriptions without a process. */
  readonly process: boolean;
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
  /** Active subscriptions per (channel type, conversation, identity). One
   *  without a process (first major), or one per process (second major). */
  private byIdentity = new Map<string, readonly MessageSubscription[]>();
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
      const next = new Map<string, MessageSubscription[]>();
      for (const subscription of active) {
        const key = lookupKey(subscription.channelType, subscription.conversationId, subscription.channelKey);
        next.set(key, [...(next.get(key) ?? []), subscription]);
      }
      this.byIdentity = next;
    });
  }

  private all(): MessageSubscription[] {
    return [...this.byIdentity.values()].flat();
  }

  private at(channelType: string, conversationId: string, channelKey: string): readonly MessageSubscription[] {
    return this.byIdentity.get(lookupKey(channelType, conversationId, channelKey)) ?? [];
  }

  private isActive(subscription: MessageSubscription): MessageSubscription | undefined {
    return this.at(subscription.channelType, subscription.conversationId, subscription.channelKey).find(
      (s) => s.id === subscription.id,
    );
  }

  /** Add the subscription to the cache, or replace its cached copy. */
  private put(subscription: MessageSubscription): void {
    const key = lookupKey(subscription.channelType, subscription.conversationId, subscription.channelKey);
    const next = new Map(this.byIdentity);
    next.set(key, [...(next.get(key) ?? []).filter((s) => s.id !== subscription.id), subscription]);
    this.byIdentity = next;
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
    for (const subscription of this.all()) {
      let reason: string | undefined;
      try {
        reason = (await groundFor(subscription)) ?? (await this.processGround(subscription));
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

  /**
   * #2088 — end of service: end every subscription of this agent, now. Used
   * before an agent is disabled or deleted and before its archetype plugin
   * is removed; the periodic reconcile would get there too, but only after
   * the change, and the order matters (nothing may still be delivered for an
   * agent that is being taken out of service).
   */
  /**
   * #2089 — a process subscription stands on its process's execution scopes
   * and reservation. No open scope: the reason that ends it. Reservation
   * released while it reads every message: the mode is turned down to
   * `addressed` here, and the subscription stays.
   */
  private async processGround(subscription: MessageSubscription): Promise<string | undefined> {
    if (subscription.processId === undefined || !this.deps.processAccess) return undefined;
    const access = await this.deps.processAccess({
      pluginId: subscription.pluginId,
      processId: subscription.processId,
      channelType: subscription.channelType,
      conversationId: subscription.conversationId,
    });
    if (!access.openScope) return 'its process has no open execution scope';
    if (subscription.mode === 'all' && !access.reserved) {
      await this.changeMode(subscription, 'addressed');
      this.log(
        `[conversation-messages] '${subscription.agentSlug}' (process ${subscription.processId}) no longer holds ${subscription.channelType}/${subscription.conversationId}: it now gets addressed messages only`,
      );
    }
    return undefined;
  }

  private changeMode(subscription: MessageSubscription, mode: ConversationMessageMode): Promise<MessageSubscription | undefined> {
    return this.exclusive(async () => {
      const updated = await this.deps.store.setSubscriptionMode(subscription.id, mode);
      if (updated && this.isActive(subscription)) this.put(updated);
      return updated;
    });
  }

  async endAllOf(agentSlug: string, reason: string): Promise<readonly MessageSubscription[]> {
    const ended: MessageSubscription[] = [];
    for (const subscription of this.all()) {
      if (subscription.agentSlug !== agentSlug) continue;
      await this.end(subscription);
      ended.push(subscription);
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
    const current = this.byIdentity.get(key);
    if (!current?.some((s) => s.id === subscription.id)) return;
    const next = new Map(this.byIdentity);
    const rest = current.filter((s) => s.id !== subscription.id);
    if (rest.length > 0) next.set(key, rest);
    else next.delete(key);
    this.byIdentity = next;
  }

  // ── hot path ─────────────────────────────────────────────────────────────

  isSubscribed(channelType: string, conversationId: string, channelKey: string): boolean {
    if (typeof channelType !== 'string' || typeof conversationId !== 'string' || typeof channelKey !== 'string') {
      return false;
    }
    return this.at(channelType, conversationId, channelKey).some((s) => s.mode === 'all');
  }

  /** #2089 — what the identity is handed of the conversation: every human
   *  message, only addressed ones, or nothing. Hot path, like `isSubscribed`. */
  deliveryMode(channelType: string, conversationId: string, channelKey: string): ConversationMessageMode {
    if (typeof channelType !== 'string' || typeof conversationId !== 'string' || typeof channelKey !== 'string') {
      return 'none';
    }
    const subscriptions = this.at(channelType, conversationId, channelKey);
    if (subscriptions.some((s) => s.mode === 'all')) return 'all';
    return subscriptions.some((s) => s.mode === 'addressed') ? 'addressed' : 'none';
  }

  /** The agent's active subscription WITHOUT a process for a conversation
   *  (the first major's), from the cache. */
  subscriptionFor(scope: ConversationMessageScope): MessageSubscription | undefined {
    for (const subscription of this.all()) {
      if (
        subscription.processId === undefined &&
        subscription.agentSlug === scope.agentSlug &&
        subscription.channelType === scope.channelType &&
        subscription.conversationId === scope.conversationId
      ) {
        return subscription;
      }
    }
    return undefined;
  }

  /**
   * Does the engine read EVERY message of this conversation for this agent,
   * through a subscription of either major? Then it answers what is said
   * there itself, and a turn the channel starts for the same message (a
   * mention) must not produce a second answer.
   */
  readsEverything(scope: ConversationMessageScope): boolean {
    return this.all().some(
      (s) =>
        s.mode === 'all' &&
        s.agentSlug === scope.agentSlug &&
        s.channelType === scope.channelType &&
        s.conversationId === scope.conversationId,
    );
  }

  /** Every active subscription for a conversation, whichever agent holds it. */
  subscriptionsIn(channelType: string, conversationId: string): readonly MessageSubscription[] {
    return this.all().filter(
      (s) => s.channelType === channelType && s.conversationId === conversationId,
    );
  }

  /** Every active subscription of an agent on a channel type. */
  subscriptionsOf(agentSlug: string, channelType: string): readonly MessageSubscription[] {
    return this.all().filter(
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

  /** Store one event and deliver it. Resolves the stored record (the first
   *  one, when several processes get the event), or `undefined` when it was
   *  dropped (no subscription takes it, invalid, redelivery). */
  ingest(event: ConversationMessageEvent): Promise<ConversationMessageRecord | undefined> {
    const invalid = validateMessageEvent(event);
    if (invalid) {
      this.log(`[conversation-messages] dropped an invalid event: ${invalid}`);
      return Promise.resolve(undefined);
    }
    const key = lookupKey(event.channelType, event.conversationId, event.receivedByChannelKey);
    if (!this.byIdentity.has(key)) return Promise.resolve(undefined);
    // One queue per conversation and identity: routing reads the bindings, and
    // "created, then edited" must not be stored the other way round.
    const work = (): Promise<ConversationMessageRecord | undefined> => this.routeAndStore(key, event);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.queues.set(key, next);
    void next.finally(() => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    }).catch(() => undefined);
    return next;
  }

  /**
   * #2089 — which subscriptions take the event. The process mapping happens
   * here, before anything is stored or delivered:
   *  - a reply to a message, a reaction on it or an answer to a card that is
   *    bound to a process goes to that process alone;
   *  - anything else goes to every subscription in `all` mode, and to those
   *    in `addressed` mode when the channel says it addresses the agent.
   */
  private async recipients(
    subscriptions: readonly MessageSubscription[],
    event: ConversationMessageEvent,
  ): Promise<readonly MessageSubscription[]> {
    if (subscriptions.some((s) => s.processId !== undefined)) {
      const refs = [
        typeof event.replyToMessageId === 'string' ? event.replyToMessageId : undefined,
        event.kind === 'card_answer' && event.cardAnswer ? cardRef(event.cardAnswer.cardId) : undefined,
        event.kind === 'card_answer' || event.kind === 'reaction' ? event.messageId : undefined,
      ].filter((ref): ref is string => typeof ref === 'string' && ref.length > 0);
      const bindings = await this.deps.store.findProcessBindings(event.channelType, event.conversationId, refs);
      const bound = refs.map((ref) => bindings.find((b) => b.ref === ref)).find((b) => b !== undefined);
      if (bound) {
        return subscriptions.filter(
          (s) => s.processId === bound.processId && s.pluginId === bound.pluginId && s.mode !== 'none',
        );
      }
    }
    return subscriptions.filter(
      (s) => s.mode === 'all' || (s.mode === 'addressed' && event.addressedToBot === true),
    );
  }

  private async routeAndStore(
    key: string,
    event: ConversationMessageEvent,
  ): Promise<ConversationMessageRecord | undefined> {
    const subscriptions = this.byIdentity.get(key) ?? [];
    if (subscriptions.length === 0) return undefined;
    let first: ConversationMessageRecord | undefined;
    for (const subscription of await this.recipients(subscriptions, event)) {
      const record = await this.store(subscription, event);
      first ??= record;
    }
    return first;
  }

  private async store(
    subscription: MessageSubscription,
    event: ConversationMessageEvent,
  ): Promise<ConversationMessageRecord | undefined> {
    // Unsubscribed while the event waited in the queue: the gate is closed.
    if (!this.isActive(subscription)) return undefined;
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
    const forProcess = subscription.processId !== undefined;
    const delivered: ConversationMessageRecord = forProcess
      ? ({ ...record, processId: subscription.processId } as ProcessConversationMessageRecord)
      : record;
    for (const registration of this.live) {
      if (registration.process !== forProcess) continue;
      if (registration.agentSlug !== subscription.agentSlug) continue;
      if (registration.pluginId !== undefined && registration.pluginId !== subscription.pluginId) continue;
      if (!registration.allowed()) continue;
      // At-least-once: a handler that fails catches up through `listSince`.
      void Promise.resolve()
        .then(() => registration.handler(delivered))
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
    // #2088 — what the agent's archetype ADDS decides; today only the
    // facilitator's descriptor lists `conversation_messages`.
    if (!archetypeAdds(agent, 'conversation_messages')) {
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
    const here = this.at(scope.channelType, scope.conversationId, channelKey);
    const existing = here.find((s) => s.processId === undefined);
    if (existing) {
      return existing.pluginId === pluginId
        ? { outcome: 'subscribed' }
        : refused('unavailable', 'another plugin already holds the subscription for this conversation');
    }
    // #2089 — an identity reads a conversation through process subscriptions
    // or through one without a process, never both.
    if (here.length > 0) {
      return refused('unavailable', 'a process already holds a subscription for this conversation');
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
        if (row.pluginId === pluginId) this.put(row);
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
    const registration: LiveRegistration = { process: false, agentSlug, pluginId, allowed, handler };
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

  // ── #2089: process subscriptions ('conversationMessages@2') ──────────────

  /** The caller's active subscription of a process for a conversation. */
  private processSubscription(scope: ProcessMessageScope, pluginId: string): MessageSubscription | undefined {
    if (!scope || typeof scope.processId !== 'string' || typeof scope.agentSlug !== 'string') return undefined;
    return this.all().find(
      (s) =>
        s.processId === scope.processId &&
        s.pluginId === pluginId &&
        s.agentSlug === scope.agentSlug &&
        s.channelType === scope.channelType &&
        s.conversationId === scope.conversationId,
    );
  }

  private asProcessRecord(
    subscription: MessageSubscription,
    record: ConversationMessageRecord | undefined,
  ): ProcessConversationMessageRecord | undefined {
    return record && subscription.processId !== undefined ? { ...record, processId: subscription.processId } : undefined;
  }

  /**
   * Subscribe a process to a conversation, or change the mode of its
   * subscription. `all` needs the reservation, every mode an open scope; the
   * checks of the first major (archetype, own identity, presence, and for
   * `all` the channel's readiness) apply as well.
   */
  async subscribeProcess(
    scope: ProcessMessageScope,
    mode: ConversationMessageMode,
    pluginId: string,
  ): Promise<ProcessSubscribeOutcome> {
    const refused = (
      code: Extract<ProcessSubscribeOutcome, { outcome: 'refused' }>['code'],
      message: string,
    ): ProcessSubscribeOutcome => ({ outcome: 'refused', code, message });

    if (
      !isBoundedText(scope?.agentSlug, 128) ||
      !isBoundedText(scope.channelType, 64) ||
      !isBoundedText(scope.conversationId, MAX_ID_LENGTH) ||
      !isBoundedText(scope.processId, 200)
    ) {
      return refused('unavailable', 'agentSlug, channelType, conversationId and processId are required');
    }
    if (mode !== 'all' && mode !== 'addressed' && mode !== 'none') {
      return refused('unavailable', "mode is 'all', 'addressed' or 'none'");
    }
    if (!this.deps.processAccess) {
      return refused('unavailable', 'process subscriptions need the execution store (a database)');
    }
    const agent = this.deps.resolveAgent(scope.agentSlug);
    if (!agent) return refused('unavailable', `agent '${scope.agentSlug}' is not active`);
    if (!archetypeAdds(agent, 'conversation_messages')) {
      return refused('not_facilitator', `the archetype of agent '${scope.agentSlug}' does not add conversation messages`);
    }
    const identity = this.deps.identityFor(scope.agentSlug, scope.channelType);
    if (!identity) {
      return refused(
        'no_identity',
        `agent '${scope.agentSlug}' has no identity of its own on '${scope.channelType}'; it does not listen through another agent's bot`,
      );
    }
    const channelKey = normalizeChannelKey(identity.channelKey);

    let access: ProcessAccess;
    try {
      access = await this.deps.processAccess({
        pluginId,
        processId: scope.processId,
        channelType: scope.channelType,
        conversationId: scope.conversationId,
      });
    } catch (err) {
      return refused('unavailable', `the process's permissions could not be read: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!access.openScope) return refused('no_scope', 'this process has no open execution scope');
    if (mode === 'all' && !access.reserved) {
      return refused('not_reserved', 'every message of a conversation is read only by the process that holds its reservation');
    }
    if (!access.everReserved) {
      return refused('not_reserved', 'this process never held the reservation of this conversation');
    }

    const here = this.at(scope.channelType, scope.conversationId, channelKey);
    if (here.some((s) => s.processId === undefined)) {
      return refused('unavailable', 'this conversation is read through a subscription without a process (the first major); end it first');
    }
    const existing = this.processSubscription(scope, pluginId);
    if (existing) {
      if (existing.mode !== mode) {
        const updated = await this.changeMode(existing, mode);
        if (!updated) return refused('ended', "this process's subscription for the conversation has ended");
        this.log(
          `[conversation-messages] '${existing.agentSlug}' (process ${scope.processId}): ${existing.mode} -> ${mode} in ${existing.channelType}/${existing.conversationId}`,
        );
      }
      return { outcome: 'subscribed', mode };
    }

    let present: boolean;
    try {
      present = await this.deps.isBotPresent(scope.channelType, scope.conversationId, channelKey);
    } catch {
      present = false;
    }
    if (!present) {
      return refused('not_present', `the bot of agent '${scope.agentSlug}' was not observed in this conversation; add it to the conversation first`);
    }
    // Only reading EVERY message needs what the channel's readiness states
    // (Teams: the chat-specific permission). Addressed messages reach a bot
    // that is present.
    if (mode === 'all') {
      let report: ChannelReadinessReport | undefined;
      try {
        report = await this.deps.checkReadiness?.(scope.channelType, scope.conversationId, channelKey);
      } catch (err) {
        return refused('not_ready', `the readiness check failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!report) {
        return refused('not_ready', `channel '${scope.channelType}' does not declare delivery of all messages`);
      }
      if (!report.ready) {
        const reasons = report.missing.map((m) => `${m.code}: ${m.message}`).join('; ');
        return refused('not_ready', reasons || 'the channel reported it cannot deliver all messages');
      }
    }

    let created: { subscription: MessageSubscription; existed: boolean; ended: boolean };
    try {
      created = await this.exclusive(async () => {
        const row = await this.deps.store.createProcessSubscription({
          agentId: agent.id,
          agentSlug: agent.slug,
          channelType: scope.channelType,
          conversationId: scope.conversationId,
          channelKey,
          pluginId,
          processId: scope.processId,
          mode,
        });
        if (!row.ended) this.put(row.subscription);
        return row;
      });
    } catch (err) {
      this.log(`[conversation-messages] subscribe failed: ${err instanceof Error ? err.message : String(err)}`);
      return refused('unavailable', 'the subscription could not be stored');
    }
    if (created.ended) return refused('ended', "this process's subscription for the conversation has ended");
    if (created.existed && created.subscription.mode !== mode) {
      // Another machine created it a moment ago with another mode.
      await this.changeMode(created.subscription, mode);
    }
    this.log(
      `[conversation-messages] '${agent.slug}' (process ${scope.processId}) receives ${mode === 'all' ? 'all' : mode === 'addressed' ? 'addressed' : 'no'} messages of ${scope.channelType}/${scope.conversationId}`,
    );
    return { outcome: 'subscribed', mode };
  }

  modeOfProcess(scope: ProcessMessageScope, pluginId: string): ConversationMessageMode | undefined {
    return this.processSubscription(scope, pluginId)?.mode;
  }

  onProcessMessage(
    agentSlug: string,
    pluginId: string,
    handler: (record: ProcessConversationMessageRecord) => void | Promise<void>,
    allowed: () => boolean = () => true,
  ): () => void {
    const registration: LiveRegistration = {
      process: true,
      agentSlug,
      pluginId,
      allowed,
      handler: handler as LiveHandler,
    };
    this.live = [...this.live, registration];
    return () => {
      this.live = this.live.filter((r) => r !== registration);
    };
  }

  async getProcessEvent(
    scope: ProcessMessageScope,
    pluginId: string,
    messageId: string,
    revision?: number,
  ): Promise<ProcessConversationMessageRecord | undefined> {
    const subscription = this.processSubscription(scope, pluginId);
    if (!subscription || !isBoundedText(messageId, MAX_ID_LENGTH)) return undefined;
    return this.asProcessRecord(
      subscription,
      await this.deps.store.getEvent(subscription, messageId, Number.isInteger(revision) ? revision : undefined),
    );
  }

  async getProcessEventById(
    scope: ProcessMessageScope,
    pluginId: string,
    eventId: string,
  ): Promise<ProcessConversationMessageRecord | undefined> {
    const subscription = this.processSubscription(scope, pluginId);
    if (!subscription || !isBoundedText(eventId, 64)) return undefined;
    return this.asProcessRecord(subscription, await this.deps.store.getEventById(subscription, eventId));
  }

  async listProcessEventsSince(
    scope: ProcessMessageScope,
    pluginId: string,
    opts?: { after?: string; limit?: number },
  ): Promise<{ events: readonly ProcessConversationMessageRecord[]; nextCursor?: string }> {
    const subscription = this.processSubscription(scope, pluginId);
    if (!subscription || subscription.processId === undefined) return { events: [] };
    const processId = subscription.processId;
    const requested = Number.isInteger(opts?.limit) ? opts!.limit! : DEFAULT_PAGE_SIZE;
    const limit = Math.min(Math.max(requested, 1), MAX_PAGE_SIZE);
    const rows = await this.deps.store.listSince(subscription, opts?.after, limit + 1);
    const events = rows.slice(0, limit).map((record) => ({ ...record, processId }));
    const last = events[events.length - 1];
    return { events, ...(rows.length > limit && last ? { nextCursor: last.eventId } : {}) };
  }

  /** Record that a message or card of the agent belongs to the process. */
  async bindProcessMessage(
    scope: ProcessMessageScope,
    pluginId: string,
    ref: { messageId?: string; cardId?: string },
  ): Promise<boolean> {
    const subscription = this.processSubscription(scope, pluginId);
    if (!subscription || subscription.processId === undefined) return false;
    const refs = [
      isBoundedText(ref?.messageId, MAX_ID_LENGTH) ? ref.messageId : undefined,
      isBoundedText(ref?.cardId, MAX_ID_LENGTH) ? cardRef(ref.cardId) : undefined,
    ].filter((r): r is string => r !== undefined);
    if (refs.length === 0) return false;
    let bound = true;
    for (const one of refs) {
      const ok = await this.deps.store.bindProcessMessage({
        channelType: subscription.channelType,
        conversationId: subscription.conversationId,
        ref: one,
        agentId: subscription.agentId,
        pluginId,
        processId: subscription.processId,
      });
      bound = bound && ok;
    }
    return bound;
  }

  /** Exact, for the engine's own reconcile: re-reads the store first, so the
   *  answer does not depend on a boot refresh or a notification having run. */
  async holdsSubscription(scope: ConversationMessageScope, pluginId: string): Promise<boolean> {
    await this.refresh();
    return this.owned(scope, pluginId) !== undefined;
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
