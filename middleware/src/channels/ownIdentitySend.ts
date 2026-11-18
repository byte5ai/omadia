// Sending as an agent's OWN channel identity (#2043): what the conversation
// send and the targeted (DM) send share.
//
// A facilitator never speaks through another agent's bot. So an own-identity
// send resolves the agent's identity and stops with `no_identity` when there
// is none; there is no fallback to the default bot. Permission does not come
// from an ephemeral attachment (the discussion relay's scope) but from the
// agent's message subscription: it may post into a conversation it moderates,
// and DM the people of such a conversation.

import type {
  ChannelUserKind,
  ChannelUserRef,
  ConversationRoster,
  TargetedDeliveryOutcome,
  TargetedMention,
  TargetedPoll,
} from '@omadia/channel-sdk';
import { parsePrincipal } from '@omadia/channel-sdk';

import type { ConversationMessageHub } from './conversationMessages/hub.js';
import type { MessageSubscription } from './conversationMessages/store.js';

export interface OwnIdentityDeps {
  /** The agent's OWN identity on a channel; never the default bot. */
  readonly identityFor: (agentSlug: string, channelType: string) => { channelKey: string } | undefined;
  /** The subscriptions that carry the permission. Absent (no database) =
   *  no own-identity send is permitted. */
  readonly subscriptions?: Pick<ConversationMessageHub, 'subscriptionFor' | 'subscriptionsOf' | 'findAuthor'>;
  readonly getRoster?: (channelType: string, conversationId: string) => Promise<ConversationRoster | undefined>;
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
      roster = await deps.getRoster?.(subscription.channelType, subscription.conversationId);
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

/** Plugin-form mentions resolved to channel user references. A person who is
 *  not part of the conversation is left out: the text stays as it is. */
export async function resolveMentions(
  deps: OwnIdentityDeps,
  subscriptions: readonly MessageSubscription[],
  mentions: readonly { readonly user: unknown; readonly text: unknown }[] | undefined,
): Promise<TargetedMention[]> {
  const resolved: TargetedMention[] = [];
  for (const mention of mentions ?? []) {
    if (typeof mention?.text !== 'string' || mention.text.length === 0) continue;
    // Already a channel reference (a kernel-internal caller): passed on.
    if (mention.user !== null && typeof mention.user === 'object') {
      resolved.push({ user: mention.user as ChannelUserRef, text: mention.text });
      continue;
    }
    if (typeof mention.user !== 'string') continue;
    const user = await resolveChannelUser(deps, subscriptions, mention.user);
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
  const poll = raw as { pollId?: unknown; question?: unknown; options?: unknown; hint?: unknown };
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
    },
  };
}
