/**
 * #2050 — save-time refusals of the Agent Builder for internal helpers (DB
 * sub-agents). Each refusal answers 409 with `error: 'helper_refused'` and a
 * stable `code`, and writes nothing:
 *
 *   - `helper_name_collision`: the helper's `ask_<name>` is taken by another
 *     helper of the agent (`A B` vs `A-B`) or by one of the agent's own tools;
 *   - `helper_model_not_allowed`: the agent's model policy does not allow it;
 *   - `helper_grant_not_held_by_agent` (spec §6.11): a native or MCP grant the
 *     agent does not hold itself.
 */

import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';

import express from 'express';

import {
  clearExternalModels,
  registerExternalModels,
  type ModelInfo,
} from '@omadia/llm-provider';
import type {
  AgentGraphStore,
  ConfigStore,
  OrchestratorRegistry,
  SubAgentRow,
  ToolGrantRow,
} from '@omadia/orchestrator';

import { createAgentBuilderRouter } from '../src/routes/agentBuilder.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

const model = (id: string, cls: ModelInfo['class']): ModelInfo => ({
  id: `anthropic:${id}`,
  provider: 'anthropic',
  modelId: id,
  label: id,
  class: cls,
  maxTokens: 8192,
  contextWindow: 200000,
  vision: false,
  classDefault: true,
});
const HAIKU = model('claude-haiku-test', 'fast');
const SONNET = model('claude-sonnet-test', 'balanced');
const OPUS = model('claude-opus-test', 'frontier');

const SERVER_ID = '22222222-2222-4222-8222-222222222222';

const AGENT = {
  id: 'id-mira',
  slug: 'mira',
  name: 'Mira',
  description: null,
  privacyProfile: 'default',
  status: 'enabled',
  archetype: 'standard',
  modelPolicy: { primary: { provider: 'anthropic', model: SONNET.modelId }, fallback: 'none' },
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

function helper(id: string, name: string, parentAgentId = AGENT.id): SubAgentRow {
  return {
    id,
    parentAgentId,
    name,
    skillId: null,
    model: null,
    maxTokens: null,
    maxIterations: null,
    systemPromptOverride: null,
    status: 'enabled',
    position: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

interface State {
  helpers: SubAgentRow[];
  grants: ToolGrantRow[];
  writes: string[];
  natives: string[];
  domainTools: { name: string; internalHelper?: unknown }[];
}
const state: State = { helpers: [], grants: [], writes: [], natives: [], domainTools: [] };

const config = {
  getAgentBySlug: (slug: string) => Promise.resolve(slug === AGENT.slug ? AGENT : undefined),
  listChannelBindingsForAgent: () => Promise.resolve([]),
} as unknown as ConfigStore;

const graph = {
  listAllSubAgents: () => Promise.resolve(state.helpers),
  listAllToolGrants: () => Promise.resolve(state.grants),
  listMcpServers: () => Promise.resolve([{ id: SERVER_ID, name: 'crm' }]),
  listSkills: () => Promise.resolve([]),
  listSchedulesForAgent: () => Promise.resolve([]),
  listPersonaSkills: () => Promise.resolve([]),
  getMcpToolVerdict: () => Promise.resolve({ severity: 'no_signals', contentHash: 'h' }),
  getMcpToolVerdictAck: () => Promise.resolve(undefined),
  createSubAgent: (input: { name: string }) => {
    state.writes.push(`createSubAgent:${input.name}`);
    return Promise.resolve(helper('new', input.name));
  },
  updateSubAgent: (id: string) => {
    state.writes.push(`updateSubAgent:${id}`);
    return Promise.resolve(state.helpers.find((h) => h.id === id)!);
  },
  createToolGrant: (input: { toolRef: string }) => {
    state.writes.push(`createToolGrant:${input.toolRef}`);
    return Promise.resolve({ id: 'grant-new' });
  },
} as unknown as AgentGraphStore;

const registry = {
  reload: () => Promise.resolve({ actions: [], platformChanged: false }),
  list: () => [],
  get: (slug: string) =>
    slug === AGENT.slug
      ? {
          built: {
            orchestrator: {
              listDomainTools: () => state.domainTools,
              listNativeToolNames: () => state.natives,
              holdsNativeTool: (name: string) => state.natives.includes(name),
            },
          },
        }
      : undefined,
} as unknown as OrchestratorRegistry;

let server: Server;
let base = '';

before(async () => {
  clearExternalModels();
  registerExternalModels([HAIKU, SONNET, OPUS]);
  const app = express();
  app.use(express.json());
  app.use(
    '/builder',
    createAgentBuilderRouter({
      getConfigStore: () => config,
      getGraphStore: () => graph,
      getRegistry: () => registry,
      getActiveProvider: () => 'anthropic',
    }),
  );
  server = await listenLoopback(app);
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

after(async () => {
  clearExternalModels();
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  state.helpers = [helper('h-ab', 'A B'), helper('h-other', 'Elsewhere', 'id-other')];
  state.grants = [];
  state.writes = [];
  state.natives = ['ask_user_choice', 'web_search'];
  state.domainTools = [{ name: 'ask_crm' }, { name: 'ask_a_b', internalHelper: { helperId: 'h-ab' } }];
});

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/builder${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}

function assertRefused(res: { status: number; json: Record<string, unknown> }, code: string): void {
  assert.equal(res.status, 409, JSON.stringify(res.json));
  assert.equal(res.json['error'], 'helper_refused');
  assert.equal(res.json['code'], code);
  assert.deepEqual(state.writes, [], 'a refused write changes nothing');
}

describe('#2050 — helper names are collision-free at save time', () => {
  it('refuses a helper whose tool name another helper of the agent already has (A B vs A-B)', async () => {
    const res = await call('POST', '/agents/mira/subagents', { name: 'A-B' });
    assertRefused(res, 'helper_name_collision');
    assert.match(String(res.json['message']), /ask_a_b/);
  });

  it("refuses a helper name that maps to one of the agent's own tools", async () => {
    assertRefused(await call('POST', '/agents/mira/subagents', { name: 'User Choice' }), 'helper_name_collision');
    assertRefused(await call('POST', '/agents/mira/subagents', { name: 'crm' }), 'helper_name_collision');
  });

  it('refuses a rename onto a sibling, allows renaming a helper onto its own tool name', async () => {
    state.helpers.push(helper('h-c', 'C'));
    assertRefused(await call('PATCH', '/agents/mira/subagents/h-c', { name: 'a-b' }), 'helper_name_collision');
    const same = await call('PATCH', '/agents/mira/subagents/h-ab', { name: 'a_b' });
    assert.equal(same.status, 200, JSON.stringify(same.json));
  });

  it('a helper of another agent does not block the name, and cannot be patched through this agent', async () => {
    const created = await call('POST', '/agents/mira/subagents', { name: 'Elsewhere' });
    assert.equal(created.status, 200, JSON.stringify(created.json));
    state.writes = [];
    const foreign = await call('PATCH', '/agents/mira/subagents/h-other', { name: 'x' });
    assert.equal(foreign.status, 404);
    assert.deepEqual(state.writes, []);
  });
});

describe('#2050 — the helper model must fit the agent model policy at save time', () => {
  it('refuses a model stronger than the agent pinned model, accepts a cheaper one', async () => {
    assertRefused(
      await call('POST', '/agents/mira/subagents', { name: 'Fast one', model: OPUS.id }),
      'helper_model_not_allowed',
    );
    assertRefused(
      await call('PATCH', '/agents/mira/subagents/h-ab', { model: OPUS.id }),
      'helper_model_not_allowed',
    );
    const ok = await call('POST', '/agents/mira/subagents', { name: 'Fast one', model: HAIKU.id });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
  });
});

describe('#2050 — fail loud: the graph shows each helper the runtime puts out of service', () => {
  it('names the code and the reason on the helper node; a fitting helper has none', async () => {
    state.helpers = [
      { ...helper('h-strong', 'Strong'), model: OPUS.id },
      { ...helper('h-fit', 'Fit'), model: HAIKU.id },
    ];
    // The graph maps full MCP server rows; this fixture's server is a stub.
    const g = graph as unknown as { listMcpServers: () => Promise<unknown[]> };
    const listServers = g.listMcpServers;
    g.listMcpServers = () => Promise.resolve([]);
    const res = await call('GET', '/agents/mira/graph').finally(() => {
      g.listMcpServers = listServers;
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const nodes = (res.json as { subAgents: { id: string; outOfService: { code: string; reason: string } | null }[] })
      .subAgents;
    const strong = nodes.find((n) => n.id === 'h-strong');
    assert.equal(strong?.outOfService?.code, 'helper_model_not_allowed');
    assert.match(strong?.outOfService?.reason ?? '', /stronger than the agent's own balanced model/);
    assert.equal(nodes.find((n) => n.id === 'h-fit')?.outOfService, null);
  });
});

describe('#2050 §6.11 — a helper grant the agent lacks is refused at save time', () => {
  const edge = (config: Record<string, unknown>) =>
    call('POST', '/agents/mira/graph/edges', {
      kind: 'tool_grant',
      source: 'subagent:h-ab',
      target: `tool:${String(config['toolRef'])}`,
      config,
    });

  it('MCP: refused without an agent-level grant, accepted with one', async () => {
    assertRefused(
      await edge({ toolKind: 'mcp', toolRef: 'search', mcpServerId: SERVER_ID }),
      'helper_grant_not_held_by_agent',
    );
    state.grants = [
      {
        id: 'g-agent',
        agentId: AGENT.id,
        subAgentId: null,
        toolKind: 'mcp',
        toolRef: 'search',
        mcpServerId: SERVER_ID,
        config: {},
        createdAt: new Date(0),
      },
    ];
    const ok = await edge({ toolKind: 'mcp', toolRef: 'crm:search', mcpServerId: SERVER_ID });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.deepEqual(state.writes, ['createToolGrant:search']);
  });

  it('native: refused when the agent does not hold the tool, accepted when it does', async () => {
    assertRefused(await edge({ toolKind: 'native', toolRef: 'crm_write' }), 'helper_grant_not_held_by_agent');
    const ok = await edge({ toolKind: 'native', toolRef: 'web_search' });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
  });

  it('a helper of another agent cannot be granted through this agent', async () => {
    const res = await call('POST', '/agents/mira/graph/edges', {
      kind: 'tool_grant',
      source: 'subagent:h-other',
      target: 'tool:web_search',
      config: { toolKind: 'native', toolRef: 'web_search' },
    });
    assert.equal(res.status, 409);
    assert.deepEqual(state.writes, []);
  });
});
