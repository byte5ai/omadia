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
  /** The agents to discuss WITH — one or several. The opener comes from the turn. */
  partners: readonly string[];
  topic: string;
  guidingQuestion?: string;
  /** Ceiling on contributions; the service clamps it. Absent = its default. */
  maxTurns?: number;
  ttlMs?: number;
}

export interface DiscussionPartner {
  slug: string;
  /** The bot's name as people read it in the chat. */
  name: string;
}

/**
 * Everyone who could take part in one conversation: agents with a provisioned
 * identity for the channel whose bot is actually PRESENT in that chat.
 *
 * Presence matters, not just provisioning. A partner whose bot was never added
 * to the chat has no conversation reference there, so its turns would be
 * generated, charged and then dropped — the half-silent discussion this design
 * refuses to produce.
 */
export type PartnerLister = (
  channelType: string,
  conversationId: string,
) => Promise<readonly DiscussionPartner[]>;

/** What `ctx.services.get('conductorDiscussions')` hands a granted plugin. */
export interface ConductorDiscussionsCapability {
  startHere(input: StartDiscussionHereInput): Promise<EphemeralRunHandle>;
  partnersHere(): Promise<readonly DiscussionPartner[]>;
}

/**
 * The named partner is not someone this chat can hear from. Carries the real
 * candidates so the caller can correct itself in one step — the first live
 * attempt died because the model guessed a roster, guessed wrong, and stopped.
 */
export class DiscussionUnknownPartnerError extends Error {
  constructor(
    readonly requested: string,
    readonly candidates: readonly DiscussionPartner[],
  ) {
    super(
      candidates.length > 0
        ? `'${requested}' is not an agent with its own bot in this chat`
        : `'${requested}' is not available here, and no other agent has its own bot in this chat`,
    );
    this.name = 'DiscussionUnknownPartnerError';
  }
}

/** Match a free-text partner reference against a candidate: people name the bot
 *  the way the chat shows it ('Messias'), models reach for the slug. Accept both,
 *  case- and whitespace-insensitively. */
function matchesPartner(requested: string, partner: DiscussionPartner): boolean {
  const want = requested.trim().toLowerCase();
  return partner.slug.toLowerCase() === want || partner.name.trim().toLowerCase() === want;
}

export function createDiscussionsCapability(deps: {
  discussions: Pick<ConductorDiscussionService, 'start'>;
  resolveTurn: AmbientTurnResolver;
  resolveOpener: OpenerResolver;
  listPartners: PartnerLister;
  log?: (msg: string) => void;
}): ConductorDiscussionsCapability {
  /** The turn's conversation + the agent that answered it, or a typed refusal. */
  const resolveHere = (): { turn: AmbientTurn; opener: string } => {
    const turn = deps.resolveTurn();
    if (!turn || turn.conversationId.trim().length === 0) {
      throw new DiscussionNoConversationError();
    }
    const opener = turn.botChannelKey
      ? deps.resolveOpener(turn.channelType, turn.botChannelKey)
      : undefined;
    if (!opener) throw new DiscussionUnknownOpenerError(turn.botChannelKey);
    return { turn, opener };
  };

  return {
    async partnersHere() {
      const { turn, opener } = resolveHere();
      const all = await deps.listPartners(turn.channelType, turn.conversationId);
      return all.filter((p) => p.slug !== opener);
    },

    async startHere(input) {
      const { turn, opener } = resolveHere();

      // Resolve every named partner against who can ACTUALLY speak in this
      // chat. This is where a guessed name is caught — before a run exists,
      // before a floor is claimed, and with the real candidates attached.
      const candidates = (await deps.listPartners(turn.channelType, turn.conversationId)).filter(
        (p) => p.slug !== opener,
      );
      const named = Array.isArray(input.partners) ? input.partners : [];
      if (named.length === 0) {
        throw new DiscussionUnknownPartnerError('', candidates);
      }
      const resolved: string[] = [];
      for (const wanted of named) {
        const partner = candidates.find((p) => matchesPartner(wanted, p));
        // One unknown name fails the whole start rather than quietly dropping a
        // participant: a discussion missing the agent someone asked for is not
        // the discussion they asked for.
        if (!partner) throw new DiscussionUnknownPartnerError(wanted, candidates);
        if (!resolved.includes(partner.slug)) resolved.push(partner.slug);
      }

      deps.log?.(
        `[conductor] discussion requested: '${opener}' with ${resolved.join(', ')} in ${turn.channelType}/${turn.conversationId}`,
      );
      return deps.discussions.start({
        channelType: turn.channelType,
        conversationId: turn.conversationId,
        // The opener speaks first and closes; then the RESOLVED slugs, never
        // the caller's spelling — a display name must not reach the registry as
        // if it were a slug.
        participants: [opener, ...resolved],
        topic: input.topic,
        ...(input.guidingQuestion !== undefined ? { guidingQuestion: input.guidingQuestion } : {}),
        ...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
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
