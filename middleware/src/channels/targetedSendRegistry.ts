// Per-channel targeted-send providers (#330 B3). Same shape and rationale as
// ConversationRosterRegistry: one provider per channelType (a channel type is
// owned by exactly one plugin), owner-tracked so deactivation drops exactly
// that channel's contribution.

import type { TargetedSendProvider } from '@omadia/channel-sdk';

export class TargetedSendRegistry {
  private readonly providers = new Map<string, TargetedSendProvider>();
  private readonly owners = new Map<string, string>();

  constructor(
    private readonly log: (msg: string, fields?: Record<string, unknown>) => void = () => undefined,
  ) {}

  register(channelId: string, provider: TargetedSendProvider): void {
    // Ownership is enforced like routeRegistry's route conflict: a channel type
    // belongs to the plugin that registered it first. Silently replacing a
    // FOREIGN provider would let plugin B redirect plugin A's report DMs —
    // delivery redirection is security-relevant. Re-registering your own
    // provider (re-activate / upgrade) stays allowed.
    const owner = this.owners.get(provider.channelType);
    if (owner !== undefined && owner !== channelId) {
      throw new Error(
        `targeted-send provider for '${provider.channelType}' already owned by channel '${owner}' (attempted: '${channelId}')`,
      );
    }
    const replaced = this.providers.has(provider.channelType);
    this.providers.set(provider.channelType, provider);
    this.owners.set(provider.channelType, channelId);
    this.log(
      `targetedSendRegistry: ${replaced ? 'replaced' : 'registered'} provider for ${provider.channelType}`,
      { channelType: provider.channelType, channelId },
    );
  }

  /** Drop every provider a channel plugin registered. Idempotent. */
  unregisterChannel(channelId: string): void {
    for (const [channelType, owner] of this.owners) {
      if (owner !== channelId) continue;
      this.providers.delete(channelType);
      this.owners.delete(channelType);
      this.log(`targetedSendRegistry: unregistered ${channelType} (channel ${channelId} deactivated)`);
    }
  }

  get(channelType: string): TargetedSendProvider | undefined {
    return this.providers.get(channelType);
  }

  types(): readonly string[] {
    return Array.from(this.providers.keys()).sort();
  }
}
