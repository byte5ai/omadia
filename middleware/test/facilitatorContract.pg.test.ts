/**
 * Native facilitators, kernel contract suite (#2068, kernel half; epic #2043):
 * one facilitation from creation to purge, and what several facilitators and
 * a meeting look like to the engine.
 *
 * End to end through the real kernel modules on Postgres, with a simulated
 * channel, a fixture engine plugin and a scripted model at the provider seam
 * (`_helpers/facilitatorKernelHarness.ts`). The engine works as a plugin
 * does since #2067: a facilitation is a process with an execution scope, and
 * it reads (`conversationMessages@2`), runs turns (`agentTurn@2`) and posts
 * (`conversationSend@2`) as that process. The engine plugin's own suite runs
 * the mirror image against a fake kernel; this one is what that fake has to
 * be true to. What is refused is in `facilitatorContractGuards.pg.test.ts`.
 */

import { strict as assert } from 'node:assert';
import { it } from 'node:test';

import type { ProcessConversationMessageRecord } from '@omadia/plugin-api';

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

    // 3. The tool started a process: an execution scope with the chat as its
    //    home, which reserves the chat, and a subscription of that process.
    //    The channel's mention gate is lifted.
    const process = c.k.engine.started[0]!;
    assert.ok(process, 'the tool started a process');
    const reserved = await c.pool.query<{ role: string; conversation_id: string }>(
      'SELECT role, conversation_id FROM conversation_reservations WHERE process_id = $1 AND released_at IS NULL',
      [process.processId],
    );
    assert.deepEqual(reserved.rows, [{ role: 'home', conversation_id: CHAT }]);
    assert.equal(await c.k.engine.messages.modeOf(process.scope), 'all');
    assert.equal(c.readsAll(maraKey), true);
    assert.equal(c.readsAll('28:someone-else'), false);

    // 4. A message that mentions nobody is stored and delivered live, as the
    //    process's.
    const live: ProcessConversationMessageRecord[] = [];
    c.k.engine.messages.onMessage('mara', (r) => void live.push(r));
    c.k.channel.core.emitConversationMessage!(c.event({}, maraKey));
    await c.until('the message is delivered live', () => live.length === 1);
    const vote = live[0]!;
    assert.equal(vote.processId, process.processId);
    assert.deepEqual(vote.author, {
      kind: 'teams-aad',
      id: ANNA,
      displayName: 'Anna Köhler',
      principalId: `user:${ANNA}`,
    });
    assert.deepEqual(await c.k.engine.messages.getEvent(process.scope, 'm1'), vote);
    assert.deepEqual(await c.k.engine.messages.getEventById(process.scope, vote.eventId), vote);

    // 5. No kernel turn while the process reads everything, not even for a mention.
    const modelCalls = c.k.model.requests.length;
    const suppressed = await bundle.chat(c.groupMention('@mara what is the status?'));
    assert.equal(suppressed.text, '');
    assert.equal(c.k.model.requests.length, modelCalls, 'the model was not called');

    // 6. The engine drives the turn: an authorized action under the scope,
    //    with the stored event and a reservation of model calls.
    c.k.model.script({ tool: 'record_contribution', input: { ranking: ['A', 'C', 'B'] } }, { text: 'Recorded for you: A > C > B.' });
    const turn = await c.k.engine.agentTurn.runTurn({
      agentSlug: 'mara',
      sessionKey: 'facilitation-1',
      channelType: CHANNEL_TYPE,
      conversationId: CHAT,
      inboundEventId: vote.eventId,
      input: 'Anna wrote: A > C > B',
      engineContext: 'ENGINE STATE: step prioritise; open contributions: 1.',
      scopeId: process.scopeId,
      processId: process.processId,
      phase: 'active',
      purpose: 'moderation',
      emission: 'prose',
      budget: { modelCalls: 4 },
    });
    assert.equal(turn.outcome, 'completed', JSON.stringify(turn));
    // The turn runs in the agent's normal envelope, so the text carries what
    // every answer of this agent carries.
    assert.ok(turn.outcome === 'completed' && turn.text.startsWith('Recorded for you: A > C > B.'));
    // Two model calls were made (the tool call, the answer); the other two of
    // the reservation went back to the scope.
    assert.deepEqual(turn.outcome === 'completed' && turn.modelCalls, { reserved: 4, used: 2 });
    const afterTurn = (await c.k.engine.execution.listScopes(process.processId)).find((s) => s.id === process.scopeId)!;
    assert.deepEqual(afterTurn.used, { actions: 1, modelCalls: 2 });
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
        callerUserRef: { kind: 'teams-aad', id: ANNA, displayName: 'Anna Köhler' },
      },
    });
    assert.deepEqual(c.k.channel.sent, [], 'the turn posted nothing; the engine sends');

    // 7. Send as own identity, drawn from the scope: mention + poll, ids returned.
    const posted = await c.k.engine.conversationSend.sendToConversation({
      agentSlug: 'mara',
      channelType: CHANNEL_TYPE,
      conversationId: CHAT,
      message: {
        text: '@Ben one contribution is still open. Which date?',
        mentions: [{ user: `user:${BEN}`, text: '@Ben' }],
        poll: { pollId: 'poll-1', question: 'Which date?', options: [{ id: 'a', label: '12 May' }, { id: 'b', label: '19 May' }] },
      },
      authorization: process.authorization,
    });
    assert.equal(posted.outcome, 'delivered', JSON.stringify(posted));
    assert.ok(posted.authorizationId, 'the post names the authorization it was drawn from');
    assert.deepEqual(posted, {
      outcome: 'delivered',
      authorizationId: posted.authorizationId,
      messageId: 'sent-1',
      cardMessageId: 'card-of-sent-1',
    });
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
    await c.until('the poll answer is delivered live', () => live.length === 2);
    assert.deepEqual(live[1]!.cardAnswer, { cardId: 'poll-1', value: { optionId: 'b' }, answererVerified: true });
    assert.equal(live[1]!.processId, process.processId);

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
    await c.until('both edits are delivered live', () => live.length === 4);
    assert.deepEqual(live.slice(2).map((r) => r.revision), [1, 2]);
    const cursor = live[live.length - 1]!.eventId;

    // 10. Restart: a new kernel over the same database. The process, its
    //     scope and its subscription are rows, so the engine carries on.
    await c.k.stop();
    c.k = await bootFacilitatorKernel({ pool: c.pool, graceMs: 0 });
    assert.equal(c.readsAll(maraKey), true, 'the subscription survived');
    c.k.channel.core.emitConversationMessage!(c.event({ kind: 'edited', revision: 1, text: 'C > A > B' }, maraKey));
    c.k.channel.core.emitConversationMessage!(c.event({ messageId: 'm2', author: { kind: 'teams-aad', id: BEN }, text: 'B > A > C' }, maraKey));
    await c.until('both events are stored', async () => (await c.k.engine.messages.listSince(process.scope)).events.length === 6);
    const replay = await c.k.engine.messages.listSince(process.scope, { after: cursor });
    assert.deepEqual(
      replay.events.map((e) => [e.messageId, e.kind, e.revision, e.processId]),
      [
        ['m1', 'edited', 3, process.processId],
        ['m2', 'created', 0, process.processId],
      ],
    );
    assert.equal(replay.nextCursor, undefined);
    const whole = await c.k.engine.messages.listSince(process.scope);
    assert.equal(whole.events.length, 6, 'vote, poll answer, three edits, second vote');

    // 11. The process ends its scope → the kernel ends the subscription with
    //     it: the gate applies again, sending is over, events are purged
    //     after the grace period (0 here).
    c.k.messagesWiring.enableReconcile();
    await c.k.engine.execution.endScope(process.scopeId, 'facilitation closed');
    await c.until('the subscription ends with the last open scope', () => !c.readsAll(maraKey));
    assert.equal(await c.k.engine.messages.modeOf(process.scope), undefined);
    const late = await c.k.engine.conversationSend.sendToConversation({
      agentSlug: 'mara',
      channelType: CHANNEL_TYPE,
      conversationId: CHAT,
      message: { text: 'too late' },
      authorization: process.authorization,
    });
    assert.deepEqual(
      [late.outcome, late.outcome === 'unreachable' && late.code, late.outcome === 'unreachable' && late.executionCode],
      ['unreachable', 'not_authorized', 'scope_ended'],
    );
    assert.equal(c.sent().some((s) => s.message.text === 'too late'), false);
    await c.flush();
    await c.k.messagesWiring.purge.tick();
    const left = await c.pool.query('SELECT 1 FROM conversation_message_events');
    assert.equal(left.rows.length, 0);
    assert.deepEqual((await c.k.engine.messages.listSince(process.scope)).events, []);
  });

  it('two facilitators in one conversation: one process holds it at a time, each keeps its own record', async () => {
    const maraKey = await c.facilitator('mara', 'aaaa-mara');
    const noraKey = await c.facilitator('nora', 'bbbb-nora');
    const mara = await c.moderate('mara');

    // The chat is reserved for mara's process. Nora's cannot start there, and
    // without a scope it reads nothing.
    const home = { channelType: CHANNEL_TYPE, conversationId: CHAT };
    const busy = await c.k.engine.execution.openScope({
      agentSlug: 'nora',
      processId: 'nora-too-early',
      kind: 'configuring',
      budget: { actions: 5, modelCalls: 5 },
      home,
    });
    assert.equal(busy.outcome === 'refused' && busy.code, 'conversation_busy');
    const early = await c.k.engine.messages.subscribe({ ...c.scope('nora'), processId: 'nora-too-early' }, { mode: 'all' });
    assert.equal(early.outcome === 'refused' && early.code, 'no_scope');

    // Teams delivers one human message once per bot; only the copy of the
    // identity whose process reads the chat is stored.
    const shared = c.event({ messageId: 'shared' }, maraKey);
    c.k.channel.core.emitConversationMessage!(shared);
    c.k.channel.core.emitConversationMessage!({ ...shared, receivedByChannelKey: noraKey });
    c.k.channel.core.emitConversationMessage!({ ...shared, receivedByChannelKey: '28:a-third-bot' });
    await c.flush();
    assert.deepEqual(
      (await c.k.engine.messages.listSince(mara.scope)).events.map((e) => [e.messageId, e.receivedByChannelKey]),
      [['shared', maraKey]],
    );
    assert.equal((await c.pool.query('SELECT 1 FROM conversation_message_events')).rows.length, 1);

    // Mara's process releases the chat: it keeps its record and from now on
    // gets addressed messages only. Nora's process can take the chat.
    c.k.messagesWiring.enableReconcile();
    await c.k.engine.execution.releaseConversation({ processId: mara.processId, ...home, reason: 'session over' });
    await c.until('reading follows the released reservation', () => !c.readsAll(maraKey));
    assert.equal(await c.k.engine.messages.modeOf(mara.scope), 'addressed');
    const nora = await c.moderate('nora');
    const second = c.event({ messageId: 'second' }, maraKey);
    c.k.channel.core.emitConversationMessage!(second);
    c.k.channel.core.emitConversationMessage!({ ...second, receivedByChannelKey: noraKey });
    await c.flush();
    const maraEvents = (await c.k.engine.messages.listSince(mara.scope)).events;
    const noraEvents = (await c.k.engine.messages.listSince(nora.scope)).events;
    assert.deepEqual(maraEvents.map((e) => [e.messageId, e.receivedByChannelKey, e.processId]), [['shared', maraKey, mara.processId]]);
    assert.deepEqual(noraEvents.map((e) => [e.messageId, e.receivedByChannelKey, e.processId]), [['second', noraKey, nora.processId]]);
    assert.notEqual(maraEvents[0]!.eventId, noraEvents[0]!.eventId);
    // Neither reads the other's record, also not with the other's process id.
    assert.deepEqual((await c.k.engine.messages.listSince({ ...mara.scope, agentSlug: 'nora' })).events, []);
    assert.equal(await c.k.engine.messages.getEvent(nora.scope, 'shared'), undefined);

    // Each posts as itself. Mara's scope still lists the chat, so its process
    // may still post there after the release (the closing words).
    for (const process of [mara, nora]) {
      const post = await c.k.engine.conversationSend.sendToConversation({
        agentSlug: process.scope.agentSlug,
        channelType: CHANNEL_TYPE,
        conversationId: CHAT,
        message: { text: `hello from ${process.scope.agentSlug}` },
        authorization: process.authorization,
      });
      assert.equal(post.outcome, 'delivered', JSON.stringify(post));
    }
    assert.deepEqual(c.sent().map((s) => s.asChannelKey), [maraKey, noraKey]);
    // A scope of one agent is not a permission for the other.
    const crossed = await c.k.engine.conversationSend.sendToConversation({
      agentSlug: 'nora',
      channelType: CHANNEL_TYPE,
      conversationId: CHAT,
      message: { text: 'as nora, under the scope of mara' },
      authorization: mara.authorization,
    });
    assert.deepEqual(
      [crossed.outcome === 'unreachable' && crossed.code, crossed.outcome === 'unreachable' && crossed.executionCode],
      ['not_authorized', 'unknown_scope'],
    );

    // One ending does not end the other.
    await c.k.engine.execution.endScope(mara.scopeId, 'facilitation closed');
    await c.until('the subscription of the ended process ends', async () => (await c.k.engine.messages.modeOf(mara.scope)) === undefined);
    assert.equal(c.readsAll(noraKey), true);
    assert.equal(await c.k.engine.messages.modeOf(nora.scope), 'all');
  });

  it('without an identity of its own a facilitator is refused everywhere, never the default bot', async () => {
    const created = await c.k.api('POST', '/agents', { slug: 'ida', name: 'ida', archetype: 'facilitator' });
    assert.equal(created.status, 201);
    c.k.channel.botAdded(CHAT);
    // The scope is the engine's permission to act for the agent; the identity
    // is asked where something would be read or sent.
    const process = await c.k.engine.openProcess('ida', CHAT);
    const subscribe = await c.k.engine.messages.subscribe(process.scope, { mode: 'all' });
    assert.equal(subscribe.outcome === 'refused' && subscribe.code, 'no_identity');
    const post = await c.k.engine.conversationSend.sendToConversation({
      agentSlug: 'ida',
      channelType: CHANNEL_TYPE,
      conversationId: CHAT,
      message: { text: 'hello' },
      authorization: process.authorization,
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
    await c.k.api('POST', '/agents', { slug: 'mara', name: 'mara', archetype: 'facilitator' });
    await c.k.provisionIdentity('mara', 'aaaa-mara');
    const process = await c.k.engine.openProcess('mara', CHAT);
    const absent = await c.k.engine.messages.subscribe(process.scope, { mode: 'all' });
    assert.equal(absent.outcome === 'refused' && absent.code, 'not_present');
    c.k.channel.botAdded(CHAT);
    c.k.channel.readiness = {
      ready: false,
      installed: true,
      canReadAllMessages: false,
      canPost: true,
      missing: [{ code: 'consent_missing', message: 'ChatMessage.Read.Chat is not granted in this chat' }],
    };
    const notReady = await c.k.engine.messages.subscribe(process.scope, { mode: 'all' });
    assert.equal(notReady.outcome === 'refused' && notReady.code, 'not_ready');
    assert.match(notReady.outcome === 'refused' ? notReady.message : '', /consent_missing: ChatMessage\.Read\.Chat/);
    assert.deepEqual(await c.k.engine.readiness.check(c.scope('mara')), c.k.channel.readiness);
    // The same report through the scoped check, as an authorized action.
    const checked = await c.k.engine.conversationSend.checkReadiness({
      ...c.scope('mara'),
      authorization: { scopeId: process.scopeId, processId: process.processId, phase: 'active' },
    });
    assert.deepEqual(checked.outcome === 'checked' && checked.report, c.k.channel.readiness);
    assert.equal(await c.k.engine.messages.modeOf(process.scope), undefined, 'a refused subscribe left nothing behind');
    c.k.channel.readiness = undefined;
    assert.deepEqual(await c.k.engine.messages.subscribe(process.scope, { mode: 'all' }), {
      outcome: 'subscribed',
      mode: 'all',
    });
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
    await c.moderate('mara');
    emit('session_started', '2026-11-18T10:05:00Z');
    emit('session_started', '2026-11-18T10:05:00Z'); // the second bot's copy
    emit('participant_joined', '2026-11-18T10:06:00Z');
    await c.flush();
    assert.deepEqual(seen, ['session_started:-', `participant_joined:user:${ANNA}`]);
    const snapshot = await c.k.engine.capabilities.getSnapshot(c.scope('mara'));
    assert.deepEqual([snapshot.modality, snapshot.inputs, snapshot.outputs], ['chat', ['text'], ['text']]);
  });
});
