import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { ContextRetriever } from '@omadia/orchestrator-extras';
import type {
  AgentPrioritiesStore,
  AgentPriorityRecord,
  EntryType,
  KnowledgeGraph,
  TurnSearchHit,
} from '@omadia/plugin-api';
import { turnNodeId } from '@omadia/plugin-api';

// ---------------------------------------------------------------------------
// MockGraph — minimal KnowledgeGraph stand-in. The assembler only touches
// `getSession`, `findEntityCapturedTurns`, `searchTurnsByEmbedding`,
// `searchTurns`, `getNeighbors`. Returning scripted shapes lets us assert
// the assembly logic without a real backend.
// ---------------------------------------------------------------------------

interface MockGraphScript {
  tail?: ReadonlyArray<{
    time: string;
    userMessage: string;
    assistantAnswer: string;
  }>;
  ftsHits?: ReadonlyArray<TurnSearchHit>;
}

function makeMockGraph(script: MockGraphScript): KnowledgeGraph {
  const tail = script.tail ?? [];
  const ftsHits = script.ftsHits ?? [];
  const sessionTurns = tail.map((t) => ({
    turn: {
      id: turnNodeId('chat-active', t.time),
      type: 'Turn' as const,
      props: {
        time: t.time,
        userMessage: t.userMessage,
        assistantAnswer: t.assistantAnswer,
      },
    },
    capturedEntities: [],
  }));

  return {
    async ingestTurn() {
      throw new Error('not implemented in mock');
    },
    async getSession(scope: string) {
      if (scope !== 'chat-active' || sessionTurns.length === 0) return null;
      return {
        scope,
        turns: sessionTurns,
        runId: null,
        agentInvocationIds: [],
        toolCallIds: [],
      };
    },
    async findEntityCapturedTurns() {
      return [];
    },
    // Without an embeddingClient on ContextRetriever, the assembler falls
    // through to searchTurns. Both legs return the same scripted hits so
    // tests work either way.
    async searchTurns() {
      return [...ftsHits];
    },
    async searchTurnsByEmbedding() {
      return [...ftsHits];
    },
    async getNeighbors() {
      return [];
    },
    async findEntities() {
      return [];
    },
    async listSessions() {
      return [];
    },
    async getStats() {
      return {
        totalNodes: 0,
        totalEdges: 0,
        byNodeType: {} as Record<string, number>,
        byEdgeType: {} as Record<string, number>,
      };
    },
    async upsertNode() {
      throw new Error('not implemented in mock');
    },
    async upsertEdge() {
      throw new Error('not implemented in mock');
    },
    async getNode() {
      return null;
    },
  } as unknown as KnowledgeGraph;
}

class FakeAgentPriorities implements AgentPrioritiesStore {
  constructor(private readonly records: ReadonlyArray<AgentPriorityRecord>) {}
  async listForAgent(): Promise<readonly AgentPriorityRecord[]> {
    return this.records;
  }
  async upsert(): Promise<void> {}
  async remove(): Promise<void> {}
}

function rec(
  entryExternalId: string,
  action: 'block' | 'boost',
  weight = 1.3,
): AgentPriorityRecord {
  return {
    agentId: 'agent-test',
    entryExternalId,
    action,
    weight,
    reason: null,
    updatedAt: '2026-05-08T10:00:00.000Z',
  };
}

function ftsHit(
  scope: string,
  time: string,
  body: { userMessage: string; assistantAnswer: string },
  rank: number,
  extras: { entryType?: EntryType; manuallyAuthored?: boolean } = {},
): TurnSearchHit {
  return {
    turnId: turnNodeId(scope, time),
    scope,
    time,
    userMessage: body.userMessage,
    assistantAnswer: body.assistantAnswer,
    rank,
    ...(extras.entryType ? { entryType: extras.entryType } : {}),
    ...(extras.manuallyAuthored !== undefined
      ? { manuallyAuthored: extras.manuallyAuthored }
      : {}),
  };
}

describe('ContextRetriever.assembleForBudget', () => {
  it('greedy-fill — top-N hits matching the budget', async () => {
    // 5 hits, all rank 0.9 → 0.5 descending, each ~50 chars.
    const hits: TurnSearchHit[] = [];
    for (let i = 0; i < 5; i++) {
      hits.push(
        ftsHit(
          `s-${String(i)}`,
          `2026-05-0${String(i + 1)}T08:00:00Z`,
          { userMessage: `q-${String(i)}`, assistantAnswer: `a-${String(i)}` },
          0.9 - i * 0.1,
        ),
      );
    }
    const graph = makeMockGraph({ ftsHits: hits });
    const retr = new ContextRetriever(graph);

    // Budget that fits ~3 hits at ~80 chars/hit (compact-shape): 80/4 = 20
    // tokens per chunk → ~60 tokens for 3 chunks. Use 70-token budget.
    const result = await retr.assembleForBudget({
      userMessage: 'find',
      agentId: 'agent-test',
      budget: { tokens: 70 },
    });

    assert.ok(result.included.length >= 1);
    assert.ok(result.included.length <= 5);
    // The very lowest-ranked hits must be in the excluded list with
    // budget-exceeded reason (when budget actually got exceeded).
    const lastIncluded = result.included[result.included.length - 1];
    assert.ok(lastIncluded !== undefined);
    // First included hit should be the highest-ranked one (turn:s-0:…).
    assert.equal(result.included[0]?.turnId, hits[0]?.turnId);
  });

  it('budget-exhaustion — hits past the cap land in excluded with reason="budget-exceeded"', async () => {
    const hits = [0, 1, 2, 3, 4].map((i) =>
      ftsHit(
        `s-${String(i)}`,
        `2026-05-0${String(i + 1)}T08:00:00Z`,
        {
          userMessage: 'X'.repeat(200),
          assistantAnswer: 'Y'.repeat(200),
        },
        0.9 - i * 0.05,
      ),
    );
    const graph = makeMockGraph({ ftsHits: hits });
    const retr = new ContextRetriever(graph);

    // Tiny budget — first hit consumes ~500 chars = ~125 tokens.
    const result = await retr.assembleForBudget({
      userMessage: 'find',
      agentId: 'agent-test',
      budget: { tokens: 60 },
    });

    assert.ok(result.included.length < hits.length);
    const budgetExceeded = result.excluded.filter(
      (e) => e.reason === 'budget-exceeded',
    );
    assert.ok(budgetExceeded.length >= 1);
  });

  it('manual-boost — manuallyAuthored=true bumps a low-score hit above an unboosted higher-score hit', async () => {
    const lower = ftsHit(
      's-low',
      '2026-05-01T08:00:00Z',
      { userMessage: 'low', assistantAnswer: 'low-a' },
      0.4,
      { manuallyAuthored: true },
    );
    const higher = ftsHit(
      's-high',
      '2026-05-02T08:00:00Z',
      { userMessage: 'high', assistantAnswer: 'high-a' },
      0.5,
      { manuallyAuthored: false },
    );
    const graph = makeMockGraph({ ftsHits: [higher, lower] });
    const retr = new ContextRetriever(graph);

    const result = await retr.assembleForBudget({
      userMessage: 'find',
      agentId: 'agent-test',
      budget: { tokens: 1000 },
    });

    // 0.4 × 1.3 = 0.52 > 0.5 → manual-boosted hit ranks first.
    assert.equal(result.included[0]?.turnId, lower.turnId);
    assert.equal(result.included[0]?.reason, 'manual-boost');
    assert.equal(result.included[1]?.turnId, higher.turnId);
  });

  it('agent-block — blocked entry shows up in excluded with reason="agent-blocked"', async () => {
    const a = ftsHit(
      's-a',
      '2026-05-01T08:00:00Z',
      { userMessage: 'a', assistantAnswer: 'a-a' },
      0.7,
    );
    const b = ftsHit(
      's-b',
      '2026-05-02T08:00:00Z',
      { userMessage: 'b', assistantAnswer: 'b-a' },
      0.6,
    );
    const graph = makeMockGraph({ ftsHits: [a, b] });
    const priorities = new FakeAgentPriorities([rec(a.turnId, 'block')]);
    const retr = new ContextRetriever(graph, {}, undefined, priorities);

    const result = await retr.assembleForBudget({
      userMessage: 'find',
      agentId: 'agent-test',
      budget: { tokens: 1000 },
    });

    const blocked = result.excluded.find(
      (e) => e.reason === 'agent-blocked' && e.turnId === a.turnId,
    );
    assert.ok(blocked !== undefined);
    // Only b should be included.
    assert.equal(result.included.length, 1);
    assert.equal(result.included[0]?.turnId, b.turnId);
  });

  it('agent-boost — weight=2.0 lifts a 0.3 hit above an unboosted 0.5 hit', async () => {
    const low = ftsHit(
      's-low',
      '2026-05-01T08:00:00Z',
      { userMessage: 'low', assistantAnswer: 'low-a' },
      0.3,
    );
    const high = ftsHit(
      's-high',
      '2026-05-02T08:00:00Z',
      { userMessage: 'high', assistantAnswer: 'high-a' },
      0.5,
    );
    const graph = makeMockGraph({ ftsHits: [high, low] });
    const priorities = new FakeAgentPriorities([rec(low.turnId, 'boost', 2.0)]);
    const retr = new ContextRetriever(graph, {}, undefined, priorities);

    const result = await retr.assembleForBudget({
      userMessage: 'find',
      agentId: 'agent-test',
      budget: { tokens: 1000 },
    });

    // 0.3 × 2.0 = 0.6 > 0.5 → boosted hit ranks first.
    assert.equal(result.included[0]?.turnId, low.turnId);
    assert.equal(result.included[0]?.reason, 'agent-boost');
    assert.equal(result.included[1]?.turnId, high.turnId);
  });

  it('compact-mode — pool > threshold triggers snippet rendering (~120 char per hit)', async () => {
    // 105 hits, each with full-body ~600 chars. Pool > default 100.
    const hits: TurnSearchHit[] = [];
    for (let i = 0; i < 105; i++) {
      hits.push(
        ftsHit(
          `s-${String(i)}`,
          `2026-05-${String((i % 28) + 1).padStart(2, '0')}T08:00:00Z`,
          {
            userMessage: 'X'.repeat(600),
            assistantAnswer: 'Y'.repeat(600),
          },
          0.9 - i * 0.005,
        ),
      );
    }
    const graph = makeMockGraph({ ftsHits: hits });
    const retr = new ContextRetriever(graph);

    const result = await retr.assembleForBudget({
      userMessage: 'find',
      agentId: 'agent-test',
      budget: { tokens: 100_000 }, // generous so compact-mode is observable
    });

    assert.equal(result.stats.compactMode, true);
    assert.ok(result.stats.candidatePool > 100);
    // Compact chunks: `- [time] q… … a…` ≤ ~135 chars (80+40+ markup).
    for (const h of result.included) {
      assert.ok(
        h.chars <= 200,
        `expected compact chunk ≤200 chars, got ${String(h.chars)}`,
      );
    }
  });

  it('tail-always-first — tail turns fill before higher-scored hybrid hits', async () => {
    const tailItem = {
      time: '2026-05-08T08:00:00Z',
      userMessage: 'tail-msg',
      assistantAnswer: 'tail-ans',
    };
    const hybrid = ftsHit(
      's-hybrid',
      '2026-05-07T08:00:00Z',
      { userMessage: 'hybrid', assistantAnswer: 'hybrid-a' },
      0.99,
      { manuallyAuthored: true },
    );
    const graph = makeMockGraph({ tail: [tailItem], ftsHits: [hybrid] });
    const retr = new ContextRetriever(graph);

    // Big budget — both fit, tail must be first.
    const result = await retr.assembleForBudget({
      userMessage: 'find',
      sessionScope: 'chat-active',
      agentId: 'agent-test',
      budget: { tokens: 1000 },
    });

    assert.ok(result.included.length >= 2);
    assert.equal(result.included[0]?.reason, 'tail');
    assert.equal(
      result.included[0]?.turnId,
      turnNodeId('chat-active', tailItem.time),
    );
  });

  it('no-priorities-service — assembler runs without block/boost when service is absent', async () => {
    const a = ftsHit(
      's-a',
      '2026-05-01T08:00:00Z',
      { userMessage: 'a', assistantAnswer: 'a-a' },
      0.7,
    );
    const graph = makeMockGraph({ ftsHits: [a] });
    // No priorities passed.
    const retr = new ContextRetriever(graph);

    const result = await retr.assembleForBudget({
      userMessage: 'find',
      agentId: 'agent-test',
      budget: { tokens: 1000 },
    });

    assert.equal(result.included.length, 1);
    assert.equal(
      result.excluded.filter((e) => e.reason === 'agent-blocked').length,
      0,
    );
  });

  it('chars-per-token — tighter heuristic shrinks the effective budget', async () => {
    const hits = [0, 1, 2, 3].map((i) =>
      ftsHit(
        `s-${String(i)}`,
        `2026-05-0${String(i + 1)}T08:00:00Z`,
        {
          userMessage: 'X'.repeat(200),
          assistantAnswer: 'Y'.repeat(200),
        },
        0.9 - i * 0.05,
      ),
    );
    const graph = makeMockGraph({ ftsHits: hits });

    const lax = new ContextRetriever(graph, { charsPerToken: 5 });
    const tight = new ContextRetriever(graph, { charsPerToken: 3 });

    const laxRes = await lax.assembleForBudget({
      userMessage: 'find',
      agentId: 'agent-test',
      budget: { tokens: 200 },
    });
    const tightRes = await tight.assembleForBudget({
      userMessage: 'find',
      agentId: 'agent-test',
      budget: { tokens: 200 },
    });

    // Tighter chars/token → fewer hits fit (or equal in edge cases).
    assert.ok(
      tightRes.included.length <= laxRes.included.length,
      `tight=${String(tightRes.included.length)} should be ≤ lax=${String(laxRes.included.length)}`,
    );
  });

  it('determinism — two consecutive calls with identical input return identical output', async () => {
    const hits = [0, 1, 2, 3].map((i) =>
      ftsHit(
        `s-${String(i)}`,
        `2026-05-0${String(i + 1)}T08:00:00Z`,
        {
          userMessage: `q-${String(i)}`,
          assistantAnswer: `a-${String(i)}`,
        },
        0.5, // identical scores → tie-break by turnId ASC
      ),
    );
    const graph = makeMockGraph({ ftsHits: hits });
    const retr = new ContextRetriever(graph);

    const a = await retr.assembleForBudget({
      userMessage: 'find',
      agentId: 'agent-test',
      budget: { tokens: 1000 },
    });
    const b = await retr.assembleForBudget({
      userMessage: 'find',
      agentId: 'agent-test',
      budget: { tokens: 1000 },
    });

    assert.deepEqual(
      a.included.map((h) => h.turnId),
      b.included.map((h) => h.turnId),
    );
    assert.equal(a.text, b.text);
    // Tie-break must be turnId ASC.
    const ids = a.included.map((h) => h.turnId);
    const sorted = [...ids].sort((x, y) => x.localeCompare(y));
    assert.deepEqual(ids, sorted);
  });
});
