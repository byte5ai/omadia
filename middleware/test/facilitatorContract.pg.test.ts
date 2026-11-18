/**
 * Native facilitators, kernel contract suite (#2068, kernel half; epic #2043):
 * one facilitation from creation to purge, and what several facilitators and
 * a meeting look like to the engine.
 *
 * End to end through the real kernel modules on Postgres, with a simulated
 * channel, a fixture engine plugin and a scripted model at the provider seam
 * (`_helpers/facilitatorKernelHarness.ts`). The engine plugin's own suite
 * runs the mirror image against a fake kernel; this one is what that fake
 * has to be true to. What is refused is in `facilitatorContractGuards.pg.test.ts`.
 */

import { strict as assert } from 'node:assert';
import { it } from 'node:test';

import type { ConversationMessageRecord } from '@omadia/plugin-api';

import {
  ANNA,
  BEN,
  CHAT,
  contractSuite,
  NEUTRALITY,
} from './_helpers/facilitatorContractSuite.js';
import {
  bootFacilitatorKernel,
  CHANNEL_PLUGIN,
  CHANNEL_TYPE,
  ENGINE_PLUGIN,
  systemText,
} from './_helpers/facilitatorKernelHarness.js';

await contractSuite('native facilitators: kernel contract (pg)', 'facilitatorContract', (c) => {
  it('walks one facilitation from creation to purge', async () => {
    // 1. Create → the engine is attached without a grant click.
    const maraKey = await c.facilitator('mara', 'AAAA-MARA');
    assert.equal(maraKey, '28:aaaa-mara');
    const agent = await c.k.store.getAgentBySlug('mara');
    assert.deepEqual(
      (await c.k.store.listAgentPlugins(agent!.id)).map((p) => [p.pluginId, p.enabled]),
      [[ENGINE_PLUGIN, true]],
    );

    // 2. First contact: a mention in the group reaches the model, with the
    //    engine's tools only and the neutrality block closing the identity.
    c.k.model.script({ tool: 'facilitation_start' }, { text: 'I will moderate this. Goal?' });
    const bundle = c.k.registry.get('mara')!.built.bundle.agent;
    const first = await bundle.chat(c.groupMention('@mara please run a vote on the offsite date'));
    assert.equal(first.text.includes('I will moderate this. Goal?'), true);
    const request = c.k.model.requests[0]!;
    const toolNames = (request.tools ?? []).map((t) => t.name);
    assert.ok(toolNames.includes('facilitation_start') && toolNames.includes('record_contribution'));
    assert.equal(toolNames.includes('crm_lookup'), false, 'no business tool');
    assert.equal(toolNames.includes('memory'), false, 'no memory tool');
    const system = systemText(request);
    assert.ok(system.includes(NEUTRALITY));
    // The tool learned its conversation from the kernel, not from the model.
    assert.deepEqual(c.k.engine.toolCalls[0], {
      tool: 'facilitation_start',
      input: {},
      context: {
        agentSlug: 'mara',
        channelType: CHANNEL_TYPE,
        conversationId: CHAT,
        callerPrincipalId: `user:${ANNA}`,
        callerUserRef: { kind: 'teams', id: ANNA },
      },
    });

    // 3. Subscribed (by the tool). The channel's mention gate is lifted.
    assert.equal(c.k.channel.core.isAllMessagesSubscribed!(CHANNEL_TYPE, CHAT, maraKey), true);
    assert.equal(c.k.channel.core.isAllMessagesSubscribed!(CHANNEL_TYPE, CHAT, '28:someone-else'), false);

    // 4. A message that mentions nobody is stored and delivered live.
    const live: ConversationMessageRecord[] = [];
    c.k.engine.messages.onMessage('mara', (r) => void live.push(r));
    c.k.channel.core.emitConversationMessage!(c.event({}, maraKey));
    await c.flush();
    assert.equal(live.length, 1);
    const vote = live[0]!;
    assert.deepEqual(vote.author, {
      kind: 'teams-aad',
      id: ANNA,
      displayName: 'Anna Köhler',
      principalId: `user:${ANNA}`,
    });
    assert.deepEqual(await c.k.engine.messages.getEvent(c.scope('mara'), 'm1'), vote);

    // 5. No kernel turn while subscribed, not even for a mention.
    const modelCalls = c.k.model.requests.length;
    const suppressed = await bundle.chat(c.groupMention('@mara what is the status?'));
    assert.equal(suppressed.text, '');
    assert.equal(c.k.model.requests.length, modelCalls, 'the model was not called');

    // 6. The engine drives the turn: agentTurn with the stored event.
    c.k.model.script({ tool: 'record_contribution', input: { ranking: ['A', 'C', 'B'] } }, { text: 'Recorded for you: A > C > B.' });
    const turn = await c.k.engine.agentTurn.runTurn({
      agentSlug: 'mara',
      sessionKey: 'facilitation-1',
      channelType: CHANNEL_TYPE,
      conversationId: CHAT,
      inboundEventId: vote.eventId,
      input: 'Anna wrote: A > C > B',
      engineContext: 'ENGINE STATE: step prioritise; open contributions: 1.',
    });
    assert.equal(turn.outcome, 'completed');
    // The turn runs in the agent's normal envelope, so the text carries what
    // every answer of this agent carries (here: the AI disclosure line).
    assert.ok(turn.outcome === 'completed' && turn.text.startsWith('Recorded for you: A > C > B.'));
    const engineRequest = c.k.model.requests[modelCalls]!;
    const engineSystem = systemText(engineRequest);
    assert.ok(engineSystem.includes(NEUTRALITY));
    assert.ok(
      engineSystem.indexOf('ENGINE STATE') > engineSystem.indexOf(NEUTRALITY),
      'engine context comes after the identity and its neutrality block',
    );
    assert.deepEqual(c.k.engine.toolCalls[1], {
      tool: 'record_contribution',
      input: { ranking: ['A', 'C', 'B'] },
      context: {
        agentSlug: 'mara',
        channelType: CHANNEL_TYPE,
        conversationId: CHAT,
        inboundEventId: vote.eventId,
        callerPrincipalId: `user:${ANNA}`,
        callerUserRef: { kind: 'teams-aad', id: ANNA },
      },
    });
    assert.deepEqual(c.k.channel.sent, [], 'the turn posted nothing; the engine sends');

    // 7. Send as own identity: mention + poll, ids returned.
    const posted = await c.k.engine.conversationSend.sendToConversation({
      agentSlug: 'mara',
      channelType: CHANNEL_TYPE,
      conversationId: CHAT,
      asOwnIdentity: true,
      message: {
        text: '@Ben one contribution is still open. Which date?',
        mentions: [{ user: `user:${BEN}`, text: '@Ben' }],
        poll: { pollId: 'poll-1', question: 'Which date?', options: [{ id: 'a', label: '12 May' }, { id: 'b', label: '19 May' }] },
      },
    });
    assert.deepEqual(posted, { outcome: 'delivered', messageId: 'sent-1', cardMessageId: 'card-of-sent-1' });
    assert.equal(c.sent()[0]!.asChannelKey, maraKey);
    assert.deepEqual(c.sent()[0]!.message.mentions, [
      { user: { kind: 'teams-aad', id: BEN, displayName: 'Ben' }, text: '@Ben' },
    ]);
    assert.equal(c.sent()[0]!.message.poll?.pollId, 'poll-1');
    // …and the poll answer comes back as an event against the card.
    c.k.channel.core.emitConversationMessage!(
      c.event(
        {
          kind: 'card_answer',
          messageId: 'card-of-sent-1',
          text: undefined,
          author: { kind: 'teams-aad', id: BEN },
          cardAnswer: { cardId: 'poll-1', value: { optionId: 'b' }, answererVerified: true },
        },
        maraKey,
      ),
    );
    await c.flush();
    assert.deepEqual(live[1]!.cardAnswer, { cardId: 'poll-1', value: { optionId: 'b' }, answererVerified: true });

    // 8. Direct messages: first contact with the channel reference; provider
    //    outcomes are passed through as they are.
    const dm = (principal: string) =>
      c.k.engine.targetedSend.sendToPrincipal({
        channelType: CHANNEL_TYPE,
        principal,
        message: { text: 'One contribution is still open for you.' },
        asAgentSlug: 'mara',
      });
    const delivered = await dm(`user:${BEN}`);
    assert.deepEqual(delivered.deliveries, [{ principalId: BEN, outcome: { outcome: 'delivered', messageId: 'sent-2' } }]);
    assert.equal(c.sent()[1]!.asChannelKey, maraKey);
    assert.deepEqual(c.sent()[1]!.userRef, { kind: 'teams-aad', id: BEN, displayName: 'Ben' });
    for (const code of ['app_not_installed', 'blocked'] as const) {
      c.k.channel.nextOutcome = { outcome: 'unreachable', code, message: `403 ${code}` };
      const report = await dm(`user:${BEN}`);
      assert.deepEqual(report.deliveries[0]!.outcome, { outcome: 'unreachable', code, message: `403 ${code}` });
    }
    const stranger = await dm('user:99999999-0000-4000-8000-000000000000');
    assert.equal((stranger.deliveries[0]!.outcome as { code: string }).code, 'not_permitted');

    // 9. Edits get kernel revisions, whatever the adapter counts.
    c.k.channel.core.emitConversationMessage!(c.event({ kind: 'edited', revision: 1, text: 'A > B > C' }, maraKey));
    c.k.channel.core.emitConversationMessage!(c.event({ kind: 'edited', revision: 1, text: 'B > A > C' }, maraKey));
    await c.flush();
    assert.deepEqual(live.slice(2).map((r) => r.revision), [1, 2]);
    const cursor = live[live.length - 1]!.eventId;

    // 10. Restart: a new kernel over the same database.
    await c.k.stop();
    c.k = await bootFacilitatorKernel({ pool: c.pool, graceMs: 0 });
    assert.equal(c.k.channel.core.isAllMessagesSubscribed!(CHANNEL_TYPE, CHAT, maraKey), true, 'the subscription survived');
    c.k.channel.core.emitConversationMessage!(c.event({ kind: 'edited', revision: 1, text: 'C > A > B' }, maraKey));
    c.k.channel.core.emitConversationMessage!(c.event({ messageId: 'm2', author: { kind: 'teams-aad', id: BEN }, text: 'B > A > C' }, maraKey));
    await c.flush();
    const replay = await c.k.engine.messages.listSince(c.scope('mara'), { after: cursor });
    assert.deepEqual(
      replay.events.map((e) => [e.messageId, e.kind, e.revision]),
      [
        ['m1', 'edited', 3],
        ['m2', 'created', 0],
      ],
    );
    assert.equal(replay.nextCursor, undefined);
    const whole = await c.k.engine.messages.listSince(c.scope('mara'));
    assert.equal(whole.events.length, 6, 'vote, poll answer, three edits, second vote');

    // 11. Unsubscribe → the gate applies again, sending is over, events are
    //     purged after the grace period (0 here).
    await c.k.engine.messages.unsubscribe(c.scope('mara'));
    assert.equal(c.k.channel.core.isAllMessagesSubscribed!(CHANNEL_TYPE, CHAT, maraKey), false);
    const late = await c.k.engine.conversationSend.sendToConversation({
      agentSlug: 'mara',
      channelType: CHANNEL_TYPE,
      conversationId: CHAT,
      asOwnIdentity: true,
      message: { text: 'too late' },
    });
    assert.equal(late.outcome === 'unreachable' && late.code, 'not_permitted');
    await c.flush();
    await c.k.messagesWiring.purge.tick();
    const left = await c.pool.query('SELECT 1 FROM conversation_message_events');
    assert.equal(left.rows.length, 0);
    assert.deepEqual((await c.k.engine.messages.listSince(c.scope('mara'))).events, []);
  });

  it('two facilitators in one conversation each keep their own record', async () => {
    const maraKey = await c.facilitator('mara', 'aaaa-mara');
    const noraKey = await c.facilitator('nora', 'bbbb-nora');
    assert.deepEqual(await c.k.engine.messages.subscribe(c.scope('mara')), { outcome: 'subscribed' });
    assert.deepEqual(await c.k.engine.messages.subscribe(c.scope('nora')), { outcome: 'subscribed' });
    // Teams delivers one human message once per bot.
    const shared = c.event({ messageId: 'shared' }, maraKey);
    c.k.channel.core.emitConversationMessage!(shared);
    c.k.channel.core.emitConversationMessage!({ ...shared, receivedByChannelKey: noraKey });
    c.k.channel.core.emitConversationMessage!({ ...shared, receivedByChannelKey: '28:a-third-bot' });
    await c.flush();
    const mara = await c.k.engine.messages.listSince(c.scope('mara'));
    const nora = await c.k.engine.messages.listSince(c.scope('nora'));
    assert.deepEqual(mara.events.map((e) => [e.messageId, e.receivedByChannelKey]), [['shared', maraKey]]);
    assert.deepEqual(nora.events.map((e) => [e.messageId, e.receivedByChannelKey]), [['shared', noraKey]]);
    assert.notEqual(mara.events[0]!.eventId, nora.events[0]!.eventId);
    assert.equal((await c.pool.query('SELECT 1 FROM conversation_message_events')).rows.length, 2);
    // Each posts as itself.
    for (const slug of ['mara', 'nora']) {
      await c.k.engine.conversationSend.sendToConversation({
        agentSlug: slug,
        channelType: CHANNEL_TYPE,
        conversationId: CHAT,
        asOwnIdentity: true,
        message: { text: `hello from ${slug}` },
      });
    }
    assert.deepEqual(c.sent().map((s) => s.asChannelKey), [maraKey, noraKey]);
    // One ending does not end the other.
    await c.k.engine.messages.unsubscribe(c.scope('mara'));
    assert.equal(c.k.channel.core.isAllMessagesSubscribed!(CHANNEL_TYPE, CHAT, noraKey), true);
  });

  it('without an identity of its own a facilitator is refused everywhere, never the default bot', async () => {
    const created = await c.k.api('POST', '/agents', { slug: 'ida', name: 'ida', kind: 'facilitator' });
    assert.equal(created.status, 201);
    c.k.channel.botAdded(CHAT);
    const subscribe = await c.k.engine.messages.subscribe(c.scope('ida'));
    assert.equal(subscribe.outcome === 'refused' && subscribe.code, 'no_identity');
    const post = await c.k.engine.conversationSend.sendToConversation({
      agentSlug: 'ida',
      channelType: CHANNEL_TYPE,
      conversationId: CHAT,
      asOwnIdentity: true,
      message: { text: 'hello' },
    });
    assert.equal(post.outcome === 'unreachable' && post.code, 'no_identity');
    const dm = await c.k.engine.targetedSend.sendToPrincipal({
      channelType: CHANNEL_TYPE,
      principal: `user:${ANNA}`,
      message: { text: 'hello' },
      asAgentSlug: 'ida',
    });
    assert.equal((dm.deliveries[0]!.outcome as { code: string }).code, 'no_identity');
    const readiness = await c.k.engine.readiness.check(c.scope('ida'));
    assert.deepEqual([readiness.ready, readiness.missing[0]!.code], [false, 'no_identity']);
    assert.deepEqual(c.k.channel.sent, [], 'nothing left the kernel under any identity');
  });

  it('subscribe needs presence and readiness; both are reported with their reason', async () => {
    await c.k.api('POST', '/agents', { slug: 'mara', name: 'mara', kind: 'facilitator' });
    await c.k.provisionIdentity('mara', 'aaaa-mara');
    const absent = await c.k.engine.messages.subscribe(c.scope('mara'));
    assert.equal(absent.outcome === 'refused' && absent.code, 'not_present');
    c.k.channel.botAdded(CHAT);
    c.k.channel.readiness = {
      ready: false,
      installed: true,
      canReadAllMessages: false,
      canPost: true,
      missing: [{ code: 'consent_missing', message: 'ChatMessage.Read.Chat is not granted in this chat' }],
    };
    const notReady = await c.k.engine.messages.subscribe(c.scope('mara'));
    assert.equal(notReady.outcome === 'refused' && notReady.code, 'not_ready');
    assert.match(notReady.outcome === 'refused' ? notReady.message : '', /consent_missing: ChatMessage\.Read\.Chat/);
    assert.deepEqual(await c.k.engine.readiness.check(c.scope('mara')), c.k.channel.readiness);
    c.k.channel.readiness = undefined;
    assert.deepEqual(await c.k.engine.messages.subscribe(c.scope('mara')), { outcome: 'subscribed' });
  });

  it('meeting lifecycle events reach the engine only for a moderated conversation', async () => {
    await c.facilitator('mara', 'aaaa-mara');
    const seen: string[] = [];
    c.k.engine.capabilities.onSessionEvent!('mara', (e) => void seen.push(`${e.kind}:${e.participants?.[0]?.principalId ?? '-'}`));
    const emit = (kind: 'session_started' | 'participant_joined', at: string): void =>
      c.k.channel.core.emitSessionEvent!({
        channelId: CHANNEL_PLUGIN,
        channelType: CHANNEL_TYPE,
        conversationId: CHAT,
        sessionRef: 'meeting-1',
        kind,
        ...(kind === 'participant_joined' ? { participants: [{ kind: 'teams-aad', id: ANNA }] } : {}),
        occurredAt: at,
      });
    emit('session_started', '2026-11-18T10:00:00Z');
    await c.flush();
    assert.deepEqual(seen, []);
    await c.k.engine.messages.subscribe(c.scope('mara'));
    emit('session_started', '2026-11-18T10:05:00Z');
    emit('session_started', '2026-11-18T10:05:00Z'); // the second bot's copy
    emit('participant_joined', '2026-11-18T10:06:00Z');
    await c.flush();
    assert.deepEqual(seen, ['session_started:-', `participant_joined:user:${ANNA}`]);
    const snapshot = await c.k.engine.capabilities.getSnapshot(c.scope('mara'));
    assert.deepEqual([snapshot.modality, snapshot.inputs, snapshot.outputs], ['chat', ['text'], ['text']]);
  });
});
