import { strict as assert } from 'node:assert';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import {
  DEFAULT_LEASE_TTL_SEC,
  DockerBackend,
  DockerBackendError,
  type DockerRunnerHandle,
} from '../../src/devplatform/dockerBackend.js';
import { DAEMON_PROTOCOL_VERSION } from '../../src/devplatform/daemonProtocol.js';
import type { DevJobProvisionInput, RunnerHandle } from '../../src/devplatform/types.js';

/**
 * Epic #470 W1 — the DockerBackend, driven against a REAL http server standing
 * in for the daemon (the wire contract is `daemonProtocol.ts`, parity-tested
 * against the daemon's own copy). Proven here:
 *   - provision posts EXACTLY { protocol, jobId, leaseTtlSec } — no env/image/
 *     egressAllowlist (the caller names a job, never a policy; review S3)
 *   - every call is bearer-authenticated, and a redirect is refused
 *   - terminate treats 404 as success but RETAINS the handle on 502 cleanup_failed
 *   - reap returns handles the middleware tracks that the daemon lost
 *   - the lease loop renews at the daemon and survives a 404 (leaves it for reap)
 *   - the daemon error taxonomy maps to meaningful, typed outcomes
 */

const TOKEN = 'daemon-token-abcdefghijklmnopqrstuvwxyz-0123456789';

interface RecordedRequest {
  method: string;
  path: string;
  auth: string | undefined;
  body: unknown;
}

interface DaemonReply {
  status: number;
  body?: unknown;
  /** Send a raw string body instead of JSON (for the byte-cap test). */
  raw?: string;
  /** Delay the response by this many ms (for the timeout test). */
  delayMs?: number;
  /** Reply with a redirect Location instead of a normal body. */
  redirectTo?: string;
}

type DaemonHandler = (req: RecordedRequest) => DaemonReply;

/** A controllable daemon: records every request, answers via an injected handler. */
class FakeDaemon {
  readonly requests: RecordedRequest[] = [];
  handler: DaemonHandler = () => ({ status: 500, body: { code: 'daemon.unset' } });
  private server: Server | undefined;
  url = '';

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.onRequest(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const { port } = this.server!.address() as AddressInfo;
    this.url = `http://127.0.0.1:${String(port)}`;
  }

  async stop(): Promise<void> {
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    let body: unknown;
    try {
      body = rawBody.length > 0 ? JSON.parse(rawBody) : undefined;
    } catch {
      body = rawBody;
    }
    const recorded: RecordedRequest = {
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      auth: req.headers.authorization,
      body,
    };
    this.requests.push(recorded);
    const reply = this.handler(recorded);
    const send = (): void => {
      if (reply.redirectTo) {
        res.writeHead(302, { location: reply.redirectTo });
        res.end();
        return;
      }
      if (reply.raw !== undefined) {
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(reply.raw);
        return;
      }
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(reply.body === undefined ? '' : JSON.stringify(reply.body));
    };
    if (reply.delayMs) setTimeout(send, reply.delayMs);
    else send();
  }
}

const CREATE_OK = (jobId: string): DaemonReply => ({
  status: 201,
  body: {
    containerId: `container-${jobId}`,
    networkId: `net-${jobId}`,
    volumeName: `vol-${jobId}`,
    imageDigest: 'sha256:deadbeef',
    leaseExpiresAt: '2026-01-01T00:03:00.000Z',
  },
});

function makeBackend(url: string, extra: Record<string, unknown> = {}): DockerBackend {
  return new DockerBackend({
    daemonUrl: url,
    daemonToken: TOKEN,
    autoRenew: false, // tests drive renewLeases() directly — no stray timers
    provisionRetryBackoffMs: [0, 0],
    sleepImpl: () => Promise.resolve(),
    log: () => {},
    ...extra,
  });
}

function input(jobId: string): DevJobProvisionInput {
  return { jobId, jobToken: 'djr_token', baseUrl: 'http://mw.local' };
}

// ---------------------------------------------------------------------------

describe('DockerBackend — construction', () => {
  it('refuses to construct without a daemon URL or token', () => {
    assert.throws(
      () => new DockerBackend({ daemonUrl: '', daemonToken: TOKEN }),
      (e: unknown) => e instanceof DockerBackendError && e.code === 'devplatform.docker_daemon_url_required',
    );
    assert.throws(
      () => new DockerBackend({ daemonUrl: 'http://d', daemonToken: '' }),
      (e: unknown) => e instanceof DockerBackendError && e.code === 'devplatform.docker_daemon_token_required',
    );
  });
});

describe('DockerBackend — provision', () => {
  it('posts EXACTLY { protocol, jobId, leaseTtlSec } — no env/image/egressAllowlist — bearer-authed, and maps the handle', async () => {
    const daemon = new FakeDaemon();
    await daemon.start();
    after(() => daemon.stop());
    const jobId = randomUUID();
    daemon.handler = (req) => {
      assert.equal(req.method, 'POST');
      assert.equal(req.path, '/v1/jobs');
      return CREATE_OK(jobId);
    };
    const backend = makeBackend(daemon.url);
    after(() => backend.stop());

    const handle = (await backend.provision(input(jobId))) as DockerRunnerHandle;

    const sent = daemon.requests.at(-1)!;
    assert.equal(sent.auth, `Bearer ${TOKEN}`);
    assert.deepEqual(Object.keys(sent.body as object).sort(), ['jobId', 'leaseTtlSec', 'protocol']);
    const bodyObj = sent.body as { protocol: number; jobId: string; leaseTtlSec: number };
    assert.equal(bodyObj.protocol, DAEMON_PROTOCOL_VERSION);
    assert.equal(bodyObj.jobId, jobId);
    assert.equal(bodyObj.leaseTtlSec, DEFAULT_LEASE_TTL_SEC);

    assert.equal(handle.backend, 'docker');
    assert.equal(handle.id, jobId, 'handle.id is the jobId — the store/reap join key');
    assert.equal(handle.jobId, jobId);
    assert.equal(handle.containerId, `container-${jobId}`);
    assert.equal(handle.networkId, `net-${jobId}`);
    assert.equal(handle.volumeName, `vol-${jobId}`);
    assert.equal(handle.imageDigest, 'sha256:deadbeef');
    assert.equal(handle.leaseExpiresAt, '2026-01-01T00:03:00.000Z');
  });

  it('never leaks a caller policy: a spec object on the input is ignored — only the id is sent', async () => {
    const daemon = new FakeDaemon();
    await daemon.start();
    after(() => daemon.stop());
    const jobId = randomUUID();
    daemon.handler = () => CREATE_OK(jobId);
    const backend = makeBackend(daemon.url);
    after(() => backend.stop());

    // A hostile caller smuggling policy fields onto the input object.
    const hostile = {
      ...input(jobId),
      env: { SECRET: 'x' },
      image: 'evil:latest',
      egressAllowlist: ['attacker.tld'],
    } as unknown as DevJobProvisionInput;
    await backend.provision(hostile);

    const sent = daemon.requests.at(-1)!.body as Record<string, unknown>;
    assert.equal(sent['env'], undefined);
    assert.equal(sent['image'], undefined);
    assert.equal(sent['egressAllowlist'], undefined);
  });

  it('bounds the lease TTL to the daemon window [30, 3600]', async () => {
    const daemon = new FakeDaemon();
    await daemon.start();
    after(() => daemon.stop());
    const jobId = randomUUID();
    daemon.handler = () => CREATE_OK(jobId);
    const backend = makeBackend(daemon.url, { leaseTtlSec: 10 }); // below the floor
    after(() => backend.stop());
    await backend.provision(input(jobId));
    assert.equal((daemon.requests.at(-1)!.body as { leaseTtlSec: number }).leaseTtlSec, 30);
  });

  it('maps 400 daemon.spec_rejected to a terminal, non-retryable failure with the reason', async () => {
    const daemon = new FakeDaemon();
    await daemon.start();
    after(() => daemon.stop());
    const jobId = randomUUID();
    daemon.handler = () => ({ status: 400, body: { code: 'daemon.spec_rejected', message: 'floating tag' } });
    const backend = makeBackend(daemon.url);
    after(() => backend.stop());
    await assert.rejects(backend.provision(input(jobId)), (e: unknown) => {
      assert.ok(e instanceof DockerBackendError);
      assert.equal(e.code, 'devplatform.spec_rejected');
      assert.equal(e.retryable, false);
      assert.match(e.message, /floating tag/);
      return true;
    });
    // A terminal 4xx is NEVER retried (exactly one create attempt).
    assert.equal(daemon.requests.filter((r) => r.method === 'POST').length, 1);
  });

  it('maps 429 to a RETRYABLE at-capacity error (not a job failure)', async () => {
    const daemon = new FakeDaemon();
    await daemon.start();
    after(() => daemon.stop());
    const jobId = randomUUID();
    // The retryable promise ("nothing was created") is confirmed against the
    // daemon before it is made, so the job list must answer too.
    daemon.handler = (req) =>
      req.method === 'GET' && req.path === '/v1/jobs'
        ? { status: 200, body: { jobs: [] } }
        : { status: 429, body: { code: 'daemon.at_capacity', message: 'busy' } };
    const backend = makeBackend(daemon.url);
    after(() => backend.stop());
    await assert.rejects(backend.provision(input(jobId)), (e: unknown) => {
      assert.ok(e instanceof DockerBackendError);
      assert.equal(e.code, 'devplatform.daemon_at_capacity');
      assert.equal(e.retryable, true);
      return true;
    });
  });

  it('maps a 5xx engine fault to engine_error', async () => {
    const daemon = new FakeDaemon();
    await daemon.start();
    after(() => daemon.stop());
    const jobId = randomUUID();
    daemon.handler = () => ({ status: 500, body: { code: 'daemon.internal' } });
    const backend = makeBackend(daemon.url);
    after(() => backend.stop());
    await assert.rejects(backend.provision(input(jobId)), (e: unknown) => {
      assert.ok(e instanceof DockerBackendError);
      assert.equal(e.code, 'devplatform.engine_error');
      return true;
    });
  });

  it('after a transport failure, CONFIRMS the job is absent before re-creating (never a blind re-create)', async () => {
    const daemon = new FakeDaemon();
    await daemon.start();
    after(() => daemon.stop());
    const jobId = randomUUID();
    let posts = 0;
    daemon.handler = (req) => {
      if (req.method === 'POST' && req.path === '/v1/jobs') {
        posts += 1;
        if (posts === 1) return { status: 200, delayMs: 5_000 }; // will be aborted by timeout
        return CREATE_OK(jobId);
      }
      if (req.method === 'GET' && req.path === '/v1/jobs') return { status: 200, body: { jobs: [] } };
      return { status: 404, body: {} };
    };
    // Tight provision timeout so the first POST aborts → daemon_unreachable → retry.
    const backend = makeBackend(daemon.url, { provisionTimeoutMs: 100 });
    after(() => backend.stop());

    const handle = (await backend.provision(input(jobId))) as DockerRunnerHandle;
    assert.equal(handle.jobId, jobId);
    // A GET /v1/jobs (confirm-absent) ran BEFORE the second POST.
    const order = daemon.requests.map((r) => `${r.method} ${r.path}`);
    const firstList = order.indexOf('GET /v1/jobs');
    const secondPost = order.lastIndexOf('POST /v1/jobs');
    assert.ok(firstList >= 0 && firstList < secondPost, 'confirm-absent list precedes the re-create');
  });

  it('adopts an already-created job on retry instead of duplicating it', async () => {
    const daemon = new FakeDaemon();
    await daemon.start();
    after(() => daemon.stop());
    const jobId = randomUUID();
    let posts = 0;
    daemon.handler = (req) => {
      if (req.method === 'POST' && req.path === '/v1/jobs') {
        posts += 1;
        return { status: 200, delayMs: 5_000 }; // both posts hang → aborted
      }
      if (req.method === 'GET' && req.path === '/v1/jobs') {
        // The first create actually landed a container despite the transport abort.
        return {
          status: 200,
          body: {
            jobs: [
              {
                jobId,
                containerId: `container-${jobId}`,
                networkId: `net-${jobId}`,
                volumeName: `vol-${jobId}`,
                imageDigest: 'sha256:cafe',
                leaseExpiresAt: '2026-01-01T00:03:00.000Z',
              },
            ],
          },
        };
      }
      return { status: 404, body: {} };
    };
    const backend = makeBackend(daemon.url, { provisionTimeoutMs: 100 });
    after(() => backend.stop());
    const handle = (await backend.provision(input(jobId))) as DockerRunnerHandle;
    assert.equal(handle.containerId, `container-${jobId}`);
    assert.equal(posts, 1, 'the second create was skipped — the existing container was adopted');
  });

  it('refuses to follow a redirect off the daemon origin', async () => {
    const daemon = new FakeDaemon();
    await daemon.start();
    after(() => daemon.stop());
    const jobId = randomUUID();
    daemon.handler = () => ({ status: 302, redirectTo: 'http://evil.tld/v1/jobs' });
    const backend = makeBackend(daemon.url);
    after(() => backend.stop());
    await assert.rejects(backend.provision(input(jobId)), (e: unknown) => {
      assert.ok(e instanceof DockerBackendError);
      assert.equal(e.code, 'devplatform.daemon_unreachable');
      return true;
    });
  });

  it('aborts (does not buffer) a response body past the byte cap', async () => {
    const daemon = new FakeDaemon();
    await daemon.start();
    after(() => daemon.stop());
    const jobId = randomUUID();
    daemon.handler = () => ({ status: 200, raw: 'x'.repeat(5_000) });
    const backend = makeBackend(daemon.url, { maxBodyBytes: 512 });
    after(() => backend.stop());
    await assert.rejects(backend.provision(input(jobId)), (e: unknown) => {
      assert.ok(e instanceof DockerBackendError);
      // The oversized body is aborted mid-read and surfaces its own specific code.
      assert.equal(e.code, 'devplatform.daemon_body_too_large');
      return true;
    });
  });
});

describe('DockerBackend — terminate', () => {
  async function provisioned(daemon: FakeDaemon): Promise<{ backend: DockerBackend; handle: DockerRunnerHandle; jobId: string }> {
    const jobId = randomUUID();
    daemon.handler = () => CREATE_OK(jobId);
    const backend = makeBackend(daemon.url);
    const handle = (await backend.provision(input(jobId))) as DockerRunnerHandle;
    return { backend, handle, jobId };
  }

  it('DELETEs the job and treats a 200 as success', async () => {
    const daemon = new FakeDaemon();
    await daemon.start();
    after(() => daemon.stop());
    const { backend, handle, jobId } = await provisioned(daemon);
    after(() => backend.stop());
    daemon.handler = (req) => {
      assert.equal(req.method, 'DELETE');
      assert.equal(req.path, `/v1/jobs/${jobId}`);
      assert.equal(req.auth, `Bearer ${TOKEN}`);
      return { status: 200, body: { jobId, deleted: true } };
    };
    await backend.terminate(handle);
    // The job left the live set (reap will not re-report it).
    assert.deepEqual(await backend.reap(), []);
  });

  it('treats a 404 as success (idempotent — the container is already gone)', async () => {
    const daemon = new FakeDaemon();
    await daemon.start();
    after(() => daemon.stop());
    const { backend, handle } = await provisioned(daemon);
    after(() => backend.stop());
    daemon.handler = () => ({ status: 404, body: { code: 'daemon.job_not_found' } });
    await backend.terminate(handle); // resolves, no throw
  });

  it('RETAINS the handle on 502 daemon.cleanup_failed and surfaces a keepHandle error', async () => {
    const daemon = new FakeDaemon();
    await daemon.start();
    after(() => daemon.stop());
    const { backend, handle, jobId } = await provisioned(daemon);
    after(() => backend.stop());
    daemon.handler = () => ({ status: 502, body: { code: 'daemon.cleanup_failed', message: 'engine busy' } });
    await assert.rejects(backend.terminate(handle), (e: unknown) => {
      assert.ok(e instanceof DockerBackendError);
      assert.equal(e.code, 'devplatform.cleanup_failed');
      assert.equal(e.keepHandle, true);
      return true;
    });
    // The handle is STILL tracked — a live container never loses its only handle.
    // (A daemon that later loses the job would surface it via reap.)
    daemon.handler = () => ({ status: 200, body: { jobs: [] } });
    const reaped = await backend.reap();
    assert.equal(reaped.length, 1);
    assert.equal((reaped[0] as DockerRunnerHandle).jobId, jobId);
  });

  it('refuses a non-docker handle', async () => {
    const daemon = new FakeDaemon();
    await daemon.start();
    after(() => daemon.stop());
    const backend = makeBackend(daemon.url);
    after(() => backend.stop());
    const local: RunnerHandle = { backend: 'local', id: '/tmp/x', startedAt: 'now' };
    await assert.rejects(backend.terminate(local), (e: unknown) => {
      assert.ok(e instanceof DockerBackendError);
      assert.equal(e.code, 'devplatform.wrong_backend');
      return true;
    });
  });
});

describe('DockerBackend — reap', () => {
  it('returns handles the middleware tracks that the daemon no longer knows about', async () => {
    const daemon = new FakeDaemon();
    await daemon.start();
    after(() => daemon.stop());
    const kept = randomUUID();
    const lost = randomUUID();
    const backend = makeBackend(daemon.url);
    after(() => backend.stop());

    daemon.handler = () => CREATE_OK(kept);
    await backend.provision(input(kept));
    daemon.handler = () => CREATE_OK(lost);
    await backend.provision(input(lost));

    // The daemon still holds `kept`, but `lost` vanished.
    daemon.handler = () => ({
      status: 200,
      body: {
        jobs: [
          {
            jobId: kept,
            containerId: `container-${kept}`,
            networkId: `net-${kept}`,
            volumeName: `vol-${kept}`,
            imageDigest: 'sha256:deadbeef',
            leaseExpiresAt: '2026-01-01T00:03:00.000Z',
          },
        ],
      },
    });
    const reaped = (await backend.reap()) as DockerRunnerHandle[];
    assert.equal(reaped.length, 1);
    assert.equal(reaped[0]!.jobId, lost);
    assert.equal(reaped[0]!.id, lost, 'reaped handle.id is the jobId — the worker join key');

    // A second reap returns nothing (the lost job left the live set).
    assert.deepEqual(await backend.reap(), []);
  });

  it('reaps NOTHING when the daemon list read fails (a blip must not mass-finalize)', async () => {
    const daemon = new FakeDaemon();
    await daemon.start();
    after(() => daemon.stop());
    const jobId = randomUUID();
    const backend = makeBackend(daemon.url);
    after(() => backend.stop());
    daemon.handler = () => CREATE_OK(jobId);
    await backend.provision(input(jobId));

    daemon.handler = () => ({ status: 503, body: { code: 'daemon.policy_unreachable' } });
    assert.deepEqual(await backend.reap(), []);
    // The job is STILL tracked — the next healthy reap can settle it.
    daemon.handler = () => ({ status: 200, body: { jobs: [] } });
    assert.equal((await backend.reap()).length, 1);
  });
});

describe('DockerBackend — lease renewal', () => {
  it('renews every live job at the daemon and refreshes leaseExpiresAt', async () => {
    const daemon = new FakeDaemon();
    await daemon.start();
    after(() => daemon.stop());
    const jobId = randomUUID();
    const backend = makeBackend(daemon.url);
    after(() => backend.stop());
    daemon.handler = () => CREATE_OK(jobId);
    const handle = (await backend.provision(input(jobId))) as DockerRunnerHandle;

    daemon.handler = (req) => {
      assert.equal(req.method, 'POST');
      assert.equal(req.path, `/v1/jobs/${jobId}/lease`);
      assert.equal(req.auth, `Bearer ${TOKEN}`);
      assert.deepEqual(Object.keys(req.body as object).sort(), ['leaseTtlSec', 'protocol']);
      return { status: 200, body: { jobId, leaseExpiresAt: '2026-01-01T00:06:00.000Z' } };
    };
    await backend.renewLeases();
    assert.equal(handle.leaseExpiresAt, '2026-01-01T00:06:00.000Z');
  });

  it('on a 404 leaves the job in the live set (reap, not the lease loop, finalizes it)', async () => {
    const daemon = new FakeDaemon();
    await daemon.start();
    after(() => daemon.stop());
    const jobId = randomUUID();
    const backend = makeBackend(daemon.url);
    after(() => backend.stop());
    daemon.handler = () => CREATE_OK(jobId);
    await backend.provision(input(jobId));

    daemon.handler = () => ({ status: 404, body: { code: 'daemon.job_not_found' } });
    await backend.renewLeases(); // must not throw, must not drop the job

    daemon.handler = () => ({ status: 200, body: { jobs: [] } });
    const reaped = await backend.reap();
    assert.equal(reaped.length, 1, 'the job survived the 404 renew and is reaped');
  });

  it('the auto-renew loop fires on its TTL/3 interval', async () => {
    const daemon = new FakeDaemon();
    await daemon.start();
    after(() => daemon.stop());
    const jobId = randomUUID();
    // A fast interval seam so the loop test does not wait the real ≥10s cadence.
    const backend = new DockerBackend({
      daemonUrl: daemon.url,
      daemonToken: TOKEN,
      renewIntervalMs: 50,
      log: () => {},
    });
    after(() => backend.stop());
    let leaseCalls = 0;
    daemon.handler = (req) => {
      if (req.path.endsWith('/lease')) {
        leaseCalls += 1;
        return { status: 200, body: { jobId, leaseExpiresAt: '2026-01-01T00:06:00.000Z' } };
      }
      return CREATE_OK(jobId);
    };
    await backend.provision(input(jobId));
    await new Promise((r) => setTimeout(r, 250));
    backend.stop();
    assert.ok(leaseCalls >= 1, `expected at least one auto-renew, got ${String(leaseCalls)}`);
  });
});

/**
 * Epic #470 W1 — the two holes a cross-family audit found in the first cut of
 * `adopt()`/`releaseClaim()`.
 */
describe('devplatform/DockerBackend — a retryable create must PROVE nothing was created', () => {
  const daemon = new FakeDaemon();
  const JOB = '11111111-1111-4111-8111-111111111111';

  const summary = {
    jobId: JOB,
    containerId: 'real-container',
    networkId: 'net-1',
    volumeName: 'vol-1',
    imageDigest: `sha256:${'c'.repeat(64)}`,
    leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
  };

  before(async () => daemon.start());
  after(async () => daemon.stop());

  it('adopts the container when a 429 lied and the create had in fact succeeded', async () => {
    // A retry or proxy layer between middleware and daemon turned a successful
    // create into a 429. Requeueing here would leak a container nobody holds.
    daemon.handler = (req) => {
      if (req.method === 'POST' && req.path === '/v1/jobs') return { status: 429, body: { code: 'daemon.at_capacity' } };
      if (req.method === 'GET' && req.path === '/v1/jobs') return { status: 200, body: { jobs: [summary] } };
      return { status: 500, body: { code: 'daemon.unexpected' } };
    };
    const backend = makeBackend(daemon.url);
    const handle = (await backend.provision(input(JOB))) as DockerRunnerHandle;
    assert.equal(handle.containerId, 'real-container', 'the create succeeded; we hold its handle');
    assert.equal(handle.jobId, JOB);
    backend.stop();
  });

  it('propagates the 429 as retryable once the daemon confirms the job is absent', async () => {
    daemon.handler = (req) => {
      if (req.method === 'POST' && req.path === '/v1/jobs') return { status: 429, body: { code: 'daemon.at_capacity' } };
      if (req.method === 'GET' && req.path === '/v1/jobs') return { status: 200, body: { jobs: [] } };
      return { status: 500, body: { code: 'daemon.unexpected' } };
    };
    const backend = makeBackend(daemon.url);
    await assert.rejects(
      () => backend.provision(input(JOB)),
      (e: unknown) =>
        e instanceof DockerBackendError && e.code === 'devplatform.daemon_at_capacity' && e.retryable,
    );
    backend.stop();
  });

  it('refuses to promise a clean retry when the daemon cannot be read afterwards', async () => {
    // Absence unproven ⇒ requeueing the same jobId might collide with a container
    // the daemon still holds. Fail the job; the daemon's lease reaper is the backstop.
    daemon.handler = (req) => {
      if (req.method === 'POST' && req.path === '/v1/jobs') return { status: 429, body: { code: 'daemon.at_capacity' } };
      return { status: 500, body: { code: 'daemon.engine_error' } };
    };
    const backend = makeBackend(daemon.url);
    await assert.rejects(
      () => backend.provision(input(JOB)),
      (e: unknown) =>
        e instanceof DockerBackendError && e.code === 'devplatform.orphan_unproven' && !e.retryable,
    );
    backend.stop();
  });
});

describe('devplatform/DockerBackend — rehydrate prefers the daemon over the database', () => {
  const daemon = new FakeDaemon();
  const JOB = '22222222-2222-4222-8222-222222222222';

  function persisted(containerId: string): DockerRunnerHandle {
    return {
      backend: 'docker',
      id: JOB,
      jobId: JOB,
      containerId,
      networkId: 'net-db',
      volumeName: 'vol-db',
      imageDigest: `sha256:${'d'.repeat(64)}`,
      leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      startedAt: new Date().toISOString(),
    };
  }

  before(async () => daemon.start());
  after(async () => daemon.stop());

  it('trusts the daemon container id when the persisted handle diverges', async () => {
    daemon.handler = (req) => {
      if (req.method === 'GET' && req.path === '/v1/jobs') {
        return {
          status: 200,
          body: {
            jobs: [
              {
                jobId: JOB,
                containerId: 'daemon-truth',
                networkId: 'net-1',
                volumeName: 'vol-1',
                imageDigest: `sha256:${'c'.repeat(64)}`,
                leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
              },
            ],
          },
        };
      }
      return { status: 200, body: { jobs: [] } };
    };
    const backend = makeBackend(daemon.url);
    const r = await backend.rehydrate([{ id: JOB, runnerHandle: persisted('stale-or-forged') }]);
    assert.deepEqual(r, { adopted: 1, skipped: 0, reconciled: 1 });
    // reap() joins live against the daemon: the job IS on the daemon, so nothing is lost.
    assert.deepEqual(await backend.reap(), []);
    backend.stop();
  });

  it('adopts a job the daemon no longer lists, so reap() can settle it', async () => {
    // This is the whole point of rehydration: a container that died while the
    // middleware was down must become visible again, or its row hangs in `running`.
    daemon.handler = () => ({ status: 200, body: { jobs: [] } });
    const backend = makeBackend(daemon.url);
    const r = await backend.rehydrate([{ id: JOB, runnerHandle: persisted('gone') }]);
    assert.equal(r.adopted, 1);
    const lost = await backend.reap();
    assert.equal(lost.length, 1, 'reap now reports the lost job, and the worker finalizes it');
    assert.equal((lost[0] as DockerRunnerHandle).jobId, JOB);
    backend.stop();
  });

  it('adopts from the database when the daemon cannot be listed at all', async () => {
    // Adopting nothing here would make every live container invisible forever.
    daemon.handler = () => ({ status: 503, body: { code: 'daemon.engine_unreachable' } });
    const backend = makeBackend(daemon.url);
    const r = await backend.rehydrate([{ id: JOB, runnerHandle: persisted('from-db') }]);
    assert.equal(r.adopted, 1);
    backend.stop();
  });

  it('skips a handle that does not narrow to this backend, and one whose jobId lies', async () => {
    daemon.handler = () => ({ status: 200, body: { jobs: [] } });
    const backend = makeBackend(daemon.url);
    const foreign: RunnerHandle = { backend: 'local', id: '/tmp/ws', pid: 1, startedAt: new Date().toISOString() };
    const liar = { ...persisted('x'), jobId: 'someone-elses-job' };
    const r = await backend.rehydrate([
      { id: JOB, runnerHandle: foreign },
      { id: JOB, runnerHandle: liar },
      { id: JOB, runnerHandle: null },
    ]);
    assert.deepEqual(r, { adopted: 0, skipped: 2, reconciled: 0 });
    assert.deepEqual(await backend.reap(), [], 'nothing was adopted, so nothing is tracked');
    backend.stop();
  });
});

describe('devplatform/DockerBackend — a failed teardown forfeits the lease', () => {
  const daemon = new FakeDaemon();
  const JOB = '33333333-3333-4333-8333-333333333333';

  before(async () => daemon.start());
  after(async () => daemon.stop());

  function handleFor(jobId: string): DockerRunnerHandle {
    return {
      backend: 'docker',
      id: jobId,
      jobId,
      containerId: 'c1',
      networkId: 'n1',
      volumeName: 'v1',
      imageDigest: `sha256:${'e'.repeat(64)}`,
      leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      startedAt: new Date().toISOString(),
    };
  }

  it('never renews a container it is trying to destroy, even when the DELETE fails', async () => {
    // `keepHandle` means "teardown unproven", not "keep it alive". If the lease kept
    // being renewed, a container we decided must die would live forever — and the
    // daemon's lease reaper, the only backstop, would never fire.
    const renews: string[] = [];
    daemon.handler = (req) => {
      if (req.method === 'DELETE') return { status: 502, body: { code: 'daemon.cleanup_failed' } };
      if (req.path.endsWith('/lease')) {
        renews.push(req.path);
        return { status: 200, body: { leaseExpiresAt: new Date(Date.now() + 600_000).toISOString() } };
      }
      return { status: 200, body: { jobs: [] } };
    };
    const backend = makeBackend(daemon.url);
    await backend.rehydrate([{ id: JOB, runnerHandle: handleFor(JOB) }]);

    await backend.renewLeases();
    assert.equal(renews.length, 1, 'before teardown, the lease is renewed normally');

    await assert.rejects(
      () => backend.terminate(handleFor(JOB)),
      (e: unknown) => e instanceof DockerBackendError && e.keepHandle,
    );
    assert.equal(backend.isTerminating(JOB), true);

    await backend.renewLeases();
    assert.equal(renews.length, 1, 'after a failed teardown the lease is NEVER renewed again');
    backend.stop();
  });

  it('clears the terminating mark once the daemon confirms the job is gone', async () => {
    daemon.handler = (req) => {
      if (req.method === 'DELETE') return { status: 502, body: { code: 'daemon.cleanup_failed' } };
      return { status: 200, body: { jobs: [] } };
    };
    const backend = makeBackend(daemon.url);
    await backend.rehydrate([{ id: JOB, runnerHandle: handleFor(JOB) }]);
    await assert.rejects(() => backend.terminate(handleFor(JOB)), DockerBackendError);
    assert.equal(backend.isTerminating(JOB), true);

    const lost = await backend.reap();
    assert.equal(lost.length, 1, 'the daemon no longer has it; reap settles the row');
    assert.equal(backend.isTerminating(JOB), false, 'and the mark does not leak');
    backend.stop();
  });
});

describe('devplatform/DockerBackend — a handle whose id and jobId disagree is malformed', () => {
  const daemon = new FakeDaemon();
  const HEALTHY = '44444444-4444-4444-8444-444444444444';

  before(async () => daemon.start());
  after(async () => daemon.stop());

  it('refuses to terminate through a handle that names a different job than its id', async () => {
    // A corrupt or attacker-supplied row: id = 'A' (the job the caller means),
    // jobId = the id of a HEALTHY running job. terminate() used to trust jobId,
    // mark the healthy job's lease forfeit, and let the daemon reaper kill it.
    const deletes: string[] = [];
    const renews: string[] = [];
    daemon.handler = (req) => {
      if (req.method === 'DELETE') {
        deletes.push(req.path);
        return { status: 502, body: { code: 'daemon.cleanup_failed' } };
      }
      if (req.path.endsWith('/lease')) {
        renews.push(req.path);
        return { status: 200, body: { leaseExpiresAt: new Date(Date.now() + 600_000).toISOString() } };
      }
      return { status: 200, body: { jobs: [] } };
    };
    const backend = makeBackend(daemon.url);
    const healthy: DockerRunnerHandle = {
      backend: 'docker',
      id: HEALTHY,
      jobId: HEALTHY,
      containerId: 'c-healthy',
      networkId: 'n',
      volumeName: 'v',
      imageDigest: `sha256:${'f'.repeat(64)}`,
      leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      startedAt: new Date().toISOString(),
    };
    await backend.rehydrate([{ id: HEALTHY, runnerHandle: healthy }]);

    const liar = { ...healthy, id: 'some-other-job' };
    await assert.rejects(
      () => backend.terminate(liar),
      (e: unknown) => e instanceof DockerBackendError && e.code === 'devplatform.malformed_handle',
    );

    assert.deepEqual(deletes, [], 'nothing was deleted');
    assert.equal(backend.isTerminating(HEALTHY), false, 'the healthy job keeps its lease');
    await backend.renewLeases();
    assert.equal(renews.length, 1, 'and it is still being renewed');
    backend.stop();
  });

  it('refuses to rehydrate such a handle too', async () => {
    daemon.handler = () => ({ status: 200, body: { jobs: [] } });
    const backend = makeBackend(daemon.url);
    const liar = {
      backend: 'docker' as const,
      id: 'job-a',
      jobId: 'job-b',
      containerId: 'c',
      networkId: 'n',
      volumeName: 'v',
      imageDigest: `sha256:${'0'.repeat(64)}`,
      leaseExpiresAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
    };
    const r = await backend.rehydrate([{ id: 'job-a', runnerHandle: liar }]);
    assert.deepEqual(r, { adopted: 0, skipped: 1, reconciled: 0 });
    backend.stop();
  });
});
