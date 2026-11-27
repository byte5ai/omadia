// #2324 / ADR-0302 — a turn's origin channel type is checked against the
// plugin that states it.
//
// A plugin channel turn names its sender only through `origin` + `userId`
// (`resolveTurnOwnerIdentity`). An operator link (ADR-0280) or a directory
// person (ADR-0300) turns that sender into an account or a person with
// `per_user` MCP tokens. So the kernel must know the stating plugin holds the
// channel type: Teams for `teams`, Telegram for `telegram`. Every plugin-facing
// entry point that takes an origin — `chatAgent@1`, the `chatAgent` of a
// `channelResolver@1` answer, `CoreApi.handleTurnStream` — is wrapped per
// calling plugin, and a foreign origin is dropped before the turn runs.

import type { ChatAgent, ChatTurnInput, ChannelUserKind } from '@omadia/channel-sdk';
import type { ServiceCaller } from '@omadia/plugin-api';

import { KERNEL_SERVICE_CALLER } from '../platform/serviceRegistry.js';

/** The Public API channel plugin, the one channel that may state an `api` origin (ADR-0182). */
export const PUBLIC_API_CHANNEL_ID = '@omadia/channel-api';

/** Whether `pluginId` may state `channelType` as a turn origin. */
export type OriginTypeCheck = (pluginId: string, channelType: string) => boolean;

/**
 * The rule. `http` is the kernel's web account room: nobody states it. `api`
 * only the Public API channel. Any other type: the plugin must hold it
 * (`channelTypesOf`: what it claimed, else what its manifest derives).
 */
export function createOriginTypeCheck(channelTypesOf: (pluginId: string) => readonly string[]): OriginTypeCheck {
  return (pluginId, channelType) => {
    const type = channelType.trim().toLowerCase();
    if (type === 'http') return false;
    if (type === 'api') return pluginId === PUBLIC_API_CHANNEL_ID;
    return channelTypesOf(pluginId).some((held) => held.trim().toLowerCase() === type);
  };
}

/** The channel type a `userRef.kind` attests, when it names one. */
export const CHANNEL_TYPE_BY_USER_KIND: Readonly<Partial<Record<ChannelUserKind, string>>> = {
  'teams-aad': 'teams',
  'slack-user': 'slack',
  'telegram-chat': 'telegram',
  'discord-user': 'discord',
  'whatsapp-phone': 'whatsapp',
};

type Log = (message: string) => void;

/**
 * `input` without the identity it may not state: an `origin` of a channel type
 * the caller does not hold, and likewise a `channelIdentity` of a channel kind
 * it does not hold (that field names the sender as directly as an origin).
 */
export function guardTurnInputOrigin<T extends Pick<ChatTurnInput, 'origin' | 'channelIdentity'>>(
  input: T,
  pluginId: string,
  mayState: OriginTypeCheck,
  log: Log,
): T {
  if (input === null || typeof input !== 'object') return input;
  const drop: string[] = [];
  const origin = input.origin;
  if (origin) {
    const channelType = typeof origin.channelType === 'string' ? origin.channelType : '';
    if (channelType === '' || !mayState(pluginId, channelType)) drop.push('origin');
  }
  const identity = input.channelIdentity;
  if (identity) {
    const kind = typeof identity.channelKind === 'string' ? identity.channelKind : '';
    if (kind === '' || !mayState(pluginId, kind)) drop.push('channelIdentity');
  }
  if (drop.length === 0) return input;
  log(
    `[security-audit] turn-origin-guard: plugin ${pluginId} stated ${drop.join(' and ')} of a channel it does not hold (${String(
      origin?.channelType ?? identity?.channelKind,
    )}) — dropped, turn runs context-free`,
  );
  return Object.fromEntries(Object.entries(input).filter(([key]) => !drop.includes(key))) as T;
}

/** A `ChatAgent` whose `chat` / `chatStream` drop an origin `pluginId` may not state. */
export function guardChatAgent(agent: ChatAgent, pluginId: string, mayState: OriginTypeCheck, log: Log): ChatAgent {
  const guard = (input: ChatTurnInput): ChatTurnInput => guardTurnInputOrigin(input, pluginId, mayState, log);
  return new Proxy(agent, {
    get(target, prop) {
      if (prop === 'chat') return (input: ChatTurnInput) => target.chat(guard(input));
      if (prop === 'chatStream') {
        return (input: ChatTurnInput, ...rest: unknown[]) =>
          (target.chatStream as (i: ChatTurnInput, ...r: unknown[]) => unknown)(guard(input), ...rest);
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

const isKernel = (caller: ServiceCaller): boolean => caller.pluginId === KERNEL_SERVICE_CALLER.pluginId;

/**
 * `chatAgent@1` for one caller. The kernel's own reads get the whole bundle
 * (the dispatcher checked the origin). A plugin gets only the guarded `agent`
 * — the part the SDK types (`ChatAgentBundle`): the raw orchestrator and the
 * stores in the bundle would run turns around the guard.
 */
export function chatAgentBundleFor<B extends { readonly agent: ChatAgent }>(
  bundle: B,
  caller: ServiceCaller,
  mayState: OriginTypeCheck,
  log: Log,
): B | { readonly agent: ChatAgent } {
  if (isKernel(caller)) return bundle;
  return { agent: guardChatAgent(bundle.agent, caller.agentId, mayState, log) };
}

interface ResolverLike {
  resolve(...args: never[]): unknown;
}

/** `channelResolver@1` for one caller: the `chatAgent` of every answer is guarded. */
export function channelResolverFor<R extends ResolverLike>(
  resolver: R,
  caller: ServiceCaller,
  mayState: OriginTypeCheck,
  log: Log,
): R {
  if (isKernel(caller)) return resolver;
  return new Proxy(resolver, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (prop !== 'resolve' || typeof value !== 'function') {
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      }
      return (...args: unknown[]) => {
        const result = (value as (...a: unknown[]) => unknown).apply(target, args);
        const wrap = (r: unknown): unknown => {
          if (r === null || typeof r !== 'object') return r;
          const chatAgent = (r as { chatAgent?: ChatAgent }).chatAgent;
          return chatAgent ? { ...r, chatAgent: guardChatAgent(chatAgent, caller.agentId, mayState, log) } : r;
        };
        return result instanceof Promise ? result.then(wrap) : wrap(result);
      };
    },
  });
}
