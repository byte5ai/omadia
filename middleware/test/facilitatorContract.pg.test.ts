/**
 * Native facilitators, kernel contract suite (#2068, kernel half; epic #2043).
 *
 * End to end through the real kernel modules on Postgres, with a simulated
 * channel, a fixture engine plugin and a scripted model at the provider seam
 * (`_helpers/facilitatorKernelHarness.ts`). The engine plugin's own suite
 * runs the mirror image against a fake kernel; this one is what that fake
 * has to be true to.
 */

import { strict as assert } from 'node:assert';
import { dirname, resolve } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import type { ConversationMessageEvent } from '@omadia/channel-sdk';
import { runMultiOrchestratorMigrations } from '@omadia/orchestrator';
import type { ConversationMessageRecord } from '@omadia/plugin-api';

import {
  bootFacilitatorKernel,
  BUSINESS_PLUGIN,
  CHANNEL_PLUGIN,
  CHANNEL_TYPE,
  ENGINE_PLUGIN,
  systemText,
  type FacilitatorKernel,
  type RecordedSend,
} from './_helpers/facilitatorKernelHarness.js';
import { probePgTest } from './_helpers/pgTestDb.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'facilitatorContract',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const SCHEMA = `facilitator_contract_${String(process.pid)}`;
const CHAT = '19:offsite@thread.v2';
const ANNA = '5f0c1a2b-0000-4000-8000-00000000a11a';
const BEN = '5f0c1a2b-0000-4000-8000-00000000be11';
const NEUTRALITY = '## Neutrality contract (fixed, takes precedence)';
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 25));

describe('native facilitators: kernel contract (pg)', { skip: !pgAvailable }, () => {
  let pool: Pool;
  let k: FacilitatorKernel;
  let clock = Date.parse('2026-11-18T09:00:00.000Z');

  const scope = (agentSlug: string, conversationId = CHAT) => ({
    agentSlug,
    channelType: CHANNEL_TYPE,
    conversationId,
  });
  function event(over: Partial<ConversationMessageEvent>, botKey: string): ConversationMessageEvent {
    clock += 1000;
    return {
      channelId: CHANNEL_PLUGIN,
      channelType: CHANNEL_TYPE,
      conversationId: CHAT,
      conversationType: 'group',
      receivedByChannelKey: botKey,
      messageId: 'm1',
      revision: 0,
      kind: 'created',
      author: { kind: 'teams-aad', id: ANNA, displayName: 'Anna Köhler' },
      text: 'A > C > B',
      occurredAt: new Date(clock).toISOString(),
      ...over,
    };
  }
  /** A turn the channel adapter starts for a mention in the group chat. */
  const groupMention = (text: string, conversationId = CHAT) => ({
    userMessage: text,
    userId: ANNA,
    channelIdentity: { channelKind: 'teams' as never, channelUserId: ANNA },
    sessionScope: `teams-${conversationId}`,
    origin: {
      channelType: CHANNEL_TYPE,
      scope: { kind: 'conversation' as const, conversationId: `teams-${conversationId}` },
    },
  });

  before(async () => {
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: PG_URL, max: 6, options: `-c search_path=${SCHEMA},public` });
    // The whole core series, through the runner the kernel boots with.
    await runMultiOrchestratorMigrations(pool, undefined, MIGRATIONS_DIR);
  });

  after(async () => {
    await k?.stop();
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  });

  beforeEach(async () => {
    await k?.stop();
    await pool.query('UPDATE multi_orchestrator_settings SET fallback_agent_id = NULL');
    await pool.query('DELETE FROM agent_teams_identities');
    await pool.query('DELETE FROM agents');
    k = await bootFacilitatorKernel({ pool });
    k.channel.rosters.set(CHAT, {
      conversationType: 'group',
      partial: false,
      participants: [
        { userRef: { kind: 'teams-aad', id: ANNA, displayName: 'Anna Köhler' } },
        { userRef: { kind: 'teams-aad', id: BEN, displayName: 'Ben' } },
      ],
    });
  });

  /** What the simulated channel recorded. Read through a call, so a "nothing
   *  was sent" assertion does not narrow the array's type afterwards. */
  const sent = (): RecordedSend[] => k.channel.sent;

  /** A facilitator with its own identity, present in the chat. */
  async function facilitator(slug: string, appId: string): Promise<string> {
    const created = await k.api('POST', '/agents', { slug, name: slug, kind: 'facilitator' });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const key = await k.provisionIdentity(slug, appId);
    k.channel.botAdded(CHAT);
    return key;
  }

  it('walks one facilitation from creation to purge', async () => {
    // 1. Create → the engine is attached without a grant click.
    const maraKey = await facilitator('mara', 'AAAA-MARA');
    assert.equal(maraKey, '28:aaaa-mara');
    const agent = await k.store.getAgentBySlug('mara');
    assert.deepEqual(
      (await k.store.listAgentPlugins(agent!.id)).map((p) => [p.pluginId, p.enabled]),
      [[ENGINE_PLUGIN, true]],
    );

    // 2. First contact: a mention in the group reaches the model, with the
    //    engine's tools only and the neutrality block closing the identity.
    k.model.script({ tool: 'facilitation_start' }, { text: 'I will moderate this. Goal?' });
    const bundle = k.registry.get('mara')!.built.bundle.agent;
    const first = await bundle.chat(groupMention('@mara please run a vote on the offsite date'));
    assert.equal(first.text.includes('I will moderate this. Goal?'), true);
    const request = k.model.requests[0]!;
    const toolNames = (request.tools ?? []).map((t) => t.name);
    assert.ok(toolNames.includes('facilitation_start') && toolNames.includes('record_contribution'));
    assert.equal(toolNames.includes('crm_lookup'), false, 'no business tool');
    assert.equal(toolNames.includes('memory'), false, 'no memory tool');
    const system = systemText(request);
    assert.ok(system.includes(NEUTRALITY));
    // The tool learned its conversation from the kernel, not from the model.
    assert.deepEqual(k.engine.toolCalls[0], {
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
    assert.equal(k.channel.core.isAllMessagesSubscribed!(CHANNEL_TYPE, CHAT, maraKey), true);
    assert.equal(k.channel.core.isAllMessagesSubscribed!(CHANNEL_TYPE, CHAT, '28:someone-else'), false);

    // 4. A message that mentions nobody is stored and delivered live.
    const live: ConversationMessageRecord[] = [];
    k.engine.messages.onMessage('mara', (r) => void live.push(r));
    k.channel.core.emitConversationMessage!(event({}, maraKey));
    await flush();
    assert.equal(live.length, 1);
    const vote = live[0]!;
    assert.deepEqual(vote.author, {
      kind: 'teams-aad',
      id: ANNA,
      displayName: 'Anna Köhler',
      principalId: `user:${ANNA}`,
    });
    assert.deepEqual(await k.engine.messages.getEvent(scope('mara'), 'm1'), vote);

    // 5. No kernel turn while subscribed, not even for a mention.
    const modelCalls = k.model.requests.length;
    const suppressed = await bundle.chat(groupMention('@mara what is the status?'));
    assert.equal(suppressed.text, '');
    assert.equal(k.model.requests.length, modelCalls, 'the model was not called');

    // 6. The engine drives the turn: agentTurn with the stored event.
    k.model.script({ tool: 'record_contribution', input: { ranking: ['A', 'C', 'B'] } }, { text: 'Recorded for you: A > C > B.' });
    const turn = await k.engine.agentTurn.runTurn({
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
    const engineRequest = k.model.requests[modelCalls]!;
    const engineSystem = systemText(engineRequest);
    assert.ok(engineSystem.includes(NEUTRALITY));
    assert.ok(
      engineSystem.indexOf('ENGINE STATE') > engineSystem.indexOf(NEUTRALITY),
      'engine context comes after the identity and its neutrality block',
    );
    assert.deepEqual(k.engine.toolCalls[1], {
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
    assert.deepEqual(k.channel.sent, [], 'the turn posted nothing; the engine sends');

    // 7. Send as own identity: mention + poll, ids returned.
    const posted = await k.engine.conversationSend.sendToConversation({
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
    assert.equal(sent()[0]!.asChannelKey, maraKey);
    assert.deepEqual(sent()[0]!.message.mentions, [
      { user: { kind: 'teams-aad', id: BEN, displayName: 'Ben' }, text: '@Ben' },
    ]);
    assert.equal(sent()[0]!.message.poll?.pollId, 'poll-1');
    // …and the poll answer comes back as an event against the card.
    k.channel.core.emitConversationMessage!(
      event(
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
    await flush();
    assert.deepEqual(live[1]!.cardAnswer, { cardId: 'poll-1', value: { optionId: 'b' }, answererVerified: true });

    // 8. Direct messages: first contact with the channel reference; provider
    //    outcomes are passed through as they are.
    const dm = (principal: string) =>
      k.engine.targetedSend.sendToPrincipal({
        channelType: CHANNEL_TYPE,
        principal,
        message: { text: 'One contribution is still open for you.' },
        asAgentSlug: 'mara',
      });
    const delivered = await dm(`user:${BEN}`);
    assert.deepEqual(delivered.deliveries, [{ principalId: BEN, outcome: { outcome: 'delivered', messageId: 'sent-2' } }]);
    assert.equal(sent()[1]!.asChannelKey, maraKey);
    assert.deepEqual(sent()[1]!.userRef, { kind: 'teams-aad', id: BEN, displayName: 'Ben' });
    for (const code of ['app_not_installed', 'blocked'] as const) {
      k.channel.nextOutcome = { outcome: 'unreachable', code, message: `403 ${code}` };
      const report = await dm(`user:${BEN}`);
      assert.deepEqual(report.deliveries[0]!.outcome, { outcome: 'unreachable', code, message: `403 ${code}` });
    }
    const stranger = await dm('user:99999999-0000-4000-8000-000000000000');
    assert.equal((stranger.deliveries[0]!.outcome as { code: string }).code, 'not_permitted');

    // 9. Edits get kernel revisions, whatever the adapter counts.
    k.channel.core.emitConversationMessage!(event({ kind: 'edited', revision: 1, text: 'A > B > C' }, maraKey));
    k.channel.core.emitConversationMessage!(event({ kind: 'edited', revision: 1, text: 'B > A > C' }, maraKey));
    await flush();
    assert.deepEqual(live.slice(2).map((r) => r.revision), [1, 2]);
    const cursor = live[live.length - 1]!.eventId;

    // 10. Restart: a new kernel over the same database.
    await k.stop();
    k = await bootFacilitatorKernel({ pool, graceMs: 0 });
    assert.equal(k.channel.core.isAllMessagesSubscribed!(CHANNEL_TYPE, CHAT, maraKey), true, 'the subscription survived');
    k.channel.core.emitConversationMessage!(event({ kind: 'edited', revision: 1, text: 'C > A > B' }, maraKey));
    k.channel.core.emitConversationMessage!(event({ messageId: 'm2', author: { kind: 'teams-aad', id: BEN }, text: 'B > A > C' }, maraKey));
    await flush();
    const replay = await k.engine.messages.listSince(scope('mara'), { after: cursor });
    assert.deepEqual(
      replay.events.map((e) => [e.messageId, e.kind, e.revision]),
      [
        ['m1', 'edited', 3],
        ['m2', 'created', 0],
      ],
    );
    assert.equal(replay.nextCursor, undefined);
    const whole = await k.engine.messages.listSince(scope('mara'));
    assert.equal(whole.events.length, 6, 'vote, poll answer, three edits, second vote');

    // 11. Unsubscribe → the gate applies again, sending is over, events are
    //     purged after the grace period (0 here).
    await k.engine.messages.unsubscribe(scope('mara'));
    assert.equal(k.channel.core.isAllMessagesSubscribed!(CHANNEL_TYPE, CHAT, maraKey), false);
    const late = await k.engine.conversationSend.sendToConversation({
      agentSlug: 'mara',
      channelType: CHANNEL_TYPE,
      conversationId: CHAT,
      asOwnIdentity: true,
      message: { text: 'too late' },
    });
    assert.equal(late.outcome === 'unreachable' && late.code, 'not_permitted');
    await flush();
    await k.messagesWiring.purge.tick();
    const left = await pool.query('SELECT 1 FROM conversation_message_events');
    assert.equal(left.rows.length, 0);
    assert.deepEqual((await k.engine.messages.listSince(scope('mara'))).events, []);
  });

  it('two facilitators in one conversation each keep their own record', async () => {
    const maraKey = await facilitator('mara', 'aaaa-mara');
    const noraKey = await facilitator('nora', 'bbbb-nora');
    assert.deepEqual(await k.engine.messages.subscribe(scope('mara')), { outcome: 'subscribed' });
    assert.deepEqual(await k.engine.messages.subscribe(scope('nora')), { outcome: 'subscribed' });
    // Teams delivers one human message once per bot.
    const shared = event({ messageId: 'shared' }, maraKey);
    k.channel.core.emitConversationMessage!(shared);
    k.channel.core.emitConversationMessage!({ ...shared, receivedByChannelKey: noraKey });
    k.channel.core.emitConversationMessage!({ ...shared, receivedByChannelKey: '28:a-third-bot' });
    await flush();
    const mara = await k.engine.messages.listSince(scope('mara'));
    const nora = await k.engine.messages.listSince(scope('nora'));
    assert.deepEqual(mara.events.map((e) => [e.messageId, e.receivedByChannelKey]), [['shared', maraKey]]);
    assert.deepEqual(nora.events.map((e) => [e.messageId, e.receivedByChannelKey]), [['shared', noraKey]]);
    assert.notEqual(mara.events[0]!.eventId, nora.events[0]!.eventId);
    assert.equal((await pool.query('SELECT 1 FROM conversation_message_events')).rows.length, 2);
    // Each posts as itself.
    for (const slug of ['mara', 'nora']) {
      await k.engine.conversationSend.sendToConversation({
        agentSlug: slug,
        channelType: CHANNEL_TYPE,
        conversationId: CHAT,
        asOwnIdentity: true,
        message: { text: `hello from ${slug}` },
      });
    }
    assert.deepEqual(sent().map((s) => s.asChannelKey), [maraKey, noraKey]);
    // One ending does not end the other.
    await k.engine.messages.unsubscribe(scope('mara'));
    assert.equal(k.channel.core.isAllMessagesSubscribed!(CHANNEL_TYPE, CHAT, noraKey), true);
  });

  it('without an identity of its own a facilitator is refused everywhere, never the default bot', async () => {
    const created = await k.api('POST', '/agents', { slug: 'ida', name: 'ida', kind: 'facilitator' });
    assert.equal(created.status, 201);
    k.channel.botAdded(CHAT);
    const subscribe = await k.engine.messages.subscribe(scope('ida'));
    assert.equal(subscribe.outcome === 'refused' && subscribe.code, 'no_identity');
    const post = await k.engine.conversationSend.sendToConversation({
      agentSlug: 'ida',
      channelType: CHANNEL_TYPE,
      conversationId: CHAT,
      asOwnIdentity: true,
      message: { text: 'hello' },
    });
    assert.equal(post.outcome === 'unreachable' && post.code, 'no_identity');
    const dm = await k.engine.targetedSend.sendToPrincipal({
      channelType: CHANNEL_TYPE,
      principal: `user:${ANNA}`,
      message: { text: 'hello' },
      asAgentSlug: 'ida',
    });
    assert.equal((dm.deliveries[0]!.outcome as { code: string }).code, 'no_identity');
    const readiness = await k.engine.readiness.check(scope('ida'));
    assert.deepEqual([readiness.ready, readiness.missing[0]!.code], [false, 'no_identity']);
    assert.deepEqual(k.channel.sent, [], 'nothing left the kernel under any identity');
  });

  it('subscribe needs presence and readiness; both are reported with their reason', async () => {
    await k.api('POST', '/agents', { slug: 'mara', name: 'mara', kind: 'facilitator' });
    await k.provisionIdentity('mara', 'aaaa-mara');
    const absent = await k.engine.messages.subscribe(scope('mara'));
    assert.equal(absent.outcome === 'refused' && absent.code, 'not_present');
    k.channel.botAdded(CHAT);
    k.channel.readiness = {
      ready: false,
      installed: true,
      canReadAllMessages: false,
      canPost: true,
      missing: [{ code: 'consent_missing', message: 'ChatMessage.Read.Chat is not granted in this chat' }],
    };
    const notReady = await k.engine.messages.subscribe(scope('mara'));
    assert.equal(notReady.outcome === 'refused' && notReady.code, 'not_ready');
    assert.match(notReady.outcome === 'refused' ? notReady.message : '', /consent_missing: ChatMessage\.Read\.Chat/);
    assert.deepEqual(await k.engine.readiness.check(scope('mara')), k.channel.readiness);
    k.channel.readiness = undefined;
    assert.deepEqual(await k.engine.messages.subscribe(scope('mara')), { outcome: 'subscribed' });
  });

  it('a private request for help gets the refusal without a model call', async () => {
    await facilitator('mara', 'aaaa-mara');
    const bundle = k.registry.get('mara')!.built.bundle.agent;
    const answer = await bundle.chat({
      userMessage: 'Can you summarise our Q3 numbers?',
      userId: ANNA,
      origin: { channelType: CHANNEL_TYPE, scope: { kind: 'personal', userId: ANNA } },
    });
    assert.match(answer.text, /facilitator, not an assistant/);
    assert.equal(k.model.requests.length, 0);
  });

  it('every enforced omission is refused for a facilitator', async () => {
    await facilitator('mara', 'aaaa-mara');
    await k.api('POST', '/agents', { slug: 'hr', name: 'hr' });
    const refused = async (method: string, path: string, body: unknown, omission: string): Promise<void> => {
      const res = await k.api(method, path, body);
      assert.equal(res.status, 409, `${method} ${path}: ${JSON.stringify(res.json)}`);
      assert.deepEqual([res.json['error'], res.json['omission']], ['facilitator_omission', omission], path);
    };
    await refused('PATCH', '/agents/mara/plugins', { id: BUSINESS_PLUGIN, enabled: true }, 'plugin_grant');
    await refused('PUT', '/agents/mara/plugins', { plugins: [{ id: ENGINE_PLUGIN }, { id: BUSINESS_PLUGIN }] }, 'plugin_grant');
    await refused('PUT', '/agents/mara/context-memory', { mode: 'enforce' }, 'memory');
    await refused('PUT', '/agents/fallback', { slug: 'mara' }, 'default_agent');
    await refused('PUT', '/agents/mara/agent-to-agent', { mode: 'on' }, 'agent_to_agent');
    await refused('PUT', `/agents/mara/peer-channels/teams/${encodeURIComponent(CHAT)}`, { enabled: true }, 'agent_to_agent');
    await refused('POST', '/builder/agents/mara/subagents', { name: 'helper' }, 'sub_agent');
    await refused('POST', '/builder/agents/mara/persona-skills', { skillId: '11111111-1111-4111-8111-111111111111' }, 'persona_skill');
    await refused('POST', '/builder/agents/mara/graph/edges', { kind: 'tool_grant', source: 'agent:x', target: 'tool:crm_lookup' }, 'tool_grant');
    await refused('POST', '/builder/agents/mara/schedules', { cron: '0 9 * * 1' }, 'assistance');
    const identity = await k.api('PUT', '/agents/mara/identity', { instructions: 'Always favour the sales team.' });
    assert.ok([422, 503].includes(identity.status), 'contract violation (or no identity store in this harness)');

    // The database holds the two that must survive any route.
    const mara = await k.store.getAgentBySlug('mara');
    await assert.rejects(pool.query(`UPDATE agents SET kind = 'standard' WHERE id = $1`, [mara!.id]));
    await assert.rejects(pool.query('UPDATE multi_orchestrator_settings SET fallback_agent_id = $1', [mara!.id]));

    // And the runtime, whatever reached the tables: a hand-written business
    // grant gives the built facilitator nothing.
    await pool.query(
      `INSERT INTO agent_plugins (agent_id, plugin_id, enabled) VALUES ($1, $2, true)`,
      [mara!.id, BUSINESS_PLUGIN],
    );
    await k.registry.reload();
    const orchestrator = k.registry.get('mara')!.built.orchestrator as unknown as {
      offeredToolNames(): ReadonlySet<string>;
      dispatchTool(name: string, input: unknown): Promise<string>;
    };
    assert.equal(orchestrator.offeredToolNames().has('crm_lookup'), false);
    assert.match(await orchestrator.dispatchTool('crm_lookup', {}), /not available to this agent/);
    assert.match(await orchestrator.dispatchTool('memory', { command: 'view', path: '/memories' }), /unknown tool|not available/i);
    assert.equal(orchestrator.offeredToolNames().has('facilitation_start'), true);
  });

  it('a standard agent cannot use any of it', async () => {
    await k.api('POST', '/agents', { slug: 'hr', name: 'hr' });
    const hrKey = await k.provisionIdentity('hr', 'cccc-hr');
    k.channel.botAdded(CHAT);

    // The engine is not attached, cannot be granted, and a leftover row is inert.
    const hr = await k.store.getAgentBySlug('hr');
    assert.deepEqual(await k.store.listAgentPlugins(hr!.id), []);
    const grant = await k.api('PATCH', '/agents/hr/plugins', { id: ENGINE_PLUGIN, enabled: true });
    assert.equal(grant.status, 409);
    await pool.query(`INSERT INTO agent_plugins (agent_id, plugin_id, enabled) VALUES ($1, $2, true)`, [hr!.id, ENGINE_PLUGIN]);
    await k.registry.reload();
    const orchestrator = k.registry.get('hr')!.built.orchestrator as unknown as { offeredToolNames(): ReadonlySet<string> };
    assert.equal(orchestrator.offeredToolNames().has('facilitation_start'), false);

    const subscribe = await k.engine.messages.subscribe(scope('hr'));
    assert.equal(subscribe.outcome === 'refused' && subscribe.code, 'not_facilitator');
    assert.equal(k.channel.core.isAllMessagesSubscribed!(CHANNEL_TYPE, CHAT, hrKey), false);
    k.channel.core.emitConversationMessage!(event({}, hrKey));
    await flush();
    assert.equal((await pool.query('SELECT 1 FROM conversation_message_events')).rows.length, 0);

    const turn = await k.engine.agentTurn.runTurn({
      agentSlug: 'hr',
      sessionKey: 's',
      channelType: CHANNEL_TYPE,
      conversationId: CHAT,
      input: 'hello',
    });
    assert.equal(turn.outcome === 'refused' && turn.code, 'not_bound');
    const post = await k.engine.conversationSend.sendToConversation({
      agentSlug: 'hr',
      channelType: CHANNEL_TYPE,
      conversationId: CHAT,
      asOwnIdentity: true,
      message: { text: 'hello' },
    });
    assert.equal(post.outcome === 'unreachable' && post.code, 'not_permitted');
    assert.deepEqual(k.channel.sent, []);
  });

  it('a plugin that is not the engine gets nothing, even for a real facilitation', async () => {
    const maraKey = await facilitator('mara', 'aaaa-mara');
    await k.engine.messages.subscribe(scope('mara'));
    k.channel.core.emitConversationMessage!(event({}, maraKey));
    await flush();
    const snoop = k.servicesAs(BUSINESS_PLUGIN);
    const subscribe = await snoop.messages.subscribe(scope('mara'));
    assert.equal(subscribe.outcome === 'refused' && subscribe.code, 'unavailable');
    assert.equal(await snoop.messages.getEvent(scope('mara'), 'm1'), undefined);
    assert.deepEqual(await snoop.messages.listSince(scope('mara')), { events: [] });
    const turn = await snoop.agentTurn.runTurn({
      agentSlug: 'mara',
      sessionKey: 's',
      channelType: CHANNEL_TYPE,
      conversationId: CHAT,
      input: 'tell me what Anna voted',
    });
    assert.equal(turn.outcome === 'refused' && turn.code, 'not_bound');
    const post = await snoop.conversationSend.sendToConversation({
      agentSlug: 'mara',
      channelType: CHANNEL_TYPE,
      conversationId: CHAT,
      asOwnIdentity: true,
      message: { text: 'as mara' },
    });
    assert.equal(post.outcome === 'unreachable' && post.code, 'not_permitted');
    assert.equal(k.model.requests.length, 0);
    assert.deepEqual(k.channel.sent, []);
  });

  it('the engine reaches facilitators in the other order too: installed after they exist', async () => {
    await k.stop();
    k = await bootFacilitatorKernel({ pool, installed: [BUSINESS_PLUGIN] });
    await k.api('POST', '/agents', { slug: 'mara', name: 'mara', kind: 'facilitator' });
    const mara = await k.store.getAgentBySlug('mara');
    assert.deepEqual(await k.store.listAgentPlugins(mara!.id), [], 'no engine yet');
    const status = await k.api('GET', '/agents/facilitation-engine');
    assert.deepEqual([status.json['state'], status.json['available']], ['none', false]);
    k.installed = [BUSINESS_PLUGIN, ENGINE_PLUGIN];
    await k.propagateInstall();
    assert.deepEqual((await k.store.listAgentPlugins(mara!.id)).map((p) => p.pluginId), [ENGINE_PLUGIN]);
    const orchestrator = k.registry.get('mara')!.built.orchestrator as unknown as { offeredToolNames(): ReadonlySet<string> };
    assert.equal(orchestrator.offeredToolNames().has('facilitation_start'), true);
    assert.equal((await k.api('GET', '/agents/facilitation-engine')).json['state'], 'bound');
  });

  it('meeting lifecycle events reach the engine only for a moderated conversation', async () => {
    await facilitator('mara', 'aaaa-mara');
    const seen: string[] = [];
    k.engine.capabilities.onSessionEvent!('mara', (e) => void seen.push(`${e.kind}:${e.participants?.[0]?.principalId ?? '-'}`));
    const emit = (kind: 'session_started' | 'participant_joined', at: string): void =>
      k.channel.core.emitSessionEvent!({
        channelId: CHANNEL_PLUGIN,
        channelType: CHANNEL_TYPE,
        conversationId: CHAT,
        sessionRef: 'meeting-1',
        kind,
        ...(kind === 'participant_joined' ? { participants: [{ kind: 'teams-aad', id: ANNA }] } : {}),
        occurredAt: at,
      });
    emit('session_started', '2026-11-18T10:00:00Z');
    await flush();
    assert.deepEqual(seen, []);
    await k.engine.messages.subscribe(scope('mara'));
    emit('session_started', '2026-11-18T10:05:00Z');
    emit('session_started', '2026-11-18T10:05:00Z'); // the second bot's copy
    emit('participant_joined', '2026-11-18T10:06:00Z');
    await flush();
    assert.deepEqual(seen, ['session_started:-', `participant_joined:user:${ANNA}`]);
    const snapshot = await k.engine.capabilities.getSnapshot(scope('mara'));
    assert.deepEqual([snapshot.modality, snapshot.inputs, snapshot.outputs], ['chat', ['text'], ['text']]);
  });
});
