// One provider per channel type, owned by the channel plugin that registered
// it (#2043). The same lifecycle as `ConversationRosterRegistry`, for the same
// reasons: the first registrant owns the channel type (a hijacked readiness
// check would declare a conversation ready that is not), re-registering your
// own provider is allowed, and a channel's deactivation drops exactly its own
// contributions. Used for readiness providers and meeting sources.

export class ChannelProviderRegistry<P extends { readonly channelType: string }> {
  private readonly providers = new Map<string, P>();
  private readonly owners = new Map<string, string>();

  constructor(
    private readonly label: string,
    private readonly log: (msg: string, fields?: Record<string, unknown>) => void = () => undefined,
  ) {}

  register(channelId: string, provider: P): void {
    const owner = this.owners.get(provider.channelType);
    if (owner !== undefined && owner !== channelId) {
      throw new Error(
        `${this.label} provider for '${provider.channelType}' already owned by channel '${owner}' (attempted: '${channelId}')`,
      );
    }
    const replaced = this.providers.has(provider.channelType);
    this.providers.set(provider.channelType, provider);
    this.owners.set(provider.channelType, channelId);
    this.log(`${this.label}Registry: ${replaced ? 'replaced' : 'registered'} provider for ${provider.channelType}`, {
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
      this.log(`${this.label}Registry: unregistered ${channelType} (channel ${channelId} deactivated)`);
    }
  }

  get(channelType: string): P | undefined {
    return this.providers.get(channelType);
  }

  types(): readonly string[] {
    return [...this.providers.keys()];
  }
}
