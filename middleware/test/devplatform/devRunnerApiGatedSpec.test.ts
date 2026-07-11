import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';

import { auth, makeHarness, makeJob, VALID } from './devRunnerApi.harness.js';
import { deriveJobPolicy } from '../../src/devplatform/deriveJobPolicy.js';
import type { DevJobSpec } from '../../src/devplatform/types.js';

/**
 * Forge W2 BLOCKER: a gated job's /spec was returning the W0-shaped spec (no
 * pipelineMode / phaseContext / bootstrap), so the shim silently ran the
 * single-shot path and the entire gate/plan flow was dark in production. The
 * green tests missed it because they drove the shim's gated path directly and
 * never asserted the MIDDLEWARE EMITS the gated wire. This is that assertion.
 */
describe('devRunnerApi — GET /spec emits the gated wire (Forge W2 blocker)', () => {
  async function specFor(job: ReturnType<typeof makeJob>, bootstrap: string | null = null) {
    const h = await makeHarness();
    after(() => h.close());
    h.repoBootstrap.value = bootstrap;
    h.store.add(job, VALID);
    const res = await fetch(`${h.baseUrl}/jobs/${job.id}/spec`, { headers: auth() });
    assert.equal(res.status, 200);
    return { spec: (await res.json()) as DevJobSpec, h };
  }

  it('a gated job at analyze gets pipelineMode=gated + phaseContext.phase, and bootstrap when set', async () => {
    const { spec } = await specFor(
      makeJob({ id: 'g1', pipelineMode: 'gated', phase: 'analyze', status: 'running' }),
      'npm ci',
    );
    assert.equal(spec.pipelineMode, 'gated', 'without this the shim collapses');
    assert.equal(spec.phaseContext?.phase, 'analyze');
    assert.deepEqual(spec.bootstrap, { command: 'npm ci' });
  });

  it('a gated job at implement (provision B) carries the approved plan + answers + attempt', async () => {
    const job = makeJob({ id: 'g2', pipelineMode: 'gated', phase: 'implement', status: 'running', reviewAttempt: 1 });
    const h = await makeHarness();
    after(() => h.close());
    h.store.add(job, VALID);
    // Provision-A artifacts living server-side.
    await h.store.addArtifact(job.id, 'plan', 'THE APPROVED PLAN');
    await h.store.addArtifact(job.id, 'answers', JSON.stringify([{ questionId: 'q1', text: 'yes' }]));
    await h.store.addArtifact(
      job.id,
      'review_verdict',
      JSON.stringify({ verdict: 'request_changes', findings: [{ severity: 'blocker', file: 'a.ts', issue: 'boom' }] }),
    );

    const res = await fetch(`${h.baseUrl}/jobs/${job.id}/spec`, { headers: auth() });
    const spec = (await res.json()) as DevJobSpec;
    assert.equal(spec.phaseContext?.plan, 'THE APPROVED PLAN', 'the runner implements the plan the human approved');
    assert.deepEqual(spec.phaseContext?.answers, [{ questionId: 'q1', text: 'yes' }]);
    assert.equal(spec.phaseContext?.attempt, 1);
    assert.equal(spec.phaseContext?.priorFindings?.[0]?.issue, 'boom', 'retry replays the prior findings');
  });

  it('a collapsed job gets pipelineMode=collapsed and NO phaseContext', async () => {
    const { spec } = await specFor(makeJob({ id: 'g3', pipelineMode: 'collapsed', phase: 'implement', status: 'running' }));
    assert.equal(spec.pipelineMode, 'collapsed');
    assert.equal(spec.phaseContext, undefined);
    assert.equal(spec.bootstrap, undefined);
  });
});

describe('deriveJobPolicy — the runner env carries OMADIA_PIPELINE_MODE (shim dispatch)', () => {
  const config = {
    middlewareHost: 'mw.internal',
    baseAllowlist: [],
    image: 'ghcr.io/x/y@sha256:abc',
    llmProxyBaseUrl: 'http://mw.internal/api/v1/dev-runner/llm',
  };
  const repo = { cloneUrl: 'https://github.com/o/r.git', egressAllowlist: [] };

  it('injects gated for a gated job — without it the shim runs W0 single-shot', () => {
    const policy = deriveJobPolicy(repo, { authMode: 'api_key', pipelineMode: 'gated' }, config);
    assert.equal(policy.env['OMADIA_PIPELINE_MODE'], 'gated');
  });

  it('injects collapsed for a collapsed job', () => {
    const policy = deriveJobPolicy(repo, { authMode: 'api_key', pipelineMode: 'collapsed' }, config);
    assert.equal(policy.env['OMADIA_PIPELINE_MODE'], 'collapsed');
  });
});
