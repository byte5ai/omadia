import type { OrchestratorRegistry } from '@omadia/orchestrator';

/**
 * WHICH AGENT IS A BOT, AND WHICH BOT IS AN AGENT — for the Conductor.
 *
 * One answer for both directions, so a run that a message to a bot started is
 * also delivered back through that bot:
 *
 *  - Inbound ({@link resolveAddressedBot}) — a channel-triggered run binds its
 *    agent steps to the bot the person addressed (`assertChannelOriginAllows`).
 *  - Outbound ({@link speakingIdentityFor}) — a `say` step posts as the bot
 *    that IS the agent (`ConductorSayService`).
 *
 * Provisioned bots (`agent_teams_identities`) always win and are unambiguous.
 * The one other bot that has an owner is the deployment's explicitly
 * configured DEFAULT bot (the Microsoft 365 integration's app id — the bot
 * that serves `/api/messages`). It has no identity row; normal chat routes it
 * through `channel_bindings`, then the platform fallback agent
 * (`OrchestratorRegistry.resolveByChannel`), and the Conductor now resolves it
 * the same way. Before, the Conductor knew only provisioned identities, so a
 * workflow triggered through the default bot was refused at its first agent
 * step and could not have spoken back either.
 *
 * What is still refused, deliberately:
 *  - a provisioned bot whose agent is not active — answering it from the
 *    fallback would run with somebody else's permissions (the privilege
 *    escalation `identityOwnerFor` exists to stop);
 *  - any other unknown bot key — only the configured default bot falls back.
 *
 * For the default bot, a binding of the run's conversation comes first, as
 * in chat — otherwise a bound conversation would get the fallback's (usually
 * broader) permissions in a workflow while chat answers as the bound agent.
 */

type BotRegistry = Pick<
  OrchestratorRegistry,
  'identityForChannel' | 'identityOwnerFor' | 'resolveByChannel' | 'channelIdentityFor' | 'list'
>;

/** The active agent a `channel_bindings` row binds this conversation to. */
function conversationBinding(
  registry: BotRegistry,
  channelType: string,
  conversationId: string | undefined,
): string | undefined {
  if (!conversationId) return undefined;
  return registry
    .list()
    .find((e) => e.bindings.some((b) => b.channelType === channelType && b.channelKey === conversationId))
    ?.agent.slug;
}

/** The configured default bot's routing key for a channel type (Teams:
 *  `28:<appId>`), or undefined when none is configured. Read per call. */
export type DefaultChannelBotKey = (channelType: string) => string | undefined;

/** A bot routing key as identities are stored: `28:<appId>` lowercased (the
 *  Teams plugin's `teamsBotKey()`), whatever casing the payload carried. */
export function channelBotKey(raw: string): string {
  return raw.trim().toLowerCase();
}

export type AddressedBotResolution =
  | { readonly kind: 'agent'; readonly agentSlug: string; readonly via: 'identity' | 'default-bot' }
  | { readonly kind: 'refused'; readonly reason: 'identity-unavailable'; readonly ownerAgentId: string }
  | { readonly kind: 'refused'; readonly reason: 'unknown-bot' | 'no-agent' };

/**
 * `conversationId` — the conversation the run came from. For the default bot
 * only, its binding comes first, exactly as chat routes it (the Teams plugin
 * tries the conversation, then the bot): in a conversation bound to agent X,
 * the default bot answers as X in chat, so a run it starts must not run as
 * the (usually broader) fallback instead. A provisioned bot stays exclusive.
 */
export function resolveAddressedBot(
  registry: BotRegistry,
  channelType: string,
  rawBotKey: string,
  defaultBotKey: DefaultChannelBotKey | undefined,
  conversationId?: string,
): AddressedBotResolution {
  const key = channelBotKey(rawBotKey);
  const owned = registry.identityForChannel(channelType, key);
  if (owned) return { kind: 'agent', agentSlug: owned.agent.slug, via: 'identity' };
  const ownerAgentId = registry.identityOwnerFor(channelType, key);
  if (ownerAgentId !== undefined) {
    return { kind: 'refused', reason: 'identity-unavailable', ownerAgentId };
  }
  const configured = defaultBotKey?.(channelType);
  if (!configured || channelBotKey(configured) !== key) {
    return { kind: 'refused', reason: 'unknown-bot' };
  }
  const boundToConversation = conversationBinding(registry, channelType, conversationId);
  if (boundToConversation) return { kind: 'agent', agentSlug: boundToConversation, via: 'default-bot' };
  const entry = registry.resolveByChannel(channelType, key);
  return entry
    ? { kind: 'agent', agentSlug: entry.agent.slug, via: 'default-bot' }
    : { kind: 'refused', reason: 'no-agent' };
}

/**
 * The bot an agent speaks as: its own provisioned identity, else the default
 * bot when — and only when — the default bot resolves to this very agent.
 * Undefined means "this agent cannot speak in its own name here"; callers
 * refuse rather than borrow another bot.
 */
export function speakingIdentityFor(
  registry: BotRegistry,
  agentSlug: string,
  channelType: string,
  defaultBotKey: DefaultChannelBotKey | undefined,
  conversationId?: string,
): { channelType: string; channelKey: string } | undefined {
  const own = registry.channelIdentityFor(agentSlug, channelType);
  if (own) return own;
  const configured = defaultBotKey?.(channelType);
  if (!configured) return undefined;
  const resolved = resolveAddressedBot(registry, channelType, configured, defaultBotKey, conversationId);
  return resolved.kind === 'agent' && resolved.agentSlug === agentSlug
    ? { channelType, channelKey: channelBotKey(configured) }
    : undefined;
}
