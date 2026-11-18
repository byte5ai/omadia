/**
 * Native facilitators, kernel contract suite (#2068, kernel half; epic #2043):
 * what is refused, who gets nothing, and when the kernel ends a subscription
 * on its own. The walk-through of one facilitation is in
 * `facilitatorContract.pg.test.ts`; both share `_helpers/facilitatorContractSuite.ts`.
 */

import { strict as assert } from 'node:assert';
import { it } from 'node:test';


import {
  ANNA,
  CHAT,
  contractSuite,
} from './_helpers/facilitatorContractSuite.js';
import {
  bootFacilitatorKernel,
  BUSINESS_PLUGIN,
  CHANNEL_TYPE,
  ENGINE_PLUGIN,
} from './_helpers/facilitatorKernelHarness.js';

await contractSuite('native facilitators: kernel contract, guards (pg)', 'facilitatorGuards', (c) => {
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

    const subscribe = await c.k.engine.messages.subscribe(c.scope('hr'));
    assert.equal(subscribe.outcome === 'refused' && subscribe.code, 'not_facilitator');
    assert.equal(c.k.channel.core.isAllMessagesSubscribed!(CHANNEL_TYPE, CHAT, hrKey), false);
    c.k.channel.core.emitConversationMessage!(c.event({}, hrKey));
    await c.flush();
    assert.equal((await c.pool.query('SELECT 1 FROM conversation_message_events')).rows.length, 0);

    const turn = await c.k.engine.agentTurn.runTurn({
      agentSlug: 'hr',
      sessionKey: 's',
      channelType: CHANNEL_TYPE,
      conversationId: CHAT,
      input: 'hello',
    });
    assert.equal(turn.outcome === 'refused' && turn.code, 'not_bound');
    const post = await c.k.engine.conversationSend.sendToConversation({
      agentSlug: 'hr',
      channelType: CHANNEL_TYPE,
      conversationId: CHAT,
      asOwnIdentity: true,
      message: { text: 'hello' },
    });
    assert.equal(post.outcome === 'unreachable' && post.code, 'not_permitted');
    assert.deepEqual(c.k.channel.sent, []);
  });

  it('a plugin that is not the engine gets nothing, even for a real facilitation', async () => {
    const maraKey = await c.facilitator('mara', 'aaaa-mara');
    await c.k.engine.messages.subscribe(c.scope('mara'));
    c.k.channel.core.emitConversationMessage!(c.event({}, maraKey));
    await c.flush();
    const snoop = c.k.servicesAs(BUSINESS_PLUGIN);
    const subscribe = await snoop.messages.subscribe(c.scope('mara'));
    assert.equal(subscribe.outcome === 'refused' && subscribe.code, 'unavailable');
    assert.equal(await snoop.messages.getEvent(c.scope('mara'), 'm1'), undefined);
    assert.deepEqual(await snoop.messages.listSince(c.scope('mara')), { events: [] });
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
    assert.equal(c.k.model.requests.length, 0);
    assert.deepEqual(c.k.channel.sent, []);
  });

  it('the engine reaches facilitators in the other order too: installed after they exist', async () => {
    await c.k.stop();
    c.k = await bootFacilitatorKernel({ pool: c.pool, installed: [BUSINESS_PLUGIN] });
    await c.k.api('POST', '/agents', { slug: 'mara', name: 'mara', kind: 'facilitator' });
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
    const maraKey = await c.facilitator('mara', 'aaaa-mara');
    const noraKey = await c.facilitator('nora', 'bbbb-nora');
    const idaKey = await c.facilitator('ida', 'cccc-ida');
    for (const slug of ['mara', 'nora', 'ida']) {
      assert.deepEqual(await c.k.engine.messages.subscribe(c.scope(slug)), { outcome: 'subscribed' });
    }
    const subscribed = (key: string): boolean => c.k.channel.core.isAllMessagesSubscribed!(CHANNEL_TYPE, CHAT, key);
    c.k.messagesWiring.enableReconcile();
    await c.k.messagesWiring.reconcileNow();
    assert.deepEqual([maraKey, noraKey, idaKey].map(subscribed), [true, true, true], 'all three stand');

    // The agent is disabled; another loses its own identity.
    await c.k.api('PATCH', '/agents/nora', { status: 'disabled' });
    await c.pool.query(`DELETE FROM agent_teams_identities WHERE bot_slug = 'ida'`);
    await c.k.messagesWiring.reconcileNow();
    assert.deepEqual([maraKey, noraKey, idaKey].map(subscribed), [true, false, false]);
    c.k.channel.core.emitConversationMessage!(c.event({ messageId: 'for-nora' }, noraKey));
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
    assert.ok(c.k.logs.some((l) => /ended the subscription of 'mara'.*facilitation engine plugin is inactive/.test(l)));
    // Sending as the agent went with the subscription.
    c.k.setStatus(ENGINE_PLUGIN, 'active');
    const late = await c.k.engine.conversationSend.sendToConversation({
      agentSlug: 'mara',
      channelType: CHANNEL_TYPE,
      conversationId: CHAT,
      asOwnIdentity: true,
      message: { text: 'still here?' },
    });
    assert.equal(late.outcome === 'unreachable' && late.code, 'not_permitted');
  });

  it('a deleted agent leaves no silenced conversation behind, and an uninstalled engine ends everything', async () => {
    const maraKey = await c.facilitator('mara', 'aaaa-mara');
    const noraKey = await c.facilitator('nora', 'bbbb-nora');
    await c.k.engine.messages.subscribe(c.scope('mara'));
    await c.k.engine.messages.subscribe(c.scope('nora'));
    c.k.messagesWiring.enableReconcile();

    // Deleted straight in the database: the cascade takes the subscription
    // while this process still has it cached.
    await c.pool.query(`DELETE FROM agents WHERE slug = 'mara'`);
    assert.equal(c.k.channel.core.isAllMessagesSubscribed!(CHANNEL_TYPE, CHAT, maraKey), true, 'stale cache, before any event');
    c.k.channel.core.emitConversationMessage!(c.event({}, maraKey));
    await c.flush();
    assert.equal(c.k.channel.core.isAllMessagesSubscribed!(CHANNEL_TYPE, CHAT, maraKey), false, 'closed by the first event');
    assert.equal(c.k.logs.some((l) => /storing an event failed/.test(l)), false, 'not an error loop');

    // The engine is uninstalled while nora's subscription is live.
    c.k.installed = [BUSINESS_PLUGIN];
    await c.k.messagesWiring.reconcileNow();
    assert.equal(c.k.channel.core.isAllMessagesSubscribed!(CHANNEL_TYPE, CHAT, noraKey), false);
    assert.equal(
      (await c.pool.query('SELECT 1 FROM conversation_message_subscriptions WHERE ended_at IS NULL')).rows.length,
      0,
    );
  });

  it('a second machine learns of a subscribe and an unsubscribe through NOTIFY', async () => {
    const maraKey = await c.facilitator('mara', 'aaaa-mara');
    const other = await bootFacilitatorKernel({ pool: c.pool, listen: true });
    try {
      const seenThere = (): boolean => other.channel.core.isAllMessagesSubscribed!(CHANNEL_TYPE, CHAT, maraKey);
      assert.equal(seenThere(), false);
      await c.k.engine.messages.subscribe(c.scope('mara'));
      const until = async (want: boolean): Promise<void> => {
        for (let i = 0; i < 80 && seenThere() !== want; i += 1) await c.flush();
      };
      await until(true);
      assert.equal(seenThere(), true, 'no restart, no polling interval (it is one hour in this harness)');
      await c.k.engine.messages.unsubscribe(c.scope('mara'));
      await until(false);
      assert.equal(seenThere(), false);
    } finally {
      await other.stop();
    }
  });
});
