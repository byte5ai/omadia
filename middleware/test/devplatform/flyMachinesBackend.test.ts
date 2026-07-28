import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  clampGuest,
  DEFAULT_FLY_LEASE_TTL_SEC,
  FlyMachinesBackend,
  FlyMachinesBackendError,
  JOB_ID_METADATA_KEY,
  LEASE_METADATA_KEY,
  type FlyMachinesBackendOptions,
  type FlyRunnerHandle,
} from '../../src/devplatform/flyMachinesBackend.js';
import type { DevJobProvisionInput, RunnerHandle } from '../../src/devplatform/types.js';

/**
 * Epic #470 W4 — `FlyMachinesBackend`, driven against a FAKE fetch (no real Fly, no
 * pg, no docker). The fake records every request and answers via a route table, so
 * every wire assertion is made against the exact JSON the backend would send Fly.
 */

const APP = 'odoo-bot-dev-runners';
const API_BASE = 'https://api.machines.dev/v1';
const IMAGE = `registry.fly.io/odoo-bot-dev-runners@sha256:${'a'.repeat(64)}`;
const PHONE_HOME = 'http://middleware.internal:8080/dev/phone-home';
const TOKEN = 'FlyV1 fm2_deploy_token_scoped_to_runner_app';

interface RecordedCall {
  method: string;
  url: string;
  path: string;
  auth: string | undefined;
  body: unknown;
}

type Route = (call: RecordedCall) => { status: number; body?: unknown; raw?: string };

/** A fake `fetch` that records calls and answers via an injected route function. */
function makeFetch(route: Route): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url));
    const headers = new Headers(init?.headers ?? {});
    let body: unknown;
    if (typeof init?.body === 'string' && init.body.length > 0) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call: RecordedCall = {
      method: init?.method ?? 'GET',
      url: String(url),
      path: `${u.pathname}${u.search}`,
      auth: headers.get('authorization') ?? undefined,
      body,
    };
    calls.push(call);
    const reply = route(call);
    if (reply.raw !== undefined) {
      return new Response(reply.raw, { status: reply.status, headers: { 'content-type': 'application/json' } });
    }
    const payload = reply.body === undefined ? '' : JSON.stringify(reply.body);
    return new Response(payload, { status: reply.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function options(over: Partial<FlyMachinesBackendOptions> & { fetchImpl: typeof fetch }): FlyMachinesBackendOptions {
  return {
    apiBase: API_BASE,
    appName: APP,
    token: () => Promise.resolve(TOKEN),
    image: IMAGE,
    phoneHomeUrl: PHONE_HOME,
    guest: { cpus: 2, memoryMb: 2_048 },
    maxCpus: 4,
    maxMemoryMb: 4_096,
    isJobActive: () => true,
    log: () => {},
    ...over,
  };
}

function input(jobId: string): DevJobProvisionInput {
  return { jobId, jobToken: 'djr_one_time_runner_token', baseUrl: 'http://mw.local' };
}

/** Route helper: a create that succeeds + a wait that succeeds. */
function happyRoute(machineId: string): Route {
  return (call) => {
    if (call.method === 'POST' && /\/machines$/.test(call.path.split('?')[0]!)) {
      return { status: 200, body: { id: machineId, state: 'created', region: 'fra' } };
    }
    if (call.method === 'GET' && /\/wait/.test(call.path)) return { status: 200, body: { ok: true } };
    return { status: 200, body: {} };
  };
}

// ---------------------------------------------------------------------------

describe('FlyMachinesBackend — construction', () => {
  it('refuses to construct without apiBase, appName, or image', () => {
    const { fetchImpl } = makeFetch(() => ({ status: 200 }));
    assert.throws(
      () => new FlyMachinesBackend(options({ fetchImpl, apiBase: '' })),
      (e: unknown) => e instanceof FlyMachinesBackendError && e.code === 'devplatform.fly_api_base_required',
    );
    assert.throws(
      () => new FlyMachinesBackend(options({ fetchImpl, appName: '' })),
      (e: unknown) => e instanceof FlyMachinesBackendError && e.code === 'devplatform.fly_app_required',
    );
    assert.throws(
      () => new FlyMachinesBackend(options({ fetchImpl, image: '' })),
      (e: unknown) => e instanceof FlyMachinesBackendError && e.code === 'devplatform.fly_image_required',
    );
  });
});

describe('FlyMachinesBackend — provision', () => {
  it('issues create→wait against the runner app with the right metadata/image/auto_destroy and returns a handle carrying the machine id', async () => {
    // FAIL-IF-REVERTED: if create stops targeting /apps/<app>/machines, or drops
    // metadata.omadia_job_id / the digest image / auto_destroy, or the handle stops
    // carrying the machine id, these assertions fail.
    const jobId = randomUUID();
    const machineId = 'machine-abc123';
    const { fetchImpl, calls } = makeFetch(happyRoute(machineId));
    const backend = new FlyMachinesBackend(options({ fetchImpl }));

    const handle = (await backend.provision(input(jobId))) as FlyRunnerHandle;

    const create = calls.find((c) => c.method === 'POST' && c.path.endsWith('/machines'))!;
    assert.ok(create, 'a create POST was issued');
    assert.equal(create.path, `/v1/apps/${APP}/machines`, 'create targets the DEDICATED runner app');
    assert.equal(create.auth, `Bearer ${TOKEN}`, 'the Vault deploy token is the bearer');
    const cfg = (create.body as { config: Record<string, unknown> }).config;
    assert.equal(cfg['image'], IMAGE, 'the digest-pinned image is used');
    assert.equal(cfg['auto_destroy'], true, 'auto_destroy is set (kill layer 3)');
    assert.deepEqual(cfg['restart'], { policy: 'no' }, 'the ephemeral VM is never restarted');
    const metadata = cfg['metadata'] as Record<string, string>;
    assert.equal(metadata[JOB_ID_METADATA_KEY], jobId, 'metadata.omadia_job_id is set — reap keys on it');
    const env = cfg['env'] as Record<string, string>;
    assert.equal(env['OMADIA_PHONE_HOME_URL'], PHONE_HOME);
    assert.equal(env['OMADIA_JOB_TOKEN'], 'djr_one_time_runner_token', 'the one-time runner token is planted');

    const wait = calls.find((c) => c.method === 'GET' && c.path.includes('/wait'))!;
    assert.ok(wait, 'a wait GET was issued');
    assert.match(wait.path, new RegExp(`/v1/apps/${APP}/machines/${machineId}/wait\\?state=started&timeout=\\d+`));

    assert.equal(handle.backend, 'fly');
    assert.equal(handle.id, jobId, 'handle.id is the jobId — the store/reap join key');
    assert.equal(handle.jobId, jobId);
    assert.equal(handle.machineId, machineId, 'the handle carries the created machine id');
    assert.equal(handle.image, IMAGE);
    assert.equal(handle.appName, APP);
  });

  it('ALWAYS sets metadata.omadia_job_id (reap depends on it)', async () => {
    // FAIL-IF-REVERTED: reap() joins terminal jobs to machines on this key; a create
    // that omits it would leak un-reapable machines. Assert it is present and correct.
    const jobId = randomUUID();
    const { fetchImpl, calls } = makeFetch(happyRoute('m-1'));
    const backend = new FlyMachinesBackend(options({ fetchImpl }));
    await backend.provision(input(jobId));
    const create = calls.find((c) => c.method === 'POST' && c.path.endsWith('/machines'))!;
    const metadata = (create.body as { config: { metadata: Record<string, string> } }).config.metadata;
    assert.equal(metadata[JOB_ID_METADATA_KEY], jobId);
    assert.ok(typeof metadata[LEASE_METADATA_KEY] === 'string' && metadata[LEASE_METADATA_KEY].length > 0);
  });

  it('CLAMPS a guest request over the ceiling instead of passing it through', async () => {
    // FAIL-IF-REVERTED: a request of 16 cpus / 65536 MB against a 4-cpu / 4096-MB
    // ceiling must land as 4 / 4096 in the create body — never the requested values.
    const jobId = randomUUID();
    const { fetchImpl, calls } = makeFetch(happyRoute('m-2'));
    const backend = new FlyMachinesBackend(
      options({ fetchImpl, guest: { cpus: 16, memoryMb: 65_536 }, maxCpus: 4, maxMemoryMb: 4_096 }),
    );
    await backend.provision(input(jobId));
    const create = calls.find((c) => c.method === 'POST' && c.path.endsWith('/machines'))!;
    const guest = (create.body as { config: { guest: { cpus: number; memory_mb: number } } }).config.guest;
    assert.equal(guest.cpus, 4, 'cpus clamped to the ceiling, not the requested 16');
    assert.equal(guest.memory_mb, 4_096, 'memory clamped to the ceiling, not the requested 65536');
  });

  it('surfaces a create failure as a RunnerBackendError whose retryability matches the sibling convention', async () => {
    // FAIL-IF-REVERTED: a 429 with the machine CONFIRMED ABSENT (list=[]) stays
    // RETRYABLE (like DockerBackend's daemon 429); a 422 spec-rejection is terminal.
    const jobId = randomUUID();
    const capacity = makeFetch((call) => {
      if (call.method === 'POST') return { status: 429, body: { error: 'rate limited' } };
      // The F2 confirm-absent list: empty ⇒ the create truly did not commit.
      if (call.method === 'GET' && call.path.endsWith('/machines')) return { status: 200, body: [] };
      return { status: 200, body: {} };
    });
    const back1 = new FlyMachinesBackend(options({ fetchImpl: capacity.fetchImpl }));
    await assert.rejects(back1.provision(input(jobId)), (e: unknown) => {
      assert.ok(e instanceof FlyMachinesBackendError);
      assert.equal(e.code, 'devplatform.fly_at_capacity');
      assert.equal(e.retryable, true, '429 + machine absent is retryable — safe to requeue');
      return true;
    });

    const rejected = makeFetch((call) =>
      call.method === 'POST' ? { status: 422, body: { error: 'bad guest' } } : { status: 200, body: {} },
    );
    const back2 = new FlyMachinesBackend(options({ fetchImpl: rejected.fetchImpl }));
    await assert.rejects(back2.provision(input(jobId)), (e: unknown) => {
      assert.ok(e instanceof FlyMachinesBackendError);
      assert.equal(e.code, 'devplatform.fly_spec_rejected');
      assert.equal(e.retryable, false, 'a spec rejection is terminal');
      return true;
    });
  });

  it('F2: a retryable create whose machine ALREADY COMMITTED is ADOPTED, not requeued (no second VM)', async () => {
    const jobId = randomUUID();
    let creates = 0;
    const { fetchImpl, calls } = makeFetch((call) => {
      if (call.method === 'POST' && call.path.split('?')[0]!.endsWith('/machines')) {
        creates += 1;
        return { status: 503, body: { error: 'proxy blip after commit' } };
      }
      // The machine DID commit despite the 503 — the list surfaces it by our jobId.
      if (call.method === 'GET' && call.path.endsWith('/machines')) {
        return { status: 200, body: [{ id: 'm-committed', region: 'fra', config: { metadata: { [JOB_ID_METADATA_KEY]: jobId } } }] };
      }
      if (call.method === 'GET' && call.path.includes('/wait')) return { status: 200, body: {} };
      return { status: 200, body: {} };
    });
    const backend = new FlyMachinesBackend(options({ fetchImpl }));
    const handle = (await backend.provision(input(jobId))) as FlyRunnerHandle;
    // FAIL-IF-REVERTED: without confirm-absent-or-adopt, the 503 would throw retryable
    // and the worker would requeue → a SECOND VM for the same hostile job. Adoption
    // returns the committed machine's handle and issues NO second create.
    assert.equal(handle.machineId, 'm-committed', 'the committed machine is adopted');
    assert.equal(creates, 1, 'no second create was issued');
    assert.ok(calls.some((c) => c.path.includes('/wait')), 'the adopted machine is waited to started');
  });

  it('F2: a retryable create whose absence CANNOT be proven fails CLOSED (retryable stripped)', async () => {
    const jobId = randomUUID();
    const { fetchImpl } = makeFetch((call) => {
      if (call.method === 'POST') return { status: 503, body: { error: 'unreachable' } };
      // The confirm-absent list ALSO fails — we cannot prove the machine is absent.
      if (call.method === 'GET' && call.path.endsWith('/machines')) return { status: 500, body: { error: 'list down' } };
      return { status: 200, body: {} };
    });
    const backend = new FlyMachinesBackend(options({ fetchImpl }));
    await assert.rejects(backend.provision(input(jobId)), (e: unknown) => {
      assert.ok(e instanceof FlyMachinesBackendError);
      // FAIL-IF-REVERTED: unprovable absence must NOT stay retryable — requeuing could
      // launch a second VM onto a machine that quietly committed.
      assert.equal(e.retryable, false, 'unprovable absence fails closed, not retryable');
      return true;
    });
  });

  it('F4: provision refuses an empty jobId (an empty omadia_job_id is an un-reapable orphan)', async () => {
    const { fetchImpl } = makeFetch(() => ({ status: 200, body: {} }));
    const backend = new FlyMachinesBackend(options({ fetchImpl }));
    await assert.rejects(backend.provision(input('  ')), (e: unknown) => {
      assert.ok(e instanceof FlyMachinesBackendError);
      assert.equal(e.code, 'devplatform.fly_job_id_required');
      return true;
    });
  });
});

describe('FlyMachinesBackend — terminate', () => {
  async function provisioned(machineId: string): Promise<{
    backend: FlyMachinesBackend;
    handle: FlyRunnerHandle;
    calls: RecordedCall[];
    setRoute: (r: Route) => void;
  }> {
    let route: Route = happyRoute(machineId);
    const { fetchImpl, calls } = makeFetch((call) => route(call));
    const backend = new FlyMachinesBackend(options({ fetchImpl }));
    const handle = (await backend.provision(input(randomUUID()))) as FlyRunnerHandle;
    return { backend, handle, calls, setRoute: (r) => (route = r) };
  }

  it('issues stop(15s) then destroy(force=true)', async () => {
    // FAIL-IF-REVERTED: terminate must SIGTERM-stop with a 15s grace, then force-destroy.
    const { backend, handle, calls, setRoute } = await provisioned('m-term');
    setRoute((call) => {
      if (call.method === 'POST' && call.path.includes('/stop')) return { status: 200, body: { ok: true } };
      if (call.method === 'DELETE') return { status: 200, body: { ok: true } };
      return { status: 200, body: {} };
    });
    await backend.terminate(handle);
    const stop = calls.find((c) => c.method === 'POST' && c.path.includes('/stop'))!;
    assert.ok(stop, 'a stop was issued');
    assert.deepEqual(stop.body, { timeout: '15s', signal: 'SIGTERM' }, 'stop carries the 15s SIGTERM grace');
    const destroy = calls.find((c) => c.method === 'DELETE')!;
    assert.ok(destroy, 'a destroy was issued');
    assert.match(destroy.path, /\?force=true$/, 'destroy is a force destroy');
    assert.match(destroy.path, /\/machines\/m-term\?/, 'destroy targets the created machine');
  });

  it('F3: refuses to destroy a machine whose omadia_job_id != the handle job (tampered handle)', async () => {
    const { backend, handle, calls, setRoute } = await provisioned('m-term');
    // The machine at handle.machineId actually belongs to a DIFFERENT job (a tampered
    // runner_handle: id===jobId but machineId points at another job's live machine).
    setRoute((call) => {
      if (call.method === 'GET' && call.path.includes('/machines/m-term') && !call.path.includes('/wait')) {
        return { status: 200, body: { id: 'm-term', config: { metadata: { [JOB_ID_METADATA_KEY]: 'SOMEONE-ELSES-JOB' } } } };
      }
      if (call.method === 'DELETE') return { status: 200, body: {} };
      return { status: 200, body: {} };
    });
    await assert.rejects(backend.terminate(handle), (e: unknown) => {
      assert.ok(e instanceof FlyMachinesBackendError);
      assert.equal(e.code, 'devplatform.malformed_handle');
      return true;
    });
    // FAIL-IF-REVERTED: no DELETE may be issued — we must NOT destroy another job's VM.
    assert.ok(!calls.some((c) => c.method === 'DELETE'), 'no destroy was issued against the foreign machine');
  });

  it('treats a 404 on destroy as SUCCESS (idempotent — the machine is already gone)', async () => {
    // FAIL-IF-REVERTED: a destroy 404 must resolve, not throw — the machine vanished.
    const { backend, handle, setRoute } = await provisioned('m-gone');
    setRoute((call) => {
      if (call.method === 'POST' && call.path.includes('/stop')) return { status: 404, body: {} };
      if (call.method === 'DELETE') return { status: 404, body: { error: 'not found' } };
      return { status: 200, body: {} };
    });
    await backend.terminate(handle); // resolves, no throw
  });

  it('RETAINS the handle on a non-404 destroy failure (keepHandle, teardown unproven)', async () => {
    const { backend, handle, setRoute } = await provisioned('m-stuck');
    setRoute((call) => {
      if (call.method === 'POST' && call.path.includes('/stop')) return { status: 200, body: {} };
      if (call.method === 'DELETE') return { status: 500, body: { error: 'engine busy' } };
      return { status: 200, body: {} };
    });
    await assert.rejects(backend.terminate(handle), (e: unknown) => {
      assert.ok(e instanceof FlyMachinesBackendError);
      assert.equal(e.keepHandle, true, 'the only handle on a live VM is kept for retry');
      return true;
    });
  });

  it('refuses a non-fly handle', async () => {
    const { fetchImpl } = makeFetch(() => ({ status: 200, body: {} }));
    const backend = new FlyMachinesBackend(options({ fetchImpl }));
    const local: RunnerHandle = { backend: 'local', id: '/tmp/x', startedAt: 'now' };
    await assert.rejects(backend.terminate(local), (e: unknown) => {
      assert.ok(e instanceof FlyMachinesBackendError);
      assert.equal(e.code, 'devplatform.wrong_backend');
      return true;
    });
  });
});

describe('FlyMachinesBackend — reap', () => {
  function machine(jobId: string, machineId: string, lease?: string): unknown {
    return {
      id: machineId,
      region: 'fra',
      config: {
        metadata: {
          [JOB_ID_METADATA_KEY]: jobId,
          ...(lease ? { [LEASE_METADATA_KEY]: lease } : {}),
        },
      },
    };
  }

  it('destroys ONLY machines whose job is terminal/unknown (via the injected predicate), leaving active ones', async () => {
    // FAIL-IF-REVERTED: with isJobActive true for `active` and false for `dead`, reap
    // must destroy exactly `dead`'s machine and return that handle — never `active`'s.
    const active = randomUUID();
    const dead = randomUUID();
    const destroyed: string[] = [];
    const { fetchImpl } = makeFetch((call) => {
      if (call.method === 'GET' && call.path.endsWith('/machines')) {
        return { status: 200, body: [machine(active, 'm-active'), machine(dead, 'm-dead')] };
      }
      if (call.method === 'DELETE') {
        destroyed.push(call.path);
        return { status: 200, body: { ok: true } };
      }
      return { status: 200, body: {} };
    });
    const backend = new FlyMachinesBackend(
      options({ fetchImpl, isJobActive: (jobId) => jobId === active }),
    );

    const reaped = (await backend.reap()) as FlyRunnerHandle[];

    assert.equal(destroyed.length, 1, 'exactly one machine was destroyed');
    assert.match(destroyed[0]!, /\/machines\/m-dead\?force=true$/, 'the terminal job’s machine was destroyed');
    assert.equal(reaped.length, 1);
    assert.equal(reaped[0]!.jobId, dead, 'reap returns the terminal job handle');
    assert.equal(reaped[0]!.id, dead, 'reaped handle.id is the jobId — the worker join key');
  });

  it('F1: does NOT reap an ACTIVE job even past its lease deadline (a healthy long job survives)', async () => {
    const job = randomUUID();
    const past = new Date(Date.now() - 60_000).toISOString();
    const destroyed: string[] = [];
    const { fetchImpl } = makeFetch((call) => {
      if (call.method === 'GET' && call.path.endsWith('/machines')) {
        return { status: 200, body: [machine(job, 'm-longrun', past)] };
      }
      if (call.method === 'DELETE') {
        destroyed.push(call.path);
        return { status: 200, body: {} };
      }
      return { status: 200, body: {} };
    });
    const backend = new FlyMachinesBackend(options({ fetchImpl, isJobActive: () => true }));
    const reaped = await backend.reap();
    // FAIL-IF-REVERTED: Fly's lease is a create-time stamp, not a renewed heartbeat,
    // so reaping on lease-expiry force-kills any job that legitimately runs past the
    // TTL. An ACTIVE job must survive reap regardless of its lease (Forge W4 F1);
    // wedged jobs are caught by the worker's enforce sweep + auto_destroy instead.
    assert.equal(destroyed.length, 0, 'an active job past its lease is NOT destroyed');
    assert.equal(reaped.length, 0);
  });

  it('never touches a machine that lacks the omadia_job_id metadata (not ours)', async () => {
    const destroyed: string[] = [];
    const { fetchImpl } = makeFetch((call) => {
      if (call.method === 'GET' && call.path.endsWith('/machines')) {
        return { status: 200, body: [{ id: 'foreign', config: { metadata: { other: 'x' } } }] };
      }
      if (call.method === 'DELETE') {
        destroyed.push(call.path);
        return { status: 200, body: {} };
      }
      return { status: 200, body: {} };
    });
    const backend = new FlyMachinesBackend(options({ fetchImpl, isJobActive: () => false }));
    const reaped = await backend.reap();
    assert.deepEqual(destroyed, [], 'a machine without our metadata is never destroyed');
    assert.deepEqual(reaped, []);
  });

  it('reaps NOTHING when the machine list read fails (a blip must not mass-destroy)', async () => {
    const destroyed: string[] = [];
    const { fetchImpl } = makeFetch((call) => {
      if (call.method === 'GET') return { status: 503, body: { error: 'fly down' } };
      if (call.method === 'DELETE') {
        destroyed.push(call.path);
        return { status: 200, body: {} };
      }
      return { status: 200, body: {} };
    });
    const backend = new FlyMachinesBackend(options({ fetchImpl, isJobActive: () => false }));
    assert.deepEqual(await backend.reap(), []);
    assert.deepEqual(destroyed, [], 'a list failure destroys nothing');
  });
});

describe('FlyMachinesBackend — clampGuest (pure)', () => {
  it('clamps over-ceiling and floors zero/negative/NaN, defaulting cpu_kind to shared', () => {
    assert.deepEqual(clampGuest({ cpus: 99, memoryMb: 99_999 }, { maxCpus: 8, maxMemoryMb: 8_192 }), {
      cpus: 8,
      memoryMb: 8_192,
      cpuKind: 'shared',
    });
    assert.deepEqual(clampGuest({ cpus: 0, memoryMb: -5 }, { maxCpus: 8, maxMemoryMb: 8_192 }), {
      cpus: 1,
      memoryMb: 256,
      cpuKind: 'shared',
    });
    assert.deepEqual(
      clampGuest({ cpus: Number.NaN, memoryMb: 1_024, cpuKind: 'performance' }, { maxCpus: 8, maxMemoryMb: 8_192 }),
      { cpus: 1, memoryMb: 1_024, cpuKind: 'performance' },
    );
  });
});

describe('FlyMachinesBackend — lease default', () => {
  it('exposes the spec default lease TTL', () => {
    assert.equal(DEFAULT_FLY_LEASE_TTL_SEC, 1_800);
  });
});
