import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import { planNodeId, planStepNodeId, type LlmCompleteResult } from '@omadia/plugin-api';
import {
  gcSupersededPlans,
  parseIndexArray,
  summariseRequest,
} from '@omadia/plugin-plan-runner';

// #237 (plan GC) — hard-delete prior semantic-duplicate plans for a scope,
// keeping only the latest. Runs against the in-memory backend; the Neon backend
// implements the same `deletePlan` contract (typecheck + interface parity).

const fakeLlm = (text: string) => ({
  complete: async (): Promise<LlmCompleteResult> => ({
    text,
    model: 'claude-haiku-4-5',
    inputTokens: 10,
    outputTokens: 5,
    finishReason: 'stop' as const,
    stopReason: 'end_turn' as const,
  }),
});

/** Ingest a Plan + N steps for a scope at a given createdAt. */
async function seedPlan(
  kg: InMemoryKnowledgeGraph,
  opts: {
    planId: string;
    scope: string;
    createdAt: string;
    requestSummary?: string;
    steps: number;
  },
): Promise<string> {
  const { planExternalId } = await kg.ingestPlan({
    planId: opts.planId,
    scope: opts.scope,
    createdBy: 'gate',
    createdAt: opts.createdAt,
    ...(opts.requestSummary ? { requestSummary: opts.requestSummary } : {}),
  });
  for (let i = 0; i < opts.steps; i++) {
    await kg.upsertPlanStep({
      stepId: `${opts.planId}-s${String(i)}`,
      planId: opts.planId,
      scope: opts.scope,
      goal: `goal ${String(i)}`,
      order: i,
      status: 'pending',
    });
  }
  return planExternalId;
}

describe('#237 plan GC — InMemoryKnowledgeGraph.deletePlan', () => {
  it('hard-deletes a Plan, its steps, and their edges; leaves siblings intact', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const doomed = await seedPlan(kg, {
      planId: 'p1',
      scope: 's',
      createdAt: '2026-06-01T00:00:00.000Z',
      steps: 3,
    });
    const keep = await seedPlan(kg, {
      planId: 'p2',
      scope: 's',
      createdAt: '2026-06-02T00:00:00.000Z',
      steps: 2,
    });

    const res = await kg.deletePlan(doomed);
    assert.equal(res.deleted, true);
    assert.equal(res.deletedSteps, 3);

    assert.equal(await kg.getPlan(doomed), null);
    assert.deepEqual(await kg.getPlanSteps(doomed), []);
    // Step nodes are gone individually.
    assert.equal(await kg.getPlan(planStepNodeId('p1-s0')), null);
    // Sibling plan untouched.
    assert.ok(await kg.getPlan(keep));
    assert.equal((await kg.getPlanSteps(keep)).length, 2);
  });

  it('is an idempotent no-op for a missing plan', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const res = await kg.deletePlan(planNodeId('nope'));
    assert.deepEqual(res, { deleted: false, deletedSteps: 0 });
  });
});

describe('#237 plan GC — gcSupersededPlans', () => {
  const scope = 'sess-1';
  const survivorSummary = 'update the participant list for the course';

  it('structurally deletes an identical-request prior plan (no LLM hit)', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const old = await seedPlan(kg, {
      planId: 'old',
      scope,
      createdAt: '2026-06-01T00:00:00.000Z',
      requestSummary: survivorSummary.toUpperCase(), // normalise → match
      steps: 2,
    });
    const keep = await seedPlan(kg, {
      planId: 'new',
      scope,
      createdAt: '2026-06-02T00:00:00.000Z',
      requestSummary: survivorSummary,
      steps: 1,
    });

    // LLM returns [] — proves the deletion came from the structural layer.
    const res = await gcSupersededPlans({
      scope,
      keepPlanExternalId: keep,
      requestSummary: survivorSummary,
      protectedPlanExternalIds: new Set(),
      llm: fakeLlm('[]'),
      kg,
    });

    assert.deepEqual(res.deletedPlanExternalIds, [old]);
    assert.equal(res.deletedSteps, 2);
    assert.equal(await kg.getPlan(old), null);
    assert.ok(await kg.getPlan(keep), 'survivor must remain');
  });

  it('semantically deletes a same-task prior plan via the LLM verdict', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const old = await seedPlan(kg, {
      planId: 'old',
      scope,
      createdAt: '2026-06-01T00:00:00.000Z',
      requestSummary: 'refresh who is attending the training session',
      steps: 1,
    });
    const keep = await seedPlan(kg, {
      planId: 'new',
      scope,
      createdAt: '2026-06-02T00:00:00.000Z',
      requestSummary: survivorSummary,
      steps: 1,
    });

    const res = await gcSupersededPlans({
      scope,
      keepPlanExternalId: keep,
      requestSummary: survivorSummary,
      protectedPlanExternalIds: new Set(),
      llm: fakeLlm('[0]'), // model says candidate 0 is the same task
      kg,
    });

    assert.deepEqual(res.deletedPlanExternalIds, [old]);
    assert.ok(await kg.getPlan(keep));
  });

  it('never deletes the survivor or a protected in-flight plan', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const inflight = await seedPlan(kg, {
      planId: 'old',
      scope,
      createdAt: '2026-06-01T00:00:00.000Z',
      requestSummary: survivorSummary,
      steps: 1,
    });
    const keep = await seedPlan(kg, {
      planId: 'new',
      scope,
      createdAt: '2026-06-02T00:00:00.000Z',
      requestSummary: survivorSummary,
      steps: 1,
    });

    const res = await gcSupersededPlans({
      scope,
      keepPlanExternalId: keep,
      requestSummary: survivorSummary,
      protectedPlanExternalIds: new Set([inflight]),
      llm: fakeLlm('[0]'),
      kg,
    });

    assert.deepEqual(res.deletedPlanExternalIds, []);
    assert.ok(await kg.getPlan(inflight), 'protected plan survives');
    assert.ok(await kg.getPlan(keep));
  });

  it('skips legacy plans that carry no requestSummary', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const legacy = await seedPlan(kg, {
      planId: 'old',
      scope,
      createdAt: '2026-06-01T00:00:00.000Z',
      steps: 1, // no requestSummary
    });
    const keep = await seedPlan(kg, {
      planId: 'new',
      scope,
      createdAt: '2026-06-02T00:00:00.000Z',
      requestSummary: survivorSummary,
      steps: 1,
    });

    const res = await gcSupersededPlans({
      scope,
      keepPlanExternalId: keep,
      requestSummary: survivorSummary,
      protectedPlanExternalIds: new Set(),
      llm: fakeLlm('[0]'),
      kg,
    });

    assert.deepEqual(res.deletedPlanExternalIds, []);
    assert.ok(await kg.getPlan(legacy));
  });

  it('does nothing when the scope has no prior plans', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const keep = await seedPlan(kg, {
      planId: 'new',
      scope,
      createdAt: '2026-06-02T00:00:00.000Z',
      requestSummary: survivorSummary,
      steps: 1,
    });
    const res = await gcSupersededPlans({
      scope,
      keepPlanExternalId: keep,
      requestSummary: survivorSummary,
      protectedPlanExternalIds: new Set(),
      llm: fakeLlm('[]'),
      kg,
    });
    assert.deepEqual(res.deletedPlanExternalIds, []);
  });
});

describe('#237 plan GC — helpers', () => {
  it('parseIndexArray keeps in-range integers, strips fences, tolerates junk', () => {
    assert.deepEqual(parseIndexArray('[0,2]', 3), [0, 2]);
    assert.deepEqual(parseIndexArray('```json\n[1]\n```', 3), [1]);
    assert.deepEqual(parseIndexArray('[5, -1, 1.5, 1]', 3), [1]); // out-of-range / non-int dropped
    assert.deepEqual(parseIndexArray('not json', 3), []);
    assert.deepEqual(parseIndexArray('{"x":1}', 3), []);
  });

  it('summariseRequest collapses whitespace and caps length', () => {
    assert.equal(summariseRequest('  a   b\nc  '), 'a b c');
    const long = 'x'.repeat(400);
    const out = summariseRequest(long);
    assert.equal(out.length, 281); // 280 chars + ellipsis
    assert.ok(out.endsWith('…'));
  });
});
