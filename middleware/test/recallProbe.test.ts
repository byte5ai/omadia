import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { toSemanticAnswer } from '@omadia/channel-sdk';
import type { ChatTurnResult } from '@omadia/channel-sdk';
import type { EmbeddingClient } from '@omadia/embeddings';
import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import {
  ContextRetriever,
  createRecallRelevanceJudge,
} from '@omadia/orchestrator-extras';
import type { RecallRelevanceJudge } from '@omadia/orchestrator-extras';
import type { LlmProvider } from '@omadia/llm-provider';
import type {
  ProcessMemoryService,
  ProcessQueryHit,
  RecalledContext,
} from '@omadia/plugin-api';
import { turnNodeId } from '@omadia/plugin-api';

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

  // Regression: cross-session recall must NOT evict the immediately-preceding
  // in-session turn from the budget. Before the continuity guard, the recall
  // blocks claimed up to half the budget first and a large recent answer could
  // be dropped (`reason: budget-exceeded`) — so a follow-up silently lost the
  // latest state. The tail is now reserved before recall takes its share.
  it('keeps the most-recent in-session turn even when recall fills the budget', async () => {
    const kg = new InMemoryKnowledgeGraph();

    // Two in-session turns: an old short one and a recent LARGE one.
    await kg.ingestTurn({
      scope: 'sess-now',
      time: '2026-06-01T09:00:00.000Z',
      userMessage: 'kurze Frage',
      assistantAnswer: 'kurze Antwort',
      entityRefs: [],
      userId: 'alice',
    });
    const recentTime = '2026-06-01T09:30:00.000Z';
    await kg.ingestTurn({
      scope: 'sess-now',
      time: recentTime,
      userMessage: 'Detailanalyse der nicht abgerechneten TN bitte',
      // Big distinctive answer — the "latest state" a follow-up must keep.
      assistantAnswer: `LATEST-STATE-MARKER ${'Befund über nicht abgerechnete Teilnehmer. '.repeat(30)}`,
      entityRefs: [],
      userId: 'alice',
    });

    // Several team-visible insights, all aligned to the query so the recall
    // block is as full as it can get.
    for (let i = 0; i < 6; i++) {
      const mk = await kg.createMemorableKnowledge({
        kind: 'reference',
        summary: `Insight ${String(i)}: ${'kontextreiche Erkenntnis. '.repeat(10)}`,
        createdBy: 'web:bob',
        involvedOmadiaUserIds: [],
        aclOwners: ['bob'],
      });
      kg.setEmbedding(mk.memorableKnowledgeNodeId, ALIGNED);
    }

    const retriever = new ContextRetriever(
      kg,
      { teamVisibility: true },
      stubEmbedder,
    );
    const result = await retriever.assembleForBudget({
      userMessage: 'kannst du eine Detailanalyse machen?',
      agentId: 'test-agent',
      sessionScope: 'sess-now',
      userId: 'alice',
      budget: { tokens: 500 }, // tight: recall would otherwise crowd the tail
    });

    // Recall is present (the block did claim its share) …
    assert.ok(
      result.recalled.insights.length > 0,
      'recall insights should still be surfaced',
    );
    // … and yet the most-recent turn survived in the assembled context.
    const recentTurnId = turnNodeId('sess-now', recentTime);
    const includedIds = new Set(result.included.map((h) => h.turnId));
    assert.ok(
      includedIds.has(recentTurnId),
      'the latest in-session turn must be carried into the follow-up context',
    );
    assert.match(result.text, /LATEST-STATE-MARKER/);
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

  it('does NOT surface plans when the message has no candidate terms', async () => {
    const kg = new InMemoryKnowledgeGraph();
    await seedVacationPlan(kg);
    const retriever = new ContextRetriever(kg, { teamVisibility: true });
    // "ok?" → no extractable terms. The old recency fallback dumped the latest
    // open plan regardless of topic (the reported bug); the turn-level gate now
    // suppresses cross-session recall entirely on term-less turns.
    const result = await retriever.assembleForBudget({
      userMessage: 'ok?',
      agentId: 'test-agent',
      sessionScope: 'sess-now',
      userId: 'alice',
    });
    assert.equal(result.recalled.plans.length, 0);
  });
});

describe('R7 · turn-level recall gate (plans + processes + insights)', () => {
  it('a term-less turn surfaces NO processes or insights', async () => {
    const kg = new InMemoryKnowledgeGraph();
    // A team insight + a strongly-matching process would both surface if the
    // gate were open — they must NOT on a term-less greeting.
    const mk = await kg.createMemorableKnowledge({
      kind: 'reference',
      summary: 'unrelated prior-session insight',
      createdBy: 'web:bob',
      involvedOmadiaUserIds: [],
      aclOwners: ['bob'],
    });
    kg.setEmbedding(mk.memorableKnowledgeNodeId, ALIGNED);
    const processMemory = stubProcessMemory([
      {
        record: {
          id: 'process:sess-x:deploy',
          scope: 'sess-x',
          title: 'Deploy',
          steps: ['build'],
          visibility: 'team',
          version: 1,
          createdAt: '2026-06-01T09:00:00.000Z',
          updatedAt: '2026-06-01T09:00:00.000Z',
        },
        score: 0.99,
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
      userMessage: 'danke!',
      agentId: 'test-agent',
      sessionScope: 'sess-now',
      userId: 'alice',
    });
    assert.deepEqual(result.recalled, {
      plans: [],
      processes: [],
      insights: [],
    });
  });

  it('drops a process scoring below the raised default floor (0.45)', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const processMemory = stubProcessMemory([
      {
        record: {
          id: 'process:sess-x:weak',
          scope: 'sess-x',
          title: 'Weakly related',
          steps: ['x'],
          visibility: 'team',
          version: 1,
          createdAt: '2026-06-01T09:00:00.000Z',
          updatedAt: '2026-06-01T09:00:00.000Z',
        },
        score: 0.4, // ≥ old 0.3 default, < new 0.45 default
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
      userMessage: 'how do I run the deployment process?',
      agentId: 'test-agent',
      sessionScope: 'sess-now',
      userId: 'alice',
    });
    assert.equal(result.recalled.processes.length, 0);
  });

  it('recallRequiresTerms=false re-opens the gate for the semantic legs on a term-less turn', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const mk = await kg.createMemorableKnowledge({
      kind: 'reference',
      summary: 'aligned prior-session insight',
      createdBy: 'web:bob',
      involvedOmadiaUserIds: [],
      aclOwners: ['bob'],
    });
    kg.setEmbedding(mk.memorableKnowledgeNodeId, ALIGNED);
    // …also seed an open plan: even with the gate open, plans must NOT return
    // on a term-less turn — that recency dump is the bug, never restored.
    await kg.ingestPlan({
      planId: 'open-plan',
      scope: 'sess-prior',
      strategy: 'Urlaubsregeln zusammenfassen',
      createdAt: '2026-06-01T10:00:00.000Z',
    });
    await kg.upsertPlanStep({
      stepId: 'op-s1',
      planId: 'open-plan',
      scope: 'sess-prior',
      goal: 'Punkte herausarbeiten',
      order: 0,
      status: 'pending',
    });
    const retriever = new ContextRetriever(
      kg,
      { teamVisibility: true, recallRequiresTerms: false },
      stubEmbedder,
    );
    const result = await retriever.assembleForBudget({
      userMessage: 'ok?',
      agentId: 'test-agent',
      sessionScope: 'sess-now',
      userId: 'alice',
    });
    assert.equal(
      result.recalled.insights.length,
      1,
      'gate open → insight surfaces',
    );
    assert.equal(result.recalled.plans.length, 0, 'plans never recency-dump');
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

/** Minimal LlmProvider stub: `complete` returns a fixed text body (or throws). */
function stubLlm(reply: string | (() => never)): LlmProvider {
  return {
    async complete(): Promise<unknown> {
      if (typeof reply === 'function') return reply();
      return { content: [{ type: 'text', text: reply }] };
    },
  } as unknown as LlmProvider;
}

describe('R8 · recall relevance judge (LLM-agnostic)', () => {
  const cands = [
    { id: 'plan:a', kind: 'plan' as const, text: 'about billing migration' },
    { id: 'process:b', kind: 'process' as const, text: 'deploy to staging' },
    { id: 'mk:c', kind: 'insight' as const, text: 'generic odoo access note' },
  ];

  it('keeps only the ids the model returns', async () => {
    const judge = createRecallRelevanceJudge({
      llm: stubLlm(JSON.stringify({ relevant: ['plan:a', 'process:b'] })),
      model: 'fast-test',
    });
    const keep = await judge.filterRelevant('how do I deploy billing?', cands);
    assert.deepEqual([...keep].sort(), ['plan:a', 'process:b']);
  });

  it('ignores hallucinated ids not among the candidates', async () => {
    const judge = createRecallRelevanceJudge({
      llm: stubLlm(JSON.stringify({ relevant: ['plan:a', 'mk:GHOST'] })),
      model: 'fast-test',
    });
    const keep = await judge.filterRelevant('deploy', cands);
    assert.deepEqual([...keep], ['plan:a']);
  });

  it('FAILS OPEN (keeps all) on a non-JSON reply', async () => {
    const judge = createRecallRelevanceJudge({
      llm: stubLlm('sorry, I cannot do that'),
      model: 'fast-test',
    });
    const keep = await judge.filterRelevant('deploy', cands);
    assert.equal(keep.size, 3);
  });

  it('FAILS OPEN (keeps all) when the provider throws', async () => {
    const judge = createRecallRelevanceJudge({
      llm: stubLlm(() => {
        throw new Error('provider down');
      }),
      model: 'fast-test',
    });
    const keep = await judge.filterRelevant('deploy', cands);
    assert.equal(keep.size, 3);
  });

  it('keeps everything when there are no candidates', async () => {
    const judge = createRecallRelevanceJudge({
      llm: stubLlm('{"relevant":[]}'),
      model: 'fast-test',
    });
    const keep = await judge.filterRelevant('deploy', []);
    assert.equal(keep.size, 0);
  });

  /** Stub returning a different reply per call; counts invocations. */
  function sequencedLlm(replies: Array<string | (() => never)>): {
    llm: LlmProvider;
    calls: () => number;
  } {
    let i = 0;
    return {
      calls: () => i,
      llm: {
        async complete(): Promise<unknown> {
          const r = replies[Math.min(i, replies.length - 1)];
          i += 1;
          if (typeof r === 'function') return r();
          return { content: [{ type: 'text', text: r }] };
        },
      } as unknown as LlmProvider,
    };
  }

  it('replays a genuine verdict for an identical query (R5 determinism — judge called once)', async () => {
    const seq = sequencedLlm([
      JSON.stringify({ relevant: ['plan:a'] }), // 1st genuine verdict
      JSON.stringify({ relevant: ['process:b'] }), // would differ if re-called
    ]);
    const judge = createRecallRelevanceJudge({ llm: seq.llm, model: 'fast-test' });
    const first = await judge.filterRelevant('how do I deploy billing?', cands);
    const second = await judge.filterRelevant('how do I deploy billing?', cands);
    assert.deepEqual([...first], ['plan:a']);
    assert.deepEqual([...second], ['plan:a'], 'cached verdict replayed, not re-rolled');
    assert.equal(seq.calls(), 1, 'provider hit exactly once for the repeated query');
  });

  it('does NOT cache an abstain — a transient failure retries the judge next time', async () => {
    const seq = sequencedLlm([
      () => {
        throw new Error('provider down'); // 1st call abstains (keep all)
      },
      JSON.stringify({ relevant: ['plan:a'] }), // 2nd call genuinely judges
    ]);
    const judge = createRecallRelevanceJudge({ llm: seq.llm, model: 'fast-test' });
    const first = await judge.filterRelevant('deploy', cands);
    const second = await judge.filterRelevant('deploy', cands);
    assert.equal(first.size, 3, 'abstain keeps all (deterministic floor)');
    assert.deepEqual([...second], ['plan:a'], 'retry runs the judge (abstain was not cached)');
    assert.equal(seq.calls(), 2);
  });
});

describe('R9 · ContextRetriever applies the relevance judge to recalled', () => {
  async function seedPlanAndInsight(kg: InMemoryKnowledgeGraph): Promise<void> {
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
      goal: 'run billing migration in staging',
      order: 0,
      status: 'pending',
    });
    const mk = await kg.createMemorableKnowledge({
      kind: 'reference',
      summary: 'generic note about billing access',
      createdBy: 'web:bob',
      involvedOmadiaUserIds: [],
      aclOwners: ['bob'],
    });
    kg.setEmbedding(mk.memorableKnowledgeNodeId, ALIGNED);
  }

  // A judge that drops every INSIGHT (mk:*) but keeps plans/processes.
  const dropInsights: RecallRelevanceJudge = {
    async filterRelevant(_msg, candidates): Promise<Set<string>> {
      return new Set(
        candidates.filter((c) => c.kind !== 'insight').map((c) => c.id),
      );
    },
  };

  it('drops the candidates the judge rejects (insight filtered, plan kept)', async () => {
    const kg = new InMemoryKnowledgeGraph();
    await seedPlanAndInsight(kg);
    const retriever = new ContextRetriever(
      kg,
      { teamVisibility: true },
      stubEmbedder,
      undefined,
      undefined,
      dropInsights,
    );
    const result = await retriever.assembleForBudget({
      userMessage: 'how do I run the billing migration in staging?',
      agentId: 'test-agent',
      sessionScope: 'sess-now',
      userId: 'alice',
    });
    assert.equal(result.recalled.plans.length, 1, 'relevant plan kept');
    assert.equal(result.recalled.insights.length, 0, 'insight judged out');
  });

  it('recallRelevanceJudgeDisabled=true bypasses the judge', async () => {
    const kg = new InMemoryKnowledgeGraph();
    await seedPlanAndInsight(kg);
    const retriever = new ContextRetriever(
      kg,
      { teamVisibility: true, recallRelevanceJudgeDisabled: true },
      stubEmbedder,
      undefined,
      undefined,
      dropInsights,
    );
    const result = await retriever.assembleForBudget({
      userMessage: 'how do I run the billing migration in staging?',
      agentId: 'test-agent',
      sessionScope: 'sess-now',
      userId: 'alice',
    });
    assert.equal(result.recalled.insights.length, 1, 'judge bypassed → insight stays');
  });
});
