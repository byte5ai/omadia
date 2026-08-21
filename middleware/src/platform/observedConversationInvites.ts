// Kernel-side invite index (#330 C2a). Subscribes DIRECTLY to the
// ConversationEventHub — before any plugin sees the event and independent of
// the subscribe-only service facade — and remembers which GROUP conversations
// this deployment's channel adapters reported a bot_added for. The
// conversationBindings service consults it as its scope guard: a plugin can
// only auto-bind a conversation the transport actually observed an invite
// for, never an arbitrary conversation id it made up.

import type { ChannelUserRef, ConversationMembershipEvent } from '@omadia/channel-sdk';

import type { ConversationEventHub } from '../channels/conversationEventHub.js';

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
    this.invites.delete(key);
    this.invites.set(key, {
      invite: {
        channelId: event.channelId,
        channelType: event.channelType,
        conversationId: event.conversationId,
        ...(event.addedBy ? { addedBy: event.addedBy } : {}),
        occurredAt: event.occurredAt,
      },
      seenAt: now,
    });
    if (this.invites.size > MAX_ENTRIES) {
      const oldest = this.invites.keys().next().value;
      if (oldest !== undefined) this.invites.delete(oldest);
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
      return undefined;
    }
    return entry.invite;
  }
}
