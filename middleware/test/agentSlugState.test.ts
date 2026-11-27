/**
 * #1881 (ADR-0218) — deleting an agent must not hand its slug-keyed state to
 * the next agent with the same slug.
 *
 * A delete moves the memory trees `/memories/orchestrators/<slug>` and
 * `/memories/contexts/<slug>` under the tombstone's placeholder slug, where
 * the Danger-Zone purge (ADR-0120, axis `agent`) still reaches them, and it
 * removes the slug's public MCP key bindings. The graph's scopes cannot be
 * moved, so a create refuses a slug while graph history, curated memory, a
 * memory tree or a binding is still keyed by it.
 */

import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

import express from 'express';

import { InMemoryMemoryStore } from '@omadia/memory';
import type { MemoryStore } from '@omadia/plugin-api';
import { tombstoneSlug, type AgentTombstone, type ConfigStore, type OrchestratorRegistry } from '@omadia/orchestrator';

import type { AuditEntryInput } from '../src/auth/adminAuditLog.js';
import {
  createInMemoryPublicMcpKeyBindingAdminStore,
  type PublicMcpKeyBindingAdminStore,
} from '../src/mcp/publicMcpKeyBindingsAdmin.js';
import { createAgentSlugState, hasRemainingSlugState } from '../src/platform/agentSlugState.js';
import { createOperatorAgentsRouter } from '../src/routes/operatorAgents.js';
import { purgeMemory, resolvePurgeTargets } from '../src/services/memoryPurge.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

const AGENT_ID = '0b9f3c1e-5d2a-4c7b-9e8f-1a2b3c4d5e6f';
const SLUG = 'slug-reuse';
const NOTE = `/memories/orchestrators/${SLUG}/observations/codewoerter.md`;
const CONTEXT_NOTE = `/memories/contexts/${SLUG}/team/teams~abc/notes.md`;

function binding(keyId: string, agentId: string) {
  return { keyId, agentId, readTools: ['query_odoo'], writeTools: [], enabled: true };
}

/** A graph that answers counts per slug, or fails. */
function fakeGraph(counts: { history?: Record<string, number>; mk?: Record<string, number>; fails?: boolean }) {
  return {
    countMemorableKnowledge: (filter: { originAgent?: string }) =>
      counts.fails
        ? Promise.reject(new Error('graph down'))
        : Promise.resolve({ count: counts.mk?.[filter.originAgent ?? ''] ?? 0 }),
    countConversationHistory: (filter: { agentSlug?: string }) =>
      counts.fails
        ? Promise.reject(new Error('graph down'))
        : Promise.resolve({ count: counts.history?.[filter.agentSlug ?? ''] ?? 0 }),
  };
}

async function seed(memory: MemoryStore, bindings: PublicMcpKeyBindingAdminStore): Promise<void> {
  await memory.createFile(NOTE, 'Das Codewort ist Bernstein.');
  await memory.createFile(CONTEXT_NOTE, 'team note');
  await bindings.upsert(binding('key-1', SLUG));
  await bindings.upsert(binding('key-other', 'sales'));
}

describe('agent slug state: retire and remaining', () => {
  let memory: InMemoryMemoryStore;
  let bindings: PublicMcpKeyBindingAdminStore;

  beforeEach(async () => {
    memory = new InMemoryMemoryStore();
    bindings = createInMemoryPublicMcpKeyBindingAdminStore();
    await seed(memory, bindings);
  });

  it('moves both memory trees under the tombstone slug and removes only the slug\'s bindings', async () => {
    const state = createAgentSlugState({ memoryStore: () => memory, mcpBindings: () => bindings, tenantId: 'default' });
    const tomb = tombstoneSlug(AGENT_ID);

    const report = await state.retire(SLUG, tomb);

    assert.deepEqual(report.failures, []);
    assert.deepEqual(report.memoryMoved, [
      `/memories/orchestrators/${SLUG} -> /memories/orchestrators/${tomb}`,
      `/memories/contexts/${SLUG} -> /memories/contexts/${tomb}`,
    ]);
    assert.deepEqual(report.mcpBindingsRemoved, ['key-1']);
    assert.equal(await memory.fileExists(NOTE), false);
    assert.equal(
      await memory.readFile(`/memories/orchestrators/${tomb}/observations/codewoerter.md`),
      'Das Codewort ist Bernstein.',
    );
    assert.deepEqual((await bindings.list()).map((b) => b.keyId), ['key-other']);

    const remaining = await state.remaining(SLUG);
    assert.equal(hasRemainingSlugState(remaining), false);
  });

  it('keeps the moved memory purgeable through the Danger-Zone purge of the tombstone slug (ADR-0120)', async () => {
    const state = createAgentSlugState({ memoryStore: () => memory, tenantId: 'default' });
    const tomb = tombstoneSlug(AGENT_ID);
    await state.retire(SLUG, tomb);

    assert.deepEqual(await resolvePurgeTargets(memory, 'agent', tomb), [
      `/memories/orchestrators/${tomb}`,
      `/memories/contexts/${tomb}`,
    ]);
    assert.equal(await purgeMemory(memory, 'agent', tomb), 2);
    assert.equal(await memory.directoryExists(`/memories/orchestrators/${tomb}`), false);
    assert.equal(await memory.directoryExists(`/memories/contexts/${tomb}`), false);
  });

  it('moves through the labelling wrapper, named with the tombstone slug', async () => {
    const wrappedFor: string[] = [];
    const state = createAgentSlugState({
      memoryStore: () => memory,
      labelMoves: (store, agentSlug) => {
        wrappedFor.push(agentSlug);
        return store;
      },
      tenantId: 'default',
    });
    await state.retire(SLUG, 'deleted-abc');
    assert.deepEqual(wrappedFor, ['deleted-abc']);
  });

  it('reports a move that fails instead of throwing, and the slug then still counts as taken', async () => {
    const failing: MemoryStore = Object.assign(Object.create(memory) as MemoryStore, {
      rename: () => Promise.reject(new Error('disk full')),
    });
    const logs: string[] = [];
    const state = createAgentSlugState({ memoryStore: () => failing, tenantId: 'default', log: (m) => logs.push(m) });

    const report = await state.retire(SLUG, 'deleted-abc');

    assert.equal(report.memoryMoved.length, 0);
    assert.deepEqual(report.failures.map((f) => f.part), ['memory', 'memory']);
    assert.match(logs.join('\n'), /disk full/);
    const remaining = await state.remaining(SLUG);
    assert.deepEqual(remaining.memoryTrees, [`/memories/orchestrators/${SLUG}`, `/memories/contexts/${SLUG}`]);
    assert.equal(hasRemainingSlugState(remaining), true);
  });

  it('counts graph history and curated memory of the slug, which a delete cannot move', async () => {
    const state = createAgentSlugState({
      knowledgeGraph: () => fakeGraph({ history: { [SLUG]: 7 }, mk: { [SLUG]: 1 } }),
      tenantId: 'default',
    });
    const remaining = await state.remaining(SLUG);
    assert.equal(remaining.graphHistory, 7);
    assert.equal(remaining.memorableKnowledge, 1);
    assert.equal(hasRemainingSlugState(remaining), true);
    assert.equal(hasRemainingSlugState(await state.remaining('fresh')), false);
  });
});

describe('agent slug state: delete, then create with the same slug', () => {
  let server: Server;
  let base = '';
  let agents: Array<{ id: string; slug: string; name: string; status: string; archetype: string }> = [];
  let tombstones: AgentTombstone[] = [];
  let audits: AuditEntryInput[] = [];
  let memory: InMemoryMemoryStore;
  let bindings: PublicMcpKeyBindingAdminStore;
  let graph: ReturnType<typeof fakeGraph>;

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  };

  before(async () => {
    const store = {
      getAgentBySlug: (slug: string) => Promise.resolve(agents.find((a) => a.slug === slug)),
      createAgent: (input: { slug: string; name: string }) => {
        const row = {
          id: agents.length === 0 && tombstones.length === 0 ? AGENT_ID : `id-${String(tombstones.length + agents.length)}`,
          slug: input.slug,
          name: input.name,
          status: 'enabled',
          archetype: 'standard',
          contextMemory: 'off',
        };
        agents = [...agents, row];
        return Promise.resolve(row);
      },
      updateAgent: () => Promise.resolve(),
      deleteAgent: (id: string) => {
        const agent = agents.find((a) => a.id === id);
        if (!agent) return Promise.resolve(undefined);
        agents = agents.filter((a) => a.id !== id);
        const tombstone: AgentTombstone = {
          id,
          slug: agent.slug,
          name: agent.name,
          archetype: agent.archetype,
          deletedAt: new Date().toISOString(),
          deletedBy: null,
        };
        tombstones = [...tombstones, tombstone];
        return Promise.resolve(tombstone);
      },
      listTombstones: () => Promise.resolve(tombstones),
    } as unknown as ConfigStore;
    const registry = { reload: () => Promise.resolve({ actions: [] }), get: () => undefined } as unknown as OrchestratorRegistry;
    const app = express();
    app.use(express.json());
    app.use(
      '/agents',
      createOperatorAgentsRouter({
        getConfigStore: () => store,
        getRegistry: () => registry,
        getChatSessionStore: () => undefined,
        slugState: createAgentSlugState({
          memoryStore: () => memory,
          mcpBindings: () => bindings,
          knowledgeGraph: () => graph,
          tenantId: 'default',
        }),
        recordAudit: (entry: AuditEntryInput) => {
          audits = [...audits, entry];
          return Promise.resolve();
        },
      }),
    );
    server = await listenLoopback(app);
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  after(() => {
    server.close();
  });

  beforeEach(async () => {
    agents = [];
    tombstones = [];
    audits = [];
    memory = new InMemoryMemoryStore();
    bindings = createInMemoryPublicMcpKeyBindingAdminStore();
    graph = fakeGraph({});
    const created = await call('POST', '/agents', { slug: SLUG, name: 'Slug Reuse' });
    assert.equal(created.status, 201);
    await seed(memory, bindings);
  });

  it('a re-created agent starts without the memory and the MCP key bindings of the deleted one', async () => {
    const deleted = await call('DELETE', `/agents/${SLUG}`);
    assert.equal(deleted.status, 200);
    const tomb = tombstoneSlug(AGENT_ID);
    assert.deepEqual(deleted.json['slug_state'], {
      moved_to_slug: tomb,
      memory_moved: [
        `/memories/orchestrators/${SLUG} -> /memories/orchestrators/${tomb}`,
        `/memories/contexts/${SLUG} -> /memories/contexts/${tomb}`,
      ],
      mcp_bindings_removed: ['key-1'],
      failures: [],
    });
    const audit = audits.find((a) => a.action === 'agent.slug_state_moved');
    assert.equal(audit?.target, `agent:${AGENT_ID}`);
    assert.deepEqual(audit?.after, deleted.json['slug_state'], 'the audit records what moved');

    const recreated = await call('POST', '/agents', { slug: SLUG, name: 'Slug Reuse 2' });
    assert.equal(recreated.status, 201);
    assert.notEqual(recreated.json['id'], AGENT_ID);
    assert.equal(await memory.directoryExists(`/memories/orchestrators/${SLUG}`), false);
    assert.equal(await memory.directoryExists(`/memories/contexts/${SLUG}`), false);
    assert.deepEqual((await bindings.list()).filter((b) => b.agentId === SLUG), []);
  });

  it('refuses the slug while graph history of the deleted agent remains, naming the purge', async () => {
    await call('DELETE', `/agents/${SLUG}`);
    graph = fakeGraph({ history: { [SLUG]: 12 }, mk: { [SLUG]: 2 } });

    const recreated = await call('POST', '/agents', { slug: SLUG, name: 'Slug Reuse 2' });

    assert.equal(recreated.status, 409);
    assert.equal(recreated.json['error'], 'slug_state_remains');
    assert.match(String(recreated.json['message']), /axis "agent", selector "slug-reuse"/);
    assert.deepEqual(recreated.json['remaining'], {
      memory_trees: [],
      mcp_bindings: [],
      graph_history: 12,
      memorable_knowledge: 2,
    });
    assert.equal(agents.length, 0, 'no agent was created');

    // After the purge (graph empty again) the slug is free.
    graph = fakeGraph({});
    assert.equal((await call('POST', '/agents', { slug: SLUG, name: 'Slug Reuse 2' })).status, 201);
  });

  it('refuses a slug whose state was left by a delete from before this change', async () => {
    // Seeded memory and binding of a slug no agent has.
    const fresh = 'legacy-slug';
    await memory.createFile(`/memories/orchestrators/${fresh}/x.md`, 'old');
    await bindings.upsert(binding('key-legacy', fresh));

    const created = await call('POST', '/agents', { slug: fresh, name: 'Legacy' });

    assert.equal(created.status, 409);
    assert.deepEqual(created.json['remaining'], {
      memory_trees: [`/memories/orchestrators/${fresh}`],
      mcp_bindings: ['key-legacy'],
      graph_history: 0,
      memorable_knowledge: 0,
    });
  });

  it('refuses with 503 when the remaining state cannot be checked', async () => {
    await call('DELETE', `/agents/${SLUG}`);
    graph = fakeGraph({ fails: true });
    const recreated = await call('POST', '/agents', { slug: SLUG, name: 'Slug Reuse 2' });
    assert.equal(recreated.status, 503);
    assert.equal(recreated.json['error'], 'slug_state_unverifiable');
  });
});
