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
 */

import { strict as assert } from 'node:assert';
import { after, afterEach, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import {
  ConfigValidationError,
  type ChatSessionStore,
  type ConfigStore,
  type OrchestratorRegistry,
} from '@omadia/orchestrator';
import { createOperatorAgentsRouter } from '../src/routes/operatorAgents.js';

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

function newId(): string {
  return `00000000-0000-0000-0000-${String(Date.now() % 1e12).padStart(12, '0')}`;
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
  let sessionStore: { list: () => Promise<unknown[]> };

  before(() => {
    store = new FakeConfigStore();
    registry = new FakeRegistry();
    sessionStore = { list: () => Promise.resolve([]) };
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
    server = app.listen(0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${String(addr.port)}/api/v1/operator/agents`;
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  afterEach(() => {
    store = new FakeConfigStore();
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
    const s = app.listen(0);
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
