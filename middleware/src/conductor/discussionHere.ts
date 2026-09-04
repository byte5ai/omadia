// `conductorDiscussions@1` — the plugin-facing way to start an agent topic
// discussion FROM A CHAT.
//
// The capability takes neither a conversation nor an opener. A plugin says
// "start a discussion with agent X about Y"; the kernel derives WHERE and WHO
// from the inbound turn being answered. That is the security design of this
// seam, and it holds for both halves:
//
//   * WHERE — the conversation comes off the turn, so a granted plugin can open
//     a discussion in the chat it was addressed in and in no other. Were the id
//     an argument, any plugin holding this capability could post a conversation
//     into any chat whose id it could guess or log.
//   * WHO — the opener is the bot that RECEIVED the turn, resolved through the
//     same provisioned-identity table inbound routing uses. A tool plugin is
//     registered once for the whole process and cannot know which agent invoked
//     it; letting it name the opener would mean taking its word for an identity
//     that decides whose name appears in the chat.
//
// Both come from the routines turn context, which channel adapters enter at the
// outer edge of every inbound turn. Outside a channel turn — an HTTP call, a
// schedule, a unit test — there is no turn to read and the start is refused
// rather than guessed.

import type { EphemeralRunHandle } from './ephemeralRunService.js';
import type { ConductorDiscussionService } from './discussionService.js';

/** What an inbound turn tells us about where it is happening and who answered. */
export interface AmbientTurn {
  channelType: string;
  conversationId: string;
  /** Channel identity key of the bot that received the turn (Teams: `28:<appId>`). */
  botChannelKey?: string;
}

export type AmbientTurnResolver = () => AmbientTurn | undefined;

/** Maps a bot's channel identity key back to the agent that owns it. */
export type OpenerResolver = (channelType: string, botChannelKey: string) => string | undefined;

/**
 * No conversation could be attributed to the caller. Distinct from every other
 * refusal because the fix differs: this is not "you may not", it is "I cannot
 * tell where you are" — typically a tool invoked outside a channel turn.
 */
export class DiscussionNoConversationError extends Error {
  constructor() {
    super(
      'no conversation could be attributed to this turn — a discussion starts in the chat it was requested in, and this call did not come from one',
    );
    this.name = 'DiscussionNoConversationError';
  }
}

/**
 * The turn arrived through a bot the kernel cannot attribute to an agent. The
 * honest answer is to refuse: the alternative would be picking an opener, and
 * the opener is whose name ends up on the first message in the chat.
 */
export class DiscussionUnknownOpenerError extends Error {
  constructor(readonly botChannelKey: string | undefined) {
    super(
      botChannelKey
        ? `the bot '${botChannelKey}' that received this turn belongs to no provisioned agent — cannot tell which agent would be opening the discussion`
        : 'this turn carries no bot identity — cannot tell which agent would be opening the discussion',
    );
    this.name = 'DiscussionUnknownOpenerError';
  }
}

export interface StartDiscussionHereInput {
  /** The agent to discuss WITH. The opener is derived from the turn. */
  agentB: string;
  topic: string;
  guidingQuestion?: string;
  ttlMs?: number;
}

/** What `ctx.services.get('conductorDiscussions')` hands a granted plugin. */
export interface ConductorDiscussionsCapability {
  startHere(input: StartDiscussionHereInput): Promise<EphemeralRunHandle>;
}

export function createDiscussionsCapability(deps: {
  discussions: Pick<ConductorDiscussionService, 'start'>;
  resolveTurn: AmbientTurnResolver;
  resolveOpener: OpenerResolver;
  log?: (msg: string) => void;
}): ConductorDiscussionsCapability {
  return {
    async startHere(input) {
      const here = deps.resolveTurn();
      if (!here || here.conversationId.trim().length === 0) {
        throw new DiscussionNoConversationError();
      }
      const opener = here.botChannelKey
        ? deps.resolveOpener(here.channelType, here.botChannelKey)
        : undefined;
      if (!opener) {
        throw new DiscussionUnknownOpenerError(here.botChannelKey);
      }
      deps.log?.(
        `[conductor] discussion requested: '${opener}' with '${input.agentB}' in ${here.channelType}/${here.conversationId}`,
      );
      return deps.discussions.start({
        channelType: here.channelType,
        conversationId: here.conversationId,
        agentA: opener,
        agentB: input.agentB,
        topic: input.topic,
        ...(input.guidingQuestion !== undefined ? { guidingQuestion: input.guidingQuestion } : {}),
        ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
      });
    },
  };
}

/**
 * Read the ambient turn out of a routines turn context.
 *
 * Kept here rather than inline at the wiring site so the channel-shaped
 * `conversationRef` unwrapping has ONE home and a test. The reference is the
 * channel's own handle — for Teams a Bot-Framework `ConversationReference`,
 * whose `bot` field is the recipient of the inbound activity, i.e. exactly the
 * bot that was addressed. This reaches into it structurally and returns
 * undefined on anything it does not recognise: a half-understood reference must
 * not become a confidently wrong conversation or a confidently wrong speaker.
 */
export function ambientTurnFrom(
  context: { channel?: string; conversationRef?: unknown } | undefined,
): AmbientTurn | undefined {
  const channelType = typeof context?.channel === 'string' ? context.channel.trim() : '';
  if (channelType.length === 0) return undefined;
  const ref = context?.conversationRef;
  if (ref === null || typeof ref !== 'object') return undefined;

  const conversation = (ref as { conversation?: unknown }).conversation;
  if (conversation === null || typeof conversation !== 'object') return undefined;
  const id = (conversation as { id?: unknown }).id;
  if (typeof id !== 'string' || id.trim().length === 0) return undefined;

  const bot = (ref as { bot?: unknown }).bot;
  const botId =
    bot !== null && typeof bot === 'object' ? (bot as { id?: unknown }).id : undefined;

  return {
    channelType,
    conversationId: id.trim(),
    ...(typeof botId === 'string' && botId.trim().length > 0
      ? { botChannelKey: botId.trim() }
      : {}),
  };
}
