/**
 * #575 — a restricted room keeps the curated knowledge it IS entitled to.
 *
 * #742 narrowed turn recall to the room's own conversation and, as a
 * side-effect, dropped curated memory entirely along with the other
 * cross-session legs. That was the safe answer and an unnecessarily blunt one:
 * curated memory is **tiered**. `team` / `public` knowledge is shared by
 * construction, so a restricted room is entitled to it; only rows the recalling
 * user privately owns are not.
 *
 * `sharedOnly` narrows to exactly that tier. It is **not** the opposite of
 * `teamVisibility`, which WIDENS the ACL (owner rows plus shared ones) — the
 * two answer different questions and the difference is the whole point:
 *
 *   teamVisibility  : "may I also see shared rows?"   → owner ∪ shared
 *   sharedOnly      : "what may EVERYONE here see?"   → shared only
 *
 * Asserted against the in-memory graph, which is a real implementation of the
 * same contract the Neon one implements — not a stub written for this test.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';

const VIEWER = 'user-alice';
const OTHER = 'user-bob';

/** Deterministic unit vectors so cosine similarity is exactly 1 for a match. */
const VEC = [1, 0, 0];

async function seed(): Promise<InMemoryKnowledgeGraph> {
  const graph = new InMemoryKnowledgeGraph();
  const rows: Array<{ summary: string; owner: string; visibility?: string }> = [
    { summary: 'private-own', owner: VIEWER, visibility: 'private' },
    { summary: 'team-own', owner: VIEWER, visibility: 'team' },
    { summary: 'public-other', owner: OTHER, visibility: 'public' },
    { summary: 'private-other', owner: OTHER, visibility: 'private' },
  ];
  for (const row of rows) {
    const res = await graph.createMemorableKnowledge({
      kind: 'insight',
      summary: row.summary,
      createdBy: `auto:${row.owner}`,
      aclOwners: [row.owner],
      ...(row.visibility ? { visibility: row.visibility } : {}),
    } as never);
    // Identical embedding so cosine = 1 and ranking never hides a row.
    graph.setEmbedding(res.memorableKnowledgeNodeId, VEC);
  }
  return graph;
}

async function search(
  graph: InMemoryKnowledgeGraph,
  opts: { teamVisibility?: boolean; sharedOnly?: boolean },
): Promise<string[]> {
  const hits = await graph.searchMemorableKnowledgeByEmbedding({
    queryEmbedding: VEC,
    viewerOmadiaUserId: VIEWER,
    limit: 50,
    minSimilarity: 0,
    ...opts,
  });
  return hits.map((h) => String(h.mk.props['summary'])).sort();
}

describe('#575 sharedOnly — the shared tier, and nothing else', () => {
  it('owner-only (the historical default) returns the viewer’s own rows', async () => {
    const graph = await seed();
    const ids = await search(graph, {});
    assert.ok(ids.includes('private-own'), 'the viewer sees their own private row');
    assert.ok(!ids.includes('public-other'), 'and not somebody else’s, without teamVisibility');
  });

  it('teamVisibility WIDENS: own rows plus shared ones', async () => {
    const graph = await seed();
    const ids = await search(graph, { teamVisibility: true });
    assert.ok(ids.includes('private-own'), 'still sees their own private row');
    assert.ok(ids.includes('public-other'), 'and now shared rows too');
  });

  it('sharedOnly NARROWS: the viewer’s private row is dropped', async () => {
    // The property the audience floor needs. A row only this participant may
    // see must not reach a prompt the whole room’s answer is derived from.
    const graph = await seed();
    const ids = await search(graph, { sharedOnly: true });
    assert.ok(!ids.includes('private-own'), 'the viewer’s OWN private row is excluded');
    assert.ok(!ids.includes('private-other'), 'and so is anyone else’s');
    assert.ok(ids.includes('team-own'), 'their shared row survives');
    assert.ok(ids.includes('public-other'), 'as does the tenant’s public knowledge');
  });

  it('sharedOnly implies the shared branch — no teamVisibility needed', async () => {
    // Without the implication this would return only the viewer's own shared
    // rows: a misconfiguration with no legitimate use, so the implementation
    // removes the possibility rather than documenting it.
    const graph = await seed();
    const ids = await search(graph, { sharedOnly: true, teamVisibility: false });
    assert.ok(
      ids.includes('public-other'),
      'another owner’s public row must be reachable without teamVisibility',
    );
  });

  it('sharedOnly wins over teamVisibility when both are set', async () => {
    const graph = await seed();
    const ids = await search(graph, { sharedOnly: true, teamVisibility: true });
    assert.ok(!ids.includes('private-own'), 'widening must not undo the narrowing');
  });
});
