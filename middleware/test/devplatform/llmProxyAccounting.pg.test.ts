import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, describe, it } from 'node:test';

import express from 'express';
import { Pool } from 'pg';

import { runMultiOrchestratorMigrations } from '@omadia/orchestrator';

import { DevJobStore } from '../../src/devplatform/devJobStore.js';
import { DevRepoStore } from '../../src/devplatform/devRepoStore.js';
import { finalizeDevJob } from '../../src/devplatform/finalizeDevJob.js';
import { mintRunnerToken } from '../../src/devplatform/jobToken.js';
import {
  createLlmProxyAccounting,
  type BudgetWarningInfo,
} from '../../src/devplatform/llmProxyAccounting.js';
import {
  createLlmProxyRouter,
  type LlmProxyBudgetHook,
  type LlmProxyUsageRecord,
} from '../../src/devplatform/llmProxy.js';
import { createDevRunnerRouter, type DevRunnerRouterDeps } from '../../src/routes/devRunnerApi.js';

/**
 * Epic #470 W4 (spec §5) — LLM budget accounting + enforcement, wired through the
 * REAL W2 proxy and the REAL pg `DevJobStore.accumulateJobUsage`. Each test is
 * FAIL-IF-REVERTED: it exercises a concrete accounting/enforcement behaviour that
 * only exists because of this unit. Skips when no test Postgres is reachable,
 * like the other `*.pg.test.ts`.
 *
 * Cost math is deterministic: model `claude-opus-4-8` bills input at $5/Mtok, so
 * `input_tokens = 200_000` ⇒ exactly $1.00 per call.
 */

const PG_URL =
  process.env['GRAPH_PG_TEST_URL'] ??
  process.env['MEMORY_PG_TEST_URL'] ??
  process.env['WS5_PG_TEST_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://test:test@127.0.0.1:55438/test';

const MARK = 'pg-llm-accounting';
const MODEL = 'claude-opus-4-8';
const OK_BODY = { model: MODEL, messages: [{ role: 'user', content: 'hi' }], stream: false };
const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

const probePool = new Pool({ connectionString: PG_URL, connectionTimeoutMillis: 2000 });
let pgAvailable = true;
try {
  await probePool.query('SELECT 1');
} catch {
  pgAvailable = false;
  await probePool.end().catch(() => undefined);
}

/** An upstream Anthropic-shaped non-stream JSON success carrying provider usage. */
function usageResponse(inputTokens: number, outputTokens: number): Response {
  return new Response(
    JSON.stringify({
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/** A minimal runner-router store: the LLM proxy sub-router does its OWN token
 *  auth via `resolveJobByToken`, so none of these are exercised here. */
const runnerStore: DevRunnerRouterDeps['store'] = {
  verifyRunnerToken: async () => false,
  getJob: async () => null,
  markRunning: async () => false,
  touchHeartbeat: async () => false,
  appendEvents: async () => 0,
  addArtifact: async () => 'x',
  artifactBelongsToJob: async () => false,
  recordResult: async () => {},
};

describe('devplatform/llmProxyAccounting (pg)', { skip: !pgAvailable }, () => {
  const pool = probePool;
  const store = new DevJobStore(pool);
  const repoStore = new DevRepoStore(pool);

  // Per-test capture, reset in beforeEach.
  const ledgerRows: LlmProxyUsageRecord[] = [];
  const warnings: Array<{ jobId: string; info: BudgetWarningInfo }> = [];
  let terminateCalls = 0;
  let upstreamCalls = 0;
  let upstream: () => Response = () => usageResponse(200_000, 0);

  const budget: LlmProxyBudgetHook = createLlmProxyAccounting({
    store,
    defaultBudgetCostUsd: 5,
    // Wire the terminal transition to the REAL finalize choke point (which also
    // dispatches backend terminate — spied here), never a raw status write.
    markBudgetExceeded: async (jobId) => {
      await finalizeDevJob(
        {
          store,
          terminate: async () => {
            terminateCalls += 1;
          },
        },
        jobId,
        'budget_exceeded',
        { reason: 'llm budget exhausted' },
      );
    },
    emitBudgetWarning: async (jobId, info) => {
      warnings.push({ jobId, info });
    },
    recordUsage: (row) => {
      ledgerRows.push(row);
    },
  });

  const fetchImpl = (async () => {
    upstreamCalls += 1;
    return upstream();
  }) as unknown as typeof fetch;

  const proxyRouter = createLlmProxyRouter({
    resolveJobByToken: (token) => store.resolveJobByToken(token),
    resolvePolicy: async () => ({
      provider: 'anthropic',
      upstreamBaseUrl: 'https://upstream.test',
      allowedModels: [MODEL],
    }),
    resolveProviderKey: async () => 'sk-ant-test-key',
    addJobUsage: async () => {}, // unused under the budget path
    budget,
    fetchImpl,
  });

  const app = express();
  app.use(
    '/api/v1/dev-runner',
    createDevRunnerRouter({
      store: runnerStore,
      repos: { getRepo: async () => null },
      scmTokens: { resolve: async () => undefined },
      finalizeDevJob: async () => null,
      llmProxyRouter: proxyRouter,
    } as unknown as DevRunnerRouterDeps),
  );

  let server: Server;
  let base = '';

  function post(token: string, body: object = OK_BODY): Promise<Response> {
    return fetch(`${base}/llm/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  }

  async function cleanup(): Promise<void> {
    // Cascades to dev_jobs → dev_job_events → dev_job_artifacts.
    await pool.query('DELETE FROM dev_repos WHERE created_by = $1', [MARK]);
  }

  async function makeJob(opts: {
    jobBudgetCostUsd?: number | null;
    jobBudgetTokens?: number | null;
    repoBudgetCostUsd?: number | null;
    repoBudgetTokens?: number | null;
    withHandle?: boolean;
  } = {}): Promise<{ jobId: string; token: string }> {
    const repo = await repoStore.createRepo({
      owner: MARK,
      name: `r-${randomUUID().slice(0, 8)}`,
      cloneUrl: 'https://example.com/x/y.git',
      credentialKind: 'pat',
      credentialRef: 'repo/x',
      createdBy: MARK,
    });
    if (opts.repoBudgetCostUsd !== undefined || opts.repoBudgetTokens !== undefined) {
      await pool.query('UPDATE dev_repos SET budget_cost_usd = $2, budget_tokens = $3 WHERE id = $1', [
        repo.id,
        opts.repoBudgetCostUsd ?? null,
        opts.repoBudgetTokens ?? null,
      ]);
    }
    const { token, hash } = mintRunnerToken();
    const job = await store.createJob({
      repoId: repo.id,
      kind: 'implement',
      brief: 'b',
      source: 'admin',
      backend: 'local',
      createdBy: MARK,
      runnerTokenHash: hash,
    });
    const handle = opts.withHandle
      ? JSON.stringify({ backend: 'local', id: 'h1', startedAt: new Date().toISOString() })
      : null;
    await pool.query(
      `UPDATE dev_jobs SET status = 'running', budget_cost_usd = $2, budget_tokens = $3,
                           runner_handle = $4::jsonb WHERE id = $1`,
      [job.id, opts.jobBudgetCostUsd ?? null, opts.jobBudgetTokens ?? null, handle],
    );
    return { jobId: job.id, token };
  }

  async function readJob(
    jobId: string,
  ): Promise<{ status: string; tokensIn: number; tokensOut: number; costUsd: number }> {
    const r = await pool.query('SELECT status, tokens_in, tokens_out, cost_usd FROM dev_jobs WHERE id = $1', [
      jobId,
    ]);
    const row = r.rows[0] as Record<string, unknown>;
    return {
      status: String(row['status']),
      tokensIn: Number(row['tokens_in']),
      tokensOut: Number(row['tokens_out']),
      costUsd: Number(row['cost_usd']),
    };
  }

  before(async () => {
    await runMultiOrchestratorMigrations(pool, undefined, migrationsDir);
    await cleanup();
    await new Promise<void>((r) => {
      server = app.listen(0, () => {
        base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/v1/dev-runner`;
        r();
      });
    });
  });

  after(async () => {
    await cleanup();
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
  });

  beforeEach(() => {
    ledgerRows.length = 0;
    warnings.length = 0;
    terminateCalls = 0;
    upstreamCalls = 0;
    upstream = () => usageResponse(200_000, 0);
  });

  it('a call under budget accumulates tokens/cost and records the ledger row for devjob:<id>', async () => {
    const { jobId, token } = await makeJob({ jobBudgetCostUsd: 100 });
    upstream = () => usageResponse(200_000, 0); // $1.00

    const res = await post(token);
    assert.equal(res.status, 200);
    await res.text();

    const job = await readJob(jobId);
    assert.equal(job.tokensIn, 200_000, 'tokens_in accumulated');
    assert.equal(job.tokensOut, 0, 'tokens_out accumulated');
    assert.ok(Math.abs(job.costUsd - 1) < 1e-9, `cost accumulated (~$1, got ${String(job.costUsd)})`);
    assert.equal(job.status, 'running', 'under budget ⇒ still running');

    assert.equal(ledgerRows.length, 1, 'exactly one ledger row');
    const row = ledgerRows[0]!;
    assert.equal(row.source, 'dev-job');
    assert.equal(row.sessionId, `devjob:${jobId}`);
    assert.equal(row.model, MODEL);
    assert.equal(row.inputTokens, 200_000);
    assert.equal(row.outputTokens, 0);

    assert.equal(terminateCalls, 0);
    assert.equal(warnings.length, 0);
    assert.equal(upstreamCalls, 1);
  });

  it('crossing 80% emits exactly ONE budget_warning (edge-triggered, not per call)', async () => {
    const { token } = await makeJob({ jobBudgetCostUsd: 1.2 }); // 80% = $0.96

    upstream = () => usageResponse(200_000, 0); // $1.00 → 83% of $1.20
    const res1 = await post(token);
    assert.equal(res1.status, 200);
    await res1.text();
    assert.equal(warnings.length, 1, 'first crossing of 80% warns once');
    assert.ok(Math.abs(warnings[0]!.info.budgetCostUsd - 1.2) < 1e-9);
    assert.equal(warnings[0]!.info.threshold, 0.8);

    upstream = () => usageResponse(20_000, 0); // +$0.10 → $1.10, still ≥80% and <100%
    const res2 = await post(token);
    assert.equal(res2.status, 200);
    await res2.text();
    assert.equal(warnings.length, 1, 'a second over-80% call does NOT re-warn');
  });

  it('crossing the cap returns 402, marks budget_exceeded via finalize, and terminates once; a subsequent call also gets 402 with no upstream call', async () => {
    const { jobId, token } = await makeJob({ jobBudgetCostUsd: 1.5, withHandle: true });
    upstream = () => usageResponse(200_000, 0); // $1.00 per call

    const res1 = await post(token); // $1.00 < $1.50
    assert.equal(res1.status, 200);
    await res1.text();
    assert.equal(terminateCalls, 0);

    const res2 = await post(token); // → $2.00 ≥ $1.50, crosses
    assert.equal(res2.status, 402, 'the crossing call is answered 402');
    assert.equal(((await res2.json()) as { code: string }).code, 'dev.budget_exceeded');

    const job = await readJob(jobId);
    assert.equal(job.status, 'budget_exceeded', 'marked terminal via finalize');
    assert.equal(terminateCalls, 1, 'backend terminate dispatched exactly once (through finalize)');
    assert.equal(upstreamCalls, 2, 'both calls hit upstream (enforcement is post-hoc)');

    const res3 = await post(token); // subsequent call on a capped job
    assert.equal(res3.status, 402, 'a capped job answers 402 on every subsequent call');
    assert.equal(((await res3.json()) as { code: string }).code, 'dev.budget_exceeded');
    assert.equal(upstreamCalls, 2, 'a capped-job call never reaches upstream');
  });

  it('enforcement is LEVEL-triggered: a call ALREADY over budget still 402s (not just the edge call)', async () => {
    // Forge W4 audit #1: an edge-only trigger let every call AFTER the crossing
    // deliver 200. Level-triggered means every over-budget call reports exceeded.
    const { jobId } = await makeJob({ jobBudgetCostUsd: 1 });
    const hook = createLlmProxyAccounting({
      store,
      defaultBudgetCostUsd: 5,
      markBudgetExceeded: async () => {}, // do NOT finalize — isolate the meter verdict
      emitBudgetWarning: async () => {},
      recordUsage: () => {},
    });
    const usage = { inputTokens: 400_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    const first = await hook.meter({ jobId, model: MODEL, usage }); // $2 ≥ $1 → crosses
    assert.equal(first.exceeded, true, 'the crossing call exceeds');
    // The job is NOT finalized here (markBudgetExceeded is a no-op), so a second
    // meter call lands on an already-over-budget job WITHOUT crossing any edge.
    const second = await hook.meter({ jobId, model: MODEL, usage }); // $4, prev already ≥ $1
    // COUNTER-PROOF: an edge trigger returns exceeded=false here (prev ≥ budget, no
    // crossing) and the call would be billed. Level-triggered must still exceed.
    assert.equal(second.exceeded, true, 'an already-over-budget call STILL exceeds (level-triggered)');
  });

  it('a markBudgetExceeded failure SELF-HEALS: the next over-budget call re-drives finalize', async () => {
    // Forge W4 audit #1: an edge trigger fired markBudgetExceeded exactly once, so a
    // transient failure there left the cap open forever. Level-triggered re-attempts.
    const { jobId } = await makeJob({ jobBudgetCostUsd: 1 });
    let attempts = 0;
    const hook = createLlmProxyAccounting({
      store,
      defaultBudgetCostUsd: 5,
      markBudgetExceeded: async (id) => {
        attempts += 1;
        if (attempts === 1) throw new Error('transient finalize blip'); // fail at the crossing
        await finalizeDevJob({ store, terminate: async () => {} }, id, 'budget_exceeded', { reason: 'llm budget' });
      },
      emitBudgetWarning: async () => {},
      recordUsage: () => {},
    });
    const usage = { inputTokens: 400_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    const first = await hook.meter({ jobId, model: MODEL, usage }); // crosses; markBudgetExceeded THROWS
    assert.equal(first.exceeded, true, 'the crossing call still 402s despite the finalize failure');
    assert.notEqual((await readJob(jobId)).status, 'budget_exceeded', 'the first finalize did not stick');
    const second = await hook.meter({ jobId, model: MODEL, usage }); // still over → RE-drives finalize
    assert.equal(second.exceeded, true);
    // COUNTER-PROOF: an edge trigger never retries → the job stays active forever.
    assert.equal(attempts, 2, 'markBudgetExceeded was re-attempted by the next over-budget call');
    assert.equal((await readJob(jobId)).status, 'budget_exceeded', 'the retry finalized the job');
  });

  it('budget resolution: job override wins over the repo budget', async () => {
    const { token } = await makeJob({ jobBudgetCostUsd: 0.5, repoBudgetCostUsd: 100, withHandle: true });
    upstream = () => usageResponse(200_000, 0); // $1.00 ≥ job $0.50, < repo $100
    const res = await post(token);
    assert.equal(res.status, 402, 'the job override ($0.50) is enforced, not the repo budget ($100)');
    assert.equal(((await res.json()) as { code: string }).code, 'dev.budget_exceeded');
  });

  it('budget resolution: repo budget is used when the job override is null', async () => {
    const { token } = await makeJob({ jobBudgetCostUsd: null, repoBudgetCostUsd: 0.5, withHandle: true });
    upstream = () => usageResponse(200_000, 0); // $1.00 ≥ repo $0.50
    const res = await post(token);
    assert.equal(res.status, 402, 'the repo budget is enforced when the job has none');
    assert.equal(((await res.json()) as { code: string }).code, 'dev.budget_exceeded');
  });

  it('budget resolution: config default ($5) applies when neither job nor repo sets a budget', async () => {
    const under = await makeJob({}); // both null → default $5
    upstream = () => usageResponse(200_000, 0); // $1.00 < $5
    const resUnder = await post(under.token);
    assert.equal(resUnder.status, 200, '$1 is under the $5 default');
    await resUnder.text();

    const over = await makeJob({ withHandle: true }); // both null → default $5
    upstream = () => usageResponse(1_200_000, 0); // $6.00 ≥ $5 default
    const resOver = await post(over.token);
    assert.equal(resOver.status, 402, 'the $5 default is enforced, not treated as unlimited');
    assert.equal(((await resOver.json()) as { code: string }).code, 'dev.budget_exceeded');
  });

  it('a token budget is enforced independently of the (unexceeded) cost budget', async () => {
    const { jobId, token } = await makeJob({ jobBudgetTokens: 150_000, withHandle: true });
    upstream = () => usageResponse(200_000, 0); // 200k tokens ≥ 150k; cost $1 < $5 default
    const res = await post(token);
    assert.equal(res.status, 402, 'crossing the token budget caps the job even under the cost budget');
    assert.equal((await readJob(jobId)).status, 'budget_exceeded');
  });

  it('accumulateJobUsage is race-safe: N concurrent writes never lose an update', async () => {
    const { jobId } = await makeJob({ jobBudgetCostUsd: 1000 });
    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, () => store.accumulateJobUsage(jobId, 10, 5, 0.01)),
    );
    for (const r of results) assert.ok(r, 'every concurrent accumulate returns a position');

    const job = await readJob(jobId);
    assert.equal(job.tokensIn, N * 10, 'no lost tokens_in update under concurrency');
    assert.equal(job.tokensOut, N * 5, 'no lost tokens_out update under concurrency');
    assert.ok(Math.abs(job.costUsd - N * 0.01) < 1e-9, 'no lost cost update under concurrency');
  });
});

/**
 * The `max_tokens` clamp lives on the proxy and is driven by the budget hook's
 * `maxOutputTokens` ceiling (spec §5 — bounds the single-request overshoot). It
 * needs no DB, so it runs unconditionally with an inline budget hook.
 */
describe('llmProxy — max_tokens clamp (budget hook ceiling)', () => {
  const CEILING = 500;
  let forwardedBody = '';
  let server: Server;
  let base = '';

  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    forwardedBody = init?.body instanceof Buffer ? init.body.toString('utf8') : String(init?.body ?? '');
    return usageResponse(1, 1);
  }) as unknown as typeof fetch;

  const proxyRouter = createLlmProxyRouter({
    resolveJobByToken: async () => ({ id: 'j1', status: 'running', agentKind: 'claude-cli' }),
    resolvePolicy: async () => ({
      provider: 'anthropic',
      upstreamBaseUrl: 'https://upstream.test',
      allowedModels: [MODEL],
    }),
    resolveProviderKey: async () => 'sk-ant-test-key',
    addJobUsage: async () => {},
    budget: { maxOutputTokens: CEILING, meter: async () => ({ exceeded: false }) },
    fetchImpl,
  });

  const app = express();
  app.use(
    '/api/v1/dev-runner',
    createDevRunnerRouter({
      store: runnerStore,
      repos: { getRepo: async () => null },
      scmTokens: { resolve: async () => undefined },
      finalizeDevJob: async () => null,
      llmProxyRouter: proxyRouter,
    } as unknown as DevRunnerRouterDeps),
  );

  before(async () => {
    await new Promise<void>((r) => {
      server = app.listen(0, () => {
        base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/v1/dev-runner`;
        r();
      });
    });
  });
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  function post(body: object): Promise<Response> {
    return fetch(`${base}/llm/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer djr_x' },
      body: JSON.stringify(body),
    });
  }

  it('clamps an over-ceiling max_tokens down to the ceiling', async () => {
    const res = await post({ ...OK_BODY, max_tokens: 100_000 });
    assert.equal(res.status, 200);
    await res.text();
    assert.equal((JSON.parse(forwardedBody) as { max_tokens: number }).max_tokens, CEILING);
  });

  it('sets max_tokens to the ceiling when the request omits it', async () => {
    const res = await post({ ...OK_BODY });
    assert.equal(res.status, 200);
    await res.text();
    assert.equal((JSON.parse(forwardedBody) as { max_tokens: number }).max_tokens, CEILING);
  });

  it('leaves an under-ceiling max_tokens unchanged', async () => {
    const res = await post({ ...OK_BODY, max_tokens: 128 });
    assert.equal(res.status, 200);
    await res.text();
    assert.equal((JSON.parse(forwardedBody) as { max_tokens: number }).max_tokens, 128);
  });
});
