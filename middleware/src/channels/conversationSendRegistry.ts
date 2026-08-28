// Per-channel conversation-send providers (#330 C3b). Same shape and
// ownership discipline as TargetedSendRegistry: one provider per channelType,
// first registrant owns it (a hijacked group-post capability would let a
// plugin speak INTO foreign conversations), owner-tracked for deactivation.

import type { ConversationSendProvider } from '@omadia/channel-sdk';

export class ConversationSendRegistry {
  private readonly providers = new Map<string, ConversationSendProvider>();
  private readonly owners = new Map<string, string>();

  constructor(
    private readonly log: (msg: string, fields?: Record<string, unknown>) => void = () => undefined,
  ) {}

  register(channelId: string, provider: ConversationSendProvider): void {
    const owner = this.owners.get(provider.channelType);
    if (owner !== undefined && owner !== channelId) {
      throw new Error(
        `conversation-send provider for '${provider.channelType}' already owned by channel '${owner}' (attempted: '${channelId}')`,
      );
    }
    const replaced = this.providers.has(provider.channelType);
    this.providers.set(provider.channelType, provider);
    this.owners.set(provider.channelType, channelId);
    this.log(
      `conversationSendRegistry: ${replaced ? 'replaced' : 'registered'} provider for ${provider.channelType}`,
      { channelType: provider.channelType, channelId },
    );
  }

  /** Drop every provider a channel plugin registered. Idempotent. */
  unregisterChannel(channelId: string): void {
    for (const [channelType, owner] of this.owners) {
      if (owner !== channelId) continue;
      this.providers.delete(channelType);
      this.owners.delete(channelType);
      this.log(`conversationSendRegistry: unregistered ${channelType} (channel ${channelId} deactivated)`);
    }
  }

  get(channelType: string): ConversationSendProvider | undefined {
    return this.providers.get(channelType);
  }
}
