// Kernel-side invite index (#330 C2a). Subscribes DIRECTLY to the
// ConversationEventHub — before any plugin sees the event and independent of
// the subscribe-only service facade — and remembers which GROUP conversations
// this deployment's channel adapters reported a bot_added for. The
// conversationBindings service consults it as its scope guard: a plugin can
// only auto-bind a conversation the transport actually observed an invite
// for, never an arbitrary conversation id it made up.

import type { ChannelUserRef, ConversationMembershipEvent } from '@omadia/channel-sdk';

import type { ConversationEventHub } from '../channels/conversationEventHub.js';
import type { ObservedInvitePersistence } from './observedInvitePersistence.js';

export interface ObservedInvite {
  channelId: string;
  channelType: string;
  conversationId: string;
  addedBy?: ChannelUserRef;
  occurredAt: string;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 1000;

export class ObservedConversationInvites {
  private readonly invites = new Map<string, { invite: ObservedInvite; seenAt: number }>();
  private persistence?: ObservedInvitePersistence;

  constructor(
    private readonly opts: {
      ttlMs?: number;
      now?: () => number;
      log?: (msg: string) => void;
    } = {},
  ) {}

  /** Wire into the hub; returns the unsubscribe function. */
  attach(hub: ConversationEventHub): () => void {
    return hub.subscribe((event) => this.observe(event));
  }

  /** Optional write-through backing store — the map stays the hot path, the
   *  store only makes it survive restarts. Every write is fire-and-forget
   *  (log-only on failure): losing a persisted invite degrades to the old
   *  re-invite behaviour, it must never break the live event path. */
  attachPersistence(persistence: ObservedInvitePersistence): void {
    this.persistence = persistence;
  }

  /** Load persisted, TTL-fresh invites into the map. Call once at boot after
   *  the pool is up; keys already observed live in this process win. This
   *  index is a deny-by-default scope guard, so hydration is defensive: the
   *  key comes from the table's key COLUMNS, and a JSONB payload that names a
   *  different conversation than its columns is dropped (defense in depth —
   *  such a row would authorise a bind its column-based expiry could never
   *  revoke). The in-memory cap applies to hydration too. */
  async hydrate(): Promise<void> {
    if (!this.persistence) return;
    const now = (this.opts.now ?? Date.now)();
    const rows = await this.persistence.loadFresh(now - (this.opts.ttlMs ?? DEFAULT_TTL_MS));
    let restored = 0;
    for (const row of rows) {
      if (this.invites.size >= MAX_ENTRIES) break;
      if (row.invite?.channelType !== row.channelType || row.invite?.conversationId !== row.conversationId) {
        this.opts.log?.(`invite hydration dropped a row whose payload disagrees with its key (${row.channelType}::${row.conversationId})`);
        continue;
      }
      const key = this.key(row.channelType, row.conversationId);
      if (this.invites.has(key)) continue;
      this.invites.set(key, { invite: row.invite, seenAt: row.seenAt });
      restored += 1;
    }
    if (restored > 0) this.opts.log?.(`invite index hydrated: ${restored} persisted invite(s) restored`);
  }

  /** Composite key (review M3): two channels with colliding conversation ids
   *  must never shadow each other, and an invite without a channelType is
   *  not eligible at all — no positive statement, no eligibility. */
  private key(channelType: string, conversationId: string): string {
    return `${channelType}::${conversationId}`;
  }

  observe(event: ConversationMembershipEvent): void {
    if (event.kind !== 'bot_added') return;
    // Group-only by design: a 1:1 never needs a facilitation binding, and
    // treating an unknown type as group would widen the guard on a guess.
    if (event.conversationType !== 'group') return;
    if (!event.channelType) return;
    const now = (this.opts.now ?? Date.now)();
    const key = this.key(event.channelType, event.conversationId);
    const invite: ObservedInvite = {
      channelId: event.channelId,
      channelType: event.channelType,
      conversationId: event.conversationId,
      ...(event.addedBy ? { addedBy: event.addedBy } : {}),
      occurredAt: event.occurredAt,
    };
    this.invites.delete(key);
    this.invites.set(key, { invite, seenAt: now });
    void this.persistence
      ?.upsert(invite, now)
      .catch((err: unknown) => this.opts.log?.(`invite persist failed: ${err instanceof Error ? err.message : String(err)}`));
    if (this.invites.size > MAX_ENTRIES) {
      const oldest = this.invites.keys().next().value;
      if (oldest !== undefined) {
        const evicted = this.invites.get(oldest);
        this.invites.delete(oldest);
        if (evicted) {
          void this.persistence
            ?.delete(evicted.invite.channelType, evicted.invite.conversationId)
            .catch(() => undefined);
        }
      }
    }
    this.opts.log?.(`observed group invite for ${event.conversationId} (${event.channelType})`);
  }

  /** The invite for a conversation, if one was observed within the TTL. */
  get(channelType: string, conversationId: string): ObservedInvite | undefined {
    const key = this.key(channelType, conversationId);
    const entry = this.invites.get(key);
    if (!entry) return undefined;
    const now = (this.opts.now ?? Date.now)();
    if (now - entry.seenAt > (this.opts.ttlMs ?? DEFAULT_TTL_MS)) {
      this.invites.delete(key);
      void this.persistence?.delete(channelType, conversationId).catch(() => undefined);
      return undefined;
    }
    return entry.invite;
  }
}
