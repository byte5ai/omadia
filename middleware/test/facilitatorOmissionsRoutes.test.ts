/**
 * #2060 — write-time refusals for facilitator-kind agents (spec 2043 §2.3).
 *
 * Every omission an operator could try to configure is refused by the route
 * that would write it, with a stable `error`/`omission` pair and a message
 * that says why, and WITHOUT a write. The fakes record every mutating call,
 * so "refused" also means "nothing changed". The engine side (status, grant,
 * attach) is in `facilitatorEngineRoutes.test.ts`.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { ENGINE, ODOO, routesHarness, SERVER_ID, SKILL_ID } from './_helpers/facilitatorRoutesHarness.js';

describe('facilitator omissions: operator routes', () => {
  const h = routesHarness();

  it('plugin grant: a business plugin is refused (toggle and replace)', async () => {
    const toggle = await h.call('PATCH', '/agents/mara/plugins', { id: ODOO, enabled: true });
    h.assertRefused(toggle, 'plugin_grant', /only '@omadia\/agent-facilitator' \(the facilitation engine\) can be granted/);
    assert.deepEqual(toggle.json['refused_plugins'], [ODOO]);
    const replace = await h.call('PUT', '/agents/mara/plugins', {
      plugins: [{ id: ENGINE }, { id: ODOO, enabled: true }],
    });
    h.assertRefused(replace, 'plugin_grant', /business plugins would make it partial/);
  });

  it('a standard agent keeps every grant path', async () => {
    assert.equal((await h.call('PATCH', '/agents/hr/plugins', { id: ODOO, enabled: true })).status, 200);
    assert.equal((await h.call('PUT', '/agents/hr/agent-to-agent', { mode: 'on' })).status, 200);
    assert.equal((await h.call('PUT', '/agents/hr/context-memory', { mode: 'enforce' })).status, 200);
    assert.equal((await h.call('PUT', '/agents/fallback', { slug: 'hr' })).status, 200);
  });

  it('default agent designation is refused', async () => {
    h.assertRefused(
      await h.call('PUT', '/agents/fallback', { slug: 'mara' }),
      'default_agent',
      /cannot be the default agent/,
    );
  });

  it('memory: a context-memory mode is refused', async () => {
    h.assertRefused(
      await h.call('PUT', '/agents/mara/context-memory', { mode: 'enforce' }),
      'memory',
      /no general memory/,
    );
    assert.equal((await h.call('PUT', '/agents/mara/context-memory', { mode: 'off' })).status, 200);
  });

  it('agent-to-agent: the switch and the per-chat policy are refused', async () => {
    h.assertRefused(
      await h.call('PUT', '/agents/mara/agent-to-agent', { mode: 'on' }),
      'agent_to_agent',
      /neither talks to other agents nor is addressed by them/,
    );
    h.assertRefused(
      await h.call('PUT', `/agents/mara/peer-channels/teams/${encodeURIComponent('19:abc@thread.v2')}`, {
        enabled: true,
      }),
      'agent_to_agent',
      /neither talks to other agents/,
    );
  });

  it('identity: instructions and persona against the contract are refused with findings', async () => {
    const res = await h.call('PUT', '/agents/mara/identity', {
      instructions: 'Always favour the sales team.',
      persona: { axes: { sarcasm: 90 } },
      quality: { sycophancy: 'off' },
    });
    assert.equal(res.status, 422, JSON.stringify(res.json));
    assert.equal(res.json['error'], 'facilitator_contract_violation');
    assert.deepEqual(
      (res.json['issues'] as { path: string; rule: string }[]).map((i) => `${i.path}:${i.rule}`),
      ['instructions:partiality', 'persona.axes.sarcasm:persona_axis_above_bound', 'quality.sycophancy:sycophancy_guard_off'],
    );
    assert.equal(h.identitySaves, 0, 'nothing was stored');
  });

  it('channel bindings are refused: agent bindings, channel rebind and the canvas edge', async () => {
    h.assertRefused(
      await h.call('PUT', '/agents/mara/bindings', {
        bindings: [{ channel_type: 'teams', channel_key: '28:default-bot' }],
      }),
      'channel_binding',
      /speaks only as its own channel identity/,
    );
    h.assertRefused(
      await h.call('PUT', '/channels/binding', {
        channel_type: 'teams',
        channel_key: '28:default-bot',
        agent_slug: 'mara',
      }),
      'channel_binding',
      /answer through another bot/,
    );
    h.assertRefused(
      await h.call('POST', '/builder/agents/mara/graph/edges', {
        kind: 'channel_bind',
        source: 'channel:teams:28:default-bot',
        target: 'agent:id-mara',
      }),
      'channel_binding',
      /own channel identity/,
    );
    // Clearing stale rows stays possible, and a standard agent is unaffected.
    assert.equal((await h.call('PUT', '/agents/mara/bindings', { bindings: [] })).status, 200);
    h.writes = [];
    const hr = await h.call('PUT', '/agents/hr/bindings', {
      bindings: [{ channel_type: 'teams', channel_key: '28:default-bot' }],
    });
    assert.equal(hr.status, 200, JSON.stringify(hr.json));
  });

  it('persona skills are refused', async () => {
    h.assertRefused(
      await h.call('POST', '/builder/agents/mara/persona-skills', { skillId: SKILL_ID }),
      'persona_skill',
      /no persona skills/,
    );
  });

  it('sub-agents (consultation by attachment) are refused', async () => {
    h.assertRefused(
      await h.call('POST', '/builder/agents/mara/subagents', { name: 'researcher' }),
      'sub_agent',
      /no sub-agents/,
    );
  });

  it('tool grants are refused: canvas edge and MCP grant', async () => {
    h.assertRefused(
      await h.call('POST', '/builder/agents/mara/graph/edges', {
        kind: 'tool_grant',
        source: 'agent:id-mara',
        target: 'tool:odoo_version',
      }),
      'tool_grant',
      /other tool grants would make it partial/,
    );
    h.assertRefused(
      await h.call('PUT', '/builder/mcp-grants', { agentSlug: 'mara', mcpServerId: SERVER_ID, toolName: 'search' }),
      'tool_grant',
      /only gets the tools of the facilitation engine/,
    );
  });

  it('schedules (standing orders) are refused', async () => {
    h.assertRefused(
      await h.call('POST', '/builder/agents/mara/schedules', { cron: '0 9 * * 1' }),
      'assistance',
      /not an assistant/,
    );
  });
});
