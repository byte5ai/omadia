/**
 * Epic #470 W1 — runner daemon scaffold + control-plane API tests.
 *
 * These drive the REAL `createDaemon` server over a REAL socket (review lesson
 * (c): a component tested only through a hand-built stub is not the component
 * that ships). The container engine and the policy client are the only fakes —
 * exactly the two seams the later W1 units (clamp, warmer, reaper) fill.
 *
 * What is proven here:
 *   - bearer auth on EVERY route, `/v1/health` included; token rotation via a
 *     comma-separated list; boot refuses a short/empty token;
 *   - `POST /v1/jobs` accepts exactly { protocol, jobId, leaseTtlSec }, rejects
 *     smuggled env/image/egressAllowlist, and is idempotent on jobId;
 *   - the daemon fetches the policy ITSELF and hands the engine the
 *     server-derived policy, never anything from the caller (S3);
 *   - the full route set: create/delete/lease/list/logs/health/warm;
 *   - the server refuses a wildcard bind.
 */

import { strict as assert } from 'node:assert';
import { Readable } from 'node:stream';
import { afterEach, describe, it } from 'node:test';

import { DaemonAuthConfigError, parseDaemonTokens } from '../src/auth.mjs';
import { assertControlPlaneBind, createDaemon } from '../src/daemon.mjs';
import { JobManager } from '../src/jobs.mjs';

const TOKEN = 'test-daemon-token-000000000000000000';
const OTHER_TOKEN = 'rotated-daemon-token-11111111111111111';
const JOB_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID_2 = '22222222-2222-4222-8222-222222222222';

/** A policy as the middleware's job-policy endpoint returns it. */
function samplePolicy(jobId = JOB_ID) {
  return {
    jobId,
    image: 'ghcr.io/byte5ai/omadia-dev-runner@sha256:abc',
    env: { ANTHROPIC_BASE_URL: 'http://middleware:8080/api/v1/dev-runner/llm' },
    egressAllowlist: ['github.com', 'registry.npmjs.org'],
  };
}

/** A container engine fake recording every call; the seam the clamp unit fills. */
function fakeEngine(overrides = {}) {
  const calls = { create: [], destroy: [], warm: 0, ping: 0, logs: [] };
  let seq = 0;
  return {
    calls,
    async ping() {
      calls.ping += 1;
      return { reachable: true, apiVersion: '1.47' };
    },
    async createJobContainer(args) {
      calls.create.push(args);
      seq += 1;
      return {
        containerId: `container-${seq}`,
        networkId: `net-${seq}`,
        volumeName: `vol-${seq}`,
        imageDigest: args.policy.image,
      };
    },
    async destroyJobContainer(container) {
      calls.destroy.push(container);
    },
    async streamLogs() {
      calls.logs.push(true);
      return Readable.from(['log-line-1\n', 'log-line-2\n']);
    },
    async warmImages() {
      calls.warm += 1;
      return ['ghcr.io/byte5ai/omadia-dev-runner@sha256:abc'];
    },
    ...overrides,
  };
}

/** A policy client fake recording lookups; returns a configurable policy. */
function fakePolicyClient(policy = samplePolicy(), onFetch) {
  const calls = [];
  return {
    calls,
    async fetchJobPolicy(jobId) {
      calls.push(jobId);
      if (onFetch) return onFetch(jobId);
      return { ...policy, jobId };
    },
  };
}

/** Boot a real daemon on an ephemeral port; returns handles + a closer. */
async function startDaemon(opts = {}) {
  const engine = opts.engine ?? fakeEngine();
  const policyClient = opts.policyClient ?? fakePolicyClient();
  const jobManager = opts.jobManager ?? new JobManager({ engine, policyClient });
  const server = createDaemon({
    tokens: opts.tokens ?? [TOKEN],
    policyClient,
    jobManager,
    engine,
    warmImageRefs: opts.warmImageRefs ?? ['ghcr.io/byte5ai/omadia-dev-runner:latest'],
    maxLogFollows: opts.maxLogFollows,
    logger: { warn() {} },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const addr = server.address();
  const url = `http://127.0.0.1:${addr.port}`;
  return {
    url,
    server,
    engine,
    policyClient,
    jobManager,
    async close() {
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}

/** Authed fetch helper. */
function call(url, path, { method = 'GET', token = TOKEN, body } = {}) {
  const headers = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${url}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** A valid create body. */
function createBody(jobId = JOB_ID, leaseTtlSec = 180) {
  return { protocol: 1, jobId, leaseTtlSec };
}

/** Poll `pred` until true or timeout. */
async function waitFor(pred, ms = 3000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ---------------------------------------------------------------------------

describe('dev-runner-daemon — boot-time token config', () => {
  it('refuses an unset token', () => {
    assert.throws(() => parseDaemonTokens(undefined), DaemonAuthConfigError);
    assert.throws(() => parseDaemonTokens(''), DaemonAuthConfigError);
  });

  it('refuses a token shorter than 32 chars', () => {
    assert.throws(() => parseDaemonTokens('short'), DaemonAuthConfigError);
    assert.throws(() => parseDaemonTokens('x'.repeat(31)), DaemonAuthConfigError);
  });

  it('accepts a >=32-char token and a comma-separated rotation list', () => {
    assert.deepEqual(parseDaemonTokens(TOKEN), [TOKEN]);
    assert.deepEqual(parseDaemonTokens(`${TOKEN},${OTHER_TOKEN}`), [TOKEN, OTHER_TOKEN]);
    // A trailing comma / whitespace is tolerated, empties dropped.
    assert.deepEqual(parseDaemonTokens(`${TOKEN}, ${OTHER_TOKEN} ,`), [TOKEN, OTHER_TOKEN]);
  });
});

describe('dev-runner-daemon — bind guard', () => {
  it('refuses a wildcard/empty bind so nothing listens toward dev-engine', () => {
    for (const bad of [
      '0.0.0.0',
      '::',
      '',
      '*',
      // node binds every one of these to the wildcard too, so a literal-spelling
      // list is not a guard — the bind is canonicalised before comparison.
      '0',
      '000.000.000.000',
      '::0',
      '0:0:0:0:0:0:0:0',
    ]) {
      assert.throws(() => assertControlPlaneBind(bad), /wildcard|refusing/i, `should refuse ${JSON.stringify(bad)}`);
    }
  });
  it('accepts a concrete control-plane address', () => {
    assert.equal(assertControlPlaneBind('127.0.0.1'), '127.0.0.1');
    assert.equal(assertControlPlaneBind('172.28.1.4'), '172.28.1.4');
    assert.equal(assertControlPlaneBind('::1'), '::1');
  });
});

describe('dev-runner-daemon — bearer auth on every route', () => {
  let d;
  afterEach(async () => d && d.close());

  it('rejects a missing token on /v1/health (health is gated too)', async () => {
    d = await startDaemon();
    const res = await call(d.url, '/v1/health', { token: null });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).code, 'daemon.unauthorized');
  });

  it('rejects a wrong token on a mutating route', async () => {
    d = await startDaemon();
    const res = await call(d.url, '/v1/jobs', { method: 'POST', token: 'wrong', body: createBody() });
    assert.equal(res.status, 401);
  });

  it('accepts EITHER token from a rotation list', async () => {
    d = await startDaemon({ tokens: [TOKEN, OTHER_TOKEN] });
    for (const token of [TOKEN, OTHER_TOKEN]) {
      const res = await call(d.url, '/v1/health', { token });
      assert.equal(res.status, 200, `token ${token} should authenticate`);
    }
  });
});

describe('dev-runner-daemon — POST /v1/jobs', () => {
  let d;
  afterEach(async () => d && d.close());

  it('creates a job and returns the container handle', async () => {
    d = await startDaemon();
    const res = await call(d.url, '/v1/jobs', { method: 'POST', body: createBody() });
    assert.equal(res.status, 201);
    const json = await res.json();
    assert.equal(json.containerId, 'container-1');
    assert.equal(json.networkId, 'net-1');
    assert.equal(json.volumeName, 'vol-1');
    assert.ok(typeof json.leaseExpiresAt === 'string');
    assert.ok(json.imageDigest.includes('sha256'));
    assert.equal(d.engine.calls.create.length, 1);
  });

  it('fetches the policy ITSELF and hands the engine the server-derived policy (S3)', async () => {
    const engine = fakeEngine();
    const policyClient = fakePolicyClient(samplePolicy());
    d = await startDaemon({ engine, policyClient });
    await call(d.url, '/v1/jobs', { method: 'POST', body: createBody() });
    // The daemon looked the policy up by jobId.
    assert.deepEqual(policyClient.calls, [JOB_ID]);
    // The engine received exactly that server-derived policy.
    const arg = engine.calls.create[0];
    assert.equal(arg.jobId, JOB_ID);
    assert.deepEqual(arg.policy.egressAllowlist, ['github.com', 'registry.npmjs.org']);
    assert.equal(arg.policy.env.ANTHROPIC_BASE_URL, 'http://middleware:8080/api/v1/dev-runner/llm');
  });

  it('is idempotent on jobId — a second create returns the existing job, no second container', async () => {
    d = await startDaemon();
    const first = await call(d.url, '/v1/jobs', { method: 'POST', body: createBody() });
    const second = await call(d.url, '/v1/jobs', { method: 'POST', body: createBody() });
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    const a = await first.json();
    const b = await second.json();
    assert.equal(a.containerId, b.containerId);
    // Exactly one container ever created, and the policy fetched once for it.
    assert.equal(d.engine.calls.create.length, 1);
    assert.equal(d.policyClient.calls.length, 1);
  });

  it('de-duplicates two CONCURRENT creates into one container', async () => {
    d = await startDaemon();
    const [r1, r2] = await Promise.all([
      call(d.url, '/v1/jobs', { method: 'POST', body: createBody() }),
      call(d.url, '/v1/jobs', { method: 'POST', body: createBody() }),
    ]);
    assert.ok([r1.status, r2.status].every((s) => s === 200 || s === 201));
    assert.equal(d.engine.calls.create.length, 1);
  });

  it('rejects a body smuggling env / image / egressAllowlist / limits (schema clamp)', async () => {
    d = await startDaemon();
    for (const extra of [
      { env: { SECRET: 'x' } },
      { image: 'ghcr.io/evil:latest' },
      { egressAllowlist: ['evil.example'] },
      { limits: { memory: '64g' } },
    ]) {
      const res = await call(d.url, '/v1/jobs', {
        method: 'POST',
        body: { ...createBody(), ...extra },
      });
      assert.equal(res.status, 400, `smuggled ${Object.keys(extra)[0]} must be rejected`);
    }
    // No container was ever created from a rejected body.
    assert.equal(d.engine.calls.create.length, 0);
  });

  it('rejects a non-UUID jobId at the wire', async () => {
    d = await startDaemon();
    const res = await call(d.url, '/v1/jobs', {
      method: 'POST',
      body: { protocol: 1, jobId: '../../etc/passwd', leaseTtlSec: 180 },
    });
    assert.equal(res.status, 400);
    assert.equal(d.engine.calls.create.length, 0);
  });

  it('rejects a mismatched protocol version', async () => {
    d = await startDaemon();
    const res = await call(d.url, '/v1/jobs', {
      method: 'POST',
      body: { protocol: 2, jobId: JOB_ID, leaseTtlSec: 180 },
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'daemon.protocol_mismatch');
  });

  it('surfaces a middleware "job not found" as 404', async () => {
    const policyClient = {
      calls: [],
      async fetchJobPolicy(jobId) {
        this.calls.push(jobId);
        const { PolicyLookupError } = await import('../src/policyClient.mjs');
        throw new PolicyLookupError(404, 'devplatform.job_not_found', 'no such job');
      },
    };
    d = await startDaemon({ policyClient });
    const res = await call(d.url, '/v1/jobs', { method: 'POST', body: createBody() });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).code, 'daemon.job_not_found');
  });
});

describe('dev-runner-daemon — job lifecycle routes', () => {
  let d;
  afterEach(async () => d && d.close());

  async function create(jobId = JOB_ID) {
    return call(d.url, '/v1/jobs', { method: 'POST', body: createBody(jobId) });
  }

  it('GET /v1/jobs lists live jobs (the reap() join source)', async () => {
    d = await startDaemon();
    await create(JOB_ID);
    await create(JOB_ID_2);
    const res = await call(d.url, '/v1/jobs');
    assert.equal(res.status, 200);
    const { jobs } = await res.json();
    assert.deepEqual(jobs.map((j) => j.jobId).sort(), [JOB_ID, JOB_ID_2].sort());
    assert.ok(jobs.every((j) => j.containerId && j.networkId && j.volumeName && j.imageDigest));
  });

  it('POST /v1/jobs/:id/lease renews and returns a fresh expiry', async () => {
    d = await startDaemon();
    await create();
    const res = await call(d.url, `/v1/jobs/${JOB_ID}/lease`, {
      method: 'POST',
      body: { protocol: 1, leaseTtlSec: 300 },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.jobId, JOB_ID);
    assert.ok(typeof json.leaseExpiresAt === 'string');
  });

  it('lease renew on an unknown job is 404', async () => {
    d = await startDaemon();
    const res = await call(d.url, `/v1/jobs/${JOB_ID}/lease`, {
      method: 'POST',
      body: { protocol: 1, leaseTtlSec: 300 },
    });
    assert.equal(res.status, 404);
  });

  it('DELETE /v1/jobs/:id kills + cleans, and is idempotent', async () => {
    d = await startDaemon();
    await create();
    const first = await call(d.url, `/v1/jobs/${JOB_ID}`, { method: 'DELETE' });
    assert.equal(first.status, 200);
    assert.equal(d.engine.calls.destroy.length, 1);
    // Second delete of the now-absent job still succeeds (idempotent).
    const second = await call(d.url, `/v1/jobs/${JOB_ID}`, { method: 'DELETE' });
    assert.equal(second.status, 200);
    // No extra destroy for the absent job.
    assert.equal(d.engine.calls.destroy.length, 1);
    // The job is gone from the list.
    assert.equal((await (await call(d.url, '/v1/jobs')).json()).jobs.length, 0);
  });

  it('GET /v1/jobs/:id/logs streams container output', async () => {
    d = await startDaemon();
    await create();
    const res = await call(d.url, `/v1/jobs/${JOB_ID}/logs?follow=1`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /log-line-1/);
    assert.match(text, /log-line-2/);
    assert.equal(d.engine.calls.logs.length, 1);
  });

  it('logs for an unknown job is 404', async () => {
    d = await startDaemon();
    const res = await call(d.url, `/v1/jobs/${JOB_ID}/logs`);
    assert.equal(res.status, 404);
  });

  it('a non-UUID id on a per-job route is rejected', async () => {
    d = await startDaemon();
    const res = await call(d.url, '/v1/jobs/not-a-uuid', { method: 'DELETE' });
    assert.equal(res.status, 400);
  });
});

describe('dev-runner-daemon — health + warm', () => {
  let d;
  afterEach(async () => d && d.close());

  it('GET /v1/health reports dind reachability, version, and live count', async () => {
    d = await startDaemon();
    await call(d.url, '/v1/jobs', { method: 'POST', body: createBody() });
    const res = await call(d.url, '/v1/health');
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(json.dindReachable, true);
    assert.equal(json.engineApiVersion, '1.47');
    assert.equal(json.liveJobs, 1);
    assert.equal(json.imageWarm, false);
    assert.deepEqual(json.warmedDigests, []);
  });

  it('POST /v1/warm pulls images and health then reflects warmed digests', async () => {
    d = await startDaemon();
    const warm = await call(d.url, '/v1/warm', { method: 'POST' });
    assert.equal(warm.status, 200);
    assert.equal((await warm.json()).imageWarm, true);
    assert.equal(d.engine.calls.warm, 1);
    const health = await (await call(d.url, '/v1/health')).json();
    assert.equal(health.imageWarm, true);
    assert.equal(health.warmedDigests.length, 1);
  });

  it('an engine seam not yet implemented surfaces as 501, not a wrong answer', async () => {
    // Prove EngineNotImplementedError maps cleanly (the clamp unit replaces it).
    const engine = {
      async ping() {
        return { reachable: true, apiVersion: '1.47' };
      },
      async createJobContainer() {
        const { EngineNotImplementedError } = await import('../src/jobs.mjs');
        throw new EngineNotImplementedError('createJobContainer');
      },
      async destroyJobContainer() {},
      async streamLogs() {
        return Readable.from(['x']);
      },
      async warmImages() {
        return [];
      },
    };
    d = await startDaemon({ engine });
    const res = await call(d.url, '/v1/jobs', { method: 'POST', body: createBody() });
    assert.equal(res.status, 501);
    assert.equal((await res.json()).code, 'daemon.engine_not_implemented');
  });
});

describe('dev-runner-daemon — admission bound on POST /v1/jobs', () => {
  let d;
  afterEach(async () => d && d.close());

  it('429s a NEW job past the live-job cap, and still allows the idempotent re-attach', async () => {
    const engine = fakeEngine();
    const jobManager = new JobManager({ engine, policyClient: fakePolicyClient(), maxLiveJobs: 1, maxInflight: 1 });
    d = await startDaemon({ engine, jobManager });

    const first = await call(d.url, '/v1/jobs', { method: 'POST', body: createBody(JOB_ID) });
    assert.equal(first.status, 201);

    const second = await call(d.url, '/v1/jobs', { method: 'POST', body: createBody(JOB_ID_2) });
    assert.equal(second.status, 429);
    assert.equal((await second.json()).code, 'daemon.at_capacity');
    // The second job's container was never created.
    assert.equal(engine.calls.create.length, 1);

    // Re-attaching to the existing job is not a new admission — still allowed.
    const again = await call(d.url, '/v1/jobs', { method: 'POST', body: createBody(JOB_ID) });
    assert.equal(again.status, 200);
  });
});

describe('dev-runner-daemon — log-follow hardening', () => {
  let d;
  afterEach(async () => d && d.close());

  it('destroys the upstream docker stream when the client disconnects', async () => {
    const src = new Readable({ read() {} });
    src.push('hello\n'); // flush response headers to the client
    const engine = fakeEngine({
      async streamLogs() {
        return src;
      },
    });
    d = await startDaemon({ engine });
    await call(d.url, '/v1/jobs', { method: 'POST', body: createBody() });

    const controller = new AbortController();
    const res = await fetch(`${d.url}/v1/jobs/${JOB_ID}/logs?follow=1`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: controller.signal,
    });
    assert.equal(res.status, 200);
    // Pull the first chunk so the body stream is live, then hang up.
    await res.body.getReader().read();
    controller.abort();

    await waitFor(() => src.destroyed);
    assert.equal(src.destroyed, true, 'a client disconnect tore down the docker log stream');
  });

  it('caps concurrent follow streams and 429s past the cap, freeing a slot on disconnect', async () => {
    /** @type {import('node:stream').Readable[]} */
    const streams = [];
    const engine = fakeEngine({
      async streamLogs() {
        const s = new Readable({ read() {} });
        s.push('x\n');
        streams.push(s);
        return s;
      },
    });
    const jobManager = new JobManager({ engine, policyClient: fakePolicyClient() });
    d = await startDaemon({ engine, jobManager, maxLogFollows: 2 });
    await call(d.url, '/v1/jobs', { method: 'POST', body: createBody() });

    /** @type {AbortController[]} */
    const controllers = [];
    const openFollow = async () => {
      const c = new AbortController();
      controllers.push(c);
      const r = await fetch(`${d.url}/v1/jobs/${JOB_ID}/logs?follow=1`, {
        headers: { authorization: `Bearer ${TOKEN}` },
        signal: c.signal,
      });
      return r;
    };

    try {
      // Two follows fill the cap.
      assert.equal((await openFollow()).status, 200);
      assert.equal((await openFollow()).status, 200);

      // The third is refused rather than allowed to pin another docker stream.
      const third = await call(d.url, `/v1/jobs/${JOB_ID}/logs?follow=1`);
      assert.equal(third.status, 429);
      assert.equal((await third.json()).code, 'daemon.too_many_log_follows');

      // Free a slot by disconnecting the first follow; a new follow then gets in.
      controllers[0].abort();
      await waitFor(() => streams[0].destroyed);
      assert.equal((await openFollow()).status, 200);
    } finally {
      for (const c of controllers) c.abort();
      for (const s of streams) if (!s.destroyed) s.destroy();
      await waitFor(() => streams.every((s) => s.destroyed)).catch(() => {});
    }
  });

  it('holds the follow cap under a concurrent burst (the slot is reserved before the await)', async () => {
    /** @type {Readable[]} */
    const streams = [];
    const engine = fakeEngine({
      // Real docker I/O spans event-loop turns. Resolving on a macrotask is what
      // lets a whole burst past a check-then-act cap, so the fake must do it too
      // — a promise that settles in one microtask cannot reproduce the race.
      async streamLogs() {
        await new Promise((r) => setTimeout(r, 5));
        const s = new Readable({ read() {} });
        s.push('x\n');
        streams.push(s);
        return s;
      },
    });
    const jobManager = new JobManager({ engine, policyClient: fakePolicyClient() });
    d = await startDaemon({ engine, jobManager, maxLogFollows: 2 });
    await call(d.url, '/v1/jobs', { method: 'POST', body: createBody() });

    /** @type {AbortController[]} */
    const controllers = [];
    try {
      const burst = await Promise.all(
        Array.from({ length: 6 }, () => {
          const c = new AbortController();
          controllers.push(c);
          return fetch(`${d.url}/v1/jobs/${JOB_ID}/logs?follow=1`, {
            headers: { authorization: `Bearer ${TOKEN}` },
            signal: c.signal,
          });
        }),
      );
      const admitted = burst.filter((r) => r.status === 200).length;
      const refused = burst.filter((r) => r.status === 429).length;
      assert.equal(admitted, 2, 'exactly maxLogFollows streams are admitted');
      assert.equal(refused, 4, 'the rest are refused, not queued');
      assert.ok(streams.length <= 2, 'no docker log stream is opened past the cap');
    } finally {
      for (const c of controllers) c.abort();
      for (const s of streams) if (!s.destroyed) s.destroy();
      await waitFor(() => streams.every((s) => s.destroyed)).catch(() => {});
    }
  });
});
