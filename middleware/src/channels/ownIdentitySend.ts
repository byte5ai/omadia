// Sending as an agent's OWN channel identity (#2043): what the conversation
// send and the targeted (DM) send share.
//
// A facilitator never speaks through another agent's bot. So an own-identity
// send resolves the agent's identity and stops with `no_identity` when there
// is none; there is no fallback to the default bot. Permission does not come
// from an ephemeral attachment (the discussion relay's scope): a post into a
// conversation is authorized by an execution scope (`scopedSendService.ts`),
// and a person is only written to when they are part of a conversation one
// of the agent's processes is subscribed to.

import type {
  AiDisclosure,
  ChannelUserKind,
  ChannelUserRef,
  ConversationRoster,
  DisclosureSeenStore,
  SendProviderCapabilities,
  TargetedDeliveryOutcome,
  TargetedMention,
  TargetedMessage,
  TargetedPoll,
} from '@omadia/channel-sdk';
import { applyAiDisclosure, parsePrincipal, resolveAiDisclosure } from '@omadia/channel-sdk';

import type { ConversationMessageHub } from './conversationMessages/hub.js';
import type { MessageSubscription } from './conversationMessages/store.js';

export interface OwnIdentityDeps {
  /** The agent's OWN identity on a channel; never the default bot. */
  readonly identityFor: (agentSlug: string, channelType: string) => { channelKey: string } | undefined;
  /** The message subscriptions people are looked up in. Absent (no
   *  database) = nobody is found, so no person is mentioned or written to. */
  readonly subscriptions?: Pick<ConversationMessageHub, 'subscriptionsOf' | 'findAuthor'>;
  /** `asChannelKey`: the roster is read as the agent's own identity (the
   *  subscription's), never as the channel's default bot. */
  readonly getRoster?: (
    channelType: string,
    conversationId: string,
    opts?: { readonly asChannelKey?: string },
  ) => Promise<ConversationRoster | undefined>;
  /**
   * #2088 — does the agent's archetype add posting as its own identity
   * (`own_identity_send` in its descriptor)? Absent = not asked (hosts
   * without an agent registry, unit tests).
   */
  readonly archetypeAddsOwnIdentitySend?: (agentSlug: string) => boolean;
  /** The AI marking of what an agent posts as itself; see
   *  {@link markOwnIdentityMessage}. Absent = the text goes out as given. */
  readonly disclosure?: OwnIdentityDisclosure;
}

export interface OwnIdentityDisclosure {
  /** The instance's disclosure for this agent on this channel, by the same
   *  rule as its turn answers. `undefined` = the operator turned it off. */
  /** `text` is the message being posted: the line follows its language (ADR-0320). */
  readonly disclosureFor: (
    agentSlug: string,
    channelType: string,
    text?: string,
  ) => AiDisclosure | undefined;
  /** Where the sentence was already posted (per agent, channel and target). */
  readonly seen: DisclosureSeenStore;
}

/**
 * The AI marking of a message an agent posts as itself (#2043), by the one
 * rule every message under an agent's name follows: the channel's own AI
 * label where it has one, the instance's disclosure sentence otherwise, once,
 * never both.
 *
 * - The channel declares `supports.aiLabel`: it labels every such message
 *   itself. The text goes out as it is.
 * - Otherwise the instance's disclosure line is folded into the FIRST message
 *   the agent posts to that target, as a turn answer folds it into the first
 *   answer of a conversation. `delivered()` records that it went out: a send
 *   the channel refused does not use up the marking.
 *
 * Deterministic engine texts and texts from `agentTurn` are treated alike:
 * `agentTurn` returns its text without the sentence, so the marking is
 * decided here, at the send, and only here.
 */
export function markOwnIdentityMessage(
  disclosure: OwnIdentityDisclosure | undefined,
  at: { readonly agentSlug: string; readonly channelType: string; readonly target: string },
  message: TargetedMessage,
  supports: SendProviderCapabilities | undefined,
): { readonly message: TargetedMessage; readonly delivered: () => void } {
  const unchanged = { message, delivered: () => undefined };
  if (!disclosure || supports?.aiLabel === true) return unchanged;
  let line: AiDisclosure | undefined;
  let alreadyShown: boolean;
  const scope = `own-identity::${at.agentSlug}::${at.channelType}::${at.target}`;
  try {
    line = disclosure.disclosureFor(at.agentSlug, at.channelType, message.text);
    alreadyShown = disclosure.seen.hasSeen(scope);
  } catch {
    // Undeterminable = mark, with the shipping default: a repeated sentence
    // is noise, a missing one is the gap.
    line = resolveAiDisclosure();
    alreadyShown = false;
  }
  if (!line || alreadyShown) return unchanged;
  return {
    message: { ...message, text: applyAiDisclosure(message.text, { disclosure: line }).text },
    delivered: () => {
      try {
        disclosure.seen.markSeen(scope);
      } catch {
        // The next message is marked again.
      }
    },
  };
}

/** The refusal for an agent whose archetype does not add own-identity sends. */
export function ownIdentitySendNotAdded(deps: OwnIdentityDeps | undefined, agentSlug: string): string | undefined {
  if (!deps?.archetypeAddsOwnIdentitySend || deps.archetypeAddsOwnIdentitySend(agentSlug)) return undefined;
  return `the archetype of agent '${agentSlug}' does not add posting as its own identity`;
}

export function unreachable(
  code: Extract<TargetedDeliveryOutcome, { outcome: 'unreachable' }>['code'] | 'no_identity',
  message: string,
): TargetedDeliveryOutcome {
  // 'no_identity' is the kernel's own refusal, not a provider code; the
  // plugin-facing outcome types carry `code: string`.
  return { outcome: 'unreachable', code: code as never, message };
}

/** The channel user id a 'user:<id>' principal or a bare id stands for. */
export function channelUserIdOf(userOrPrincipal: string): string | undefined {
  const trimmed = typeof userOrPrincipal === 'string' ? userOrPrincipal.trim() : '';
  if (trimmed.length === 0) return undefined;
  const principal = parsePrincipal(trimmed);
  if (principal) return principal.kind === 'user' ? principal.userId : undefined;
  return trimmed.toLowerCase();
}

function rosterMatch(roster: ConversationRoster | undefined, userIdLowerCase: string): ChannelUserRef | undefined {
  const member = roster?.participants.find(
    (p) =>
      p.isBot !== true &&
      (p.userRef.id.toLowerCase() === userIdLowerCase ||
        (typeof p.externalId === 'string' && p.externalId.toLowerCase() === userIdLowerCase)),
  );
  return member?.userRef;
}

/**
 * The channel's own reference for a person, looked up where the agent
 * moderates: the conversation's roster first (it knows people who have not
 * written yet), then the authors of stored messages (it works without a
 * roster provider). `undefined` = not a person of these conversations.
 */
export async function resolveChannelUser(
  deps: OwnIdentityDeps,
  subscriptions: readonly MessageSubscription[],
  userOrPrincipal: string,
): Promise<ChannelUserRef | undefined> {
  const userId = channelUserIdOf(userOrPrincipal);
  if (!userId) return undefined;
  for (const subscription of subscriptions) {
    let roster: ConversationRoster | undefined;
    try {
      roster = await deps.getRoster?.(subscription.channelType, subscription.conversationId, {
        asChannelKey: subscription.channelKey,
      });
    } catch {
      roster = undefined;
    }
    const fromRoster = rosterMatch(roster, userId);
    if (fromRoster) return fromRoster;
    const author = await deps.subscriptions?.findAuthor(subscription, userId).catch(() => undefined);
    if (author) {
      return {
        kind: author.kind as ChannelUserKind,
        id: author.id,
        ...(author.displayName !== undefined ? { displayName: author.displayName } : {}),
      };
    }
  }
  return undefined;
}

/** Mentions resolved to channel user references. A person who is not part of
 *  the conversation is left out: the text stays as it is. */
export async function resolveMentions(
  deps: OwnIdentityDeps,
  subscriptions: readonly MessageSubscription[],
  mentions: readonly { readonly user: unknown; readonly text: unknown }[] | undefined,
): Promise<TargetedMention[]> {
  const resolved: TargetedMention[] = [];
  for (const mention of mentions ?? []) {
    if (typeof mention?.text !== 'string' || mention.text.length === 0) continue;
    // ALWAYS resolved against the conversation, whatever shape arrives. An
    // object-shaped reference is a plugin's claim about who somebody is; the
    // kernel takes only the id from it and looks the person up itself, so a
    // plugin cannot mention (and thereby notify) somebody who is not there.
    const stated =
      typeof mention.user === 'string'
        ? mention.user
        : mention.user !== null &&
            typeof mention.user === 'object' &&
            typeof (mention.user as { id?: unknown }).id === 'string'
          ? (mention.user as { id: string }).id
          : undefined;
    if (stated === undefined) continue;
    const user = await resolveChannelUser(deps, subscriptions, stated);
    if (user) resolved.push({ user, text: mention.text });
  }
  return resolved;
}

const MAX_POLL_TEXT = 128;
const MIN_POLL_OPTIONS = 2;
const MAX_POLL_OPTIONS = 6;

function isShortText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_POLL_TEXT;
}

/** Validate a poll at the kernel boundary. Returns the poll, or the reason
 *  it is refused (nothing is posted then). */
export function readPoll(raw: unknown): { poll: TargetedPoll } | { error: string } {
  if (raw === null || typeof raw !== 'object') return { error: 'poll must be an object' };
  const poll = raw as { pollId?: unknown; question?: unknown; options?: unknown; hint?: unknown; multipleAnswers?: unknown };
  if (!isShortText(poll.pollId)) return { error: 'pollId must be 1..128 characters' };
  if (typeof poll.question !== 'string' || poll.question.trim().length === 0) {
    return { error: 'question must not be empty' };
  }
  if (
    !Array.isArray(poll.options) ||
    poll.options.length < MIN_POLL_OPTIONS ||
    poll.options.length > MAX_POLL_OPTIONS
  ) {
    return { error: 'a poll needs 2..6 options' };
  }
  const options: { id: string; label: string }[] = [];
  for (const option of poll.options as { id?: unknown; label?: unknown }[]) {
    if (!isShortText(option?.id) || typeof option.label !== 'string' || option.label.trim().length === 0) {
      return { error: 'every option needs an id (1..128 characters) and a label' };
    }
    if (options.some((o) => o.id === option.id)) return { error: `option id '${option.id}' is not unique` };
    options.push({ id: option.id, label: option.label });
  }
  return {
    poll: {
      pollId: poll.pollId,
      question: poll.question,
      options,
      ...(typeof poll.hint === 'string' && poll.hint.trim().length > 0 ? { hint: poll.hint } : {}),
      ...(poll.multipleAnswers === true ? { multipleAnswers: true } : {}),
    },
  };
}
