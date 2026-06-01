import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import { planNodeId, planStepNodeId } from '@omadia/plugin-api';
import { buildResumePlan } from '@omadia/plugin-plan-runner';

// #133 (plan-as-data) slice E5 — resume descriptor.

const NOW = '2026-06-01T00:00:00.000Z';

interface StepSpec {
  id: string;
  status: 'pending' | 'in_progress' | 'done' | 'failed' | 'skipped';
  resultSummary?: string;
  sideEffecting?: boolean;
}

async function seed(
  kg: InMemoryKnowledgeGraph,
  specs: StepSpec[],
): Promise<void> {
  await kg.ingestPlan({ planId: 'p1', scope: 'sess-1', createdAt: NOW });
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i]!;
    await kg.upsertPlanStep({
      stepId: s.id,
      planId: 'p1',
      scope: 'sess-1',
      goal: `goal ${s.id}`,
      order: i,
      status: s.status,
      ...(s.resultSummary ? { resultSummary: s.resultSummary } : {}),
      ...(s.sideEffecting !== undefined ? { sideEffecting: s.sideEffecting } : {}),
    });
  }
}

describe('#133 E5 — buildResumePlan', () => {
  it('returns null for an unknown plan', async () => {
    const kg = new InMemoryKnowledgeGraph();
    assert.equal(await buildResumePlan(planNodeId('nope'), kg), null);
  });

  it('reports completed steps + resumes from the first non-done step', async () => {
    const kg = new InMemoryKnowledgeGraph();
    await seed(kg, [
      { id: 's0', status: 'done', resultSummary: 'gathered 3 items' },
      { id: 's1', status: 'in_progress' },
      { id: 's2', status: 'pending' },
    ]);
    const r = await buildResumePlan(planNodeId('p1'), kg);
    assert.ok(r);
    assert.equal(r.completedSteps.length, 1);
    assert.equal(r.completedSteps[0]!.resultSummary, 'gathered 3 items');
    assert.equal(r.resumeFromStepExternalId, planStepNodeId('s1'));
    assert.match(r.resumeContext, /do NOT redo/);
    assert.match(r.resumeContext, /gathered 3 items/);
  });

  it('after a replan, resumes from the recovery path (ignores failed/skipped)', async () => {
    const kg = new InMemoryKnowledgeGraph();
    await seed(kg, [
      { id: 's0', status: 'done' },
      { id: 's1', status: 'failed' },
      { id: 's2', status: 'skipped' },
      { id: 'r0', status: 'pending' },
    ]);
    const r = await buildResumePlan(planNodeId('p1'), kg);
    assert.ok(r);
    assert.equal(r.resumeFromStepExternalId, planStepNodeId('r0'));
    assert.equal(r.completedSteps.length, 1);
  });

  it('flags done side-effecting steps and ambiguous in-progress ones', async () => {
    const kg = new InMemoryKnowledgeGraph();
    await seed(kg, [
      { id: 's0', status: 'done', sideEffecting: true },
      { id: 's1', status: 'in_progress', sideEffecting: true },
    ]);
    const r = await buildResumePlan(planNodeId('p1'), kg);
    assert.ok(r);
    assert.equal(r.sideEffectingDone.length, 1);
    assert.equal(r.sideEffectingDone[0]!.stepExternalId, planStepNodeId('s0'));
    assert.equal(
      r.ambiguousSideEffectStepExternalId,
      planStepNodeId('s1'),
    );
  });

  it('reports no resume point when every step is done', async () => {
    const kg = new InMemoryKnowledgeGraph();
    await seed(kg, [
      { id: 's0', status: 'done' },
      { id: 's1', status: 'done' },
    ]);
    const r = await buildResumePlan(planNodeId('p1'), kg);
    assert.ok(r);
    assert.equal(r.resumeFromStepExternalId, null);
    assert.match(r.resumeContext, /All planned steps are complete/);
  });
});
