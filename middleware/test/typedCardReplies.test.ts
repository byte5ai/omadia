/**
 * #2086 (spec 2042 §5.14, criterion 30) — a question card the channel cannot
 * show natively goes out as numbered text and its question stays open; a typed
 * reply that fits becomes the same `card_answer` event a card submission would
 * be. Deterministic, no model. A message that does not fit stays a message.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { parseCardReply, type ConversationMessageEvent, type TargetedMessage } from '@omadia/channel-sdk';
import type { QuestionCard } from '@omadia/plugin-api';

import { ConversationMessageHub, type ProcessAccess } from '../src/channels/conversationMessages/hub.js';
import { createProcessConversationMessagesService } from '../src/channels/conversationMessages/service.js';
import { InMemoryConversationMessageStore } from '../src/channels/conversationMessages/store.js';
import { createConversationSendService } from '../src/channels/conversationSendService.js';
import {
  InMemoryOpenCardQuestionStore,
  pollAsCard,
  typedReplyAsCardAnswer,
} from '../src/channels/openCardQuestions.js';
import { readPoll } from '../src/channels/ownIdentitySend.js';
import { CONVERSATION, ENGINE, MARA_KEY, messageEvent } from './_helpers/conversationMessagesFixture.js';

const NOW = new Date('2026-11-20T10:00:00.000Z');
const LATER = new Date('2026-11-20T10:30:00.000Z');
// The in-memory store drops questions expired by the wall clock when one is
// registered, so an open question must stay open in real time too.
const OPEN_UNTIL = new Date('2099-01-01T00:00:00.000Z');
const READY = { ready: true, installed: true, canReadAllMessages: true, canPost: true, missing: [] };

const ranking: QuestionCard = {
  cardId: 'rank-1',
  proposalId: 'p-7',
  proposalVersion: 2,
  title: 'Ordnung der Themen',
  questions: [
    {
      id: 'q1',
      kind: 'ranking',
      label: 'Beste zuerst',
      options: [
        { id: 'a', label: 'Alpha' },
        { id: 'b', label: 'Beta' },
        { id: 'c', label: 'Gamma' },
      ],
    },
  ],
};
const freeText: QuestionCard = {
  cardId: 'why-1',
  title: 'Warum?',
  questions: [{ id: 'q1', kind: 'text', label: 'Dein Grund' }],
};

function ev(over: Partial<ConversationMessageEvent>): ConversationMessageEvent {
  return messageEvent({ occurredAt: NOW.toISOString(), ...over });
}

async function openStore(card: QuestionCard, messageId = 'card-msg', asPoll = false) {
  const store = new InMemoryOpenCardQuestionStore();
  await store.register({
    channelType: 'teams',
    conversationId: CONVERSATION,
    messageId,
    agentSlug: 'mara',
    card,
    ...(asPoll ? { asPoll: true } : {}),
    expiresAt: OPEN_UNTIL,
  });
  return store;
}

describe('typed reply → card_answer', () => {
  it('a reply to the question message becomes the typed answer, by its author', async () => {
    const store = await openStore(ranking);
    const answer = await typedReplyAsCardAnswer(
      store,
      ev({ messageId: 'u1', text: '2,1,3', replyToMessageId: 'card-msg' }),
      LATER,
    );
    assert.equal(answer?.kind, 'card_answer');
    assert.equal(answer?.messageId, 'card-msg', 'the id of the message answered');
    assert.equal(answer?.author.id, 'AAD-Anna');
    assert.equal(answer?.cardAnswer?.cardId, 'rank-1');
    assert.equal(answer?.cardAnswer?.answererVerified, true);
    assert.equal(answer?.cardAnswer?.proposalId, 'p-7');
    assert.equal(answer?.cardAnswer?.proposalVersion, 2);
    assert.deepEqual(answer?.cardAnswer?.answers, [{ questionId: 'q1', kind: 'ranking', ranking: ['b', 'a', 'c'] }]);
  });

  it('a message that does not fit stays a message', async () => {
    const store = await openStore(ranking);
    assert.equal(await typedReplyAsCardAnswer(store, ev({ text: 'weiß nicht', replyToMessageId: 'card-msg' }), LATER), undefined);
    assert.equal(await typedReplyAsCardAnswer(store, ev({ text: '1,1,2', replyToMessageId: 'card-msg' }), LATER), undefined);
  });

  it('a reply to some other message, or none, is not an answer', async () => {
    const store = await openStore(ranking);
    assert.equal(await typedReplyAsCardAnswer(store, ev({ text: '2,1,3', replyToMessageId: 'other' }), LATER), undefined);
    assert.equal(await typedReplyAsCardAnswer(store, ev({ text: '2,1,3' }), LATER), undefined, 'not addressed, not a reply');
  });

  it('an addressed message without a reply answers the only open question of the conversation', async () => {
    const store = await openStore(ranking);
    const answer = await typedReplyAsCardAnswer(store, ev({ text: '3,2,1', addressedToBot: true }), LATER);
    assert.equal(answer?.cardAnswer?.cardId, 'rank-1');
    const two = await openStore(ranking, 'card-msg');
    await two.register({
      channelType: 'teams',
      conversationId: CONVERSATION,
      messageId: 'card-msg-2',
      agentSlug: 'mara',
      card: { ...ranking, cardId: 'rank-2' },
      expiresAt: OPEN_UNTIL,
    });
    assert.equal(await typedReplyAsCardAnswer(two, ev({ text: '3,2,1', addressedToBot: true }), LATER), undefined, 'two open: only a reply says which');
  });

  it('a free-text question is answered by a reply only, never by any addressed sentence', async () => {
    const store = await openStore(freeText);
    assert.equal(await typedReplyAsCardAnswer(store, ev({ text: 'Weil es passt', addressedToBot: true }), LATER), undefined);
    const answer = await typedReplyAsCardAnswer(store, ev({ text: 'Weil es passt', replyToMessageId: 'card-msg' }), LATER);
    assert.deepEqual(answer?.cardAnswer?.answers, [{ questionId: 'q1', kind: 'text', text: 'Weil es passt' }]);
  });

  it('a forwarded message, a closed question and another conversation are not answers', async () => {
    const store = await openStore(ranking);
    assert.equal(await typedReplyAsCardAnswer(store, ev({ text: '2,1,3', replyToMessageId: 'card-msg', forwarded: true }), LATER), undefined);
    assert.equal(
      await typedReplyAsCardAnswer(store, ev({ text: '2,1,3', replyToMessageId: 'card-msg' }), new Date(OPEN_UNTIL.getTime() + 1)),
      undefined,
    );
    assert.equal(
      await typedReplyAsCardAnswer(store, ev({ text: '2,1,3', replyToMessageId: 'card-msg', conversationId: 'elsewhere' }), LATER),
      undefined,
    );
  });

  it('a poll answers as { optionId }, like a native poll', async () => {
    const poll: QuestionCard = {
      cardId: 'poll-1',
      title: 'Mittag?',
      questions: [
        { id: 'poll', kind: 'single_choice', label: 'Mittag?', options: [{ id: 'pizza', label: 'Pizza' }, { id: 'sushi', label: 'Sushi' }] },
      ],
    };
    const store = await openStore(poll, 'poll-msg', true);
    const answer = await typedReplyAsCardAnswer(store, ev({ text: '2', replyToMessageId: 'poll-msg' }), LATER);
    assert.equal(answer?.cardAnswer?.cardId, 'poll-1');
    assert.deepEqual(answer?.cardAnswer?.value, { optionId: 'sushi' });
    assert.equal(answer?.cardAnswer?.answers, undefined);
  });

  it('a poll for several answers (approval vote) answers as { optionIds }', async () => {
    const card = pollAsCard({
      pollId: 'poll-2',
      question: 'Welche Termine gehen?',
      options: [{ id: 'mo', label: 'Montag' }, { id: 'di', label: 'Dienstag' }, { id: 'mi', label: 'Mittwoch' }],
      multipleAnswers: true,
    });
    assert.equal(card.questions[0]?.kind, 'multiple_choice');
    const store = await openStore(card, 'poll-msg', true);
    const answer = await typedReplyAsCardAnswer(store, ev({ text: '1, 3', replyToMessageId: 'poll-msg' }), LATER);
    assert.deepEqual(answer?.cardAnswer?.value, { optionIds: ['mo', 'mi'] });
    assert.equal(answer?.cardAnswer?.answers, undefined);
  });

  it('readPoll keeps multipleAnswers only when it is true', () => {
    const base = { pollId: 'p', question: 'q', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] };
    const multi = readPoll({ ...base, multipleAnswers: true });
    assert.ok('poll' in multi && multi.poll.multipleAnswers === true);
    const single = readPoll({ ...base, multipleAnswers: 'yes' });
    assert.ok('poll' in single && !('multipleAnswers' in single.poll));
    assert.equal(pollAsCard(base).questions[0]?.kind, 'single_choice');
  });
});

describe('the hub stores the answer instead of the message', () => {
  function setup(openQuestions = new InMemoryOpenCardQuestionStore()) {
    const store = new InMemoryConversationMessageStore();
    const access = new Map<string, ProcessAccess>();
    const hub = new ConversationMessageHub({
      store,
      typedReplies: { store: openQuestions, now: () => LATER },
      resolveAgent: (slug) => (slug === 'mara' ? { id: 'id-mara', slug, archetype: 'facilitator' } : undefined),
      identityFor: (slug) => (slug === 'mara' ? { channelKey: MARA_KEY } : undefined),
      isBotPresent: () => Promise.resolve(true),
      checkReadiness: () => Promise.resolve(READY),
      processAccess: ({ pluginId, processId }) =>
        Promise.resolve(access.get(`${pluginId}|${processId}`) ?? { reserved: false, everReserved: false, openScope: false }),
      groundFor: () => Promise.resolve(undefined),
    });
    access.set(`${ENGINE}|f1`, { reserved: true, everReserved: true, openScope: true });
    const service = createProcessConversationMessagesService({ hub, callerPluginId: ENGINE });
    const scope = { agentSlug: 'mara', channelType: 'teams', conversationId: CONVERSATION, processId: 'f1' };
    return { hub, service, scope, openQuestions };
  }

  it('a fitting reply is one card_answer event, the unfitting one an ordinary message', async () => {
    const h = setup();
    await h.openQuestions.register({
      channelType: 'teams',
      conversationId: CONVERSATION,
      messageId: 'card-msg',
      agentSlug: 'mara',
      card: ranking,
      expiresAt: OPEN_UNTIL,
    });
    assert.equal((await h.service.subscribe(h.scope, { mode: 'all' })).outcome, 'subscribed');
    await h.hub.ingest(messageEvent({ messageId: 'u1', text: '2,1,3', replyToMessageId: 'card-msg' }));
    await h.hub.ingest(messageEvent({ messageId: 'u2', text: 'hm, vielleicht', replyToMessageId: 'card-msg' }));
    await new Promise((r) => setImmediate(r));
    const { events } = await h.service.listSince(h.scope);
    assert.deepEqual(
      events.map((e) => `${e.kind}:${e.messageId}`),
      ['card_answer:card-msg', 'created:u2'],
    );
    assert.equal(events[0]?.cardAnswer?.cardId, 'rank-1');
  });

  it('report tells the channel whether the message was taken as an answer, so it starts no turn', async () => {
    const h = setup();
    await h.openQuestions.register({
      channelType: 'teams',
      conversationId: CONVERSATION,
      messageId: 'card-msg',
      agentSlug: 'mara',
      card: ranking,
      expiresAt: OPEN_UNTIL,
    });
    await h.service.subscribe(h.scope, { mode: 'all' });
    assert.deepEqual(await h.hub.report(messageEvent({ messageId: 'u1', text: '2,1,3', replyToMessageId: 'card-msg' })), { answeredCard: true });
    assert.deepEqual(await h.hub.report(messageEvent({ messageId: 'u2', text: 'hm', replyToMessageId: 'card-msg' })), { answeredCard: false });
    assert.deepEqual(await h.hub.report(messageEvent({ messageId: 'u3', text: 'hallo' })), { answeredCard: false });
    // an invalid event and a conversation nobody subscribed to are never an answer, and never reject
    assert.deepEqual(await h.hub.report({ ...messageEvent({ messageId: 'u4' }), conversationId: '' }), { answeredCard: false });
    assert.deepEqual(await h.hub.report(messageEvent({ messageId: 'u5', conversationId: 'unsubscribed', text: '2,1,3', replyToMessageId: 'card-msg' })), { answeredCard: false });
  });

  it('an answer nobody receives is left to the channel turn', async () => {
    const h = setup();
    await h.openQuestions.register({
      channelType: 'teams',
      conversationId: CONVERSATION,
      messageId: 'card-msg',
      agentSlug: 'mara',
      card: ranking,
      expiresAt: OPEN_UNTIL,
    });
    // subscribed in `addressed` mode, and the reply does not address the bot
    await h.service.subscribe(h.scope, { mode: 'addressed' });
    assert.deepEqual(await h.hub.report(messageEvent({ messageId: 'u1', text: '2,1,3', replyToMessageId: 'card-msg' })), { answeredCard: false });
  });

  it('a question belongs to the identity that posted it', async () => {
    const h = setup();
    await h.openQuestions.register({
      channelType: 'teams',
      conversationId: CONVERSATION,
      messageId: 'card-msg',
      agentSlug: 'nora', // another agent's question: identityFor('nora') is not the receiver
      card: ranking,
      expiresAt: OPEN_UNTIL,
    });
    await h.service.subscribe(h.scope, { mode: 'all' });
    assert.deepEqual(await h.hub.report(messageEvent({ messageId: 'u1', text: '2,1,3', replyToMessageId: 'card-msg', addressedToBot: true })), { answeredCard: false });
    assert.deepEqual((await h.service.listSince(h.scope)).events.map((e) => e.kind), ['created']);
  });

  it('emit alone converts only where the channel turn is suppressed anyway (a process reads everything)', async () => {
    const q = {
      channelType: 'teams',
      conversationId: CONVERSATION,
      messageId: 'card-msg',
      agentSlug: 'mara',
      card: ranking,
      expiresAt: OPEN_UNTIL,
    };
    const addressed = setup();
    await addressed.openQuestions.register(q);
    await addressed.service.subscribe(addressed.scope, { mode: 'addressed' });
    await addressed.hub.ingest(messageEvent({ messageId: 'u1', text: '2,1,3', replyToMessageId: 'card-msg', addressedToBot: true }));
    assert.deepEqual((await addressed.service.listSince(addressed.scope)).events.map((e) => e.kind), ['created'], 'a channel that only emits starts its turn: no conversion');
    await addressed.hub.report(messageEvent({ messageId: 'u2', text: '2,1,3', replyToMessageId: 'card-msg', addressedToBot: true }));
    assert.ok((await addressed.service.listSince(addressed.scope)).events.some((e) => e.kind === 'card_answer'), 'reported: converted');
  });

  it('the same reply delivered twice is still an answer, never a turn', async () => {
    const h = setup();
    await h.openQuestions.register({
      channelType: 'teams',
      conversationId: CONVERSATION,
      messageId: 'card-msg',
      agentSlug: 'mara',
      card: ranking,
      expiresAt: OPEN_UNTIL,
    });
    await h.service.subscribe(h.scope, { mode: 'all' });
    const reply = messageEvent({ messageId: 'u1', text: '2,1,3', replyToMessageId: 'card-msg' });
    assert.deepEqual(await h.hub.report(reply), { answeredCard: true });
    assert.deepEqual(await h.hub.report(reply), { answeredCard: true });
    assert.equal((await h.service.listSince(h.scope)).events.filter((e) => e.kind === 'card_answer').length, 1);
  });

  it('without a store a reply is only a message', async () => {
    const store = new InMemoryConversationMessageStore();
    const hub = new ConversationMessageHub({
      store,
      resolveAgent: (slug) => (slug === 'mara' ? { id: 'id-mara', slug, archetype: 'facilitator' } : undefined),
      identityFor: () => ({ channelKey: MARA_KEY }),
      isBotPresent: () => Promise.resolve(true),
      checkReadiness: () => Promise.resolve(READY),
      processAccess: () => Promise.resolve({ reserved: true, everReserved: true, openScope: true }),
      groundFor: () => Promise.resolve(undefined),
    });
    const service = createProcessConversationMessagesService({ hub, callerPluginId: ENGINE });
    const scope = { agentSlug: 'mara', channelType: 'teams', conversationId: CONVERSATION, processId: 'f1' };
    await service.subscribe(scope, { mode: 'all' });
    await hub.ingest(messageEvent({ messageId: 'u1', text: '2,1,3', replyToMessageId: 'card-msg' }));
    assert.deepEqual((await service.listSince(scope)).events.map((e) => e.kind), ['created']);
  });
});

describe('the send service posts what the channel cannot show as text and keeps the question', () => {
  const ground = { subscriptions: [] };

  function service(supportsCard: boolean, openQuestions?: InMemoryOpenCardQuestionStore) {
    const sent: TargetedMessage[] = [];
    const registry = {
      get: () => ({
        supports: { asChannelKey: true, ...(supportsCard ? { card: { kinds: ['single_choice' as const], maxQuestions: 1, update: false } } : {}) },
        sendToConversation: (_id: string, message: TargetedMessage) => {
          sent.push(message);
          return Promise.resolve({ outcome: 'delivered' as const, messageId: 'posted-1' });
        },
      }),
    };
    const send = createConversationSendService({
      providers: registry as never,
      ownIdentity: { identityFor: () => ({ channelKey: '@bot' }), disclosure: undefined } as never,
      ...(openQuestions ? { openQuestions } : {}),
    });
    return { send, sent };
  }
  const input = (message: Record<string, unknown>) => ({ agentSlug: 'mara', channelType: 'telegram', conversationId: CONVERSATION, message: { text: 'Bitte abstimmen', ...message } as never });

  it('a card the channel lacks goes out as numbered text and its question is kept open', async () => {
    const open = new InMemoryOpenCardQuestionStore();
    const { send, sent } = service(false, open);
    const outcome = await send.sendToConversation(input({ card: ranking }), ground);
    assert.equal(outcome.outcome, 'delivered');
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.card, undefined);
    assert.match(sent[0]?.text ?? '', /Bitte abstimmen[\s\S]*1\) Alpha[\s\S]*2\) Beta/);
    assert.equal(outcome.outcome === 'delivered' && outcome.cardMessageId, 'posted-1');
    const kept = await open.listOpen('telegram', CONVERSATION, new Date());
    assert.equal(kept[0]?.card.cardId, 'rank-1');
  });

  it('a poll the channel lacks goes out the same way and is kept as a poll', async () => {
    const open = new InMemoryOpenCardQuestionStore();
    const { send, sent } = service(false, open);
    const outcome = await send.sendToConversation(
      input({ poll: { pollId: 'poll-1', question: 'Mittag?', options: [{ id: 'pizza', label: 'Pizza' }, { id: 'sushi', label: 'Sushi' }] } }),
      ground,
    );
    assert.equal(outcome.outcome, 'delivered');
    assert.equal(sent[0]?.poll, undefined);
    assert.match(sent[0]?.text ?? '', /Mittag\?\n1\) Pizza\n2\) Sushi/);
    assert.equal((await open.listOpen('telegram', CONVERSATION, new Date()))[0]?.asPoll, true);
  });

  it('a channel that shows the card natively gets it untouched', async () => {
    const open = new InMemoryOpenCardQuestionStore();
    const single: QuestionCard = { cardId: 's-1', title: 'T', questions: [{ id: 'q', kind: 'single_choice', label: 'L', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }] };
    const { send, sent } = service(true, open);
    await send.sendToConversation(input({ card: single }), ground);
    assert.equal(sent[0]?.card?.cardId, 's-1');
    assert.deepEqual(await open.listOpen('telegram', CONVERSATION, new Date()), []);
  });

  it('a card with several questions, or an assignment nobody could name by typing, is still refused and nothing is posted', async () => {
    const { send, sent } = service(false, new InMemoryOpenCardQuestionStore());
    const two: QuestionCard = { ...ranking, questions: [...ranking.questions, { id: 'q2', kind: 'number', label: 'Wie viele?' }] };
    const refused = await send.sendToConversation(input({ card: two }), ground);
    assert.equal(refused.outcome, 'unreachable');
    const assignment: QuestionCard = { cardId: 'as-1', title: 'T', questions: [{ id: 'q', kind: 'assignment', label: 'Wer?', candidates: 'conversation_members' }] };
    assert.equal((await send.sendToConversation(input({ card: assignment }), ground)).outcome, 'unreachable');
    assert.equal(sent.length, 0);
  });

  it('criterion 30: an assignment goes out as text and "2" / "ich" come back as the typed assignee', async () => {
    const open = new InMemoryOpenCardQuestionStore();
    const { send, sent } = service(false, open);
    const fixed: QuestionCard = {
      cardId: 'as-2',
      title: 'Wer übernimmt?',
      questions: [{ id: 'q', kind: 'assignment', label: 'Wer?', candidates: [{ id: 'anna', label: 'Anna' }, { id: 'ben', label: 'Ben' }], allowVolunteer: true }],
    };
    assert.equal((await send.sendToConversation(input({ card: fixed }), ground)).outcome, 'delivered');
    assert.match(sent[0]?.text ?? '', /1\) Anna\n2\) Ben/);
    const asked = (await open.listOpen('telegram', CONVERSATION, new Date()))[0]?.card.questions[0];
    assert.ok(asked);
    assert.deepEqual(parseCardReply(asked, '2'), { ok: true, value: { questionId: 'q', kind: 'assignment', assignee: { kind: 'user', id: 'ben', displayName: 'Ben' } } });
    assert.deepEqual(parseCardReply(asked, 'ich'), { ok: true, value: { questionId: 'q', kind: 'assignment', assignee: 'self' } });
    // a member list can only be volunteered for
    const members: QuestionCard = { cardId: 'as-3', title: 'T', questions: [{ id: 'q', kind: 'assignment', label: 'Wer?', candidates: 'conversation_members', allowVolunteer: true }] };
    assert.equal((await send.sendToConversation(input({ card: members }), ground)).outcome, 'delivered');
    // without volunteering, "ich" is not an answer to a fixed list
    const noVolunteer = { ...asked, allowVolunteer: false } as typeof asked;
    assert.equal(parseCardReply(noVolunteer, 'ich').ok, false);
    // a member list nobody may volunteer for cannot go out as text at all
    const closedMembers: QuestionCard = { cardId: 'as-4', title: 'T', questions: [{ id: 'q', kind: 'assignment', label: 'Wer?', candidates: 'conversation_members' }] };
    const before = sent.length;
    assert.equal((await send.sendToConversation(input({ card: closedMembers }), ground)).outcome, 'unreachable');
    assert.equal(sent.length, before, 'nothing was posted');
  });

  it('a close far in the future does not keep a question open for ever', async () => {
    const open = new InMemoryOpenCardQuestionStore();
    const { send } = service(false, open);
    await send.sendToConversation(input({ card: { ...ranking, closesAt: '2099-01-01T00:00:00.000Z' } }), ground);
    const kept = await open.listOpen('telegram', CONVERSATION, new Date());
    assert.ok((kept[0]?.expiresAt.getTime() ?? 0) <= Date.now() + 7 * 24 * 3600_000 + 5000);
  });

  it('without a store the refusal is the old one', async () => {
    const { send, sent } = service(false);
    const refused = await send.sendToConversation(input({ card: ranking }), ground);
    assert.equal(refused.outcome, 'unreachable');
    assert.equal(sent.length, 0);
    assert.equal(send.capabilities('telegram')?.card, undefined);
  });

  it('says it can ask any one-question card and poll when it can keep the question', () => {
    const { send } = service(false, new InMemoryOpenCardQuestionStore());
    const caps = send.capabilities('telegram');
    assert.equal(caps?.poll, true);
    assert.equal(caps?.card?.maxQuestions, 1);
    assert.equal(caps?.card?.kinds.includes('assignment'), true);
    assert.equal(caps?.card?.kinds.includes('ranking'), true);
  });
});
