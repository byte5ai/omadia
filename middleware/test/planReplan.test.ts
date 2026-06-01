import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import {
  planNodeId,
  planStepNodeId,
  type LlmCompleteResult,
} from '@omadia/plugin-api';
import {
  applyReplan,
  exitConditionMet,
  isToolFailure,
  replanRemainder,
  type TurnPlanState,
} from '@omadia/plugin-plan-runner';

// #133 (plan-as-data) slice E4 — replanning. LLM mocked; persistence runs
// against the in-memory knowledge graph.

const NOW = '2026-06-01T00:00:00.000Z';

const fakeLlm = (text: string) => ({
  complete: async (): Promise<LlmCompleteResult> => ({
    text,
    model: 'claude-haiku-4-5',
    inputTokens: 10,
    outputTokens: 5,
    stopReason: 'end_turn',
  }),
});

const statusOf = async (kg: InMemoryKnowledgeGraph): Promise<unknown[]> => {
  const steps = await kg.getPlanSteps(planNodeId('p1'));
  return steps.map((s) => s.props['status']);
};

describe('#133 E4 — isToolFailure', () => {
  it('detects the orchestrator "Error:" convention', () => {
    assert.equal(isToolFailure('Error: boom'), true);
    assert.equal(isToolFailure('  Error: leading space'), true);
    assert.equal(isToolFailure('all good'), false);
    assert.equal(isToolFailure(undefined), false);
  });
});

describe('#133 E4 — exitConditionMet', () => {
  it('treats YES as met and NO as unmet, defaulting to met on error', async () => {
    assert.equal(await exitConditionMet('x', 'r', fakeLlm('YES')), true);
    assert.equal(await exitConditionMet('x', 'r', fakeLlm('NO')), false);
    const boom = {
      complete: async (): Promise<never> => {
        throw new Error('down');
      },
    };
    assert.equal(await exitConditionMet('x', 'r', boom), true);
  });
});

describe('#133 E4 — replanRemainder', () => {
  it('fails the step, supersedes the tail, and appends a recovery path', async () => {
    const kg = new InMemoryKnowledgeGraph();
    await kg.ingestPlan({ planId: 'p1', scope: 'sess-1', createdAt: NOW });
    for (let i = 0; i < 3; i++) {
      await kg.upsertPlanStep({
        stepId: `s${String(i)}`,
        planId: 'p1',
        scope: 'sess-1',
        goal: `step ${String(i)}`,
        order: i,
      });
    }
    // s0 completed; s1 is the one that failed.
    await kg.setPlanStepStatus(planStepNodeId('s0'), 'done');

    const { newStepExternalIds } = await replanRemainder({
      planExternalId: planNodeId('p1'),
      planId: 'p1',
      scope: 'sess-1',
      userMessage: 'do the thing',
      failedStepExternalId: planStepNodeId('s1'),
      failureReason: 'Error: tool blew up',
      generation: 1,
      llm: fakeLlm('[{"goal":"recover A","dependsOn":[]},{"goal":"recover B","dependsOn":[0]}]'),
      kg,
    });

    assert.equal(newStepExternalIds.length, 2);
    assert.equal(newStepExternalIds[0], planStepNodeId('p1-r1-s0'));

    const steps = await kg.getPlanSteps(planNodeId('p1'));
    const byId = new Map(steps.map((s) => [s.id, s]));
    assert.equal(byId.get(planStepNodeId('s0'))!.props['status'], 'done');
    assert.equal(byId.get(planStepNodeId('s1'))!.props['status'], 'failed');
    assert.equal(byId.get(planStepNodeId('s2'))!.props['status'], 'skipped');
    // recovery steps appended, ordered after the originals.
    const recA = byId.get(planStepNodeId('p1-r1-s0'))!;
    assert.equal(recA.props['goal'], 'recover A');
    assert.equal(recA.props['status'], 'pending');
    assert.equal(recA.props['order'], 3);
    assert.deepEqual(
      byId.get(planStepNodeId('p1-r1-s1'))!.props['dependsOn'],
      ['p1-r1-s0'],
    );
  });

  it('returns no new steps when the model offers no recovery path', async () => {
    const kg = new InMemoryKnowledgeGraph();
    await kg.ingestPlan({ planId: 'p1', scope: 'sess-1', createdAt: NOW });
    await kg.upsertPlanStep({
      stepId: 's0',
      planId: 'p1',
      scope: 'sess-1',
      goal: 'step 0',
      order: 0,
    });
    const { newStepExternalIds } = await replanRemainder({
      planExternalId: planNodeId('p1'),
      planId: 'p1',
      scope: 'sess-1',
      userMessage: 'x',
      failedStepExternalId: planStepNodeId('s0'),
      failureReason: 'Error: nope',
      generation: 1,
      llm: fakeLlm('not json'),
      kg,
    });
    assert.deepEqual(newStepExternalIds, []);
    assert.deepEqual(await statusOf(kg), ['failed']);
  });
});

describe('#133 E4 — applyReplan', () => {
  it('keeps completed steps, drops the tail, appends + arms the new steps', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const state: TurnPlanState = {
      stepExternalIds: ['a', 'b', 'c'],
      cursor: 1, // 'a' done, 'b' failed
    };
    await applyReplan(state, ['n0', 'n1'], kg);
    assert.deepEqual(state.stepExternalIds, ['a', 'n0', 'n1']);
    assert.equal(state.cursor, 1);
  });
});
