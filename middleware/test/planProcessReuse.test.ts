import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import { planNodeId } from '@omadia/plugin-api';
import type {
  ProcessMemoryService,
  ProcessQueryHit,
  ProcessRecord,
} from '@omadia/plugin-api';
import {
  materializePlanFromSteps,
  pickReusableProcess,
} from '@omadia/plugin-plan-runner';

// Process reuse: a matching learned process is materialised straight from its
// stored steps (no LLM), and the picker only reuses on a confident hit.

const NOW = '2026-06-09T12:00:00.000Z';

function record(over: Partial<ProcessRecord> = {}): ProcessRecord {
  return {
    id: 'process:sess-A:backend-deploy',
    scope: 'sess-A',
    title: 'Backend: Deploy to staging',
    steps: ['Build the image', 'Push to registry', 'Roll the deployment'],
    visibility: 'team',
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

/** Minimal ProcessMemoryService stub — only `query` is exercised. */
function stubProcessMemory(
  hits: readonly ProcessQueryHit[] | (() => Promise<never>),
): Pick<ProcessMemoryService, 'query'> {
  return {
    query: typeof hits === 'function' ? hits : async () => hits,
  };
}

describe('materializePlanFromSteps', () => {
  it('persists a Plan + ordered steps from process steps, no LLM', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const result = await materializePlanFromSteps({
      planId: 't1',
      scope: 'sess-A',
      userMessage: 'deploy the backend',
      createdAt: NOW,
      kg,
      steps: ['Build the image', 'Push to registry', 'Roll the deployment'],
      processTitle: 'Backend: Deploy to staging',
    });
    assert.ok(result);
    assert.equal(result.stepCount, 3);

    const plan = await kg.getPlan(planNodeId('t1'));
    assert.equal(plan?.props['createdBy'], 'process');
    assert.equal(
      plan?.props['strategy'],
      'Reused stored process: Backend: Deploy to staging',
    );

    const steps = await kg.getPlanSteps(planNodeId('t1'));
    assert.deepEqual(
      steps.map((s) => s.props['goal']),
      ['Build the image', 'Push to registry', 'Roll the deployment'],
    );
    assert.ok(steps.every((s) => s.props['status'] === 'pending'));
  });

  it('skips blank steps and returns null when nothing remains', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const trimmed = await materializePlanFromSteps({
      planId: 't2',
      scope: 'sess-A',
      userMessage: 'x',
      createdAt: NOW,
      kg,
      steps: ['  ', 'Real step', ''],
      processTitle: 'X: Y',
    });
    assert.equal(trimmed?.stepCount, 1);

    const empty = await materializePlanFromSteps({
      planId: 't3',
      scope: 'sess-A',
      userMessage: 'x',
      createdAt: NOW,
      kg,
      steps: ['', '   '],
      processTitle: 'X: Y',
    });
    assert.equal(empty, null);
  });
});

describe('pickReusableProcess', () => {
  it('reuses the top hit when it clears the threshold', async () => {
    const svc = stubProcessMemory([{ record: record(), score: 0.82 }]);
    const reuse = await pickReusableProcess(svc, 'deploy backend', 0.6);
    assert.equal(reuse?.id, 'process:sess-A:backend-deploy');
    assert.equal(reuse?.title, 'Backend: Deploy to staging');
    assert.equal(reuse?.steps.length, 3);
  });

  it('does not reuse a hit below the threshold', async () => {
    const svc = stubProcessMemory([{ record: record(), score: 0.4 }]);
    assert.equal(await pickReusableProcess(svc, 'something else', 0.6), null);
  });

  it('does not reuse a step-less process', async () => {
    const svc = stubProcessMemory([{ record: record({ steps: [] }), score: 0.95 }]);
    assert.equal(await pickReusableProcess(svc, 'deploy', 0.6), null);
  });

  it('returns null on no hits and on a query error (fall through to LLM)', async () => {
    assert.equal(await pickReusableProcess(stubProcessMemory([]), 'q', 0.6), null);
    const throwing = stubProcessMemory(async () => {
      throw new Error('process store down');
    });
    assert.equal(await pickReusableProcess(throwing, 'q', 0.6), null);
  });
});
