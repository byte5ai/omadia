/**
 * Per-orchestrator isolation of curated MemorableKnowledge (in-memory KG).
 *
 * Owner-gated MK is additionally constrained to the producing Agent
 * (`origin_agent`): Agent A does not recall Agent B's MK even for the same
 * owning user. team/public-promoted MK still crosses Agents (the existing ACL
 * sharing model is preserved). Legacy MK without an `origin_agent` stays
 * visible to the owner.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';

const USER = 'user-1';

async function mk(
  g: InMemoryKnowledgeGraph,
  summary: string,
  originAgent: string | undefined,
): Promise<string> {
  const res = await g.createMemorableKnowledge({
    kind: 'insight',
    summary,
    createdBy: `auto:${USER}`,
    aclOwners: [USER],
    ...(originAgent ? { originAgent } : {}),
  });
  // Seed an identical embedding so cosine = 1 for the query below.
  g.setEmbedding(res.memorableKnowledgeNodeId, [1, 0, 0]);
  return res.memorableKnowledgeNodeId;
}

test('owner-gated recall is constrained to the viewing Agent\'s origin_agent', async () => {
  const g = new InMemoryKnowledgeGraph();
  await mk(g, 'A insight', 'agent-a');
  await mk(g, 'B insight', 'agent-b');
  await mk(g, 'legacy insight', undefined); // no origin_agent

  const seenBy = async (slug: string): Promise<string[]> => {
    const hits = await g.searchMemorableKnowledgeByEmbedding({
      queryEmbedding: [1, 0, 0],
      viewerOmadiaUserId: USER,
      viewerAgentSlug: slug,
      teamVisibility: false,
    });
    return hits.map((h) => String(h.mk.props['summary'])).sort();
  };

  // Agent A sees its own MK + the legacy (origin-less) one — never Agent B's.
  assert.deepEqual(await seenBy('agent-a'), ['A insight', 'legacy insight']);
  assert.deepEqual(await seenBy('agent-b'), ['B insight', 'legacy insight']);
});

test('team/public visibility bypasses origin_agent (sharing preserved)', async () => {
  const g = new InMemoryKnowledgeGraph();
  await mk(g, 'A insight', 'agent-a');
  await mk(g, 'B insight', 'agent-b');

  // With teamVisibility on, default-`team` MK is shared across Agents.
  const hits = await g.searchMemorableKnowledgeByEmbedding({
    queryEmbedding: [1, 0, 0],
    viewerOmadiaUserId: USER,
    viewerAgentSlug: 'agent-a',
    teamVisibility: true,
  });
  assert.deepEqual(
    hits.map((h) => String(h.mk.props['summary'])).sort(),
    ['A insight', 'B insight'],
  );
});

test('no viewerAgentSlug → legacy owner-only behaviour (no agent constraint)', async () => {
  const g = new InMemoryKnowledgeGraph();
  await mk(g, 'A insight', 'agent-a');
  await mk(g, 'B insight', 'agent-b');

  const hits = await g.searchMemorableKnowledgeByEmbedding({
    queryEmbedding: [1, 0, 0],
    viewerOmadiaUserId: USER,
    teamVisibility: false,
  });
  assert.deepEqual(
    hits.map((h) => String(h.mk.props['summary'])).sort(),
    ['A insight', 'B insight'],
  );
});
