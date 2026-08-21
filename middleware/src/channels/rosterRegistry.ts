// Per-channel roster providers (#330 B1). One provider per channelType, in
// the ChannelDirectoryRegistry mould (and for the same reason: the
// ServiceRegistry is keyed by capability name — a second channel registering
// would silently replace the first, while this map preserves one contribution
// per channel type). Provider failures are isolated: a throwing provider
// degrades to "roster unknown", never to a crashed caller.

import type { ConversationRoster, ConversationRosterProvider } from '@omadia/channel-sdk';

export class ConversationRosterRegistry {
  private readonly providers = new Map<string, ConversationRosterProvider>();
  /** Which channel plugin (catalog id) registered which channelType — so a
   *  channel deactivation can drop exactly its own contributions. */
  private readonly owners = new Map<string, string>();

  constructor(
    private readonly log: (msg: string, fields?: Record<string, unknown>) => void = () => undefined,
  ) {}

  register(channelId: string, provider: ConversationRosterProvider): void {
    // Same ownership rule as routeRegistry / targetedSendRegistry: first
    // registrant owns the channel type; a foreign replace is rejected (a
    // hijacked roster would feed wrong participant lists to group-aware
    // agents). Re-registering your own provider stays allowed.
    const owner = this.owners.get(provider.channelType);
    if (owner !== undefined && owner !== channelId) {
      throw new Error(
        `roster provider for '${provider.channelType}' already owned by channel '${owner}' (attempted: '${channelId}')`,
      );
    }
    const replaced = this.providers.has(provider.channelType);
    this.providers.set(provider.channelType, provider);
    this.owners.set(provider.channelType, channelId);
    this.log(`rosterRegistry: ${replaced ? 'replaced' : 'registered'} provider for ${provider.channelType}`, {
      channelType: provider.channelType,
      channelId,
    });
  }

  /** Drop every provider a channel plugin registered. Idempotent. */
  unregisterChannel(channelId: string): void {
    for (const [channelType, owner] of this.owners) {
      if (owner !== channelId) continue;
      this.providers.delete(channelType);
      this.owners.delete(channelType);
      this.log(`rosterRegistry: unregistered ${channelType} (channel ${channelId} deactivated)`);
    }
  }

  types(): readonly string[] {
    return Array.from(this.providers.keys()).sort();
  }

  /**
   * Resolve a conversation's roster. Undefined when no provider serves the
   * channel type, the provider cannot resolve the conversation, or it threw
   * (logged) — callers treat all three as "roster unknown", never invent one.
   */
  async getRoster(channelType: string, conversationId: string): Promise<ConversationRoster | undefined> {
    const provider = this.providers.get(channelType);
    if (!provider) return undefined;
    try {
      return await provider.getRoster(conversationId);
    } catch (err) {
      this.log(`rosterRegistry: ${channelType} getRoster FAILED — treating as unknown`, {
        channelType,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }
}
