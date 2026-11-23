/**
 * Spec 2042 §6 criterion 40 — availability at the HTTP surface: agent A is
 * available to Anna in Teams only. Ben's agent directory (what the web-ui
 * picker lists, `GET /api/v1/agents/directory`) does not list A, Anna's
 * Teams directory does; a default-agent entry naming A for Ben is refused at
 * save time (`PUT /api/v1/operator/default-agents`).
 */

import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import type { ConfigStore, OrchestratorRegistry } from '@omadia/orchestrator';

import { SnapshotRoutingView } from '../packages/harness-orchestrator/src/registry/routingView.js';
import type { AgentRow, ConfigSnapshot } from '../packages/harness-orchestrator/src/registry/configStore.js';
import {
  createAgentDirectoryRouter,
  createOperatorDefaultAgentsRouter,
} from '../src/routes/managementLayer.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

const NOW = new Date('2026-11-20T00:00:00Z');
const ANNA = 'anna@example.com';
const BEN = 'ben@example.com';

function agentRow(slug: string, overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id: `id-${slug}`,
    slug,
    name: slug,
    description: null,
    privacyProfile: 'default',
    status: 'enabled',
    identityName: slug.toUpperCase(),
    availableToEveryone: true,
    availableChannels: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const A = agentRow('a', { availableToEveryone: false, availableChannels: ['teams'] });
const OTHER = agentRow('other');
const SNAPSHOT: ConfigSnapshot = {
  agents: [A, OTHER],
  agentPlugins: [],
  channelBindings: [],
  availabilityPrincipals: [{ agentId: A.id, principal: `user:${ANNA}` }],
  defaultEntries: [],
};

interface Harness {
  readonly base: string;
  readonly upserts: Array<{ principal: string | null; channelType: string | null; agentId: string | null }>;
  close(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const upserts: Harness['upserts'] = [];
  const view = new SnapshotRoutingView(SNAPSHOT);
  const rows = new Map(SNAPSHOT.agents.map((row) => [row.slug, row]));
  const store = {
    getAgentBySlug: (slug: string) => Promise.resolve(rows.get(slug)),
    listAgentPlugins: () => Promise.resolve([]),
    routing: {
      listDefaultEntries: () => Promise.resolve([]),
      upsertDefaultEntry: (input: Harness['upserts'][number]) => {
        upserts.push(input);
        return Promise.resolve({ id: 'e1', ...input, updatedAt: NOW, updatedBy: null });
      },
    },
  } as unknown as ConfigStore;
  const registry = {
    reload: () => Promise.resolve(),
    routingView: () => view,
    // No built runtime: the directory reads rows only for avatars/descriptions.
    getById: () => undefined,
  } as unknown as OrchestratorRegistry;
  const options = { getConfigStore: () => store, getRegistry: () => registry };

  const app = express();
  app.use(express.json());
  // The signed-in user, as the session middleware would set it.
  app.use((req, _res, next) => {
    const email = req.header('x-test-user');
    if (email) (req as unknown as { session: { email: string } }).session = { email };
    next();
  });
  app.use('/api/v1/agents', createAgentDirectoryRouter(options));
  app.use('/api/v1/operator/default-agents', createOperatorDefaultAgentsRouter(options));
  const server: Server = await listenLoopback(app);
  return {
    base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/v1`,
    upserts,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('criterion 40 — directory and default-agent table honour availability', () => {
  let h: Harness;
  before(async () => {
    h = await harness();
  });
  after(async () => {
    await h.close();
  });

  async function directory(user: string, channel: string): Promise<string[]> {
    const res = await fetch(`${h.base}/agents/directory?channel=${channel}`, { headers: { 'x-test-user': user } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { agents: Array<{ slug: string }> };
    return body.agents.map((a) => a.slug);
  }

  async function putEntry(body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${h.base}/operator/default-agents`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  it("criterion 40: Ben's directory (picker) does not list A, in Teams or anywhere else", async () => {
    assert.deepEqual(await directory(BEN, 'teams'), ['other']);
    assert.deepEqual(await directory(BEN, 'web'), ['other']);
  });

  it("criterion 40: Anna's Teams directory lists A, her Slack directory does not", async () => {
    assert.deepEqual(await directory(ANNA, 'teams'), ['a', 'other']);
    assert.deepEqual(await directory(ANNA, 'slack'), ['other']);
  });

  it('criterion 40: a default-agent entry naming A for Ben is refused at save time, nothing written', async () => {
    const forBenInTeams = await putEntry({ principal: `user:${BEN}`, channel_type: 'teams', agent_slug: 'a' });
    assert.equal(forBenInTeams.status, 409, JSON.stringify(forBenInTeams.json));
    assert.equal(forBenInTeams.json['error'], 'agent_not_available_to_user');
    assert.equal(forBenInTeams.json['slug'], 'a');

    const forBenEverywhere = await putEntry({ principal: `user:${BEN}`, channel_type: null, agent_slug: 'a' });
    assert.equal(forBenEverywhere.status, 409);
    assert.equal(forBenEverywhere.json['error'], 'agent_not_available_in_every_channel');

    const forAnnaInSlack = await putEntry({ principal: `user:${ANNA}`, channel_type: 'slack', agent_slug: 'a' });
    assert.equal(forAnnaInSlack.status, 409);
    assert.equal(forAnnaInSlack.json['error'], 'agent_not_available_in_channel');

    assert.deepEqual(h.upserts, [], 'no refused entry was written');
  });

  it('criterion 40: the entry naming A for Anna in Teams is saved', async () => {
    const ok = await putEntry({ principal: `user:${ANNA}`, channel_type: 'teams', agent_slug: 'a' });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.deepEqual(h.upserts.at(-1), { principal: `user:${ANNA}`, channelType: 'teams', agentId: A.id, updatedBy: null });
  });
});
