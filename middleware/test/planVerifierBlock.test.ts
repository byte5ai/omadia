import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import { planNodeId, planStepNodeId } from '@omadia/plugin-api';
import { markLatestPlanVerifierBlocked } from '@omadia/plugin-plan-runner';

// #133 E6 — verifier-block recording on the scope's latest plan.

const NOW = '2026-06-01T00:00:00.000Z';

const step = (
  stepId: string,
  planId: string,
  order: number,
  status: 'pending' | 'done',
) => ({ stepId, planId, scope: 'sess', goal: stepId, order, status });

describe('#133 E6 — markLatestPlanVerifierBlocked', () => {
  it('marks the latest plan’s last done step failed with the reason', async () => {
    const kg = new InMemoryKnowledgeGraph();
    await kg.ingestPlan({ planId: 'p1', scope: 'sess', createdAt: NOW });
    await kg.upsertPlanStep(step('s0', 'p1', 0, 'done'));
    await kg.upsertPlanStep(step('s1', 'p1', 1, 'done'));
    await kg.upsertPlanStep(step('s2', 'p1', 2, 'pending'));

    const marked = await markLatestPlanVerifierBlocked('sess', 'boom', kg);
    assert.equal(marked, planStepNodeId('s1')); // last done step

    const steps = await kg.getPlanSteps(planNodeId('p1'));
    const s1 = steps.find((s) => s.id === planStepNodeId('s1'))!;
    assert.equal(s1.props['status'], 'failed');
    assert.match(String(s1.props['resultSummary']), /verifier blocked: boom/);
  });

  it('picks the most-recent plan by scope', async () => {
    const kg = new InMemoryKnowledgeGraph();
    await kg.ingestPlan({
      planId: 'old',
      scope: 'sess',
      createdAt: '2026-06-01T10:00:00.000Z',
    });
    await kg.upsertPlanStep(step('o0', 'old', 0, 'done'));
    await kg.ingestPlan({
      planId: 'new',
      scope: 'sess',
      createdAt: '2026-06-01T11:00:00.000Z',
    });
    await kg.upsertPlanStep(step('n0', 'new', 0, 'done'));

    const marked = await markLatestPlanVerifierBlocked('sess', 'r', kg);
    assert.equal(marked, planStepNodeId('n0')); // from the newer plan
  });

  it('returns null when the scope has no plan', async () => {
    const kg = new InMemoryKnowledgeGraph();
    assert.equal(await markLatestPlanVerifierBlocked('nope', 'r', kg), null);
  });
});
