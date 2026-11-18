/**
 * Route harness for the facilitator suites: the operator agents, channels
 * and builder routers over fakes that record every mutating call.
 *
 * Originally part of: #2060 — write-time refusals for facilitator-kind agents (spec 2043 §2.3).
 *
 * Every omission an operator could try to configure is refused by the route
 * that would write it, with a stable `error`/`omission` pair and a message
 * that says why, and WITHOUT a write. The fakes record every mutating call,
 * so "refused" also means "nothing changed".
 */

import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach } from 'node:test';

import express from 'express';

import type { AgentGraphStore, ConfigStore, OrchestratorRegistry } from '@omadia/orchestrator';

import { createAgentBuilderRouter } from '../../src/routes/agentBuilder.js';
import { createOperatorAgentsRouter } from '../../src/routes/operatorAgents.js';
import { createOperatorChannelsRouter } from '../../src/routes/operatorChannels.js';
import { listenLoopback } from './listenLoopback.js';

export const ENGINE = '@omadia/agent-facilitator';
export const ODOO = '@omadia/integration-odoo';
export const SKILL_ID = '11111111-1111-4111-8111-111111111111';
export const SERVER_ID = '22222222-2222-4222-8222-222222222222';

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

export interface RouteResponse {
  status: number;
  json: Record<string, unknown>;
}

export interface RoutesHarness {
  /** Every mutating store / graph call, in order. */
  writes: string[];
  agents: FakeAgent[];
  installed: { id: string; status: string }[];
  /** What the engine plugin reports about itself. */
  engineState: unknown;
  /** Has the operator granted the engine its SQL ledger? */
  sqlGranted: boolean;
  identitySaves: number;
  call(method: string, path: string, body?: unknown): Promise<RouteResponse>;
  assertRefused(res: RouteResponse, omission: string, messagePattern: RegExp): void;
}

/** Register the harness hooks inside a `describe`. State resets per test:
 *  a facilitator `mara`, a standard agent `hr`, the engine and one business
 *  plugin the engine granted SQL. */
export function routesHarness(): RoutesHarness {
  const h = {} as RoutesHarness;

  let server: Server;
  let base: string;

  const provides: Record<string, string[]> = {
    [ENGINE]: ['facilitationEngine@1'],
    '@acme/second-engine': ['facilitationEngine@1'],
    [ODOO]: [],
  };

  /** Read methods answer; every mutating method is recorded. An unexpected
   *  call fails loudly so a refusal test cannot pass by accident. */
  function store(): ConfigStore {
    const reads: Record<string, (...args: never[]) => unknown> = {
      getAgentBySlug: (slug: string) => Promise.resolve(h.agents.find((a) => a.slug === slug)),
      listAgents: () => Promise.resolve(h.agents),
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
        h.agents.push(created);
        return Promise.resolve(created);
      },
    };
    return new Proxy(
      {},
      {
        get: (_t, prop: string) =>
          reads[prop] ??
          ((...args: unknown[]) => {
            h.writes.push(`${prop}(${JSON.stringify(args).slice(0, 80)})`);
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
            h.writes.push(`graph.${prop}(${JSON.stringify(args).slice(0, 60)})`);
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
        getFacilitationEngineState: () => h.engineState,
        isSqlGranted: () => h.sqlGranted,
        getInstalledRegistry: () => ({ list: () => h.installed }) as never,
        getPluginCatalog: () =>
          ({ get: (id: string) => (id in provides ? { plugin: { provides: provides[id] } } : undefined) }) as never,
        getAgentIdentity: () => ({
          store: {
            getByAgentId: () => Promise.resolve(undefined),
            save: () => {
              h.identitySaves += 1;
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
    h.writes = [];
    h.identitySaves = 0;
    h.sqlGranted = true;
    h.agents = [agent('mara', 'facilitator'), agent('hr', 'standard')];
    h.installed = [
      { id: ENGINE, status: 'active' },
      { id: ODOO, status: 'active' },
    ];
  });

  h.call = async function call(
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
  };

  h.assertRefused = function assertRefused(
    res: { status: number; json: Record<string, unknown> },
    omission: string,
    messagePattern: RegExp,
  ): void {
    assert.equal(res.status, 409, JSON.stringify(res.json));
    assert.equal(res.json['error'], 'facilitator_omission');
    assert.equal(res.json['omission'], omission);
    assert.match(String(res.json['message']), messagePattern);
    assert.deepEqual(h.writes, [], 'a refusal writes nothing');
  }
  return h;
}
