import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import { planNodeId, planStepNodeId } from '@omadia/plugin-api';

// #133 — getPlanStepsForPlans: batched variant of getPlanSteps that collapses
// the per-plan N+1 on the plan-recall and graph-overlay hot paths.

async function seedPlan(
  kg: InMemoryKnowledgeGraph,
  planId: string,
  scope: string,
  goals: string[],
): Promise<void> {
  await kg.ingestPlan({ planId, scope, createdAt: '2026-06-01T10:00:00.000Z' });
  for (let i = 0; i < goals.length; i++) {
    await kg.upsertPlanStep({
      stepId: `${planId}-s${String(i)}`,
      planId,
      scope,
      goal: goals[i]!,
      order: i,
      status: 'pending',
    });
  }
}

describe('#133 — getPlanStepsForPlans', () => {
  it('groups steps by plan, ordered, with [] for step-less/unknown ids', async () => {
    const kg = new InMemoryKnowledgeGraph();
    await seedPlan(kg, 'p1', 'sess-A', ['a0', 'a1']);
    await seedPlan(kg, 'p2', 'sess-A', ['b0']);
    await kg.ingestPlan({
      planId: 'p3-empty',
      scope: 'sess-A',
      createdAt: '2026-06-01T10:00:00.000Z',
    });

    const map = await kg.getPlanStepsForPlans([
      planNodeId('p1'),
      planNodeId('p2'),
      planNodeId('p3-empty'),
      planNodeId('p-unknown'),
    ]);

    // Every requested id is present, even with no steps.
    assert.equal(map.size, 4);
    assert.deepEqual(
      (map.get(planNodeId('p1')) ?? []).map((s) => s.id),
      [planStepNodeId('p1-s0'), planStepNodeId('p1-s1')],
    );
    assert.deepEqual(
      (map.get(planNodeId('p2')) ?? []).map((s) => s.props['goal']),
      ['b0'],
    );
    assert.deepEqual(map.get(planNodeId('p3-empty')), []);
    assert.deepEqual(map.get(planNodeId('p-unknown')), []);
  });

  it('matches getPlanSteps for each plan (parity with the single-plan read)', async () => {
    const kg = new InMemoryKnowledgeGraph();
    await seedPlan(kg, 'p1', 'sess-A', ['x', 'y', 'z']);

    const single = await kg.getPlanSteps(planNodeId('p1'));
    const batched = await kg.getPlanStepsForPlans([planNodeId('p1')]);
    assert.deepEqual(
      (batched.get(planNodeId('p1')) ?? []).map((s) => s.id),
      single.map((s) => s.id),
    );
  });

  it('returns an empty map for an empty id list (no work)', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const map = await kg.getPlanStepsForPlans([]);
    assert.equal(map.size, 0);
  });
});
