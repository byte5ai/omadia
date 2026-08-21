// Conversation-membership event fan-out (#330 B2 seam). Channel adapters emit
// via `core.emitConversationEvent?.(event)`; kernel-side consumers (the
// Facilitator's bot_added handshake, future group-aware agents) subscribe
// here. Deliberately separate from ctx.events.emit / the Conductor
// EventRouter: these are typed transport-lifecycle events, not
// manifest-declared domain events — a bridge can be added by a consumer
// without widening this hub.
//
// No persistence in B1: an event with no subscriber is logged and dropped.
// Fan-out is synchronous with per-subscriber isolation — one throwing
// subscriber must never break the emitting webhook turn or its siblings.

import type { ConversationMembershipEvent } from '@omadia/channel-sdk';

export type ConversationEventSubscriber = (event: ConversationMembershipEvent) => void;

export class ConversationEventHub {
  private readonly subscribers = new Set<ConversationEventSubscriber>();

  constructor(
    private readonly log: (msg: string, fields?: Record<string, unknown>) => void = () => undefined,
  ) {}

  /** Returns the unsubscribe function. */
  subscribe(fn: ConversationEventSubscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  emit(event: ConversationMembershipEvent): void {
    this.log(`conversationEventHub: ${event.kind} in ${event.conversationId}`, {
      kind: event.kind,
      channelId: event.channelId,
      conversationId: event.conversationId,
      members: event.members.length,
      subscribers: this.subscribers.size,
    });
    for (const fn of this.subscribers) {
      try {
        fn(event);
      } catch (err) {
        this.log('conversationEventHub: subscriber threw — isolated', {
          kind: event.kind,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
