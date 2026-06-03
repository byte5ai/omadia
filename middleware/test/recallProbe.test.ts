import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { toSemanticAnswer } from '@omadia/channel-sdk';
import type { ChatTurnResult } from '@omadia/channel-sdk';
import type { EmbeddingClient } from '@omadia/embeddings';
import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import { ContextRetriever } from '@omadia/orchestrator-extras';
import type {
  ProcessMemoryService,
  ProcessQueryHit,
  RecalledContext,
} from '@omadia/plugin-api';

// Cross-session KG-recall probe — R0 (listRecentPlans), R1 (team-visibility
// for curated-memory recall), R2 (ContextRetriever plan/process/insight legs).

const ALIGNED: number[] = [1, 0, 0, 0];

/** Embedding stub — every text maps to the same aligned vector so cosine ≈ 1
 *  against a MK seeded with the same vector. */
const stubEmbedder: EmbeddingClient = {
  async embed(): Promise<number[]> {
    return [...ALIGNED];
  },
};

/** ProcessMemoryService stub — only `query` is exercised by the retriever. */
function stubProcessMemory(
  hits: readonly ProcessQueryHit[],
): ProcessMemoryService {
  return {
    async query(): Promise<readonly ProcessQueryHit[]> {
      return hits;
    },
  } as unknown as ProcessMemoryService;
}

describe('R0 · listRecentPlans', () => {
  it('returns plans most-recent first, clamped to limit, tenant-wide', async () => {
    const kg = new InMemoryKnowledgeGraph();
    await kg.ingestPlan({
      planId: 'p-old',
      scope: 'sess-A',
      createdAt: '2026-06-01T10:00:00.000Z',
    });
    await kg.ingestPlan({
      planId: 'p-new',
      scope: 'sess-B',
      createdAt: '2026-06-01T12:00:00.000Z',
    });
    await kg.ingestPlan({
      planId: 'p-mid',
      scope: 'sess-C',
      createdAt: '2026-06-01T11:00:00.000Z',
    });

    const all = await kg.listRecentPlans({ limit: 10 });
    assert.deepEqual(
      all.map((p) => p.props['planId']),
      ['p-new', 'p-mid', 'p-old'],
    );

    const top1 = await kg.listRecentPlans({ limit: 1 });
    assert.equal(top1.length, 1);
    assert.equal(top1[0]!.props['planId'], 'p-new');
  });

  it('openOnly filters to plans with ≥1 pending/in_progress step', async () => {
    const kg = new InMemoryKnowledgeGraph();
    // Open plan: one done + one pending step.
    await kg.ingestPlan({
      planId: 'open',
      scope: 'sess-A',
      createdAt: '2026-06-01T10:00:00.000Z',
    });
    await kg.upsertPlanStep({
      stepId: 'open-s1',
      planId: 'open',
      scope: 'sess-A',
      goal: 'done step',
      order: 0,
      status: 'done',
    });
    await kg.upsertPlanStep({
      stepId: 'open-s2',
      planId: 'open',
      scope: 'sess-A',
      goal: 'pending step',
      order: 1,
      status: 'pending',
    });
    // Closed plan: all steps done.
    await kg.ingestPlan({
      planId: 'closed',
      scope: 'sess-A',
      createdAt: '2026-06-01T11:00:00.000Z',
    });
    await kg.upsertPlanStep({
      stepId: 'closed-s1',
      planId: 'closed',
      scope: 'sess-A',
      goal: 'all done',
      order: 0,
      status: 'done',
    });

    const open = await kg.listRecentPlans({ openOnly: true, limit: 10 });
    assert.deepEqual(
      open.map((p) => p.props['planId']),
      ['open'],
    );
    const any = await kg.listRecentPlans({ openOnly: false, limit: 10 });
    assert.equal(any.length, 2);
  });

  it('filters by userId when provided', async () => {
    const kg = new InMemoryKnowledgeGraph();
    await kg.ingestPlan({
      planId: 'mine',
      scope: 'sess-A',
      userId: 'alice',
      createdAt: '2026-06-01T10:00:00.000Z',
    });
    await kg.ingestPlan({
      planId: 'theirs',
      scope: 'sess-B',
      userId: 'bob',
      createdAt: '2026-06-01T11:00:00.000Z',
    });

    const mine = await kg.listRecentPlans({ userId: 'alice', limit: 10 });
    assert.deepEqual(
      mine.map((p) => p.props['planId']),
      ['mine'],
    );
  });
});

describe('R1 · team-visibility for curated-memory recall', () => {
  async function seedTeamMk(kg: InMemoryKnowledgeGraph): Promise<string> {
    const created = await kg.createMemorableKnowledge({
      kind: 'reference',
      summary: 'shared team knowledge',
      createdBy: 'web:bob',
      involvedOmadiaUserIds: [],
      aclOwners: ['bob'], // owned by bob, default (team) visibility
    });
    kg.setEmbedding(created.memorableKnowledgeNodeId, ALIGNED);
    return created.memorableKnowledgeNodeId;
  }

  it('owner-only by default: a non-owner does NOT see a team MK', async () => {
    const kg = new InMemoryKnowledgeGraph();
    await seedTeamMk(kg);
    const hits = await kg.searchMemorableKnowledgeByEmbedding({
      queryEmbedding: ALIGNED,
      viewerOmadiaUserId: 'alice', // not in acl_owners
    });
    assert.equal(hits.length, 0);
  });

  it('teamVisibility=true: a non-owner DOES see a team MK', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const mkId = await seedTeamMk(kg);
    const hits = await kg.searchMemorableKnowledgeByEmbedding({
      queryEmbedding: ALIGNED,
      viewerOmadiaUserId: 'alice',
      teamVisibility: true,
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.mk.id, mkId);
  });

  it('owner still sees their own MK regardless of teamVisibility', async () => {
    const kg = new InMemoryKnowledgeGraph();
    await seedTeamMk(kg);
    const hits = await kg.searchMemorableKnowledgeByEmbedding({
      queryEmbedding: ALIGNED,
      viewerOmadiaUserId: 'bob',
    });
    assert.equal(hits.length, 1);
  });
});

describe('R2 · ContextRetriever cross-session recall legs', () => {
  it('surfaces cross-session plans, processes, and team insights', async () => {
    const kg = new InMemoryKnowledgeGraph();

    // Prior-session plan with one open step.
    await kg.ingestPlan({
      planId: 'prior',
      scope: 'sess-prior',
      strategy: 'Migrate the billing module',
      createdAt: '2026-06-01T10:00:00.000Z',
    });
    await kg.upsertPlanStep({
      stepId: 'prior-s1',
      planId: 'prior',
      scope: 'sess-prior',
      goal: 'write migration',
      order: 0,
      status: 'done',
    });
    await kg.upsertPlanStep({
      stepId: 'prior-s2',
      planId: 'prior',
      scope: 'sess-prior',
      goal: 'run migration in staging',
      order: 1,
      status: 'pending',
    });

    // Team-visible insight owned by someone else.
    const mk = await kg.createMemorableKnowledge({
      kind: 'reference',
      summary: 'staging DSN is in the vault under billing/staging',
      createdBy: 'web:bob',
      involvedOmadiaUserIds: [],
      aclOwners: ['bob'],
    });
    kg.setEmbedding(mk.memorableKnowledgeNodeId, ALIGNED);

    const processMemory = stubProcessMemory([
      {
        record: {
          id: 'process:sess-x:backend-deploy',
          scope: 'sess-x',
          title: 'Backend: Deploy to staging',
          steps: ['build', 'migrate', 'smoke'],
          visibility: 'team',
          version: 1,
          createdAt: '2026-06-01T09:00:00.000Z',
          updatedAt: '2026-06-01T09:00:00.000Z',
        },
        score: 0.82,
      },
    ]);

    const retriever = new ContextRetriever(
      kg,
      { teamVisibility: true },
      stubEmbedder,
      undefined,
      processMemory,
    );

    const result = await retriever.assembleForBudget({
      userMessage: 'how do I deploy the billing migration to staging?',
      agentId: 'test-agent',
      sessionScope: 'sess-now', // different from sess-prior
      userId: 'alice',
    });

    assert.equal(result.recalled.plans.length, 1, 'one prior-session plan');
    assert.equal(result.recalled.plans[0]!.openStepGoals.length, 1);
    assert.equal(result.recalled.plans[0]!.doneCount, 1);
    assert.equal(result.recalled.plans[0]!.totalCount, 2);

    assert.equal(result.recalled.processes.length, 1, 'one stored process');
    assert.equal(
      result.recalled.processes[0]!.title,
      'Backend: Deploy to staging',
    );

    assert.equal(result.recalled.insights.length, 1, 'one team insight');

    // The recall blocks are prepended into the injected prompt text.
    assert.match(result.text, /Aus früheren Sessions — offene Pläne/);
    assert.match(result.text, /Aus früheren Sessions — gespeicherte Prozesse/);
    assert.match(result.text, /Aus früheren Sessions — verwandte Erkenntnisse/);
  });

  it('excludes the current session’s own plan from recall', async () => {
    const kg = new InMemoryKnowledgeGraph();
    await kg.ingestPlan({
      planId: 'current',
      scope: 'sess-now',
      createdAt: '2026-06-01T10:00:00.000Z',
    });
    await kg.upsertPlanStep({
      stepId: 'current-s1',
      planId: 'current',
      scope: 'sess-now',
      goal: 'do the thing',
      order: 0,
      status: 'pending',
    });

    const retriever = new ContextRetriever(kg, { teamVisibility: true });
    const result = await retriever.assembleForBudget({
      userMessage: 'continue',
      agentId: 'test-agent',
      sessionScope: 'sess-now',
      userId: 'alice',
    });
    assert.equal(result.recalled.plans.length, 0);
  });

  it('empty recall legs leave the assembler output untouched', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const retriever = new ContextRetriever(kg, { teamVisibility: true });
    const result = await retriever.assembleForBudget({
      userMessage: 'hello',
      agentId: 'test-agent',
      sessionScope: 'sess-now',
      userId: 'alice',
    });
    assert.deepEqual(result.recalled, {
      plans: [],
      processes: [],
      insights: [],
    });
    assert.doesNotMatch(result.text, /Aus früheren Sessions/);
  });
});

describe('R6 · relevance-filtered plan recall', () => {
  async function seedVacationPlan(kg: InMemoryKnowledgeGraph): Promise<void> {
    // A prior-session plan about VACATION RULES with an open mermaid step.
    await kg.ingestPlan({
      planId: 'vacation',
      scope: 'sess-vacation',
      strategy: 'Urlaubsregeln zusammenfassen',
      createdAt: '2026-06-01T10:00:00.000Z',
    });
    await kg.upsertPlanStep({
      stepId: 'vac-s1',
      planId: 'vacation',
      scope: 'sess-vacation',
      goal: 'Die drei wichtigsten Punkte herausarbeiten',
      order: 0,
      status: 'done',
    });
    await kg.upsertPlanStep({
      stepId: 'vac-s2',
      planId: 'vacation',
      scope: 'sess-vacation',
      goal: 'Erstelle ein Mermaid-Diagramm der drei wichtigsten Punkte',
      order: 1,
      status: 'pending',
    });
  }

  it('does NOT surface a topically-unrelated open plan (the reported bug)', async () => {
    const kg = new InMemoryKnowledgeGraph();
    await seedVacationPlan(kg);
    const retriever = new ContextRetriever(kg, { teamVisibility: true });
    const result = await retriever.assembleForBudget({
      userMessage: 'Wo waren wir beim Mitarbeiter-Onboarding in Odoo?',
      agentId: 'test-agent',
      sessionScope: 'sess-now',
      userId: 'alice',
    });
    assert.equal(result.recalled.plans.length, 0);
  });

  it('surfaces an open plan when the query shares a term with it', async () => {
    const kg = new InMemoryKnowledgeGraph();
    await seedVacationPlan(kg);
    const retriever = new ContextRetriever(kg, { teamVisibility: true });
    const result = await retriever.assembleForBudget({
      userMessage: 'Wie waren nochmal die Urlaubsregeln?',
      agentId: 'test-agent',
      sessionScope: 'sess-now',
      userId: 'alice',
    });
    assert.equal(result.recalled.plans.length, 1);
    assert.equal(result.recalled.plans[0]!.planId, 'plan:vacation');
  });

  it('ranks the more-relevant plan first (term-overlap count)', async () => {
    const kg = new InMemoryKnowledgeGraph();
    // Two plans; the query "Rechnung Odoo buchen" overlaps 1 vs 2 terms.
    await kg.ingestPlan({
      planId: 'one',
      scope: 'sess-a',
      strategy: 'Rechnung erfassen',
      createdAt: '2026-06-01T12:00:00.000Z',
    });
    await kg.upsertPlanStep({
      stepId: 'one-s1', planId: 'one', scope: 'sess-a',
      goal: 'Rechnung anlegen', order: 0, status: 'pending',
    });
    await kg.ingestPlan({
      planId: 'two',
      scope: 'sess-b',
      strategy: 'Rechnung in Odoo buchen',
      createdAt: '2026-06-01T11:00:00.000Z', // older, but more relevant
    });
    await kg.upsertPlanStep({
      stepId: 'two-s1', planId: 'two', scope: 'sess-b',
      goal: 'Buchung in Odoo durchführen', order: 0, status: 'pending',
    });
    const retriever = new ContextRetriever(kg, { teamVisibility: true });
    const result = await retriever.assembleForBudget({
      userMessage: 'Rechnung in Odoo buchen — wo standen wir?',
      agentId: 'test-agent',
      sessionScope: 'sess-now',
      userId: 'alice',
    });
    assert.equal(result.recalled.plans[0]!.planId, 'plan:two'); // 3 terms > 1
  });

  it('falls back to recency when the message has no candidate terms', async () => {
    const kg = new InMemoryKnowledgeGraph();
    await seedVacationPlan(kg);
    const retriever = new ContextRetriever(kg, { teamVisibility: true });
    // "ok" / punctuation only → no extractable terms → recency fallback.
    const result = await retriever.assembleForBudget({
      userMessage: 'ok?',
      agentId: 'test-agent',
      sessionScope: 'sess-now',
      userId: 'alice',
    });
    assert.equal(result.recalled.plans.length, 1);
  });
});

describe('T1 · toSemanticAnswer forwards recalled (non-stream / Teams path)', () => {
  const recalled: RecalledContext = {
    plans: [
      {
        planId: 'plan:prior',
        scope: 'sess-prior',
        openStepGoals: ['ship it'],
        doneCount: 1,
        totalCount: 2,
      },
    ],
    processes: [],
    insights: [],
  };

  it('carries recalled onto the SemanticAnswer when non-empty', () => {
    const result: ChatTurnResult = {
      answer: 'hi',
      toolCalls: 0,
      iterations: 1,
      recalled,
    };
    const answer = toSemanticAnswer(result);
    assert.deepEqual(answer.recalled, recalled);
  });

  it('omits recalled when all legs are empty', () => {
    const result: ChatTurnResult = {
      answer: 'hi',
      toolCalls: 0,
      iterations: 1,
      recalled: { plans: [], processes: [], insights: [] },
    };
    assert.equal(toSemanticAnswer(result).recalled, undefined);
  });

  it('omits recalled when absent', () => {
    const result: ChatTurnResult = { answer: 'hi', toolCalls: 0, iterations: 1 };
    assert.equal(toSemanticAnswer(result).recalled, undefined);
  });
});
