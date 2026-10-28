import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import { planNodeId, planStepNodeId } from '@omadia/plugin-api';
import {
  abandonPlan,
  advanceStep,
  finishPlan,
  NOT_REACHED_SUMMARY,
  startFirstStep,
  type TurnPlanState,
} from '@omadia/plugin-plan-runner';

// #133 (plan-as-data) slice E3 — in-turn progress tracking. Exercises the KG
// setPlanStepStatus patch + the cursor-based progress helpers against the
// in-memory backend.

const NOW = '2026-06-01T00:00:00.000Z';

async function seedPlan(
  kg: InMemoryKnowledgeGraph,
  rawStepIds: string[],
): Promise<TurnPlanState> {
  await kg.ingestPlan({ planId: 'p1', scope: 'sess-1', createdAt: NOW });
  for (let i = 0; i < rawStepIds.length; i++) {
    await kg.upsertPlanStep({
      stepId: rawStepIds[i]!,
      planId: 'p1',
      scope: 'sess-1',
      goal: `step ${String(i)}`,
      order: i,
    });
  }
  return {
    stepExternalIds: rawStepIds.map((id) => planStepNodeId(id)),
    cursor: 0,
  };
}

const statusOf = async (
  kg: InMemoryKnowledgeGraph,
): Promise<Array<unknown>> => {
  const steps = await kg.getPlanSteps(planNodeId('p1'));
  return steps.map((s) => s.props['status']);
};

describe('#133 E3 — setPlanStepStatus', () => {
  it('patches status + resultSummary in place, leaving other props intact', async () => {
    const kg = new InMemoryKnowledgeGraph();
    await seedPlan(kg, ['s0']);
    await kg.setPlanStepStatus(planStepNodeId('s0'), 'done', {
      resultSummary: 'did it',
    });
    const [step] = await kg.getPlanSteps(planNodeId('p1'));
    assert.equal(step!.props['status'], 'done');
    assert.equal(step!.props['resultSummary'], 'did it');
    assert.equal(step!.props['goal'], 'step 0'); // untouched
  });

  it('is a no-op for an unknown step id', async () => {
    const kg = new InMemoryKnowledgeGraph();
    await seedPlan(kg, ['s0']);
    await kg.setPlanStepStatus(planStepNodeId('ghost'), 'done');
    assert.deepEqual(await statusOf(kg), ['pending']);
  });
});

describe('#133 E3 — progress cursor', () => {
  it('walks pending → in_progress → done across steps', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const state = await seedPlan(kg, ['s0', 's1', 's2']);

    await startFirstStep(state, kg);
    assert.deepEqual(await statusOf(kg), ['in_progress', 'pending', 'pending']);

    await advanceStep(state, kg, { resultSummary: 's0 done' });
    assert.deepEqual(await statusOf(kg), ['done', 'in_progress', 'pending']);
    assert.equal(state.cursor, 1);

    await advanceStep(state, kg);
    assert.deepEqual(await statusOf(kg), ['done', 'done', 'in_progress']);

    await finishPlan(state, kg);
    assert.deepEqual(await statusOf(kg), ['done', 'done', 'done']);
  });

  it('records evidence on the completed step', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const state = await seedPlan(kg, ['s0', 's1']);
    await startFirstStep(state, kg);
    await advanceStep(state, kg, { resultSummary: 'query_kg: 3 hits' });
    const steps = await kg.getPlanSteps(planNodeId('p1'));
    assert.equal(steps[0]!.props['resultSummary'], 'query_kg: 3 hits');
  });

  it('advanceStep is a no-op once the cursor runs past the last step', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const state = await seedPlan(kg, ['s0']);
    await startFirstStep(state, kg);
    await advanceStep(state, kg); // s0 done, cursor → 1 (past end)
    await advanceStep(state, kg); // no-op
    assert.deepEqual(await statusOf(kg), ['done']);
    assert.equal(state.cursor, 1);
  });

  // #1502 — the turn's end used to mark the in-progress step `done` whether
  // or not a call ever worked on it, and left later steps `pending` (which
  // plan recall then read as an interrupted plan with "done" work).
  it('finishPlan skips every step the turn did not reach', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const state = await seedPlan(kg, ['s0', 's1', 's2']);
    await startFirstStep(state, kg);
    await advanceStep(state, kg); // s0 done, s1 in_progress
    await finishPlan(state, kg); // s1 never got its call; s2 never reached
    assert.deepEqual(await statusOf(kg), ['done', 'skipped', 'skipped']);
    const steps = await kg.getPlanSteps(planNodeId('p1'));
    assert.equal(steps[1]!.props['resultSummary'], NOT_REACHED_SUMMARY);
  });

  it('finishPlan skips the whole plan when no step was worked on', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const state = await seedPlan(kg, ['s0', 's1']);
    await startFirstStep(state, kg);
    await finishPlan(state, kg);
    assert.deepEqual(await statusOf(kg), ['skipped', 'skipped']);
  });

  it('finishPlan lets the answer complete the last step once all before it are done', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const state = await seedPlan(kg, ['s0', 's1']);
    await startFirstStep(state, kg);
    await advanceStep(state, kg); // s0 done, s1 (present) in_progress
    await finishPlan(state, kg);
    assert.deepEqual(await statusOf(kg), ['done', 'done']);
  });

  it('finishPlan leaves an abandoned plan as the replanner left it', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const state = await seedPlan(kg, ['s0', 's1']);
    await startFirstStep(state, kg);
    await kg.setPlanStepStatus(planStepNodeId('s0'), 'failed');
    await kg.setPlanStepStatus(planStepNodeId('s1'), 'skipped');
    abandonPlan(state);
    await finishPlan(state, kg);
    assert.deepEqual(await statusOf(kg), ['failed', 'skipped']);
  });
});
