/**
 * #2089 — question cards: a typed question out, typed answers in.
 *
 * The kernel is the boundary between a plugin that sends a card and a channel
 * that renders it. It refuses what the channel could not show (so the engine
 * falls back to a chat ballot), hands on only fields of the contract, stores
 * an answer only in the contract's typed form, and updates a posted card
 * under the same identity rules as a send. Tested through the delivery
 * behind 'conversationSend@2', called as the scoped send calls it once an
 * execution scope authorized the action (`scopedSendService.test.ts` has the
 * authorization).
 */

import { strict as assert } from 'node:assert';
import { beforeEach, describe, it } from 'node:test';

import type {
  CardSupport,
  CardUpdate,
  ConversationSendProvider,
  QuestionCard,
  TargetedDeliveryOutcome,
  TargetedMessage,
} from '@omadia/channel-sdk';

import { ConversationSendRegistry } from '../src/channels/conversationSendRegistry.js';
import {
  createConversationSendService,
  type ConversationCardUpdateInput,
  type ConversationSendInput,
  type ConversationSendService,
} from '../src/channels/conversationSendService.js';
import { toStoredEvent, validateMessageEvent } from '../src/channels/conversationMessages/eventIntake.js';
import { InMemoryConversationMessageStore } from '../src/channels/conversationMessages/store.js';
import { readCardAnswerFields, readCardUpdate, readQuestionCard } from '../src/channels/questionCard.js';
import { CONVERSATION, ENGINE, hubFixture, MARA_KEY, messageEvent, processOf, readAll } from './_helpers/conversationMessagesFixture.js';

const OPTIONS = [
  { id: 'a', label: 'Tuesday' },
  { id: 'b', label: 'Wednesday' },
  { id: 'c', label: 'Friday' },
];

const CARD: QuestionCard = {
  cardId: 'c-17',
  proposalId: 'p-4',
  proposalVersion: 2,
  title: 'Which date do we take?',
  questions: [
    { id: 'q1', kind: 'single_choice', label: 'Date', options: OPTIONS },
    { id: 'q2', kind: 'text', label: 'Anything to add?', required: false, multiline: true, mode: 'replace' },
  ],
  closesAt: '2026-11-20T16:00:00Z',
  changeable: true,
  locale: 'en',
};

const ALL_KINDS: CardSupport = {
  kinds: ['single_choice', 'multiple_choice', 'ranking', 'consent', 'assignment', 'text', 'number', 'date'],
  maxQuestions: 5,
  update: true,
};

describe('readQuestionCard', () => {
  const read = (card: unknown): string | QuestionCard => {
    const result = readQuestionCard(card);
    return 'error' in result ? result.error : result.card;
  };
  const withQuestion = (question: unknown): unknown => ({ ...CARD, questions: [question] });

  it('accepts every kind of the contract and hands on only known fields', () => {
    const everything = {
      cardId: 'c-1',
      title: 'Check-in',
      intro: 'Five short questions.',
      smuggled: '<script>',
      questions: [
        { id: 'q1', kind: 'single_choice', label: 'One', options: OPTIONS, extra: 1 },
        { id: 'q2', kind: 'multiple_choice', label: 'Some', options: OPTIONS, min: 1, max: 2 },
        { id: 'q3', kind: 'ranking', label: 'Order', options: OPTIONS, ranks: 2, rankLabels: ['1st', '2nd'] },
        { id: 'q4', kind: 'consent', label: 'Proposal B', reasonRequiredOnObject: true },
        { id: 'q5', kind: 'assignment', label: 'Who?', candidates: 'conversation_members', allowVolunteer: true },
        { id: 'q6', kind: 'assignment', label: 'Who of these?', candidates: [{ id: 'aad-anna', label: 'Anna' }] },
        { id: 'q7', kind: 'text', label: 'Idea', maxLength: 2000, mode: 'append' },
        { id: 'q8', kind: 'number', label: 'Hours', min: 0, max: 40 },
        { id: 'q9', kind: 'date', label: 'When' },
      ],
    };
    const card = read(everything) as QuestionCard;
    assert.deepEqual(card.questions.map((q) => q.kind), [
      'single_choice', 'multiple_choice', 'ranking', 'consent', 'assignment', 'assignment', 'text', 'number', 'date',
    ]);
    assert.equal('smuggled' in card, false);
    assert.equal('extra' in card.questions[0]!, false);
    assert.deepEqual(read(CARD), CARD, 'a valid card is unchanged');
  });

  it('refuses what a channel could not render, with the reason', () => {
    assert.match(read({ ...CARD, cardId: 'c 17' }) as string, /cardId must be 1\.\.64 characters/);
    assert.match(read({ ...CARD, title: ' ' }) as string, /title/);
    assert.match(read({ ...CARD, questions: [] }) as string, /1\.\.10 questions/);
    assert.match(read({ ...CARD, questions: [CARD.questions[0], CARD.questions[0]] }) as string, /question id 'q1' is not unique/);
    assert.match(read({ ...CARD, closesAt: 'tomorrow' }) as string, /closesAt/);
    assert.match(read({ ...CARD, proposalVersion: 1.5 }) as string, /proposalVersion/);
    // An id is part of the channel's input ids and of a comma-separated value.
    assert.match(read(withQuestion({ id: 'q.1', kind: 'date', label: 'x' })) as string, /id must be 1\.\.64 characters/);
    assert.match(
      read(withQuestion({ id: 'q1', kind: 'single_choice', label: 'x', options: [{ id: 'a,b', label: 'A' }, { id: 'c', label: 'C' }] })) as string,
      /every option needs an id/,
    );
    assert.match(read(withQuestion({ id: 'q1', kind: 'single_choice', label: 'x', options: [OPTIONS[0]] })) as string, /2\.\.25 options/);
    assert.match(
      read(withQuestion({ id: 'q1', kind: 'single_choice', label: 'x', options: [OPTIONS[0], OPTIONS[0]] })) as string,
      /option id 'a' is not unique/,
    );
    assert.match(read(withQuestion({ id: 'q1', kind: 'multiple_choice', label: 'x', options: OPTIONS, min: 3, max: 2 })) as string, /min is above max/);
    assert.match(read(withQuestion({ id: 'q1', kind: 'ranking', label: 'x', options: OPTIONS, ranks: 4 })) as string, /ranks must be 1\.\.3/);
    assert.match(
      read(withQuestion({ id: 'q1', kind: 'ranking', label: 'x', options: OPTIONS, rankLabels: ['1st'] })) as string,
      /rankLabels needs exactly 3 labels/,
    );
    assert.match(read(withQuestion({ id: 'q1', kind: 'assignment', label: 'x', candidates: 'everyone' })) as string, /candidates must be/);
    assert.match(read(withQuestion({ id: 'q1', kind: 'text', label: 'x', maxLength: 0 })) as string, /maxLength/);
    assert.match(read(withQuestion({ id: 'q1', kind: 'number', label: 'x', min: 5, max: 1 })) as string, /min is above max/);
    assert.match(read(withQuestion({ id: 'q1', kind: 'matrix', label: 'x' })) as string, /unknown kind 'matrix'/);
  });
});

/** The delivery with the ground of the engine's process already handed in. */
interface AuthorizedSend {
  sendToConversation(input: ConversationSendInput): ReturnType<ConversationSendService['sendToConversation']>;
  capabilities: ConversationSendService['capabilities'];
  updateCard(input: ConversationCardUpdateInput): ReturnType<ConversationSendService['updateCard']>;
}

describe('question cards through conversationSend, as an authorized send', () => {
  let support: CardSupport | undefined;
  let withUpdate: boolean;
  let posted: TargetedMessage[];
  let updates: { conversationId: string; cardMessageId: string; update: CardUpdate; opts: unknown }[];
  let updateOutcome: { outcome: 'updated' } | { outcome: 'unreachable'; code: string; message: string };
  let engine: AuthorizedSend;
  let conversation: ConversationSendService;

  beforeEach(async () => {
    support = ALL_KINDS;
    withUpdate = true;
    posted = [];
    updates = [];
    updateOutcome = { outcome: 'updated' };
    const f = hubFixture(new InMemoryConversationMessageStore());
    await readAll(f, 'mara');
    const providers = new ConversationSendRegistry();
    const provider: ConversationSendProvider = {
      channelType: 'teams',
      get supports() {
        return { asChannelKey: true, poll: true, ...(support ? { card: support } : {}) };
      },
      sendToConversation: (_id, message) => {
        posted.push(message);
        return Promise.resolve({ outcome: 'delivered', messageId: 'm1', cardMessageId: 'card-m1' } as TargetedDeliveryOutcome);
      },
      get updateCard() {
        return withUpdate
          ? (conversationId: string, cardMessageId: string, update: CardUpdate, opts: { asChannelKey: string }) => {
              updates.push({ conversationId, cardMessageId, update, opts });
              return Promise.resolve(updateOutcome);
            }
          : undefined;
      },
    };
    providers.register('@omadia/channel-teams', provider);
    conversation = createConversationSendService({
      providers,
      ownIdentity: {
        identityFor: (slug: string) => (slug === 'mara' ? { channelKey: MARA_KEY } : undefined),
        subscriptions: f.hub,
      } as never,
    });
    const ground = () => ({
      subscriptions: f.hub.subscriptionsOfProcess(ENGINE, processOf('mara').processId, 'mara'),
    });
    engine = {
      sendToConversation: (input) => conversation.sendToConversation(input, ground()),
      capabilities: (channelType) => conversation.capabilities(channelType),
      updateCard: (input) => conversation.updateCard(input, ground()),
    };
  });

  const send = (card: unknown, over: Record<string, unknown> = {}) =>
    engine.sendToConversation({
      agentSlug: 'mara',
      channelType: 'teams',
      conversationId: CONVERSATION,
      message: { text: 'Please answer.', card: card as QuestionCard, ...over },
    });
  const update = (
    target: AuthorizedSend,
    cardUpdate: unknown,
    over: Record<string, unknown> = {},
  ) =>
    target.updateCard({
      agentSlug: 'mara',
      channelType: 'teams',
      conversationId: CONVERSATION,
      cardMessageId: 'card-m1',
      update: cardUpdate as CardUpdate,
      ...over,
    });
  const CLOSED: CardUpdate = {
    state: 'closed',
    title: 'Which date do we take?',
    resultLines: ['Wednesday: 3', 'Tuesday: 1'],
    closedAt: '2026-11-20T16:00:00Z',
  };

  it('posts a valid card and returns the id a later update names', async () => {
    assert.deepEqual(await send(CARD), { outcome: 'delivered', messageId: 'm1', cardMessageId: 'card-m1' });
    assert.deepEqual(posted, [{ text: 'Please answer.', card: CARD }]);
  });

  it('says what the channel declares, so the engine can choose card or chat ballot', () => {
    assert.deepEqual(engine.capabilities('teams'), { asOwnIdentity: true, mentions: false, poll: true, card: ALL_KINDS });
    assert.equal(engine.capabilities('slack'), undefined, 'no channel plugin for that type');
    support = undefined;
    assert.deepEqual(engine.capabilities('teams'), { asOwnIdentity: true, mentions: false, poll: true });
    // `update` is only reported when the method exists, and a nonsense declaration is cut down.
    support = { kinds: ['single_choice', 'matrix' as never], maxQuestions: 99, update: true };
    withUpdate = false;
    assert.deepEqual(engine.capabilities('teams')?.card, { kinds: ['single_choice'], maxQuestions: 10, update: false });
  });

  it('refuses a card for a channel without cards, with a kind it does not list, or with too many questions', async () => {
    support = undefined;
    const none = await send(CARD);
    assert.deepEqual([none.outcome, none.outcome === 'unreachable' && none.code], ['unreachable', 'channel_error']);
    assert.match(none.outcome === 'unreachable' ? none.message : '', /does not declare question cards — nothing was posted/);

    support = { kinds: ['single_choice'], maxQuestions: 5, update: false };
    const kind = await send(CARD);
    assert.equal(kind.outcome === 'unreachable' && kind.code, 'channel_error');
    assert.match(kind.outcome === 'unreachable' ? kind.message : '', /does not declare the question kind text \(it declares single_choice\)/);

    support = { ...ALL_KINDS, maxQuestions: 1 };
    const many = await send(CARD);
    assert.match(many.outcome === 'unreachable' ? many.message : '', /at most 1 question on a card; this one has 2/);
    assert.deepEqual(posted, [], 'nothing was posted in any of the three cases');
  });

  it('refuses an invalid card and a card next to a poll', async () => {
    const invalid = await send({ ...CARD, questions: [] });
    assert.match(invalid.outcome === 'unreachable' ? invalid.message : '', /invalid card: a card needs 1\.\.10 questions/);
    const both = await send(CARD, { poll: { pollId: 'p1', question: 'x', options: OPTIONS } });
    assert.match(both.outcome === 'unreachable' ? both.message : '', /a poll or a question card, not both/);
    assert.deepEqual(posted, []);
  });

  it('a poll keeps working unchanged', async () => {
    support = undefined;
    const outcome = await engine.sendToConversation({
      agentSlug: 'mara',
      channelType: 'teams',
      conversationId: CONVERSATION,
      message: { text: 'Vote.', poll: { pollId: 'p1', question: 'Which?', options: OPTIONS } },
    });
    assert.equal(outcome.outcome, 'delivered');
    assert.deepEqual(posted[0]?.poll, { pollId: 'p1', question: 'Which?', options: OPTIONS });
  });

  it('closes a posted card as the agent own identity, with the result the engine supplied', async () => {
    assert.deepEqual(await update(engine, CLOSED), { outcome: 'updated' });
    assert.deepEqual(updates, [
      { conversationId: CONVERSATION, cardMessageId: 'card-m1', update: CLOSED, opts: { asChannelKey: MARA_KEY } },
    ]);
    // A corrected open card is validated like a new one.
    assert.deepEqual(await update(engine, { state: 'open', card: CARD }), { outcome: 'updated' });
    assert.deepEqual(updates[1]?.update, { state: 'open', card: CARD });
  });

  it('an update follows the identity rules of a send', async () => {
    // Without the ground an authorization leaves, nothing is updated.
    const unauthorized = await conversation.updateCard(
      { agentSlug: 'mara', channelType: 'teams', conversationId: CONVERSATION, cardMessageId: 'card-m1', update: CLOSED },
      undefined as never,
    );
    assert.deepEqual(
      [unauthorized.outcome, unauthorized.outcome === 'unreachable' && unauthorized.code],
      ['unreachable', 'not_permitted'],
    );
    const noIdentity = await update(engine, CLOSED, { agentSlug: 'hr' });
    assert.equal(noIdentity.outcome === 'unreachable' && noIdentity.code, 'no_identity');
    const noId = await update(engine, CLOSED, { cardMessageId: '' });
    assert.equal(noId.outcome === 'unreachable' && noId.code, 'not_permitted');
    assert.deepEqual(updates, [], 'the channel was not asked in any of these cases');
  });

  it('an update the channel cannot do or that is invalid is a channel_error; a failure is returned, not thrown', async () => {
    withUpdate = false;
    const cannot = await update(engine, CLOSED);
    assert.equal(cannot.outcome === 'unreachable' && cannot.code, 'channel_error');
    assert.match(cannot.outcome === 'unreachable' ? cannot.message : '', /cannot update a posted card — post the result as text/);
    withUpdate = true;
    const invalid = await update(engine, { state: 'closed', title: 'x', resultLines: 'Wednesday', closedAt: 'now' });
    assert.match(invalid.outcome === 'unreachable' ? invalid.message : '', /invalid card update: closedAt/);
    support = { kinds: ['single_choice'], maxQuestions: 5, update: true };
    const kind = await update(engine, { state: 'open', card: CARD });
    assert.match(kind.outcome === 'unreachable' ? kind.message : '', /does not declare the question kind text/);
    assert.deepEqual(updates, []);
    support = ALL_KINDS;
    updateOutcome = { outcome: 'unreachable', code: 'channel_error', message: 'message was deleted' };
    assert.deepEqual(await update(engine, CLOSED), updateOutcome);
  });

  it('readCardUpdate bounds the result lines', () => {
    const lines = Array.from({ length: 41 }, (_, i) => `line ${String(i)}`);
    assert.ok('error' in readCardUpdate({ ...CLOSED, resultLines: lines }));
    assert.ok('error' in readCardUpdate({ state: 'reopened' }));
    assert.deepEqual(readCardUpdate({ ...CLOSED, resultLines: [] }), { update: { ...CLOSED, resultLines: [] } });
  });
});

describe('card answers: stored in the typed form of the contract', () => {
  const ANSWERS = [
    { questionId: 'q1', kind: 'single_choice', optionId: 'b' },
    { questionId: 'q2', kind: 'multiple_choice', optionIds: ['a', 'c'] },
    { questionId: 'q3', kind: 'ranking', ranking: ['c', 'a', 'b'] },
    { questionId: 'q4', kind: 'consent', decision: 'object', reason: 'Too early.' },
    { questionId: 'q5', kind: 'assignment', assignee: 'self' },
    { questionId: 'q6', kind: 'assignment', assignee: { kind: 'teams-aad', id: 'aad-ben', displayName: 'Ben' } },
    { questionId: 'q7', kind: 'text', text: 'Budget first.' },
    { questionId: 'q8', kind: 'number', value: 12 },
    { questionId: 'q9', kind: 'date', value: '2026-12-01' },
  ] as const;
  const answerEvent = (cardAnswer: Record<string, unknown>) =>
    messageEvent({ kind: 'card_answer', messageId: 'card-m1', cardAnswer: cardAnswer as never });

  it('every kind passes and is stored with the proposal it answers; unknown fields are not stored as typed', () => {
    const event = answerEvent({
      cardId: 'c-17',
      value: { answers: ANSWERS },
      answererVerified: true,
      proposalId: 'p-4',
      proposalVersion: 2,
      answers: ANSWERS.map((a) => ({ ...a, smuggled: true })),
    });
    assert.equal(validateMessageEvent(event), undefined);
    assert.deepEqual(toStoredEvent(event, undefined).cardAnswer, {
      cardId: 'c-17',
      value: { answers: ANSWERS },
      answererVerified: true,
      proposalId: 'p-4',
      proposalVersion: 2,
      answers: ANSWERS,
    });
  });

  it('a poll answer is stored exactly as before', () => {
    const event = answerEvent({ cardId: 'poll-7', value: { optionId: 'b' } });
    assert.equal(validateMessageEvent(event), undefined);
    assert.deepEqual(toStoredEvent(event, undefined).cardAnswer, { cardId: 'poll-7', value: { optionId: 'b' } });
  });

  it('a typed answer that is not in the form of the contract refuses the event', () => {
    const bad = (answers: unknown, over: Record<string, unknown> = {}) =>
      validateMessageEvent(answerEvent({ cardId: 'c-17', value: {}, answers, ...over }));
    assert.equal(bad('b'), 'cardAnswer.answers');
    assert.equal(bad([{ questionId: 'q1', kind: 'single_choice' }]), 'cardAnswer.answers');
    assert.equal(bad([{ questionId: 'q1', kind: 'multiple_choice', optionIds: ['a', 'a'] }]), 'cardAnswer.answers');
    assert.equal(bad([{ questionId: 'q1', kind: 'consent', decision: 'maybe' }]), 'cardAnswer.answers');
    assert.equal(bad([{ questionId: 'q1', kind: 'date', value: '1.12.2026' }]), 'cardAnswer.answers');
    assert.equal(bad([{ questionId: 'q1', kind: 'number', value: Number.NaN }]), 'cardAnswer.answers');
    assert.equal(bad([{ questionId: 'q1', kind: 'assignment', assignee: { id: 'x' } }]), 'cardAnswer.answers');
    assert.equal(bad([ANSWERS[0], ANSWERS[0]]), 'cardAnswer.answers', 'one answer per question');
    assert.equal(bad([{ questionId: 'q1', kind: 'matrix' }]), 'cardAnswer.answers');
    assert.equal(bad(undefined, { proposalVersion: '2' }), 'cardAnswer.proposalVersion');
    assert.equal(bad(undefined, { proposalId: '' }), 'cardAnswer.proposalId');
    assert.deepEqual(readCardAnswerFields({}), { value: {} });
  });
});
