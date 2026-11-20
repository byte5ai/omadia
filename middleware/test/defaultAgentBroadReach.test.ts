/**
 * #2054 — spec 2042 §5.7: designating an agent with access to every
 * connected system as a default agent needs the operator's explicit
 * confirmation and is audited (`agent.broad_reach_default`). An agent short
 * of everything is set without asking.
 */

import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import type { ConfigStore, OrchestratorRegistry } from '@omadia/orchestrator';

import type { AuditEntryInput } from '../src/auth/adminAuditLog.js';
import type { InstalledRegistry } from '../src/plugins/installedRegistry.js';
import type { PluginCatalog } from '../src/plugins/manifestLoader.js';
import { createOperatorDefaultAgentsRouter } from '../src/routes/managementLayer.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

const ODOO = '@acme/integration-odoo';
const SEARCH = '@acme/web-search';

interface Harness {
  base: string;
  audits: AuditEntryInput[];
  upserts: Array<{ agentId: string | null }>;
  close(): Promise<void>;
}

async function harness(grantsOfMira: string[]): Promise<Harness> {
  const audits: AuditEntryInput[] = [];
  const upserts: Array<{ agentId: string | null }> = [];
  const mira = { id: 'a-mira', slug: 'mira', name: 'Mira', status: 'enabled', archetype: 'standard' };
  const record = {
    id: mira.id,
    slug: mira.slug,
    name: mira.name,
    status: 'enabled',
    deleted: false,
    defaultable: true,
    availableToEveryone: true,
    availableChannels: null,
    bindable: true,
  };
  const store = {
    getAgentBySlug: (slug: string) => Promise.resolve(slug === 'mira' ? mira : undefined),
    listAgentPlugins: () => Promise.resolve(grantsOfMira.map((pluginId) => ({ agentId: mira.id, pluginId, config: {}, enabled: true }))),
    routing: {
      listDefaultEntries: () => Promise.resolve([]),
      upsertDefaultEntry: (input: { principal: string | null; channelType: string | null; agentId: string | null }) => {
        upserts.push({ agentId: input.agentId });
        return Promise.resolve({ id: 'e1', ...input, updatedAt: new Date(0), updatedBy: null });
      },
    },
  } as unknown as ConfigStore;
  const registry = {
    reload: () => Promise.resolve(),
    get: () => undefined,
    list: () => [],
    routingView: () => ({
      agentBySlug: (slug: string) => (slug === 'mira' ? record : undefined),
      agentById: (id: string) => (id === mira.id ? record : undefined),
      agents: () => [record],
      defaultEntries: () => [],
      availabilityPrincipals: () => [],
      selections: () => [],
      roleMembership: () => [],
    }),
  } as unknown as OrchestratorRegistry;
  const entries = [
    { plugin: { id: ODOO, name: 'Odoo', kind: 'integration' }, manifest: {} },
    { plugin: { id: SEARCH, name: 'Web search', kind: 'tool' }, manifest: {} },
  ];
  const catalog = { get: (id: string) => entries.find((e) => e.plugin.id === id), list: () => entries } as unknown as PluginCatalog;
  const installed = { list: () => [ODOO, SEARCH].map((id) => ({ id, status: 'active' })) } as unknown as InstalledRegistry;
  const app = express();
  app.use(express.json());
  app.use(
    '/default-agents',
    createOperatorDefaultAgentsRouter({
      getConfigStore: () => store,
      getRegistry: () => registry,
      audit: (entry) => {
        audits.push(entry);
        return Promise.resolve();
      },
      reachSources: () => ({ catalog, installed }),
    }),
  );
  const server: Server = await listenLoopback(app);
  return {
    base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/default-agents`,
    audits,
    upserts,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function put(h: Harness, body: Record<string, unknown>) {
  const res = await fetch(h.base, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const INSTANCE = { principal: null, channel_type: null, agent_slug: 'mira' };

describe('#2054 — a default agent with every connected system is confirmed and audited', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('409 without confirmation; confirmed: set and audited as agent.broad_reach_default', async () => {
    h = await harness([ODOO, SEARCH]);
    const refused = await put(h, INSTANCE);
    assert.equal(refused.status, 409, JSON.stringify(refused.json));
    assert.equal(refused.json['error'], 'broad_reach_confirmation_required');
    assert.equal(refused.json['change'], 'default_agent');
    assert.deepEqual(h.upserts, [], 'nothing written');

    const ok = await put(h, { ...INSTANCE, confirmBroadReach: true });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.deepEqual(h.upserts, [{ agentId: 'a-mira' }]);
    assert.deepEqual(
      h.audits.map((a) => a.action),
      ['agent.default_entry.set', 'agent.broad_reach_default'],
    );
  });

  it('an agent short of everything, or `off`, is set without asking', async () => {
    h = await harness([ODOO]);
    assert.equal((await put(h, INSTANCE)).status, 200);
    assert.equal((await put(h, { ...INSTANCE, agent_slug: null })).status, 200);
    assert.equal(h.audits.some((a) => a.action === 'agent.broad_reach_default'), false);
  });
});
