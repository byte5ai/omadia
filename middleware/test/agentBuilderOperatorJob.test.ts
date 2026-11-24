/**
 * Spec 2042 §6 criterion 37 — "the Agent Builder and the Plugin Builder run
 * as operator jobs and appear nowhere as agents".
 *
 * The Agent Builder's one model-backed step is the verdict on a skill
 * (`POST /api/v1/operator/skills/:id/verdict/llm-scan`). Mounted the way the
 * kernel mounts it (`OPERATOR_JOB_ROUTES` ahead of the real router), its model
 * call is admitted under `enforce` as an operator job with the operator as
 * actor; without the job the gateway refuses the same call. No agent is
 * involved: the run is recorded as `operator_job`, never as an agent turn.
 */

import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it } from 'node:test';

import { admitModelCall } from '@omadia/llm-provider';
import type { AgentGraphStore, ConfigStore } from '@omadia/orchestrator';
import { resetModelGatewayForTests, setModelGatewayMode } from '@omadia/usage-telemetry';
import express from 'express';

import { PLUGIN_BUILDER_PREVIEW, PLUGIN_BUILDER_TURN, SKILL_VERIFICATION } from '../src/platform/modelWorkKinds.js';
import { createModelWorkRuns } from '../src/platform/modelWorkRuns.js';
import { OPERATOR_JOB_ROUTES } from '../src/platform/operatorJobRoutes.js';
import { createAgentBuilderRouter } from '../src/routes/agentBuilder.js';
import type { LlmVerifier } from '../src/services/skillVerdictLlmVerifier.js';

afterEach(() => resetModelGatewayForTests());

const SKILL_ID = '5f0c1a2b-0000-4000-8000-0000000051a1';

describe('criterion 37: the builders are operator jobs, not agents', () => {
  it('every model-backed route of the Agent Builder and the Plugin Builder is an operator job', () => {
    const kindOf = new Map(OPERATOR_JOB_ROUTES.map(([route, kind]) => [route, kind]));
    for (const route of [
      '/api/v1/operator/skills/:id/verdict/llm-scan',
      '/api/v1/operator/skills/import',
      '/api/v1/operator/skills',
      '/api/v1/operator/skills/:id/fork',
    ]) {
      assert.equal(kindOf.get(route), SKILL_VERIFICATION, route);
    }
    assert.equal(kindOf.get('/api/v1/builder/drafts/:id/turn'), PLUGIN_BUILDER_TURN);
    assert.equal(kindOf.get('/api/v1/builder/drafts/:id/preview/chat/turn'), PLUGIN_BUILDER_PREVIEW);
    assert.equal(kindOf.get('/api/v1/builder/drafts/:id/preview/tool-call'), PLUGIN_BUILDER_PREVIEW);
    for (const [, kind] of OPERATOR_JOB_ROUTES) {
      assert.equal(kind.context, 'operator_job');
      assert.ok(kind.budgetCalls > 0 && kind.deadlineMs > 0, `${kind.kind} has a budget and a deadline`);
    }
  });

  async function serve(withJobs: boolean) {
    const runs = createModelWorkRuns({ operatorDailyCalls: 100, maintenanceDailyCalls: 100 });
    const calls: string[] = [];
    const verifier: LlmVerifier = {
      modelId: 'claude-haiku-4-5',
      promptHash: 'p1',
      verify: async () => {
        admitModelCall('complete');
        calls.push('complete');
        return { severity: 'no_signals', rationale: 'nothing found' };
      },
    };
    const graph = {
      getSkill: async (id: string) => (id === SKILL_ID ? { id, contentHash: `h-${String(withJobs)}`, frontmatter: { name: 'x' }, body: 'Do x.' } : undefined),
      getSkillVerdictByModel: async () => undefined,
      upsertSkillVerdict: async () => undefined,
    } as unknown as AgentGraphStore;
    const app = express();
    app.use(express.json());
    if (withJobs) {
      for (const [route, kind] of OPERATOR_JOB_ROUTES) {
        app.post(route, (req, _res, next) => {
          (req as { session?: unknown }).session = { email: 'op@example.test' };
          next();
        }, runs.middleware(kind));
      }
    }
    app.use(
      '/api/v1/operator',
      createAgentBuilderRouter({
        getConfigStore: () => ({}) as ConfigStore,
        getGraphStore: () => graph,
        getRegistry: () => undefined,
        getLlmVerifier: async () => verifier,
      }),
    );
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    return {
      runs,
      calls,
      scan: () => fetch(`${base}/api/v1/operator/skills/${SKILL_ID}/verdict/llm-scan`, { method: 'POST' }),
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it("the Agent Builder's skill verdict runs as an operator job under enforce; outside the job the gateway refuses it", async () => {
    setModelGatewayMode('enforce');
    const mounted = await serve(true);
    try {
      const res = await mounted.scan();
      assert.equal(res.status, 200, await res.clone().text());
      assert.ok(res.headers.get('x-omadia-operator-job'), 'named as an operator job');
      assert.deepEqual(mounted.calls, ['complete']);
      // The run is recorded as finished once the response went out.
      let run = (await mounted.runs.list())[0];
      for (let i = 0; i < 50 && run?.status === 'running'; i += 1) {
        await new Promise((r) => setTimeout(r, 20));
        run = (await mounted.runs.list())[0];
      }
      assert.equal(run?.jobKind, "skill_verification", JSON.stringify(run));
      assert.equal(run?.contextKind, 'operator_job', 'no agent turn');
      assert.equal(run?.status, 'succeeded');
      assert.equal(run?.startedBy, 'op@example.test', 'the operator is its actor');
    } finally {
      await mounted.close();
    }

    const bare = await serve(false);
    try {
      // The verifier stores the refusal as a failed scan; the model is not called.
      const res = await bare.scan();
      const body = (await res.json()) as { llm?: { severity?: string } };
      assert.notEqual(body.llm?.severity, 'no_signals', 'no verdict without the job');
      assert.deepEqual(bare.calls, [], 'the gateway refused the call: no context');
    } finally {
      await bare.close();
    }
  });
});
