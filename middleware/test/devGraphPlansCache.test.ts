import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import {
  createDevGraphRouter,
  type PlanWithSteps,
} from '../src/routes/devGraph.js';
import { PlanScopeCache } from '../src/routes/planScopeCache.js';

// #133 — the dev `/plans` overlay endpoint: batched step fetch + a short-TTL
// per-scope cache. We count listPlansForScope calls to prove a second request
// inside the TTL window is served from cache (no knowledge-graph round-trip),
// and that the entry refetches once the injected clock passes the TTL.

class CountingGraph extends InMemoryKnowledgeGraph {
  listCalls = 0;
  override async listPlansForScope(
    scope: string,
  ): ReturnType<InMemoryKnowledgeGraph['listPlansForScope']> {
    this.listCalls += 1;
    return super.listPlansForScope(scope);
  }
}

interface PlansBody {
  scope: string;
  plans: Array<{
    plan: { id: string };
    steps: Array<{ id: string; props: Record<string, unknown> }>;
  }>;
}

describe('/api/dev/graph/plans — batched + cached', () => {
  let server: Server;
  let baseUrl: string;
  const graph = new CountingGraph();
  let clock = 10_000;

  before(async () => {
    await graph.ingestPlan({
      planId: 'p1',
      scope: 'sess-A',
      createdAt: '2026-06-01T10:00:00.000Z',
    });
    await graph.upsertPlanStep({
      stepId: 'p1-s0',
      planId: 'p1',
      scope: 'sess-A',
      goal: 'first goal',
      order: 0,
      status: 'pending',
    });

    const planCache = new PlanScopeCache<PlanWithSteps[]>({
      ttlMs: 1000,
      now: () => clock,
    });
    const app = express();
    app.use('/api/dev/graph', createDevGraphRouter({ graph, planCache }));
    server = app.listen(0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${String(addr.port)}/api/dev/graph`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns plans with their steps (batched read is correct)', async () => {
    const res = await fetch(`${baseUrl}/plans?scope=sess-A`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as PlansBody;
    assert.equal(body.plans.length, 1);
    assert.equal(body.plans[0]!.steps.length, 1);
    assert.equal(body.plans[0]!.steps[0]!.props['goal'], 'first goal');
    assert.equal(graph.listCalls, 1);
  });

  it('serves a second request within the TTL from cache (no KG hit)', async () => {
    clock = 10_500; // < 10_000 + 1000
    const res = await fetch(`${baseUrl}/plans?scope=sess-A`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as PlansBody;
    assert.equal(body.plans.length, 1);
    assert.equal(graph.listCalls, 1, 'cache hit — listPlansForScope not re-called');
  });

  it('refetches once the TTL has elapsed', async () => {
    clock = 11_100; // > 10_000 + 1000 → expired
    const res = await fetch(`${baseUrl}/plans?scope=sess-A`);
    assert.equal(res.status, 200);
    assert.equal(graph.listCalls, 2, 'expired — listPlansForScope re-called');
  });
});
