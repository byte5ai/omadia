import type { SemanticAnswer } from '@omadia/channel-sdk';

/**
 * Channel-agnostic proactive-send capability. A routine fires at scheduled
 * time, the agent produces a `SemanticAnswer`, and this sender bridges that
 * back to the user via the channel-native handle stored on the routine row
 * (Teams ConversationReference, Telegram chat id, …).
 *
 * The routines runner holds one sender per channel id. Channels register
 * their sender at boot (today: Teams; Telegram + HTTP follow). Each sender
 * is responsible for translating the channel-agnostic `SemanticAnswer`
 * into the wire format its connector expects — same translation the
 * channel does for inbound-driven turns.
 */
export interface ProactiveSender {
  /**
   * Channel id this sender handles. Must match the `channel` column on
   * routine rows it's expected to deliver to. Today: `'teams'`.
   */
  readonly channel: string;

  /**
   * Deliver `message` to the conversation captured in `conversationRef`.
   * Throws on non-recoverable errors (auth expired, conversation deleted,
   * bot uninstalled). The runner records the failure on the routine's
   * `last_run_error` and keeps the routine active — channels typically
   * recover when the user next interacts.
   */
  send(opts: {
    conversationRef: unknown;
    message: SemanticAnswer;
    /**
     * Routine-trigger metadata. Channel adapters that render a richer UI
     * (Teams Smart Card with Pause/Delete actions) consume this; channels
     * that only support plain text fall back to `message.text`.
     */
    routine?: {
      id: string;
      name: string;
      cron: string;
    };
    /**
     * Phase C.6 — Adaptive Card body items produced by
     * `renderRoutineTemplate` for templated routines with
     * `format: 'adaptive-card'`. Channels that can render rich cards
     * (Teams) embed these directly into the card frame; channels that
     * cannot ignore the field and fall back to `message.text` (which
     * already carries a markdown rendering of the same template as a
     * graceful degradation).
     *
     * Items conform to Adaptive Card 1.5 body element shapes
     * (`TextBlock`, `Table`, …). Renderer-owned schema — channel
     * adapters MUST NOT introspect element types beyond what the spec
     * defines, so a future renderer change doesn't break consumers.
     */
    cardBody?: readonly unknown[];
  }): Promise<void>;
}

/**
 * Lookup-by-channel-id surface the runner consumes. Bootstrap composes a
 * concrete instance from one or more registered senders; tests use a stub.
 */
export interface ProactiveSenderRegistry {
  get(channel: string): ProactiveSender | undefined;
  channels(): readonly string[];
}

export class InMemoryProactiveSenderRegistry implements ProactiveSenderRegistry {
  private readonly senders = new Map<string, ProactiveSender>();

  register(sender: ProactiveSender): () => void {
    if (this.senders.has(sender.channel)) {
      // Hot-swap: a channel plugin re-registers after a re-upload. The
      // previous sender came from the now-deactivated plugin instance;
      // its close() released the channel-native resources (adapter,
      // turn context). Replace the entry rather than throwing — the
      // throw was originally meant for "two plugins claim the same
      // channel id" conflicts, but a legit hot-swap shares the channel
      // id by design and is the common path now that plugin re-uploads
      // hot-swap instead of requiring a process restart.
      console.warn(
        `[proactive-sender] replacing existing sender for channel '${sender.channel}' (plugin hot-swap)`,
      );
    }
    this.senders.set(sender.channel, sender);
    return () => {
      this.senders.delete(sender.channel);
    };
  }

  get(channel: string): ProactiveSender | undefined {
    return this.senders.get(channel);
  }

  channels(): readonly string[] {
    return Array.from(this.senders.keys());
  }
}
