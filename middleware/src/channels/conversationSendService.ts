// Posting into a conversation as an agent's OWN identity: the kernel-internal
// delivery behind 'conversationSend@2' (`scopedSendService.ts`). Deliberately
// thin next to targetedDeliveryService: no principal resolution, one
// conversation, one delivery, and like every delivery path here,
// unreachability is a named outcome, never a throw.
//
// The message is posted as the agent's own bot. No identity → `no_identity`,
// never another bot. This module does not decide WHETHER the agent may post:
// its caller drew an authorization from an execution scope (#2091) and hands
// in the ground it stands on, the subscriptions of the process. Mentions are
// resolved against those.
//
// Two earlier permissions are gone: an ephemeral attachment with a post
// through the channel's default bot (#330 C3b, the plugin-era facilitation),
// and a message subscription without a process (the first major of
// 'conversationSend', removed with #2067). Agent discussions never used this
// service; they speak through `sayService`.

import type {
  CardUpdateOutcome,
  ConversationSendProvider,
  TargetedDeliveryOutcome,
  TargetedMessage,
} from '@omadia/channel-sdk';
import { CARD_QUESTION_KINDS, type ConversationSendCapabilities, type QuestionCard } from '@omadia/plugin-api';

import type { MessageSubscription } from './conversationMessages/store.js';
import type { ConversationSendRegistry } from './conversationSendRegistry.js';
import {
  markOwnIdentityMessage,
  ownIdentitySendNotAdded,
  readPoll,
  resolveMentions,
  unreachable,
  type OwnIdentityDeps,
} from './ownIdentitySend.js';
import {
  canGoOutAsText,
  cardAsPlainMessage,
  pollAsCard,
  pollAsPlainMessage,
  questionExpiry,
  type OpenCardQuestionStore,
} from './openCardQuestions.js';
import { cardRefusalFor, readCardSupport, readCardUpdate, readQuestionCard } from './questionCard.js';

export interface ConversationSendInput {
  agentSlug: string;
  channelType: string;
  conversationId: string;
  /** `mentions[].user` may be the plugin form (a principal or channel user
   *  id as a string) or an already resolved channel user reference. */
  message: Omit<TargetedMessage, 'mentions' | 'poll' | 'card'> & {
    mentions?: readonly { user: unknown; text: string }[];
    poll?: unknown;
    /** #2089 — validated here; see `questionCard.ts`. */
    card?: unknown;
  };
}

export interface ConversationCardUpdateInput {
  agentSlug: string;
  channelType: string;
  conversationId: string;
  cardMessageId: string;
  update: unknown;
}

/**
 * #2091 — what an own-identity action stands on: an execution scope
 * authorized it (`conversationSend@2`) for a process, and `subscriptions`
 * are that process's. Mentions are resolved against them.
 */
export interface AuthorizedSendGround {
  readonly subscriptions: readonly MessageSubscription[];
}

export interface ConversationSendService {
  /** Post as the agent's own identity. The caller has authorized the post. */
  sendToConversation(input: ConversationSendInput, ground: AuthorizedSendGround): Promise<TargetedDeliveryOutcome>;
  /** #2089 — what the channel's plugin declares; `undefined` = no provider. */
  capabilities(channelType: string): ConversationSendCapabilities | undefined;
  /** #2089 — update a card the agent posted; same identity rules as a send. */
  updateCard(input: ConversationCardUpdateInput, ground: AuthorizedSendGround): Promise<CardUpdateOutcome>;
}

/** The question kinds a person can answer by typing (#2086). */
const TEXT_CARD_KINDS = CARD_QUESTION_KINDS.filter((kind) => kind !== 'assignment');

const NO_GROUND =
  'an agent posts as itself only under an execution scope that authorized it (conversationSend@2)';

export function createConversationSendService(deps: {
  providers: ConversationSendRegistry;
  /** Own-identity sends. Absent (no registry) → every send is refused. */
  ownIdentity?: OwnIdentityDeps;
  /**
   * #2086 — where a card or poll that went out as plain text keeps its open
   * question, so a typed reply can become a `card_answer`. Absent: such a card
   * is refused as before and the sender posts its own chat ballot.
   */
  openQuestions?: OpenCardQuestionStore;
  /** Told about every message that went out as an agent's own identity. */
  onOwnIdentityDelivered?: (agentSlug: string, channelType: string, conversationId: string) => void;
  log?: (msg: string) => void;
}): ConversationSendService {
  const log = deps.log ?? (() => undefined);

  /** What goes to the provider: the message as it is, or its plain-text form. */
  type PlainForm =
    | { message: TargetedMessage; question?: OpenQuestionToKeep }
    | { refusal: string };
  interface OpenQuestionToKeep {
    card: QuestionCard;
    asPoll: boolean;
  }

  function plainFormOf(message: TargetedMessage, provider: ConversationSendProvider, channelType: string): PlainForm {
    const { poll, card, ...rest } = message;
    const canKeep = deps.openQuestions !== undefined;
    if (poll && provider.supports?.poll !== true) {
      if (!canKeep) return { refusal: `the '${channelType}' channel plugin does not declare poll support` };
      return {
        message: { ...rest, text: pollAsPlainMessage(message.text, poll) },
        question: { card: pollAsCard(poll), asPoll: true },
      };
    }
    if (card) {
      const refusal = cardRefusalFor(card, readCardSupport(provider.supports?.card), channelType);
      if (refusal === undefined) return { message };
      if (!canKeep || !canGoOutAsText(card)) return { refusal: `${refusal} — nothing was posted` };
      return {
        message: { ...rest, text: cardAsPlainMessage(message.text, card) },
        question: { card, asPoll: false },
      };
    }
    return { message };
  }

  /** Remember the question of a card or poll that went out as text, and say which message carries it. */
  async function keepQuestionOpen(
    input: ConversationSendInput,
    outcome: Extract<TargetedDeliveryOutcome, { outcome: 'delivered' }>,
    question: OpenQuestionToKeep,
  ): Promise<TargetedDeliveryOutcome> {
    // A channel that reports no message id still gets its question tracked:
    // an addressed reply in a conversation with one open question is matched
    // without one.
    const messageId = outcome.cardMessageId ?? outcome.messageId ?? `card:${question.card.cardId}`;
    try {
      await deps.openQuestions?.register({
        channelType: input.channelType,
        conversationId: input.conversationId,
        messageId,
        agentSlug: input.agentSlug,
        card: question.card,
        ...(question.asPoll ? { asPoll: true } : {}),
        expiresAt: questionExpiry(question.card, new Date()),
      });
    } catch (err) {
      // The message is out; a lost question only means a typed reply stays a message.
      log(
        `[channels] could not keep the question of ${question.card.cardId} open: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { ...outcome, cardMessageId: messageId };
  }

  async function deliver(
    input: ConversationSendInput,
    message: TargetedMessage,
    asChannelKey: string,
  ): Promise<TargetedDeliveryOutcome> {
    const provider = deps.providers.get(input.channelType);
    if (!provider) {
      return unreachable(
        'channel_error',
        `no conversation-send provider registered for channel type '${input.channelType}'`,
      );
    }
    // The kernel cannot see whether a provider honoured `asChannelKey`: one
    // that predates the option ignores it and reports `delivered` through its
    // default bot. So only a provider that DECLARED it is asked.
    if (provider.supports?.asChannelKey !== true) {
      log(
        `[channels] own-identity send to ${input.channelType}/${input.conversationId} refused: the channel plugin does not declare supports.asChannelKey`,
      );
      return unreachable(
        'no_identity',
        `the '${input.channelType}' channel plugin does not declare that it sends as a named identity — nothing was posted, so nothing could go out under another bot's name`,
      );
    }
    // #2086 — a card or poll the channel does not show natively goes out as
    // numbered text, and its question stays open for a typed reply. Only with a
    // store to keep it in: otherwise the sender gets the refusal it always got
    // and posts its own chat ballot.
    const plain = plainFormOf(message, provider, input.channelType);
    if ('refusal' in plain) return unreachable('channel_error', plain.refusal);
    const outgoing = plain.message;
    // Mentions degrade by contract: a channel without them shows plain text.
    const { mentions, ...withoutMentions } = outgoing;
    const marked = markOwnIdentityMessage(
      deps.ownIdentity?.disclosure,
      { agentSlug: input.agentSlug, channelType: input.channelType, target: input.conversationId },
      mentions && provider.supports.mentions !== true ? withoutMentions : outgoing,
      provider.supports,
    );
    try {
      const outcome = await provider.sendToConversation(input.conversationId, marked.message, { asChannelKey });
      if (outcome.outcome === 'delivered') {
        marked.delivered();
        if (plain.question) return keepQuestionOpen(input, outcome, plain.question);
      }
      return outcome;
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      log(`[channels] conversation send to ${input.channelType}/${input.conversationId} threw: ${text}`);
      return unreachable('channel_error', text);
    }
  }

  async function sendAsOwnIdentity(
    input: ConversationSendInput,
    ground: AuthorizedSendGround,
  ): Promise<TargetedDeliveryOutcome> {
    const identity = ownIdentityOf(input);
    if ('outcome' in identity) return identity;
    let poll: TargetedMessage['poll'];
    if (input.message.poll !== undefined) {
      const read = readPoll(input.message.poll);
      if ('error' in read) return unreachable('channel_error', `invalid poll: ${read.error}`);
      poll = read.poll;
    }
    let card: TargetedMessage['card'];
    if (input.message.card !== undefined) {
      if (poll) return unreachable('channel_error', 'a message is a poll or a question card, not both');
      const read = readQuestionCard(input.message.card);
      if ('error' in read) return unreachable('channel_error', `invalid card: ${read.error}`);
      card = read.card;
    }
    const mentions = await resolveMentions(identity.own, ground.subscriptions, input.message.mentions);
    const message: TargetedMessage = {
      text: input.message.text,
      ...(input.message.attachments ? { attachments: input.message.attachments } : {}),
      ...(mentions.length > 0 ? { mentions } : {}),
      ...(poll ? { poll } : {}),
      ...(card ? { card } : {}),
    };
    const outcome = await deliver(input, message, identity.channelKey);
    if (outcome.outcome === 'delivered') {
      deps.onOwnIdentityDelivered?.(input.agentSlug, input.channelType, input.conversationId);
    }
    return outcome;
  }

  /** The identity an own-identity action goes out as, or the refusal. */
  function ownIdentityOf(scope: {
    agentSlug: string;
    channelType: string;
  }): { own: OwnIdentityDeps; channelKey: string } | Extract<TargetedDeliveryOutcome, { outcome: 'unreachable' }> {
    const own = deps.ownIdentity;
    const notAdded = ownIdentitySendNotAdded(own, scope.agentSlug);
    if (notAdded) {
      return unreachable('not_permitted', notAdded) as Extract<TargetedDeliveryOutcome, { outcome: 'unreachable' }>;
    }
    const identity = own?.identityFor(scope.agentSlug, scope.channelType);
    if (!own || !identity) {
      return unreachable(
        'no_identity',
        `agent '${scope.agentSlug}' has no ${scope.channelType} identity of its own — it does not post through another agent's bot`,
      ) as Extract<TargetedDeliveryOutcome, { outcome: 'unreachable' }>;
    }
    return { own, channelKey: identity.channelKey };
  }

  function capabilitiesOf(provider: ConversationSendProvider): ConversationSendCapabilities {
    const card = readCardSupport(provider.supports?.card);
    // #2086 — with a store for open questions every channel can ask: what it
    // does not show natively goes out as numbered text and a typed reply comes
    // back as the same answer event.
    const asText = deps.openQuestions !== undefined;
    return {
      asOwnIdentity: provider.supports?.asChannelKey === true,
      mentions: provider.supports?.mentions === true,
      poll: provider.supports?.poll === true || asText,
      // `update` is only true when the method is really there.
      ...(card
        ? { card: { ...card, update: card.update && typeof provider.updateCard === 'function' } }
        : asText
          ? { card: { kinds: TEXT_CARD_KINDS, maxQuestions: 1, update: false } }
          : {}),
    };
  }

  return {
    capabilities(channelType) {
      const provider = typeof channelType === 'string' ? deps.providers.get(channelType) : undefined;
      return provider ? capabilitiesOf(provider) : undefined;
    },

    async updateCard(input, ground) {
      const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
      if (
        !isText(input?.agentSlug, 128) ||
        !isText(input.channelType, 64) ||
        !isText(input.conversationId, 512) ||
        !isText(input.cardMessageId, 512)
      ) {
        return {
          outcome: 'unreachable',
          code: 'not_permitted',
          message: 'agentSlug, channelType, conversationId and cardMessageId are required',
        };
      }
      if (!ground) {
        return { outcome: 'unreachable', code: 'not_permitted', message: NO_GROUND };
      }
      const identity = ownIdentityOf(input);
      if ('outcome' in identity) return identity;
      const provider = deps.providers.get(input.channelType);
      if (!provider) {
        return unreachable('channel_error', `no conversation-send provider registered for channel type '${input.channelType}'`) as CardUpdateOutcome;
      }
      // Same rule as a send: only a provider that DECLARED it acts as a named
      // identity is asked to act as the agent.
      if (provider.supports?.asChannelKey !== true) {
        return unreachable(
          'no_identity',
          `the '${input.channelType}' channel plugin does not declare that it sends as a named identity — nothing was updated`,
        ) as CardUpdateOutcome;
      }
      const support = capabilitiesOf(provider).card;
      if (!support?.update || !provider.updateCard) {
        return unreachable(
          'channel_error',
          `the '${input.channelType}' channel plugin cannot update a posted card — post the result as text`,
        ) as CardUpdateOutcome;
      }
      const read = readCardUpdate(input.update);
      if ('error' in read) return unreachable('channel_error', `invalid card update: ${read.error}`) as CardUpdateOutcome;
      if (read.update.state === 'open') {
        const refusal = cardRefusalFor(read.update.card, support, input.channelType);
        if (refusal) return unreachable('channel_error', `${refusal} — nothing was updated`) as CardUpdateOutcome;
      }
      try {
        return await provider.updateCard(input.conversationId, input.cardMessageId, read.update, {
          asChannelKey: identity.channelKey,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        log(`[channels] card update in ${input.channelType}/${input.conversationId} threw: ${text}`);
        return unreachable('channel_error', text) as CardUpdateOutcome;
      }
    },

    async sendToConversation(input, ground) {
      if (typeof input.agentSlug !== 'string' || input.agentSlug.trim().length === 0) {
        return { outcome: 'unreachable', code: 'not_permitted', message: 'agentSlug is required' };
      }
      // The type requires the ground; a caller that got here without one (a
      // cast, plain JavaScript) has no authorization, so nothing is posted.
      if (!ground) {
        log(
          `[channels] conversation send by '${input.agentSlug}' to ${input.channelType}/${input.conversationId} refused (no authorization)`,
        );
        return { outcome: 'unreachable', code: 'not_permitted', message: NO_GROUND };
      }
      return sendAsOwnIdentity(input, ground);
    },
  };
}
