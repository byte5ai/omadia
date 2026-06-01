import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import { planNodeId, planStepNodeId, turnNodeId } from '@omadia/plugin-api';

// #133 (plan-as-data) slice E1 — Plan / PlanStep persistence.
// Exercises the in-memory backend (no DB). The Neon backend implements the
// same KnowledgeGraph contract and is covered by typecheck + the shared
// interface; behavioural parity is asserted here against the in-memory store.

const NOW = '2026-06-01T00:00:00.000Z';

describe('#133 E1 — Plan / PlanStep persistence (in-memory)', () => {
  it('ingestPlan creates a Plan node readable via getPlan', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const { planExternalId } = await kg.ingestPlan({
      planId: 'p1',
      scope: 'sess-1',
      strategy: 'mvp-first',
      createdBy: 'gate',
      createdAt: NOW,
    });
    assert.equal(planExternalId, planNodeId('p1'));

    const plan = await kg.getPlan(planExternalId);
    assert.ok(plan, 'plan node should exist');
    assert.equal(plan.type, 'Plan');
    assert.equal(plan.props['planId'], 'p1');
    assert.equal(plan.props['strategy'], 'mvp-first');
    assert.equal(plan.props['createdBy'], 'gate');

    assert.equal(await kg.getPlan(planNodeId('missing')), null);
  });

  it('upsertPlanStep persists steps with order, status and dependencies', async () => {
    const kg = new InMemoryKnowledgeGraph();
    await kg.ingestPlan({ planId: 'p1', scope: 'sess-1', createdAt: NOW });

    await kg.upsertPlanStep({
      stepId: 's1',
      planId: 'p1',
      scope: 'sess-1',
      goal: 'gather inputs',
      order: 0,
    });
    await kg.upsertPlanStep({
      stepId: 's2',
      planId: 'p1',
      scope: 'sess-1',
      goal: 'compute result',
      order: 1,
      exitCondition: 'result is non-empty',
      dependsOnStepIds: ['s1'],
    });

    const steps = await kg.getPlanSteps(planNodeId('p1'));
    assert.equal(steps.length, 2);
    // Ordered by props.order ascending.
    assert.equal(steps[0]!.id, planStepNodeId('s1'));
    assert.equal(steps[1]!.id, planStepNodeId('s2'));
    // Default status.
    assert.equal(steps[0]!.props['status'], 'pending');
    assert.equal(steps[1]!.props['status'], 'pending');
    // Dependency captured.
    assert.deepEqual(steps[1]!.props['dependsOn'], ['s1']);
    assert.equal(steps[1]!.props['exitCondition'], 'result is non-empty');
  });

  it('upsertPlanStep is idempotent and updates status on re-call', async () => {
    const kg = new InMemoryKnowledgeGraph();
    await kg.ingestPlan({ planId: 'p1', scope: 'sess-1', createdAt: NOW });
    await kg.upsertPlanStep({
      stepId: 's1',
      planId: 'p1',
      scope: 'sess-1',
      goal: 'do thing',
      order: 0,
    });
    await kg.upsertPlanStep({
      stepId: 's1',
      planId: 'p1',
      scope: 'sess-1',
      goal: 'do thing',
      order: 0,
      status: 'done',
      resultSummary: 'thing done',
    });

    const steps = await kg.getPlanSteps(planNodeId('p1'));
    assert.equal(steps.length, 1, 'no duplicate step node');
    assert.equal(steps[0]!.props['status'], 'done');
    assert.equal(steps[0]!.props['resultSummary'], 'thing done');
  });

  it('upsertPlanStep throws when the Plan has not been ingested', async () => {
    const kg = new InMemoryKnowledgeGraph();
    await assert.rejects(
      kg.upsertPlanStep({
        stepId: 's1',
        planId: 'ghost',
        scope: 'sess-1',
        goal: 'orphan',
        order: 0,
      }),
      /Plan .* not found/,
    );
  });

  it('getPlanSteps returns [] for an unknown plan', async () => {
    const kg = new InMemoryKnowledgeGraph();
    assert.deepEqual(await kg.getPlanSteps(planNodeId('nope')), []);
  });

  // #133 (E8) — PLAN_OF back-link. onBeforeTurn materialises the plan before
  // the Turn node exists, so the link is established on a later (idempotent)
  // re-ingest once the orchestrator hands the plugin the persisted Turn id.
  describe('PLAN_OF back-link', () => {
    const ingestTurn = async (
      kg: InMemoryKnowledgeGraph,
      scope: string,
      time: string,
    ): Promise<string> => {
      await kg.ingestTurn({
        scope,
        time,
        userMessage: 'do a multi-step thing',
        assistantAnswer: 'ok',
        entityRefs: [],
      });
      return turnNodeId(scope, time);
    };

    it('links the Plan to an existing Turn and records props.turnId', async () => {
      const kg = new InMemoryKnowledgeGraph();
      const turnExternalId = await ingestTurn(kg, 'sess-1', NOW);
      await kg.ingestPlan({
        planId: 'p1',
        scope: 'sess-1',
        turnExternalId,
        createdBy: 'gate',
        createdAt: NOW,
      });

      const plan = await kg.getPlan(planNodeId('p1'));
      assert.equal(plan!.props['turnId'], turnExternalId);

      const neighbors = await kg.getNeighbors(planNodeId('p1'));
      assert.ok(
        neighbors.some((n) => n.id === turnExternalId && n.type === 'Turn'),
        'PLAN_OF edge should connect the plan to its Turn',
      );
    });

    it('tolerates a missing Turn — no edge, no throw, plan still created', async () => {
      const kg = new InMemoryKnowledgeGraph();
      await kg.ingestPlan({
        planId: 'p1',
        scope: 'sess-1',
        turnExternalId: turnNodeId('sess-1', NOW), // Turn never ingested
        createdBy: 'gate',
        createdAt: NOW,
      });
      assert.ok(await kg.getPlan(planNodeId('p1')));
      assert.deepEqual(await kg.getNeighbors(planNodeId('p1')), []);
    });

    it('re-ingest adds the link once the Turn exists (idempotent, no dup plan)', async () => {
      const kg = new InMemoryKnowledgeGraph();
      // onBeforeTurn: plan first, no Turn yet → orphan.
      await kg.ingestPlan({
        planId: 'p1',
        scope: 'sess-1',
        createdBy: 'gate',
        createdAt: NOW,
      });
      await kg.upsertPlanStep({
        stepId: 'p1-s0',
        planId: 'p1',
        scope: 'sess-1',
        goal: 'gather',
        order: 0,
      });
      // The step is a neighbor (STEP_OF), but there is no Turn link yet.
      const before = await kg.getNeighbors(planNodeId('p1'));
      assert.ok(!before.some((n) => n.type === 'Turn'), 'no Turn link yet');

      // onAfterTurn: Turn now persisted → re-ingest with the turn id links it.
      const turnExternalId = await ingestTurn(kg, 'sess-1', NOW);
      await kg.ingestPlan({
        planId: 'p1',
        scope: 'sess-1',
        turnExternalId,
        createdBy: 'gate',
        createdAt: NOW,
      });

      const neighbors = await kg.getNeighbors(planNodeId('p1'));
      assert.ok(neighbors.some((n) => n.id === turnExternalId));
      // The plan node is not duplicated and its steps survive the re-ingest.
      const steps = await kg.getPlanSteps(planNodeId('p1'));
      assert.equal(steps.length, 1);
    });
  });
});
