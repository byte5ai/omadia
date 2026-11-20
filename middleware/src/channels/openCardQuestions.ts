// Question cards as plain text (#2086, spec 2042 §5.14 channel parity).
//
// A channel that cannot show a question card natively still gets one: the
// kernel posts it as numbered text (`renderCardAsText`) and keeps the question
// open here. A reply that fits it (`parseCardReply`) becomes the same typed
// `card_answer` event a card submission would be, so the engine that asked
// cannot tell the difference, and a channel plugin needs no card code of its
// own. Deterministic, no model.
//
// Only one-question cards go out this way, because a typed reply answers one
// question. A reply is taken when it points at the question's message, or —
// the private-chat case — when it addresses the bot and is the only open
// question of the conversation. A message that does not fit stays what it
// was: an ordinary message the receiver sees as such.

import { parseCardReply, renderCardAsText, type ConversationMessageEvent } from '@omadia/channel-sdk';
import type { CardAnswerValue, QuestionCard } from '@omadia/plugin-api';
import type { Pool } from 'pg';

/** A question stays open this long when the card names no close. */
export const DEFAULT_OPEN_QUESTION_MS = 24 * 60 * 60 * 1000;

export interface OpenCardQuestion {
  readonly channelType: string;
  readonly conversationId: string;
  /** The platform id of the posted message; what a reply points at. */
  readonly messageId: string;
  readonly agentSlug: string;
  readonly card: QuestionCard;
  /** A poll that went out as text: the answer is `{ optionId }`, the poll id the card id. */
  readonly asPoll?: boolean;
  readonly expiresAt: Date;
}

export interface OpenCardQuestionStore {
  register(question: OpenCardQuestion): Promise<void>;
  /** The questions of a conversation that have not closed at `now`. */
  listOpen(channelType: string, conversationId: string, now: Date): Promise<readonly OpenCardQuestion[]>;
}

export class InMemoryOpenCardQuestionStore implements OpenCardQuestionStore {
  readonly #questions = new Map<string, OpenCardQuestion>();

  register(question: OpenCardQuestion): Promise<void> {
    const now = Date.now();
    for (const [key, open] of this.#questions) if (open.expiresAt.getTime() <= now) this.#questions.delete(key);
    this.#questions.set(`${question.channelType}\n${question.conversationId}\n${question.messageId}`, question);
    return Promise.resolve();
  }

  listOpen(channelType: string, conversationId: string, now: Date): Promise<readonly OpenCardQuestion[]> {
    return Promise.resolve(
      [...this.#questions.values()].filter(
        (q) => q.channelType === channelType && q.conversationId === conversationId && q.expiresAt > now,
      ),
    );
  }
}

interface QuestionRow {
  channel_type: string;
  conversation_id: string;
  message_id: string;
  agent_slug: string;
  card: QuestionCard;
  as_poll: boolean;
  expires_at: Date;
}

/** Migration 0101. */
export class PgOpenCardQuestionStore implements OpenCardQuestionStore {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async register(question: OpenCardQuestion): Promise<void> {
    await this.pool.query('DELETE FROM open_card_questions WHERE expires_at <= now()');
    await this.pool.query(
      `INSERT INTO open_card_questions (channel_type, conversation_id, message_id, agent_slug, card_id, card, as_poll, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
       ON CONFLICT (channel_type, conversation_id, message_id)
       DO UPDATE SET agent_slug = EXCLUDED.agent_slug, card_id = EXCLUDED.card_id,
                     card = EXCLUDED.card, as_poll = EXCLUDED.as_poll, expires_at = EXCLUDED.expires_at`,
      [
        question.channelType,
        question.conversationId,
        question.messageId,
        question.agentSlug,
        question.card.cardId,
        JSON.stringify(question.card),
        question.asPoll === true,
        question.expiresAt,
      ],
    );
  }

  async listOpen(channelType: string, conversationId: string, now: Date): Promise<readonly OpenCardQuestion[]> {
    const { rows } = await this.pool.query<QuestionRow>(
      `SELECT channel_type, conversation_id, message_id, agent_slug, card, as_poll, expires_at
         FROM open_card_questions
        WHERE channel_type = $1 AND conversation_id = $2 AND expires_at > $3`,
      [channelType, conversationId, now],
    );
    return rows.map((r) => ({
      channelType: r.channel_type,
      conversationId: r.conversation_id,
      messageId: r.message_id,
      agentSlug: r.agent_slug,
      card: r.card,
      ...(r.as_poll ? { asPoll: true } : {}),
      expiresAt: r.expires_at,
    }));
  }
}

/** Whether a card can go out as text: one question, of a kind a person can type. */
export function canGoOutAsText(card: QuestionCard): boolean {
  const only = card.questions.length === 1 ? card.questions[0] : undefined;
  return only !== undefined && only.kind !== 'assignment';
}

/** The text a card is posted as: the sender's lead-in, then the numbered question. */
export function cardAsPlainMessage(lead: string, card: QuestionCard): string {
  const body = renderCardAsText(card);
  return lead.trim().length > 0 ? `${lead.trim()}\n\n${body}` : body;
}

/** When the question closes: the card's own close, else a day after the post. */
export function questionExpiry(card: QuestionCard, postedAt: Date): Date {
  const closes = card.closesAt !== undefined ? new Date(card.closesAt) : undefined;
  return closes !== undefined && !Number.isNaN(closes.getTime())
    ? closes
    : new Date(postedAt.getTime() + DEFAULT_OPEN_QUESTION_MS);
}

function pickQuestion(
  open: readonly OpenCardQuestion[],
  event: ConversationMessageEvent,
): OpenCardQuestion | undefined {
  if (event.replyToMessageId !== undefined) return open.find((q) => q.messageId === event.replyToMessageId);
  const only = open.length === 1 ? open[0] : undefined;
  // Without a reply only a message that addresses the bot counts, and never a
  // free-text question: any addressed sentence would answer it.
  return event.addressedToBot === true && only !== undefined && only.card.questions[0]?.kind !== 'text'
    ? only
    : undefined;
}

/**
 * The `card_answer` event a typed reply stands for, or `undefined` when the
 * message is not a reply to an open question or does not fit it. The author is
 * the platform's statement of who wrote the message, so the answer is theirs.
 */
export async function typedReplyAsCardAnswer(
  store: OpenCardQuestionStore,
  event: ConversationMessageEvent,
  now: Date,
): Promise<ConversationMessageEvent | undefined> {
  if (event.kind !== 'created' || event.forwarded === true) return undefined;
  const text = event.text?.trim();
  if (!text) return undefined;
  const open = await store.listOpen(event.channelType, event.conversationId, now);
  if (open.length === 0) return undefined;
  const question = pickQuestion(open, event);
  const asked = question?.card.questions[0];
  if (!question || !asked) return undefined;
  const parsed = parseCardReply(asked, text);
  if (!parsed.ok) return undefined;
  const answers: readonly CardAnswerValue[] = [parsed.value];
  const { card } = question;
  return {
    channelId: event.channelId,
    channelType: event.channelType,
    conversationId: event.conversationId,
    ...(event.conversationType !== undefined ? { conversationType: event.conversationType } : {}),
    receivedByChannelKey: event.receivedByChannelKey,
    messageId: question.messageId,
    revision: 0,
    kind: 'card_answer',
    author: event.author,
    ...(event.tenantId !== undefined ? { tenantId: event.tenantId } : {}),
    cardAnswer:
      question.asPoll === true && parsed.value.kind === 'single_choice'
        ? { cardId: card.cardId, value: { optionId: parsed.value.optionId }, answererVerified: true }
        : {
            cardId: card.cardId,
            value: { answers },
            answers,
            answererVerified: true,
            ...(card.proposalId !== undefined ? { proposalId: card.proposalId } : {}),
            ...(card.proposalVersion !== undefined ? { proposalVersion: card.proposalVersion } : {}),
          },
    occurredAt: event.occurredAt,
    ...(event.addressedToBot !== undefined ? { addressedToBot: event.addressedToBot } : {}),
  };
}

/** A poll as the one-question card its text form and its typed reply are built from. */
export function pollAsCard(poll: {
  readonly pollId: string;
  readonly question: string;
  readonly options: readonly { id: string; label: string }[];
  readonly hint?: string;
}): QuestionCard {
  return {
    cardId: poll.pollId,
    title: poll.question,
    ...(poll.hint !== undefined ? { intro: poll.hint } : {}),
    questions: [{ id: 'poll', kind: 'single_choice', label: poll.question, options: poll.options }],
  };
}

/** A poll's message text: the question, the hint, the numbered options. */
export function pollAsPlainMessage(lead: string, poll: Parameters<typeof pollAsCard>[0]): string {
  const lines = [poll.question, ...(poll.hint ? [poll.hint] : []), ...poll.options.map((o, i) => `${String(i + 1)}) ${o.label}`)];
  return lead.trim().length > 0 ? `${lead.trim()}\n\n${lines.join('\n')}` : lines.join('\n');
}
