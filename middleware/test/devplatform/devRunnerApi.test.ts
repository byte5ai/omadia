import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

import { RUNNER_PROTOCOL_VERSION } from '../../src/devplatform/types.js';
import {
  CLONE_TOKEN,
  FIXED_NOW,
  VALID,
  auth,
  hasCredentialKey,
  makeHarness,
  makeJob,
  type Harness,
} from './devRunnerApi.harness.js';

/**
 * Epic #470 W0 — phone-home router contract: the job-token auth gate (no
 * `requireAuth`), the 401/409/410 status contract, and the six endpoints.
 * Regression-guards the reviewed spec bug: `GET /spec` must carry NO credential.
 * Adversarial cases live in devRunnerApi.hostile.test.ts. No DB.
 */

describe('devRunnerApi — auth gate', () => {
  let h: Harness;
  afterEach(async () => {
    if (h) await h.close();
  });

  it('401 with no bearer', async () => {
    h = await makeHarness();
    h.store.add(makeJob());
    const res = await fetch(`${h.baseUrl}/jobs/job-1/spec`);
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { code: string }).code, 'devplatform.unauthorized');
  });

  it('401 with a wrong bearer', async () => {
    h = await makeHarness();
    h.store.add(makeJob());
    const res = await fetch(`${h.baseUrl}/jobs/job-1/spec`, { headers: auth('djr_wrong') });
    assert.equal(res.status, 401);
  });

  it('401 for an unknown job (no oracle)', async () => {
    h = await makeHarness();
    const res = await fetch(`${h.baseUrl}/jobs/nope/spec`, { headers: auth() });
    assert.equal(res.status, 401);
  });

  it('410 on a terminal job', async () => {
    h = await makeHarness();
    h.store.add(makeJob({ status: 'done' }));
    const res = await fetch(`${h.baseUrl}/jobs/job-1/spec`, { headers: auth() });
    assert.equal(res.status, 410);
    assert.equal(((await res.json()) as { code: string }).code, 'devplatform.job_terminal');
  });
});

describe('devRunnerApi — GET /spec', () => {
  let h: Harness;
  afterEach(async () => {
    if (h) await h.close();
  });

  it('carries protocol, no credential field, and flips provisioning→running', async () => {
    h = await makeHarness();
    h.store.add(makeJob({ status: 'provisioning' }));
    const res = await fetch(`${h.baseUrl}/jobs/job-1/spec`, { headers: auth() });
    assert.equal(res.status, 200);
    const raw = await res.text();
    // Regression: the reviewed bug leaked the clone credential into the spec.
    assert.ok(!raw.includes(CLONE_TOKEN), 'spec must not contain the clone token');
    const spec = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(spec['protocol'], RUNNER_PROTOCOL_VERSION);
    assert.equal(hasCredentialKey(spec), false, 'spec carries no credential-like key');
    assert.deepEqual(spec['repo'], {
      cloneUrl: 'https://github.com/o/r.git',
      defaultBranch: 'main',
      baseSha: 'base0000000000000000000000000000000000sha',
    });
    // local backend → no exec capabilities.
    assert.deepEqual(spec['capabilities'], { installDeps: false, runTests: false });
    // Status flip happened.
    assert.equal(h.store.jobs.get('job-1')?.status, 'running');
    assert.deepEqual(h.store.markRunningCalls, ['job-1']);
  });

  it('is idempotent when already running', async () => {
    h = await makeHarness();
    h.store.add(makeJob({ status: 'running' }));
    const res = await fetch(`${h.baseUrl}/jobs/job-1/spec`, { headers: auth() });
    assert.equal(res.status, 200);
  });
});

describe('devRunnerApi — GET /scm-token', () => {
  let h: Harness;
  afterEach(async () => {
    if (h) await h.close();
  });

  it('returns the read-only clone credential and an ≤15min expiry, one-shot per provision', async () => {
    h = await makeHarness();
    h.store.add(makeJob({ status: 'running' }));
    const res = await fetch(`${h.baseUrl}/jobs/job-1/scm-token`, { headers: auth() });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { token: string; expiresAt: string };
    assert.equal(body.token, CLONE_TOKEN, 'token is the repo credential the source resolved');
    assert.equal(body.expiresAt, new Date(FIXED_NOW + 15 * 60 * 1000).toISOString());
    // Second call in the same provision → 409.
    const again = await fetch(`${h.baseUrl}/jobs/job-1/scm-token`, { headers: auth() });
    assert.equal(again.status, 409);
    assert.equal(((await again.json()) as { code: string }).code, 'devplatform.scm_token_already_issued');
  });

  it('re-issues for the same job under a new provision', async () => {
    h = await makeHarness();
    const job = h.store.add(makeJob({ status: 'running', provision: 1 }));
    assert.equal((await fetch(`${h.baseUrl}/jobs/job-1/scm-token`, { headers: auth() })).status, 200);
    job.provision = 2; // a gated pipeline (W2) bumps the provision
    const res = await fetch(`${h.baseUrl}/jobs/job-1/scm-token`, { headers: auth() });
    assert.equal(res.status, 200);
  });

  it('500 (no secret) when no credential is stored', async () => {
    h = await makeHarness();
    h.cloneToken.value = undefined;
    h.store.add(makeJob({ status: 'running' }));
    const res = await fetch(`${h.baseUrl}/jobs/job-1/scm-token`, { headers: auth() });
    assert.equal(res.status, 500);
    const body = await res.text();
    assert.ok(!body.includes(CLONE_TOKEN));
  });
});

describe('devRunnerApi — POST /events', () => {
  let h: Harness;
  afterEach(async () => {
    if (h) await h.close();
  });

  async function postEvents(
    h: Harness,
    provision: number,
    events: Array<{ seq: number; type: string }>,
  ): Promise<{ status: number; accepted?: number }> {
    const res = await fetch(`${h.baseUrl}/jobs/job-1/events`, {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ provision, events }),
    });
    const json = res.ok ? ((await res.json()) as { accepted: number }) : undefined;
    return { status: res.status, accepted: json?.accepted };
  }

  it('is idempotent per (job, provision, seq) and accepts a colliding seq under a new provision', async () => {
    h = await makeHarness();
    h.store.add(makeJob({ status: 'running' }));
    const first = await postEvents(h, 1, [
      { seq: 0, type: 'log' },
      { seq: 1, type: 'tool' },
    ]);
    assert.deepEqual(first, { status: 200, accepted: 2 });
    // Same batch again → all conflict → 0.
    const retry = await postEvents(h, 1, [
      { seq: 0, type: 'log' },
      { seq: 1, type: 'tool' },
    ]);
    assert.equal(retry.accepted, 0);

    // A colliding seq is accepted under a NEW provision — but only after a real
    // re-provision bumps the job's own provision. The client does not get to
    // choose: see the mismatch test below, without which the same seq could be
    // replayed forever under invented provision numbers and idempotency would
    // hold for cooperative clients only.
    h.store.setProvision('job-1', 2);
    const p2 = await postEvents(h, 2, [{ seq: 0, type: 'log' }]);
    assert.equal(p2.accepted, 1);
  });

  it('409 when the client picks a provision that is not the job\'s (replay-dedupe bypass)', async () => {
    h = await makeHarness();
    h.store.add(makeJob({ status: 'running' })); // provision = 1
    const spoofed = await postEvents(h, 999, [{ seq: 0, type: 'log' }]);
    assert.equal(spoofed.status, 409);
    assert.equal(h.store.events.length, 0);
  });

  it('400 on an invalid event type', async () => {
    h = await makeHarness();
    h.store.add(makeJob({ status: 'running' }));
    const res = await postEvents(h, 1, [{ seq: 0, type: 'nope' }]);
    assert.equal(res.status, 400);
  });

  it('410 on a terminal job', async () => {
    h = await makeHarness();
    h.store.add(makeJob({ status: 'failed' }));
    const res = await postEvents(h, 1, [{ seq: 0, type: 'log' }]);
    assert.equal(res.status, 410);
  });
});

describe('devRunnerApi — POST /heartbeat', () => {
  let h: Harness;
  afterEach(async () => {
    if (h) await h.close();
  });

  async function beat(h: Harness): Promise<{ status: number; body: { ok?: boolean; cancelRequested?: boolean } }> {
    const res = await fetch(`${h.baseUrl}/jobs/job-1/heartbeat`, {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: '{}',
    });
    return { status: res.status, body: res.ok ? ((await res.json()) as { ok: boolean; cancelRequested: boolean }) : {} };
  }

  it('bumps liveness and reports no cancel on a live job', async () => {
    h = await makeHarness();
    h.store.add(makeJob({ status: 'running' }));
    const res = await beat(h);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, cancelRequested: false });
    // appendEvents returns early on an empty batch, so without a standalone
    // touch an agent that thinks without emitting a tool call would be reaped by
    // findStalled while perfectly healthy. touchHeartbeat is required on the
    // injected store interface precisely so wiring cannot omit it.
    assert.deepEqual(h.store.touchCalls, ['job-1']);
  });

  it('signals cancelRequested on a cancelled job (cooperative stop)', async () => {
    h = await makeHarness();
    h.store.add(makeJob({ status: 'cancelled' }));
    const res = await beat(h);
    assert.equal(res.status, 200);
    assert.equal(res.body.cancelRequested, true);
  });

  it('410 on any other terminal status', async () => {
    h = await makeHarness();
    h.store.add(makeJob({ status: 'done' }));
    const res = await beat(h);
    assert.equal(res.status, 410);
  });
});

describe('devRunnerApi — POST /diff', () => {
  let h: Harness;
  afterEach(async () => {
    if (h) await h.close();
  });

  async function postDiff(h: Harness, body: string): Promise<{ status: number; artifactId?: string }> {
    const res = await fetch(`${h.baseUrl}/jobs/job-1/diff`, {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'text/plain' },
      body,
    });
    const json = res.ok ? ((await res.json()) as { artifactId: string }) : undefined;
    return { status: res.status, artifactId: json?.artifactId };
  }

  it('stores the diff as a `diff` artifact', async () => {
    h = await makeHarness();
    h.store.add(makeJob({ status: 'running' }));
    const res = await postDiff(h, 'diff --git a b\n@@\n+x\n');
    assert.equal(res.status, 200);
    assert.ok(res.artifactId);
    assert.equal(h.store.artifacts[0]?.kind, 'diff');
  });

  it('rejects a body over the size cap with 413', async () => {
    h = await makeHarness({ maxDiffBytes: 32 });
    h.store.add(makeJob({ status: 'running' }));
    const res = await postDiff(h, 'x'.repeat(64));
    assert.equal(res.status, 413);
  });
});

describe('devRunnerApi — POST /result', () => {
  let h: Harness;
  afterEach(async () => {
    if (h) await h.close();
  });

  async function postResult(
    h: Harness,
    body: Record<string, unknown>,
  ): Promise<{ status: number }> {
    const res = await fetch(`${h.baseUrl}/jobs/job-1/result`, {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status };
  }

  it('diff_ready flips the job to applying via the store, not finalize', async () => {
    h = await makeHarness();
    h.store.add(makeJob({ status: 'running' }));
    // The artifact must exist and belong to this job. The earlier version of
    // this test invented an id, which the ownership check now rejects.
    const own = await h.store.addArtifact('job-1', 'diff', 'diff --git a/x b/x\n');
    const res = await postResult(h, { outcome: 'diff_ready', diffArtifactId: own });
    assert.equal(res.status, 200);
    assert.equal(h.store.jobs.get('job-1')?.status, 'applying');
    assert.equal(h.store.recorded[0]?.outcome, 'diff_ready');
    assert.equal(h.finalizeCalls.length, 0, 'diff_ready must not touch the terminal choke point');
  });

  it('failed goes terminal through the finalizeDevJob choke point', async () => {
    h = await makeHarness();
    h.store.add(makeJob({ status: 'running' }));
    const res = await postResult(h, { outcome: 'failed', error: 'boom', usage: { tokensIn: 10 } });
    assert.equal(res.status, 200);
    assert.equal(h.finalizeCalls.length, 1);
    assert.equal(h.finalizeCalls[0]?.status, 'failed');
    assert.equal(h.finalizeCalls[0]?.ctx?.error, 'boom');
    assert.equal(h.store.jobs.get('job-1')?.status, 'failed');
    // usage/result was persisted through recordResult (non-terminal flip).
    assert.equal(h.store.recorded[0]?.usage?.tokensIn, 10);
  });

  it('no_changes finalizes as done through the choke point', async () => {
    h = await makeHarness();
    h.store.add(makeJob({ status: 'running' }));
    const res = await postResult(h, { outcome: 'no_changes' });
    assert.equal(res.status, 200);
    assert.equal(h.finalizeCalls[0]?.status, 'done');
  });

  it('400 on an unknown outcome', async () => {
    h = await makeHarness();
    h.store.add(makeJob({ status: 'running' }));
    const res = await postResult(h, { outcome: 'weird' });
    assert.equal(res.status, 400);
  });
});
