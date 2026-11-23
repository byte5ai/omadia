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

import { formatPrincipal, type ChatTurnInput } from '@omadia/channel-sdk';
import type { NativeToolCallContext } from '@omadia/plugin-api';

import { channelConversationId } from './channelConversationId.js';
import { conversationPrincipal } from './conversationPrincipal.js';
import { currentEngineTurn, processWideStore } from './facilitatorAgent.js';
import { turnContext } from './turnContext.js';

const toolCalls = processWideStore<NativeToolCallContext>('omadia.toolCallContext');

/** The context of the turn this code runs in, if it runs in one. */
export function currentToolCallContext(): NativeToolCallContext | undefined {
  return toolCalls.getStore() ?? turnContext.current()?.toolCall;
}

/**
 * The caller as the conversation layer names people: `user:<channel user id>`,
 * the same value as a stored message's `author.principalId`
 * (`principalOfChannelUser`) and a roster participant's key (ADR 0032).
 *
 * The channel user comes first: the speaker the channel named, else the
 * channel identity of the turn. `TurnOrigin.principal` is NOT that form for
 * every channel. Discord, Slack and Telegram state the routing principal of
 * spec 2042 §5.3 there (`user:discord-user:<id>`, `user:<e-mail>`), which keys
 * selections and availability, not message authors. A facilitator that keyed
 * the initiator by it counted the same person twice. The stated principal is
 * only the fallback for a turn without a channel user (web chat).
 */
function principalOf(input: ChatTurnInput): string | undefined {
  const speakerId = input.origin?.speaker?.id;
  const channelUserId =
    (typeof speakerId === 'string' && speakerId.trim() !== '' ? speakerId : undefined) ??
    input.channelIdentity?.channelUserId;
  const fromChannel = conversationPrincipal(channelUserId);
  if (fromChannel) return fromChannel;
  const stated = input.origin?.principal;
  if (stated?.kind === 'user') return formatPrincipal(stated);
  return conversationPrincipal(input.userId);
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
  // Who spoke, in the channel's terms: what an engine turn states, else what
  // the channel stated on the origin (with the display name when it gave
  // one), else the knowledge-graph identity of the turn (never a name).
  const speaker = input.origin?.speaker;
  const callerUserRef =
    engine.callerUserRef ??
    (speaker && typeof speaker.kind === 'string' && typeof speaker.id === 'string' && speaker.id !== ''
      ? {
          kind: speaker.kind,
          id: speaker.id,
          ...(typeof speaker.displayName === 'string' && speaker.displayName.trim() !== ''
            ? { displayName: speaker.displayName.trim().slice(0, 256) }
            : {}),
        }
      : input.channelIdentity
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
