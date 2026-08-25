/**
 * US9 / T042 — operator Agents REST router tests.
 *
 *  1. GET / returns the agent list + memory_scope + active flag from the
 *     fake registry.
 *  2. POST / creates an agent; PATCH /:slug updates name/status/privacy;
 *     DELETE /:slug removes it.
 *  3. PUT /:slug/plugins replaces the plugin set; PUT /:slug/bindings
 *     replaces the channel bindings (both call reload() afterwards).
 *  4. PUT /fallback sets/clears platform_settings.fallback_agent_id.
 *  5. POST /:slug/drain and /:slug/kill call registry.forceInvalidate.
 *  6. ConfigValidationError surfaces as HTTP 409.
 *  7. Zod errors surface as HTTP 400 with a structured `issues` array.
 *  8. 503 when no orchestratorRegistry is published.
 *  9. W0c (#861): GET /:slug/plugins reads the assignment; PATCH
 *     /:slug/plugins flips ONE plugin (config preserved, fallback keeps the
 *     global config, unassigned+disable → 404); GET /:slug/grants returns
 *     the agent's tool grants (grant epoch included) + the plugin MCP
 *     grants of its assigned plugins, and 503s without a graph store.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { after, afterEach, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import {
  ConfigValidationError,
  type AgentGraphStore,
  type ChatSessionStore,
  type ConfigStore,
  type OrchestratorRegistry,
} from '@omadia/orchestrator';
import { createOperatorAgentsRouter } from '../src/routes/operatorAgents.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

interface AgentMem {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  privacyProfile: 'strict' | 'default';
  status: 'enabled' | 'disabled';
  createdAt: Date;
  updatedAt: Date;
}
interface PluginMem {
  agentId: string;
  pluginId: string;
  config: Record<string, unknown>;
  enabled: boolean;
  createdAt: Date;
}
interface BindingMem {
  channelType: string;
  channelKey: string;
  agentId: string;
  createdAt: Date;
}

let idCounter = 0;
function newId(): string {
  // Monotonic, not time-based: two agents created in the same millisecond
  // must still get distinct ids (the W0c grants test creates two).
  idCounter += 1;
  return `00000000-0000-0000-0000-${String(idCounter).padStart(12, '0')}`;
}

/**
 * Hand-rolled fake ConfigStore. Reuses the production ConfigStore's method
 * names so the type narrows when handed to the router; only the methods
 * the router calls are implemented.
 */
class FakeConfigStore {
  agents = new Map<string, AgentMem>();
  plugins = new Map<string, PluginMem>(); // key: agentId|pluginId
  bindings = new Map<string, BindingMem>(); // key: type|key
  fallbackId: string | null = null;

  listAgents(): Promise<AgentMem[]> {
    return Promise.resolve(Array.from(this.agents.values()));
  }
  listAllAgentPlugins(): Promise<PluginMem[]> {
    return Promise.resolve(Array.from(this.plugins.values()));
  }
  listChannelBindings(): Promise<BindingMem[]> {
    return Promise.resolve(Array.from(this.bindings.values()));
  }
  listAgentPlugins(agentId: string): Promise<PluginMem[]> {
    return Promise.resolve(
      Array.from(this.plugins.values()).filter((p) => p.agentId === agentId),
    );
  }
  listChannelBindingsForAgent(agentId: string): Promise<BindingMem[]> {
    return Promise.resolve(
      Array.from(this.bindings.values()).filter((b) => b.agentId === agentId),
    );
  }
  getPlatformSettings(): Promise<{ fallbackAgentId: string | null; updatedAt: Date }> {
    return Promise.resolve({ fallbackAgentId: this.fallbackId, updatedAt: new Date() });
  }
  getAgentBySlug(slug: string): Promise<AgentMem | undefined> {
    for (const a of this.agents.values()) if (a.slug === slug) return Promise.resolve(a);
    return Promise.resolve(undefined);
  }
  createAgent(input: {
    slug: string;
    name: string;
    description?: string | null;
    privacyProfile?: 'strict' | 'default';
    status?: 'enabled' | 'disabled';
  }): Promise<AgentMem> {
    for (const a of this.agents.values()) {
      if (a.slug === input.slug) {
        return Promise.reject(new ConfigValidationError(`slug "${input.slug}" exists`));
      }
    }
    const row: AgentMem = {
      id: newId(),
      slug: input.slug,
      name: input.name,
      description: input.description ?? null,
      privacyProfile: input.privacyProfile ?? 'default',
      status: input.status ?? 'enabled',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.agents.set(row.id, row);
    return Promise.resolve(row);
  }
  updateAgent(
    id: string,
    patch: Partial<{
      name: string;
      description: string | null;
      privacyProfile: 'strict' | 'default';
      status: 'enabled' | 'disabled';
    }>,
  ): Promise<AgentMem> {
    const row = this.agents.get(id);
    if (!row) return Promise.reject(new ConfigValidationError(`not found`));
    const updated: AgentMem = { ...row, ...patch, updatedAt: new Date() };
    this.agents.set(id, updated);
    return Promise.resolve(updated);
  }
  deleteAgent(id: string): Promise<void> {
    this.agents.delete(id);
    return Promise.resolve();
  }
  upsertAgentPlugin(
    agentId: string,
    input: { pluginId: string; config?: Record<string, unknown>; enabled?: boolean },
  ): Promise<PluginMem> {
    const row: PluginMem = {
      agentId,
      pluginId: input.pluginId,
      config: input.config ?? {},
      enabled: input.enabled ?? true,
      createdAt: new Date(),
    };
    this.plugins.set(`${agentId}|${input.pluginId}`, row);
    return Promise.resolve(row);
  }
  removeAgentPlugin(agentId: string, pluginId: string): Promise<void> {
    this.plugins.delete(`${agentId}|${pluginId}`);
    return Promise.resolve();
  }
  createChannelBinding(
    agentId: string,
    input: { channelType: string; channelKey: string },
  ): Promise<BindingMem> {
    const key = `${input.channelType}|${input.channelKey}`;
    const existing = this.bindings.get(key);
    if (existing && existing.agentId !== agentId) {
      return Promise.reject(
        new ConfigValidationError(`binding (${key}) already bound to another agent`),
      );
    }
    const row: BindingMem = { ...input, agentId, createdAt: new Date() };
    this.bindings.set(key, row);
    return Promise.resolve(row);
  }
  removeChannelBinding(channelType: string, channelKey: string): Promise<void> {
    this.bindings.delete(`${channelType}|${channelKey}`);
    return Promise.resolve();
  }
  resolveBinding(channelType: string, channelKey: string): Promise<BindingMem | undefined> {
    return Promise.resolve(this.bindings.get(`${channelType}|${channelKey}`));
  }
  setFallbackAgentId(id: string | null): Promise<{ fallbackAgentId: string | null; updatedAt: Date }> {
    this.fallbackId = id;
    return Promise.resolve({ fallbackAgentId: id, updatedAt: new Date() });
  }
}

interface ToolGrantMem {
  id: string;
  agentId: string | null;
  subAgentId: string | null;
  toolKind: string;
  toolRef: string;
  mcpServerId: string | null;
  config: Record<string, unknown>;
  createdAt: Date;
  grantEpoch: string | null;
}
interface PluginMcpGrantMem {
  pluginId: string;
  mcpServerId: string;
  grantedBy: string;
  grantedAt: Date;
}

/** Fake AgentGraphStore — only the three reads GET /:slug/grants uses. */
class FakeGraphStore {
  toolGrants: ToolGrantMem[] = [];
  pluginGrants: PluginMcpGrantMem[] = [];
  servers: Array<{ id: string; name: string }> = [];
  /** agentId → its sub-agent ids, mirroring agent_subagents. */
  subAgentsOf: Record<string, readonly string[]> = {};

  listToolGrantsForAgent(agentId: string): Promise<ToolGrantMem[]> {
    // Mirrors the real store's contract (W0c): rows held directly by the
    // agent PLUS rows held by one of ITS sub-agents (agent_id NULL there).
    const subs = new Set(this.subAgentsOf[agentId] ?? []);
    return Promise.resolve(
      this.toolGrants.filter(
        (g) => g.agentId === agentId || (g.subAgentId !== null && subs.has(g.subAgentId)),
      ),
    );
  }
  listPluginMcpGrantsForPlugins(
    pluginIds: readonly string[],
  ): Promise<PluginMcpGrantMem[]> {
    const wanted = new Set(pluginIds);
    return Promise.resolve(this.pluginGrants.filter((g) => wanted.has(g.pluginId)));
  }
  listMcpServers(): Promise<Array<{ id: string; name: string }>> {
    return Promise.resolve(this.servers);
  }
}

class FakeRegistry {
  reloadCalls = 0;
  invalidateCalls: Array<{ slug: string; mode: 'drain' | 'kill' }> = [];

  list() {
    return [];
  }
  get(slug: string) {
    return { memoryScope: [`agent:fake:${slug}:*`, 'core'] };
  }
  reload(): Promise<{ actions: unknown[]; platformChanged: boolean }> {
    this.reloadCalls += 1;
    return Promise.resolve({ actions: [], platformChanged: false });
  }
  forceInvalidate(slug: string, mode: 'drain' | 'kill'): Promise<number> {
    this.invalidateCalls.push({ slug, mode });
    return Promise.resolve(2);
  }
}

describe('createOperatorAgentsRouter', () => {
  let server: Server;
  let baseUrl: string;
  let store: FakeConfigStore;
  let registry: FakeRegistry;
  let graph: FakeGraphStore;
  let sessionStore: { list: () => Promise<unknown[]> };

  before(async () => {
    store = new FakeConfigStore();
    registry = new FakeRegistry();
    graph = new FakeGraphStore();
    sessionStore = { list: () => Promise.resolve([]) };
    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1/operator/agents',
      createOperatorAgentsRouter({
        getConfigStore: () => store as unknown as ConfigStore,
        getRegistry: () => registry as unknown as OrchestratorRegistry,
        getChatSessionStore: () => sessionStore as unknown as ChatSessionStore,
        getAgentGraphStore: () => graph as unknown as AgentGraphStore,
      }),
    );
    server = await listenLoopback(app);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${String(addr.port)}/api/v1/operator/agents`;
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  afterEach(() => {
    store = new FakeConfigStore();
    graph = new FakeGraphStore();
    registry.reloadCalls = 0;
    registry.invalidateCalls = [];
  });

  it('POST / creates an agent and triggers a reload', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'public', name: 'Public Agent' }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { slug: string };
    assert.equal(body.slug, 'public');
    assert.equal(registry.reloadCalls, 1);
  });

  it('POST / surfaces a Zod validation error as HTTP 400', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: '', name: 'x' }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string; issues: unknown[] };
    assert.equal(body.error, 'invalid_body');
    assert.ok(Array.isArray(body.issues));
  });

  it('POST / surfaces a ConfigValidationError as HTTP 409', async () => {
    await store.createAgent({ slug: 'pub', name: 'Pub' });
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'pub', name: 'Dup' }),
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'config_validation');
  });

  it('GET / returns the agent list with runtime memory_scope', async () => {
    await store.createAgent({ slug: 'public', name: 'Public' });
    const res = await fetch(baseUrl);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      agents: Array<{ slug: string; memory_scope: string[] }>;
    };
    assert.equal(body.agents.length, 1);
    assert.equal(body.agents[0]!.slug, 'public');
    assert.deepEqual(body.agents[0]!.memory_scope, [
      'agent:fake:public:*',
      'core',
    ]);
  });

  it('PATCH /:slug updates status and triggers a reload', async () => {
    await store.createAgent({ slug: 'public', name: 'Public' });
    const res = await fetch(`${baseUrl}/public`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'disabled' }),
    });
    assert.equal(res.status, 200);
    const agent = await store.getAgentBySlug('public');
    assert.equal(agent?.status, 'disabled');
    assert.equal(registry.reloadCalls, 1);
  });

  it('DELETE /:slug removes the agent', async () => {
    await store.createAgent({ slug: 'public', name: 'Public' });
    const res = await fetch(`${baseUrl}/public`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.equal(await store.getAgentBySlug('public'), undefined);
  });

  it('PATCH /:slug refuses to DISABLE the fallback orchestrator (409 fallback_protected)', async () => {
    await store.createAgent({ slug: 'fallback', name: 'Standard Orchestrator' });
    const res = await fetch(`${baseUrl}/fallback`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'disabled' }),
    });
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { error: string }).error, 'fallback_protected');
    assert.equal((await store.getAgentBySlug('fallback'))?.status, 'enabled', 'stayed enabled');
  });

  it('PATCH /:slug still allows ENABLING / renaming the fallback orchestrator', async () => {
    await store.createAgent({ slug: 'fallback', name: 'Standard Orchestrator' });
    const res = await fetch(`${baseUrl}/fallback`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'enabled', name: 'Renamed' }),
    });
    assert.equal(res.status, 200, 'only disable/delete are blocked');
  });

  it('DELETE /:slug refuses to delete the fallback orchestrator (409 fallback_protected)', async () => {
    await store.createAgent({ slug: 'fallback', name: 'Standard Orchestrator' });
    const res = await fetch(`${baseUrl}/fallback`, { method: 'DELETE' });
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { error: string }).error, 'fallback_protected');
    assert.ok(await store.getAgentBySlug('fallback'), 'not deleted');
  });

  it('protects whatever the platform fallbackAgentId points at (id-based, non-"fallback" slug)', async () => {
    const agent = await store.createAgent({ slug: 'special', name: 'Special' });
    await store.setFallbackAgentId(agent.id);
    const res = await fetch(`${baseUrl}/special`, { method: 'DELETE' });
    assert.equal(res.status, 409, 'active platform fallback protected by id');
    assert.equal(((await res.json()) as { error: string }).error, 'fallback_protected');
  });

  it('PUT /:slug/plugins replaces the plugin set', async () => {
    const agent = await store.createAgent({ slug: 'public', name: 'Public' });
    await store.upsertAgentPlugin(agent.id, { pluginId: '@omadia/old' });
    const res = await fetch(`${baseUrl}/public/plugins`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        plugins: [
          { id: '@omadia/a', enabled: true },
          { id: '@omadia/b', enabled: false },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const remaining = await store.listAgentPlugins(agent.id);
    const ids = remaining.map((p) => p.pluginId).sort();
    assert.deepEqual(ids, ['@omadia/a', '@omadia/b']);
  });

  it('GET /:slug/plugins reads the assignment (W0c #861)', async () => {
    const agent = await store.createAgent({ slug: 'public', name: 'Public' });
    await store.upsertAgentPlugin(agent.id, {
      pluginId: '@omadia/odoo',
      config: { url: 'https://odoo.example' },
      enabled: true,
    });
    await store.upsertAgentPlugin(agent.id, {
      pluginId: '@omadia/confluence',
      enabled: false,
    });
    const res = await fetch(`${baseUrl}/public/plugins`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      slug: string;
      fallback: boolean;
      plugins: Array<{ id: string; config: Record<string, unknown>; enabled: boolean }>;
    };
    assert.equal(body.slug, 'public');
    assert.equal(body.fallback, false);
    const byId = new Map(body.plugins.map((p) => [p.id, p]));
    assert.equal(byId.size, 2);
    assert.deepEqual(byId.get('@omadia/odoo')?.config, { url: 'https://odoo.example' });
    assert.equal(byId.get('@omadia/odoo')?.enabled, true);
    assert.equal(byId.get('@omadia/confluence')?.enabled, false);
  });

  it('GET /:slug/plugins 404s for an unknown agent', async () => {
    const res = await fetch(`${baseUrl}/ghost/plugins`);
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { error: string }).error, 'not_found');
  });

  it('PATCH /:slug/plugins disables ONE plugin, preserves its config, reloads', async () => {
    const agent = await store.createAgent({ slug: 'public', name: 'Public' });
    await store.upsertAgentPlugin(agent.id, {
      pluginId: '@omadia/odoo',
      config: { url: 'https://odoo.example' },
      enabled: true,
    });
    const res = await fetch(`${baseUrl}/public/plugins`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: '@omadia/odoo', enabled: false }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      plugin: { id: string; enabled: boolean };
    };
    assert.equal(body.ok, true);
    assert.deepEqual(body.plugin, { id: '@omadia/odoo', enabled: false });
    const rows = await store.listAgentPlugins(agent.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.enabled, false);
    assert.deepEqual(
      rows[0]!.config,
      { url: 'https://odoo.example' },
      'toggle must not wipe the per-agent config',
    );
    assert.equal(registry.reloadCalls, 1);
  });

  it('PATCH /:slug/plugins with enabled=true assigns a not-yet-assigned plugin', async () => {
    const agent = await store.createAgent({ slug: 'public', name: 'Public' });
    const res = await fetch(`${baseUrl}/public/plugins`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: '@omadia/fresh', enabled: true }),
    });
    assert.equal(res.status, 200);
    const rows = await store.listAgentPlugins(agent.id);
    assert.deepEqual(
      rows.map((p) => ({ id: p.pluginId, enabled: p.enabled })),
      [{ id: '@omadia/fresh', enabled: true }],
    );
  });

  it('PATCH /:slug/plugins with enabled=false on an unassigned plugin → 404 plugin_not_assigned', async () => {
    await store.createAgent({ slug: 'public', name: 'Public' });
    const res = await fetch(`${baseUrl}/public/plugins`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: '@omadia/ghost', enabled: false }),
    });
    assert.equal(res.status, 404);
    assert.equal(
      ((await res.json()) as { error: string }).error,
      'plugin_not_assigned',
    );
    assert.equal(registry.reloadCalls, 0, 'no reload on a rejected toggle');
  });

  it('PATCH /:slug/plugins keeps the fallback agent on the global config ({})', async () => {
    const agent = await store.createAgent({ slug: 'special', name: 'Special' });
    await store.setFallbackAgentId(agent.id);
    await store.upsertAgentPlugin(agent.id, {
      pluginId: '@omadia/odoo',
      config: { smuggled: true },
      enabled: true,
    });
    const res = await fetch(`${baseUrl}/special/plugins`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: '@omadia/odoo', enabled: false }),
    });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { fallback: boolean }).fallback, true);
    const rows = await store.listAgentPlugins(agent.id);
    assert.deepEqual(
      rows[0]!.config,
      {},
      'fallback Agent always runs plugins with the global store config',
    );
  });

  it('GET /:slug/grants returns tool grants + plugin MCP grants + grant epoch (W0c #861)', async () => {
    const agent = await store.createAgent({ slug: 'public', name: 'Public' });
    const other = await store.createAgent({ slug: 'other', name: 'Other' });
    await store.upsertAgentPlugin(agent.id, { pluginId: '@omadia/odoo' });
    graph.servers = [{ id: 'srv-1', name: 'odoo-mcp' }];
    graph.toolGrants = [
      {
        id: 'g-1',
        agentId: agent.id,
        subAgentId: null,
        toolKind: 'mcp',
        toolRef: 'mcp:odoo-mcp:search',
        mcpServerId: 'srv-1',
        config: {},
        createdAt: new Date('2026-08-01T00:00:00Z'),
        grantEpoch: '2026-08-20 10:00:00+00',
      },
      {
        id: 'g-2',
        agentId: agent.id,
        subAgentId: null,
        toolKind: 'builtin',
        toolRef: 'web_search',
        mcpServerId: null,
        config: {},
        createdAt: new Date('2026-08-02T00:00:00Z'),
        grantEpoch: '2026-08-21 09:30:00+00',
      },
      {
        id: 'g-3',
        agentId: other.id,
        subAgentId: null,
        toolKind: 'mcp',
        toolRef: 'mcp:odoo-mcp:write',
        mcpServerId: 'srv-1',
        config: {},
        createdAt: new Date('2026-08-03T00:00:00Z'),
        grantEpoch: null,
      },
    ];
    graph.pluginGrants = [
      {
        pluginId: '@omadia/odoo',
        mcpServerId: 'srv-1',
        grantedBy: 'operator',
        grantedAt: new Date('2026-08-10T00:00:00Z'),
      },
      {
        pluginId: '@omadia/unassigned',
        mcpServerId: 'srv-1',
        grantedBy: 'operator',
        grantedAt: new Date('2026-08-11T00:00:00Z'),
      },
    ];
    const res = await fetch(`${baseUrl}/public/grants`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      slug: string;
      grant_epoch: string | null;
      tool_grants: Array<{
        id: string;
        server_name: string | null;
        grant_epoch: string | null;
      }>;
      plugin_mcp_grants: Array<{ plugin_id: string; server_name: string | null }>;
    };
    assert.equal(body.slug, 'public');
    assert.equal(body.grant_epoch, '2026-08-21 09:30:00+00', 'latest bump wins');
    assert.deepEqual(
      body.tool_grants.map((g) => g.id),
      ['g-1', 'g-2'],
      'only the agent\'s own grants',
    );
    assert.equal(body.tool_grants[0]!.server_name, 'odoo-mcp');
    assert.equal(body.tool_grants[0]!.grant_epoch, '2026-08-20 10:00:00+00');
    assert.deepEqual(
      body.plugin_mcp_grants.map((g) => g.plugin_id),
      ['@omadia/odoo'],
      'plugin grants scoped to the plugins assigned to THIS agent',
    );
    assert.equal(body.plugin_mcp_grants[0]!.server_name, 'odoo-mcp');
  });

  it('GET /:slug/grants includes grants held by the agent\'s SUB-agents, attributed via sub_agent_id (W0c)', async () => {
    // agent_tool_grants is a XOR table: a sub-agent-held grant has agent_id
    // NULL. Hiding those rows made the detail page claim "no grants" while
    // the sub-agent could reach the server (the W0c review's failing state).
    const agent = await store.createAgent({ slug: 'public', name: 'Public' });
    const other = await store.createAgent({ slug: 'other', name: 'Other' });
    graph.servers = [{ id: 'srv-1', name: 'odoo-mcp' }];
    graph.subAgentsOf = { [agent.id]: ['sa-researcher'], [other.id]: ['sa-foreign'] };
    graph.toolGrants = [
      {
        id: 'g-sub',
        agentId: null,
        subAgentId: 'sa-researcher',
        toolKind: 'mcp',
        toolRef: 'odoo-mcp:search',
        mcpServerId: 'srv-1',
        config: {},
        createdAt: new Date('2026-08-01T00:00:00Z'),
        grantEpoch: '2026-08-22 08:00:00+00',
      },
      {
        id: 'g-foreign',
        agentId: null,
        subAgentId: 'sa-foreign',
        toolKind: 'mcp',
        toolRef: 'odoo-mcp:write',
        mcpServerId: 'srv-1',
        config: {},
        createdAt: new Date('2026-08-02T00:00:00Z'),
        grantEpoch: null,
      },
    ];
    const res = await fetch(`${baseUrl}/public/grants`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      grant_epoch: string | null;
      tool_grants: Array<{ id: string; sub_agent_id: string | null; tool_ref: string }>;
    };
    assert.deepEqual(
      body.tool_grants.map((g) => g.id),
      ['g-sub'],
      "own sub-agents' grants in, other agents' sub-agents out",
    );
    assert.equal(body.tool_grants[0]!.sub_agent_id, 'sa-researcher');
    assert.equal(
      body.grant_epoch,
      '2026-08-22 08:00:00+00',
      'a sub-agent grant epoch counts toward the agent-level max',
    );
  });

  it('GET /:slug/grants normalizes a serverName-prefixed mcp tool_ref to the bare tool name (W0c)', async () => {
    // Stored refs may carry the '<serverName>:' prefix (canvas edges persist
    // the caller's raw ref). Every other reader normalizes via
    // mcpToolNameFromRef; the read model must too, so the UI can compare
    // tool_ref against discoveredTools[].name verbatim.
    const agent = await store.createAgent({ slug: 'public', name: 'Public' });
    graph.servers = [{ id: 'srv-1', name: 'odoo-mcp' }];
    graph.toolGrants = [
      {
        id: 'g-prefixed',
        agentId: agent.id,
        subAgentId: null,
        toolKind: 'mcp',
        toolRef: 'odoo-mcp:search_partners',
        mcpServerId: 'srv-1',
        config: {},
        createdAt: new Date('2026-08-01T00:00:00Z'),
        grantEpoch: null,
      },
      {
        id: 'g-native',
        agentId: agent.id,
        subAgentId: null,
        toolKind: 'native',
        toolRef: 'memory:search', // native refs are NOT server-prefixed — stay verbatim
        mcpServerId: null,
        config: {},
        createdAt: new Date('2026-08-02T00:00:00Z'),
        grantEpoch: null,
      },
    ];
    const res = await fetch(`${baseUrl}/public/grants`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { tool_grants: Array<{ id: string; tool_ref: string }> };
    assert.equal(body.tool_grants[0]!.tool_ref, 'search_partners');
    assert.equal(body.tool_grants[1]!.tool_ref, 'memory:search');
  });

  it('index.ts supplies getAgentGraphStore to the operator-agents mount (wiring pin, W0c)', async () => {
    // The route tests above inject their own store; they cannot see a missing
    // option at the REAL mount. That exact gap shipped once: index.ts called
    // createOperatorAgentsRouter without getAgentGraphStore and every
    // /grants request 503ed in every environment (W0c review blocker). Pin
    // the wiring statically so the option cannot silently disappear again.
    const indexSource = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
    const mount = /createOperatorAgentsRouter\(\{([\s\S]*?)\}\)/.exec(indexSource)?.[1];
    assert.ok(mount, 'index.ts no longer mounts createOperatorAgentsRouter — update this pin');
    assert.match(
      mount,
      /getAgentGraphStore:/,
      'index.ts must pass getAgentGraphStore to createOperatorAgentsRouter — without it every GET /:slug/grants 503s',
    );
    assert.match(mount, /new AgentGraphStore\(graphPool\)/, 'the option must construct the real store from graphPool');
  });

  it('GET /:slug/grants → grant_epoch null when no grant was ever bumped', async () => {
    const agent = await store.createAgent({ slug: 'public', name: 'Public' });
    graph.toolGrants = [
      {
        id: 'g-1',
        agentId: agent.id,
        subAgentId: null,
        toolKind: 'builtin',
        toolRef: 'web_search',
        mcpServerId: null,
        config: {},
        createdAt: new Date(),
        grantEpoch: null,
      },
    ];
    const res = await fetch(`${baseUrl}/public/grants`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { grant_epoch: string | null };
    assert.equal(body.grant_epoch, null);
  });

  it('GET /:slug/grants 503s when no agent graph store is wired', async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1/operator/agents',
      createOperatorAgentsRouter({
        getConfigStore: () => store as unknown as ConfigStore,
        getRegistry: () => registry as unknown as OrchestratorRegistry,
        getChatSessionStore: () => sessionStore as unknown as ChatSessionStore,
      }),
    );
    const s = await listenLoopback(app);
    try {
      await store.createAgent({ slug: 'public', name: 'Public' });
      const addr = s.address() as AddressInfo;
      const res = await fetch(
        `http://127.0.0.1:${String(addr.port)}/api/v1/operator/agents/public/grants`,
      );
      assert.equal(res.status, 503);
      assert.equal(
        ((await res.json()) as { error: string }).error,
        'agent_graph_store_unavailable',
      );
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
  });

  it('PUT /:slug/bindings replaces the channel bindings', async () => {
    const agent = await store.createAgent({ slug: 'public', name: 'Public' });
    const res = await fetch(`${baseUrl}/public/bindings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        bindings: [
          { channel_type: 'teams', channel_key: '28:abc' },
          { channel_type: 'telegram', channel_key: '@bot' },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const bindings = await store.listChannelBindingsForAgent(agent.id);
    assert.equal(bindings.length, 2);
  });

  it('PUT /fallback sets and clears the fallback agent', async () => {
    await store.createAgent({ slug: 'pub', name: 'Pub' });
    let res = await fetch(`${baseUrl}/fallback`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'pub' }),
    });
    assert.equal(res.status, 200);
    assert.ok(store.fallbackId);

    res = await fetch(`${baseUrl}/fallback`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: null }),
    });
    assert.equal(res.status, 200);
    assert.equal(store.fallbackId, null);
  });

  it('POST /:slug/drain calls forceInvalidate(drain)', async () => {
    await store.createAgent({ slug: 'public', name: 'Public' });
    const res = await fetch(`${baseUrl}/public/drain`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { affected: number };
    assert.equal(body.affected, 2);
    assert.deepEqual(registry.invalidateCalls, [
      { slug: 'public', mode: 'drain' },
    ]);
  });

  it('POST /:slug/kill calls forceInvalidate(kill)', async () => {
    await store.createAgent({ slug: 'public', name: 'Public' });
    const res = await fetch(`${baseUrl}/public/kill`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.deepEqual(registry.invalidateCalls, [
      { slug: 'public', mode: 'kill' },
    ]);
  });

  it('POST /reload triggers a manual registry reload', async () => {
    const res = await fetch(`${baseUrl}/reload`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(registry.reloadCalls, 1);
  });

  it('503 when the orchestratorRegistry is not published', async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1/operator/agents',
      createOperatorAgentsRouter({
        getConfigStore: () => undefined,
        getRegistry: () => undefined,
        getChatSessionStore: () => undefined,
      }),
    );
    const s = await listenLoopback(app);
    try {
      const addr = s.address() as AddressInfo;
      const res = await fetch(
        `http://127.0.0.1:${String(addr.port)}/api/v1/operator/agents`,
      );
      assert.equal(res.status, 503);
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
  });
});
