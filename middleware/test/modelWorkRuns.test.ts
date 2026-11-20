/**
 * Spec 2042 §5.10, §6 criterion 37 — operator jobs and maintenance runs.
 *
 *   - an operator job's model calls share one budget, a deadline and a
 *     cancel; it stops at each without further effects;
 *   - a maintenance run only embeds (`complete` refused) and stops at its
 *     budget;
 *   - the instance's daily budget per context caps all runs together;
 *   - raw model clients and provider pools are never a plugin's.
 */

import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it } from 'node:test';

import express from 'express';
import type { Pool } from 'pg';

import { admitModelCall, isModelCallNotCovered } from '@omadia/llm-provider';
import { resetModelGatewayForTests, setModelGatewayMode } from '@omadia/usage-telemetry';

import { ModelWorkBudgetError, createModelWorkRuns, type ModelWorkKind } from '../src/platform/modelWorkRuns.js';
import { EMBEDDING_BACKFILL, ISSUE_PREVIEW, TOPIC_REGROUPING } from '../src/platform/modelWorkKinds.js';
import { rawModelServiceAccess } from '../src/platform/pluginServiceGrants.js';

afterEach(() => resetModelGatewayForTests());

const job = (budgetCalls: number, deadlineMs = 60_000): ModelWorkKind => ({
  kind: 'test_job',
  context: 'operator_job',
  budgetCalls,
  deadlineMs,
  effects: ['topics'],
});

describe('operator jobs', () => {
  it('admits the job’s calls under enforce and records what it used', async () => {
    setModelGatewayMode('enforce');
    const runs = createModelWorkRuns({ operatorDailyCalls: 100, maintenanceDailyCalls: 100 });
    const out = await runs.run(job(5), 'op@example.com', async () => {
      admitModelCall();
      admitModelCall();
      return 'done';
    });
    assert.equal(out, 'done');
    const [row] = await runs.list();
    assert.equal(row?.status, 'succeeded');
    assert.equal(row?.modelCalls, 2);
    assert.equal(row?.startedBy, 'op@example.com');
    assert.deepEqual(row?.effects, ['topics']);
  });

  it('stops at its budget without further effects', async () => {
    const runs = createModelWorkRuns({ operatorDailyCalls: 100, maintenanceDailyCalls: 100 });
    const effects: string[] = [];
    await assert.rejects(
      runs.run(job(2), 'op', async () => {
        for (let i = 0; i < 5; i += 1) {
          admitModelCall();
          effects.push(`topic ${String(i)}`);
        }
      }),
      (err: unknown) => isModelCallNotCovered(err),
    );
    assert.deepEqual(effects, ['topic 0', 'topic 1']);
    assert.equal((await runs.list())[0]?.status, 'budget_exhausted');
  });

  it('stops at a cancel', async () => {
    const runs = createModelWorkRuns({ operatorDailyCalls: 100, maintenanceDailyCalls: 100 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const running = runs.run(job(10), 'op', async ({ id }) => {
      admitModelCall();
      assert.equal(runs.cancel(id, 'boss@example.com'), true);
      await gate;
      admitModelCall();
    });
    release();
    await assert.rejects(running, (err: unknown) => isModelCallNotCovered(err));
    const [row] = await runs.list();
    assert.equal(row?.status, 'cancelled');
    assert.equal(row?.cancelledBy, 'boss@example.com');
    assert.equal(runs.cancel(row!.id, 'x'), false, 'an ended job is not cancelled again');
  });

  it('stops at its deadline', async () => {
    const runs = createModelWorkRuns({ operatorDailyCalls: 100, maintenanceDailyCalls: 100 });
    await assert.rejects(
      runs.run(job(10, 5), 'op', async () => {
        await new Promise((r) => setTimeout(r, 20));
        admitModelCall();
      }),
      (err: unknown) => isModelCallNotCovered(err),
    );
    assert.equal((await runs.list())[0]?.status, 'deadline');
  });

  it('the daily operator-tools budget caps all jobs together', async () => {
    const runs = createModelWorkRuns({ operatorDailyCalls: 3, maintenanceDailyCalls: 100 });
    await runs.run(job(10), 'op', async () => {
      admitModelCall();
      admitModelCall();
    });
    // One call left today: the next job's budget is cut to it.
    await assert.rejects(
      runs.run(job(10), 'op', async () => {
        admitModelCall();
        admitModelCall();
      }),
      (err: unknown) => isModelCallNotCovered(err),
    );
    await assert.rejects(runs.run(job(10), 'op', async () => undefined), ModelWorkBudgetError);
  });

  it('the known jobs declare budgets, deadlines and effects', () => {
    for (const kind of [ISSUE_PREVIEW, TOPIC_REGROUPING]) {
      assert.equal(kind.context, 'operator_job');
      assert.ok(kind.budgetCalls > 0 && kind.deadlineMs > 0);
      assert.ok(kind.effects.length > 0);
    }
  });
});

describe('maintenance runs', () => {
  it('only embed; `complete` is refused', async () => {
    setModelGatewayMode('enforce');
    const runs = createModelWorkRuns({ operatorDailyCalls: 100, maintenanceDailyCalls: 100 });
    await runs.run(EMBEDDING_BACKFILL, undefined, async () => {
      admitModelCall('embed');
      assert.throws(() => admitModelCall('complete'), (err: unknown) => isModelCallNotCovered(err));
      assert.throws(() => admitModelCall('transcribe'), (err: unknown) => isModelCallNotCovered(err));
    });
  });

  it('stop at their budget', async () => {
    const runs = createModelWorkRuns({ operatorDailyCalls: 100, maintenanceDailyCalls: 100 });
    let embedded = 0;
    await assert.rejects(
      runs.run({ ...EMBEDDING_BACKFILL, budgetCalls: 3 }, undefined, async () => {
        for (;;) {
          admitModelCall('embed');
          embedded += 1;
        }
      }),
      (err: unknown) => isModelCallNotCovered(err),
    );
    assert.equal(embedded, 3);
    assert.equal(runs.cancel((await runs.list())[0]!.id, 'op'), false, 'a maintenance run has no operator cancel');
  });
});

describe('raw model services', () => {
  const access = (name: string, kind: Parameters<typeof rawModelServiceAccess>[0]['kind'], bundled: boolean, mode: 'observe' | 'enforce') =>
    rawModelServiceAccess({ name, kind, bundled, mode });

  it('are never an archetype plugin’s', () => {
    for (const name of ['anthropicClient', 'llm', 'llmProviderPool']) {
      assert.equal(access(name, 'archetype', false, 'observe'), 'refuse');
      assert.equal(access(name, 'archetype', true, 'observe'), 'refuse');
    }
  });

  it('are observed for other plugins in the expand step and refused once enforced', () => {
    assert.equal(access('anthropicClient', 'channel', false, 'observe'), 'observe');
    assert.equal(access('anthropicClient', 'channel', false, 'enforce'), 'refuse');
    assert.equal(access('llm', 'integration', false, 'enforce'), 'refuse');
    assert.equal(access('llmProviderPool', 'extension', false, 'enforce'), 'refuse');
  });

  it('stay with model plugins and the kernel’s own system modules', () => {
    assert.equal(access('llmProviderPool', 'model', false, 'enforce'), 'allow');
    assert.equal(access('llmProviderPool', 'system-module', true, 'enforce'), 'allow');
    assert.equal(access('llm', 'extension', true, 'enforce'), 'allow');
  });

  it('leave every other service alone', () => {
    assert.equal(access('knowledgeGraph', 'archetype', false, 'enforce'), 'allow');
  });
});

describe('operator jobs — the route middleware', () => {
  async function serve(runs: ReturnType<typeof createModelWorkRuns>, handler: express.RequestHandler): Promise<{ url: string; close: () => Promise<void> }> {
    const app = express();
    app.post('/job', runs.middleware(job(5)), handler);
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    return {
      url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/job`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it('runs the route as a job and names it in a header', async () => {
    setModelGatewayMode('enforce');
    const runs = createModelWorkRuns({ operatorDailyCalls: 100, maintenanceDailyCalls: 100 });
    const h = await serve(runs, (_req, res) => {
      admitModelCall();
      res.json({ ok: true });
    });
    try {
      const res = await fetch(h.url, { method: 'POST' });
      assert.equal(res.status, 200);
      assert.ok(res.headers.get('x-omadia-operator-job'));
    } finally {
      await h.close();
    }
  });

  it('answers 429 when the daily budget is used up, without running the route', async () => {
    const runs = createModelWorkRuns({ operatorDailyCalls: 0, maintenanceDailyCalls: 100 });
    let ran = false;
    const h = await serve(runs, (_req, res) => {
      ran = true;
      res.json({ ok: true });
    });
    try {
      const res = await fetch(h.url, { method: 'POST' });
      assert.equal(res.status, 429);
      assert.equal(ran, false);
    } finally {
      await h.close();
    }
  });

  it('answers 503 when the run store is unreachable, instead of leaving the request open', async () => {
    const pool = { query: async () => Promise.reject(new Error('pooler hiccup')) } as unknown as Pool;
    const runs = createModelWorkRuns({ pool, operatorDailyCalls: 100, maintenanceDailyCalls: 100, log: () => undefined });
    let ran = false;
    const h = await serve(runs, (_req, res) => {
      ran = true;
      res.json({ ok: true });
    });
    try {
      const res = await fetch(h.url, { method: 'POST', signal: AbortSignal.timeout(5_000) });
      assert.equal(res.status, 503);
      assert.equal(((await res.json()) as { code: string }).code, 'model_work.unavailable');
      assert.equal(ran, false);
    } finally {
      await h.close();
    }
  });

  it('a run that died while running stops holding its budget once past its deadline', async () => {
    let t = Date.parse('2026-11-20T10:00:00Z');
    const runs = createModelWorkRuns({ operatorDailyCalls: 10, maintenanceDailyCalls: 100, now: () => new Date(t) });
    // A run that never finishes holds its whole budget …
    void runs.run(job(10, 1_000), 'op', () => new Promise(() => undefined));
    await new Promise((r) => setTimeout(r, 10));
    await assert.rejects(runs.run(job(1), 'op', async () => 'x'), ModelWorkBudgetError);
    // … until its deadline passed: then it counts what it recorded.
    t += 2_000;
    assert.equal(await runs.run(job(1), 'op', async () => 'x'), 'x');
  });
});
