/**
 * #2043 — where a tool call comes from (`NativeToolCallContext`).
 *
 * A plugin's tool handler gets, as its second argument, the agent, channel,
 * conversation, inbound event and caller of the turn that dispatched it.
 * Every field is stated by the kernel from the turn itself. None of it comes
 * from a tool argument, so a handler can key its state on the conversation
 * without trusting what a model wrote.
 *
 * Two tool loops, two carriers. The in-process loop reads it from the
 * orchestrator's turn context (`TurnContextValue.toolCall`). The
 * subscription-CLI runtime has no such context: it binds this module's own
 * store inside the snapshot it restores before a loopback dispatch
 * (`CliChatAgent.captureTurnContext`).
 */

import { formatPrincipal, makePrincipal, type ChatTurnInput } from '@omadia/channel-sdk';
import type { NativeToolCallContext } from '@omadia/plugin-api';

import { currentEngineTurn, processWideStore } from './facilitatorAgent.js';
import { turnContext } from './turnContext.js';

const toolCalls = processWideStore<NativeToolCallContext>('omadia.toolCallContext');

/** The context of the turn this code runs in, if it runs in one. */
export function currentToolCallContext(): NativeToolCallContext | undefined {
  return toolCalls.getStore() ?? turnContext.current()?.toolCall;
}

/**
 * The channel-native conversation id of a turn. Channels fold their own
 * prefix into the session scope (`<channelId>::<id>`, `teams-<id>`); a tool
 * needs the id the channel itself uses.
 */
export function channelConversationId(input: ChatTurnInput): string | undefined {
  const scope = input.origin?.scope;
  if (!scope || scope.kind !== 'conversation') return undefined;
  const raw = scope.conversationId;
  const separatorAt = raw.indexOf('::');
  if (separatorAt >= 0) return raw.slice(separatorAt + 2);
  const prefix = `${input.origin!.channelType}-`;
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
}

function principalOf(input: ChatTurnInput): string | undefined {
  const stated = input.origin?.principal;
  if (stated?.kind === 'user') return formatPrincipal(stated);
  const id = input.channelIdentity?.channelUserId ?? input.userId;
  const principal = id ? makePrincipal('user', id) : undefined;
  return principal ? formatPrincipal(principal) : undefined;
}

/**
 * Build the context of one turn. An engine-run turn (`agentTurn`) states the
 * conversation, the inbound event and the caller itself; those win over what
 * the turn input implies.
 */
export function buildToolCallContext(agentSlug: string, input: ChatTurnInput): NativeToolCallContext {
  const engine = currentEngineTurn()?.toolContext ?? {};
  const conversationId = engine.conversationId ?? channelConversationId(input);
  const channelType = engine.channelType ?? input.origin?.channelType;
  const callerPrincipalId = engine.callerPrincipalId ?? principalOf(input);
  const callerUserRef =
    engine.callerUserRef ??
    (input.channelIdentity
      ? { kind: input.channelIdentity.channelKind, id: input.channelIdentity.channelUserId }
      : undefined);
  return {
    agentSlug,
    ...(channelType !== undefined ? { channelType } : {}),
    ...(conversationId !== undefined ? { conversationId } : {}),
    ...(engine.inboundEventId !== undefined ? { inboundEventId: engine.inboundEventId } : {}),
    ...(callerPrincipalId !== undefined ? { callerPrincipalId } : {}),
    ...(callerUserRef !== undefined ? { callerUserRef } : {}),
  };
}

/**
 * Run `fn` with the turn's tool call context bound. Used by the turn entry
 * points; a generator entry point calls it around every advance.
 */
export function runWithToolCallContext<T>(context: NativeToolCallContext, fn: () => T): T {
  return toolCalls.run(context, fn);
}
