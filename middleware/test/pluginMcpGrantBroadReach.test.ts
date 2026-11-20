/**
 * #2054 — spec 2042 §5.7: a plugin MCP grant (`PUT /plugin-mcp-grants`) makes
 * the server reachable for every agent that holds the plugin. When that gives
 * one of them every connected system, the grant needs `confirmBroadReach` and
 * is audited per agent; an agent without the plugin is never asked about.
 */

import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import type { AgentGraphStore, ConfigStore, OrchestratorRegistry } from '@omadia/orchestrator';

import type { AuditEntryInput } from '../src/auth/adminAuditLog.js';
import type { InstalledRegistry } from '../src/plugins/installedRegistry.js';
import type { PluginCatalog } from '../src/plugins/manifestLoader.js';
import { createAgentBuilderRouter } from '../src/routes/agentBuilder.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

const ODOO = '@acme/integration-odoo';
const JIRA = '00000000-0000-4000-8000-0000000000a1';

interface Harness {
  base: string;
  audits: AuditEntryInput[];
  writes: string[];
  close(): Promise<void>;
}

async function harness(holders: string[]): Promise<Harness> {
  const audits: AuditEntryInput[] = [];
  const writes: string[] = [];
  const agents = [
    { id: 'a-sales', slug: 'sales', name: 'Sales', status: 'enabled' },
    { id: 'a-hr', slug: 'hr', name: 'HR', status: 'enabled' },
  ];
  const rows = holders.map((agentId) => ({ agentId, pluginId: ODOO, config: {}, enabled: true }));
  const config = {
    listAgents: () => Promise.resolve(agents),
    listAllAgentPlugins: () => Promise.resolve(rows),
  } as unknown as ConfigStore;
  const graph = {
    listMcpServers: () => Promise.resolve([{ id: JIRA, name: 'jira', status: 'enabled', discoveredTools: [] }]),
    listToolGrantsForAgent: () => Promise.resolve([]),
    listPluginMcpGrantsForPlugins: () => Promise.resolve([]),
    upsertPluginMcpGrant: (pluginId: string, serverId: string) => {
      writes.push(`${pluginId}->${serverId}`);
      return Promise.resolve();
    },
  } as unknown as AgentGraphStore;
  const catalog = {
    get: (id: string) =>
      id === ODOO
        ? { plugin: { id: ODOO, name: 'Odoo', kind: 'integration' }, manifest: { capabilities: [{ side_effects: 'read' }] } }
        : undefined,
    list: () => [{ plugin: { id: ODOO, name: 'Odoo', kind: 'integration' }, manifest: {} }],
  } as unknown as PluginCatalog;
  const installed = { list: () => [{ id: ODOO, status: 'active' }] } as unknown as InstalledRegistry;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: { sub: string } }).session = { sub: 'user-1' };
    next();
  });
  app.use(
    '/builder',
    createAgentBuilderRouter({
      getConfigStore: () => config,
      getGraphStore: () => graph,
      getRegistry: () => ({ reload: () => Promise.resolve() }) as unknown as OrchestratorRegistry,
      listMcpPluginCandidates: () => [{ id: ODOO, name: 'Odoo', mcp: true }],
      getReachPluginSources: () => ({ catalog, installed }),
      recordAudit: (entry) => {
        audits.push(entry);
        return Promise.resolve();
      },
    }),
  );
  const server: Server = await listenLoopback(app);
  return {
    base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/builder`,
    audits,
    writes,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function put(h: Harness, body: Record<string, unknown>) {
  const res = await fetch(`${h.base}/plugin-mcp-grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('#2054 — a plugin MCP grant is checked for every agent holding the plugin', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('409 when it makes a holder reach every connected system; confirmed: written and audited', async () => {
    h = await harness(['a-sales']);
    const refused = await put(h, { pluginId: ODOO, mcpServerId: JIRA });
    assert.equal(refused.status, 409);
    assert.equal(refused.json['error'], 'broad_reach_confirmation_required');
    assert.deepEqual(refused.json['slugs'], ['sales']);
    assert.deepEqual(h.writes, [], 'nothing written');

    const ok = await put(h, { pluginId: ODOO, mcpServerId: JIRA, confirmBroadReach: true });
    assert.equal(ok.status, 200);
    assert.deepEqual(h.writes, [`${ODOO}->${JIRA}`]);
    assert.deepEqual(h.audits.map((a) => [a.action, a.target]), [['agent.broad_reach_grant', 'agent:a-sales']]);
  });

  it('no agent holds the plugin: nothing to confirm', async () => {
    h = await harness([]);
    const ok = await put(h, { pluginId: ODOO, mcpServerId: JIRA });
    assert.equal(ok.status, 200);
    assert.equal(h.audits.length, 0);
  });
});
