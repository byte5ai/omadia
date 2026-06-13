import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import { planNodeId, type LlmCompleteResult } from '@omadia/plugin-api';
import {
  buildPlanSnapshot,
  materializePlan,
  parsePlanSteps,
  pruneTurns,
  shouldPlan,
} from '@omadia/plugin-plan-runner';

// #133 (plan-as-data) slice E2 — gate + materializer. The LLM is mocked so
// classification + decomposition are deterministic; persistence runs against
// the in-memory knowledge graph (E1).

const NOW = '2026-06-01T00:00:00.000Z';

const fakeLlm = (text: string) => ({
  complete: async (): Promise<LlmCompleteResult> => ({
    text,
    model: 'claude-haiku-4-5',
    inputTokens: 10,
    outputTokens: 5,
    finishReason: 'stop',
    stopReason: 'end_turn',
  }),
});

describe('#133 E2 — plan-runner gate + materializer', () => {
  describe('parsePlanSteps', () => {
    it('parses a plain JSON array', () => {
      const steps = parsePlanSteps(
        '[{"goal":"a","exitCondition":"done","dependsOn":[]},{"goal":"b","dependsOn":[0]}]',
      );
      assert.equal(steps.length, 2);
      assert.equal(steps[0]!.goal, 'a');
      assert.equal(steps[0]!.exitCondition, 'done');
      assert.deepEqual(steps[1]!.dependsOn, [0]);
    });

    it('strips ```json code fences', () => {
      const steps = parsePlanSteps('```json\n[{"goal":"x"}]\n```');
      assert.equal(steps.length, 1);
      assert.equal(steps[0]!.goal, 'x');
      assert.deepEqual(steps[0]!.dependsOn, []);
    });

    it('drops malformed entries and returns [] on non-JSON', () => {
      assert.deepEqual(parsePlanSteps('not json'), []);
      assert.deepEqual(parsePlanSteps('{"goal":"obj-not-array"}'), []);
      const mixed = parsePlanSteps('[{"goal":"ok"},{"nope":1},{"goal":""}]');
      assert.equal(mixed.length, 1);
      assert.equal(mixed[0]!.goal, 'ok');
    });
  });

  describe('shouldPlan', () => {
    it('returns true when the gate replies PLAN', async () => {
      assert.equal(await shouldPlan('do a multi-step thing', fakeLlm('PLAN')), true);
    });

    it('returns false when the gate replies DIRECT', async () => {
      assert.equal(await shouldPlan('what is 2+2?', fakeLlm('DIRECT')), false);
    });

    it('returns false on empty input without calling the model', async () => {
      let called = false;
      const llm = {
        complete: async (): Promise<never> => {
          called = true;
          throw new Error('should not be called');
        },
      };
      assert.equal(await shouldPlan('   ', llm), false);
      assert.equal(called, false);
    });

    it('errs toward DIRECT when the model throws', async () => {
      const llm = {
        complete: async (): Promise<never> => {
          throw new Error('llm down');
        },
      };
      assert.equal(await shouldPlan('something', llm), false);
    });
  });

  describe('materializePlan', () => {
    it('persists a Plan + ordered PlanSteps with dependencies', async () => {
      const kg = new InMemoryKnowledgeGraph();
      const llm = fakeLlm(
        '[{"goal":"gather","exitCondition":"inputs ready","dependsOn":[]},' +
          '{"goal":"compute","dependsOn":[0]}]',
      );
      const result = await materializePlan({
        planId: 'turn-xyz',
        scope: 'sess-1',
        userMessage: 'plan something',
        createdAt: NOW,
        llm,
        kg,
      });
      assert.ok(result);
      assert.equal(result.stepCount, 2);
      assert.equal(result.planExternalId, planNodeId('turn-xyz'));
      // E4(b) — exit conditions returned aligned with the steps (undefined
      // where the model declared none).
      assert.deepEqual(result.exitConditions, ['inputs ready', undefined]);

      const plan = await kg.getPlan(result.planExternalId);
      assert.ok(plan);
      assert.equal(plan.props['createdBy'], 'gate');

      const steps = await kg.getPlanSteps(result.planExternalId);
      assert.equal(steps.length, 2);
      assert.equal(steps[0]!.props['goal'], 'gather');
      assert.equal(steps[0]!.props['status'], 'pending');
      assert.equal(steps[1]!.props['goal'], 'compute');
      // dependsOn translated to the stable per-step id of step 0.
      assert.deepEqual(steps[1]!.props['dependsOn'], ['turn-xyz-s0']);
    });

    it('returns null when the model yields no usable steps', async () => {
      const kg = new InMemoryKnowledgeGraph();
      const result = await materializePlan({
        planId: 'turn-empty',
        scope: 'sess-1',
        userMessage: 'plan something',
        createdAt: NOW,
        llm: fakeLlm('garbage, not json'),
        kg,
      });
      assert.equal(result, null);
      assert.equal(await kg.getPlan(planNodeId('turn-empty')), null);
    });
  });

  // Hardening — the per-turn state map evicts leaked records (an errored turn
  // never fires onAfterTurn, so its entry would otherwise live forever).
  describe('pruneTurns', () => {
    it('evicts entries older than the TTL, keeps fresh ones', () => {
      const now = 1_000_000;
      const turns = new Map<string, { startedAtMs: number }>([
        ['fresh', { startedAtMs: now - 1000 }],
        ['stale', { startedAtMs: now - 31 * 60 * 1000 }],
      ]);
      pruneTurns(turns, now, { ttlMs: 30 * 60 * 1000 });
      assert.equal(turns.has('fresh'), true);
      assert.equal(turns.has('stale'), false);
    });

    it('drops the oldest (insertion-order) entries over the cap', () => {
      const now = 1000;
      const turns = new Map<string, { startedAtMs: number }>();
      for (let i = 0; i < 5; i++) turns.set(`t${String(i)}`, { startedAtMs: now });
      pruneTurns(turns, now, { ttlMs: 10_000, maxEntries: 3 });
      assert.equal(turns.size, 3);
      assert.equal(turns.has('t0'), false);
      assert.equal(turns.has('t1'), false);
      assert.equal(turns.has('t4'), true);
    });

    it('is a no-op within bounds', () => {
      const now = 1000;
      const turns = new Map<string, { startedAtMs: number }>([
        ['a', { startedAtMs: now }],
      ]);
      pruneTurns(turns, now);
      assert.equal(turns.size, 1);
    });
  });

  // E9 — the plan snapshot streamed to the UI as a `turn_annotation`.
  describe('buildPlanSnapshot', () => {
    it('projects the plan steps ordered, with live status', async () => {
      const kg = new InMemoryKnowledgeGraph();
      await kg.ingestPlan({ planId: 'p1', scope: 'sess', createdAt: NOW });
      await kg.upsertPlanStep({
        stepId: 's1',
        planId: 'p1',
        scope: 'sess',
        goal: 'second',
        order: 1,
        status: 'in_progress',
      });
      await kg.upsertPlanStep({
        stepId: 's0',
        planId: 'p1',
        scope: 'sess',
        goal: 'first',
        order: 0,
        status: 'done',
      });

      const snap = await buildPlanSnapshot(planNodeId('p1'), kg);
      assert.equal(snap.planExternalId, planNodeId('p1'));
      assert.deepEqual(
        snap.steps.map((s) => [s.order, s.goal, s.status]),
        [
          [0, 'first', 'done'],
          [1, 'second', 'in_progress'],
        ],
      );
    });
  });
});
