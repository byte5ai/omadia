/**
 * Native facilitators, kernel contract suite (#2068, kernel half; epic #2043):
 * what is refused, who gets nothing, and when the kernel ends a subscription
 * on its own. The walk-through of one facilitation is in
 * `facilitatorContract.pg.test.ts`; both share `_helpers/facilitatorContractSuite.ts`.
 *
 * The engine reaches the kernel as a plugin does since #2067: through an
 * execution scope of a process, `conversationMessages@2`, `agentTurn@2` and
 * `conversationSend@2`. So "refused" has two layers here: what the execution
 * authorization refuses (no scope for this caller, this agent, this process)
 * and what the service behind it refuses.
 */

import { strict as assert } from 'node:assert';
import { it } from 'node:test';


import {
  ANNA,
  CHAT,
  CHAT_2,
  CHAT_3,
  contractSuite,
} from './_helpers/facilitatorContractSuite.js';
import {
  bootFacilitatorKernel,
  BUSINESS_PLUGIN,
  CHANNEL_TYPE,
  ENGINE_PLUGIN,
} from './_helpers/facilitatorKernelHarness.js';

/** What a refused send says: the code, and why the execution authorization refused. */
function refusalOf(outcome: { outcome: string; code?: string; executionCode?: string }): (string | undefined)[] {
  return [outcome.outcome, outcome.code, outcome.executionCode];
}

await contractSuite('native facilitators: kernel contract, guards (pg)', 'facilitatorGuards', (c) => {
  /** A turn request under a scope; the scope and process are the caller's claim. */
  const turnAs = (agentSlug: string, scopeId: string, processId: string, input: string) => ({
    agentSlug,
    sessionKey: 's',
    channelType: CHANNEL_TYPE,
    conversationId: CHAT,
    input,
    scopeId,
    processId,
    phase: 'active' as const,
    purpose: 'moderation' as const,
    emission: 'prose' as const,
    budget: { modelCalls: 2 },
  });

  it('a private request for help gets the refusal without a model call', async () => {
    await c.facilitator('mara', 'aaaa-mara');
    const bundle = c.k.registry.get('mara')!.built.bundle.agent;
    const answer = await bundle.chat({
      userMessage: 'Can you summarise our Q3 numbers?',
      userId: ANNA,
      origin: { channelType: CHANNEL_TYPE, scope: { kind: 'personal', userId: ANNA } },
    });
    assert.match(answer.text, /facilitator, not an assistant/);
    assert.equal(c.k.model.requests.length, 0);
  });

  it('every enforced omission is refused for a facilitator', async () => {
    await c.facilitator('mara', 'aaaa-mara');
    await c.k.api('POST', '/agents', { slug: 'hr', name: 'hr' });
    const refused = async (method: string, path: string, body: unknown, omission: string): Promise<void> => {
      const res = await c.k.api(method, path, body);
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
    const identity = await c.k.api('PUT', '/agents/mara/identity', { instructions: 'Always favour the sales team.' });
    assert.ok([422, 503].includes(identity.status), 'contract violation (or no identity store in this harness)');

    // The database holds the two that must survive any route.
    const mara = await c.k.store.getAgentBySlug('mara');
    await assert.rejects(c.pool.query(`UPDATE agents SET kind = 'standard' WHERE id = $1`, [mara!.id]));
    await assert.rejects(c.pool.query('UPDATE multi_orchestrator_settings SET fallback_agent_id = $1', [mara!.id]));

    // And the runtime, whatever reached the tables: a hand-written business
    // grant gives the built facilitator nothing.
    await c.pool.query(
      `INSERT INTO agent_plugins (agent_id, plugin_id, enabled) VALUES ($1, $2, true)`,
      [mara!.id, BUSINESS_PLUGIN],
    );
    await c.k.registry.reload();
    const orchestrator = c.k.registry.get('mara')!.built.orchestrator as unknown as {
      offeredToolNames(): ReadonlySet<string>;
      dispatchTool(name: string, input: unknown): Promise<string>;
    };
    assert.equal(orchestrator.offeredToolNames().has('crm_lookup'), false);
    assert.match(await orchestrator.dispatchTool('crm_lookup', {}), /not available to this agent/);
    assert.match(await orchestrator.dispatchTool('memory', { command: 'view', path: '/memories' }), /unknown tool|not available/i);
    assert.equal(orchestrator.offeredToolNames().has('facilitation_start'), true);
  });

  it('a standard agent cannot use any of it', async () => {
    await c.k.api('POST', '/agents', { slug: 'hr', name: 'hr' });
    const hrKey = await c.k.provisionIdentity('hr', 'cccc-hr');
    c.k.channel.botAdded(CHAT);

    // The engine is not attached, cannot be granted, and a leftover row is inert.
    const hr = await c.k.store.getAgentBySlug('hr');
    assert.deepEqual(await c.k.store.listAgentPlugins(hr!.id), []);
    const grant = await c.k.api('PATCH', '/agents/hr/plugins', { id: ENGINE_PLUGIN, enabled: true });
    assert.equal(grant.status, 409);
    await c.pool.query(`INSERT INTO agent_plugins (agent_id, plugin_id, enabled) VALUES ($1, $2, true)`, [hr!.id, ENGINE_PLUGIN]);
    await c.k.registry.reload();
    const orchestrator = c.k.registry.get('hr')!.built.orchestrator as unknown as { offeredToolNames(): ReadonlySet<string> };
    assert.equal(orchestrator.offeredToolNames().has('facilitation_start'), false);

    // No execution scope for an agent whose archetype the engine does not
    // deliver: there is no process of a standard agent to act for.
    const home = { channelType: CHANNEL_TYPE, conversationId: CHAT };
    const scope = await c.k.engine.execution.openScope({
      agentSlug: 'hr',
      processId: 'hr-1',
      kind: 'configuring',
      budget: { actions: 5, modelCalls: 5 },
      home,
    });
    assert.equal(scope.outcome === 'refused' && scope.code, 'not_permitted');
    assert.equal((await c.pool.query('SELECT 1 FROM conversation_reservations')).rows.length, 0, 'the chat is not reserved');

    const subscribe = await c.k.engine.messages.subscribe({ ...c.scope('hr'), processId: 'hr-1' }, { mode: 'all' });
    assert.equal(subscribe.outcome === 'refused' && subscribe.code, 'not_facilitator');
    const addressed = await c.k.engine.messages.subscribe({ ...c.scope('hr'), processId: 'hr-1' }, { mode: 'addressed' });
    assert.equal(addressed.outcome === 'refused' && addressed.code, 'not_facilitator');
    assert.equal(c.readsAll(hrKey), false);
    c.k.channel.core.emitConversationMessage!(c.event({}, hrKey));
    await c.flush();
    assert.equal((await c.pool.query('SELECT 1 FROM conversation_message_events')).rows.length, 0);

    const turn = await c.k.engine.agentTurn.runTurn(turnAs('hr', 'no-such-scope', 'hr-1', 'hello'));
    assert.equal(turn.outcome === 'refused' && turn.code, 'not_bound');
    const post = await c.k.engine.conversationSend.sendToConversation({
      agentSlug: 'hr',
      ...home,
      message: { text: 'hello' },
      authorization: { scopeId: 'no-such-scope', processId: 'hr-1', phase: 'active', purpose: 'moderation', emission: 'template' },
    });
    assert.deepEqual(refusalOf(post), ['unreachable', 'not_authorized', 'unknown_scope']);
    // Not under the scope of a real facilitation either: a scope is one agent's.
    await c.facilitator('mara', 'aaaa-mara', CHAT_2);
    const mara = await c.moderate('mara', CHAT_2);
    const borrowedTurn = await c.k.engine.agentTurn.runTurn(turnAs('hr', mara.scopeId, mara.processId, 'hello'));
    assert.equal(borrowedTurn.outcome === 'refused' && borrowedTurn.code, 'not_bound');
    const borrowedPost = await c.k.engine.conversationSend.sendToConversation({
      agentSlug: 'hr',
      channelType: CHANNEL_TYPE,
      conversationId: CHAT_2,
      message: { text: 'hello' },
      authorization: mara.authorization,
    });
    assert.deepEqual(refusalOf(borrowedPost), ['unreachable', 'not_authorized', 'unknown_scope']);
    assert.equal(c.k.model.requests.length, 0);
    assert.deepEqual(c.k.channel.sent, []);
  });

  it('a plugin that is not the engine gets nothing, even for a real facilitation', async () => {
    const maraKey = await c.facilitator('mara', 'aaaa-mara');
    const process = await c.moderate('mara');
    c.k.channel.core.emitConversationMessage!(c.event({}, maraKey));
    await c.flush();
    assert.equal((await c.k.engine.messages.listSince(process.scope)).events.length, 1, 'the engine has the event');

    // The other plugin knows everything a process is named by. It still has
    // no scope: it cannot open one for a facilitator, and the engine's are
    // not its own.
    const snoop = c.k.servicesAs(BUSINESS_PLUGIN);
    const own = await snoop.execution.openScope({
      agentSlug: 'mara',
      processId: 'snoop-1',
      kind: 'configuring',
      budget: { actions: 5, modelCalls: 5 },
      home: { channelType: CHANNEL_TYPE, conversationId: CHAT_2 },
    });
    assert.equal(own.outcome === 'refused' && own.code, 'not_permitted');
    assert.deepEqual(await snoop.execution.listScopes(process.processId), []);
    const authorize = await snoop.execution.authorize({
      scopeId: process.scopeId,
      phase: 'active',
      purpose: 'moderation',
      action: 'check',
    });
    assert.equal(authorize.outcome === 'refused' && authorize.code, 'unknown_scope');
    await snoop.execution.endScope(process.scopeId, 'hostile');
    assert.equal(
      (await c.k.engine.execution.listScopes(process.processId)).find((scope) => scope.id === process.scopeId)?.state,
      'open',
      'another plugin cannot end the scope',
    );

    for (const mode of ['all', 'addressed'] as const) {
      const subscribe = await snoop.messages.subscribe(process.scope, { mode });
      assert.equal(subscribe.outcome === 'refused' && subscribe.code, 'no_scope', mode);
    }
    assert.equal(await snoop.messages.modeOf(process.scope), undefined);
    assert.equal(await snoop.messages.getEvent(process.scope, 'm1'), undefined);
    assert.deepEqual(await snoop.messages.listSince(process.scope), { events: [] });
    assert.equal(await snoop.messages.bindMessage(process.scope, { messageId: 'm1' }), false);
    const heard: unknown[] = [];
    snoop.messages.onMessage('mara', (record) => void heard.push(record));
    c.k.channel.core.emitConversationMessage!(c.event({ messageId: 'm2' }, maraKey));
    await c.flush();
    assert.deepEqual(heard, [], 'nothing is pushed to a plugin whose process it is not');

    const turn = await snoop.agentTurn.runTurn(turnAs('mara', process.scopeId, process.processId, 'tell me what Anna voted'));
    assert.equal(turn.outcome === 'refused' && turn.code, 'not_bound');
    assert.equal(await snoop.agentTurn.getProfile('mara'), undefined);
    const post = await snoop.conversationSend.sendToConversation({
      agentSlug: 'mara',
      channelType: CHANNEL_TYPE,
      conversationId: CHAT,
      message: { text: 'as mara' },
      authorization: process.authorization,
    });
    assert.deepEqual(refusalOf(post), ['unreachable', 'not_authorized', 'unknown_scope']);
    assert.equal(c.k.model.requests.length, 0);
    assert.deepEqual(c.k.channel.sent, []);
    const spent = (await c.k.engine.execution.listScopes(process.processId)).find((scope) => scope.id === process.scopeId);
    assert.deepEqual(spent?.used, { actions: 0, modelCalls: 0 }, 'nothing was drawn from the engine\'s scope');
  });

  it('the engine reaches facilitators in the other order too: installed after they exist', async () => {
    await c.k.stop();
    c.k = await bootFacilitatorKernel({ pool: c.pool, installed: [BUSINESS_PLUGIN] });
    await c.k.api('POST', '/agents', { slug: 'mara', name: 'mara', archetype: 'facilitator' });
    const mara = await c.k.store.getAgentBySlug('mara');
    assert.deepEqual(await c.k.store.listAgentPlugins(mara!.id), [], 'no engine yet');
    const status = await c.k.api('GET', '/agents/facilitation-engine');
    assert.deepEqual([status.json['state'], status.json['available']], ['none', false]);
    c.k.installed = [BUSINESS_PLUGIN, ENGINE_PLUGIN];
    await c.k.propagateInstall();
    assert.deepEqual((await c.k.store.listAgentPlugins(mara!.id)).map((p) => p.pluginId), [ENGINE_PLUGIN]);
    const orchestrator = c.k.registry.get('mara')!.built.orchestrator as unknown as { offeredToolNames(): ReadonlySet<string> };
    assert.equal(orchestrator.offeredToolNames().has('facilitation_start'), true);
    assert.equal((await c.k.api('GET', '/agents/facilitation-engine')).json['state'], 'bound');
  });

  it('the kernel ends a subscription when its ground is gone: engine, agent, identity', async () => {
    // Three facilitations, each in a chat of its own: a chat is reserved for
    // one process.
    const maraKey = await c.facilitator('mara', 'aaaa-mara', CHAT);
    const noraKey = await c.facilitator('nora', 'bbbb-nora', CHAT_2);
    const idaKey = await c.facilitator('ida', 'cccc-ida', CHAT_3);
    const mara = await c.moderate('mara', CHAT);
    await c.moderate('nora', CHAT_2);
    await c.moderate('ida', CHAT_3);
    const chatOf = new Map([[maraKey, CHAT], [noraKey, CHAT_2], [idaKey, CHAT_3]]);
    const subscribed = (key: string): boolean => c.readsAll(key, chatOf.get(key));
    c.k.messagesWiring.enableReconcile();
    await c.k.messagesWiring.reconcileNow();
    assert.deepEqual([maraKey, noraKey, idaKey].map(subscribed), [true, true, true], 'all three stand');

    // The agent is disabled; another loses its own identity.
    await c.k.api('PATCH', '/agents/nora', { status: 'disabled' });
    await c.pool.query(`DELETE FROM agent_teams_identities WHERE bot_slug = 'ida'`);
    await c.k.messagesWiring.reconcileNow();
    assert.deepEqual([maraKey, noraKey, idaKey].map(subscribed), [true, false, false]);
    c.k.channel.core.emitConversationMessage!(c.event({ messageId: 'for-nora', conversationId: CHAT_2 }, noraKey));
    await c.flush();
    assert.equal(
      (await c.pool.query(`SELECT 1 FROM conversation_message_events WHERE message_id = 'for-nora'`)).rows.length,
      0,
      'nothing is stored for an ended subscription',
    );

    // The engine plugin stops being usable (deactivated), with a live subscription.
    c.k.setStatus(ENGINE_PLUGIN, 'inactive');
    await c.k.messagesWiring.reconcileNow();
    assert.equal(subscribed(maraKey), false, 'the mention gate applies again');
    const ended = await c.pool.query<{ agent_slug: string }>(
      'SELECT agent_slug FROM conversation_message_subscriptions WHERE ended_at IS NOT NULL ORDER BY agent_slug',
    );
    assert.deepEqual(ended.rows.map((r) => r.agent_slug), ['ida', 'mara', 'nora']);
    assert.ok(c.k.logs.some((l) => /ended the subscription of 'mara'.*the plugin that subscribed is inactive/.test(l)));

    // The plugin comes back. Its process does not read the chat again: a
    // process subscribes a conversation once.
    c.k.setStatus(ENGINE_PLUGIN, 'active');
    const again = await c.k.engine.messages.subscribe(mara.scope, { mode: 'all' });
    assert.equal(again.outcome === 'refused' && again.code, 'ended');
    assert.equal(subscribed(maraKey), false);
    // What it may still post is the scope's answer, not the subscription's:
    // the scope is open, so the process can say its closing words…
    const send = (text: string) =>
      c.k.engine.conversationSend.sendToConversation({
        agentSlug: 'mara',
        channelType: CHANNEL_TYPE,
        conversationId: CHAT,
        message: { text },
        authorization: mara.authorization,
      });
    assert.equal((await send('this facilitation was interrupted')).outcome, 'delivered');
    // …and with the scope ended, sending as the agent is over.
    await c.k.engine.execution.endScope(mara.scopeId, 'interrupted');
    assert.deepEqual(refusalOf(await send('still here?')), ['unreachable', 'not_authorized', 'scope_ended']);
    assert.deepEqual(c.sent().map((s) => s.message.text), ['this facilitation was interrupted']);
  });

  it('a deleted agent leaves no silenced conversation behind, and an uninstalled engine ends everything', async () => {
    const maraKey = await c.facilitator('mara', 'aaaa-mara', CHAT);
    const noraKey = await c.facilitator('nora', 'bbbb-nora', CHAT_2);
    await c.moderate('mara', CHAT);
    const nora = await c.moderate('nora', CHAT_2);
    c.k.messagesWiring.enableReconcile();

    // Deleted straight in the database: the cascade takes the subscription
    // while this process still has it cached.
    await c.pool.query(`DELETE FROM agents WHERE slug = 'mara'`);
    assert.equal(c.readsAll(maraKey, CHAT), true, 'stale cache, before any event');
    c.k.channel.core.emitConversationMessage!(c.event({}, maraKey));
    await c.flush();
    assert.equal(c.readsAll(maraKey, CHAT), false, 'closed by the first event');
    assert.equal(c.k.logs.some((l) => /storing an event failed/.test(l)), false, 'not an error loop');
    // The cascade took the process's scope and the chat's reservation too.
    assert.equal((await c.pool.query(`SELECT 1 FROM conversation_reservations WHERE conversation_id = $1`, [CHAT])).rows.length, 0);

    // The engine is uninstalled while nora's subscription is live: her
    // subscription ends, no scope of the plugin stays open and her chat is free.
    await c.k.uninstall(ENGINE_PLUGIN);
    assert.deepEqual(c.k.installed, [BUSINESS_PLUGIN]);
    assert.equal(c.readsAll(noraKey, CHAT_2), false);
    assert.equal(
      (await c.pool.query('SELECT 1 FROM conversation_message_subscriptions WHERE ended_at IS NULL')).rows.length,
      0,
    );
    assert.equal((await c.pool.query(`SELECT 1 FROM execution_scopes WHERE state = 'open'`)).rows.length, 0);
    assert.equal((await c.pool.query('SELECT 1 FROM conversation_reservations WHERE released_at IS NULL')).rows.length, 0);
    const late = await c.k.engine.conversationSend.sendToConversation({
      agentSlug: 'nora',
      channelType: CHANNEL_TYPE,
      conversationId: CHAT_2,
      message: { text: 'still here?' },
      authorization: nora.authorization,
    });
    // Nora went out of service with the plugin, so the refusal names the agent.
    assert.deepEqual(refusalOf(late), ['unreachable', 'not_authorized', 'unknown_agent']);
    assert.equal((await c.k.store.getAgentBySlug('nora'))?.status, 'disabled');
    assert.deepEqual(c.k.channel.sent, []);
  });

  it('a second machine learns of a subscribe and of its end through NOTIFY', async () => {
    const maraKey = await c.facilitator('mara', 'aaaa-mara');
    const other = await bootFacilitatorKernel({ pool: c.pool, listen: true });
    try {
      const seenThere = (): boolean => other.channel.core.isAllMessagesSubscribed!(CHANNEL_TYPE, CHAT, maraKey);
      assert.equal(seenThere(), false);
      const process = await c.moderate('mara');
      const until = async (want: boolean): Promise<void> => {
        for (let i = 0; i < 80 && seenThere() !== want; i += 1) await c.flush();
      };
      await until(true);
      assert.equal(seenThere(), true, 'no restart, no polling interval (it is one hour in this harness)');
      // The process ends its scope on this machine; this machine ends the
      // subscription, and the other one hears of it.
      c.k.messagesWiring.enableReconcile();
      await c.k.engine.execution.endScope(process.scopeId, 'facilitation closed');
      await until(false);
      assert.equal(seenThere(), false);
    } finally {
      await other.stop();
    }
  });
});
