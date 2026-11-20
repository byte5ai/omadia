/**
 * #2054 — the operator routes of least privilege (spec 2042 §5.7, §7):
 *
 *  1. `GET /:slug/reach` and the directory (`GET /`) show the reach, and it
 *     matches the agent's effective grants (plugin + MCP grants).
 *  2. A plugin grant that gives an agent every connected system is refused
 *     with 409 `broad_reach_confirmation_required` unless the request carries
 *     `confirmBroadReach: true`; the confirmed grant is written AND audited.
 *     Same for the replace-set PUT.
 *  3. The "reset to all plugins" route is gone.
 *  4. `GET /plugin-catalog` marks capability plugins — the only ones the
 *     install flow offers.
 *  5. The first-run flow creates the first agent with an explicit choice of
 *     capabilities (zero allowed), refuses non-capability plugins and is
 *     offered only once.
 */

import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import {
  FALLBACK_AGENT_SEED_DESCRIPTION,
  FALLBACK_AGENT_SEED_NAME,
  FALLBACK_AGENT_SLUG,
  type AgentGraphStore,
  type ChatSessionStore,
  type ConfigStore,
  type OrchestratorRegistry,
} from '@omadia/orchestrator';

import type { AuditEntryInput } from '../src/auth/adminAuditLog.js';
import type { InstalledRegistry } from '../src/plugins/installedRegistry.js';
import type { PluginCatalog } from '../src/plugins/manifestLoader.js';
import { createOperatorAgentsRouter } from '../src/routes/operatorAgents.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

const ODOO = '@acme/integration-odoo';
const SEARCH = '@acme/web-search';
const TEAMS = '@acme/channel-teams';
const JIRA_SERVER = 'srv-jira';

interface AgentMem {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  privacyProfile: 'strict' | 'default';
  status: 'enabled' | 'disabled';
  archetype?: string;
  createdAt: Date;
  updatedAt: Date;
}
interface PluginMem {
  agentId: string;
  pluginId: string;
  config: Record<string, unknown>;
  enabled: boolean;
}

class FakeStore {
  agents: AgentMem[] = [];
  plugins: PluginMem[] = [];
  fallbackId: string | null = null;
  private n = 0;

  listAgents(): Promise<AgentMem[]> {
    return Promise.resolve([...this.agents]);
  }
  getAgentBySlug(slug: string): Promise<AgentMem | undefined> {
    return Promise.resolve(this.agents.find((a) => a.slug === slug));
  }
  createAgent(input: { slug: string; name: string; description?: string | null; archetype?: string }): Promise<AgentMem> {
    this.n += 1;
    const row: AgentMem = {
      id: `agent-${String(this.n)}`,
      slug: input.slug,
      name: input.name,
      description: input.description ?? null,
      privacyProfile: 'default',
      status: 'enabled',
      ...(input.archetype ? { archetype: input.archetype } : {}),
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    this.agents.push(row);
    return Promise.resolve(row);
  }
  updateAgent(id: string, patch: Partial<AgentMem>): Promise<AgentMem> {
    const i = this.agents.findIndex((a) => a.id === id);
    const updated = { ...this.agents[i]!, ...patch };
    this.agents[i] = updated;
    return Promise.resolve(updated);
  }
  listAgentPlugins(agentId: string): Promise<PluginMem[]> {
    return Promise.resolve(this.plugins.filter((p) => p.agentId === agentId));
  }
  listAllAgentPlugins(): Promise<PluginMem[]> {
    return Promise.resolve([...this.plugins]);
  }
  listChannelBindings(): Promise<never[]> {
    return Promise.resolve([]);
  }
  getPlatformSettings(): Promise<{ fallbackAgentId: string | null; updatedAt: Date }> {
    return Promise.resolve({ fallbackAgentId: this.fallbackId, updatedAt: new Date(0) });
  }
  upsertAgentPlugin(
    agentId: string,
    input: { pluginId: string; config?: Record<string, unknown>; enabled?: boolean },
  ): Promise<PluginMem> {
    this.plugins = this.plugins.filter((p) => !(p.agentId === agentId && p.pluginId === input.pluginId));
    const row = { agentId, pluginId: input.pluginId, config: input.config ?? {}, enabled: input.enabled ?? true };
    this.plugins.push(row);
    return Promise.resolve(row);
  }
  removeAgentPlugin(agentId: string, pluginId: string): Promise<void> {
    this.plugins = this.plugins.filter((p) => !(p.agentId === agentId && p.pluginId === pluginId));
    return Promise.resolve();
  }
}

function catalogOf(
  plugins: ReadonlyArray<{ id: string; name: string; kind: string; manifest?: unknown }>,
): PluginCatalog {
  const entries = plugins.map((p) => ({
    plugin: { id: p.id, name: p.name, kind: p.kind, version: '1.0.0', setup_fields: [], depends_on: [] },
    manifest: p.manifest ?? {},
  }));
  return {
    get: (id: string) => entries.find((e) => e.plugin.id === id),
    list: () => entries,
  } as unknown as PluginCatalog;
}

interface Harness {
  base: string;
  store: FakeStore;
  audits: AuditEntryInput[];
  close(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const store = new FakeStore();
  const audits: AuditEntryInput[] = [];
  const catalog = catalogOf([
    { id: ODOO, name: 'Odoo', kind: 'integration', manifest: { capabilities: [{ side_effects: 'read' }, { side_effects: 'write' }] } },
    { id: SEARCH, name: 'Web search', kind: 'tool', manifest: { capabilities: [{ side_effects: 'read' }] } },
    { id: TEAMS, name: 'Teams', kind: 'channel' },
  ]);
  const installed = { list: () => [ODOO, SEARCH, TEAMS].map((id) => ({ id, status: 'active' })) } as unknown as InstalledRegistry;
  const graph = {
    listMcpServers: () =>
      Promise.resolve([
        {
          id: JIRA_SERVER,
          name: 'jira',
          status: 'enabled',
          discoveredTools: [{ name: 'search', annotations: { readOnlyHint: true } }],
        },
      ]),
    listToolGrantsForAgent: (agentId: string) =>
      Promise.resolve(
        agentId === store.agents.find((a) => a.slug === 'sales')?.id
          ? [{ id: 'g1', agentId, subAgentId: null, toolKind: 'mcp', toolRef: 'jira:search', mcpServerId: JIRA_SERVER, config: {}, createdAt: new Date(0) }]
          : [],
      ),
    listPluginMcpGrantsForPlugins: () => Promise.resolve([]),
  };
  const registry = { list: () => [], get: () => undefined, reload: () => Promise.resolve() };
  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1/operator/agents',
    createOperatorAgentsRouter({
      getConfigStore: () => store as unknown as ConfigStore,
      getRegistry: () => registry as unknown as OrchestratorRegistry,
      getChatSessionStore: () => ({}) as unknown as ChatSessionStore,
      getAgentGraphStore: () => graph as unknown as AgentGraphStore,
      getPluginCatalog: () => catalog,
      getInstalledRegistry: () => installed,
      recordAudit: async (entry) => {
        audits.push(entry);
      },
    }),
  );
  const server: Server = await listenLoopback(app);
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${String(port)}/api/v1/operator/agents`,
    store,
    audits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function call(h: Harness, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${h.base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
  return { status: res.status, json: isJson && text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

describe('#2054 — reach, broad-reach confirmation and first-run flow', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('GET /:slug/reach and the directory show the reach, matching the effective grants', async () => {
    h = await harness();
    const sales = await h.store.createAgent({ slug: 'sales', name: 'Sales' });
    await h.store.upsertAgentPlugin(sales.id, { pluginId: ODOO });
    await h.store.upsertAgentPlugin(sales.id, { pluginId: SEARCH, enabled: false });
    await h.store.upsertAgentPlugin(sales.id, { pluginId: TEAMS });

    const { status, json } = await call(h, 'GET', '/sales/reach');
    assert.equal(status, 200);
    assert.deepEqual(
      (json['systems'] as Array<Record<string, unknown>>).map((s) => [s['key'], s['read'], s['write'], s['via']]),
      [
        // The disabled Web search row and the Teams channel are no reach.
        ['plugin:@acme/integration-odoo', true, true, ['grant']],
        ['mcp:srv-jira', true, false, ['grant']],
      ],
    );
    // Odoo + Web search + the Jira server; the channel is no connected system.
    assert.equal(json['connected_systems'], 3);
    assert.equal(json['broad'], false);

    const list = await call(h, 'GET', '/');
    const row = (list.json['agents'] as Array<Record<string, unknown>>).find((a) => a['slug'] === 'sales');
    const { slug: _slug, ...reach } = json;
    assert.deepEqual(row?.['reach'], reach, 'the directory shows the same reach');
  });

  it('a grant into every connected system: 409 without confirmation, granted + audited with it', async () => {
    h = await harness();
    const sales = await h.store.createAgent({ slug: 'sales', name: 'Sales' });
    await h.store.upsertAgentPlugin(sales.id, { pluginId: ODOO });

    const refused = await call(h, 'PATCH', '/sales/plugins', { id: SEARCH, enabled: true });
    assert.equal(refused.status, 409);
    assert.equal(refused.json['error'], 'broad_reach_confirmation_required');
    assert.equal(refused.json['change'], 'grant');
    assert.equal((refused.json['reach'] as Record<string, unknown>)['broad'], true);
    assert.equal(h.store.plugins.some((p) => p.pluginId === SEARCH), false, 'nothing granted');
    assert.equal(h.audits.length, 0);

    const granted = await call(h, 'PATCH', '/sales/plugins', { id: SEARCH, enabled: true, confirmBroadReach: true });
    assert.equal(granted.status, 200);
    assert.equal(h.store.plugins.some((p) => p.pluginId === SEARCH && p.enabled), true);
    assert.equal(h.audits.length, 1);
    const audit = h.audits[0]!;
    assert.equal(audit.action, 'agent.broad_reach_grant');
    assert.equal(audit.target, `agent:${sales.id}`);
    assert.deepEqual((audit.before as { broad: boolean }).broad, false);
    assert.deepEqual((audit.after as { broad: boolean; systems: string[] }).broad, true);
    assert.deepEqual(
      (audit.after as { systems: string[] }).systems.sort(),
      ['mcp:srv-jira', `plugin:${ODOO}`, `plugin:${SEARCH}`].sort(),
    );

    // Switching a grant off never asks.
    const again = await call(h, 'PATCH', '/sales/plugins', { id: SEARCH, enabled: false });
    assert.equal(again.status, 200);
    assert.equal(h.audits.length, 1);
  });

  it('the replace-set PUT is gated the same way; a grant short of everything is not', async () => {
    h = await harness();
    await h.store.createAgent({ slug: 'sales', name: 'Sales' });
    const partial = await call(h, 'PUT', '/sales/plugins', { plugins: [{ id: ODOO }] });
    assert.equal(partial.status, 200);
    assert.equal(h.audits.length, 0);

    const refused = await call(h, 'PUT', '/sales/plugins', { plugins: [{ id: ODOO }, { id: SEARCH }] });
    assert.equal(refused.status, 409);
    assert.equal(refused.json['error'], 'broad_reach_confirmation_required');
    assert.deepEqual(h.store.plugins.map((p) => p.pluginId), [ODOO]);

    const confirmed = await call(h, 'PUT', '/sales/plugins', {
      plugins: [{ id: ODOO }, { id: SEARCH }],
      confirmBroadReach: true,
    });
    assert.equal(confirmed.status, 200);
    assert.equal(h.audits.length, 1);
    assert.equal(h.audits[0]!.action, 'agent.broad_reach_grant');
  });

  it('the "reset standard to all plugins" route is gone', async () => {
    h = await harness();
    const res = await call(h, 'POST', '/fallback/rehydrate');
    assert.equal(res.status, 404);
  });

  it('the plugin catalog marks capability plugins', async () => {
    h = await harness();
    const { json } = await call(h, 'GET', '/plugin-catalog');
    assert.deepEqual(
      (json['items'] as Array<Record<string, unknown>>).map((i) => [i['id'], i['capability']]),
      [
        [ODOO, true],
        [SEARCH, true],
        [TEAMS, false],
      ],
    );
  });

  it('first run: the untouched seed becomes the first agent with exactly the chosen capabilities', async () => {
    h = await harness();
    const seed = await h.store.createAgent({
      slug: FALLBACK_AGENT_SLUG,
      name: FALLBACK_AGENT_SEED_NAME,
      description: FALLBACK_AGENT_SEED_DESCRIPTION,
    });
    const offer = await call(h, 'GET', '/onboarding');
    assert.equal(offer.json['required'], true);
    assert.deepEqual(
      (offer.json['capabilities'] as Array<Record<string, unknown>>).map((c) => c['id']),
      [ODOO, SEARCH],
      'capability plugins only, nothing preselected',
    );

    const notCapability = await call(h, 'POST', '/onboarding/first-agent', { name: 'Mira', plugin_ids: [TEAMS] });
    assert.equal(notCapability.status, 400);
    assert.equal(notCapability.json['error'], 'not_a_capability_plugin');

    const done = await call(h, 'POST', '/onboarding/first-agent', { name: 'Mira', plugin_ids: [SEARCH] });
    assert.equal(done.status, 200);
    assert.equal(h.store.agents.length, 1);
    assert.equal(h.store.agents[0]!.name, 'Mira');
    assert.deepEqual(h.store.plugins.map((p) => [p.agentId, p.pluginId]), [[seed.id, SEARCH]]);

    const after = await call(h, 'GET', '/onboarding');
    assert.equal(after.json['required'], false);
    const twice = await call(h, 'POST', '/onboarding/first-agent', { name: 'Again', plugin_ids: [] });
    assert.equal(twice.status, 409);
    assert.equal(twice.json['error'], 'onboarding_not_required');
  });

  it('first run without any agent creates one; zero capabilities is allowed', async () => {
    h = await harness();
    const done = await call(h, 'POST', '/onboarding/first-agent', { name: 'Mira Müller', plugin_ids: [] });
    assert.equal(done.status, 201);
    assert.equal(done.json['slug'], 'mira-muller');
    assert.deepEqual(h.store.plugins, []);
  });
});
