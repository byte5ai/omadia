/**
 * #2060 — write-time refusals for facilitator-kind agents (spec 2043 §2.3).
 *
 * Every omission an operator could try to configure is refused by the route
 * that would write it, with a stable `error`/`omission` pair and a message
 * that says why, and WITHOUT a write. The fakes record every mutating call,
 * so "refused" also means "nothing changed".
 */

import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';

import express from 'express';

import type { AgentGraphStore, ConfigStore, OrchestratorRegistry } from '@omadia/orchestrator';

import { createAgentBuilderRouter } from '../src/routes/agentBuilder.js';
import { createOperatorAgentsRouter } from '../src/routes/operatorAgents.js';
import { createOperatorChannelsRouter } from '../src/routes/operatorChannels.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

const ENGINE = '@omadia/agent-facilitator';
const ODOO = '@omadia/integration-odoo';
const SKILL_ID = '11111111-1111-4111-8111-111111111111';
const SERVER_ID = '22222222-2222-4222-8222-222222222222';

interface FakeAgent {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  privacyProfile: 'default';
  status: 'enabled';
  kind: 'standard' | 'facilitator';
  createdAt: Date;
  updatedAt: Date;
}

function agent(slug: string, kind: FakeAgent['kind']): FakeAgent {
  return {
    id: `id-${slug}`,
    slug,
    name: slug,
    description: null,
    privacyProfile: 'default',
    status: 'enabled',
    kind,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

describe('facilitator omissions: operator routes', () => {
  let server: Server;
  let base: string;
  let writes: string[];
  let agents: FakeAgent[];
  let installed: { id: string; status: string }[];
  let identitySaves: number;
  let engineState: unknown;

  const provides: Record<string, string[]> = {
    [ENGINE]: ['facilitationEngine@1'],
    '@acme/second-engine': ['facilitationEngine@1'],
    [ODOO]: [],
  };

  /** Read methods answer; every mutating method is recorded. An unexpected
   *  call fails loudly so a refusal test cannot pass by accident. */
  function store(): ConfigStore {
    const reads: Record<string, (...args: never[]) => unknown> = {
      getAgentBySlug: (slug: string) => Promise.resolve(agents.find((a) => a.slug === slug)),
      listAgents: () => Promise.resolve(agents),
      getPlatformSettings: () => Promise.resolve({ fallbackAgentId: 'id-hr', updatedAt: new Date(0) }),
      listAgentPlugins: () => Promise.resolve([]),
      listAllAgentPlugins: () => Promise.resolve([]),
      listChannelBindings: () => Promise.resolve([]),
      listChannelBindingsForAgent: () => Promise.resolve([]),
      listChannelIdentities: () => Promise.resolve([]),
      resolveBinding: () => Promise.resolve(undefined),
      getAgentChannelPolicy: () => Promise.resolve(undefined),
      createAgent: (input: { slug: string; name: string; kind?: FakeAgent['kind'] }) => {
        const created = agent(input.slug, input.kind ?? 'standard');
        agents.push(created);
        return Promise.resolve(created);
      },
    };
    return new Proxy(
      {},
      {
        get: (_t, prop: string) =>
          reads[prop] ??
          ((...args: unknown[]) => {
            writes.push(`${prop}(${JSON.stringify(args).slice(0, 80)})`);
            return Promise.resolve({ fallbackAgentId: null, updatedAt: new Date(0), agentToAgent: true });
          }),
      },
    ) as ConfigStore;
  }

  function graph(): AgentGraphStore {
    return new Proxy(
      {},
      {
        get: (_t, prop: string) => {
          if (prop === 'getSkill') {
            return () => Promise.resolve({ id: SKILL_ID, frontmatter: {}, body: '', description: '' });
          }
          if (prop === 'listMcpServers') return () => Promise.resolve([{ id: SERVER_ID, name: 'crm' }]);
          return (...args: unknown[]) => {
            writes.push(`graph.${prop}(${JSON.stringify(args).slice(0, 60)})`);
            return Promise.resolve({ id: 'x', agentId: 'x', skillId: SKILL_ID, position: 0 });
          };
        },
      },
    ) as AgentGraphStore;
  }

  before(async () => {
    const registry = {
      reload: () => Promise.resolve({ actions: [], platformChanged: false }),
      list: () => [],
      get: () => undefined,
    } as unknown as OrchestratorRegistry;
    const app = express();
    app.use(express.json());
    app.use(
      '/agents',
      createOperatorAgentsRouter({
        getConfigStore: () => store(),
        getRegistry: () => registry,
        getChatSessionStore: () => undefined,
        getFacilitationEngineState: () => engineState,
        getInstalledRegistry: () => ({ list: () => installed }) as never,
        getPluginCatalog: () =>
          ({ get: (id: string) => (id in provides ? { plugin: { provides: provides[id] } } : undefined) }) as never,
        getAgentIdentity: () => ({
          store: {
            getByAgentId: () => Promise.resolve(undefined),
            save: () => {
              identitySaves += 1;
              return Promise.reject(new Error('save must not be reached'));
            },
          } as never,
        }),
      }),
    );
    app.use(
      '/channels',
      createOperatorChannelsRouter({
        getConfigStore: () => store(),
        getRegistry: () => registry,
        getDirectoryRegistry: () => ({ list: () => [], types: () => [] }) as never,
      }),
    );
    app.use(
      '/builder',
      createAgentBuilderRouter({
        getConfigStore: () => store(),
        getGraphStore: () => graph(),
        getRegistry: () => registry,
      }),
    );
    server = await listenLoopback(app);
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  beforeEach(() => {
    writes = [];
    identitySaves = 0;
    agents = [agent('mara', 'facilitator'), agent('hr', 'standard')];
    installed = [
      { id: ENGINE, status: 'active' },
      { id: ODOO, status: 'active' },
    ];
  });

  async function call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  }

  function assertRefused(
    res: { status: number; json: Record<string, unknown> },
    omission: string,
    messagePattern: RegExp,
  ): void {
    assert.equal(res.status, 409, JSON.stringify(res.json));
    assert.equal(res.json['error'], 'facilitator_omission');
    assert.equal(res.json['omission'], omission);
    assert.match(String(res.json['message']), messagePattern);
    assert.deepEqual(writes, [], 'a refusal writes nothing');
  }

  it('reports the facilitation engine state for the directory', async () => {
    engineState = undefined;
    assert.deepEqual((await call('GET', '/agents/facilitation-engine')).json, {
      state: 'bound',
      capability: 'facilitationEngine@1',
      plugin_id: ENGINE,
      plugin_ids: [ENGINE],
      version: null,
      available: false,
      unavailable_reason: 'The facilitation engine plugin is installed but not active.',
    });
    engineState = { pluginId: ENGINE, version: '1.0.0', available: false, unavailableReason: 'No SQL grant.' };
    const noSql = (await call('GET', '/agents/facilitation-engine')).json;
    assert.equal(noSql['available'], false);
    assert.equal(noSql['unavailable_reason'], 'No SQL grant.');
    assert.equal(noSql['version'], '1.0.0');
    engineState = { pluginId: ENGINE, version: '1.0.0', available: true };
    const ok = (await call('GET', '/agents/facilitation-engine')).json;
    assert.deepEqual([ok['state'], ok['available'], ok['unavailable_reason']], ['bound', true, null]);
    // A report from a plugin that is not the bound engine does not count.
    engineState = { pluginId: '@acme/other', version: '9', available: true };
    assert.equal((await call('GET', '/agents/facilitation-engine')).json['available'], false);

    installed = [{ id: ODOO, status: 'active' }];
    const none = (await call('GET', '/agents/facilitation-engine')).json;
    assert.deepEqual([none['state'], none['plugin_id'], none['available']], ['none', null, false]);
    installed = [
      { id: ENGINE, status: 'active' },
      { id: '@acme/second-engine', status: 'active' },
    ];
    const two = (await call('GET', '/agents/facilitation-engine')).json;
    assert.equal(two['state'], 'ambiguous');
    assert.deepEqual(two['plugin_ids'], ['@acme/second-engine', ENGINE]);
  });

  it('creates a facilitator and reports the kind in create, list and picker', async () => {
    const created = await call('POST', '/agents', { slug: 'nora', name: 'Nora', kind: 'facilitator' });
    assert.equal(created.status, 201);
    assert.equal(created.json['kind'], 'facilitator');
    const plain = await call('POST', '/agents', { slug: 'sales', name: 'Sales' });
    assert.equal(plain.json['kind'], 'standard');
    const bogus = await call('POST', '/agents', { slug: 'x', name: 'X', kind: 'moderator' });
    assert.equal(bogus.status, 400);

    const list = await call('GET', '/agents');
    const kinds = Object.fromEntries(
      (list.json['agents'] as { slug: string; kind: string }[]).map((a) => [a.slug, a.kind]),
    );
    assert.deepEqual(kinds, { mara: 'facilitator', hr: 'standard', nora: 'facilitator', sales: 'standard' });
    const enabled = await call('GET', '/agents/enabled');
    assert.equal((enabled.json['agents'] as { slug: string; kind: string }[])[0]!.kind, 'facilitator');
  });

  it('create attaches the engine to a facilitator, and only to a facilitator', async () => {
    await call('POST', '/agents', { slug: 'nora', name: 'Nora', kind: 'facilitator' });
    assert.equal(writes.length, 1);
    assert.match(writes[0]!, /^upsertAgentPlugin\(\["id-nora",\{"pluginId":"@omadia\/agent-facilitator","enabled":true\}/);
    writes = [];
    await call('POST', '/agents', { slug: 'sales', name: 'Sales' });
    assert.deepEqual(writes, []);
    // No engine installed: the facilitator is created, the engine follows on install.
    installed = [{ id: ODOO, status: 'active' }];
    assert.equal((await call('POST', '/agents', { slug: 'ida', name: 'Ida', kind: 'facilitator' })).status, 201);
    assert.deepEqual(writes, []);
  });

  it('the engine cannot be granted to a standard agent', async () => {
    const res = await call('PATCH', '/agents/hr/plugins', { id: ENGINE, enabled: true });
    assert.equal(res.status, 409);
    assert.equal(res.json['error'], 'config_validation');
    assert.match(String(res.json['message']), /can only be granted to a facilitator/);
    assert.deepEqual(writes, []);
  });

  it('the kind cannot be patched', async () => {
    const res = await call('PATCH', '/agents/hr', { kind: 'facilitator', name: 'HR' });
    assert.equal(res.status, 200);
    assert.equal(writes.length, 1);
    assert.equal(writes[0]!.includes('kind'), false, 'kind is not part of any update');
  });

  it('plugin grant: a business plugin is refused (toggle and replace)', async () => {
    const toggle = await call('PATCH', '/agents/mara/plugins', { id: ODOO, enabled: true });
    assertRefused(toggle, 'plugin_grant', /only '@omadia\/agent-facilitator' \(the facilitation engine\) can be granted/);
    assert.deepEqual(toggle.json['refused_plugins'], [ODOO]);
    const replace = await call('PUT', '/agents/mara/plugins', {
      plugins: [{ id: ENGINE }, { id: ODOO, enabled: true }],
    });
    assertRefused(replace, 'plugin_grant', /business plugins would make it partial/);
  });

  it('plugin grant: the engine plugin is granted, found by capability', async () => {
    const res = await call('PATCH', '/agents/mara/plugins', { id: ENGINE, enabled: true });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(writes.length, 1);
    assert.match(writes[0]!, /^upsertAgentPlugin/);
    writes = [];
    // A disabled row grants nothing, so switching a stale grant off stays possible.
    const off = await call('PUT', '/agents/mara/plugins', { plugins: [{ id: ODOO, enabled: false }] });
    assert.equal(off.status, 200, JSON.stringify(off.json));
  });

  it('plugin grant: refused without an engine, and with two', async () => {
    installed = [{ id: ODOO, status: 'active' }];
    assertRefused(
      await call('PATCH', '/agents/mara/plugins', { id: ENGINE, enabled: true }),
      'plugin_grant',
      /no facilitation engine plugin is installed/,
    );
    installed = [
      { id: ENGINE, status: 'active' },
      { id: '@acme/second-engine', status: 'inactive' },
    ];
    assertRefused(
      await call('PATCH', '/agents/mara/plugins', { id: ENGINE, enabled: true }),
      'plugin_grant',
      /more than one facilitation engine is installed/,
    );
    // An errored provider does not count.
    installed = [
      { id: ENGINE, status: 'active' },
      { id: '@acme/second-engine', status: 'errored' },
    ];
    assert.equal((await call('PATCH', '/agents/mara/plugins', { id: ENGINE, enabled: true })).status, 200);
  });

  it('a standard agent keeps every grant path', async () => {
    assert.equal((await call('PATCH', '/agents/hr/plugins', { id: ODOO, enabled: true })).status, 200);
    assert.equal((await call('PUT', '/agents/hr/agent-to-agent', { mode: 'on' })).status, 200);
    assert.equal((await call('PUT', '/agents/hr/context-memory', { mode: 'enforce' })).status, 200);
    assert.equal((await call('PUT', '/agents/fallback', { slug: 'hr' })).status, 200);
  });

  it('default agent designation is refused', async () => {
    assertRefused(
      await call('PUT', '/agents/fallback', { slug: 'mara' }),
      'default_agent',
      /cannot be the default agent/,
    );
  });

  it('memory: a context-memory mode is refused', async () => {
    assertRefused(
      await call('PUT', '/agents/mara/context-memory', { mode: 'enforce' }),
      'memory',
      /no general memory/,
    );
    assert.equal((await call('PUT', '/agents/mara/context-memory', { mode: 'off' })).status, 200);
  });

  it('agent-to-agent: the switch and the per-chat policy are refused', async () => {
    assertRefused(
      await call('PUT', '/agents/mara/agent-to-agent', { mode: 'on' }),
      'agent_to_agent',
      /neither talks to other agents nor is addressed by them/,
    );
    assertRefused(
      await call('PUT', `/agents/mara/peer-channels/teams/${encodeURIComponent('19:abc@thread.v2')}`, {
        enabled: true,
      }),
      'agent_to_agent',
      /neither talks to other agents/,
    );
  });

  it('identity: instructions and persona against the contract are refused with findings', async () => {
    const res = await call('PUT', '/agents/mara/identity', {
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
    assert.equal(identitySaves, 0, 'nothing was stored');
  });

  it('channel bindings are refused: agent bindings, channel rebind and the canvas edge', async () => {
    assertRefused(
      await call('PUT', '/agents/mara/bindings', {
        bindings: [{ channel_type: 'teams', channel_key: '28:default-bot' }],
      }),
      'channel_binding',
      /speaks only as its own channel identity/,
    );
    assertRefused(
      await call('PUT', '/channels/binding', {
        channel_type: 'teams',
        channel_key: '28:default-bot',
        agent_slug: 'mara',
      }),
      'channel_binding',
      /answer through another bot/,
    );
    assertRefused(
      await call('POST', '/builder/agents/mara/graph/edges', {
        kind: 'channel_bind',
        source: 'channel:teams:28:default-bot',
        target: 'agent:id-mara',
      }),
      'channel_binding',
      /own channel identity/,
    );
    // Clearing stale rows stays possible, and a standard agent is unaffected.
    assert.equal((await call('PUT', '/agents/mara/bindings', { bindings: [] })).status, 200);
    writes = [];
    const hr = await call('PUT', '/agents/hr/bindings', {
      bindings: [{ channel_type: 'teams', channel_key: '28:default-bot' }],
    });
    assert.equal(hr.status, 200, JSON.stringify(hr.json));
  });

  it('persona skills are refused', async () => {
    assertRefused(
      await call('POST', '/builder/agents/mara/persona-skills', { skillId: SKILL_ID }),
      'persona_skill',
      /no persona skills/,
    );
  });

  it('sub-agents (consultation by attachment) are refused', async () => {
    assertRefused(
      await call('POST', '/builder/agents/mara/subagents', { name: 'researcher' }),
      'sub_agent',
      /no sub-agents/,
    );
  });

  it('tool grants are refused: canvas edge and MCP grant', async () => {
    assertRefused(
      await call('POST', '/builder/agents/mara/graph/edges', {
        kind: 'tool_grant',
        source: 'agent:id-mara',
        target: 'tool:odoo_version',
      }),
      'tool_grant',
      /other tool grants would make it partial/,
    );
    assertRefused(
      await call('PUT', '/builder/mcp-grants', { agentSlug: 'mara', mcpServerId: SERVER_ID, toolName: 'search' }),
      'tool_grant',
      /only gets the tools of the facilitation engine/,
    );
  });

  it('schedules (standing orders) are refused', async () => {
    assertRefused(
      await call('POST', '/builder/agents/mara/schedules', { cron: '0 9 * * 1' }),
      'assistance',
      /not an assistant/,
    );
  });
});
